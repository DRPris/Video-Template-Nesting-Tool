# 视频处理系统使用说明

## 📋 概述

这是一个基于 Next.js 的视频处理系统，可以将竖版视频与模板合成生成方版和横版视频。

## 🏗️ 架构设计

### 后端 API

#### 1. `/app/api/process/route.ts` - 任务入队接口
- **功能**：接收上传文件，完成模板元数据分析后将任务推入后台队列，并立即返回 `jobId`
- **输出**：
  - `jobId`: 可用于查询的任务 ID
  - `status`: `pending | processing`
  - `queuePosition`: 前方尚有多少任务
  - `progress`: 初始进度（通常为 0）
- **输入字段**：
  - `video_vertical`: 竖版视频文件（必需）
  - `template_square`: 方版模板视频（可选）
  - `template_landscape`: 横版模板视频（可选）
- **备注**：实际的视频渲染由 `lib/job-queue.ts` 串行调度 `lib/video-processor.ts` 完成，HTTP 请求不再阻塞。

#### 2. `/app/api/process/[jobId]/route.ts` - 任务状态查询
- **功能**：返回指定任务的实时快照（状态、进度、结果）。
- **输出字段**：
  - `status`: `pending | processing | completed | failed`
  - `progress`: 0-100 的整数
  - `queuePosition`: 当前排队位置
  - `result.videos`: 生成的文件信息（任务完成时返回）

#### 3. `/app/api/output/[filename]/route.ts` - 视频下载服务
- **功能**：提供生成视频的下载/流式播放
- **特性**：
  - 支持 Range requests（断点续传）
  - 安全的文件路径验证
  - 支持浏览器内播放

### 前端组件

#### `/app/page.tsx` - 主页面
- 视频上传功能
- 模板选择功能
- 实时进度显示
- 下载生成的视频

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

依赖包括：
- `formidable`: 处理文件上传
- `ffmpeg-static`: FFmpeg 静态二进制文件
- `fluent-ffmpeg`: FFmpeg Node.js 封装
- `@types/formidable`, `@types/fluent-ffmpeg`: TypeScript 类型定义

### 2. 启动开发服务器

```bash
pnpm dev
```

### 3. 使用流程

1. **上传竖版视频**：点击或拖拽上传竖版视频文件（推荐 9:16 比例）
2. **选择模板**：至少上传一个模板（方版或横版）
3. **开始生成**：点击"开始生成视频"按钮，前端会收到一个 `jobId` 并自动轮询状态
4. **等待渲染**：在“渲染进度”卡片中可看到实时进度、排队位置与任务 ID
5. **下载视频**：任务完成后下载区域会展示所有输出文件，并支持批量下载

## 🎬 视频处理逻辑

### 方版视频生成 (1920x1920)

```
FFmpeg 滤镜链：
1. [0:v]scale=1920:1920,setsar=1[bg]           # 缩放方版模板
2. [1:v]scale=1080:1920:...[fg]                # 缩放竖版视频
3. [bg][fg]overlay=0:0[out]                    # 叠加到左侧
```

**视觉效果**：
```
+-------------------+
|      |            |
| 竖版 |  模板背景   |
| 1080 |            |
|  ×   |            |
| 1920 |            |
|      |            |
+-------------------+
   1920 × 1920
```

### 横版视频生成 (1920x1080)

```
FFmpeg 滤镜链：
1. [0:v]scale=1920:1080,setsar=1[bg]           # 缩放横版模板
2. [1:v]scale=-1:1080,crop=1920:1080[fg]       # 缩放并裁剪竖版视频
3. [bg][fg]overlay=(W-w)/2:(H-h)/2[out]        # 叠加到中心
```

**视觉效果**：
```
+--------------------------------+
|                                |
|    [居中的竖版视频裁剪]          |
|                                |
+--------------------------------+
        1920 × 1080
```

## 📂 文件结构

