/**
 * 视频处理核心模块
 *
 * 负责：
 * 1. 配置 FFmpeg 运行环境
 * 2. 提供模板元数据读取能力（识别 Alpha 通道、分辨率等）
 * 3. 输出竖版、方版、横版三种尺寸的视频
 * 4. 聚合一个批次任务的执行入口，并在需要时上报处理进度
 *
 * 所有导出的方法都遵循“单一职责+文档说明”的结构，方便非专业开发者理解。
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

/**
 * 支持的模板类型枚举。
 */
export type TemplateVariant = 'vertical' | 'square' | 'landscape'

/**
 * 模板元数据信息：用于判断模板是否含 Alpha 通道以及分辨率信息。
 */
export interface TemplateMetadata {
  hasAlphaChannel: boolean
  width: number | null
  height: number | null
  pixelFormat: string | null
}

/**
 * 默认的模板元数据，作为读取失败时的回退值。
 */
export const defaultTemplateMetadata: TemplateMetadata = {
  hasAlphaChannel: true,
  width: null,
  height: null,
  pixelFormat: null,
}

/**
 * 表示一个已上传的视频文件信息。
 */
export interface UploadedVideoDescriptor {
  path: string
  originalName: string
}

/**
 * 表示一个模板文件的信息以及其元数据。
 */
export interface TemplateDescriptor {
  path: string
  originalName: string
  variant: TemplateVariant
  metadata: TemplateMetadata | null
}

/**
 * 传递给视频处理任务的输入参数。
 */
export interface VideoProcessorPayload {
  videos: UploadedVideoDescriptor[]
  templates: {
    vertical?: TemplateDescriptor
    square?: TemplateDescriptor
    landscape?: TemplateDescriptor
  }
}

/**
 * 单个输出视频的描述信息。
 */
export interface GeneratedVideoResult {
  type: TemplateVariant
  url: string
  filename: string
}

/**
 * 可选的任务配置，例如进度回调。
 */
export interface ProcessVideoOptions {
  onProgress?: (completed: number, total: number) => void
}

const OUTPUT_DIRECTORY = '/tmp'

const explicitFfmpegPath =
  process.env.LOCAL_FFMPEG_PATH ??
  process.env.FFMPEG_PATH ??
  process.env.NEXT_PUBLIC_FFMPEG_PATH ??
  null

let ffmpegConfigured = false

type FfmpegBinarySource = 'custom-env' | 'bundled-static' | 'system-detect'

/**
 * 根据优先级解析一个可用的 FFmpeg 可执行文件路径。
 */
function resolveCandidatePath(candidate: string | null): string | null {
  if (!candidate || candidate.trim().length === 0) {
    return null
  }

  const normalized = candidate.trim()
  const absolutePath = path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized)
  return fs.existsSync(absolutePath) ? absolutePath : null
}

/**
 * 通过系统命令自动探测 FFmpeg 路径。
 */
function detectSystemFfmpeg(): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const probe = spawnSync(locator, ['ffmpeg'], { encoding: 'utf8' })
  const dynamicCandidates =
    probe.status === 0
      ? probe.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []

  const fallbackCommonPaths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']

  for (const candidate of [...dynamicCandidates, ...fallbackCommonPaths]) {
    const resolved = resolveCandidatePath(candidate)
    if (resolved) {
      return resolved
    }
  }

  return null
}

function resolveFfmpegBinary(): { path: string; source: FfmpegBinarySource } {
  const envPath = resolveCandidatePath(explicitFfmpegPath)
  if (envPath) {
    return { path: envPath, source: 'custom-env' }
  }

  const bundledPath = resolveCandidatePath(typeof ffmpegStatic === 'string' ? ffmpegStatic : null)
  if (bundledPath) {
    return { path: bundledPath, source: 'bundled-static' }
  }

  const systemPath = detectSystemFfmpeg()
  if (systemPath) {
    return { path: systemPath, source: 'system-detect' }
  }

  throw new Error(
    [
      '未能自动找到 FFmpeg 可执行文件，请确认已安装 ffmpeg-static 或本地 FFmpeg。',
      '可选操作：',
      '1. 运行 `pnpm add ffmpeg-static` 以恢复随包二进制；或',
      '2. 安装系统 FFmpeg（macOS: `brew install ffmpeg`）；或',
      '3. 在 .env.local 中设置 LOCAL_FFMPEG_PATH 指向手动安装的 ffmpeg。',
    ].join('\n'),
  )
}

/**
 * 确保 FFmpeg 仅初始化一次：优先使用自定义路径，其次为随包静态二进制，最后回退到系统命令。
 */
