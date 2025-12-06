/**
 * 视频输出 API 路由
 *
 * 功能概述：
 * 提供生成的视频文件下载服务
 * 使用动态路由参数 [filename] 来获取请求的文件名
 *
 * 路径示例：/api/output/square_1234567890.mp4
 */

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { stat } from 'fs/promises'

/**
 * GET 请求处理器
 *
 * @param req Next.js 请求对象
 * @param context 包含动态路由参数的上下文对象
 * @returns 视频文件流或错误响应
 */
export async function handleOutputGet(
  req: NextRequest,
  context: { params: Promise<{ filename: string }> },
) {
  try {
    // 获取动态路由参数
    const { filename } = await context.params
    
    console.log('请求下载文件:', filename)

    // 安全检查：防止路径遍历攻击
    // 只允许访问文件名，不允许包含路径分隔符
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json(
        { error: '非法的文件名' },
        { status: 400 }
      )
    }

    // 构建文件完整路径
    const filePath = path.join('/tmp', filename)
    console.log('文件完整路径:', filePath)

    // 检查文件是否存在
    try {
      await stat(filePath)
    } catch (error) {
      console.error('文件不存在:', filePath)
      return NextResponse.json(
        { error: '文件不存在' },
        { status: 404 }
      )
    }

    // 读取文件
    const fileBuffer = fs.readFileSync(filePath)
    
    // 获取文件统计信息
    const stats = fs.statSync(filePath)
    const fileSize = stats.size

    console.log(`开始传输文件 ${filename}, 大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`)

    // 设置响应头
    // Content-Type: 设置为 video/mp4
    // Content-Length: 文件大小
    // Content-Disposition: 设置为 inline 以便浏览器内播放，或 attachment 强制下载
    const headers = new Headers()
    headers.set('Content-Type', 'video/mp4')
    headers.set('Content-Length', fileSize.toString())
    headers.set('Content-Disposition', `inline; filename="${filename}"`)
    headers.set('Cache-Control', 'public, max-age=3600') // 缓存 1 小时
    
    // 支持范围请求 (Range requests) 用于视频流式播放
    headers.set('Accept-Ranges', 'bytes')

    // 处理范围请求
    const range = req.headers.get('range')
    if (range) {
      // 解析 Range 头
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      // 读取指定范围的数据
      const fileStream = fs.createReadStream(filePath, { start, end })
      const chunks: Buffer[] = []
      
      for await (const chunk of fileStream) {
        chunks.push(Buffer.from(chunk))
      }
      
      const buffer = Buffer.concat(chunks)

      // 设置 206 部分内容响应
      headers.set('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      headers.set('Content-Length', chunkSize.toString())

      return new NextResponse(buffer, {
        status: 206,
        headers,
      })
    }

    // 返回完整文件
    return new NextResponse(fileBuffer, {
      status: 200,
      headers,
    })

  } catch (error) {
    console.error('文件传输失败:', error)
    return NextResponse.json(
      {
        error: '文件读取失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    )
  }
}

/**
 * 可选：DELETE 请求处理器
 * 用于清理临时文件
 */
export async function handleOutputDelete(
  req: NextRequest,
  context: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await context.params

    // 安全检查
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json(
        { error: '非法的文件名' },
        { status: 400 }
      )
    }

    const filePath = path.join('/tmp', filename)

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: '文件不存在' },
        { status: 404 }
      )
    }

    // 删除文件
    fs.unlinkSync(filePath)
    console.log('文件已删除:', filePath)

    return NextResponse.json({
      success: true,
      message: '文件已删除',
    })

  } catch (error) {
    console.error('文件删除失败:', error)
    return NextResponse.json(
      {
        error: '文件删除失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    )
  }
}

