/**
 * 视频处理 API（队列版）
 *
 * 新架构说明：
 * 1. 浏览器先将所有文件上传到 Vercel Blob，并将 URL 回传给本接口。
 * 2. 本接口只接收 JSON（视频/模板的 url + 元信息），再在 Serverless 环境中下载到 /tmp。
 * 3. 下载完成后构造后台渲染任务，推入队列并立即返回 jobId。
 */

import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { enqueueJob, ensureQueueWorkerRunning, getOwnerActiveJobCount } from '@/lib/job-queue'
import {
  readTemplateMetadata,
  type TemplateDescriptor,
  type TemplateVariant,
  type UploadedVideoDescriptor,
  type VideoProcessorPayload,
} from '@/lib/video-processor'

const rawOwnerLimit = Number(process.env.MAX_ACTIVE_JOBS_PER_OWNER ?? 2)
const MAX_ACTIVE_JOBS_PER_OWNER = Number.isFinite(rawOwnerLimit) && rawOwnerLimit >= 1 ? rawOwnerLimit : 2
const MAX_REMOTE_FILE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB，只受限于 /tmp 和 ffmpeg
const SUPPORTED_PROTOCOLS = new Set(['https:'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const allowInsecureHttpSources =
  process.env.ALLOW_INSECURE_HTTP_SOURCES === 'true' ||
  (process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_HTTP_SOURCES !== 'false')

interface RemoteAssetPayload {
  url: string
  originalName: string
  size?: number
  mimeType?: string
}

interface TemplateInputPayload {
  vertical?: RemoteAssetPayload
  square?: RemoteAssetPayload
  landscape?: RemoteAssetPayload
}

interface ProcessRequestPayload {
  videos?: RemoteAssetPayload[]
  templates?: TemplateInputPayload
}

/**
 * 将字节数格式化为可读字符串，便于日志输出。
 */
function formatBytes(bytes?: number | null): string {
  if (!bytes || !Number.isFinite(bytes)) {
    return '未知大小'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(2)} ${units[unitIndex] ?? 'KB'}`
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
 * 判断模板对象中是否至少包含一个有效的引用。
 *
 * @param templates - 前端传入的模板引用集合
 * @returns 若存在任意模板则返回 true
 */
function hasAtLeastOneTemplate(templates?: TemplateInputPayload): boolean {
  if (!templates) return false
  return Boolean(templates.vertical || templates.square || templates.landscape)
}

/**
 * 下载远程文件到 /tmp，并返回本地可用的路径。
 *
 * @param asset - 来自前端的远程文件描述
 * @param label - 用于日志的友好标签
 * @returns 本地路径与原始文件名
 */
async function persistRemoteAsset(
  asset: RemoteAssetPayload,
  label: string,
): Promise<{ path: string; originalName: string }> {
  const normalizedUrl = asset.url?.trim()
  const normalizedName = asset.originalName?.trim()

  if (!normalizedUrl || !normalizedName) {
    throw new Error(`${label} 缺少 url 或 originalName，无法继续处理`)
  }

  const parsedSize = typeof asset.size === 'number' ? asset.size : Number(asset.size)
  const normalizedSize = Number.isFinite(parsedSize) ? parsedSize : undefined

  if (normalizedSize && normalizedSize > MAX_REMOTE_FILE_BYTES) {
    throw new Error(`${label} 文件体积 (${formatBytes(normalizedSize)}) 超过 ${formatBytes(MAX_REMOTE_FILE_BYTES)} 的限制`)
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(normalizedUrl)
  } catch {
    throw new Error(`${label} 提供的 URL 无法解析，请确认它是有效的 HTTPS 地址`)
  }

  const isHttps = SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)
  const isLoopbackHttp = allowInsecureHttpSources && parsedUrl.protocol === 'http:' && LOOPBACK_HOSTS.has(parsedUrl.hostname)

  if (!isHttps && !isLoopbackHttp) {
    const hint = allowInsecureHttpSources
      ? '请使用 localhost / 127.0.0.1 或改用 HTTPS 链接'
      : '若在本地调试，可设置 ALLOW_INSECURE_HTTP_SOURCES=true'
    throw new Error(`${label} 仅支持 HTTPS 资源，当前协议: ${parsedUrl.protocol}。${hint}`)
  }

  console.log(`⬇️ 正在下载 ${label}: ${normalizedName} (${formatBytes(normalizedSize)})`)
  const response = await fetch(parsedUrl, {
    headers: asset.mimeType ? { 'content-type': asset.mimeType } : undefined,
    cache: 'no-store',
  })

  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败，远程返回 ${response.status} ${response.statusText}`)
  }

  const safeExtension = extname(normalizedName) || ''
  const safePrefix = label.replace(/\s+/g, '_').toLowerCase()
  const tempPath = join(tmpdir(), `${safePrefix}_${randomUUID()}${safeExtension}`)
  const writable = createWriteStream(tempPath)
  const readable = Readable.fromWeb(response.body as WebReadableStream)

  await pipeline(readable, writable)
  console.log(`✅ ${label} 已保存到 ${tempPath}`)

  return {
    path: tempPath,
    originalName: normalizedName,
  }
}

