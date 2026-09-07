// 修复点 1.15: utils 目录下深一层
import type { DanmakuComment, DanmakuMatchMeta, DanmakuMatchCandidate } from '../../../shared/types'

interface MatchResult {
  episodeId: number
  animeTitle?: string
  animeId?: number
  source?: string
  matchLevel?: string
  confidence?: number
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
// 弹幕内容接口专用：自建 LogVar API 单次响应实测 ~10s（1.6MB，Tailscale 链路），
// 主进程 dandanRequest 内置重试（2 次 × 25s + 退避 ≈ 50.3s 最坏），
// 渲染端单次超时需覆盖主进程最坏情况，且不再叠加渲染端重试
const COMMENTS_REQUEST_TIMEOUT = 55000
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

  // 结构化元数据 cacheKey：mediaSourceId + seriesId + season + episode + filePath（一集一条，杜绝串集）
  // 本地文件无 seriesName/indexNumber，恒为 S0E0，必须追加 filePath 才能按文件隔离
  private metaCacheKey(meta: DanmakuMatchMeta): string {
    const safe = (s: string): string => s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
    const season = meta.parentIndexNumber ?? 0
    const episode = meta.indexNumber ?? 0
    const series = meta.seriesId || meta.seriesName || 'unknown'
    const filePart = meta.filePath ? `__${safe(meta.filePath)}` : ''
    return `${safe(meta.mediaSourceId)}__${safe(series)}__S${season}__E${episode}${filePart}`
  }

