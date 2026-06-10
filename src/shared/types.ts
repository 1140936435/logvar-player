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

export interface DanmakuComment {
  id: string
  content: string
  time: number  // 秒
  type: 'scroll' | 'top' | 'bottom'
  color: number  // 颜色值
  fontSize?: number
  sender?: string
}

export interface DanmakuMatchResult {
  animeId: string
  animeTitle: string
  episodeId: string
  episodeTitle: string
  commentId: string
  type: string
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
