/**
 * 任务快照持久化工具
 *
 * 该模块将内存中的队列状态同步到 Vercel KV（Upstash Redis），
 * 方便跨实例查询任务进度，避免出现 404 或状态丢失。
 */

import { kv } from '@vercel/kv'
import { BlobNotFoundError, del as deleteBlob, head as headBlob, put as putBlob } from '@vercel/blob'

import type { JobSnapshot } from '@/lib/job-queue'

const JOB_KEY_PREFIX = 'video-job'
const FALLBACK_TTL_SECONDS = 60 * 60 * 24 // 默认保存 24 小时

const ttlEnv = Number(process.env.JOB_SNAPSHOT_TTL_SECONDS)
const JOB_TTL_SECONDS =
  Number.isFinite(ttlEnv) && ttlEnv > 0 ? Math.round(ttlEnv) : FALLBACK_TTL_SECONDS

const kvReady = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
const blobToken =
  process.env.VERCEL_BLOB_READ_WRITE_TOKEN ??
  process.env.BLOB_READ_WRITE_TOKEN ??
  process.env.NEXT_PUBLIC_BLOB_READ_WRITE_TOKEN ??
  null
const blobReady = Boolean(blobToken)
const SNAPSHOT_BLOB_PREFIX = (process.env.JOB_SNAPSHOT_BLOB_PREFIX ?? 'job-snapshots').replace(/^\/+/, '').replace(/\/+$/, '')

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
 * 生成 Blob 存储中的标准化路径，格式为 job-snapshots/{id}.json。
 *
 * @param id - 任务 ID
 * @returns Blob 内部的相对路径
 */
function buildBlobPath(id: string): string {
  return `${SNAPSHOT_BLOB_PREFIX}/${id}.json`
}

/**
 * 将任务快照写入 Vercel KV，便于跨实例访问。
 *
 * @param snapshot - 需要持久化的任务信息
 */
async function persistSnapshotInKv(snapshot: JobSnapshot): Promise<void> {
  if (!kvReady) {
    return
  }

  try {
    await kv.set(buildJobKey(snapshot.id), snapshot, { ex: JOB_TTL_SECONDS })
  } catch (error) {
    console.warn('⚠️ KV 写入失败，将依赖其他存储回退。', error)
  }
}

/**
 * 将任务快照写入 Vercel Blob，作为 KV 缺失时的后备方案。
 *
 * @param snapshot - 需要持久化的任务信息
 */
async function persistSnapshotInBlob(snapshot: JobSnapshot): Promise<void> {
  if (!blobReady || !blobToken) {
    return
  }

  try {
    await putBlob(buildBlobPath(snapshot.id), JSON.stringify(snapshot), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: JOB_TTL_SECONDS,
      token: blobToken,
    })
  } catch (error) {
    console.warn('⚠️ Blob 写入失败，将依赖其他存储回退。', error)
  }
}

/**
 * 从 Vercel KV 获取任务快照。
 *
 * @param jobId - 任务 ID
 * @returns 找到时返回快照，否则 undefined
 */
async function readSnapshotFromKv(jobId: string): Promise<JobSnapshot | undefined> {
  if (!kvReady) {
    return undefined
  }

  try {
    const snapshot = await kv.get<JobSnapshot>(buildJobKey(jobId))
    return snapshot ?? undefined
  } catch (error) {
    console.warn('⚠️ KV 读取失败，尝试使用其他存储回退。', error)
    return undefined
  }
}

/**
 * 从 Blob 后备存储中读取任务快照。
 *
 * @param jobId - 任务 ID
 * @returns 找到时返回快照，否则 undefined
 */
async function readSnapshotFromBlob(jobId: string): Promise<JobSnapshot | undefined> {
  if (!blobReady || !blobToken) {
    return undefined
  }

  try {
    const metadata = await headBlob(buildBlobPath(jobId), { token: blobToken })
    const response = await fetch(metadata.downloadUrl, { cache: 'no-store' })
    if (!response.ok) {
      console.warn(`⚠️ Blob 读取失败，HTTP ${response.status} ${response.statusText}`)
      return undefined
    }
    const snapshot = (await response.json()) as JobSnapshot
    return snapshot
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return undefined
    }
    console.warn('⚠️ Blob 读取失败，返回 undefined。', error)
    return undefined
  }
}

/**
 * 删除 KV 中的任务快照。
 *
 * @param jobId - 任务 ID
 */
async function deleteSnapshotFromKv(jobId: string): Promise<void> {
  if (!kvReady) {
    return
  }

  try {
    await kv.del(buildJobKey(jobId))
  } catch (error) {
    console.warn('⚠️ KV 删除失败，将等待 TTL 自动过期。', error)
  }
}

/**
 * 删除 Blob 后备存储中的任务快照。
 *
 * @param jobId - 任务 ID
 */
async function deleteSnapshotFromBlob(jobId: string): Promise<void> {
  if (!blobReady || !blobToken) {
    return
  }

  try {
    await deleteBlob(buildBlobPath(jobId), { token: blobToken })
  } catch (error) {
    console.warn('⚠️ Blob 删除失败，需要后续人工清理。', error)
  }
}

/**
 * 将最新的任务快照写入 KV。
 *
 * @param snapshot - 当前任务状态
 * @returns Promise<void>
 */
export async function persistJobSnapshot(snapshot: JobSnapshot): Promise<void> {
  const tasks: Array<Promise<void>> = []

  tasks.push(persistSnapshotInKv(snapshot))
  tasks.push(persistSnapshotInBlob(snapshot))

  await Promise.allSettled(tasks)
}

/**
 * 从 KV 读取指定任务的快照。
 *
 * @param jobId - 任务 ID
 * @returns 若存在记录则返回快照
 */
export async function readJobSnapshotFromStore(jobId: string): Promise<JobSnapshot | undefined> {
  const attempts: Array<() => Promise<JobSnapshot | undefined>> = [() => readSnapshotFromKv(jobId), () => readSnapshotFromBlob(jobId)]

  for (const attempt of attempts) {
    const snapshot = await attempt()
    if (snapshot) {
      return snapshot
    }
  }

  return undefined
}

/**
 * 在任务完成或过期后删除 KV 中的快照。
 *
 * @param jobId - 任务 ID
 */
export async function deleteJobSnapshot(jobId: string): Promise<void> {
  await Promise.allSettled([deleteSnapshotFromKv(jobId), deleteSnapshotFromBlob(jobId)])
}


