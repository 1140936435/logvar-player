import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/preload-types'
import { electronAPI } from '@electron-toolkit/preload'

// 自定义 API
const api: Api = {
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
    onEvent: (callback: (event: string, data: any) => void) => {
      ipcRenderer.on('mpv:event', (_event, data) => callback(data.event, data))
    }
  },

  // 播放历史
  history: {
    save: (item: any) => ipcRenderer.invoke('history:save', item),
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
    reportProgress: (itemId: string, position: number, isPaused: boolean) =>
      ipcRenderer.invoke('jellyfin:report-progress', itemId, position, isPaused),
    toggleFavorite: (itemId: string) => ipcRenderer.invoke('jellyfin:toggle-favorite', itemId),
    getEpisodes: (seriesId: string, seasonId?: string) =>
      ipcRenderer.invoke('jellyfin:get-episodes', seriesId, seasonId)
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
    getSegmentComments: (params: any) => ipcRenderer.invoke('danmaku:get-segment-comments', params),
    prefetchSeries: (animeId: number) => ipcRenderer.invoke('danmaku:prefetch-series', animeId),
    getConfig: () => ipcRenderer.invoke('danmaku:get-config'),
    setConfig: (config: { primary?: string; mirrors?: string[] }) =>
      ipcRenderer.invoke('danmaku:set-config', config),
    testApi: (url: string) => ipcRenderer.invoke('danmaku:test-api', url),
    parseLocalXml: (xmlPath: string) => ipcRenderer.invoke('danmaku:parse-local-xml', xmlPath),
    findLocalXml: (videoPath: string) => ipcRenderer.invoke('danmaku:find-local-xml', videoPath)
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
    add: (params: { name: string; url: string; token: string }) => ipcRenderer.invoke('server:add', params),
    update: (params: { id: string; name?: string; url?: string; token?: string }) => ipcRenderer.invoke('server:update', params),
    remove: (id: string) => ipcRenderer.invoke('server:remove', id),
    switch: (id: string) => ipcRenderer.invoke('server:switch', id),
    test: (url: string, token: string) => ipcRenderer.invoke('server:test', url, token)
  },

  // 配置存储
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key)
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },

  // 日志
  log: {
    send: (level: string, source: string, ...args: any[]) =>
      ipcRenderer.invoke('log:send', level, source, ...args),
    toggleWindow: () => ipcRenderer.invoke('log:toggle')
  }
}

// 暴露 API
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}