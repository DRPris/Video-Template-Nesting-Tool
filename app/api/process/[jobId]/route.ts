/**
 * 任务状态查询 API
 *
 * 前端可以通过 GET /api/process/:jobId 获取最新的任务快照，
 * 从而实现轮询或基于 SSE/WebSocket 的订阅。
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'

import { getJobSnapshot } from '@/lib/job-queue'

interface JobStatusParams {
  jobId: string
}

/**
 * GET：返回指定 jobId 的实时状态。
 */
export async function GET(_req: NextRequest, context: { params: Promise<JobStatusParams> }) {
  const { jobId } = await context.params
  const job = getJobSnapshot(jobId)

  if (!job) {
    return NextResponse.json({ error: '任务不存在或已过期' }, { status: 404 })
  }

  return NextResponse.json({
    ...job,
    estimatedWaitSeconds: Math.max(0, Math.round(job.estimatedWaitMs / 1000)),
    averageJobDurationSeconds: Math.max(1, Math.round(job.averageJobDurationMs / 1000)),
  })
}

