/**
 * 简易后台排队与异步处理模块
 *
 * 功能：
 * 1. 维护一个内存中的任务队列，确保视频渲染逻辑在后台串行运行
 * 2. 为 API 暴露任务快照信息，便于前端轮询或订阅
 * 3. 在任务完成后自动清理临时文件，避免磁盘堆积
 */

import fs from 'fs'
import { randomUUID } from 'crypto'
import {
  processVideoBatch,
  type VideoProcessorPayload,
  type GeneratedVideoResult,
} from '@/lib/video-processor'
import { persistJobSnapshot } from '@/lib/job-store'

/**
 * 估算等待时间的默认回退（2 分钟），单位：毫秒。
 * 该值会在有真实执行数据后被动态更新。
 */
const DEFAULT_JOB_DURATION_MS = 2 * 60 * 1000
const RECENT_DURATION_SAMPLE_LIMIT = 20

/**
 * 任务状态枚举。
 */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed'

/**
 * 对外暴露的任务查询结果。
 */
export interface JobSnapshot {
  id: string
  status: JobStatus
  progress: number
  createdAt: number
  updatedAt: number
  queuePosition: number
  estimatedWaitMs: number
  averageJobDurationMs: number
  message?: string
  result?: { videos: GeneratedVideoResult[] }
  error?: string
  metrics: {
    completedVariants: number
    totalVariants: number
  }
}

interface InternalJobRecord {
  id: string
  ownerId: string
  status: JobStatus
  progress: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  message?: string
  result?: { videos: GeneratedVideoResult[] }
  error?: string
  metrics: {
    completedVariants: number
    totalVariants: number
  }
  payload: VideoProcessorPayload
}

interface QueueState {
  jobStore: Map<string, InternalJobRecord>
  pendingQueue: string[]
  queueWorkerActive: boolean
  currentlyProcessingJob: string | null
  recentDurations: number[]
  averageDurationMs: number
}

const globalQueueStateKey = Symbol.for('__videoJobQueue')
const existingState = (globalThis as Record<PropertyKey, unknown>)[globalQueueStateKey] as QueueState | undefined

const queueState: QueueState =
  existingState ??
  ((globalThis as Record<PropertyKey, unknown>)[globalQueueStateKey] = {
    jobStore: new Map(),
    pendingQueue: [],
    queueWorkerActive: false,
    currentlyProcessingJob: null,
    recentDurations: [],
    averageDurationMs: DEFAULT_JOB_DURATION_MS,
  } satisfies QueueState)

const jobStore = queueState.jobStore
const pendingQueue = queueState.pendingQueue

/**
 * 将当前记录同步到持久化存储（忽略失败）。
 *
 * @param record - 需要同步的任务记录
 */
function persistSnapshot(record: InternalJobRecord): void {
  void persistJobSnapshot(toPublicSnapshot(record))
}

/**
 * 将视频处理请求入队，并立即返回任务 ID。
 *
 * @param payload - 上传的视频和模板信息
 * @returns 新任务的快照
 */
interface EnqueueOptions {
  ownerId: string
}

export function enqueueJob(payload: VideoProcessorPayload, options: EnqueueOptions): JobSnapshot {
  const ownerId = options.ownerId.trim()
  if (!ownerId) {
    throw new Error('缺少任务所属用户标识')
  }

  const jobId = randomUUID()
  const jobRecord: InternalJobRecord = {
    id: jobId,
    ownerId,
    status: 'pending',
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    message: undefined,
    result: undefined,
    error: undefined,
    metrics: { completedVariants: 0, totalVariants: 0 },
    payload,
  }

  jobStore.set(jobId, jobRecord)
  pendingQueue.push(jobId)
  void startQueueWorkerIfNeeded()

  const snapshot = toPublicSnapshot(jobRecord)
  persistSnapshot(jobRecord)
  return snapshot
}

/**
 * 根据 jobId 返回任务快照；若不存在则返回 undefined。
 */
export function getJobSnapshot(jobId: string): JobSnapshot | undefined {
  const record = jobStore.get(jobId)
  if (!record) return undefined
  return toPublicSnapshot(record)
}

/**
 * 返回队列中所有任务的快照，便于调试。
 */
export function listJobSnapshots(): JobSnapshot[] {
  return Array.from(jobStore.values()).map((job) => toPublicSnapshot(job))
}

function toPublicSnapshot(record: InternalJobRecord): JobSnapshot {
  return {
    id: record.id,
    status: record.status,
    progress: record.progress,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    queuePosition: computeLiveQueuePosition(record),
    estimatedWaitMs: computeEstimatedWaitMs(record),
    averageJobDurationMs: queueState.averageDurationMs,
    message: record.message,
    result: record.result,
    error: record.error,
    metrics: record.metrics,
  }
}

