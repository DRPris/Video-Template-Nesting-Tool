import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

export type TemplateVariant = 'vertical' | 'square' | 'landscape'

export interface ProcessResult {
    type: TemplateVariant
    blobUrl: string
    filename: string
}

export interface VideoProcessorPayload {
    videoFile: File
    templates: {
        vertical?: File
        square?: File
        landscape?: File
    }
}

// Helper to write file to FFmpeg FS
async function writeFileToFFmpeg(ffmpeg: FFmpeg, filename: string, file: File) {
    await ffmpeg.writeFile(filename, await fetchFile(file))
}

// Helper to read file from FFmpeg FS and create Blob URL
async function readFileAsBlobUrl(ffmpeg: FFmpeg, filename: string, mimeType: string = 'video/mp4'): Promise<string> {
    const data = await ffmpeg.readFile(filename)
    const blob = new Blob([data], { type: mimeType })
    return URL.createObjectURL(blob)
}

export async function processVideoClientSide(
    ffmpeg: FFmpeg,
    payload: VideoProcessorPayload,
    onProgress?: (completed: number, total: number) => void
): Promise<ProcessResult[]> {
    const { videoFile, templates } = payload
    const results: ProcessResult[] = []

    const videoName = 'input_video' + videoFile.name.substring(videoFile.name.lastIndexOf('.'))
    await writeFileToFFmpeg(ffmpeg, videoName, videoFile)

    const tasks = []
    if (templates.vertical) tasks.push({ type: 'vertical', file: templates.vertical })
    if (templates.square) tasks.push({ type: 'square', file: templates.square })
    if (templates.landscape) tasks.push({ type: 'landscape', file: templates.landscape })

    let completed = 0
    const total = tasks.length

    for (const task of tasks) {
        const templateName = `template_${task.type}` + task.file.name.substring(task.file.name.lastIndexOf('.'))
        await writeFileToFFmpeg(ffmpeg, templateName, task.file)

        const outputName = `output_${task.type}.mp4`
        const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(task.file.name)

        // Construct FFmpeg command based on variant
        // Note: We use the same filter logic as the server-side version
        let filterComplex = ''

        if (task.type === 'vertical') {
            // Vertical (1080x1920)
            const templateFilter = isImage
                ? '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template]'
                : '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template]'

            filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgba[video];${templateFilter};[video][template]overlay=0:0[out]`

        } else if (task.type === 'square') {
            // Square (1080x1080)
            const templateFilter = isImage
                ? '[1:v]scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template]'
                : '[1:v]scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template]'

            filterComplex = `[0:v]scale=-2:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[video_scaled];[video_scaled]pad=1080:1080:0:(1080-ih)/2:black,format=rgba[video_bg];${templateFilter};[video_bg][template]overlay=0:0[out]`

        } else if (task.type === 'landscape') {
            // Landscape (1920x1080)
            const templateFilter = isImage
                ? '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba,loop=-1:1:0[template_layer]'
                : '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,format=rgba[template_layer]'

            filterComplex = `[0:v]scale=-1:1080:flags=lanczos[scaled_video];[scaled_video]pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgba[video_layer];${templateFilter};[video_layer][template_layer]overlay=0:0[out]`
        }

        const args = [
            '-i', videoName,
            '-i', templateName,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-map', '0:a?', // Use audio from original video if available
            '-c:v', 'libx264',
            '-preset', 'ultrafast', // Use ultrafast for client-side performance
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-shortest',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outputName
        ]

        console.log(`Running FFmpeg for ${task.type}:`, args.join(' '))
        await ffmpeg.exec(args)

        const blobUrl = await readFileAsBlobUrl(ffmpeg, outputName)
        results.push({
            type: task.type as TemplateVariant,
            blobUrl,
            filename: outputName
        })

        // Cleanup input template to save memory (keep video for next iteration)
        try {
            await ffmpeg.deleteFile(templateName)
            await ffmpeg.deleteFile(outputName)
        } catch (e) {
            console.warn('Cleanup failed', e)
        }

        completed++
        onProgress?.(completed, total)
    }

    // Cleanup input video
    try {
        await ffmpeg.deleteFile(videoName)
    } catch (e) {
        console.warn('Cleanup failed', e)
    }

    return results
}
