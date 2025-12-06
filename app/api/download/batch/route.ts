/**
 * 批量下载压缩包 API
 *
 * 功能概述：
 * 1. 接收需要批量下载的文件名列表。
 * 2. 在服务器临时目录中查找对应文件。
 * 3. 将文件实时打包为 Zip 并以附件形式返回。
 */
export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { PassThrough, Readable } from 'node:stream'

const OUTPUT_DIR = '/tmp'

interface DownloadRequestBody {
  filenames: unknown
  archiveName?: unknown
}

interface DownloadTarget {
  filename: string
  absolutePath: string
}

/**
 * 自定义错误类型，用于区分输入校验与内部错误。
 */
class DownloadValidationError extends Error {
  public readonly status: number
  public readonly details?: unknown

  constructor(message: string, status = 400, details?: unknown) {
    super(message)
    this.status = status
    this.details = details
  }
}

/**
 * 构造压缩包名称，自动补全 .zip 后缀。
 *
 * @param requestedName - 客户端可选提供的压缩包名称
 * @returns 符合命名要求的 zip 文件名
 */
function deriveArchiveName(requestedName: unknown): string {
  const fallbackName = `videos_${Date.now()}`
  if (typeof requestedName !== 'string' || requestedName.trim().length === 0) {
    return `${fallbackName}.zip`
  }
  const sanitized = requestedName.trim().replace(/[\r\n]/g, '')
  return sanitized.toLowerCase().endsWith('.zip') ? sanitized : `${sanitized}.zip`
}

/**
 * 将未知输入转换为唯一的字符串数组。
 *
 * @param value - 请求体中的 filenames 字段
 * @returns 去重后的字符串数组
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new DownloadValidationError('参数 filenames 必须是字符串数组')
  }
  const strings = value.map((item) => {
    if (typeof item !== 'string') {
      throw new DownloadValidationError('文件名必须是字符串', 400, { invalidValue: item })
    }
    const trimmed = item.trim()
    if (!trimmed) {
      throw new DownloadValidationError('文件名不能为空')
    }
    return trimmed
  })
  return Array.from(new Set(strings))
}

/**
 * 校验文件名并解析出绝对路径。
 *
 * @param filename - 客户端提供的文件名
 * @returns 包含原始文件名和绝对路径的对象
 */
function sanitizeAndResolve(filename: string): DownloadTarget {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new DownloadValidationError('文件名包含非法路径字符', 400, { filename })
  }

  const absolutePath = path.join(OUTPUT_DIR, filename)
  if (!fs.existsSync(absolutePath)) {
    throw new DownloadValidationError('部分文件不存在', 404, { missing: [filename] })
  }

  return { filename, absolutePath }
}

/**
 * 构建压缩流，将目标文件打包为 Zip。
 *
 * @param targets - 待打包文件列表
 * @returns Web ReadableStream，可直接返回给 NextResponse
 */
function createArchiveStream(targets: DownloadTarget[]): ReadableStream {
  const archive = archiver('zip', { zlib: { level: 9 } })
  const passThrough = new PassThrough()

  archive.on('warning', (warning) => {
    console.warn('⚠️ Zip 打包警告:', warning)
  })

  archive.on('error', (error) => {
    passThrough.destroy(error)
  })

  archive.pipe(passThrough)

  targets.forEach((target) => {
    archive.file(target.absolutePath, { name: target.filename })
  })

  // finalize 会在内部异步写入流
  void archive.finalize()

  return Readable.toWeb(passThrough) as ReadableStream
}

/**
 * POST 请求处理器：将多个生成文件打包成单个 Zip。
 *
 * @param req - Next.js 请求对象
 * @returns 包含压缩包的二进制流响应
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as DownloadRequestBody
    const filenames = toStringArray(body.filenames)

    if (filenames.length === 0) {
      throw new DownloadValidationError('请至少提供一个文件名')
    }

    const archiveName = deriveArchiveName(body.archiveName)
    const targets = filenames.map((name) => sanitizeAndResolve(name))
    const stream = createArchiveStream(targets)

    const headers = new Headers()
    headers.set('Content-Type', 'application/zip')
    headers.set('Content-Disposition', `attachment; filename="${archiveName}"`)
    headers.set('Cache-Control', 'no-store')

    return new NextResponse(stream, { status: 200, headers })
  } catch (error) {
    if (error instanceof DownloadValidationError) {
      return NextResponse.json(
        {
          error: error.message,
          details: error.details ?? null,
        },
        { status: error.status },
      )
    }

    console.error('批量下载失败:', error)
    return NextResponse.json(
      {
        error: '批量下载失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 },
    )
  }
}


