"use client"

import type React from "react"

import { useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Upload, X, Video } from "lucide-react"
import { cn } from "@/lib/utils"

interface VideoUploaderProps {
  videos: File[]
  setVideos: (videos: File[]) => void
}

export function VideoUploader({ videos, setVideos }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const videoFiles = files.filter((file) => file.type.startsWith("video/"))
    setVideos([...videos, ...videoFiles])
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    const videoFiles = files.filter((file) => file.type.startsWith("video/"))
    setVideos([...videos, ...videoFiles])
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }

  const removeVideo = (index: number) => {
    setVideos(videos.filter((_, i) => i !== index))
  }

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i]
  }

  return (
    <div className="space-y-4">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors hover:border-primary hover:bg-accent/50",
          videos.length === 0 && "min-h-[200px] flex items-center justify-center",
        )}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="video/*" multiple className="hidden" onChange={handleFileChange} />
        <div className="flex flex-col items-center gap-2">
          <Upload className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">点击或拖拽上传视频</p>
            <p className="text-sm text-muted-foreground">支持 MP4, MOV 格式</p>
          </div>
        </div>
      </div>

      {videos.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">已上传 {videos.length} 个视频</p>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {videos.map((video, index) => (
              <Card key={index} className="p-3">
                <div className="flex items-center gap-3">
                  <Video className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(video.size)}</p>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeVideo(index)} className="flex-shrink-0">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
