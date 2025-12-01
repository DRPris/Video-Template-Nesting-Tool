"use client"

/**
 * 视频格式转换首页：负责上传源视频、选择模板、触发渲染并展示下载入口。
 */

import { put } from "@vercel/blob/client"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { VideoUploader } from "@/components/video-uploader"
import { TemplateUploader } from "@/components/template-uploader"
import { RenderProgress } from "@/components/render-progress"
import { Download, Video } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

/**
 * 描述服务端错误解析结果的数据结构。
 */
interface ParsedErrorResponse {
  /** 最终展示给用户的可读错误信息 */
  message: string
  /** 服务器返回的原始负载，便于调试 */
  payload: unknown
}

interface BaseUploadTokenResponse {
  strategy: "vercel" | "local"
  expiresAt: string
  maxUploadBytes: number
  originalFilename: string
  declaredSize: number
}

interface VercelBlobUploadTokenResponse extends BaseUploadTokenResponse {
  strategy: "vercel"
  clientToken: string
  pathname: string
}

interface LocalUploadTokenResponse extends BaseUploadTokenResponse {
  strategy: "local"
  uploadEndpoint: string
}

type BlobUploadTokenResponse = VercelBlobUploadTokenResponse | LocalUploadTokenResponse

interface LocalUploadResponsePayload {
  url: string
  pathname: string
  originalName: string
  size: number
  mimeType: string
}

interface RemoteFileReferencePayload {
  url: string
  originalName: string
  size: number
  mimeType: string
}

interface ProcessRequestBody {
  videos: RemoteFileReferencePayload[]
  templates: {
    vertical?: RemoteFileReferencePayload
    square?: RemoteFileReferencePayload
    landscape?: RemoteFileReferencePayload
  }
}

type JobStatus = "pending" | "processing" | "completed" | "failed"

interface JobStatusResponse {
  id: string
  status: JobStatus
  progress: number
  queuePosition: number
  estimatedWaitSeconds?: number
  estimatedWaitMs?: number
  averageJobDurationSeconds?: number
  averageJobDurationMs?: number
  message?: string
  result?: {
    videos: Array<{ filename: string; url: string; type: string }>
  }
  error?: string
}

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending: "排队中",
  processing: "正在渲染",
  completed: "已完成",
  failed: "失败",
}

/**
 * 将服务器返回的等待时间（秒或毫秒）统一转换为秒，方便 UI 直接渲染。
 */
function resolveEtaSeconds(snapshot: { estimatedWaitSeconds?: number; estimatedWaitMs?: number }): number | null {
  if (typeof snapshot.estimatedWaitSeconds === "number") {
    return snapshot.estimatedWaitSeconds
  }
  if (typeof snapshot.estimatedWaitMs === "number") {
    return Math.round(snapshot.estimatedWaitMs / 1000)
  }
  return null
}

/**
 * 将秒数格式化为“X分Y秒”的可读字符串。
 */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "< 1 秒"
  }
  const wholeSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60

  if (minutes > 0) {
    return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`
  }
  return `${remainingSeconds} 秒`
}

/**
 * 从服务器响应中提取最具可读性的错误信息。
 *
 * @param response - fetch 返回的 Response 对象
 * @returns 包含可读错误信息以及原始负载的对象
 */
async function parseErrorResponse(response: Response): Promise<ParsedErrorResponse> {
  const statusLabel = `服务器返回错误 (状态码: ${response.status})`
  const contentType = response.headers.get("content-type") ?? ""

  try {
    if (contentType.includes("application/json")) {
      const data = await response.json()
      if (data && typeof data === "object") {
        const recordData = data as Record<string, unknown>
        const message =
          (recordData["error"] as string | undefined) ??
          (recordData["details"] as string | undefined) ??
          (recordData["message"] as string | undefined) ??
          statusLabel
        const safePayload = Object.keys(recordData).length > 0 ? recordData : null
        return { message, payload: safePayload }
      }
      return { message: `${statusLabel}，并且响应体是空的 JSON 对象`, payload: {} }
    }

    const textPayload = await response.text()
    if (textPayload.trim().length > 0) {
      return { message: textPayload, payload: textPayload }
    }
  } catch (error) {
    console.error("❌ 解析错误响应失败:", error)
  }

  return { message: statusLabel, payload: null }
}

const MAX_SINGLE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2GB

/**
 * 将字节数转换为可读字符串，便于错误提示。
 */
function formatBytesForDisplay(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(2)} ${units[unitIndex] ?? "KB"}`
}

/**
 * 请求服务端生成一次性 Blob 客户端上传凭证。
 */
