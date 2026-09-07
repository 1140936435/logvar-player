/**
 * useRecommendation Hook
 * 智能推荐核心逻辑 Hook
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  UserPreferenceWeights,
  RecommendationItem,
  DislikedItem,
  JellyfinItem
} from '../../../shared/types'
import type { PlayHistoryItem } from '../../../shared/preload-types'
import { cachedFetch, clearCache } from '../utils/apiCache'
import {
  buildPreferenceWeights,
  calculateItemScore,
  layeredSort,
  getColdStartRecommendations,
  shouldUpdateToday,
  addDislikedItem,
  getActiveDislikedItems,
  DEFAULT_CONFIG,
  DEFAULT_WEIGHTS,
  STORAGE_KEYS,
  DETAIL_CACHE_TTL
} from '../utils/recommendation'

// 推荐状态类型
export interface RecommendationState {
  recommendations: RecommendationItem[]
  displayedCount: number
  isLoading: boolean
  isColdStart: boolean
  hasMore: boolean
  lastUpdated: number
}

// 推荐控制方法
export interface RecommendationControls {
  loadMore: () => void
  refresh: () => Promise<void>
  addDislike: (itemId: string, itemType: 'genre' | 'actor' | 'director' | 'studio' | 'item', value: string) => void
  getMoreLikeThis: (itemId: string) => void
}

export function useRecommendation(
  historyItems: PlayHistoryItem[],
  getDetail: (itemId: string) => Promise<JellyfinItem | null>,
  getAllLibraryItems: () => Promise<JellyfinItem[]>
): RecommendationState & RecommendationControls {
  const [weights, setWeights] = useState<UserPreferenceWeights>(DEFAULT_WEIGHTS)
  const [dislikedItems, setDislikedItems] = useState<DislikedItem[]>([])
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>([])
  const [displayedCount, setDisplayedCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [isColdStart, setIsColdStart] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(0)
  
  const detailsCacheRef = useRef<Map<string, JellyfinItem>>(new Map())
  const generatedRef = useRef(false)
  // dislikedItems 的镜像 ref：addDislike 里先 setDislikedItems 再同步调
  // generateRecommendations，后者闭包捕获的是点击前的旧列表 —— 若直接用 state，
  // 重新生成会用旧列表过滤（刚标记的不感兴趣不生效），且第 213 行持久化会用旧列表
  // 覆盖存储（重启后"不感兴趣"全部丢失）。所有写入点同步更新 ref，读取点统一走 ref
  const dislikedItemsRef = useRef<DislikedItem[]>([])

  // 从本地存储加载偏好
  const loadFromStorage = useCallback(async () => {
    try {
      const storedWeights = await window.api.store.get(STORAGE_KEYS.PREFERENCES) as UserPreferenceWeights | null
      if (storedWeights) {
        setWeights({ ...DEFAULT_WEIGHTS, ...storedWeights })
      }

      const storedDisliked = await window.api.store.get(STORAGE_KEYS.DISLIKED) as DislikedItem[] | null
      if (storedDisliked && Array.isArray(storedDisliked)) {
        dislikedItemsRef.current = storedDisliked
        setDislikedItems(storedDisliked)
      }

      const storedLastUpdate = await window.api.store.get(STORAGE_KEYS.LAST_UPDATE) as number | null
      if (storedLastUpdate) {
        setLastUpdated(storedLastUpdate)
      }
    } catch (err) {
      console.warn('[Recommendation] 读取本地存储失败:', err)
    }
  }, [])

  // 保存偏好到本地存储
  const saveToStorage = useCallback((newWeights: UserPreferenceWeights, newDisliked: DislikedItem[]) => {
    try {
      window.api.store.set(STORAGE_KEYS.PREFERENCES, newWeights)
      window.api.store.set(STORAGE_KEYS.DISLIKED, newDisliked)
      window.api.store.set(STORAGE_KEYS.LAST_UPDATE, Date.now())
      setLastUpdated(Date.now())
    } catch (err) {
      console.warn('[Recommendation] 保存本地存储失败:', err)
    }
  }, [])

  // 获取详情（带缓存）
  const fetchItemDetail = useCallback(async (itemId: string): Promise<JellyfinItem | null> => {
    // 优先读取内存缓存
    if (detailsCacheRef.current.has(itemId)) {
      return detailsCacheRef.current.get(itemId) || null
    }
    
    // 使用 cachedFetch 缓存 API 请求
    return cachedFetch(
      `recommendation:getDetail:${itemId}`,
      [itemId],
      () => getDetail(itemId),
      DETAIL_CACHE_TTL
    ).then(detail => {
      if (detail) {
        detailsCacheRef.current.set(itemId, detail)
      }
      return detail
    })
  }, [getDetail])

  // 生成推荐列表
  const generateRecommendations = useCallback(async () => {
    if (isLoading) return
    setIsLoading(true)

    try {
      // 冷启动检测
      const isCold = historyItems.length < 3
      setIsColdStart(isCold)

      if (isCold) {
        // 冷启动：展示最新入库影片
        const allItems = await getAllLibraryItems()
        const coldStartRecs = getColdStartRecommendations(allItems, DEFAULT_CONFIG.maxItems)
        setRecommendations(coldStartRecs)
        setDisplayedCount(Math.min(DEFAULT_CONFIG.itemsPerPage, coldStartRecs.length))
        generatedRef.current = true
        return
      }

      // 1. 获取历史项目的详情
      const detailPromises = historyItems
        .slice(0, 30)
        .map(item => fetchItemDetail(item.itemId))
      
      const detailsResults = await Promise.all(detailPromises)
      const detailsMap = new Map<string, JellyfinItem>()
      
      detailsResults.forEach((detail, index) => {
        if (detail && historyItems[index]) {
          detailsMap.set(historyItems[index].itemId, detail)
        }
      })

      // 2. 构建偏好权重库
      const newWeights = buildPreferenceWeights(historyItems, detailsMap)
      setWeights(newWeights)

      // 3. 获取全部库项目
      const allItems = await getAllLibraryItems()
      const activeDisliked = getActiveDislikedItems(dislikedItemsRef.current)
      
      // 已观看ID集合
      const watchedIds = new Set(historyItems.map(h => h.itemId))
      
      // 续播ID集合（进度在10%-90%之间）
      const continueWatchingIds = new Set(
        historyItems
          .filter(h => {
            const ratio = h.duration > 0 ? h.position / h.duration : 0
            return ratio >= 0.1 && ratio < 0.95
          })
          .map(h => h.itemId)
      )

      // 4. 为所有候选项计算得分
      const candidates: RecommendationItem[] = allItems
        .filter(item => {
          // 过滤：只推荐电影和剧集
          return item.Type === 'Movie' || item.Type === 'Series'
        })
        .map(item => {
          const { score, reasons } = calculateItemScore(
            item,
            newWeights,
            activeDisliked,
            watchedIds
          )

          return {
            itemId: item.Id,
            name: item.Name,
            type: item.Type as 'Movie' | 'Series',
            score,
            reasons,
            posterUrl: item.ImageTags?.PrimaryImageTag,
            productionYear: item.ProductionYear,
            genres: item.Genres,
            actors: item.People?.filter(p => p.Type === 'Actor').map(p => p.Name),
            directors: item.People?.filter(p => p.Type === 'Director').map(p => p.Name),
            seriesName: item.SeriesName
          }
        })
        .filter(item => item.score > -Infinity) // 过滤掉已看完的

      // 5. 分层排序
      const sorted = layeredSort(candidates, newWeights, activeDisliked, continueWatchingIds)
      
      // 限制总数量
      const limited = sorted.slice(0, DEFAULT_CONFIG.maxItems)
      
      setRecommendations(limited)
      setDisplayedCount(Math.min(DEFAULT_CONFIG.itemsPerPage, limited.length))
      
      // 6. 保存新权重（disliked 读 ref 最新值，避免旧闭包覆盖掉 addDislike 刚写入的列表）
      saveToStorage(newWeights, dislikedItemsRef.current)
      
      generatedRef.current = true
    } catch (err) {
      console.error('[Recommendation] 生成推荐失败:', err)
    } finally {
      setIsLoading(false)
    }
  }, [historyItems, dislikedItems, isLoading, fetchItemDetail, getAllLibraryItems, saveToStorage])

  // 加载更多（分页懒加载）
  const loadMore = useCallback(() => {
    if (displayedCount >= recommendations.length) return
    setDisplayedCount(prev => 
      Math.min(prev + DEFAULT_CONFIG.itemsPerPage, recommendations.length)
    )
  }, [displayedCount, recommendations.length])

  // 刷新推荐
  const refresh = useCallback(async () => {
    generatedRef.current = false
    clearCache('recommendation:')
    detailsCacheRef.current.clear()
    await generateRecommendations()
  }, [generateRecommendations])

  // 添加不感兴趣
  const addDislike = useCallback((itemId: string, itemType: 'genre' | 'actor' | 'director' | 'studio' | 'item', value: string) => {
    const newDisliked = addDislikedItem(dislikedItemsRef.current, {
      itemId,
      itemType,
      value,
      dislikedAt: Date.now()
    })
    dislikedItemsRef.current = newDisliked
    setDislikedItems(newDisliked)
    saveToStorage(weights, newDisliked)

    // 重新生成推荐
    generatedRef.current = false
    generateRecommendations()
  }, [weights, saveToStorage, generateRecommendations])

  // 相似推荐（占位实现）
  const getMoreLikeThis = useCallback((itemId: string) => {
    // 预留接口：可用于实现"相似影片"功能
    console.log('[Recommendation] getMoreLikeThis:', itemId)
  }, [])

  // 初始化：加载本地存储
  useEffect(() => {
    loadFromStorage()
  }, [loadFromStorage])

  // 生成推荐（当历史变化或需要每日更新时）
  useEffect(() => {
    if (historyItems.length === 0) {
      // 无历史数据，冷启动
      setIsColdStart(true)
      setRecommendations([])
      setDisplayedCount(0)
      return
    }

    // 检查是否需要更新（每日更新或首次生成）
    if (!generatedRef.current || shouldUpdateToday(lastUpdated)) {
      generateRecommendations()
    }
  }, [historyItems, generateRecommendations, lastUpdated])

  return {
    // 状态
    recommendations: recommendations.slice(0, displayedCount),
    displayedCount,
    isLoading,
    isColdStart,
    hasMore: displayedCount < recommendations.length,
    lastUpdated,
    
    // 控制方法
    loadMore,
    refresh,
    addDislike,
    getMoreLikeThis
  }
}
