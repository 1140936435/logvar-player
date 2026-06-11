/// <reference types="electron-vite/renderer" />

interface JellyfinConnectResult {
  success: boolean
  data?: unknown
  error?: string
}

interface ApiResponse {
  success: boolean
  data?: unknown
  error?: string
}

interface DanmakuConfig {
  primary: string
  mirrors: string[]
}

interface DanmakuTestResult {
  success: boolean
  error?: string
  detail?: string
  elapsed: number
  animeCount?: number
  epCount?: number
}

interface VideoInfoResponse {
  success: boolean
  data?: {
    format: string
    duration: number
    size: number
    bitRate: number
    video: {
      codec: string
      width: number
      height: number
      frameRate: string
      bitRate: number
      profile: string
      level: string
    }
    audio: {
      codec: string
      sampleRate: number
      channels: number
      channelLayout: string
      bitRate: number
    }
  }
  error?: string
}

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

interface WindowApi {
  mpv: {
    play: (filePath: string) => Promise<ApiResponse>
    stop: () => Promise<ApiResponse>
    pause: () => Promise<ApiResponse>
    resume: () => Promise<ApiResponse>
    seek: (position: number) => Promise<ApiResponse>
    setVolume: (volume: number) => Promise<ApiResponse>
    setSpeed: (speed: number) => Promise<ApiResponse>
    toggleFullscreen: () => Promise<ApiResponse>
    onEvent: (callback: (event: string, data: any) => void) => void
  }
  history: {
    save: (item: PlayHistoryItem) => Promise<ApiResponse>
    list: () => Promise<ApiResponse>
    delete: (itemId: string) => Promise<ApiResponse>
    clear: () => Promise<ApiResponse>
  }
  jellyfin: {
    connect: (url: string, token: string) => Promise<JellyfinConnectResult>
    getLibraries: () => Promise<ApiResponse>
    getItems: (parentId: string, startIndex?: number, limit?: number) => Promise<ApiResponse>
    getChildren: (parentId: string) => Promise<ApiResponse>
    search: (query: string) => Promise<ApiResponse>
    getItemDetails: (itemId: string) => Promise<ApiResponse>
    getPlaybackUrl: (itemId: string) => Promise<ApiResponse>
    reportProgress: (itemId: string, position: number, isPaused: boolean) => Promise<ApiResponse>
    toggleFavorite: (itemId: string) => Promise<ApiResponse>
  }
  danmaku: {
    match: (title: string) => Promise<ApiResponse>
    search: (keyword: string) => Promise<ApiResponse>
    getComments: (commentId: string, source?: string) => Promise<ApiResponse>
    getSegmentComments: (params: any) => Promise<ApiResponse>
    getConfig: () => Promise<DanmakuConfig>
    setConfig: (config: { primary?: string; mirrors?: string[] }) => Promise<boolean>
    testApi: (url: string) => Promise<DanmakuTestResult>
    parseLocalXml: (xmlPath: string) => Promise<ApiResponse>
    findLocalXml: (videoPath: string) => Promise<ApiResponse>
    prefetchSeries: (animeId: number) => Promise<ApiResponse>
    getCachedComments: (episodeId: string) => Promise<ApiResponse>
  }
  file: {
    openFile: () => Promise<ApiResponse>
    openFolder: () => Promise<ApiResponse>
    scanFolder: (folderPath: string) => Promise<ApiResponse>
  }
  video: {
    getInfo: (filePath: string) => Promise<VideoInfoResponse>
  }
  store: {
    get: (key: string) => Promise<any>
    set: (key: string, value: any) => Promise<boolean>
    delete: (key: string) => Promise<boolean>
  }
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
  log: {
    send: (level: string, source: string, ...args: any[]) => Promise<void>
    toggleWindow: () => Promise<void>
  }
}

declare global {
  interface Window {
    api: WindowApi
    electron: typeof import('@electron-toolkit/preload').electronAPI
  }
}

export {}