async function requestBlobUploadToken(file: File): Promise<BlobUploadTokenResponse> {
  const response = await fetch("/api/blob-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      fileSize: file.size,
    }),
  })

  if (!response.ok) {
    const { message } = await parseErrorResponse(response)
    throw new Error(message)
  }

  return (await response.json()) as BlobUploadTokenResponse
}

/**
 * 使用 Vercel Blob 直传策略上传文件。
 */
async function uploadFileViaVercelBlob(
  file: File,
  uploadToken: VercelBlobUploadTokenResponse,
): Promise<RemoteFileReferencePayload> {
  const uploadResult = await put(uploadToken.pathname, file, {
    access: "public",
    token: uploadToken.clientToken,
    contentType: file.type || "application/octet-stream",
  })

  return {
    url: uploadResult.url,
    originalName: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
  }
}

/**
 * 使用后端本地兜底接口上传文件，仅在开发环境触发。
 */
async function uploadFileViaLocalEndpoint(
  file: File,
  label: string,
  uploadToken: LocalUploadTokenResponse,
): Promise<RemoteFileReferencePayload> {
  const formData = new FormData()
  formData.append("file", file, file.name)
  formData.append("label", label)
  formData.append("mimeType", file.type || "application/octet-stream")
  formData.append("size", `${file.size}`)

  const response = await fetch(uploadToken.uploadEndpoint, {
    method: "POST",
    body: formData,
  })

  if (!response.ok) {
    const { message } = await parseErrorResponse(response)
    throw new Error(message)
  }

  const payload = (await response.json()) as LocalUploadResponsePayload
  return {
    url: payload.url,
    originalName: payload.originalName,
    size: payload.size,
    mimeType: payload.mimeType,
  }
}

/**
 * 根据运行环境自动选择上传策略，并返回后端需要的远程引用。
 */
async function persistFileWithAdaptiveStrategy(file: File, label: string): Promise<RemoteFileReferencePayload> {
  if (file.size > MAX_SINGLE_UPLOAD_BYTES) {
    throw new Error(`${label} 超过当前 ${formatBytesForDisplay(MAX_SINGLE_UPLOAD_BYTES)} 的单文件限制`)
  }

  const uploadToken = await requestBlobUploadToken(file)
  if (file.size > uploadToken.maxUploadBytes) {
    throw new Error(`${label} 超过后端允许的 ${formatBytesForDisplay(uploadToken.maxUploadBytes)} 限制`)
  }

  if (uploadToken.strategy === "local") {
    return uploadFileViaLocalEndpoint(file, label, uploadToken)
  }

  return uploadFileViaVercelBlob(file, uploadToken)
}

