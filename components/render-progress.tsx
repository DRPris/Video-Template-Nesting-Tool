"use client"

import { Progress } from "@/components/ui/progress"
import { Loader2 } from "lucide-react"

interface RenderProgressProps {
  progress: number
}

export function RenderProgress({ progress }: RenderProgressProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">正在渲染视频...</p>
            <p className="text-sm font-medium text-primary">{progress}%</p>
          </div>
          <Progress value={progress} className="h-2" />
        </div>
      </div>
      <div className="text-sm text-muted-foreground">
        {progress < 30 && "正在处理视频文件..."}
        {progress >= 30 && progress < 60 && "正在应用模板..."}
        {progress >= 60 && progress < 90 && "正在合成视频..."}
        {progress >= 90 && "即将完成..."}
      </div>
    </div>
  )
}
