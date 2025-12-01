/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', 'ffmpeg-static', 'fluent-ffmpeg'],
  outputFileTracingIncludes: {
    '/api/process': [
      './node_modules/ffmpeg-static/**/*',
      './node_modules/@ffmpeg-installer/**/*',
    ],
  },
}

export default nextConfig
