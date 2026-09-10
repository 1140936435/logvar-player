import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/preload-types'
import { electronAPI } from '@electron-toolkit/preload'
import * as mpvRender from './mpv-render'

// 自定义 API
const api: Api = {
  // mpv 画布渲染引擎（方案 C：libmpv SW render API，帧经 WebGL canvas 上屏，
  // 与主进程打孔链路完全隔离；方法名与 api.mpv 对齐，Player 页按引擎分发）
  mpvRender: {
    play: (filePath: string, options?: import('../shared/preload-types').MpvRenderOptions) =>
      mpvRender.play(filePath, options),
    stop: () => mpvRender.stop(),
    pause: () => mpvRender.pause(),
    resume: () => mpvRender.resume(),
    seek: (position: number) => mpvRender.seek(position),
    setVolume: (volume: number) => mpvRender.setVolume(volume),
    setSpeed: (speed: number) => mpvRender.setSpeed(speed),
    disableSubtitle: () => mpvRender.disableSubtitle(),
    // 截图：取当前帧（rgb0 → 转 BGRA）交主进程 nativeImage 存 PNG
    screenshotSave: async () => {
      const frame = mpvRender.getFrame(-1)
      if (!frame) return { success: false, error: '暂无可截图的画面帧' }
      const { width, height, stride, buffer } = frame
      const px = Buffer.from(buffer.buffer, buffer.byteOffset, stride * height)
      // rgb0 → BGRA：逐像素交换 R/B，并置 alpha=255
      for (let i = 0; i + 2 < px.length; i += 4) {
        const r = px[i]
        px[i] = px[i + 2]
        px[i + 2] = r
        px[i + 3] = 255
      }
      return ipcRenderer.invoke('mpv:save-frame-png', {
        width, height,
        pixels: px
      })
    },
    isAvailable: async () => ({ success: true, data: mpvRender.isAvailable() }),
    getFrame: async (lastSeq: number) => mpvRender.getFrame(lastSeq),
    setTargetSize: (width: number, height: number) => mpvRender.setTargetSize(width, height),
    destroy: async () => { mpvRender.destroy(); return { success: true, data: undefined } },
    onEvent: (callback) => mpvRender.onEvent(callback as (event: string, data: unknown) => void),
    offEvent: () => mpvRender.offEvent()
  },

  // mpv 播放控制
  mpv: {
    play: (filePath: string) => ipcRenderer.invoke('mpv:play', filePath),
    stop: () => ipcRenderer.invoke('mpv:stop'),
    pause: () => ipcRenderer.invoke('mpv:pause'),
    resume: () => ipcRenderer.invoke('mpv:resume'),
    seek: (position: number) => ipcRenderer.invoke('mpv:seek', position),
    setVolume: (volume: number) => ipcRenderer.invoke('mpv:set-volume', volume),
    setSpeed: (speed: number) => ipcRenderer.invoke('mpv:set-speed', speed),
    toggleFullscreen: () => ipcRenderer.invoke('mpv:toggle-fullscreen'),
    getState: () => ipcRenderer.invoke('mpv:get-state'),
    getTracks: () => ipcRenderer.invoke('mpv:get-tracks'),
    selectTrack: (trackId: number) => ipcRenderer.invoke('mpv:select-track', trackId),
    selectSubtitle: (trackId: number) => ipcRenderer.invoke('mpv:select-subtitle', trackId),
    disableSubtitle: () => ipcRenderer.invoke('mpv:disable-subtitle'),
    loadExternalSubtitle: (subtitlePath: string) => ipcRenderer.invoke('mpv:load-subtitle', subtitlePath),
    getProperty: (name: string) => ipcRenderer.invoke('mpv:get-property', name),
    setProperty: (name: string, value: unknown) => ipcRenderer.invoke('mpv:set-property', name, value),
    screenshot: (filePath: string) => ipcRenderer.invoke('mpv:screenshot', filePath),
    screenshotSave: () => ipcRenderer.invoke('mpv:screenshot-save'),

    isAvailable: () => ipcRenderer.invoke('mpv:is-available'),
    embed: (x: number, y: number, width: number, height: number) => ipcRenderer.invoke('mpv:embed', x, y, width, height),
    updateEmbed: (x: number, y: number, width: number, height: number) => ipcRenderer.invoke('mpv:update-embed', x, y, width, height),
    hide: () => ipcRenderer.invoke('mpv:hide'),
    onEvent: ((callback: (event: string, data: unknown) => void) => {
      const listener = (_event: unknown, msg: { event: string; data: unknown }): void =>
        callback(msg.event, msg.data)
      ipcRenderer.on('mpv:event', listener)
      // 返回独立 unsubscribe：仅移除本次注册的监听，不影响其他订阅者
      return () => { ipcRenderer.removeListener('mpv:event', listener) }
    }) as Api['mpv']['onEvent'],
    offEvent: (): void => {
      // 兼容旧调用：清空该通道全部监听
      ipcRenderer.removeAllListeners('mpv:event')
    }
  },

  // 播放历史
  history: {
    save: (item: unknown) => ipcRenderer.invoke('history:save', item as import('../shared/preload-types').PlayHistoryItem),
    list: () => ipcRenderer.invoke('history:list'),
    delete: (itemId: string) => ipcRenderer.invoke('history:delete', itemId),
    clear: () => ipcRenderer.invoke('history:clear')
  },

  // Jellyfin API
  jellyfin: {
    connect: (url: string, token: string) => ipcRenderer.invoke('jellyfin:connect', url, token),
    getLibraries: () => ipcRenderer.invoke('jellyfin:get-libraries'),
    getItems: (parentId: string, startIndex?: number, limit?: number) =>
      ipcRenderer.invoke('jellyfin:get-items', parentId, startIndex, limit),
    getChildren: (parentId: string) =>
      ipcRenderer.invoke('jellyfin:get-children', parentId),
    search: (query: string) => ipcRenderer.invoke('jellyfin:search', query),
    getItemDetails: (itemId: string) => ipcRenderer.invoke('jellyfin:get-item-details', itemId),
    getPlaybackUrl: (itemId: string) => ipcRenderer.invoke('jellyfin:get-playback-url', itemId),
    fetchSubtitle: (url: string) => ipcRenderer.invoke('jellyfin:fetch-subtitle', url),
    reportProgress: (itemId: string, position: number, isPaused: boolean) =>
      ipcRenderer.invoke('jellyfin:report-progress', itemId, position, isPaused),
    toggleFavorite: (itemId: string) => ipcRenderer.invoke('jellyfin:toggle-favorite', itemId),
    getEpisodes: (seriesId: string, seasonId?: string) =>
      ipcRenderer.invoke('jellyfin:get-episodes', seriesId, seasonId),
    getGenres: () => ipcRenderer.invoke('jellyfin:get-genres'),
    getGenreItems: (genre: string, startIndex?: number) =>
      ipcRenderer.invoke('jellyfin:get-genre-items', genre, startIndex),
    getLatestMedia: (limit?: number) =>
      ipcRenderer.invoke('jellyfin:get-latest-media', limit),
    scrape: {
      search: (params: { query: string; year?: number; type?: string }) =>
        ipcRenderer.invoke('media:search-douban', params),
      fetch: (params: { doubanId: string; posterUrl: string }) =>
        ipcRenderer.invoke('media:fetch-douban-poster', params)
    }
  },

  // 豆瓣评分
  douban: {
    getRating: (title: string) => ipcRenderer.invoke('douban:get-rating', title),
    getRatingsBatch: (titles: string[]) => ipcRenderer.invoke('douban:get-ratings-batch', titles)
  },

  // 弹幕 API
  danmaku: {
    match: (title: string) => ipcRenderer.invoke('danmaku:match', title),
    search: (keyword: string) => ipcRenderer.invoke('danmaku:search', keyword),
    getComments: (commentId: string, source?: string) =>
      ipcRenderer.invoke('danmaku:get-comments', commentId, source),
    getSegmentComments: (params: unknown) => ipcRenderer.invoke('danmaku:get-segment-comments', params),
    prefetchSeries: (animeId: number, currentEpisodeId?: number) => ipcRenderer.invoke('danmaku:prefetch-series', animeId, currentEpisodeId),
    getConfig: () => ipcRenderer.invoke('danmaku:get-config'),
    setConfig: (config: { primary?: string; mirrors?: string[]; appId?: string; appSecret?: string }) =>
      ipcRenderer.invoke('danmaku:set-config', config),
    testApi: (url: string) => ipcRenderer.invoke('danmaku:test-api', url),
    parseLocalXml: (xmlPath: string) => ipcRenderer.invoke('danmaku:parse-local-xml', xmlPath),
    findLocalXml: (videoPath: string) => ipcRenderer.invoke('danmaku:find-local-xml', videoPath),
    // ===== V2 多级优先级匹配（结构化元数据，解决切集串弹幕） =====
    matchEpisode: (meta) => ipcRenderer.invoke('danmaku:match-episode', meta),
    bindEpisode: (entry) => ipcRenderer.invoke('danmaku:bind-episode', entry),
    clearBind: (mediaSourceId, itemId) => ipcRenderer.invoke('danmaku:clear-bind', mediaSourceId, itemId),
    getCandidates: (meta) => ipcRenderer.invoke('danmaku:get-candidates', meta)
  },

  // 本地文件
  file: {
    openFile: () => ipcRenderer.invoke('file:open-file'),
    openFolder: () => ipcRenderer.invoke('file:open-folder'),
    scanFolder: (folderPath: string) => ipcRenderer.invoke('file:scan-folder', folderPath),
    getLocalFileUrl: (filePath: string) => ipcRenderer.invoke('file:get-url', filePath)
  },

  // 视频文件信息
  video: {
    getInfo: (filePath: string) => ipcRenderer.invoke('video:get-info', filePath)
  },

  // 服务器管理
  server: {
    list: () => ipcRenderer.invoke('server:list'),
    getActive: () => ipcRenderer.invoke('server:get-active'),
    ensureConnected: () => ipcRenderer.invoke('server:ensure-connected'),
    add: (params: { name: string; url: string; token: string }) => ipcRenderer.invoke('server:add', params),
    update: (params: import('../shared/preload-types').ServerUpdateParams) => ipcRenderer.invoke('server:update', params),
    remove: (id: string) => ipcRenderer.invoke('server:remove', id),
    switch: (id: string) => ipcRenderer.invoke('server:switch', id),
    test: (url: string, token: string) => ipcRenderer.invoke('server:test', url, token),
    addEmby: (params: import('../shared/preload-types').EmbyAddServerParams) =>
      ipcRenderer.invoke('server:add-emby', params),
    testEmby: (params: import('../shared/preload-types').EmbyTestParams) =>
      ipcRenderer.invoke('server:test-emby', params),
    listUsers: (id: string) => ipcRenderer.invoke('server:list-users', id),
    setUser: (id: string, userId: string) => ipcRenderer.invoke('server:set-user', id, userId)
  },

  // Emby API 已移除独立登录通道：登录统一走 server.testEmby，token 只留在主进程

  // 最近入库
  recentlyAdded: {
    list: (limit?: number) => ipcRenderer.invoke('recentlyAdded:list', limit),
    add: (item: import('../shared/preload-types').RecentlyAddedItem) => ipcRenderer.invoke('recentlyAdded:add', item),
    addBatch: (items: import('../shared/preload-types').RecentlyAddedItem[]) => ipcRenderer.invoke('recentlyAdded:addBatch', items),
    clear: () => ipcRenderer.invoke('recentlyAdded:clear'),
    getConfig: () => ipcRenderer.invoke('recentlyAdded:getConfig'),
    saveConfig: (config: Partial<import('../shared/preload-types').RecentlyAddedConfig>) => ipcRenderer.invoke('recentlyAdded:saveConfig', config)
  },

  // 配置存储
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key)
  },

  // 数据导入导出
  data: {
    export: (options?: { format?: 'json' | 'csv'; includeKeys?: string[]; includeSensitive?: boolean }) =>
      ipcRenderer.invoke('data:export', options),
    import: (options?: { merge?: boolean; selectedKeys?: string[] }) =>
      ipcRenderer.invoke('data:import', options),
    listKeys: () => ipcRenderer.invoke('data:list-keys')
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    alwaysOnTop: (enabled?: boolean) => ipcRenderer.invoke('window:always-on-top', enabled),
    onFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
      const listener = (_event: unknown, fullscreen: boolean): void => callback(fullscreen)
      ipcRenderer.on('window:fullscreen-changed', listener)
      return () => { ipcRenderer.removeListener('window:fullscreen-changed', listener) }
    }
  },

  // 日志
  log: {
    send: (level: string, source: string, ...args: unknown[]) =>
      ipcRenderer.invoke('log:send', level, source, ...args),
    toggleWindow: () => ipcRenderer.invoke('log:toggle')
  }
}

// 日志窗口专用桥接（与 log-preload.ts 对齐）
const logApi = {
  onLogEntry: (callback: (entry: unknown) => void) => {
    ipcRenderer.on('log:entry', (_event, entry) => callback(entry))
  },
  onLogHistory: (callback: (entries: unknown[]) => void) => {
    ipcRenderer.on('log:history', (_event, entries) => callback(entries))
  }
}

// 暴露 API
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('logApi', logApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
  // @ts-ignore
  window.logApi = logApi
}

