// Preload API 类型定义
import type { DanmakuComment, DanmakuConfig, DanmakuMatchResult, DanmakuSearchResponse, JellyfinItem, JellyfinLibrary, LocalDanmakuCache, MpvTrack, MpvState, PlayerState, RecentlyAddedItem, RecentlyAddedConfig, ServerType, DanmakuMatchMeta, DanmakuMatchResultV2, DanmakuBindEntry } from './types'

// 供 preload/index.ts 通过 import('../shared/preload-types').Xxx 引用的类型在此重新导出
export type { RecentlyAddedItem, RecentlyAddedConfig } from './types'

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
  // 修复 X-S2: 主进程 get-libraries 返回 { Items: [...] }，类型对齐真实响应结构
  data?: { Items: JellyfinLibrary[] }
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

// 多级匹配响应（V2，对标弹弹play/Animeko 多级优先级架构）
export interface DanmakuMatchV2Response {
  success: boolean
  data?: DanmakuMatchResultV2['data']
  candidates?: DanmakuMatchResultV2['candidates']
  error?: string
  log?: string[]
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
  /** Secret 掩码（如 ab****yz），原文不出主进程 */
  appSecretHint?: string
  hasAppSecret?: boolean
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
  /** 海报 URL：由主进程派生（jellyfin-image/emby-image 协议，不含凭据）。
   * 保存时由主进程覆盖，渲染端传入值会被忽略，故保存输入中可省略 */
  posterUrl?: string
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

// ===== 最近入库相关类型 =====
export interface RecentlyAddedListResponse {
  success: boolean
  data?: RecentlyAddedItem[]
  error?: string
}

export interface RecentlyAddedConfigResponse {
  success: boolean
  data?: RecentlyAddedConfig
  error?: string
}

// ===== 服务器管理相关类型 =====
export interface ServerConfig {
  id: string
  name: string
  url: string
  token: string
  /** 服务器类型，旧配置无该字段时默认按 'jellyfin' 处理 */
  type?: ServerType
  /** Emby 专属：登录账号 */
  username?: string
  /** Emby 专属：加密保存的密码（密文，仅在主进程内部可见） */
  password?: string
  /** Emby 专属：登录后获得 userId（Jellyfin 由 /Users 自动推断） */
  userId?: string
}

/**
 * Renderer 可见的服务器公开信息（DTO）。
 * 凭据（token/password）不出主进程，仅用 hasToken/hasPassword 表示是否已配置。
 */
export interface PublicServerConfig {
  id: string
  name: string
  url: string
  /** 服务器类型，旧配置无该字段时默认按 'jellyfin' 处理 */
  type?: ServerType
  /** Emby 专属：登录账号 */
  username?: string
  /** Emby 专属：登录后获得 userId */
  userId?: string
  hasToken: boolean
  hasPassword: boolean
}

/** 更新服务器参数：未提供的字段保持不变（token 留空即不修改凭据） */
export interface ServerUpdateParams {
  id: string
  name?: string
  url?: string
  token?: string
  type?: ServerType
  username?: string
  password?: string
  userId?: string
  /** Emby 编辑：true 时主进程取最近一次 testEmby 登录的 token/userId */
  useTestedEmbyLogin?: boolean
}

export interface ServerListResponse {
  success: boolean
  data?: PublicServerConfig[]
  error?: string
}

export interface ServerActiveResponse {
  success: boolean
  data?: {
    id: string
    server: PublicServerConfig | null
  }
  error?: string
}

// ===== Emby 相关类型 =====
// EmbyLoginResponse/EmbyLoginResult 已移除：AccessToken 只留在主进程，
// Renderer 通过 server.testEmby 拿到非敏感校验结果

/** 新增 Emby 服务器参数（token/userId 由主进程从最近一次 testEmby 登录取用） */
export interface EmbyAddServerParams {
  name: string
  url: string
  username: string
  password: string
}

/** 测试 Emby 连接参数 */
export interface EmbyTestParams {
  url: string
  username: string
  password: string
}

export interface EmbyTestResponse {
  success: boolean
  data?: { ServerName?: string; Version?: string; username?: string }
  error?: string
  elapsed?: number
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

// ===== mpv 画布渲染引擎（方案 C：libmpv SW render API，视频作为 DOM 层） =====
export interface MpvRenderFrame {
  seq: number
  width: number
  height: number
  stride: number
  /** rgb0 像素（R,G,B,X），长度 = stride * height；跨 contextBridge 后为 Uint8Array */
  buffer: Uint8Array
}

export interface MpvRenderOptions {
  hardwareDecode?: boolean
  hdrToneMapping?: boolean
}

/** 与主进程 mpv 控制面对齐的方法名，Player 页可无差别分发 */
export interface MpvRenderApi {
  play: (filePath: string, options?: MpvRenderOptions) => Promise<ApiResponse<void>>
  stop: () => Promise<ApiResponse<void>>
  pause: () => Promise<ApiResponse<void>>
  resume: () => Promise<ApiResponse<void>>
  seek: (position: number) => Promise<ApiResponse<void>>
  setVolume: (volume: number) => Promise<ApiResponse<void>>
  setSpeed: (speed: number) => Promise<ApiResponse<void>>
  disableSubtitle: () => Promise<ApiResponse<void>>
  /** 当前帧导出为 PNG 保存（主进程对话框），返回保存路径 */
  screenshotSave: () => Promise<ApiResponse<string>>
  isAvailable: () => Promise<ApiResponse<boolean>>
  /** 拉取最新帧；无新帧 resolve null */
  getFrame: (lastSeq: number) => Promise<MpvRenderFrame | null>
  /** 设置渲染目标尺寸（画布 backing store 物理像素） */
  setTargetSize: (width: number, height: number) => void
  /** 离开播放页：释放 mpv 实例与渲染循环 */
  destroy: () => Promise<ApiResponse<void>>
  onEvent: (callback: (event: string, data: MpvEvent) => void) => void
  offEvent: () => void
}

// ===== API 类型定义 =====
export interface Api {
  mpvRender: MpvRenderApi
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
    /** 离开播放页：销毁嵌入子窗口并结束 mpv 进程 */
    hide: () => Promise<ApiResponse<void>>
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
    getLatestMedia: (limit?: number) => Promise<ApiResponse<unknown[]>>
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
    prefetchSeries: (animeId: number, currentEpisodeId?: number) => Promise<ApiResponse<void>>
    getConfig: () => Promise<DanmakuConfigResponse>
    setConfig: (config: { primary?: string; mirrors?: string[]; appId?: string; appSecret?: string }) => Promise<ApiResponse<void>>
    testApi: (url: string) => Promise<ApiResponse<{ success: boolean; elapsed: number; animeCount?: number; epCount?: number; detail?: string }>>
    parseLocalXml: (xmlPath: string) => Promise<DanmakuCommentsResponse>
    findLocalXml: (videoPath: string) => Promise<ApiResponse<{ count: number; comments: DanmakuComment[]; source: string }>>
    // ===== V2 多级优先级匹配（结构化元数据，解决切集串弹幕） =====
    // 多级匹配：manual→id→hash→metadata→regex→candidates
    matchEpisode: (meta: DanmakuMatchMeta) => Promise<DanmakuMatchV2Response>
    // 手动绑定弹幕源（持久化，下次直接复用精准ID）
    bindEpisode: (entry: DanmakuBindEntry) => Promise<ApiResponse<void>>
    // 清除手动绑定
    clearBind: (mediaSourceId: string, itemId: string) => Promise<ApiResponse<void>>
    // 获取候选列表（强制重新匹配，不读缓存）
    getCandidates: (meta: DanmakuMatchMeta) => Promise<DanmakuMatchV2Response>
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
    /** 主进程用自持凭据重连活跃服务器（Renderer 不接触 token） */
    ensureConnected: () => Promise<ApiResponse<void>>
    add: (params: { name: string; url: string; token: string }) => Promise<ApiResponse<PublicServerConfig>>
    update: (params: ServerUpdateParams) => Promise<ApiResponse<PublicServerConfig>>
    remove: (id: string) => Promise<ApiResponse<void> & { warning?: string }>
    /** 切换活跃服务器；API Key 多用户时返回 MULTI_USER + users 列表 */
    switch: (id: string) => Promise<ApiResponse<void> & { users?: Array<{ id: string; name?: string }> }>
    test: (url: string, token: string) => Promise<ApiResponse<void>>
    /** 新增 Emby 服务器（token/userId 由主进程从最近一次 testEmby 登录取用） */
    addEmby: (params: EmbyAddServerParams) => Promise<ApiResponse<PublicServerConfig>>
    /** 测试 Emby 连接：账号密码登录 + 校验（token 只留在主进程） */
    testEmby: (params: EmbyTestParams) => Promise<EmbyTestResponse>
    /** 列出 Jellyfin API Key 模式下可选的用户（多用户禁止静默选第一个） */
    listUsers: (id: string) => Promise<ApiResponse<Array<{ id: string; name?: string }>>>
    /** 为 Jellyfin API Key 服务器指定用户 */
    setUser: (id: string, userId: string) => Promise<ApiResponse<PublicServerConfig>>
  }

