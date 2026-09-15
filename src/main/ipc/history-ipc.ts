import { secureHandleRaw } from './secure-handle'
import { V } from './secure-schema'
import type { ServerConfig as JellyfinServerConfig } from '../services/server-manager'

export interface HistoryIpcHost {
  getConfig(): Record<string, unknown>
  setConfigValue(key: string, value: unknown): void
  saveConfigFile(): void
  findServerByUrlPrefix(url: string): { server: JellyfinServerConfig; prefix: string } | null
  normalizeUrl(url: string): string
}

let _host: HistoryIpcHost | null = null

function historyCfg(): Record<string, unknown> {
  return _host!.getConfig()
}



// ==================== IPC: 播放历史 ====================

interface PlayHistoryItem {
  itemId: string
  name: string
  duration: number
  position: number
  posterUrl: string
  watchedAt: number
  localFile?: string
  baseUrl?: string
  seriesName?: string
}

const HISTORY_KEY = 'history'

function loadHistory(): PlayHistoryItem[] {
  try {
    const raw = historyCfg()[HISTORY_KEY]
    if (Array.isArray(raw)) return raw as PlayHistoryItem[]
  } catch { /* ignore */ }
  return []
}

function saveHistory(items: PlayHistoryItem[]): void {
  historyCfg()[HISTORY_KEY] = items
  _host!.saveConfigFile()
}

// M10: 历史记录写入字段白名单 + 长度校验，watchedAt 由主进程强制覆盖，
// 防止渲染端伪造任意字段或时间戳置顶刷屏
function sanitizeHistoryItem(item: unknown): PlayHistoryItem | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  if (typeof it.itemId !== 'string' || !it.itemId || typeof it.name !== 'string' || !it.name) return null
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0)
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
  return {
    itemId: it.itemId.slice(0, 128),
    name: it.name.slice(0, 256),
    duration: num(it.duration),
    position: num(it.position),
    // 海报 URL 不信任渲染端传值（历史上曾把 api_key 拼进 URL 落盘），由主进程统一派生
    posterUrl: '',
    watchedAt: Date.now(),
    localFile: str(it.localFile, 1024),
    baseUrl: str(it.baseUrl, 256),
    seriesName: str(it.seriesName, 256)
  }
}

/** 由服务器配置派生历史海报 URL：serverId 格式协议链接（不含任何凭据）。
 * base-path 由主进程按 serverId 对应的服务器配置自动拼接（https://host/jellyfin 的 /jellyfin 会保留），
 * 展示时主进程注入认证头 */
function buildHistoryPosterUrl(baseUrl: string, itemId: string): string {
  try {
    const matched = _host!.findServerByUrlPrefix(_host!.normalizeUrl(baseUrl))
    if (!matched) return ''
    const proto = matched.server.type === 'emby' ? 'emby-image' : 'jellyfin-image'
    return `${proto}://${matched.server.id}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=300`
  } catch {
    return ''
  }
}

/** 一次性迁移：
 * 1) 旧历史 posterUrl 内嵌 api_key/token/access_token 明文 → 重写为协议 URL（重写失败则清空海报，凭据绝不保留）
 * 2) host 格式协议 URL / 明文服务器 URL（上一版迁移产物，存在 host 冲突、丢 base-path 问题）→ 升级为 serverId 格式 */
export function migrateHistoryPosters(): void {
  try {
    const items = loadHistory()
    let changed = false
    for (const it of items) {
      if (!it.posterUrl) continue
      const hasCredential = /[?&](api_key|token|access_token)=/i.test(it.posterUrl)
      const isLegacy =
        /^https?:\/\//i.test(it.posterUrl) ||
        /^jellyfin-image:\/\/(https?)\//i.test(it.posterUrl) ||
        /^emby-image:\/\/(https?)\//i.test(it.posterUrl)
      if (!hasCredential && !isLegacy) continue
      const migrated = (!it.localFile && it.baseUrl && it.itemId)
        ? buildHistoryPosterUrl(it.baseUrl, it.itemId)
        : ''
      if (migrated === it.posterUrl) continue
      it.posterUrl = migrated
      changed = true
    }
    if (changed) {
      saveHistory(items)
      console.log('[history] 已迁移历史海报 URL：升级为 serverId 协议链接（无凭据、保留 base-path）')
    }
  } catch (err) {
    console.warn('[history] 海报 URL 迁移失败:', err)
  }
}

