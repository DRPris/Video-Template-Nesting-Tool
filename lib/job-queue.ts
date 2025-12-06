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
 * 允许任务持续处理的最短时间阈值（3 分钟），避免误判短任务。
 */
const MIN_STALLED_JOB_TIMEOUT_MS = 3 * 60 * 1000
/**
 * 超时时间 = 最近平均耗时 * 该系数。
 */
const STALLED_JOB_TIMEOUT_FACTOR = 4
/**
 * 连续多少次卡死后打开熔断。
 */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2
/**
 * 熔断维持的最短冷却时间。
 */
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 1000

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
  consecutiveStalledJobs: number
  circuitBreakerOpenedAt: number | null
  workerGeneration: number
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
    consecutiveStalledJobs: 0,
    circuitBreakerOpenedAt: null,
    workerGeneration: 0,
  } satisfies QueueState)

const jobStore = queueState.jobStore
const pendingQueue = queueState.pendingQueue

/**
 * 保存当前正在运行的队列 worker，以便重复利用并在需要时向
 * Vercel waitUntil 通知“还有后台任务需要完成”。
 */
let activeWorkerPromise: Promise<void> | null = null

/**
 * 递增 worker 代际编号，用于令旧 worker 察觉自己已失效。
 */
function bumpWorkerGeneration(): number {
  queueState.workerGeneration += 1
  return queueState.workerGeneration
}

/**
 * 判断指定 worker 是否仍与最新代际保持一致。
 */
function isWorkerGenerationCurrent(workerGeneration: number): boolean {
  return workerGeneration === queueState.workerGeneration
}

/**
 * 按照历史耗时推算卡死检测阈值。
 */
function computeStalledJobTimeoutMs(): number {
  const dynamicTimeout = queueState.averageDurationMs * STALLED_JOB_TIMEOUT_FACTOR
  return Math.max(Math.round(dynamicTimeout), MIN_STALLED_JOB_TIMEOUT_MS)
}

/**
 * 在任务顺利完成后重置熔断状态。
 */
function resetCircuitBreaker(): void {
  queueState.consecutiveStalledJobs = 0
  queueState.circuitBreakerOpenedAt = null
}

/**
 * 打开熔断，使后续请求在冷却前不再唤醒 worker。
 */
function openCircuitBreaker(reason: string): void {
  queueState.circuitBreakerOpenedAt = Date.now()
  console.error(`[JobQueue] 触发熔断: ${reason}`)
}

/**
 * 返回熔断剩余的冷却时间（毫秒）。
 */
function getCircuitBreakerRemainingMs(): number {
  if (!queueState.circuitBreakerOpenedAt) {
    return 0
  }
  const elapsed = Date.now() - queueState.circuitBreakerOpenedAt
  return Math.max(CIRCUIT_BREAKER_COOLDOWN_MS - elapsed, 0)
}

/**
 * 判断熔断是否仍生效；冷却结束时会自动复位。
 */
function isCircuitBreakerOpen(): boolean {
  if (!queueState.circuitBreakerOpenedAt) {
    return false
  }
  if (Date.now() - queueState.circuitBreakerOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    resetCircuitBreaker()
    return false
  }
  return true
}

/**
 * 将当前 worker 标记为失效，避免其在恢复后继续处理任务。
 */
function invalidateActiveWorker(reason: string): void {
  bumpWorkerGeneration()
  queueState.queueWorkerActive = false
  queueState.currentlyProcessingJob = null
  activeWorkerPromise = null
  console.warn(`[JobQueue] Worker 已失效: ${reason}`)
}

/**
 * 若发现任务卡死，则标记为失败并触发必要的熔断逻辑。
 */
