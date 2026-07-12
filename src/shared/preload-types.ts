// Preload API 类型定义
import type { DanmakuComment, DanmakuConfig, DanmakuMatchResult, DanmakuSearchResponse, JellyfinItem, JellyfinLibrary, LocalDanmakuCache, MpvTrack, MpvState, PlayerState } from './types'

// ===== 通用响应类型 =====
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ===== Jellyfin 相关类型 =====
export interface JellyfinConnectResponse {
  success: boolean
  connected: boolean
  serverName?: string
  error?: string
}

export interface JellyfinLibrariesResponse {
  success: boolean
  data?: JellyfinLibrary[]
  error?: string
}

export interface JellyfinItemsResponse {
  success: boolean
  data?: {
    Items: JellyfinItem[]
    TotalRecordCount: number
  }
  error?: string
}

export interface JellyfinSearchResponse {
  success: boolean
  data?: {
    Items: JellyfinItem[]
  }
  error?: string
}

// ===== 弹幕相关类型 =====
export interface DanmakuMatchResponse {
  success: boolean
  data?: DanmakuMatchResult
  error?: string
}

export interface DanmakuSearchApiResponse {
  success: boolean
  data?: DanmakuSearchResponse
  error?: string
}

export interface DanmakuCommentsResponse {
  success: boolean
  data?: {
    count: number
    comments: DanmakuComment[]
  }
  error?: string
}

export interface DanmakuConfigResponse {
  primary: string
  mirrors: string[]
  appId?: string
  appSecretHint?: string
}

export interface LocalDanmakuCacheResponse {
  success: boolean
  data?: LocalDanmakuCache
  error?: string
}

export interface LocalDanmakuListResponse {
  success: boolean
  data?: LocalDanmakuCache[]
  error?: string
}

// ===== 播放历史相关类型 =====
export interface PlayHistoryItem {
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

export interface HistoryListResponse {
  success: boolean
  data?: PlayHistoryItem[]
  error?: string
}

// ===== 文件相关类型 =====
export interface OpenFileResponse {
  success: boolean
  data?: {
    filePath: string
  }
  error?: string
}

export interface OpenFolderResponse {
  success: boolean
  data?: {
    files: string[]
    folderPath: string
  }
  error?: string
}

export interface ScanFolderResponse {
  success: boolean
  data?: {
    files: string[]
  }
  error?: string
}

// ===== 服务器管理相关类型 =====
export interface ServerConfig {
  id: string
  name: string
  url: string
  token: string
}

export interface ServerListResponse {
  success: boolean
  data?: ServerConfig[]
  error?: string
}

export interface ServerActiveResponse {
  success: boolean
  data?: {
    id: string
    server: ServerConfig | null
  }
  error?: string
}

// ===== MPV 事件类型 =====
export interface MpvEvent {
  event: string
  data?: unknown
}

// ===== 豆瓣相关类型 =====
export interface DoubanRating {
  rating?: number
  count?: number
}

// ===== 视频信息类型 =====
export interface VideoInfo {
  duration?: number
  width?: number
  height?: number
  codec?: string
}

// ===== 日志类型 =====
export interface LogApi {
  send: (level: string, source: string, ...args: unknown[]) => Promise<void>
  toggleWindow: () => Promise<void>
}

export interface DoubanApi {
  getRating: (title: string) => Promise<ApiResponse<DoubanRating>>
  getRatingsBatch: (titles: string[]) => Promise<ApiResponse<Record<string, DoubanRating>>>
}

export interface VideoApi {
  getInfo: (filePath: string) => Promise<ApiResponse<VideoInfo>>
}

// ===== API 类型定义 =====
export interface Api {
  mpv: {
    play: (filePath: string) => Promise<ApiResponse<void>>
    stop: () => Promise<ApiResponse<void>>
    pause: () => Promise<ApiResponse<void>>
    resume: () => Promise<ApiResponse<void>>
    seek: (position: number) => Promise<ApiResponse<void>>
    setVolume: (volume: number) => Promise<ApiResponse<void>>
    setSpeed: (speed: number) => Promise<ApiResponse<void>>
    toggleFullscreen: () => Promise<ApiResponse<void>>
    getState: () => Promise<ApiResponse<MpvState>>
    getTracks: () => Promise<ApiResponse<MpvTrack[]>>
    selectTrack: (trackId: number) => Promise<ApiResponse<void>>
    selectSubtitle: (trackId: number) => Promise<ApiResponse<void>>
    disableSubtitle: () => Promise<ApiResponse<void>>
    loadExternalSubtitle: (subtitlePath: string) => Promise<ApiResponse<void>>
    getProperty: (name: string) => Promise<ApiResponse<unknown>>
    setProperty: (name: string, value: unknown) => Promise<ApiResponse<void>>
    screenshot: (filePath: string) => Promise<ApiResponse<void>>
    screenshotSave: () => Promise<ApiResponse<string>>

    isAvailable: () => Promise<ApiResponse<boolean>>
    embed: (x: number, y: number, width: number, height: number) => Promise<ApiResponse<void>>
    updateEmbed: (x: number, y: number, width: number, height: number) => Promise<ApiResponse<void>>
    onEvent: (callback: (event: string, data: MpvEvent) => void) => void
    offEvent: () => void
  }