  recentlyAdded: {
    list: (limit?: number) => Promise<RecentlyAddedListResponse>
    add: (item: RecentlyAddedItem) => Promise<ApiResponse<void>>
    addBatch: (items: RecentlyAddedItem[]) => Promise<ApiResponse<void>>
    clear: () => Promise<ApiResponse<void>>
    getConfig: () => Promise<RecentlyAddedConfigResponse>
    saveConfig: (config: Partial<RecentlyAddedConfig>) => Promise<ApiResponse<void>>
  }

  douban: DoubanApi

  video: VideoApi

  log: LogApi

  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<boolean>
    delete: (key: string) => Promise<boolean>
  }

  data: {
    export: (options?: { format?: 'json' | 'csv'; includeKeys?: string[]; includeSensitive?: boolean }) => Promise<ApiResponse<{ filePath: string; keyCount: number; size: number; excludedSensitive?: string[] }>>
    import: (options?: { merge?: boolean; selectedKeys?: string[] }) => Promise<ApiResponse<{ importedCount: number; skippedCount: number; warnings: string[]; importedKeys: string[]; skippedKeys: string[] }>>
    listKeys: () => Promise<ApiResponse<Array<{ key: string; hasSensitive: boolean }>>>
  }

  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    toggleFullscreen: () => Promise<ApiResponse<boolean>>
    alwaysOnTop: (enabled?: boolean) => Promise<ApiResponse<boolean>>
    /** 原生全屏状态变化（enter/leave-full-screen），返回取消订阅函数 */
    onFullscreenChanged: (callback: (fullscreen: boolean) => void) => () => void
  }
}

// 全局 Window 接口扩展
// 修复 X-S4: 移除 electron 属性，避免与 env.d.ts 中的声明冲突，env.d.ts 为唯一真源
declare global {
  interface Window {
    api: Api
  }
}


