/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', 'ffmpeg-static', 'fluent-ffmpeg'],
}

export default nextConfig
