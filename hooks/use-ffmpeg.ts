import { useState, useRef, useEffect } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

export function useFFmpeg() {
  const [loaded, setLoaded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState('')
  const ffmpegRef = useRef(new FFmpeg())

  const load = async () => {
    if (loaded) return
    setIsLoading(true)
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
    const ffmpeg = ffmpegRef.current
    
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
    ffmpeg: ffmpegRef.current,
    loaded,
    isLoading,
    message,
    load,
  }
}
