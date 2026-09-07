/**
 * 智能推荐引擎
 * 基于观影历史的本地推荐系统，严格遵循分层推荐排序规则
 */

import type {
  UserPreferenceWeights,
  RecommendationItem,
  DislikedItem,
  RecommendationConfig,
  JellyfinItem
} from '../../../shared/types'
import type { PlayHistoryItem } from '../../../shared/preload-types'

// ===== 默认配置 =====
const DEFAULT_CONFIG: RecommendationConfig = {
  maxItems: 20,
  itemsPerPage: 10,
  cooldownPeriod: 24 * 60 * 60 * 1000, // 24小时冷却期
  minWatchRatio: 0.7,                  // 70% 观看比例视为完整观影
  quickExitThreshold: 30,              // 30秒内退出视为快速退出
  dailyUpdateTime: '03:00'             // 每日凌晨3点更新
}

// ===== 默认偏好权重 =====
const DEFAULT_WEIGHTS: UserPreferenceWeights = {
  genres: {},
  actors: {},
  directors: {},
  studios: {},
  years: {},
  regions: {},
  lastUpdated: 0
}

// ===== 存储键 =====
const STORAGE_KEYS = {
  PREFERENCES: 'recommendation:preferences',
  DISLIKED: 'recommendation:disliked',
  HISTORY_META: 'recommendation:history-meta',
  LAST_UPDATE: 'recommendation:last-update'
}

// ===== 行为权重常量 =====
const BEHAVIOR_WEIGHTS = {
  FULL_WATCH: 1.0,        // 完整观影 +1.0
  REPEAT_WATCH: 0.5,      // 重复回看 +0.5
  PARTIAL_WATCH: 0.3,     // 部分观看 +0.3
  QUICK_EXIT: -0.5,       // 快速退出 -0.5
  MULTI_SKIP: -1.0,       // 多次跳过 -1.0
  COMPLETED: -2.0         // 已看完（不再推荐）
}

// ===== 最大分析历史条目数 =====
const MAX_HISTORY_ANALYSIS = 30

// ===== 缓存 TTL =====
const DETAIL_CACHE_TTL = 30 * 60 * 1000 // 30分钟

/**
 * 分析单个观看历史项，提取偏好特征
 */
export function analyzeHistoryItem(
  historyItem: PlayHistoryItem,
  details?: JellyfinItem
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {
    genres: {},
    actors: {},
    directors: {},
    studios: {},
    years: {}
  }

  // 如果有详细信息，提取特征
  if (details) {
    // 题材
    if (details.Genres) {
      details.Genres.forEach(genre => {
        result.genres[genre] = 1.0
      })
    }

    // 人员（演员/导演）
    if (details.People) {
      details.People.forEach(person => {
        if (person.Type === 'Actor') {
          result.actors[person.Name] = 1.0
        } else if (person.Type === 'Director') {
          result.directors[person.Name] = 1.5 // 导演权重更高
        }
      })
    }

    // 制作公司
    if (details.Studios) {
      details.Studios.forEach(studio => {
        result.studios[studio] = 0.8
      })
    }

    // 年份
    if (details.ProductionYear) {
      const decade = Math.floor(details.ProductionYear / 10) * 10
      result.years[String(decade)] = 0.5
    }
  }

  return result
}

/**
 * 计算观看行为得分
 */
export function calculateBehaviorScore(
  historyItem: PlayHistoryItem,
  behavior: 'full' | 'repeat' | 'partial' | 'quick_exit' | 'skip' | 'completed'
): number {
  const watchRatio = historyItem.duration > 0 ? historyItem.position / historyItem.duration : 0

  switch (behavior) {
    case 'full':
      return watchRatio >= DEFAULT_CONFIG.minWatchRatio ? BEHAVIOR_WEIGHTS.FULL_WATCH : BEHAVIOR_WEIGHTS.PARTIAL_WATCH
    case 'repeat':
      return BEHAVIOR_WEIGHTS.REPEAT_WATCH
    case 'partial':
      return BEHAVIOR_WEIGHTS.PARTIAL_WATCH
    case 'quick_exit':
      return BEHAVIOR_WEIGHTS.QUICK_EXIT
    case 'skip':
      return BEHAVIOR_WEIGHTS.MULTI_SKIP
    case 'completed':
      return BEHAVIOR_WEIGHTS.COMPLETED
    default:
      return 0
  }
}

