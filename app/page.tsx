"use client"

/**
 * 视频格式转换首页：负责上传源视频、选择模板、触发渲染并展示下载入口。
 * (Client-Side Version using FFmpeg.wasm)
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { VideoUploader } from "@/components/video-uploader"
import { TemplateUploader } from "@/components/template-uploader"
import { RenderProgress } from "@/components/render-progress"
import { Download, Video, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useFFmpeg } from "@/hooks/use-ffmpeg"
import { processVideoClientSide, ProcessResult } from "@/lib/client-processor"
import JSZip from "jszip"

export default function Home() {
  const [videos, setVideos] = useState<File[]>([])
  const [templates, setTemplates] = useState({
    vertical: null as File | null,
    square: null as File | null,
    horizontal: null as File | null,
  })
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [renderedVideos, setRenderedVideos] = useState<ProcessResult[]>([])
  const [isBatchDownloading, setIsBatchDownloading] = useState(false)

  const { toast } = useToast()
  const { load: loadFFmpeg, loaded: ffmpegLoaded, isLoading: ffmpegLoading, ffmpeg } = useFFmpeg()

  // Load FFmpeg on mount
  useEffect(() => {
    loadFFmpeg()
  }, [])

  /**
   * 触发视频批量渲染 (Client-Side)
   */
  const handleRender = async () => {
    if (!ffmpegLoaded) {
      toast({
        title: "FFmpeg 未就绪",
        description: "正在加载核心组件，请稍候...",
        variant: "default",
      })
      await loadFFmpeg()
      return
    }

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

    setIsProcessing(true)
    setProgress(0)
    setRenderedVideos([])

    try {
      console.log("========== 开始本地处理 ==========")

      const allResults: ProcessResult[] = []
      let completedVideos = 0
      const totalVideos = videos.length

      // Process videos sequentially to manage memory
      for (const video of videos) {
        const results = await processVideoClientSide(
          ffmpeg,
          {
            videoFile: video,
            templates: {
              vertical: templates.vertical || undefined,
              square: templates.square || undefined,
              landscape: templates.horizontal || undefined,
            }
          },
          (completedVariants, totalVariants) => {
            // Calculate overall progress
            // This is a bit rough since we reset for each video, but it gives feedback
            const currentVideoProgress = completedVariants / totalVariants
            const overallProgress = ((completedVideos + currentVideoProgress) / totalVideos) * 100
            setProgress(Math.round(overallProgress))
          }
        )
        allResults.push(...results)
        completedVideos++
        setProgress(Math.round((completedVideos / totalVideos) * 100))
      }

      setRenderedVideos(allResults)
      toast({
        title: "处理完成",
        description: `成功生成 ${allResults.length} 个视频`,
      })

    } catch (error) {
      console.error("视频处理错误:", error)
      toast({
        title: "处理失败",
        description: error instanceof Error ? error.message : "未知错误",
        variant: "destructive",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  /**
   * 将所有生成的视频打包下载 (Client-Side)
   */
  const handleBatchDownload = async () => {
    if (renderedVideos.length === 0) return

    setIsBatchDownloading(true)
    try {
      const zip = new JSZip()

      // Add files to zip
      for (const video of renderedVideos) {
        // Fetch blob from blobURL
        const response = await fetch(video.blobUrl)
        const blob = await response.blob()
        zip.file(video.filename, blob)
      }

      const content = await zip.generateAsync({ type: "blob" })
      const downloadUrl = URL.createObjectURL(content)

      const anchor = document.createElement("a")
      anchor.href = downloadUrl
      anchor.download = `rendered_videos_${Date.now()}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(downloadUrl)

      toast({
        title: "下载已开始",
        description: "压缩包已生成",
      })
    } catch (error) {
      console.error("打包失败:", error)
      toast({
        title: "打包失败",
        description: "无法生成压缩包",
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
            <h1 className="text-4xl font-bold text-balance">视频格式转换工具 (本地版)</h1>
          </div>
          <p className="text-muted-foreground text-lg">
            使用浏览器本地处理，无需上传服务器，保护隐私且无限制。
            {!ffmpegLoaded && !ffmpegLoading && (
              <span className="block text-yellow-600 text-sm mt-2">
                注意：首次加载可能需要下载组件，请保持网络畅通。
              </span>
            )}
          </p>
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
        <div className="flex flex-col items-center justify-center mb-8 gap-4">
          <Button
            size="lg"
            onClick={handleRender}
            disabled={isProcessing || (!ffmpegLoaded && !ffmpegLoading)}
            className="px-8 py-6 text-lg"
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                处理中...
              </>
            ) : ffmpegLoading ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                正在加载组件...
              </>
            ) : (
              "开始生成视频"
            )}
          </Button>
          {ffmpegLoading && <p className="text-sm text-muted-foreground">首次加载可能需要几秒钟...</p>}
        </div>

        {/* Progress Section */}
        {isProcessing && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>处理进度</CardTitle>
            </CardHeader>
            <CardContent>
              <RenderProgress progress={progress} />
              <div className="mt-4 text-sm text-muted-foreground text-center">
                正在本地合成视频，请勿关闭页面...
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
                {isBatchDownloading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    打包中...
                  </>
                ) : (
                  "一键下载压缩包"
                )}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {renderedVideos.map((video, index) => (
                  <Card key={index} className="overflow-hidden">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{video.filename}</p>
                          <p className="text-sm text-muted-foreground">准备下载</p>
                        </div>
                        <Button size="icon" variant="outline" asChild>
                          <a href={video.blobUrl} download={video.filename}>
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