async function failStalledJobIfNeeded(): Promise<boolean> {
  const stalledJobId = queueState.currentlyProcessingJob
  if (!stalledJobId) {
    return false
  }

  const job = jobStore.get(stalledJobId)
  if (!job || job.status !== 'processing' || job.startedAt === null) {
    return false
  }

  const timeoutMs = computeStalledJobTimeoutMs()
  const elapsedMs = Date.now() - job.startedAt
  if (elapsedMs < timeoutMs) {
    return false
  }

  const timeoutSeconds = Math.round(timeoutMs / 1000)
  const timeoutMessage = `任务执行超过 ${timeoutSeconds} 秒，系统自动终止以避免阻塞`
  job.status = 'failed'
  job.error = timeoutMessage
  job.message = '任务执行超时，系统已自动终止'
  job.progress = Math.min(job.progress, 99)
  job.updatedAt = Date.now()
  job.finishedAt = job.updatedAt
  persistSnapshot(job)
  recordJobDuration(job)

  await cleanupPayloadFiles(job.payload)

  queueState.currentlyProcessingJob = null
  queueState.consecutiveStalledJobs += 1

  console.warn(`[JobQueue] ${timeoutMessage}`, { jobId: job.id, elapsedMs })

  invalidateActiveWorker('卡死任务触发熔断')

  if (queueState.consecutiveStalledJobs >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    openCircuitBreaker(`连续 ${queueState.consecutiveStalledJobs} 个任务卡死`)
  }

  return true
}

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

async function runQueueWorker(workerGeneration: number): Promise<void> {
  queueState.queueWorkerActive = true

  try {
    while (pendingQueue.length > 0) {
      if (!isWorkerGenerationCurrent(workerGeneration)) {
        break
      }

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

        if (!isWorkerGenerationCurrent(workerGeneration) || job.status !== 'processing') {
          break
        }

        job.status = 'completed'
        job.progress = 100
        job.result = { videos: result.videos }
        job.message = result.message
        persistSnapshot(job)
      } catch (error) {
        if (!isWorkerGenerationCurrent(workerGeneration) || job.status !== 'processing') {
          break
        }

        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        job.message = '视频处理失败'
        persistSnapshot(job)
      } finally {
        const jobAlreadyFinalized = job.finishedAt !== null

        if (!jobAlreadyFinalized) {
          job.updatedAt = Date.now()
          job.finishedAt = Date.now()
          recordJobDuration(job)
        }

        queueState.currentlyProcessingJob = null
        await cleanupPayloadFiles(job.payload)

        if (!jobAlreadyFinalized) {
          resetCircuitBreaker()
        }
      }
    }
  } finally {
    if (isWorkerGenerationCurrent(workerGeneration)) {
      queueState.queueWorkerActive = false
      queueState.currentlyProcessingJob = null
    }
  }
}

function startQueueWorkerIfNeeded(): Promise<void> | undefined {
  if (pendingQueue.length === 0 && queueState.queueWorkerActive === false) {
    return activeWorkerPromise ?? undefined
  }

  if (activeWorkerPromise) {
    return activeWorkerPromise
  }

  const workerGeneration = bumpWorkerGeneration()
  const workerPromise = runQueueWorker(workerGeneration)

  activeWorkerPromise = workerPromise

  workerPromise.finally(() => {
    if (activeWorkerPromise === workerPromise) {
      activeWorkerPromise = null
    }
  })

  return workerPromise
}

/**
 * 供 API 层调用：在唤醒 worker 前执行超时检测与熔断判定。
 */
export async function ensureQueueWorkerRunning(): Promise<void> {
  const stalledJobCleared = await failStalledJobIfNeeded()
  if (stalledJobCleared) {
    console.warn('[JobQueue] 检测到卡死任务，已自动标记失败并重置队列。')
  }

  if (isCircuitBreakerOpen()) {
    const remaining = getCircuitBreakerRemainingMs()
    console.warn(`[JobQueue] 熔断生效，${remaining}ms 内不再重启 worker。`)
    return
  }

  return startQueueWorkerIfNeeded() ?? Promise.resolve()
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