/**
 * 构建用户偏好权重库
 */
export function buildPreferenceWeights(
  historyItems: PlayHistoryItem[],
  detailsMap: Map<string, JellyfinItem>
): UserPreferenceWeights {
  const weights: UserPreferenceWeights = {
    genres: {},
    actors: {},
    directors: {},
    studios: {},
    years: {},
    regions: {},
    lastUpdated: Date.now()
  }

  // 取最近的 N 个条目进行分析
  const recentItems = historyItems.slice(0, MAX_HISTORY_ANALYSIS)

  // 统计各条目出现次数
  const occurrenceCount: Record<string, Record<string, number>> = {
    genres: {},
    actors: {},
    directors: {},
    studios: {},
    years: {}
  }

  recentItems.forEach((item, index) => {
    const details = detailsMap.get(item.itemId)
    if (!details) return

    // 计算行为权重
    const watchRatio = item.duration > 0 ? item.position / item.duration : 0
    let behaviorWeight = 0

    if (watchRatio >= 0.95) {
      behaviorWeight = BEHAVIOR_WEIGHTS.FULL_WATCH // 完整观看
    } else if (watchRatio >= DEFAULT_CONFIG.minWatchRatio) {
      behaviorWeight = BEHAVIOR_WEIGHTS.PARTIAL_WATCH // 部分观看
    } else if (watchRatio > 0 && watchRatio <= DEFAULT_CONFIG.quickExitThreshold / item.duration) {
      behaviorWeight = BEHAVIOR_WEIGHTS.QUICK_EXIT // 快速退出
    } else {
      behaviorWeight = 0.1 // 轻微观看
    }

    // 时间衰减（最近的权重更高）
    const timeDecay = Math.exp(-index * 0.05)

    // 提取特征并累加权重
    const features = analyzeHistoryItem(item, details)
    
    Object.entries(features).forEach(([category, values]) => {
      const catWeights = weights[category as keyof UserPreferenceWeights] as Record<string, number>
      const catOccurrence = occurrenceCount[category as keyof UserPreferenceWeights] as Record<string, number>
      Object.entries(values).forEach(([key, value]) => {
        const weightedValue = value * behaviorWeight * timeDecay
        catOccurrence[key] = (catOccurrence[key] || 0) + 1

        // 累加到总权重
        if (behaviorWeight > 0) {
          catWeights[key] = (catWeights[key] || 0) + weightedValue
        } else if (behaviorWeight < 0) {
          // 负向行为降低权重
          catWeights[key] = Math.max(0, (catWeights[key] || 0) + weightedValue)
        }
      })
    })
  })

  // 归一化并计算最终权重
  Object.keys(weights).forEach(category => {
    if (category === 'lastUpdated') return
    
    const values = Object.entries(weights[category as keyof UserPreferenceWeights])
    if (values.length === 0) return

    // 找出最大值进行归一化
    const maxValue = Math.max(...values.map(([, v]) => Math.abs(v)))
    
    if (maxValue > 0) {
      const catValues = weights[category as keyof UserPreferenceWeights] as Record<string, number>
      values.forEach(([key, value]) => {
        catValues[key] = value / maxValue
      })
    }
  })

  return weights
}

/**
 * 计算单个项目的推荐得分
 */
