/**
 * 生成 Vercel Blob 上传地址的 API。
 *
 * 设计意图：
 * 1. 防止前端直接把大文件 POST 到 Serverless 函数，避开 4MB 网关限制。
 * 2. 通过一次性上传 URL，浏览器可直接 PUT 到 Blob 存储，并获得 public URL。
 * 3. 后续 /api/process 只需接收小型 JSON（包含 Blob URL），大幅降低请求体体积。
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@vercel/blob'

export const runtime = 'nodejs'

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB，受 Blob 与 /tmp 限制

const blobToken = process.env.VERCEL_BLOB_READ_WRITE_TOKEN
const blobClient = blobToken
  ? createClient({
      token: blobToken,
    })
  : null

interface UploadUrlRequestBody {
  filename: string
  contentType?: string
  fileSize: number
}

/**
 * 校验上传参数并返回标准化结果。
 *
 * @param body - 前端传入的原始 JSON
 * @returns 清洗后的文件描述
 */
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

/**
 * POST /api/blob-upload-url
 *
 * 负责生成一次性、短时有效的 PUT 链接，供浏览器直传 Blob。
 */
export async function POST(req: NextRequest) {
  if (!blobClient) {
    return NextResponse.json(
      {
        error: '尚未配置 VERCEL_BLOB_READ_WRITE_TOKEN，无法生成上传地址',
      },
      { status: 500 },
    )
  }

  try {
    const body = (await req.json()) as UploadUrlRequestBody
    const { filename, contentType, fileSize } = validateRequestBody(body)

    const uploadTarget = await blobClient.generateUploadURL({
      access: 'public',
      contentType,
      tokenPayload: {
        filename,
        fileSize,
      },
    })

    return NextResponse.json({
      uploadUrl: uploadTarget.url,
      blobId: uploadTarget.id,
      publicUrl: `https://blob.vercel-storage.com${uploadTarget.pathname}`,
      expiresAt: uploadTarget.expiresAt,
    })
  } catch (error) {
    console.error('Failed to generate blob upload URL:', error)
    const message = error instanceof Error ? error.message : '未知错误'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

