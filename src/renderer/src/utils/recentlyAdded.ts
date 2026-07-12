/**
 * 最近入库媒体管理工具
 * 统一管理最近入库数据的获取、缓存、配置和入库检测
 */

import type { RecentlyAddedItem, RecentlyAddedConfig } from '../../../shared/types'

// 内存缓存：避免重复 IPC 调用
let cachedList: RecentlyAddedItem[] | null = null
let cachedConfig: RecentlyAddedConfig | null = null
let listCacheTime = 0
let configCacheTime = 0

const LIST_CACHE_TTL = 30 * 1000 // 列表缓存 30 秒
const CONFIG_CACHE_TTL = 60 * 1000 // 配置缓存 60 秒

/**
 * 获取最近入库列表
 * @param limit 限制数量，默认从配置读取
 * @param forceRefresh 是否强制刷新缓存
 */
export async function getRecentlyAdded(limit?: number, forceRefresh = false): Promise<RecentlyAddedItem[]> {
  try {
    const now = Date.now()
    if (!forceRefresh && cachedList && now - listCacheTime < LIST_CACHE_TTL) {
      return limit ? cachedList.slice(0, limit) : cachedList
    }

    const result = await window.api.recentlyAdded.list(limit || 100)
    if (result.success && result.data) {
      cachedList = result.data
      listCacheTime = now
      return result.data
    }
    return []
  } catch (err) {
    console.error('[RecentlyAdded] 获取列表失败:', err)
    return cachedList || []
  }
}

/**
 * 添加单条入库记录
 */
export async function addRecentlyAdded(item: RecentlyAddedItem): Promise<boolean> {
  try {
    const result = await window.api.recentlyAdded.add(item)
    if (result.success) {
      // 使缓存失效
      cachedList = null
      return true
    }
    return false
  } catch (err) {
    console.error('[RecentlyAdded] 添加记录失败:', err)
    return false
  }
}

/**
 * 批量添加入库记录
 */
export async function addRecentlyAddedBatch(items: RecentlyAddedItem[]): Promise<boolean> {
  try {
    const result = await window.api.recentlyAdded.addBatch(items)
    if (result.success) {
      cachedList = null
      return true
    }
    return false
  } catch (err) {
    console.error('[RecentlyAdded] 批量添加失败:', err)
    return false
  }
}

/**
 * 清空最近入库记录
 */
export async function clearRecentlyAdded(): Promise<boolean> {
  try {
    const result = await window.api.recentlyAdded.clear()
    if (result.success) {
      cachedList = null
      return true
    }
    return false
  } catch (err) {
    console.error('[RecentlyAdded] 清空失败:', err)
    return false
  }
}

/**
 * 获取最近入库配置
 */
export async function getRecentlyAddedConfig(forceRefresh = false): Promise<RecentlyAddedConfig> {
  try {
    const now = Date.now()
    if (!forceRefresh && cachedConfig && now - configCacheTime < CONFIG_CACHE_TTL) {
      return cachedConfig
    }

    const result = await window.api.recentlyAdded.getConfig()
    if (result.success && result.data) {
      cachedConfig = result.data
      configCacheTime = now
      return result.data
    }
  } catch (err) {
    console.error('[RecentlyAdded] 获取配置失败:', err)
  }
  // 返回默认配置
  const defaultConfig: RecentlyAddedConfig = {
    enabled: true,
    displayCount: 12,
    scrollSpeed: 1,
    scrollPosition: 0
  }
  if (!cachedConfig) cachedConfig = defaultConfig
  return defaultConfig
}

/**
 * 保存最近入库配置
 */
export async function saveRecentlyAddedConfig(config: Partial<RecentlyAddedConfig>): Promise<boolean> {
  try {
    const result = await window.api.recentlyAdded.saveConfig(config)
    if (result.success) {
      // 更新缓存
      if (cachedConfig) {
        cachedConfig = { ...cachedConfig, ...config }
      }
      configCacheTime = Date.now()
      return true
    }
    return false
  } catch (err) {
    console.error('[RecentlyAdded] 保存配置失败:', err)
    return false
  }
}

/**
 * 检测新增媒体并自动记录入库
 * 对比现有记录和新加载的媒体列表，找出新增项并记录
 * @param newItems 新加载的媒体项数组（来自 Jellyfin API）
 * @param serverId 当前服务器 ID
 */
export async function detectAndRecordNewMedia(
  newItems: Array<{ Id: string; Name: string; Type: string; ProductionYear?: number; ImageTags?: Record<string, string>; SeriesName?: string; SeriesId?: string; SeasonId?: string; IndexNumber?: number; ParentIndexNumber?: number }>,
  serverId?: string
): Promise<number> {
  try {
    // 获取现有列表（完整列表用于对比）
    const existing = await getRecentlyAdded(100, false)
    const existingIds = new Set(existing.map(item => item.itemId))

    // 筛选新增项
    const newEntries: RecentlyAddedItem[] = []
    const now = Date.now()

    for (const item of newItems) {
      if (!existingIds.has(item.Id)) {
        // 只记录电影和剧集（不记录单集，避免数量过多）
        if (item.Type === 'Movie' || item.Type === 'Series') {
          newEntries.push({
            itemId: item.Id,
            name: item.Name,
            type: item.Type as 'Movie' | 'Series',
            productionYear: item.ProductionYear,
            imageTag: item.ImageTags?.Primary,
            seriesName: item.SeriesName,
            seriesId: item.SeriesId,
            seasonId: item.SeasonId,
            indexNumber: item.IndexNumber,
            parentIndexNumber: item.ParentIndexNumber,
            addedAt: now,
            serverId
          })
        }
      }
    }

    if (newEntries.length > 0) {
      console.log(`[RecentlyAdded] 检测到 ${newEntries.length} 部新增媒体`)
      await addRecentlyAddedBatch(newEntries)
    }

    return newEntries.length
  } catch (err) {
    console.error('[RecentlyAdded] 检测新增媒体失败:', err)
    return 0
  }
}

/**
 * 格式化入库时间描述
 * @param addedAt 入库时间戳（毫秒）
 * @returns 格式化字符串，如 "刚刚入库"、"3天前入库"
 */
export function formatAddedTimeAgo(addedAt: number): string {
  const diff = Date.now() - addedAt
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚入库'
  if (minutes < 60) return `${minutes}分钟前入库`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前入库`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前入库`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月前入库`
  const years = Math.floor(months / 12)
  return `${years}年前入库`
}

/**
 * 清除缓存（用于需要强制刷新的场景）
 */
export function clearRecentlyAddedCache(): void {
  cachedList = null
  cachedConfig = null
  listCacheTime = 0
  configCacheTime = 0
}
