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
