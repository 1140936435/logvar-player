// 修复点 1.15: utils 目录下深一层
import type { DanmakuComment } from '../../../shared/types'

interface MatchResult {
  episodeId: number
  animeTitle?: string
  animeId?: number
  source?: string
}

interface CommentsResult {
  count: number
  comments: DanmakuComment[]
}

interface MatchCacheEntry {
  data: MatchResult
  timestamp: number
}

interface CommentsCacheEntry {
  data: CommentsResult
  timestamp: number
}

const MATCH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const COMMENTS_CACHE_TTL = 30 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT = 15000
// 修复点 3.2: 指数退避重试
const MAX_RETRIES = 2
const RETRY_BASE_DELAY = 600

export class DanmakuRequestManager {
  private matchCache = new Map<string, MatchCacheEntry>()
  private commentsCache = new Map<string, CommentsCacheEntry>()

  // 修复点 2.2 / 2.7: 用递增的"请求代次"替代 token，每次 cancel/重新加载都会递增。
  // 所有异步 await 返回后都必须比对当前代次，失效则直接丢弃结果，绝不写入 UI/缓存。
  private requestEpoch = 0

  private nextEpoch(): number {
    this.requestEpoch += 1
    const epoch = this.requestEpoch
    console.log(`[DanmakuRequestManager] nextEpoch=${epoch}`)
    return epoch
  }

  private isEpochValid(epoch: number): boolean {
    const ok = epoch === this.requestEpoch
    if (!ok) {
      console.log(`[DanmakuRequestManager] epoch mismatch: call=${epoch} current=${this.requestEpoch}, drop stale result`)
    }
    return ok
  }

