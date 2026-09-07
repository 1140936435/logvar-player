// ===== 服务器类型 =====
// Jellyfin 与 Emby 共享同一套 API 结构（Emby 是 Jellyfin 的前身），
// 因此下方 Jellyfin* 类型在两种服务器上通用。

export type ServerType = 'jellyfin' | 'emby'

// ===== Jellyfin 类型 =====

export interface JellyfinConfig {
  url: string
  token: string
}

export interface JellyfinLibrary {
  Id: string
  Name: string
  CollectionType: string  // 'movies' | 'tvshows' | 'music'
  ImageTags: Record<string, string>
}

export interface JellyfinServerInfo {
  ServerName?: string
  Version?: string
  Id?: string
}

export interface JellyfinItem {
  Id: string
  Name: string
  Type: string  // 'Movie' | 'Series' | 'Episode'
  Overview?: string
  PremiereDate?: string
  CommunityRating?: number
  OfficialRating?: string
  ImageTags: Record<string, string>
  // 剧集特有
  SeriesName?: string
  SeasonName?: string
  IndexNumber?: number  // 集号
  ParentIndexNumber?: number  // 季号
  // 详情页扩展字段（通过 getItemDetails 获取）
  Genres?: string[]
  People?: Array<{ Name: string; Type: string; Role?: string }>
  Studios?: string[]
  ProductionYear?: number
  SeriesId?: string
  SeasonId?: string
  MediaSourceCount?: number
  Width?: number
  Height?: number
}

// ===== 推荐系统类型 =====

// 用户偏好权重
export interface UserPreferenceWeights {
  genres: Record<string, number>      // 题材偏好权重
  actors: Record<string, number>      // 演员偏好权重
  directors: Record<string, number>  // 导演偏好权重
  studios: Record<string, number>     // 制作公司偏好权重
  years: Record<string, number>       // 年份偏好权重
  regions: Record<string, number>     // 地区偏好权重
  lastUpdated: number                 // 最后更新时间戳
}

// 推荐项
export interface RecommendationItem {
  itemId: string
  name: string
  type: 'Movie' | 'Series' | 'Episode'
  score: number
  reasons: string[]
  posterUrl?: string
  productionYear?: number
  genres?: string[]
  actors?: string[]
  directors?: string[]
  seriesName?: string
  addedAt?: number
}

// 不感兴趣记录
export interface DislikedItem {
  itemId: string
  itemType: 'genre' | 'actor' | 'director' | 'studio' | 'item'
  value: string
  dislikedAt: number
  reason?: string
}

// 推荐配置
export interface RecommendationConfig {
  maxItems: number              // 最大推荐数量
  itemsPerPage: number          // 每页加载数量
  cooldownPeriod: number        // 冷却期（毫秒）- 跳过影片短期屏蔽
  minWatchRatio: number         // 完整观影最小比例
  quickExitThreshold: number    // 快速退出阈值（秒）
  dailyUpdateTime: string        // 每日更新时间（HH:mm）
}

// ===== 弹幕 类型 =====

export interface DanmakuConfig {
  apiUrl: string
  fontSize: number
  area: 'full' | 'top' | 'bottom'
  speed: number  // px/s, 60-300
  opacity: number  // 0-1
  enabled: boolean
}

// 弹幕评论（渲染层使用，API 原始结构：mode 为数字）
export interface DanmakuComment {
  time: number  // 秒
  mode: number  // 1=滚动，4=底部，5=顶部（DPlayer/B站规范）
  color: number  // 十进制颜色值
  text: string  // 弹幕文本
  // 修复点 1.6: 允许 DanmakuEngine 运行时挂载测量值（不保证 API 返回一定有，故可选）
  width?: number
  height?: number
}

// 弹幕引擎内部使用的规范化结构 —— 修复点 2.4: 避免对外部传入的 DanmakuComment 做原地破坏性修改
// mode 使用字符串枚举，width/height 一定存在
export type DanmakuMode = 'ltr' | 'rtl' | 'top' | 'bottom'

export interface EngineDanmakuComment {
  time: number
  mode: DanmakuMode
  color: number
  text: string
  width: number
  height: number
}

// 弹幕 API 响应（主进程使用）
export interface DanmakuCommentRaw {
  cid: number  // 评论 ID
  p: string  // "time,mode,color,timestamp"
  m: string  // 弹幕文本
}

// 弹幕搜索结果
export interface DanmakuSearchResult {
  animeId: number
  animeTitle: string
  episodeId: number
  episodeTitle: string
  type: string
  typeDescription: string
  // 修复点 1.19: Player.handleDanmakuSelect 里需要 ep.source 传给 getComments 第二参数
  source?: string
}

// 弹幕搜索响应
export interface DanmakuSearchResponse {
  hasMore: boolean
  animes: Array<{ animeId: number; animeTitle: string; episodes: DanmakuSearchResult[] }>
}

