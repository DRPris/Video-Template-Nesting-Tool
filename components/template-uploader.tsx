"use client"

import type React from "react"

import { useRef } from "react"
import { Button } from "@/components/ui/button"
import { Upload, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface TemplateUploaderProps {
  label: string
  description: string
  template: File | null
  onUpload: (file: File | null) => void
}

export function TemplateUploader({ label, description, template, onUpload }: TemplateUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 支持视频和图片格式
    if (file && (file.type.startsWith("video/") || file.type.startsWith("image/"))) {
      onUpload(file)
    }
  }

  return (
    <div
      className={cn(
        "border-2 rounded-lg p-4 cursor-pointer transition-colors hover:border-primary",
        template ? "border-primary bg-primary/5" : "border-dashed",
      )}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept="video/*,image/*" className="hidden" onChange={handleFileChange} />
      <div className="flex items-center gap-3">
        {template ? (
          <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0" />
        ) : (
          <Upload className="h-5 w-5 text-muted-foreground flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium">{label}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
          {template && <p className="text-xs text-primary font-medium mt-1 truncate">{template.name}</p>}
        </div>
        <Button
          size="sm"
          variant={template ? "outline" : "secondary"}
          onClick={(e) => {
            e.stopPropagation()
            if (template) {
              onUpload(null)
            } else {
              inputRef.current?.click()
            }
          }}
        >
          {template ? "更换" : "选择"}
        </Button>
      </div>
    </div>
  )
}