export function calculateItemScore(
  item: JellyfinItem,
  weights: UserPreferenceWeights,
  dislikedItems: DislikedItem[],
  alreadyWatchedIds: Set<string>
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // 检查是否已看完（已看完影片默认不再推荐）
  if (alreadyWatchedIds.has(item.Id)) {
    return { score: -Infinity, reasons: ['已观看'] }
  }

  // 检查不感兴趣
  const dislikedSet = new Set(dislikedItems.map(d => `${d.itemType}:${d.value}`))

  // 修复 U-S2: 整个影片被标记为不感兴趣（"不再推荐此影片"）时直接排除
  if (dislikedSet.has('item:' + item.Id)) return { score: -Infinity, reasons: [] }
  
  // 题材匹配
  if (item.Genres) {
    item.Genres.forEach(genre => {
      if (dislikedSet.has(`genre:${genre}`)) {
        score -= 2.0 // 不感兴趣题材大幅降权
        reasons.push(`不感兴趣题材: ${genre}`)
      } else if (weights.genres[genre]) {
        const genreScore = weights.genres[genre] * 1.2
        score += genreScore
        if (genreScore > 0.3) reasons.push(`偏好题材: ${genre}`)
      }
    })
  }

  // 演员匹配
  if (item.People) {
    item.People.forEach(person => {
      if (dislikedSet.has(`${person.Type.toLowerCase()}:${person.Name}`)) {
        score -= 1.5
      } else if (person.Type === 'Actor' && weights.actors[person.Name]) {
        score += weights.actors[person.Name] * 0.8
      } else if (person.Type === 'Director' && weights.directors[person.Name]) {
        score += weights.directors[person.Name] * 1.5
        reasons.push(`偏好导演: ${person.Name}`)
      }
    })
  }

  // 制作公司匹配
  if (item.Studios) {
    item.Studios.forEach(studio => {
      if (dislikedSet.has(`studio:${studio}`)) {
        score -= 1.0
      } else if (weights.studios[studio]) {
        score += weights.studios[studio] * 0.5
      }
    })
  }

  // 年份匹配
  if (item.ProductionYear) {
    const decade = Math.floor(item.ProductionYear / 10) * 10
    if (weights.years[String(decade)]) {
      score += weights.years[String(decade)] * 0.3
    }
  }

  // 基础分（公共平台评分）
  if (item.CommunityRating) {
    score += (item.CommunityRating / 10) * 0.5
  }

  return { score, reasons }
}

/**
 * 分层推荐排序
 * 规则：未看完续播 > 同IP/同主创 > 同题材 > 偏好匹配新入库 > 差异化试探
 */
export function layeredSort(
  candidates: RecommendationItem[],
  weights: UserPreferenceWeights,
  dislikedItems: DislikedItem[],
  continueWatchingIds: Set<string>
): RecommendationItem[] {
  const layers: RecommendationItem[][] = [
    [], // Layer 0: 未看完续播
    [], // Layer 1: 同IP/同主创高度相似
    [], // Layer 2: 同题材延伸
    [], // Layer 3: 偏好匹配新入库
    []  // Layer 4: 差异化试探
  ]

  // 分类到各层
  candidates.forEach(item => {
    if (continueWatchingIds.has(item.itemId)) {
      // Layer 0: 未看完续播 - 最高优先级
      layers[0].push(item)
    } else if (isSameIPOrCreator(item, weights)) {
      // Layer 1: 同IP/同主创
      layers[1].push(item)
    } else if (isSameGenre(item, weights)) {
      // Layer 2: 同题材
      layers[2].push(item)
    } else if (isPreferenceMatched(item, weights)) {
      // Layer 3: 偏好匹配
      layers[3].push(item)
    } else {
      // Layer 4: 差异化试探
      layers[4].push(item)
    }
  })

  // 每层内按得分排序
  layers.forEach(layer => {
    layer.sort((a, b) => b.score - a.score)
  })

  // 合并各层，从高到低
  const result: RecommendationItem[] = []
  let actorCount: Record<string, number> = {} // 同演员推荐限制

  layers.forEach(layer => {
    layer.forEach(item => {
      // 同演员限制：单次推荐不超过3部
      if (item.actors) {
        const hasAvailableActor = item.actors.some(actor => {
          const count = actorCount[actor] || 0
          return count < 3
        })
        
        if (!hasAvailableActor) return // 跳过，所有演员都已达到上限
        
        // 更新计数
        item.actors.forEach(actor => {
          actorCount[actor] = (actorCount[actor] || 0) + 1
        })
      }
      
      result.push(item)
    })
  })

  return result
}

