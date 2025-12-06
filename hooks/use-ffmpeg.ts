import { useState, useRef } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

export function useFFmpeg() {
  const [loaded, setLoaded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState('')
  const ffmpegRef = useRef<FFmpeg | null>(null)

  const load = async () => {
    if (loaded) return
    setIsLoading(true)

    if (!ffmpegRef.current) {
      ffmpegRef.current = new FFmpeg()
    }

    const ffmpeg = ffmpegRef.current
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'

    ffmpeg.on('log', ({ message }) => {
      console.log(message)
      setMessage(message)
    })

    try {
      // Load ffmpeg.wasm from a CDN to avoid large bundle sizes
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      setLoaded(true)
    } catch (error) {
      console.error('Failed to load FFmpeg:', error)
      setMessage('Failed to load FFmpeg')
    } finally {
      setIsLoading(false)
    }
  }

  return {
    ffmpeg: ffmpegRef.current!, // Non-null assertion is safe after loaded is true, but we should handle it in UI
    loaded,
    isLoading,
    message,
    load,
  }
}
