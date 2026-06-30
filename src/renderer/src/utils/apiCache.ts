/**
 * 轻量级 API 请求缓存
 * - 相同参数的请求在 TTL 内直接返回缓存
 * - 自动去重：并发相同请求只发一次网络调用
 */

interface CacheEntry<T> {
  data: T
  timestamp: number
}

// 默认 TTL：5 分钟
const DEFAULT_TTL = 5 * 60 * 1000
// 短 TTL：30 秒（适用于频繁变化的数据）
const SHORT_TTL = 30 * 1000

// 缓存上限：防止内存无限增长
const MAX_CACHE_ENTRIES = 200

const cache = new Map<string, CacheEntry<unknown>>()
// 正在进行中的请求（用于去重）
const inflight = new Map<string, Promise<unknown>>()

function makeKey(prefix: string, ...args: unknown[]): string {
  return `${prefix}:${JSON.stringify(args)}`
}

/**
 * 带缓存的请求封装
 * @param prefix  缓存前缀（如 'jellyfin.getLibraries'）
 * @param args    请求参数（用于生成唯一 key）
 * @param fetcher 实际的请求函数
 * @param ttl     缓存有效期（毫秒），默认 5 分钟
 */
export async function cachedFetch<T>(
  prefix: string,
  args: unknown[],
  fetcher: () => Promise<T>,
  ttl: number = DEFAULT_TTL
): Promise<T> {
  const key = makeKey(prefix, ...args)

  // 1. 检查缓存
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (entry && Date.now() - entry.timestamp < ttl) {
    return entry.data
  }

  // 2. 去重：如果同一个 key 已有请求在飞行中，等待它的结果
  const existing = inflight.get(key)
  if (existing) {
    return existing as Promise<T>
  }

  // 3. 发起新请求
  const promise = fetcher()
    .then((data) => {
      cache.set(key, { data, timestamp: Date.now() })
      // 缓存满时淘汰最旧的条目
      if (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value
        if (oldestKey) cache.delete(oldestKey)
      }
      return data
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

/**
 * 手动清除指定前缀的缓存
 */
export function clearCache(prefix?: string): void {
  if (!prefix) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

/**
 * 手动设置缓存（用于写入后更新缓存）
 */
export function setCache<T>(prefix: string, args: unknown[], data: T): void {
  const key = makeKey(prefix, ...args)
  cache.set(key, { data, timestamp: Date.now() })
}

export { SHORT_TTL }
