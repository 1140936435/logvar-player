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
  displayArea: number  // 10-100 百分比
  scrollSpeed: 'slow' | 'medium' | 'fast'
  opacity: number  // 20-100 百分比
  enabled: boolean
}

// 弹幕评论（渲染层使用）
export interface DanmakuComment {
  time: number  // 秒
  mode: number  // 1=滚动，4=顶部，5=底部
  color: number  // 十进制颜色值
  text: string  // 弹幕文本
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
