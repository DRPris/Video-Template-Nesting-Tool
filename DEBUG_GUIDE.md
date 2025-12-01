# 🔍 视频渲染调试指南

## 问题诊断步骤

当视频一直卡在"渲染中..."时,请按以下步骤排查:

---

## 📋 步骤 1: 查看浏览器控制台日志

### 如何打开浏览器控制台

- **Chrome/Edge**: 按 `F12` 或 `Ctrl+Shift+I` (Windows) / `Cmd+Option+I` (Mac)
- **Firefox**: 按 `F12` 或 `Ctrl+Shift+K` (Windows) / `Cmd+Option+K` (Mac)
- **Safari**: 先在设置中启用开发者菜单,然后按 `Cmd+Option+C`

### 应该看到的日志

在 **Console** 标签中,正常情况下应该显示:

```
========== 开始视频处理 ==========
上传的视频: 4_1763388326.mp4 (4.34 MB)
方版模板: 31763388299__pic_thumb.jpg
横版模板: 21763388298__pic_thumb.jpg
正在发送请求到 /api/process...
收到响应, 状态码: 200
✅ 视频处理完成: {success: true, videos: [...]}
========== 处理结束 ==========
```

### 如果看到错误

如果看到红色错误信息,记录下来:
- 错误码 (如 400, 500)
- 错误信息
- 截图保存

---

## 🖥️ 步骤 2: 查看服务器终端日志

### 找到运行 Next.js 的终端

这是您运行以下命令的终端窗口:
```bash
npm run dev
# 或
pnpm dev
# 或
yarn dev
```

### 应该看到的日志

正常情况下会显示详细的处理过程:

```
========================================
📹 开始处理视频上传请求...
时间: 2024/11/17 下午3:45:23
========================================

⏳ 正在解析上传文件...
✅ 文件解析完成
📦 解析到的文件字段: ['video_vertical', 'template_square', 'template_landscape']
📝 文件详情: {
  "video_vertical": {...},
  "template_square": {...},
  "template_landscape": {...}
}

🔍 验证文件路径...
竖版视频路径: /tmp/upload_abc123.mp4
方版模板路径: /tmp/upload_def456.jpg
横版模板路径: /tmp/upload_ghi789.jpg
✅ 文件路径验证通过

🎬 开始生成方版视频...
   输出路径: /tmp/square_1700123456789.mp4

🎥 FFmpeg 开始处理方版视频
命令: ffmpeg -i /tmp/upload_def456.jpg -i /tmp/upload_abc123.mp4...
📊 方版视频处理进度: 15.5%
📊 方版视频处理进度: 32.1%
📊 方版视频处理进度: 48.7%
...
✨ 方版视频 FFmpeg 处理完成
✅ 方版视频生成成功!

🎉 所有视频生成完成!
生成的视频数量: 2
```

---

## 🚨 常见问题和解决方案

### 问题 1: 请求根本没有发送

**症状**: 浏览器控制台没有任何日志

**可能原因**:
- 按钮点击事件没有触发
- JavaScript 错误

**解决方案**:
1. 刷新页面重试
2. 检查浏览器控制台是否有 JavaScript 错误
3. 尝试不同的浏览器

---

### 问题 2: 请求发送了但服务器没有响应

**症状**: 
- 浏览器显示 "正在发送请求到 /api/process..."
- 但没有 "收到响应" 的日志
- 服务器终端没有任何日志

**可能原因**:
- Next.js 开发服务器没有运行
- 端口冲突

**解决方案**:
1. 确认开发服务器正在运行
2. 检查终端是否显示 `✓ Ready on http://localhost:3000`
3. 重启开发服务器:
   ```bash
   # 停止当前进程 (Ctrl+C)
   # 然后重新运行
   pnpm dev
   ```

---

### 问题 3: 服务器返回错误

**症状**: 
- 浏览器显示 "收到响应, 状态码: 400" 或 "状态码: 500"
- 服务器终端显示错误信息

**常见错误及解决方案**:

#### 错误 A: "缺少竖版视频文件"
```
❌ 缺少竖版视频文件
```

**解决方案**: 确保上传了至少一个视频文件

#### 错误 B: "至少需要一个模板文件"
```
❌ 至少需要一个模板文件
```

**解决方案**: 确保上传了方版或横版模板(至少一个)

#### 错误 C: FFmpeg 未找到或失败
```
💥 方版视频 FFmpeg 处理失败!
错误信息: spawn ENOENT
```

**这是最常见的问题!** FFmpeg 没有正确安装。

**解决方案**:

1. **检查 FFmpeg 是否安装**
   ```bash
   # 在终端运行
   ffmpeg -version
   ```
   
   如果显示 "command not found",说明需要安装 FFmpeg。

