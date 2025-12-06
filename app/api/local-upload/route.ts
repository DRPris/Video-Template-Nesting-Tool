/**
 * 本地开发环境上传兜底路由。
 *
 * 设计目标：
 * 1. 当前端缺少 Vercel Blob 凭证时，仍能在开发机上完成文件上传流程；
 * 2. 仅在非生产环境或显式允许时启用，避免误将文件写入无保护的磁盘；
 * 3. 输出结构与 Blob 上传结果保持一致，便于前端复用现有逻辑。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB，与 Blob 对齐
const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'public', 'local-uploads')

const allowLocalUpload =
  process.env.ALLOW_LOCAL_FILE_UPLOAD === 'true' ||
  (process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOCAL_FILE_UPLOAD !== 'false')

/**
 * 将用户提供的文件名转换为仅包含安全字符的形式。
 */
function sanitizeFileName(filename: string): string {
  const normalized = filename.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').trim()
  return normalized.length > 0 ? normalized : `file-${Date.now()}`
}

/**
 * 将二进制内容写入磁盘目录，如果目录不存在则自动创建。
 */
async function persistBufferToDisk(filename: string, payload: Buffer): Promise<string> {
  await mkdir(LOCAL_UPLOAD_DIR, { recursive: true })
  const storagePath = path.join(LOCAL_UPLOAD_DIR, filename)
  await writeFile(storagePath, payload)
  return storagePath
}

/**
 * 处理从浏览器发送的 multipart/form-data 请求并写入磁盘。
 */
export async function POST(req: NextRequest) {
  if (!allowLocalUpload) {
    return NextResponse.json({ error: '本地上传模式未启用，请配置 Vercel Blob 凭证' }, { status: 403 })
  }

  try {
    const formData = await req.formData()
    const fileEntry = formData.get('file')
    const label = (formData.get('label') as string | null)?.trim() ?? 'file'

    if (!(fileEntry instanceof File)) {
      return NextResponse.json({ error: 'formData 中缺少 file 字段' }, { status: 400 })
    }

    if (fileEntry.size <= 0) {
      return NextResponse.json({ error: '上传内容为空，已拒绝保存' }, { status: 400 })
    }

    if (fileEntry.size > MAX_UPLOAD_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `本地上传仅支持 ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))}MB 以内的文件`,
        },
        { status: 400 },
      )
    }

    const safeOriginalName = sanitizeFileName(fileEntry.name || label)
    const randomSuffix = randomBytes(6).toString('hex')
    const storedFileName = `${Date.now()}-${randomSuffix}-${safeOriginalName}`

    const arrayBuffer = await fileEntry.arrayBuffer()
    const bufferPayload = Buffer.from(arrayBuffer)

    await persistBufferToDisk(storedFileName, bufferPayload)

    const relativePath = `/local-uploads/${storedFileName}`
    const origin = req.headers.get('origin') ?? process.env.NEXT_PUBLIC_SITE_URL ?? ''
    const publicUrl = origin ? `${origin}${relativePath}` : relativePath

    return NextResponse.json({
      url: publicUrl,
      pathname: relativePath,
      originalName: fileEntry.name || label,
      size: fileEntry.size,
      mimeType: fileEntry.type || 'application/octet-stream',
      storedAs: storedFileName,
    })
  } catch (error) {
    console.error('Local upload failed:', error)
    return NextResponse.json({ error: '本地上传失败，请检查日志获取更多细节' }, { status: 500 })
  }
}