/**
 * 将远程模板描述转换为处理器可识别的结构，并读取其元数据。
 */
async function buildTemplateDescriptorFromRemoteAsset(
  asset: RemoteAssetPayload | undefined,
  variant: TemplateVariant,
  label: string,
): Promise<TemplateDescriptor | undefined> {
  if (!asset) {
    return undefined
  }

  const persisted = await persistRemoteAsset(asset, label)
  const metadata = await readTemplateMetadata(label, persisted.path)

  return {
    path: persisted.path,
    originalName: persisted.originalName,
    variant,
    metadata,
  }
}

/**
 * 下载所有竖版视频，并产出后端队列所需的数据结构。
 */
async function buildVideoDescriptors(videos: RemoteAssetPayload[]): Promise<UploadedVideoDescriptor[]> {
  const descriptors: UploadedVideoDescriptor[] = []

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index]
    const label = `竖版视频 #${index + 1}`
    const persisted = await persistRemoteAsset(video, label)
    descriptors.push({
      path: persisted.path,
      originalName: persisted.originalName,
    })
  }

  return descriptors
}

/**
 * POST 请求：接收远程文件引用，生成队列任务并返回任务 ID。
 *
 * @param req - 来自 Next.js 的请求对象
 * @returns 包含任务快照或错误信息的 JSON 响应
 */
export async function handleProcessPost(req: NextRequest) {
  try {
    console.log('\n========================================')
    console.log('📹 接收到视频批量渲染请求（Blob 上传模式）')
    console.log('时间:', new Date().toLocaleString('zh-CN'))
    console.log('========================================\n')

    const payload = (await req.json()) as ProcessRequestPayload
    if (!payload || !Array.isArray(payload.videos) || payload.videos.length === 0) {
      return NextResponse.json({ error: '请求体必须包含至少一个视频引用' }, { status: 400 })
    }

    if (!hasAtLeastOneTemplate(payload.templates)) {
      return NextResponse.json({ error: '至少需要提供一种模板引用' }, { status: 400 })
    }

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

    const videoDescriptors = await buildVideoDescriptors(payload.videos)
    const templatesInput = payload.templates ?? {}
    const [verticalTemplate, squareTemplate, landscapeTemplate] = await Promise.all([
      buildTemplateDescriptorFromRemoteAsset(templatesInput.vertical, 'vertical', '竖版模板'),
      buildTemplateDescriptorFromRemoteAsset(templatesInput.square, 'square', '方版模板'),
      buildTemplateDescriptorFromRemoteAsset(templatesInput.landscape, 'landscape', '横版模板'),
    ])

    const jobPayload: VideoProcessorPayload = {
      videos: videoDescriptors,
      templates: {
        vertical: verticalTemplate,
        square: squareTemplate,
        landscape: landscapeTemplate,
      },
    }

    const jobSnapshot = enqueueJob(jobPayload, { ownerId: clientIdentity.ownerId })
    waitUntil(ensureQueueWorkerRunning())
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