2. **安装 FFmpeg**

   **macOS**:
   ```bash
   brew install ffmpeg
   ```

   **Windows**:
   - 下载: https://ffmpeg.org/download.html
   - 或使用 Chocolatey: `choco install ffmpeg`

   **Linux (Ubuntu/Debian)**:
   ```bash
   sudo apt update
   sudo apt install ffmpeg
   ```

3. **重启开发服务器**
   ```bash
   # 停止 (Ctrl+C)
   pnpm dev
   ```

4. **如果仍提示"未找到 ffmpeg-static"**
   - 使用 `which ffmpeg`（Windows 用 `where ffmpeg`）确认系统已安装 FFmpeg，并记录输出路径
   - 在 `.env.local` 中新增 `LOCAL_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg`（将路径换成上一步输出）
   - 重新运行 `pnpm dev`，终端会打印 `🎬 FFmpeg 路径已锁定 (自定义路径): ...` 表示配置成功

---

### 问题 4: 文件上传失败

**症状**:
```
⏳ 正在解析上传文件...
❌❌❌ 视频处理失败 ❌❌❌
错误信息: File size exceeds maximum...
```

**解决方案**:
- 检查视频文件大小(当前限制 500MB)
- 压缩视频后再上传
- 如需调整限制,修改 `app/api/process/route.ts` 第 62 行:
  ```typescript
  maxFileSize: 500 * 1024 * 1024, // 改成更大的值
  ```

---

### 问题 5: 视频格式不支持

**症状**:
```
💥 方版视频 FFmpeg 处理失败!
错误信息: Invalid data found when processing input
```

**解决方案**:
- 确保上传的是 MP4 或 MOV 格式的视频
- 模板文件应该是图片(JPG, PNG)或视频
- 使用标准编码的视频文件

---

## 🌐 步骤 3: 检查网络请求

### 打开浏览器开发者工具的 Network 标签

1. 按 F12 打开开发者工具
2. 切换到 **Network** (网络) 标签
3. 点击 "开始生成视频" 按钮
4. 查找 `/api/process` 请求

### 检查项

| 项目 | 正常值 | 说明 |
|-----|--------|------|
| Status | 200 | 请求成功 |
| Type | fetch | 请求类型 |
| Size | 几KB | 响应数据大小 |
| Time | 10秒-2分钟 | 处理时间(取决于视频大小) |

### 如果 Status 不是 200

- **400**: 客户端错误,检查上传的文件
- **500**: 服务器错误,查看服务器终端日志
- **pending**: 请求一直挂起,可能是服务器崩溃或超时

---

## 🔧 高级调试

### 1. 增加更多日志

在 `app/api/process/route.ts` 中添加更多 `console.log`:

```typescript
// 在任何你想调试的位置添加
console.log('调试点 X:', 变量名, 其他信息)
```

### 2. 测试 FFmpeg 是否工作

创建一个简单的测试脚本:

```bash
# test-ffmpeg.js
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

console.log('FFmpeg 路径:', ffmpegStatic);

ffmpeg.getAvailableFormats((err, formats) => {
  if (err) {
    console.error('FFmpeg 错误:', err);
  } else {
    console.log('FFmpeg 工作正常!');
    console.log('支持的格式:', Object.keys(formats).slice(0, 10));
  }
});
```

运行测试:
```bash
node test-ffmpeg.js
```

### 3. 检查 /tmp 目录权限

确保应用有权限写入 `/tmp` 目录:

```bash
# macOS/Linux
ls -la /tmp
```

如果没有权限,可能需要修改 `app/api/process/route.ts` 中的 `uploadDir` 和 `outputDir`。

---

## 📞 获取帮助

如果以上步骤都无法解决问题,请提供以下信息:

1. ✅ 操作系统和版本
2. ✅ Node.js 版本 (`node -v`)
3. ✅ 浏览器和版本
4. ✅ 浏览器控制台的**完整日志**(截图)
5. ✅ 服务器终端的**完整日志**(截图)
6. ✅ 上传的文件信息(格式、大小)
7. ✅ FFmpeg 版本 (`ffmpeg -version`)

---

## ✅ 快速检查清单

在报告问题前,请确认:

- [ ] Next.js 开发服务器正在运行
- [ ] 浏览器控制台已打开并查看
- [ ] 服务器终端日志已查看
- [ ] 已安装 FFmpeg (`ffmpeg -version` 能运行)
- [ ] 上传的文件格式正确 (视频: MP4/MOV, 图片: JPG/PNG)
- [ ] 文件大小在限制内 (< 500MB)
- [ ] 至少上传了一个视频和一个模板
- [ ] 已尝试刷新页面重试
- [ ] 已尝试重启开发服务器

---

## 🎯 最可能的原因

根据经验,**90% 的"一直渲染"问题**是由以下原因造成的:

1. **FFmpeg 未安装** (最常见!)
2. 文件上传失败
3. 视频格式不支持

请先重点检查这三项! 🎯