secureHandleRaw('history:save', [V.object()], async (_event, item: PlayHistoryItem) => {
  const sanitized = sanitizeHistoryItem(item)
  if (!sanitized) return { success: false, error: 'invalid history item' }
  // 海报 URL 由主进程按服务器配置派生（不含凭据）
  if (!sanitized.localFile && sanitized.baseUrl && sanitized.itemId) {
    sanitized.posterUrl = buildHistoryPosterUrl(sanitized.baseUrl, sanitized.itemId)
  }
  const items = loadHistory()
  // 去重：同名同 itemId 覆盖更新
  const idx = items.findIndex((h) => h.itemId === sanitized.itemId)
  const entry: PlayHistoryItem = sanitized
  if (idx >= 0) {
    items.splice(idx, 1)
  }
  items.unshift(entry)
  // 最多保留 100 条
  if (items.length > 100) {
    items.length = 100
  }
  saveHistory(items)
  return { success: true }
})

secureHandleRaw('history:list', [], async () => {
  const items = loadHistory()
  return { success: true, data: items }
})

secureHandleRaw('history:delete', [V.string()], async (_event, itemId: string) => {
  let items = loadHistory()
  items = items.filter((h) => h.itemId !== itemId)
  saveHistory(items)
  return { success: true }
})

secureHandleRaw('history:clear', [], async () => {
  saveHistory([])
  return { success: true }
})

// ==================== IPC: 最近入库 ====================

interface RecentlyAddedItem {
  itemId: string
  name: string
  type: 'Movie' | 'Series' | 'Episode'
  productionYear?: number
  imageTag?: string
  seriesName?: string
  seriesId?: string
  seasonId?: string
  indexNumber?: number
  parentIndexNumber?: number
  addedAt: number
  serverId?: string
}

interface RecentlyAddedConfig {
  enabled: boolean
  displayCount: number
  scrollSpeed: number
  scrollPosition: number
}

const RECENTLY_ADDED_KEY = 'recentlyAdded'
const RECENTLY_ADDED_CONFIG_KEY = 'recentlyAddedConfig'
const MAX_RECENTLY_ADDED = 200

function loadRecentlyAdded(): RecentlyAddedItem[] {
  try {
    const raw = historyCfg()[RECENTLY_ADDED_KEY]
    if (Array.isArray(raw)) return raw as RecentlyAddedItem[]
  } catch { /* ignore */ }
  return []
}

function saveRecentlyAdded(items: RecentlyAddedItem[]): void {
  historyCfg()[RECENTLY_ADDED_KEY] = items
  _host!.saveConfigFile()
}

function loadRecentlyAddedConfig(): RecentlyAddedConfig {
  try {
    const raw = historyCfg()[RECENTLY_ADDED_CONFIG_KEY]
    if (raw && typeof raw === 'object') {
      return {
        enabled: (raw as any).enabled !== false,
        displayCount: (raw as any).displayCount || 12,
        scrollSpeed: (raw as any).scrollSpeed || 1,
        scrollPosition: (raw as any).scrollPosition || 0
      }
    }
  } catch { /* ignore */ }
  return {
    enabled: true,
    displayCount: 12,
    scrollSpeed: 1,
    scrollPosition: 0
  }
}

function saveRecentlyAddedConfig(config: RecentlyAddedConfig): void {
  historyCfg()[RECENTLY_ADDED_CONFIG_KEY] = config
  _host!.saveConfigFile()
}