  // V2 多级匹配（manual→id→hash→metadata→regex→candidates）
  async matchEpisode(
    meta: DanmakuMatchMeta,
    forceRefresh: boolean = false,
    epoch?: number
  ): Promise<{ result: MatchResult | null; candidates?: DanmakuMatchCandidate[]; logs?: string[] }> {
    const safeEpoch = epoch ?? this.requestEpoch
    const startTime = Date.now()
    const cacheKey = this.metaCacheKey(meta)

    if (!forceRefresh) {
      const cached = this.matchCache.get(cacheKey)
      if (cached) {
        const age = Date.now() - cached.timestamp
        if (age < MATCH_CACHE_TTL) {
          if (!this.isEpochValid(safeEpoch)) return { result: null }
          console.log(`[DanmakuRequestManager:matchEpisode] ✅ 命中内存缓存, episodeId: ${cached.data.episodeId}, level: ${cached.data.matchLevel}`)
          return { result: cached.data }
        }
      }
    }

    try {
      const resp = await this.withRetry(() => {
        if (!this.isEpochValid(safeEpoch)) return Promise.reject(new Error('cancelled'))
        return this.withTimeout(
          window.api.danmaku.matchEpisode(meta),
          REQUEST_TIMEOUT,
          `danmaku:match-episode(${meta.seriesName} S${meta.parentIndexNumber ?? '?'}E${meta.indexNumber ?? '?'})`
        )
      }, `matchEpisode:${cacheKey}`)

      if (!this.isEpochValid(safeEpoch)) {
        console.log(`[DanmakuRequestManager:matchEpisode] ❌ 结果已过期（用户切集/取消），丢弃`)
        return { result: null }
      }

      if (resp.success && resp.data) {
        const d = resp.data
        const normalized: MatchResult = {
          episodeId: typeof d.episodeId === 'number' ? d.episodeId : parseInt(String(d.episodeId), 10) || 0,
          animeId: d.animeId,
          animeTitle: d.animeTitle,
          source: d.source,
          matchLevel: d.matchLevel,
          confidence: d.confidence
        }
        if (normalized.episodeId) {
          this.matchCache.set(cacheKey, { data: normalized, timestamp: Date.now() })
        }
        const elapsed = Date.now() - startTime
        console.log(`[DanmakuRequestManager:matchEpisode] ✅ 匹配成功, 耗时: ${elapsed}ms, level=${normalized.matchLevel}, conf=${normalized.confidence}`)
        return { result: normalized, candidates: resp.candidates, logs: resp.log }
      }
      console.warn(`[DanmakuRequestManager:matchEpisode] 未命中: ${resp.error || 'no data'}，候选 ${resp.candidates?.length ?? 0} 个`)
      return { result: null, candidates: resp.candidates, logs: resp.log }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === 'cancelled') return { result: null }
      console.error(`[DanmakuRequestManager:matchEpisode] 异常: ${errMsg}`)
      return { result: null }
    }
  }

  async getComments(episodeId: string, source?: string, forceRefresh: boolean = false, epoch?: number, ignoreEpoch: boolean = false): Promise<CommentsResult | null> {
    const safeEpoch = epoch ?? this.requestEpoch
    const startTime = Date.now()
    const cacheKey = `${episodeId}:${source || 'default'}`

    if (!forceRefresh) {
      const cached = this.commentsCache.get(cacheKey)
      if (cached) {
        const age = Date.now() - cached.timestamp
        if (age < COMMENTS_CACHE_TTL) {
          if (!ignoreEpoch && !this.isEpochValid(safeEpoch)) return null
          console.log(`[DanmakuRequestManager:getComments] ✅ 命中内存缓存, 弹幕: ${cached.data.count}条`)
          return cached.data
        }
      }
    }

    try {
      // 单次长超时（55s），不叠加渲染端重试 —— 主进程 dandanRequest 已内置
      // 重试（2 次 × 25s），双重重试会叠加成最多 6 个请求且拉长失败反馈
      const result = await this.withTimeout(
        window.api.danmaku.getComments(episodeId, source),
        COMMENTS_REQUEST_TIMEOUT,
        `danmaku:getComments(${episodeId})`
      )

      if (!ignoreEpoch && !this.isEpochValid(safeEpoch)) {
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

  // V2 加载入口：接收结构化元数据，切集时由 Player 传入新的 meta（含新 season/episode）
  // 返回 null = 已取消（epoch 失效）；返回 { ok:false, candidates } = 需手动选择
  async loadDanmaku(
    meta: DanmakuMatchMeta,
    localFile?: string
  ): Promise<{
    ok: boolean
    count?: number
    comments?: DanmakuComment[]
    source?: string
    matchLevel?: string
    confidence?: number
    candidates?: DanmakuMatchCandidate[]
    logs?: string[]
  } | null> {
    // 修复点 2.7: 创建新的 epoch，任何上一次调用（即便它的 await 已经挂起）返回后都会因 epoch 不同而被丢弃
    const epoch = this.nextEpoch()
    const startTime = Date.now()
    const log = (msg: string): void => {
      console.log(`[DanmakuRequestManager:loadDanmaku][epoch=${epoch}] ${msg}`)
      try { void window.api.log?.send?.('info', 'renderer', `[DanmakuRequestManager:loadDanmaku] ${msg}`) } catch { /* ignore */ }
    }
    log(`开始加载, series="${meta.seriesName}", S${meta.parentIndexNumber ?? '?'}E${meta.indexNumber ?? '?'}, itemId=${meta.itemId}, localFile="${localFile || 'none'}"`)

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
          return { ok: true, count: data.count ?? comments.length, comments, source: data.source }
        }
        log(`⚠️ 本地XML未找到 (${xmlResult.error || 'empty'})，尝试远程匹配`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`⚠️ 本地XML加载异常: ${errMsg}，继续远程匹配`)
      }
    }

    log(`步骤1/2: 多级匹配弹幕资源 (manual→id→hash→metadata→regex→candidates)`)
    const { result: matchResult, candidates, logs } = await this.matchEpisode(meta, false, epoch)
    if (!this.isEpochValid(epoch)) return null

    if (!matchResult) {
      log(`❌ 步骤1/2 未命中精准资源${candidates && candidates.length ? `，返回 ${candidates.length} 个候选供手动选择` : ''}`)
      return { ok: false, candidates, logs }
    }
    log(`✅ 步骤1/2 成功: episodeId=${matchResult.episodeId}, source=${matchResult.source || 'unknown'}, level=${matchResult.matchLevel}, conf=${matchResult.confidence}`)

    // animeId 预加载延迟到步骤 2（getComments）完成之后再触发，
    // 避免并发抢占当前集请求的带宽/配额，降低 429 或带宽竞争概率。
    let prefetchSchedule: { animeId: number; epId: number } | null = null
    if (matchResult.animeId) {
      prefetchSchedule = { animeId: matchResult.animeId, epId: matchResult.episodeId }
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
      return { ok: false, candidates, logs }
    }

    // 当前集弹幕请求已完成 → 启动后台预加载（非阻塞）
    if (prefetchSchedule) {
      const { animeId, epId } = prefetchSchedule
      setTimeout(() => {
        log(`后台预加载系列弹幕: animeId=${animeId}, 跳过当前集=${epId}`)
        window.api.danmaku.prefetchSeries(animeId, epId).catch((err) => {
          console.warn(`[DanmakuRequestManager] 预加载失败:`, err instanceof Error ? err.message : err)
        })
      }, 1000)
    }

    const elapsed = Date.now() - startTime
    log(`✅ 加载完成, 耗时: ${elapsed}ms, 弹幕: ${commentsResult.count}条`)

    return {
      ok: true,
      count: commentsResult.count,
      comments: commentsResult.comments,
      source: matchResult.source,
      matchLevel: matchResult.matchLevel,
      confidence: matchResult.confidence,
      // 低置信度时附带候选，UI 可提示手动确认
      candidates: (matchResult.confidence != null && matchResult.confidence < 0.6) ? candidates : undefined,
      logs
    }
  }

  // 弹幕搜索（带超时，避免主进程请求挂起时 UI 无限转圈）
  // 注意：search 是独立的查询操作，不递增 epoch —— 否则会静默取消正在进行的弹幕加载，
  // 导致加载停摆且 UI 无提示（用户只是打开搜索面板，并不想取消当前加载）
  // 超时 22s：覆盖主进程 search 重试最坏情况（2 × 10s + 退避），不叠加渲染端重试
  async search(keyword: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
    try {
      return await this.withTimeout(
        window.api.danmaku.search(keyword),
        22000,
        `danmaku:search("${keyword}")`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('超时') || msg.includes('timeout')) {
        return { success: false, error: '搜索超时，请检查网络或稍后重试' }
      }
      return { success: false, error: msg }
    }
  }

  // 手动绑定弹幕源（用户从候选列表选定后调用，持久化，下次直接复用精准ID）
  // meta: 可选，传入时同时删除该集的匹配缓存 —— 否则 matchCache（7 天 TTL）会
  // 在下次自动加载时先于主进程 manual 层命中，返回旧的匹配结果
  async bindEpisode(entry: {
    mediaSourceId: string
    itemId: string
    episodeId: number
    animeId?: number
    animeTitle?: string
    episodeTitle?: string
    source: string
    boundAt?: number
  }, meta?: DanmakuMatchMeta): Promise<boolean> {
    const entryWithBoundAt = { ...entry, boundAt: entry.boundAt ?? Date.now() }
    try {
      await window.api.danmaku.bindEpisode(entryWithBoundAt)
      // 同时清除该集的匹配缓存，强制下次走 manual 绑定
      if (meta) this.matchCache.delete(this.metaCacheKey(meta))
      return true
    } catch (err) {
      console.error(`[DanmakuRequestManager:bindEpisode] 绑定失败:`, err)
      return false
    }
  }

  // 用手动绑定的 episodeId 直接获取弹幕（跳过匹配）
  async loadByBind(
    meta: DanmakuMatchMeta,
    episodeId: number,
    source: string
  ): Promise<{ ok: boolean; count?: number; comments?: DanmakuComment[]; source?: string } | null> {
    const epoch = this.nextEpoch()
    const log = (msg: string): void => {
      console.log(`[DanmakuRequestManager:loadByBind][epoch=${epoch}] ${msg}`)
    }
    log(`手动绑定加载: episodeId=${episodeId}, source=${source}`)
    const commentsResult = await this.getComments(String(episodeId), source, false, epoch)
    if (!this.isEpochValid(epoch)) return null
    if (!commentsResult) {
      log(`❌ 获取弹幕失败`)
      return { ok: false }
    }
    log(`✅ 加载成功: ${commentsResult.count}条`)
    return { ok: true, count: commentsResult.count, comments: commentsResult.comments, source }
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