```
/Users/doris/Downloads/code (1)/
├── app/
│   ├── api/
│   │   ├── process/
│   │   │   └── route.ts           # 视频处理 API
│   │   └── output/
│   │       └── [filename]/
│   │           └── route.ts       # 视频输出 API
│   └── page.tsx                   # 主页面
├── components/
│   ├── video-uploader.tsx         # 视频上传组件
│   └── template-uploader.tsx      # 模板上传组件
└── package.json
```

## 🔧 技术栈

- **前端框架**: Next.js 16.0.0 + React 19.2.0
- **UI 组件**: Radix UI + Tailwind CSS
- **视频处理**: FFmpeg (fluent-ffmpeg)
- **文件上传**: Formidable
- **类型安全**: TypeScript

## ⚙️ FFmpeg 配置

### 编码参数说明

```typescript
-c:v libx264      // 视频编码器：H.264
-preset medium    // 编码速度：medium（平衡质量和速度）
-crf 23          // 质量控制：23（0-51，越小质量越好）
-c:a aac         // 音频编码器：AAC
-b:a 192k        // 音频比特率：192kbps
-shortest        // 以最短的输入流为准
```

### 性能优化建议

1. **Preset 选项**：
   - `ultrafast`: 最快速度，文件较大
   - `fast`: 快速，适合实时处理
   - `medium`: 平衡（当前使用）
   - `slow`: 更好的质量
   - `veryslow`: 最佳质量，速度最慢

2. **CRF 值**：
   - 18: 视觉无损质量
   - 23: 默认值（当前使用）
   - 28: 低质量，小文件

## 🐛 故障排查

### 常见问题

1. **文件上传失败**
   - 检查文件大小是否超过 500MB
   - 确认文件格式为视频格式（MP4, MOV 等）

2. **FFmpeg 处理失败**
   - 检查控制台日志获取详细错误信息
   - 确认 FFmpeg 静态二进制文件已正确安装
   - 验证输入视频文件的完整性

3. **视频下载失败**
   - 检查 `/tmp` 目录是否有写权限
   - 确认生成的视频文件存在
   - 查看浏览器控制台网络请求

### 日志查看

```bash
# 开发模式下查看终端输出
pnpm dev

# 关键日志：
# - "开始处理视频上传请求..."
# - "FFmpeg 命令: ..."
# - "方版视频处理进度: XX%"
# - "所有视频生成完成"
```

## 🔐 安全考虑

1. **文件路径验证**：防止路径遍历攻击
2. **文件大小限制**：最大 500MB
3. **文件类型检查**：仅接受视频格式
4. **临时文件清理**：建议定期清理 `/tmp` 目录

## 📝 API 使用示例

### 使用 cURL 测试

```bash
curl -X POST http://localhost:3000/api/process \
  -F "video_vertical=@/path/to/vertical_video.mp4" \
  -F "template_square=@/path/to/square_template.mp4" \
  -F "template_landscape=@/path/to/landscape_template.mp4"
```

### 响应格式

```json
{
  "success": true,
  "message": "视频处理完成",
  "videos": [
    {
      "type": "square",
      "url": "/api/output/square_1234567890.mp4",
      "filename": "square_1234567890.mp4"
    },
    {
      "type": "landscape",
      "url": "/api/output/landscape_1234567890.mp4",
      "filename": "landscape_1234567890.mp4"
    }
  ]
}
```

## 🚀 生产部署注意事项

1. **临时文件管理**：
   - 实现自动清理机制
   - 考虑使用云存储服务（如 AWS S3）

2. **性能优化**：
   - 使用消息队列处理耗时任务
   - 实现进度实时反馈（WebSocket）

3. **扩展性**：
   - 支持批量处理多个视频
   - 添加自定义尺寸和参数选项

## 📄 许可证

本项目仅供学习和参考使用。

---

**最后更新**: 2025-11-13
**作者**: AI 代码生成助手

