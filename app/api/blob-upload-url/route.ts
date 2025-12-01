/**
 * 生成 Vercel Blob 上传地址的 API。
 *
 * 设计意图：
 * 1. 防止前端直接把大文件 POST 到 Serverless 函数，避开 4MB 网关限制。
 * 2. 通过一次性上传 URL，浏览器可直接 PUT 到 Blob 存储，并获得 public URL。
 * 3. 后续 /api/process 只需接收小型 JSON（包含 Blob URL），大幅降低请求体体积。
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'

export const runtime = 'nodejs'

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB，受 Blob 与 /tmp 限制
const TOKEN_TTL_MS = 15 * 60 * 1000 // 上传凭证默认 15 分钟失效
const LOCAL_UPLOAD_ENDPOINT = '/api/local-upload'

const blobToken =
  process.env.VERCEL_BLOB_READ_WRITE_TOKEN ?? process.env.BLOB_READ_WRITE_TOKEN ?? process.env.NEXT_PUBLIC_BLOB_READ_WRITE_TOKEN ?? null

const allowLocalFallback =
  process.env.ALLOW_LOCAL_FILE_UPLOAD === 'true' ||
  (process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOCAL_FILE_UPLOAD !== 'false')

interface UploadUrlRequestBody {
  filename: string
  contentType?: string
  fileSize: number
}

/** 校验上传参数并返回标准化结果。 */
function validateRequestBody(body: UploadUrlRequestBody): UploadUrlRequestBody {
  if (!body || typeof body.filename !== 'string' || body.filename.trim().length === 0) {
    throw new Error('filename 字段必填')
  }

  const normalizedSize = Number(body.fileSize)
  if (!Number.isFinite(normalizedSize) || normalizedSize <= 0) {
    throw new Error('fileSize 必须是大于 0 的数值')
  }

  if (normalizedSize > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error(`单个文件暂仅支持 ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))}MB 以内的内容`)
  }

  return {
    filename: body.filename.trim(),
    contentType: body.contentType?.trim() || 'application/octet-stream',
    fileSize: normalizedSize,
  }
}

/** 将用户提供的文件名归一化，并生成避免冲突的路径。 */
function buildBlobPath(filename: string): string {
  const normalized = filename
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .trim()

  const effectiveName = normalized.length > 0 ? normalized : `file-${Date.now()}`
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const randomSuffix = Math.random().toString(36).slice(2, 10)
  return `uploads/${timestamp}-${randomSuffix}-${effectiveName}`
}

/**
 * 生成带约束的 Blob 客户端上传凭证，供前端使用 `@vercel/blob/client` 直传。
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as UploadUrlRequestBody
    const { filename, contentType, fileSize } = validateRequestBody(body)
    const pathname = buildBlobPath(filename)
    const validUntil = Date.now() + TOKEN_TTL_MS

    if (!blobToken) {
      if (!allowLocalFallback) {
        return NextResponse.json(
          {
            error: '尚未配置 VERCEL_BLOB_READ_WRITE_TOKEN，无法生成上传凭证',
          },
          { status: 500 },
        )
      }

      console.warn(
        '[blob-upload-url] 检测到缺少 Vercel Blob 凭证，已自动降级为本地上传模式（仅用于开发环境）。',
      )

      return NextResponse.json({
        strategy: 'local',
        uploadEndpoint: LOCAL_UPLOAD_ENDPOINT,
        expiresAt: new Date(validUntil).toISOString(),
        maxUploadBytes: MAX_UPLOAD_SIZE_BYTES,
        originalFilename: filename,
        declaredSize: fileSize,
      })
    }

    const clientToken = await generateClientTokenFromReadWriteToken({
      token: blobToken,
      pathname,
      maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
      allowedContentTypes: [contentType],
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil,
      cacheControlMaxAge: 60 * 60 * 24 * 30, // 30 天 CDN 缓存
    })

    return NextResponse.json({
      strategy: 'vercel',
      clientToken,
      pathname,
      expiresAt: new Date(validUntil).toISOString(),
      maxUploadBytes: MAX_UPLOAD_SIZE_BYTES,
      originalFilename: filename,
      declaredSize: fileSize,
    })
  } catch (error) {
    console.error('Failed to generate blob upload URL:', error)
    const message = error instanceof Error ? error.message : '未知错误'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