// 弹幕匹配结果
export interface DanmakuMatchResult {
  animeId: string
  animeTitle: string
  episodeId: string
  episodeTitle: string
  commentId: string
  type: string
}

// 弹幕缓存响应
export interface DanmakuCommentsResponse {
  count: number
  comments: DanmakuComment[]
}

// 本地弹幕缓存记录（Detail 页预下载后存储）
export interface LocalDanmakuCache {
  episodeId: number
  source: string       // 'dandanplay' | 'bilibili'
  animeTitle: string
  episodeTitle: string
  cachedAt: number     // timestamp
  count: number
}

// ===== 弹幕 剧集匹配（多级优先级架构，对标弹弹play/Animeko） =====
//
// 匹配优先级（命中即停止降级）：
//   ① manual  手动绑定缓存（用户曾手动指定的精准绑定，最高优先级）
//   ② id      媒体源外部ID精准匹配（providerIds: imdb/tvdb 等）
//   ③ hash    视频文件特征值匹配（弹弹play /api/v2/match）
//   ④ metadata 结构化元数据严格配对（seriesName+year+season+episode）
//   ⑤ regex   文件名正则解析（独立 season/episode 字段）后走元数据匹配
//   ⑥ candidates 以上全部失败 → 返回候选列表，UI 手动选择

// 匹配层级标识
export type DanmakuMatchLevel = 'manual' | 'id' | 'hash' | 'metadata' | 'regex' | 'candidates' | 'none'

// 弹幕匹配请求的结构化元数据（渲染进程 → 主进程）
// 切集时必须携带完整的 season/episode，禁止只传剧名
export interface DanmakuMatchMeta {
  mediaSourceId: string               // 媒体服务器ID（区分 Jellyfin/Emby 多源）
  itemId: string                      // 当前集媒体ID（每集唯一）
  seriesId?: string                   // 番剧ID
  seasonId?: string                   // 季ID
  seriesName?: string                 // 番剧名
  seasonName?: string                 // 季名（如 "第 1 季"）
  indexNumber?: number                // 集号（Jellyfin IndexNumber，必须独立数值）
  parentIndexNumber?: number          // 季号（Jellyfin ParentIndexNumber，必须独立数值）
  productionYear?: number             // 年份（辅助消歧）
  fileName?: string                   // 视频文件名（用于 hash/正则兜底）
  filePath?: string                   // 本地视频完整路径（用于 hash 精准匹配，仅本地文件有值）
  providerIds?: Record<string, string> // 外部ID（imdb/tvdb 等，用于 ID 精准匹配）
  title?: string                      // 原始标题（regex 层兜底用）
}

// 匹配候选项（带打分，用于多级降级 & UI 手动选择）
export interface DanmakuMatchCandidate {
  episodeId: number
  animeId: number
  animeTitle: string
  episodeTitle: string
  source: string                      // 'dandanplay' | 'bilibili'
  score: number                       // 0-1，相似度打分
  seasonHint?: number                 // 从 animeTitle 推断的季号
}

// 多级匹配结果（主进程 → 渲染进程）
export interface DanmakuMatchResultV2 {
  success: boolean
  data?: {
    episodeId: number
    animeId?: number
    animeTitle?: string
    episodeTitle?: string
    source: string
    matchLevel: DanmakuMatchLevel
    confidence: number                // 0-1，<0.6 时建议手动确认
  }
  candidates?: DanmakuMatchCandidate[] // 低置信度/失败时返回候选列表
  error?: string
  log?: string[]                      // 匹配过程日志（命中节点/打分）
}

// 手动绑定持久化记录（缓存Key = mediaSourceId:itemId）
export interface DanmakuBindEntry {
  mediaSourceId: string
  itemId: string
  episodeId: number
  animeId?: number
  animeTitle?: string
  episodeTitle?: string
  source: string
  boundAt: number
}

// ===== 播放器 类型 =====

export interface PlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  speed: number
  isFullscreen: boolean
  filePath: string
  mediaTitle: string
}

// ===== MPV 轨道类型 =====

export interface MpvTrack {
  id: number
  type: 'audio' | 'video' | 'sub'
  selected: boolean
  title?: string
  lang?: string
  codec?: string
  'demux-w': number
  'demux-h': number
}

export interface MpvState {
  paused: boolean
  timePos: number
  duration: number
  volume: number
  speed: number
  fullscreen: boolean
  trackList: MpvTrack[]
  filename: string
}

// ===== 最近入库 类型 =====

export interface RecentlyAddedItem {
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

export interface RecentlyAddedConfig {
  enabled: boolean
  displayCount: number
  scrollSpeed: number
  scrollPosition: number
}

// ===== 配置 类型 =====

export interface AppConfig {
  jellyfin: JellyfinConfig
  danmaku: DanmakuConfig
  player: {
    hardwareDecode: boolean
    hdrToneMapping: boolean
    defaultSpeed: number
  }
  theme: 'dark' | 'light' | 'system'
}