export function registerHistoryIpc(host: HistoryIpcHost): void {
  _host = host

secureHandleRaw('recentlyAdded:list', [V.optional(V.number())], async (_event, limit?: number) => {
  try {
    let items = loadRecentlyAdded()

    items = items.filter(item => {
      const isValid = typeof item.addedAt === 'number' && item.addedAt > 0 && item.addedAt < Date.now() + 86400000
      if (!isValid) {
        console.warn(`[RecentlyAdded] 过滤无效记录: "${item.name}" | itemId: ${item.itemId} | addedAt: ${item.addedAt}`)
      }
      return isValid
    })

    const beforeSort = items.map(i => `${i.name}(${i.addedAt})`).join(', ')
    console.log(`[RecentlyAdded] 查询列表 - 过滤前: ${items.length} 条, 排序前: [${beforeSort.slice(0, 200)}${beforeSort.length > 200 ? '...' : ''}]`)

    items = items.sort((a, b) => b.addedAt - a.addedAt)

    const afterSort = items.map(i => `${i.name}(${i.addedAt})`).join(', ')
    console.log(`[RecentlyAdded] 查询列表 - 排序后: [${afterSort.slice(0, 200)}${afterSort.length > 200 ? '...' : ''}]`)

    if (limit && limit > 0) {
      items = items.slice(0, limit)
    }

    console.log(`[RecentlyAdded] 查询列表 - 返回: ${items.length} 条, 第一条: ${items[0]?.name || '空'}`)

    return { success: true, data: items }
  } catch (err) {
    console.error('recentlyAdded:list failed:', err)
    return { success: false, error: String(err) }
  }
})

// M10: 最近入库写入字段白名单 + addedAt 主进程强制覆盖，防伪造置顶刷屏
function sanitizeRecentlyAddedItem(item: unknown, forcedAt: number): RecentlyAddedItem | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  if (typeof it.itemId !== 'string' || !it.itemId || typeof it.name !== 'string' || !it.name) return null
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)
  return {
    itemId: it.itemId.slice(0, 128),
    name: it.name.slice(0, 256),
    type: it.type === 'Episode' ? 'Episode' : it.type === 'Series' ? 'Series' : 'Movie',
    productionYear: num(it.productionYear),
    imageTag: str(it.imageTag, 128),
    seriesName: str(it.seriesName, 256),
    seriesId: str(it.seriesId, 128),
    seasonId: str(it.seasonId, 128),
    indexNumber: num(it.indexNumber),
    parentIndexNumber: num(it.parentIndexNumber),
    addedAt: forcedAt
  }
}

secureHandleRaw('recentlyAdded:add', [V.object()], async (_event, item: RecentlyAddedItem) => {
  try {
    const entry = sanitizeRecentlyAddedItem(item, Date.now())
    if (!entry) return { success: false, error: 'invalid recentlyAdded item' }
    const items = loadRecentlyAdded()
    const idx = items.findIndex((i) => i.itemId === entry.itemId)
    if (idx >= 0) {
      items.splice(idx, 1)
    }
    items.unshift(entry)
    if (items.length > MAX_RECENTLY_ADDED) {
      items.length = MAX_RECENTLY_ADDED
    }
    saveRecentlyAdded(items)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:add failed:', err)
    return { success: false, error: String(err) }
  }
})

secureHandleRaw('recentlyAdded:addBatch', [V.array(V.object())], async (_event, newItems: RecentlyAddedItem[]) => {
  try {
    const items = loadRecentlyAdded()
    const now = Date.now()

    console.log(`[RecentlyAdded] 批量添加 - 待添加: ${newItems.length} 条`)

    for (let i = 0; i < newItems.length; i++) {
      // addedAt 由主进程按批次顺序生成，不接受渲染端传入值
      const entry = sanitizeRecentlyAddedItem(newItems[i], now + i)
      if (!entry) continue
      const idx = items.findIndex((it) => it.itemId === entry.itemId)
      if (idx >= 0) {
        items.splice(idx, 1)
        console.log(`[RecentlyAdded] 批量添加 - 更新已有记录: "${entry.name}"`)
      }
      items.unshift(entry)
      console.log(`[RecentlyAdded] 批量添加 - 新增记录: "${entry.name}" | 时间戳: ${entry.addedAt}`)
    }

    if (items.length > MAX_RECENTLY_ADDED) {
      const removed = items.length - MAX_RECENTLY_ADDED
      items.length = MAX_RECENTLY_ADDED
      console.log(`[RecentlyAdded] 批量添加 - 超出最大限制，移除 ${removed} 条旧记录`)
    }

    saveRecentlyAdded(items)
    console.log(`[RecentlyAdded] 批量添加 - 完成，总数: ${items.length} 条`)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:addBatch failed:', err)
    return { success: false, error: String(err) }
  }
})

secureHandleRaw('recentlyAdded:clear', [], async () => {
  try {
    saveRecentlyAdded([])
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:clear failed:', err)
    return { success: false, error: String(err) }
  }
})

secureHandleRaw('recentlyAdded:getConfig', [], async () => {
  try {
    const config = loadRecentlyAddedConfig()
    return { success: true, data: config }
  } catch (err) {
    console.error('recentlyAdded:getConfig failed:', err)
    return { success: false, error: String(err) }
  }
})

secureHandleRaw('recentlyAdded:saveConfig', [V.object()], async (_event, partialConfig: Partial<RecentlyAddedConfig>) => {
  try {
    const current = loadRecentlyAddedConfig()
    const updated = { ...current, ...partialConfig }
    saveRecentlyAddedConfig(updated)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:saveConfig failed:', err)
    return { success: false, error: String(err) }
  }
})
}
