import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 自定义 API
const api = {
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

  // Jellyfin API
  jellyfin: {
    connect: (url: string, token: string) => ipcRenderer.invoke('jellyfin:connect', url, token),
    getLibraries: () => ipcRenderer.invoke('jellyfin:get-libraries'),
    getItems: (parentId: string, startIndex?: number, limit?: number) =>
      ipcRenderer.invoke('jellyfin:get-items', parentId, startIndex, limit),
    search: (query: string) => ipcRenderer.invoke('jellyfin:search', query),
    getItemDetails: (itemId: string) => ipcRenderer.invoke('jellyfin:get-item-details', itemId),
    getPlaybackUrl: (itemId: string) => ipcRenderer.invoke('jellyfin:get-playback-url', itemId),
    reportProgress: (itemId: string, position: number, isPaused: boolean) =>
      ipcRenderer.invoke('jellyfin:report-progress', itemId, position, isPaused),
    toggleFavorite: (itemId: string) => ipcRenderer.invoke('jellyfin:toggle-favorite', itemId)
  },

  // 弹幕 API
  danmaku: {
    match: (title: string) => ipcRenderer.invoke('danmaku:match', title),
    search: (keyword: string) => ipcRenderer.invoke('danmaku:search', keyword),
    getComments: (commentId: string) => ipcRenderer.invoke('danmaku:get-comments', commentId),
    getSegmentComments: (params: any) => ipcRenderer.invoke('danmaku:get-segment-comments', params)
  },

  // 本地文件
  file: {
    openFile: () => ipcRenderer.invoke('file:open-file'),
    openFolder: () => ipcRenderer.invoke('file:open-folder'),
    scanFolder: (folderPath: string) => ipcRenderer.invoke('file:scan-folder', folderPath)
  },

  // 配置存储
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key)
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