export default function Home() {
  const [videos, setVideos] = useState<File[]>([])
  const [templates, setTemplates] = useState({
    vertical: null as File | null,
    square: null as File | null,
    horizontal: null as File | null,
  })
  const [isRendering, setIsRendering] = useState(false)
  const [progress, setProgress] = useState(0)
  const [renderedVideos, setRenderedVideos] = useState<Array<{ name: string; url: string }>>([])
  const [isBatchDownloading, setIsBatchDownloading] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const [estimatedWaitSeconds, setEstimatedWaitSeconds] = useState<number | null>(null)
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { toast } = useToast()

  /**
   * 停止后台轮询，避免产生重复请求或内存泄漏。
   */
  const stopPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }

  /**
   * 处理任务完成后的 UI 更新和提示。
   */
  const handleJobCompletion = (snapshot: JobStatusResponse) => {
    stopPolling()
    setIsRendering(false)
    setProgress(100)
    setJobStatus("completed")
    setQueuePosition(0)
    setEstimatedWaitSeconds(0)
    setActiveJobId(snapshot.id)

    const processedVideos =
      snapshot.result?.videos?.map((video) => ({
        name: video.filename,
        url: video.url,
      })) ?? []

    setRenderedVideos(processedVideos)

    toast({
      title: "视频处理完成",
      description: snapshot.message ?? `成功生成 ${processedVideos.length} 个视频`,
    })
  }

  /**
   * 处理任务失败的情形。
   */
  const handleJobFailure = (message: string) => {
    stopPolling()
    setIsRendering(false)
    setJobStatus("failed")
    setProgress(0)
    setEstimatedWaitSeconds(null)

    toast({
      title: "任务失败",
      description: message,
      variant: "destructive",
    })
  }

  /**
   * 根据最新的任务快照刷新前端状态。
   */
  const processJobSnapshot = (snapshot: JobStatusResponse) => {
    setActiveJobId(snapshot.id)
    setJobStatus(snapshot.status)
    setQueuePosition(snapshot.queuePosition ?? 0)
    setProgress(snapshot.progress ?? 0)
    setEstimatedWaitSeconds(resolveEtaSeconds(snapshot))

    if (snapshot.status === "completed") {
      handleJobCompletion(snapshot)
    } else if (snapshot.status === "failed") {
      handleJobFailure(snapshot.error ?? "后台处理失败，请稍后重试")
    }
  }

  /**
   * 调用状态查询 API。若接口报错则直接停止轮询。
   */
  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await fetch(`/api/process/${jobId}`)
      if (!response.ok) {
        const { message } = await parseErrorResponse(response)
        handleJobFailure(message)
        return
      }

      const snapshot: JobStatusResponse = await response.json()
      processJobSnapshot(snapshot)
    } catch (error) {
      console.error("轮询任务状态失败:", error)
    }
  }

  /**
   * 启动轮询：立即请求一次，然后按照固定间隔重复请求。
   */
  const startPollingJob = (jobId: string) => {
    stopPolling()

    const invokePoll = () => {
      void pollJobStatus(jobId)
    }

    invokePoll()
    pollingTimerRef.current = setInterval(invokePoll, 4000)
  }

  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [])

  /**
   * 提交上传任务到后端，触发视频批量渲染。
   */
  const handleRender = async () => {
    // 验证：至少需要一个竖版视频
    if (videos.length === 0) {
      toast({
        title: "请上传视频",
        description: "至少需要上传一个竖版视频",
        variant: "destructive",
      })
      return
    }

    // 验证：至少需要方版或横版模板之一
    const hasVertical = templates.vertical !== null
    const hasSquare = templates.square !== null
    const hasLandscape = templates.horizontal !== null
    
    if (!hasVertical && !hasSquare && !hasLandscape) {
      toast({
        title: "请上传模板",
        description: "至少需要上传一种模板",
        variant: "destructive",
      })
      return
    }

    stopPolling()
    setIsRendering(true)
    setProgress(0)
    setRenderedVideos([])
    setActiveJobId(null)
    setJobStatus(null)
    setQueuePosition(null)

    try {
      console.log("========== 开始准备 Blob 上传 ==========")
      console.log(`上传的视频数量: ${videos.length}`)
      console.log("竖版模板:", templates.vertical?.name || "未上传")
      console.log("方版模板:", templates.square?.name || "未上传")
      console.log("横版模板:", templates.horizontal?.name || "未上传")

      const uploadedVideos: RemoteFileReferencePayload[] = []
      for (const [index, video] of videos.entries()) {
        const uploaded = await persistFileWithAdaptiveStrategy(video, `竖版视频 #${index + 1}`)
        uploadedVideos.push(uploaded)
      }

      const uploadedTemplates: {
        vertical?: RemoteFileReferencePayload
        square?: RemoteFileReferencePayload
        landscape?: RemoteFileReferencePayload
      } = {}

      if (templates.vertical) {
        uploadedTemplates.vertical = await persistFileWithAdaptiveStrategy(templates.vertical, "竖版模板")
      }
      if (templates.square) {
        uploadedTemplates.square = await persistFileWithAdaptiveStrategy(templates.square, "方版模板")
      }
      if (templates.horizontal) {
        uploadedTemplates.landscape = await persistFileWithAdaptiveStrategy(templates.horizontal, "横版模板")
      }

      const requestPayload: ProcessRequestBody = {
        videos: uploadedVideos,
        templates: {
          ...(uploadedTemplates.vertical ? { vertical: uploadedTemplates.vertical } : {}),
          ...(uploadedTemplates.square ? { square: uploadedTemplates.square } : {}),
          ...(uploadedTemplates.landscape ? { landscape: uploadedTemplates.landscape } : {}),
        },
      }

      console.log("正在发送 JSON 请求到 /api/process...")
      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      })

      console.log("收到响应, 状态码:", response.status)

      // 改进的错误处理逻辑
      if (!response.ok) {
        const { message, payload } = await parseErrorResponse(response)
        console.error("❌ 服务器返回错误:", payload ?? message)
        throw new Error(message)
      }

      const data: {
        jobId: string
        status: JobStatus
        progress: number
        queuePosition: number
        estimatedWaitSeconds?: number
        estimatedWaitMs?: number
      } = await response.json()

      console.log("✅ 任务已成功入队:", data.jobId)

      setActiveJobId(data.jobId)
      setJobStatus(data.status)
      setQueuePosition(data.queuePosition ?? 0)
      setProgress(data.progress ?? 0)
      setEstimatedWaitSeconds(resolveEtaSeconds(data))

      startPollingJob(data.jobId)

      toast({
        title: "任务已排队",
        description:
          data.queuePosition > 0
            ? `前方还有 ${data.queuePosition} 个任务，请稍候`
            : "正在准备开始处理，请保持页面开启",
      })
    } catch (error) {
      console.error("视频处理错误:", error)
      toast({
        title: "处理失败",
        description: error instanceof Error ? error.message : "请检查文件格式并重试",
        variant: "destructive",
      })
      stopPolling()
      setIsRendering(false)
      setProgress(0)
      setActiveJobId(null)
      setJobStatus(null)
      setQueuePosition(null)
      setEstimatedWaitSeconds(null)
    }
  }

  /**
   * 将所有生成的视频一次性打包下载，提升用户体验。
   */
  const handleBatchDownload = async () => {
    if (renderedVideos.length === 0) {
      toast({
        title: "暂无可下载文件",
        description: "请先完成视频渲染",
        variant: "destructive",
      })
      return
    }

    setIsBatchDownloading(true)

    const archiveLabel = `rendered_videos_${Date.now()}`

    try {
      const response = await fetch("/api/download/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filenames: renderedVideos.map((video) => video.name),
          archiveName: archiveLabel,
        }),
      })

      if (!response.ok) {
        const { message } = await parseErrorResponse(response)
        throw new Error(message)
      }

      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = downloadUrl
      anchor.download = `${archiveLabel}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(downloadUrl)

      toast({
        title: "开始下载",
        description: "压缩包正在保存到您的设备",
      })
    } catch (error) {
      console.error("批量下载失败:", error)
      toast({
        title: "批量下载失败",
        description: error instanceof Error ? error.message : "请稍后重试",
        variant: "destructive",
      })
    } finally {
      setIsBatchDownloading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Video className="h-10 w-10 text-primary" />
            <h1 className="text-4xl font-bold text-balance">视频格式转换工具</h1>
          </div>
          <p className="text-muted-foreground text-lg">批量上传竖版视频，选择模板，一键生成多种尺寸的视频</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 mb-8">
          {/* Video Upload Section */}
          <Card className="border-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5" />
                竖版视频上传
              </CardTitle>
              <CardDescription>支持批量上传多个竖版视频文件（MP4, MOV）</CardDescription>
            </CardHeader>
            <CardContent>
              <VideoUploader videos={videos} setVideos={setVideos} />
            </CardContent>
          </Card>

          {/* Template Upload Section */}
          <Card className="border-2">
            <CardHeader>
              <CardTitle>视频模板上传</CardTitle>
              <CardDescription>上传不同尺寸的模板，至少选择一种</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <TemplateUploader
                label="竖版模板"
                description="9:16 竖屏格式"
                template={templates.vertical}
                onUpload={(file) => setTemplates({ ...templates, vertical: file })}
              />
              <TemplateUploader
                label="方版模板"
                description="1:1 方形格式"
                template={templates.square}
                onUpload={(file) => setTemplates({ ...templates, square: file })}
              />
              <TemplateUploader
                label="横版模板"
                description="16:9 横屏格式"
                template={templates.horizontal}
                onUpload={(file) => setTemplates({ ...templates, horizontal: file })}
              />
            </CardContent>
          </Card>
        </div>

        {/* Render Button */}
        <div className="flex justify-center mb-8">
          <Button size="lg" onClick={handleRender} disabled={isRendering} className="px-8 py-6 text-lg">
            {isRendering ? "渲染中..." : "开始生成视频"}
          </Button>
        </div>

        {/* Progress Section */}
        {isRendering && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>渲染进度</CardTitle>
            </CardHeader>
            <CardContent>
              <RenderProgress progress={progress} />
              <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                {jobStatus && (
                  <p>
                    当前状态：<span className="font-medium text-primary">{JOB_STATUS_LABEL[jobStatus]}</span>
                  </p>
                )}
                {typeof queuePosition === "number" && queuePosition > 0 && (
                  <p>排队中，前面还有 {queuePosition} 个任务</p>
                )}
                {typeof estimatedWaitSeconds === "number" && estimatedWaitSeconds > 0 && (
                  <p>预计等待：约 {formatEta(estimatedWaitSeconds)}</p>
                )}
                {activeJobId && (
                  <p>
                    任务 ID：<span className="font-mono text-xs">{activeJobId}</span>
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Download Section */}
        {renderedVideos.length > 0 && (
          <Card className="border-2 border-primary">
            <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Download className="h-5 w-5" />
                  下载视频
                </CardTitle>
                <CardDescription>点击单个按钮或使用一键下载压缩包</CardDescription>
              </div>
              <Button
                variant="default"
                onClick={handleBatchDownload}
                disabled={isBatchDownloading}
                className="w-full sm:w-auto"
              >
                {isBatchDownloading ? "打包中..." : "一键下载压缩包"}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {renderedVideos.map((video, index) => (
                  <Card key={index} className="overflow-hidden">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{video.name}</p>
                          <p className="text-sm text-muted-foreground">准备下载</p>
                        </div>
                        <Button size="icon" variant="outline" asChild>
                          <a href={video.url} download={video.name}>
                            <Download className="h-4 w-4" />
                          </a>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