function ensureFfmpegIsReady(): void {
  if (ffmpegConfigured) return

  const { path: resolvedPath, source } = resolveFfmpegBinary()

  ffmpeg.setFfmpegPath(resolvedPath)
  ffmpegConfigured = true
  const sourceLabel =
    source === 'custom-env' ? '自定义路径' : source === 'bundled-static' ? 'ffmpeg-static' : '系统 PATH'
  console.log(`🎬 FFmpeg 路径已锁定 (${sourceLabel}):`, resolvedPath)
}

/**
 * 使用 ffprobe 读取模板文件的核心元数据，并判断是否包含 Alpha 通道。
 *
 * @param label - 友好的模板名称用于日志
 * @param filePath - 模板实际在磁盘上的路径
 * @returns 模板的分辨率、像素格式和 Alpha 通道信息
 */
export async function readTemplateMetadata(label: string, filePath: string): Promise<TemplateMetadata> {
  ensureFfmpegIsReady()
  return await new Promise<TemplateMetadata>((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata) {
        console.warn(`⚠️  无法读取 ${label} 元数据:`, err?.message ?? '未知错误')
        resolve(defaultTemplateMetadata)
        return
      }

      const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video')
      const pixelFormat = videoStream?.pix_fmt ?? null
      const normalizedPixFmt = pixelFormat?.toLowerCase() ?? ''
      const hasAlphaChannel =
        normalizedPixFmt.includes('alpha') ||
        normalizedPixFmt.includes('rgba') ||
        normalizedPixFmt.includes('bgra') ||
        normalizedPixFmt.includes('argb') ||
        normalizedPixFmt.includes('yuva') ||
        normalizedPixFmt.endsWith('a')

      console.log(
        `🧩 ${label} 像素格式: ${pixelFormat ?? '未知'}, 带 Alpha: ${hasAlphaChannel ? '是' : '否'}, 尺寸: ${
          videoStream?.width ?? '未知'
        }x${videoStream?.height ?? '未知'}`,
      )

      resolve({
        hasAlphaChannel,
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        pixelFormat,
      })
    })
  })
}

/**
 * 生成竖版视频 (1080x1920)：竖版视频作为底层，叠加竖版模板。
 */
