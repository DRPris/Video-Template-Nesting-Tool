# 🚀 快速开始指南

## ✅ 项目已完成配置

所有必需的后端 API 和前端集成已经完成！

## 📦 已安装的依赖

- ✅ `formidable@3.5.4` - 处理文件上传
- ✅ `ffmpeg-static@5.2.0` - FFmpeg 静态二进制
- ✅ `fluent-ffmpeg@2.1.3` - FFmpeg Node.js 接口
- ✅ `@types/formidable` - TypeScript 类型
- ✅ `@types/fluent-ffmpeg` - TypeScript 类型

## 🎯 创建的文件

### 后端 API
1. **`/app/api/process/route.ts`** ✅
   - 处理视频上传
   - 执行 FFmpeg 转换
   - 生成方版和横版视频

2. **`/app/api/output/[filename]/route.ts`** ✅
   - 提供视频文件下载
   - 支持流式播放
   - 支持 Range requests

### 前端更新
3. **`/app/page.tsx`** ✅
   - 更新为正确提交三个文件：
     - `video_vertical` - 竖版视频
     - `template_square` - 方版模板
     - `template_landscape` - 横版模板

## 🏃 启动项目

```bash
# 1. 进入项目目录
cd "/Users/doris/Downloads/code (1)"

# 2. 启动开发服务器
pnpm dev

# 3. 打开浏览器访问
# http://localhost:3000
```

## 📝 使用步骤

### 1️⃣ 上传竖版视频
- 点击左侧"竖版视频上传"区域
- 选择或拖拽一个竖版视频文件（推荐 9:16 比例，如 1080x1920）

### 2️⃣ 上传模板
至少上传一个模板：
- **方版模板** (1:1 比例，如 1920x1920) - 生成方版视频
- **横版模板** (16:9 比例，如 1920x1080) - 生成横版视频

### 3️⃣ 开始生成
- 点击"开始生成视频"按钮
- 系统会自动处理视频（可能需要几分钟）

### 4️⃣ 下载结果
- 处理完成后，在底部会显示生成的视频
- 点击下载按钮保存到本地

## 🎬 视频处理效果

### 方版输出 (1920x1920)
```
+------------------------+
|          |             |
|  竖版视频 |   模板背景   |
| (1080px) |             |
|    ×     |             |
| (1920px) |             |
|          |             |
+------------------------+
```
- 竖版视频缩放到 1080x1920，放置在左侧
- 方版模板作为 1920x1920 的背景

### 横版输出 (1920x1080)
```
+--------------------------------+
|                                |
|     居中的竖版视频（裁剪）       |
|                                |
+--------------------------------+
```
- 竖版视频缩放并居中裁剪到 1920x1080
- 横版模板作为背景

## 🔍 API 端点

### POST `/api/process`
处理视频上传和转换

**请求格式**：`multipart/form-data`

**字段**：
- `video_vertical` (必需) - 竖版视频文件
- `template_square` (可选) - 方版模板视频
- `template_landscape` (可选) - 横版模板视频

**响应示例**：
```json
{
  "success": true,
  "message": "视频处理完成",
  "videos": [
    {
      "type": "square",
      "url": "/api/output/square_1731672000000.mp4",
      "filename": "square_1731672000000.mp4"
    },
    {
      "type": "landscape",
      "url": "/api/output/landscape_1731672000000.mp4",
      "filename": "landscape_1731672000000.mp4"
    }
  ]
}
```

### GET `/api/output/[filename]`
下载或播放生成的视频

**示例**：
```
GET /api/output/square_1731672000000.mp4
```

## 🧪 测试 API（可选）

使用 cURL 测试后端 API：

```bash
# 准备测试文件
# vertical.mp4 - 竖版视频
# square.mp4 - 方版模板
# landscape.mp4 - 横版模板

# 发送请求
curl -X POST http://localhost:3000/api/process \
  -F "video_vertical=@/path/to/vertical.mp4" \
  -F "template_square=@/path/to/square.mp4" \
  -F "template_landscape=@/path/to/landscape.mp4"

# 下载生成的视频
curl -O http://localhost:3000/api/output/square_TIMESTAMP.mp4
```

## 📊 系统要求

- **Node.js**: 18+ 
- **内存**: 建议 4GB+ (FFmpeg 视频处理需要内存)
- **磁盘空间**: `/tmp` 目录需要足够空间存储临时文件
- **操作系统**: macOS, Linux, Windows (需要 WSL)

## ⚡ 性能提示

### 视频处理时间参考
- 10秒视频: ~5-15秒
- 30秒视频: ~15-45秒
- 1分钟视频: ~30-90秒

*实际时间取决于视频分辨率、编码格式和系统性能*

### 优化建议
1. **输入视频格式**: 使用 H.264 编码的 MP4 文件处理最快
2. **分辨率**: 输入视频接近目标尺寸会更快
3. **模板**: 使用较短的模板视频可加快处理

## 🐛 常见问题

### Q: 视频处理失败怎么办？
A: 检查浏览器控制台和终端日志，常见原因：
- 视频格式不支持（尝试转换为 MP4）
- 视频损坏（重新下载或转换）
- 内存不足（关闭其他应用）

### Q: 生成的视频在哪里？
A: 视频临时存储在 `/tmp` 目录，下载后会保存到浏览器默认下载位置

### Q: 可以批量处理多个视频吗？
A: 当前版本只处理第一个上传的竖版视频，批量处理可在未来版本添加

### Q: 支持哪些视频格式？
A: 输入支持 MP4, MOV, AVI 等常见格式，输出统一为 MP4 (H.264)

## 🎨 自定义配置

### 修改输出尺寸
编辑 `/app/api/process/route.ts` 中的滤镜参数：

```typescript
// 方版尺寸（当前 1920x1920）
'[0:v]scale=1920:1920,setsar=1[bg]'

// 横版尺寸（当前 1920x1080）
'[0:v]scale=1920:1080,setsar=1[bg]'
```

### 调整视频质量
修改 FFmpeg CRF 参数（18-28，越小质量越好）：

```typescript
'-crf', '23'  // 当前值：23（平衡）
```

### 修改编码速度
更改 preset 参数：

```typescript
'-preset', 'medium'  // 可选: ultrafast, fast, medium, slow, veryslow
```

## 📚 更多文档

详细技术文档请参阅：`VIDEO_PROCESSING_README.md`

## ✨ 完成！

项目已完全配置好，可以开始使用了！

有问题？查看终端和浏览器控制台的日志输出。

---

**祝使用愉快！** 🎉

