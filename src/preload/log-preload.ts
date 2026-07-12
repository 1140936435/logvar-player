/**
 * 日志窗口专用 preload 脚本
 * 通过 contextBridge 安全地暴露日志 API，避免 nodeIntegration: true
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('logApi', {
  onLogEntry: (callback: (entry: unknown) => void) => {
    ipcRenderer.on('log:entry', (_event, entry) => callback(entry))
  },
  onLogHistory: (callback: (entries: unknown[]) => void) => {
    ipcRenderer.on('log:history', (_event, entries) => callback(entries))
  }
})