/**
 * 判断是否同IP/同主创
 */
function isSameIPOrCreator(
  item: RecommendationItem,
  weights: UserPreferenceWeights
): boolean {
  // 检查是否有高权重的导演或演员
  if (item.directors?.some(d => weights.directors[d] && weights.directors[d] > 0.5)) {
    return true
  }
  if (item.actors?.some(a => weights.actors[a] && weights.actors[a] > 0.7)) {
    return true
  }
  return false
}

/**
 * 判断是否同题材
 */
function isSameGenre(
  item: RecommendationItem,
  weights: UserPreferenceWeights
): boolean {
  if (item.genres?.some(g => weights.genres[g] && weights.genres[g] > 0.4)) {
    return true
  }
  return false
}

/**
 * 判断是否偏好匹配
 */
function isPreferenceMatched(
  item: RecommendationItem,
  weights: UserPreferenceWeights
): boolean {
  const genreMatch = item.genres?.some(g => weights.genres[g] > 0.2)
  const actorMatch = item.actors?.some(a => weights.actors[a] > 0.3)
  const directorMatch = item.directors?.some(d => weights.directors[d] > 0.3)
  
  return !!(genreMatch || actorMatch || directorMatch)
}

/**
 * 冷启动处理：获取最新入库影片
 */
export function getColdStartRecommendations(
  allItems: JellyfinItem[],
  limit: number = 20
): RecommendationItem[] {
  // 按添加时间排序，取最新入库
  const sorted = [...allItems]
    .filter(item => item.Type === 'Movie' || item.Type === 'Series')
    .sort((a, b) => {
      const yearA = a.ProductionYear || 0
      const yearB = b.ProductionYear || 0
      return yearB - yearA // 年份倒序
    })
    .slice(0, limit)

  return sorted.map((item, index) => ({
    itemId: item.Id,
    name: item.Name,
    type: item.Type as 'Movie' | 'Series',
    score: 1.0 - (index * 0.05), // 逐渐降低的基础分
    reasons: ['新入库影片'],
    posterUrl: item.ImageTags?.PrimaryImageTag,
    productionYear: item.ProductionYear,
    genres: item.Genres,
    actors: item.People?.filter(p => p.Type === 'Actor').map(p => p.Name),
    directors: item.People?.filter(p => p.Type === 'Director').map(p => p.Name),
    seriesName: item.SeriesName
  }))
}

/**
 * 生成每日更新时间戳
 */
export function shouldUpdateToday(lastUpdate: number): boolean {
  if (!lastUpdate) return true
  
  const now = new Date()
  const lastDate = new Date(lastUpdate)
  
  // 如果不是今天，就需要更新
  return lastDate.toDateString() !== now.toDateString()
}

/**
 * 处理不感兴趣
 */
export function addDislikedItem(
  dislikedItems: DislikedItem[],
  item: DislikedItem
): DislikedItem[] {
  // 检查是否已存在
  const existingIndex = dislikedItems.findIndex(
    d => d.itemType === item.itemType && d.value === item.value
  )

  if (existingIndex >= 0) {
    // 修复 U-S3: 返回新数组而非原地修改，避免 React state 不更新
    return dislikedItems.map((d, i) =>
      i === existingIndex ? { ...d, dislikedAt: Date.now() } : d
    )
  }
  // 添加新记录
  return [...dislikedItems, item]
}

/**
 * 获取有效的不感兴趣条目（永久生效）
 */
export function getActiveDislikedItems(dislikedItems: DislikedItem[]): DislikedItem[] {
  // 所有不感兴趣记录永久生效，用于降低推荐权重
  return dislikedItems
}

// 导出配置常量
export { DEFAULT_CONFIG, DEFAULT_WEIGHTS, STORAGE_KEYS, DETAIL_CACHE_TTL }
