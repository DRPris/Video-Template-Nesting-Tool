/**
 * 任务快照持久化工具
 *
 * 该模块将内存中的队列状态同步到 Vercel KV（Upstash Redis），
 * 方便跨实例查询任务进度，避免出现 404 或状态丢失。
 */

import { kv } from '@vercel/kv'

import type { JobSnapshot } from '@/lib/job-queue'

const JOB_KEY_PREFIX = 'video-job'
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 // 默认保存 24 小时

const ttlEnv = Number(process.env.JOB_SNAPSHOT_TTL_SECONDS)
const JOB_TTL_SECONDS =
  Number.isFinite(ttlEnv) && ttlEnv > 0 ? Math.round(ttlEnv) : FALLBACK_TTL_SECONDS

const kvReady = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

/**
 * 拼接 KV 中使用的任务键。
 *
 * @param id - 任务 ID
 * @returns 带前缀的 KV key
 */
function buildJobKey(id: string): string {
  return `${JOB_KEY_PREFIX}:${id}`
}

/**
 * 将最新的任务快照写入 KV。
 *
 * @param snapshot - 当前任务状态
 * @returns Promise<void>
 */
export async function persistJobSnapshot(snapshot: JobSnapshot): Promise<void> {
  if (!kvReady) {
    return
  }

  try {
    await kv.set(buildJobKey(snapshot.id), snapshot, { ex: JOB_TTL_SECONDS })
  } catch (error) {
    console.warn('⚠️ KV 写入失败，将继续使用内存数据', error)
  }
}

/**
 * 从 KV 读取指定任务的快照。
 *
 * @param jobId - 任务 ID
 * @returns 若存在记录则返回快照
 */
export async function readJobSnapshotFromStore(jobId: string): Promise<JobSnapshot | undefined> {
  if (!kvReady) {
    return undefined
  }

  try {
    const snapshot = await kv.get<JobSnapshot>(buildJobKey(jobId))
    return snapshot ?? undefined
  } catch (error) {
    console.warn('⚠️ KV 读取失败，回退到内存数据', error)
    return undefined
  }
}

/**
 * 在任务完成或过期后删除 KV 中的快照。
 *
 * @param jobId - 任务 ID
 */
export async function deleteJobSnapshot(jobId: string): Promise<void> {
  if (!kvReady) {
    return
  }

  try {
    await kv.del(buildJobKey(jobId))
  } catch (error) {
    console.warn('⚠️ KV 删除失败，将在 TTL 到期后自动过期', error)
  }
}