  private async withTimeout<T>(promise: Promise<T>, timeout: number, operation: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      const timer = setTimeout(() => {
        const elapsed = Date.now() - startTime
        console.error(`[DanmakuRequestManager:withTimeout] 请求超时: ${operation}, 耗时: ${elapsed}ms, 超时阈值: ${timeout}ms`)
        reject(new Error(`请求超时 (${operation}, ${timeout}ms)`))
      }, timeout)
      promise.then(
        (result) => { clearTimeout(timer); resolve(result) },
        (error) => { clearTimeout(timer); reject(error) }
      )
    })
  }

  // 修复点 3.2: 指数退避重试包装器
  private async withRetry<T>(
    fn: () => Promise<T>,
    operation: string,
    maxRetries: number = MAX_RETRIES
  ): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn()
        if (attempt > 0) {
          console.log(`[DanmakuRequestManager:retry] ${operation} 第 ${attempt + 1} 次尝试成功`)
        }
        return result
      } catch (e) {
        lastErr = e
        if (attempt < maxRetries) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 200
          console.warn(`[DanmakuRequestManager:retry] ${operation} 第 ${attempt + 1} 次失败，${delay.toFixed(0)}ms 后重试: ${e instanceof Error ? e.message : String(e)}`)
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async match(title: string, forceRefresh: boolean = false, epoch?: number): Promise<MatchResult | null> {
    const safeEpoch = epoch ?? this.requestEpoch
    const startTime = Date.now()
    const cacheKey = title.toLowerCase().trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')

    if (!forceRefresh) {
      const cached = this.matchCache.get(cacheKey)
      if (cached) {
        const age = Date.now() - cached.timestamp
        if (age < MATCH_CACHE_TTL) {
          if (!this.isEpochValid(safeEpoch)) return null
          console.log(`[DanmakuRequestManager:match] ✅ 命中内存缓存, episodeId: ${cached.data.episodeId}`)
          return cached.data
        }
      }
    }

    try {
      const result = await this.withRetry(() => {
        if (!this.isEpochValid(safeEpoch)) return Promise.reject(new Error('cancelled'))
        return this.withTimeout(
          window.api.danmaku.match(title),
          REQUEST_TIMEOUT,
          `danmaku:match("${title}")`
        )
      }, `match:${title}`)

      if (!this.isEpochValid(safeEpoch)) {
        console.log(`[DanmakuRequestManager:match] ❌ 结果已过期（用户切集/取消），丢弃`)
        return null
      }

      if (result.success && result.data) {
        const data = result.data as unknown as MatchResult
        // 容错：Jellyfin/dandanplay 接口类型可能有 string/number 两种 episodeId，强转数字
        const normalized: MatchResult = {
          ...data,
          episodeId: typeof data.episodeId === 'number'
            ? data.episodeId
            : parseInt(String(data.episodeId), 10) || 0
        }
        if (normalized.episodeId) {
          this.matchCache.set(cacheKey, { data: normalized, timestamp: Date.now() })
        }
        const elapsed = Date.now() - startTime
        console.log(`[DanmakuRequestManager:match] ✅ 匹配成功, 耗时: ${elapsed}ms`)
        return normalized
      }
      console.warn(`[DanmakuRequestManager:match] 接口返回失败: ${result.error || 'no data'}`)
      return null
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === 'cancelled') return null
      console.error(`[DanmakuRequestManager:match] 异常: ${errMsg}`)
      return null
    }
  }

  async getComments(episodeId: string, source?: string, forceRefresh: boolean = false, epoch?: number): Promise<CommentsResult | null> {
    const safeEpoch = epoch ?? this.requestEpoch
    const startTime = Date.now()
    const cacheKey = `${episodeId}:${source || 'default'}`

    if (!forceRefresh) {
      const cached = this.commentsCache.get(cacheKey)
      if (cached) {
        const age = Date.now() - cached.timestamp
        if (age < COMMENTS_CACHE_TTL) {
          if (!this.isEpochValid(safeEpoch)) return null
          console.log(`[DanmakuRequestManager:getComments] ✅ 命中内存缓存, 弹幕: ${cached.data.count}条`)
          return cached.data
        }
      }
    }

    try {
      const result = await this.withRetry(() => {
        if (!this.isEpochValid(safeEpoch)) return Promise.reject(new Error('cancelled'))
        return this.withTimeout(
          window.api.danmaku.getComments(episodeId, source),
          REQUEST_TIMEOUT,
          `danmaku:getComments(${episodeId})`
        )
      }, `getComments:${episodeId}`)

      if (!this.isEpochValid(safeEpoch)) {
        console.log(`[DanmakuRequestManager:getComments] ❌ 结果已过期，丢弃`)
        return null
      }

      if (result.success && result.data) {
        const raw = result.data as unknown as { count?: number; comments?: DanmakuComment[] }
        const comments = Array.isArray(raw.comments) ? raw.comments : []
        const data: CommentsResult = {
          count: typeof raw.count === 'number' ? raw.count : comments.length,
          comments
        }
        this.commentsCache.set(cacheKey, { data, timestamp: Date.now() })
        const elapsed = Date.now() - startTime
        console.log(`[DanmakuRequestManager:getComments] ✅ 获取成功, 耗时: ${elapsed}ms, ${data.count}条`)
        return data
      }
      console.warn(`[DanmakuRequestManager:getComments] 接口返回失败: ${result.error || 'no data'}`)
      return null
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === 'cancelled') return null
      console.error(`[DanmakuRequestManager:getComments] 异常: ${errMsg}`)
      return null
    }
  }

  async loadDanmaku(title: string, localFile?: string): Promise<{ count: number; comments: DanmakuComment[]; source?: string } | null> {
    // 修复点 2.7: 创建新的 epoch，任何上一次调用（即便它的 await 已经挂起）返回后都会因 epoch 不同而被丢弃
    const epoch = this.nextEpoch()
    const startTime = Date.now()
    const log = (msg: string): void => {
      console.log(`[DanmakuRequestManager:loadDanmaku][epoch=${epoch}] ${msg}`)
      try { void window.api.log?.send?.('info', 'renderer', `[DanmakuRequestManager:loadDanmaku] ${msg}`) } catch { /* ignore */ }
    }
    log(`开始加载, title="${title}", localFile="${localFile || 'none'}"`)

    if (localFile) {
      log(`检测到本地文件，优先尝试本地 XML`)
      try {
        const xmlResult = await this.withTimeout(
          window.api.danmaku.findLocalXml(localFile),
          REQUEST_TIMEOUT,
          `danmaku:findLocalXml`
        )
        if (!this.isEpochValid(epoch)) return null
        if (xmlResult.success && xmlResult.data) {
          const data = xmlResult.data as { count?: number; comments?: DanmakuComment[]; source?: string }
          const comments = Array.isArray(data.comments) ? data.comments : []
          log(`✅ 本地XML加载成功: ${comments.length}条`)
          return { count: data.count ?? comments.length, comments, source: data.source }
        }
        log(`⚠️ 本地XML未找到 (${xmlResult.error || 'empty'})，尝试远程匹配`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`⚠️ 本地XML加载异常: ${errMsg}，继续远程匹配`)
      }
    }

    log(`步骤1/2: 匹配弹幕资源`)
    const matchResult = await this.match(title, false, epoch)
    if (!this.isEpochValid(epoch)) return null

    if (!matchResult) {
      log(`❌ 步骤1/2 失败：未匹配到资源`)
      return null
    }
    log(`✅ 步骤1/2 成功: episodeId=${matchResult.episodeId}, source=${matchResult.source || 'unknown'}`)

    if (matchResult.animeId) {
      log(`后台预加载系列弹幕: animeId=${matchResult.animeId}`)
      window.api.danmaku.prefetchSeries(matchResult.animeId).catch((err) => {
        console.warn(`[DanmakuRequestManager] 预加载失败:`, err instanceof Error ? err.message : err)
      })
    }

    log(`步骤2/2: 获取弹幕内容`)
    const commentsResult = await this.getComments(
      String(matchResult.episodeId),
      matchResult.source,
      false,
      epoch
    )
    if (!this.isEpochValid(epoch)) return null

    if (!commentsResult) {
      log(`❌ 步骤2/2 失败：获取弹幕内容失败`)
      return null
    }

    const elapsed = Date.now() - startTime
    log(`✅ 加载完成, 耗时: ${elapsed}ms, 弹幕: ${commentsResult.count}条`)

    return {
      count: commentsResult.count,
      comments: commentsResult.comments,
      source: matchResult.source
    }
  }

  prefetchSeries(animeId: number): void {
    window.api.danmaku.prefetchSeries(animeId).catch((err) => {
      console.warn(`[DanmakuRequestManager:prefetchSeries] 预加载失败:`, err)
    })
  }

  clearCache(): void {
    console.log(`[DanmakuRequestManager:clearCache] 清空缓存: 匹配 ${this.matchCache.size} 条, 弹幕 ${this.commentsCache.size} 条`)
    this.matchCache.clear()
    this.commentsCache.clear()
  }

  // 修复点 2.2: 取消 = 递增 epoch，之前所有挂起的请求返回时都会因 epoch 不符而被丢弃
  cancel(): void {
    const newEpoch = this.nextEpoch()
    console.log(`[DanmakuRequestManager:cancel] 已递增 requestEpoch -> ${newEpoch}，丢弃所有挂起请求`)
  }
}

export const danmakuRequestManager = new DanmakuRequestManager()
