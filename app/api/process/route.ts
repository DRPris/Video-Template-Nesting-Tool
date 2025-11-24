/**
 * 视频处理 API（队列版）
 *
 * 核心职责：
 * 1. 校验上传的多媒体文件并持久化到 /tmp
 * 2. 构造后台渲染所需的元数据（模板分辨率、Alpha 通道等）
 * 3. 将任务推送到内存队列中，立即返回任务 ID，避免阻塞 HTTP 连接
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import formidable from 'formidable'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { enqueueJob, getOwnerActiveJobCount } from '@/lib/job-queue'
import {
  readTemplateMetadata,
  type VideoProcessorPayload,
  type TemplateDescriptor,
  type TemplateMetadata,
  type TemplateVariant,
  type UploadedVideoDescriptor,
} from '@/lib/video-processor'

const rawOwnerLimit = Number(process.env.MAX_ACTIVE_JOBS_PER_OWNER ?? 2)
const MAX_ACTIVE_JOBS_PER_OWNER = Number.isFinite(rawOwnerLimit) && rawOwnerLimit >= 1 ? rawOwnerLimit : 2

type FormidableFileInput = formidable.File | formidable.File[] | undefined

/**
 * 将 NextRequest 转换为 formidable 兼容的 Node.js 可读流。
 *
 * @param req - Next.js 的请求对象
 * @returns 携带 headers/method/url 的 Node.js 可读流
 */
function toFormidableRequest(req: NextRequest): Readable & {
  headers: IncomingHttpHeaders
  method: string
  url: string
} {
  if (!req.body) {
    throw new Error('请求体为空，未检测到上传数据')
  }

  const nodeReadable = Readable.fromWeb(req.body as unknown as WebReadableStream)
  const headers: IncomingHttpHeaders = {}

  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  return Object.assign(nodeReadable, {
    headers,
    method: req.method ?? 'POST',
    url: req.url,
  })
}

/**
 * 解析请求中的来源 IP：优先使用代理透传的 X-Forwarded-For，其次使用 X-Real-IP。
 *
 * @param req - 来自 Next.js 的请求对象
 * @returns 字符串形式的 IP 地址，若无法识别则返回 'unknown'
 */
function resolveClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for')
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) {
      return firstIp
    }
  }
  const realIp = req.headers.get('x-real-ip')
  if (realIp) {
    return realIp.trim()
  }
  return 'unknown'
}

/**
 * 基于 IP、User-Agent、Accept-Language 计算一个稳定的匿名指纹，
 * 既能用于公平队列，又避免直接存储用户隐私。
 *
 * @param req - 当前 HTTP 请求
 * @returns 包含 ownerId（匿名指纹）和原始 IP 的对象
 */
function deriveClientFingerprint(req: NextRequest): { ownerId: string; sourceIp: string } {
  const sourceIp = resolveClientIp(req)
  const userAgent = req.headers.get('user-agent') ?? 'unknown-agent'
  const acceptLanguage = req.headers.get('accept-language') ?? 'unknown-lang'
  const rawFingerprint = `${sourceIp}|${userAgent}|${acceptLanguage}`
  const hash = createHash('sha256').update(rawFingerprint).digest('hex')

  return {
    ownerId: `anon_${hash.slice(0, 16)}`,
    sourceIp,
  }
}

/**
 * 使用 formidable 解析 multipart/form-data（流式，支持大文件）。
 *
 * @param req - HTTP 请求
 * @returns formidable 解析得到的文件集合
 */
async function parseMultipartForm(req: NextRequest): Promise<formidable.Files> {
  const contentType = req.headers.get('content-type')
  if (!contentType || !contentType.includes('multipart/form-data')) {
    throw new Error('Content-Type 必须是 multipart/form-data')
  }

  const formidableRequest = toFormidableRequest(req)

  return await new Promise((resolve, reject) => {
    const form = formidable({
      uploadDir: '/tmp',
      keepExtensions: true,
      maxFileSize: 2000 * 1024 * 1024, // 2GB
      multiples: true,
    })

    form.parse(formidableRequest as any, (err, _fields, files) => {
      if (err) {
        reject(err)
      } else {
        resolve(files)
      }
    })
  })
}

/**
 * 将 formidable 的 File/Files 输入整理成数组，方便统一处理。
 */
function normalizeVideoFiles(input: FormidableFileInput): formidable.File[] {
  if (!input) return []
  return Array.isArray(input) ? input.filter(Boolean) : [input]
}

/**
 * 仅提取单个模板文件，忽略多余的副本。
 */
function extractSingleFile(input: FormidableFileInput): formidable.File | null {
  if (!input) return null
  return Array.isArray(input) ? input[0] ?? null : input
}