  history: {
    save: (item: PlayHistoryItem) => Promise<ApiResponse<void>>
    list: () => Promise<HistoryListResponse>
    delete: (itemId: string) => Promise<ApiResponse<void>>
    clear: () => Promise<ApiResponse<void>>
  }

  jellyfin: {
    connect: (url: string, token: string) => Promise<JellyfinConnectResponse>
    getLibraries: () => Promise<JellyfinLibrariesResponse>
    getItems: (parentId: string, startIndex?: number, limit?: number) => Promise<JellyfinItemsResponse>
    getChildren: (parentId: string) => Promise<JellyfinItemsResponse>
    search: (query: string, options?: { limit?: number }) => Promise<JellyfinSearchResponse>
    getItemDetails: (itemId: string) => Promise<ApiResponse<JellyfinItem>>
    getPlaybackUrl: (itemId: string) => Promise<ApiResponse<{ url: string; subtitles: { index: number; label: string; language: string; codec: string; url: string }[] }>>
    fetchSubtitle: (url: string) => Promise<ApiResponse<string>>
    reportProgress: (itemId: string, position: number, isPaused: boolean) => Promise<ApiResponse<void>>
    toggleFavorite: (itemId: string) => Promise<ApiResponse<void>>
    getEpisodes: (seriesId: string, seasonId?: string) => Promise<JellyfinItemsResponse>
    getGenres: () => Promise<ApiResponse<Array<{ Id: string; Name: string }>>>
    getGenreItems: (genre: string, startIndex?: number) => Promise<JellyfinItemsResponse>
    scrape: {
      search: (params: { query: string; year?: number; type?: string }) => Promise<ApiResponse<Array<{ id: string; title: string; year: string; poster: string; overview: string }>>>
      fetch: (params: { doubanId: string; posterUrl: string }) => Promise<ApiResponse<{ localPath: string }>>
    }
  }

  danmaku: {
    match: (title: string) => Promise<DanmakuMatchResponse>
    search: (keyword: string) => Promise<DanmakuSearchApiResponse>
    getComments: (commentId: string, source?: string) => Promise<DanmakuCommentsResponse>
    getSegmentComments: (params: unknown) => Promise<DanmakuCommentsResponse>
    prefetchSeries: (animeId: number) => Promise<ApiResponse<void>>
    getConfig: () => Promise<DanmakuConfigResponse>
    setConfig: (config: { primary?: string; mirrors?: string[]; appId?: string; appSecret?: string }) => Promise<ApiResponse<void>>
    testApi: (url: string) => Promise<ApiResponse<{ success: boolean; elapsed: number; animeCount?: number; epCount?: number; detail?: string }>>
    parseLocalXml: (xmlPath: string) => Promise<DanmakuCommentsResponse>
    findLocalXml: (videoPath: string) => Promise<ApiResponse<{ count: number; comments: DanmakuComment[]; source: string }>>
    // 预下载弹幕到本地缓存
    downloadDanmaku: (title: string) => Promise<LocalDanmakuCacheResponse>
    // 获取已缓存的本地弹幕列表
    getLocalDanmakuList: () => Promise<LocalDanmakuListResponse>
    // 删除本地弹幕缓存
    deleteLocalDanmaku: (episodeId: number) => Promise<ApiResponse<void>>
  }

  file: {
    openFile: () => Promise<OpenFileResponse>
    openFolder: () => Promise<OpenFolderResponse>
    scanFolder: (folderPath: string) => Promise<ScanFolderResponse>
    getLocalFileUrl: (filePath: string) => Promise<ApiResponse<{ url: string }>>
  }

  server: {
    list: () => Promise<ServerListResponse>
    getActive: () => Promise<ServerActiveResponse>
    add: (params: { name: string; url: string; token: string }) => Promise<ApiResponse<void>>
    update: (params: { id: string; name?: string; url?: string; token?: string }) => Promise<ApiResponse<void>>
    remove: (id: string) => Promise<ApiResponse<void>>
    switch: (id: string) => Promise<ApiResponse<void>>
    test: (url: string, token: string) => Promise<ApiResponse<void>>
  }

  douban: DoubanApi

  video: VideoApi

  log: LogApi

  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<boolean>
    delete: (key: string) => Promise<boolean>
  }

  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    alwaysOnTop: (enabled?: boolean) => Promise<ApiResponse<boolean>>
  }
}

// 全局 Window 接口扩展
declare global {
  interface Window {
    api: Api
    electron: {
      platform: string
    }
  }
}