function computeLiveQueuePosition(record: InternalJobRecord): number {
  if (record.status === 'completed' || record.status === 'failed') {
    return 0
  }
  if (record.status === 'processing') {
    return 0
  }

  const indexInQueue = pendingQueue.indexOf(record.id)
  const jobsAheadInQueue = indexInQueue >= 0 ? indexInQueue : 0
  const processingPenalty = queueState.currentlyProcessingJob ? 1 : 0
  return jobsAheadInQueue + processingPenalty
}

async function startQueueWorkerIfNeeded(): Promise<void> {
  if (queueState.queueWorkerActive) {
    return
  }

  queueState.queueWorkerActive = true

  try {
    while (pendingQueue.length > 0) {
      const nextJobId = pendingQueue.shift()
      if (!nextJobId) {
        continue
      }

      const job = jobStore.get(nextJobId)
      if (!job) {
        continue
      }

      queueState.currentlyProcessingJob = job.id
      job.status = 'processing'
      job.progress = 5
      job.updatedAt = Date.now()
      job.startedAt = Date.now()
      job.metrics.completedVariants = 0
      persistSnapshot(job)

      try {
        const result = await processVideoBatch(job.payload, {
          onProgress: (completed, total) => {
            job.metrics.completedVariants = completed
            job.metrics.totalVariants = total
            job.progress = Math.min(99, Math.round((completed / total) * 100))
            job.updatedAt = Date.now()
            persistSnapshot(job)
          },
        })

        job.status = 'completed'
        job.progress = 100
        job.result = { videos: result.videos }
        job.message = result.message
        persistSnapshot(job)
      } catch (error) {
        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        job.message = '视频处理失败'
        persistSnapshot(job)
      } finally {
        job.updatedAt = Date.now()
        job.finishedAt = Date.now()
        recordJobDuration(job)
        queueState.currentlyProcessingJob = null
        await cleanupPayloadFiles(job.payload)
      }
    }
  } finally {
    queueState.queueWorkerActive = false
    queueState.currentlyProcessingJob = null
  }
}

async function cleanupPayloadFiles(payload: VideoProcessorPayload): Promise<void> {
  const filesToRemove = new Set<string>()
  payload.videos.forEach((file) => filesToRemove.add(file.path))
  if (payload.templates.vertical) filesToRemove.add(payload.templates.vertical.path)
  if (payload.templates.square) filesToRemove.add(payload.templates.square.path)
  if (payload.templates.landscape) filesToRemove.add(payload.templates.landscape.path)

  for (const filePath of filesToRemove) {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath)
      }
    } catch (error) {
      console.warn(`⚠️  清理临时文件失败: ${filePath}`, error)
    }
  }
}

function recordJobDuration(job: InternalJobRecord): void {
  if (!job.startedAt || !job.finishedAt) {
    return
  }

  const duration = Math.max(job.finishedAt - job.startedAt, 0)
  if (duration === 0) {
    return
  }

  queueState.recentDurations.push(duration)
  if (queueState.recentDurations.length > RECENT_DURATION_SAMPLE_LIMIT) {
    queueState.recentDurations.shift()
  }

  const sum = queueState.recentDurations.reduce((acc, value) => acc + value, 0)
  const average = sum / queueState.recentDurations.length
  queueState.averageDurationMs = Math.max(Math.round(average), DEFAULT_JOB_DURATION_MS * 0.25)
}

function computeEstimatedWaitMs(record: InternalJobRecord): number {
  const averageJobDurationMs = queueState.averageDurationMs || DEFAULT_JOB_DURATION_MS

  if (record.status === 'completed' || record.status === 'failed') {
    return 0
  }

  if (record.status === 'processing') {
    if (!record.startedAt) {
      return Math.round(averageJobDurationMs * 0.5)
    }
    const elapsed = Date.now() - record.startedAt
    const remaining = Math.max(averageJobDurationMs - elapsed, averageJobDurationMs * 0.1)
    return Math.round(Math.max(remaining, 0))
  }

  const queueSlotsAhead = computeLiveQueuePosition(record)
  return Math.round(queueSlotsAhead * averageJobDurationMs)
}

/**
 * 统计指定用户正在排队或处理的任务数量。
 */
export function getOwnerActiveJobCount(ownerId: string): number {
  if (!ownerId) {
    return 0
  }

  let count = 0
  jobStore.forEach((job) => {
    if (job.ownerId === ownerId && (job.status === 'pending' || job.status === 'processing')) {
      count += 1
    }
  })
  return count
}