async function generateVerticalVideo(
  verticalVideoPath: string,
  verticalTemplatePath: string,
  verticalTemplateOriginalName: string,
  outputPath: string,
  templateMetadata: TemplateMetadata | null = null,
): Promise<void> {
  const metadata = templateMetadata ?? defaultTemplateMetadata
  return new Promise((resolve, reject) => {
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(verticalTemplateOriginalName)

    console.log(`🎨 竖版模板类型: ${isImage ? '图片' : '视频'}`)

    const command = ffmpeg()

    command.input(verticalTemplatePath)
    command.input(verticalVideoPath)

    const templateFilter = isImage
      ? '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template]'
      : '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template]'

    command
      .complexFilter([
        '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgba[video]',
        templateFilter,
        metadata.hasAlphaChannel ? '[video][template]overlay=0:0[out]' : '[template][video]overlay=0:0[out]',
      ])
      .outputOptions([
        '-map',
        '[out]',
        '-map',
        '1:a?',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`🎥 开始生成竖版视频: ${cmd}`))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * 生成方版视频 (1080x1080)：竖版视频保持比例缩放到高度 1080，居中放置，然后叠加方版模板。
 */
async function generateSquareVideo(
  verticalVideoPath: string,
  squareTemplatePath: string,
  squareTemplateOriginalName: string,
  outputPath: string,
  templateMetadata: TemplateMetadata | null = null,
): Promise<void> {
  const metadata = templateMetadata ?? defaultTemplateMetadata
  return new Promise((resolve, reject) => {
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(squareTemplateOriginalName)

    console.log(`🎨 方版模板类型: ${isImage ? '图片' : '视频'}`)

    const command = ffmpeg()
    command.input(squareTemplatePath)
    command.input(verticalVideoPath)

    const templateFilter = isImage
      ? '[0:v]scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template]'
      : '[0:v]scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template]'

    command
      .complexFilter([
        // 先将竖版视频等比缩放到高度 1080，再通过 pad 居中，避免因为裁剪导致画面被放大。
        '[1:v]scale=-2:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[video_scaled]',
        // 方版模板通常将透明窗口放在画面左侧，因此固定使用左对齐，保证画面不会“漂移”。
        '[video_scaled]pad=1080:1080:0:(1080-ih)/2:black,format=rgba[video_bg]',
        templateFilter,
        metadata.hasAlphaChannel ? '[video_bg][template]overlay=0:0[out]' : '[template][video_bg]overlay=0:0[out]',
      ])
      .outputOptions([
        '-map',
        '[out]',
        '-map',
        '1:a?',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`🎥 开始生成方版视频: ${cmd}`))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * 生成横版视频 (1920x1080)：竖版视频居中，横版模板覆盖在最上层。
 */
async function generateLandscapeVideo(
  verticalVideoPath: string,
  landscapeTemplatePath: string,
  landscapeTemplateOriginalName: string,
  outputPath: string,
  templateMetadata: TemplateMetadata | null = null,
): Promise<void> {
  const metadata = templateMetadata ?? defaultTemplateMetadata
  return new Promise((resolve, reject) => {
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(landscapeTemplateOriginalName)

    console.log(`🎨 横版模板类型: ${isImage ? '图片' : '视频'}`)

    const command = ffmpeg()
    command.input(landscapeTemplatePath)
    command.input(verticalVideoPath)

    const templateFilter = isImage
      ? '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template_layer]'
      : '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template_layer]'

    command
      .complexFilter([
        '[1:v]scale=-1:1080:flags=lanczos[scaled_video]',
        '[scaled_video]pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgba[video_layer]',
        templateFilter,
        metadata.hasAlphaChannel ? '[video_layer][template_layer]overlay=0:0[out]' : '[template_layer][video_layer]overlay=0:0[out]',
      ])
      .outputOptions([
        '-map',
        '[out]',
        '-map',
        '1:a?',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`🎥 开始生成横版视频: ${cmd}`))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * 根据输入的视频与模板组合生成所有目标视频，必要时回调上报进度。
 *
 * @param payload - 包含视频与模板的基础信息
 * @param options - 可选参数，当前仅支持进度回调
 * @returns 处理结果，包括可直接下载的 URL 列表
 */
export async function processVideoBatch(
  payload: VideoProcessorPayload,
  options: ProcessVideoOptions = {},
): Promise<{ success: boolean; message: string; videos: GeneratedVideoResult[] }> {
  ensureFfmpegIsReady()
  const { onProgress } = options
  const verticalTemplate = payload.templates.vertical
  const squareTemplate = payload.templates.square
  const landscapeTemplate = payload.templates.landscape

  const templatesToRender = [verticalTemplate, squareTemplate, landscapeTemplate].filter(Boolean)
  if (templatesToRender.length === 0) {
    throw new Error('至少需要上传一个模板文件')
  }
  if (payload.videos.length === 0) {
    throw new Error('未找到可处理的视频文件')
  }

  const totalVariants = payload.videos.length * templatesToRender.length
  const results: GeneratedVideoResult[] = []
  let completedVariants = 0

  const reportProgress = () => {
    completedVariants += 1
    onProgress?.(completedVariants, totalVariants)
  }

  for (const videoFile of payload.videos) {
    const videoPath = videoFile.path
    const originalName = videoFile.originalName || 'video'
    const baseName = path.parse(originalName).name
    const timestamp = Date.now()

    console.log(`\n🎬 正在处理视频: ${originalName}`)

    const tasks: Promise<void>[] = []

    if (verticalTemplate) {
      const outputPath = path.join(OUTPUT_DIRECTORY, `vertical_${baseName}_${timestamp}.mp4`)
      tasks.push(
        generateVerticalVideo(
          videoPath,
          verticalTemplate.path,
          verticalTemplate.originalName,
          outputPath,
          verticalTemplate.metadata,
        )
          .then(() => {
            results.push({
              type: 'vertical',
              url: `/api/output/${path.basename(outputPath)}`,
              filename: path.basename(outputPath),
            })
          })
          .finally(reportProgress),
      )
    }

    if (squareTemplate) {
      const outputPath = path.join(OUTPUT_DIRECTORY, `square_${baseName}_${timestamp}.mp4`)
      tasks.push(
        generateSquareVideo(
          videoPath,
          squareTemplate.path,
          squareTemplate.originalName,
          outputPath,
          squareTemplate.metadata,
        )
          .then(() => {
            results.push({
              type: 'square',
              url: `/api/output/${path.basename(outputPath)}`,
              filename: path.basename(outputPath),
            })
          })
          .finally(reportProgress),
      )
    }

    if (landscapeTemplate) {
      const outputPath = path.join(OUTPUT_DIRECTORY, `landscape_${baseName}_${timestamp}.mp4`)
      tasks.push(
        generateLandscapeVideo(
          videoPath,
          landscapeTemplate.path,
          landscapeTemplate.originalName,
          outputPath,
          landscapeTemplate.metadata,
        )
          .then(() => {
            results.push({
              type: 'landscape',
              url: `/api/output/${path.basename(outputPath)}`,
              filename: path.basename(outputPath),
            })
          })
          .finally(reportProgress),
      )
    }

    await Promise.all(tasks)
  }

  console.log('\n🎉 所有批量任务处理完成!')

  return {
    success: true,
    message: `成功处理 ${payload.videos.length} 个视频`,
    videos: results,
  }
}