/**
 * 将 formidable 文件转换为内部使用的描述对象。
 */
function mapUploadedVideos(files: formidable.File[]): UploadedVideoDescriptor[] {
  return files.map((file) => ({
    path: file.filepath,
    originalName: file.originalFilename ?? 'video',
  }))
}

/**
 * 构造模板描述信息，便于后台渲染逻辑复用。
 */
function buildTemplateDescriptor(
  file: formidable.File | null,
  variant: TemplateVariant,
  metadata: TemplateMetadata | null,
): TemplateDescriptor | undefined {
  if (!file) {
    return undefined
  }

  return {
    path: file.filepath,
    originalName: file.originalFilename ?? `${variant}_template`,
    variant,
    metadata,
  }
}

/**
 * POST 请求：接收上传文件，生成队列任务并返回任务 ID。
 */
export async function POST(req: NextRequest) {
  try {
    console.log('\n========================================')
    console.log('📹 接收到视频批量渲染请求（异步排队模式）')
    console.log('时间:', new Date().toLocaleString('zh-CN'))
    console.log('========================================\n')

    const clientIdentity = deriveClientFingerprint(req)
    const activeJobsForOwner = getOwnerActiveJobCount(clientIdentity.ownerId)

    if (activeJobsForOwner >= MAX_ACTIVE_JOBS_PER_OWNER) {
      return NextResponse.json(
        {
          error: '任务排队过多',
          details: `当前已有 ${activeJobsForOwner} 个任务正在排队/处理，请等待其中至少一个完成后再提交新的批次。`,
          queueHint: {
            ownerActiveJobs: activeJobsForOwner,
            ownerJobLimit: MAX_ACTIVE_JOBS_PER_OWNER,
          },
        },
        { status: 429 },
      )
    }

    const files = await parseMultipartForm(req)

    const videoFiles = normalizeVideoFiles(files.video_vertical)
    const verticalTemplateFile = extractSingleFile(files.template_vertical)
    const squareTemplateFile = extractSingleFile(files.template_square)
    const landscapeTemplateFile = extractSingleFile(files.template_landscape)

    if (videoFiles.length === 0) {
      return NextResponse.json({ error: '未找到竖版视频文件' }, { status: 400 })
    }

    if (!verticalTemplateFile && !squareTemplateFile && !landscapeTemplateFile) {
      return NextResponse.json({ error: '至少需要上传一个模板文件' }, { status: 400 })
    }

    const verticalTemplateMetadata = verticalTemplateFile
      ? await readTemplateMetadata('竖版模板', verticalTemplateFile.filepath)
      : null
    const squareTemplateMetadata = squareTemplateFile
      ? await readTemplateMetadata('方版模板', squareTemplateFile.filepath)
      : null
    const landscapeTemplateMetadata = landscapeTemplateFile
      ? await readTemplateMetadata('横版模板', landscapeTemplateFile.filepath)
      : null

    const jobPayload: VideoProcessorPayload = {
      videos: mapUploadedVideos(videoFiles),
      templates: {
        vertical: buildTemplateDescriptor(verticalTemplateFile, 'vertical', verticalTemplateMetadata),
        square: buildTemplateDescriptor(squareTemplateFile, 'square', squareTemplateMetadata),
        landscape: buildTemplateDescriptor(landscapeTemplateFile, 'landscape', landscapeTemplateMetadata),
      },
    }

    const jobSnapshot = enqueueJob(jobPayload, { ownerId: clientIdentity.ownerId })
    const ownerActiveJobs = getOwnerActiveJobCount(clientIdentity.ownerId)

    return NextResponse.json({
      success: true,
      message: '任务已进入队列，前端可使用 jobId 轮询状态',
      jobId: jobSnapshot.id,
      status: jobSnapshot.status,
      progress: jobSnapshot.progress,
      queuePosition: jobSnapshot.queuePosition,
      estimatedWaitMs: jobSnapshot.estimatedWaitMs,
      estimatedWaitSeconds: Math.max(0, Math.round(jobSnapshot.estimatedWaitMs / 1000)),
      averageJobDurationMs: jobSnapshot.averageJobDurationMs,
      averageJobDurationSeconds: Math.max(1, Math.round(jobSnapshot.averageJobDurationMs / 1000)),
      ownerActiveJobs,
      ownerJobLimit: MAX_ACTIVE_JOBS_PER_OWNER,
      metrics: jobSnapshot.metrics,
    })
  } catch (error) {
    console.error('处理失败:', error)
    return NextResponse.json(
      { error: '视频任务入队失败', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
