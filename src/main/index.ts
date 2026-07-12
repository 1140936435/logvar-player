import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog,
  protocol,
  net,
  safeStorage
} from 'electron'
import * as crypto from 'crypto'
import { join, dirname, basename } from 'path'
import { pathToFileURL } from 'url'

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'fs'
import type { DanmakuComment, DanmakuCommentRaw, DanmakuCommentsResponse, DanmakuSearchResponse, JellyfinServerInfo } from '../shared/types'
import * as http from 'http'
import * as https from 'https'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// ==================== 资源路径工具 ====================

function getResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, relativePath)
  }
  return join(__dirname, '../../', relativePath)
}

// ==================== 日志系统 ====================

interface LogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  message: string
}

const logHistory: LogEntry[] = []
let logWindow: BrowserWindow | null = null
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let isAlwaysOnTop = false

// 本地日志文件
const logsDir = join(app.getPath('userData'), 'logs')
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

function getLogFile(): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return join(logsDir, `${dateStr}.log`)
}

function writeLogToFile(entry: LogEntry): void {
  try {
    const date = new Date(entry.timestamp)
    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`
    const line = `[${timeStr}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}\n`
    appendFileSync(getLogFile(), line, 'utf-8')
  } catch {}
}

// 清理 7 天前的日志文件
function cleanOldLogs(): void {
  try {
    const now = Date.now()
    const files = readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
    for (const file of files) {
      const dateStr = file.replace('.log', '')
      const fileDate = new Date(dateStr).getTime()
      if (now - fileDate > 7 * 24 * 60 * 60 * 1000) {
        unlinkSync(join(logsDir, file))
      }
    }
  } catch {}
}
cleanOldLogs()

function addLog(level: LogEntry['level'], source: string, ...args: unknown[]): void {
  const rawMessage = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message
      // 已经是字符串则直接使用，避免重复序列化
      if (typeof a === 'string') return a
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    })
    .join(' ')

  // 日志脱敏：移除 token/api_key 等敏感信息
  const message = sanitizeLog(rawMessage)

  const entry: LogEntry = { timestamp: Date.now(), level, source, message }
  logHistory.push(entry)
  if (logHistory.length > 5000) logHistory.shift()

  // 写入本地日志文件
  writeLogToFile(entry)

  const nativeConsole = level === 'error' ? origConsole.error : level === 'warn' ? origConsole.warn : origConsole.log
  nativeConsole(`[${source}] ${message}`)

  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('log:entry', entry)
  }
}

const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

console.log = (...args: unknown[]) => addLog('info', 'main', ...args)
console.warn = (...args: unknown[]) => addLog('warn', 'main', ...args)
console.error = (...args: unknown[]) => addLog('error', 'main', ...args)
console.debug = (...args: unknown[]) => addLog('debug', 'main', ...args)

// ==================== 日志窗口 ====================

function getLogWindow(): BrowserWindow {
  if (logWindow && !logWindow.isDestroyed()) return logWindow

  logWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 500,
    minHeight: 300,
    title: 'mplay - 日志',
    backgroundColor: '#0d0d0d',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  })

  logWindow.loadFile(join(__dirname, 'log-window.html'))

  logWindow.on('ready-to-show', () => {
    logWindow!.show()
    logWindow!.webContents.send('log:history', logHistory)
  })

  logWindow.on('closed', () => {
    logWindow = null
  })

  return logWindow
}

function toggleLogWindow(): void {
  if (logWindow && !logWindow.isDestroyed()) {
    if (logWindow.isVisible()) {
      logWindow.hide()
    } else {
      logWindow.show()
      logWindow.focus()
    }
  } else {
    getLogWindow()
  }
}

// ==================== IPC: 日志 ====================

ipcMain.handle('log:send', (_event, level: string, source: string, ...args: unknown[]) => {
  const validLevels = ['info', 'warn', 'error', 'debug']
  const lvl = validLevels.includes(level) ? (level as LogEntry['level']) : 'info'
  addLog(lvl, source, ...args)
})

ipcMain.handle('log:toggle', () => {
  toggleLogWindow()
})

// ==================== Jellyfin API 辅助函数 ====================

interface JellyfinAuth {
  url: string
  token: string
  userId: string
}

function buildJellyfinHeaders(token: string): Record<string, string> {
  return {
    'X-Emby-Token': token,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function isUnresolvedEncrypted(val: string): boolean {
  return typeof val === 'string' && isEncrypted(val)
}

async function jellyfinRequest<T>(
  auth: JellyfinAuth,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  if (isUnresolvedEncrypted(auth.url) || !auth.url) {
    throw new Error('Jellyfin 服务器地址无法解密，请在设置中重新输入服务器凭据')
  }
  const baseUrl = normalizeUrl(auth.url)
  const url = `${baseUrl}${endpoint}`
  const headers = { ...buildJellyfinHeaders(auth.token), ...((options.headers as Record<string, string>) || {}) }

  console.log(`Jellyfin request: ${options.method || 'GET'} ${url}`)

  const response = await fetch(url, {
    ...options,
    headers
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jellyfin API error ${response.status}: ${text || response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const buffer = await response.arrayBuffer()
    const text = new TextDecoder('utf-8').decode(buffer)
    return JSON.parse(text) as T
  }
  return (await response.text()) as unknown as T
}

// ==================== IPC: Jellyfin ====================

let jellyfinAuth: JellyfinAuth | null = null

// ==================== 多服务器管理 ====================


// 配置文件路径和数据（需要在函数定义前声明）
let configPath = ''
let configData: Record<string, unknown> = {}

interface JellyfinServerConfig {
  id: string
  name: string
  url: string
  token: string
  userId?: string
}

function getServers(): JellyfinServerConfig[] {
  const raw = configData['jellyfin:servers']
  if (Array.isArray(raw)) return raw as JellyfinServerConfig[]
  return []
}

function saveServers(servers: JellyfinServerConfig[]): void {
  configData['jellyfin:servers'] = servers
  saveConfigFile()
}

function getActiveServerId(): string | null {
  return (configData['jellyfin:activeServerId'] as string) || null
}

function setActiveServerId(id: string): void {
  configData['jellyfin:activeServerId'] = id
  saveConfigFile()
}

function generateServerId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 从旧的单服务器配置迁移 */
function migrateLegacyConfig(): void {
  const servers = getServers()
  if (servers.length > 0) return // 已迁移过
  const oldUrl = configData['jellyfin.url'] as string | undefined
  const oldToken = configData['jellyfin.token'] as string | undefined
  if (oldUrl && oldToken) {
    const id = generateServerId()
    const server: JellyfinServerConfig = {
      id,
      name: (configData['serverDisplayName'] as string) || 'Jellyfin',
      url: oldUrl,
      token: oldToken
    }
    saveServers([server])
    setActiveServerId(id)
    console.log(`[server] 已从旧配置迁移服务器: ${server.name}`)
  }
}

/** 连接到指定服务器并更新 auth */
async function connectToServer(id: string): Promise<{ success: boolean; data?: JellyfinServerInfo; error?: string }> {
  const servers = getServers()
  const server = servers.find(s => s.id === id)
  if (!server) return { success: false, error: '服务器不存在' }
  if (isUnresolvedEncrypted(server.url) || isUnresolvedEncrypted(server.token)) {
    return { success: false, error: `服务器 "${server.name}" 的凭据无法解密（safeStorage 版本变更），请在设置中重新输入 URL 和 Token` }
  }

  try {
    const auth: JellyfinAuth = { url: server.url, token: server.token, userId: '' }
    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth, '/System/Info'
    )
    const users = await jellyfinRequest<{ Id: string; Name: string }[]>(auth, '/Users')
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error('服务器上没有找到用户')
    }
    auth.userId = users[0].Id
    jellyfinAuth = auth

    // 更新 userId
    server.userId = auth.userId
    saveServers(servers)
    setActiveServerId(id)

    // 同步旧 key（兼容性）
    configData['jellyfin'] = { url: server.url, token: server.token }
    saveConfigFile()

    console.log(`[server] 已连接: ${info.ServerName} v${info.Version}, userId=${auth.userId}`)
    return { success: true, data: info }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[server] 连接失败 (${server.name}): ${msg}`)
    return { success: false, error: msg }
  }
}

ipcMain.handle('jellyfin:connect', async (_event, url: string, token: string) => {
  if (isUnresolvedEncrypted(url) || isUnresolvedEncrypted(token)) {
    console.warn('[server] Jellyfin 凭据未解密，请在设置中重新输入')
    return { success: false, error: 'Jellyfin 服务器凭据无法解密（safeStorage 版本变更），请在设置中重新输入 URL 和 Token' }
  }
  try {
    console.log(`Attempting Jellyfin connection to ${url}`)
    const auth: JellyfinAuth = { url, token, userId: '' }

    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth,
      '/System/Info'
    )

    const users = await jellyfinRequest<{ Id: string; Name: string }[]>(
      auth,
      '/Users'
    )
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error('Jellyfin 服务器上没有找到用户')
    }
    auth.userId = users[0].Id

    jellyfinAuth = auth
    console.log(`Jellyfin connected: ${info.ServerName} v${info.Version}, userId=${auth.userId}`)
    return { success: true, data: info }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Jellyfin connect failed: ${msg}`)
    return { success: false, error: msg }
  }
})

// ==================== 多服务器 IPC ====================

ipcMain.handle('server:list', async () => {
  return { success: true, data: getServers() }
})

ipcMain.handle('server:get-active', async () => {
  const id = getActiveServerId()
  const servers = getServers()
  const active = servers.find(s => s.id === id) || null
  return { success: true, data: { id, server: active } }
})

ipcMain.handle('server:add', async (_event, params: { name: string; url: string; token: string }) => {
  const servers = getServers()
  const id = generateServerId()
  const server: JellyfinServerConfig = {
    id,
    name: params.name || 'Jellyfin',
    url: params.url.replace(/\/+$/, ''),
    token: params.token
  }
  servers.push(server)
  saveServers(servers)
  return { success: true, data: server }
})

ipcMain.handle('server:update', async (_event, params: { id: string; name?: string; url?: string; token?: string }) => {
  const servers = getServers()
  const server = servers.find(s => s.id === params.id)
  if (!server) return { success: false, error: '服务器不存在' }
  if (params.name !== undefined) server.name = params.name
  if (params.url !== undefined) server.url = params.url.replace(/\/+$/, '')
  if (params.token !== undefined) server.token = params.token
  saveServers(servers)
  return { success: true }
})

ipcMain.handle('server:remove', async (_event, id: string) => {
  let servers = getServers()
  servers = servers.filter(s => s.id !== id)
  saveServers(servers)
  if (getActiveServerId() === id) {
    if (servers.length > 0) {
      setActiveServerId(servers[0].id)
    } else {
      setActiveServerId('')
      jellyfinAuth = null
    }
  }
  return { success: true }
})

ipcMain.handle('server:switch', async (_event, id: string) => {
  const result = await connectToServer(id)
  return result
})

ipcMain.handle('server:test', async (_event, url: string, token: string) => {
  const startTime = Date.now()
  try {
    const auth: JellyfinAuth = { url: url.replace(/\/+$/, ''), token, userId: '' }
    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth, '/System/Info'
    )
    const elapsed = Date.now() - startTime
    return { success: true, data: info, elapsed }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), elapsed: Date.now() - startTime }
  }
})

ipcMain.handle('jellyfin:get-libraries', async () => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const data = await jellyfinRequest<{ Items: unknown[] }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Views`
    )
    return { success: true, data }
  } catch (err) {
    console.error(`jellyfin:get-libraries failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-items', async (_event, parentId: string, startIndex = 0, limit = 50) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const params = new URLSearchParams({
      parentId: parentId,
      startIndex: String(startIndex),
      limit: String(limit),
      sortBy: 'SortName',
      sortOrder: 'Ascending',
      recursive: 'true',
      includeItemTypes: 'Series,Movie',
      fields: 'Overview,PremiereDate,CommunityRating'
    })
    const data = await jellyfinRequest<{ Items: unknown[]; TotalRecordCount: number }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items?${params.toString()}`
    )
    return { success: true, data }
  } catch (err) {
    console.error(`jellyfin:get-items failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-children', async (_event, parentId: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const params = new URLSearchParams({
      parentId: parentId,
      sortBy: 'IndexNumber,SortName',
      sortOrder: 'Ascending',
      recursive: 'false',
      fields: 'Overview,MediaSources,ChildCount',
      limit: '200'
    })
    const data = await jellyfinRequest<{ Items: unknown[]; TotalRecordCount: number }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items?${params.toString()}`
    )
    return { success: true, data }
  } catch (err) {
    console.error(`jellyfin:get-children failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:search', async (_event, query: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const params = new URLSearchParams({
      searchTerm: query,
      includeItemTypes: 'Movie,Series,Episode',
      recursive: 'true',
      limit: '30'
    })
    const data = await jellyfinRequest<{ Items: unknown[] }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items?${params.toString()}`
    )
    return { success: true, data }
  } catch (err) {
    console.error(`jellyfin:search failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-item-details', async (_event, itemId: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const data = await jellyfinRequest(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items/${itemId}?Fields=MediaSources,MediaStreams,People,Genres,Studios,OfficialRating,CommunityRating,VoteCount`
    )
    return { success: true, data }
  } catch (err) {
    console.error(`jellyfin:get-item-details failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-playback-url', async (_event, itemId: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }

  try {
    // 第1步：获取 item 详情，提取真实 MediaSourceId 和字幕轨道
    const item = await jellyfinRequest<{
      MediaSources?: {
        Id: string; Name?: string; Container?: string
        MediaStreams?: { Index: number; Type: string; DisplayTitle?: string; Language?: string; Codec?: string; IsExternal?: boolean; DeliveryUrl?: string }[]
      }[]
    }>(jellyfinAuth, `/Users/${jellyfinAuth.userId}/Items/${itemId}?Fields=MediaSources,MediaStreams`)

    const mediaSources = item?.MediaSources
    if (!mediaSources || mediaSources.length === 0) {
      console.warn(`No MediaSources for item ${itemId}, trying itemId as fallback`)
      const baseUrl = normalizeUrl(jellyfinAuth.url)
      const url = `${baseUrl}/Videos/${itemId}/stream?Static=true&api_key=${jellyfinAuth.token}`
      console.log(`get-playback-url (fallback): ${url}`)
      return { success: true, data: { url, subtitles: [] } }
    }

    const mediaSourceId = mediaSources[0].Id
    const container = mediaSources[0].Container || ''
    console.log(`get-playback-url: mediaSourceId=${mediaSourceId}, container=${container}, itemId=${itemId}`)

    const baseUrl = normalizeUrl(jellyfinAuth.url)

    // 提取字幕轨道信息
    const streams = mediaSources[0].MediaStreams || []
    const subtitleStreams = streams.filter(s => s.Type === 'Subtitle')
    console.log(`get-playback-url: total streams=${streams.length}, subtitles=${subtitleStreams.map(s => ({ Index: s.Index, DisplayTitle: s.DisplayTitle, Language: s.Language, Codec: s.Codec, IsExternal: s.IsExternal, DeliveryUrl: s.DeliveryUrl }))}`)
    const subtitles = subtitleStreams.map((s, subIdx) => {
        // 存储 API 端点路径（不含 baseUrl），由 fetch-subtitle 通过 jellyfinRequest 获取
        // 注意：Jellyfin 字幕 API 使用 MediaStream.Index（全局流索引），而非 0-based 字幕序号
        const streamIndex = s.Index ?? subIdx
        const endpoint = s.DeliveryUrl || `/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/Stream.vtt`
        console.log(`get-playback-url: subtitle[${subIdx}] streamIndex=${streamIndex} endpoint=${endpoint}`)
        return {
          index: subIdx,
          label: s.DisplayTitle || s.Language || s.Codec || `字幕 ${subIdx + 1}`,
          language: s.Language || '',
          codec: s.Codec || '',
          url: endpoint
        }
      })

    const url = `${baseUrl}/Videos/${itemId}/stream?Static=true&MediaSourceId=${mediaSourceId}&api_key=${jellyfinAuth.token}`
    console.log(`get-playback-url (final): ${url}, subtitles: ${subtitles.length}`)
    return { success: true, data: { url, subtitles } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`jellyfin:get-playback-url failed:`, msg)
    return { success: false, error: `获取播放地址失败: ${msg}` }
  }
})

// 通过主进程获取字幕内容（绕过 CORS）
// 注意：不能用 jellyfinRequest，因为它强制 Accept: application/json，
// 而字幕接口返回 text/vtt，Jellyfin 会因无法返回 JSON 而 404
ipcMain.handle('jellyfin:fetch-subtitle', async (_event, endpoint: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    console.log(`fetch-subtitle: requesting endpoint=${endpoint}`)
    // 如果 endpoint 是完整 URL（DeliveryUrl），提取路径部分
    let path = endpoint
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      const u = new URL(endpoint)
      path = u.pathname + u.search
    }
    const baseUrl = normalizeUrl(jellyfinAuth.url)
    const url = `${baseUrl}${path}`
    console.log(`fetch-subtitle: full url=${url}`)
    const response = await fetch(url, {
      headers: { 'X-Emby-Token': jellyfinAuth.token }
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Jellyfin API error ${response.status}: ${text || response.statusText}`)
    }
    const content = await response.text()
    console.log(`fetch-subtitle: got ${content.length} bytes`)
    return { success: true, data: content }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`jellyfin:fetch-subtitle failed:`, msg)
    return { success: false, error: msg }
  }
})

ipcMain.handle('jellyfin:report-progress', async (_event, itemId: string, position: number, isPaused: boolean) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    await jellyfinRequest(jellyfinAuth, `/Sessions/Playing/Progress`, {
      method: 'POST',
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: Math.floor(position * 10000000),
        IsPaused: isPaused,
        EventName: isPaused ? 'pause' : 'timeupdate'
      })
    })
    return { success: true }
  } catch (err) {
    console.error(`jellyfin:report-progress failed:`, err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:toggle-favorite', async (_event, itemId: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const item = await jellyfinRequest<{ UserData?: { IsFavorite?: boolean } }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items/${itemId}`
    )
    const isFav = item?.UserData?.IsFavorite ?? false
    await jellyfinRequest(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/FavoriteItems/${itemId}`,
      { method: isFav ? 'DELETE' : 'POST' }
    )
    return { success: true, data: { isFavorite: !isFav } }
  } catch (err) {
    console.error(`jellyfin:toggle-favorite failed:`, err)
    return { success: false, error: String(err) }
  }
})

// ==================== IPC: 豆瓣评分 ====================
// 使用 Jellyfin 的 CommunityRating，无需外部 API
ipcMain.handle('douban:get-rating', async (_event, _title: string) => {
  return { success: true, data: null }
})

ipcMain.handle('douban:get-ratings-batch', async (_event, _titles: string[]) => {
  return { success: true, data: {} }
})

// ==================== IPC: 海报映射持久化 ====================

function getPosterMapPath(): string {
  return join(app.getPath('userData'), 'poster-map.json')
}

function loadPosterMap(): Record<string, string> {
  try {
    if (existsSync(getPosterMapPath())) {
      return JSON.parse(readFileSync(getPosterMapPath(), 'utf-8'))
    }
  } catch {}
  return {}
}

function savePosterMap(map: Record<string, string>): void {
  try {
    writeFileSync(getPosterMapPath(), JSON.stringify(map, null, 2), 'utf-8')
  } catch (err) {
    console.error('[poster] Failed to save map:', err)
  }
}

ipcMain.handle('poster:load-all', async () => {
  const map = loadPosterMap()
  // Also scan directories to find any orphaned posters
  const postersDir = join(app.getPath('userData'), 'posters')
  const doubanDir = join(app.getPath('userData'), 'posters_douban')
  for (const dir of [postersDir, doubanDir]) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jpg'))
      for (const f of files) {
        const id = f.replace('.jpg', '')
        const fullPath = join(dir, f)
        // Add any orphaned posters if not already in map
        const existing = Object.entries(map).find(([, v]) => v === fullPath)
        if (!existing) {
          map[`orphan_${id}`] = fullPath
        }
      }
    } catch {}
  }
  return { success: true, data: map }
})

ipcMain.handle('poster:save-mapping', async (_event, itemId: string, localPath: string) => {
  const map = loadPosterMap()
  map[itemId] = localPath
  savePosterMap(map)
  return { success: true }
})


// ==================== IPC: 豆瓣刮削 ====================

ipcMain.handle('media:search-douban', async (_event, params: { query: string; year?: number; type?: string }) => {
  const { query, year, type } = params
  console.log(`[douban] Searching: "${query}" year=${year} type=${type}`)
  
  try {
    // 使用豆瓣 suggest JSON API（最可靠）
    const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    })

    if (!res || !res.ok) {
      return { success: false, error: '豆瓣搜索不可达' }
    }

    const items = await res.json() as any[]
    if (!Array.isArray(items) || items.length === 0) {
      return { success: false, error: '未找到豆瓣结果' }
    }

    const results = items.slice(0, 10).map((r: any) => ({
      id: String(r.id || ''),
      title: r.title || '',
      year: r.year || '',
      poster: r.img || r.cover_url || '',
      overview: r.sub_title || ''
    }))
    
    console.log(`[douban] Got ${results.length} results for "${query}"`)
    return { success: true, data: results }
  } catch (e: any) {
    console.error(`[douban] Search error:`, e?.message)
    return { success: false, error: e?.message || '搜索失败' }
  }
})

ipcMain.handle('media:fetch-douban-poster', async (_event, params: { doubanId: string; posterUrl: string }) => {
  const postersDir = join(app.getPath('userData'), 'posters_douban')
  if (!existsSync(postersDir)) mkdirSync(postersDir, { recursive: true })
  
  const safeName = params.doubanId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const localPath = join(postersDir, `${safeName}.jpg`)
  
  if (existsSync(localPath)) {
    return { success: true, data: { localPath } }
  }
  
  try {
    const imgRes = await fetch(params.posterUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://movie.douban.com/' },
      signal: AbortSignal.timeout(15000)
    }).catch(() => null)
    
    if (!imgRes || !imgRes.ok) {
      return { success: false, error: '下载封面失败' }
    }
    
    const buffer = Buffer.from(await imgRes.arrayBuffer())
    writeFileSync(localPath, buffer)
    console.log(`[douban] poster saved: ${localPath}`)
    return { success: true, data: { localPath } }
  } catch (e: any) {
    return { success: false, error: e?.message || '下载失败' }
  }
})

// ==================== IPC: 剧集列表 ====================

ipcMain.handle('jellyfin:get-episodes', async (_event, seriesId: string, seasonId?: string) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    if (seasonId) {
      const params = new URLSearchParams({
        parentId: seasonId,
        sortBy: 'IndexNumber',
        sortOrder: 'Ascending',
        recursive: 'false',
        fields: 'Overview,MediaSources,IndexNumber,ParentIndexNumber',
        limit: '500'
      })
      const data = await jellyfinRequest<{ Items: unknown[]; TotalRecordCount: number }>(
        jellyfinAuth,
        `/Users/${jellyfinAuth.userId}/Items?${params.toString()}`
      )
      return { success: true, data }
    }

    const seasonsParams = new URLSearchParams({
      parentId: seriesId,
      sortBy: 'IndexNumber',
      sortOrder: 'Ascending',
      recursive: 'false',
      includeItemTypes: 'Season',
      fields: 'ChildCount',
      limit: '100'
    })
    const seasonsData = await jellyfinRequest<{ Items: Array<{ Id: string; Name: string; IndexNumber?: number; ChildCount?: number }> }>(
      jellyfinAuth,
      `/Users/${jellyfinAuth.userId}/Items?${seasonsParams.toString()}`
    )

    const seasons = seasonsData.Items || []
    if (seasons.length === 0) {
      const epsParams = new URLSearchParams({
        parentId: seriesId,
        sortBy: 'IndexNumber',
        sortOrder: 'Ascending',
        recursive: 'false',
        fields: 'Overview,MediaSources,IndexNumber,ParentIndexNumber',
        limit: '500'
      })
      const epsData = await jellyfinRequest<{ Items: unknown[] }>(
        jellyfinAuth,
        `/Users/${jellyfinAuth.userId}/Items?${epsParams.toString()}`
      )
      return { success: true, data: { seasons: [], episodes: epsData.Items || [] } }
    }

    const allEpisodes: unknown[] = []
    for (const season of seasons) {
      const epsParams = new URLSearchParams({
        parentId: season.Id,
        sortBy: 'IndexNumber',
        sortOrder: 'Ascending',
        recursive: 'false',
        fields: 'Overview,MediaSources,IndexNumber,ParentIndexNumber',
        limit: '500'
      })
      const epsData = await jellyfinRequest<{ Items: unknown[] }>(
        jellyfinAuth,
        `/Users/${jellyfinAuth.userId}/Items?${epsParams.toString()}`
      )
      for (const ep of (epsData.Items || [])) {
        allEpisodes.push(ep)
      }
    }

    return { success: true, data: { seasons, episodes: allEpisodes } }
  } catch (err) {
    console.error('jellyfin:get-episodes failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-genres', async () => {
  try {
    if (!jellyfinAuth) return { success: false, error: '未连接 Jellyfin' }
    const result = await jellyfinRequest<{ Items?: Array<{ Id: string; Name: string }> }>(
      jellyfinAuth, '/Genres?userId=' + jellyfinAuth.userId
    )
    return { success: true, data: result.Items || [] }
  } catch (err) {
    console.error('jellyfin:get-genres failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('jellyfin:get-genre-items', async (_event, genre: string, startIndex?: number) => {
  try {
    if (!jellyfinAuth) return { success: false, error: '未连接 Jellyfin' }
    const baseUrl = normalizeUrl(jellyfinAuth.url)
    const url = `${baseUrl}/Items?userId=${jellyfinAuth.userId}&genres=${encodeURIComponent(genre)}&recursive=true&includeItemTypes=Movie,Series&sortBy=SortName&startIndex=${startIndex || 0}&limit=50`
    console.log(`[jellyfin:get-genre-items] GET ${url}`)
    const response = await fetch(url, { headers: buildJellyfinHeaders(jellyfinAuth.token) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()
    const text = new TextDecoder('utf-8').decode(buffer)
    const data = JSON.parse(text)
    return { success: true, data: { Items: data.Items || [], TotalRecordCount: data.TotalRecordCount || 0 } }
  } catch (err) {
    console.error('jellyfin:get-genre-items failed:', err)
    return { success: false, error: String(err) }
  }
})

// ==================== IPC: Store ====================

// ==================== 敏感数据加密（safeStorage） ====================

/** 需要加密存储的 key 列表 */
const ENCRYPTED_KEYS = new Set([
  'jellyfin.token',
  'jellyfin.url',
  'danmaku:api-primary',
  'danmaku:api-mirrors',
  'dandanplay:appid',
  'dandanplay:appsecret',
])

/** safeStorage 跨会话可用性检测（启动时运行一次） */
let safeStorageWorking = false
try {
  if (safeStorage.isEncryptionAvailable()) {
    const testPlain = '__mplay_safestorage_test__'
    const encrypted = safeStorage.encryptString(testPlain)
    const decrypted = safeStorage.decryptString(encrypted)
    safeStorageWorking = decrypted === testPlain
  }
} catch { safeStorageWorking = false }
if (!safeStorageWorking) {
  console.warn('[Config] safeStorage encryption unavailable or broken across sessions — using XOR obfuscation as fallback')
}

/** 机器相关的 XOR 混淆密钥（基于机器名+用户名+固定盐） */
function xorKey(): Buffer {
  const seed = `${process.env.COMPUTERNAME ?? 'unknown'}|${process.env.USERNAME ?? 'unknown'}|mplay-v1`
  return crypto.createHash('sha256').update(seed).digest()
}

/** XOR 字符串混淆 */
function xorObfuscate(plain: string): string {
  const key = xorKey()
  const buf = Buffer.from(plain, 'utf-8')
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length]
  return 'xor:' + buf.toString('base64')
}

/** XOR 字符串反混淆 */
function xorDeobfuscate(encoded: string): string {
  const key = xorKey()
  const buf = Buffer.from(encoded.slice(4), 'base64')
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length]
  return buf.toString('utf-8')
}

/** 值是否需要加密（既非 enc: 也非 xor: 前缀） */
function needsEncryption(val: string): boolean {
  return !!val && !val.startsWith('enc:') && !val.startsWith('xor:')
}

/** 值是否需要解密（enc: 或 xor: 前缀） */
function needsDecryption(val: string): boolean {
  return val.startsWith('enc:') || val.startsWith('xor:')
}

/** 值是否携带加密前缀 */
function isEncrypted(val: string): boolean {
  return val.startsWith('enc:') || val.startsWith('xor:')
}

/** 日志脱敏：移除可能的 token/密钥 */
function sanitizeLog(msg: string): string {
  return msg
    .replace(/api_key=[^&\s"']+/gi, 'api_key=***')
    .replace(/token["']?\s*[=:]\s*["']?[A-Za-z0-9_\-\.]+/gi, 'token=***')
}

function encryptValue(plain: string): string {
  if (!needsEncryption(plain)) return plain
  if (safeStorageWorking) {
    try {
      const buf = safeStorage.encryptString(plain)
      return 'enc:' + buf.toString('base64')
    } catch { /* fallthrough to XOR */ }
  }
  return xorObfuscate(plain)
}

function decryptValue(stored: string): string {
  if (!needsDecryption(stored)) return stored
  if (stored.startsWith('enc:')) {
    if (safeStorageWorking) {
      try {
        const buf = Buffer.from(stored.slice(4), 'base64')
        return safeStorage.decryptString(buf)
      } catch {
        console.warn('[Config] Failed to decrypt enc: value (safeStorage version mismatch?). Keeping encrypted blob.')
        return stored
      }
    }
    // safeStorage not working — enc: blob is orphaned, clear it
    return ''
  }
  // xor: prefix
  try {
    const result = xorDeobfuscate(stored)
    // 校验解密结果：URL 应以 http 开头，token 应为可打印 ASCII
    if (result && /^[\x20-\x7E]+$/.test(result)) {
      return result
    }
    console.warn('[Config] xor: value decoded to garbage — likely from corrupted or old-format data. Clearing.')
    return ''
  } catch {
    console.warn('[Config] Failed to deobfuscate xor: value. Keeping blob.')
    return stored
  }
}

/** 递归加密 configData 中的敏感字段 */
function encryptConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const key of ENCRYPTED_KEYS) {
    const val = out[key]
    if (typeof val === 'string' && needsEncryption(val)) {
      out[key] = encryptValue(val)
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === 'string' && needsEncryption(v) ? encryptValue(v) : v)
    }
  }
  // 对象形式（如 jellyfin: { url, token }）
  if (out.jellyfin && typeof out.jellyfin === 'object') {
    const jf = { ...(out.jellyfin as Record<string, unknown>) }
    for (const k of ['token', 'url']) {
      if (typeof jf[k] === 'string' && needsEncryption(jf[k] as string)) {
        jf[k] = encryptValue(jf[k] as string)
      }
    }
    out.jellyfin = jf
  }
  // 加密 jellyfin:servers 数组中每个服务器的 url 和 token
  if (Array.isArray(out['jellyfin:servers'])) {
    out['jellyfin:servers'] = (out['jellyfin:servers'] as Record<string, unknown>[]).map(s => {
      const sv = { ...s }
      if (typeof sv.url === 'string' && needsEncryption(sv.url)) sv.url = encryptValue(sv.url)
      if (typeof sv.token === 'string' && needsEncryption(sv.token)) sv.token = encryptValue(sv.token)
      return sv
    })
  }
  return out
}

/** 递归解密 configData 中的敏感字段 */
function decryptConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const key of ENCRYPTED_KEYS) {
    const val = out[key]
    if (typeof val === 'string' && needsDecryption(val)) {
      out[key] = decryptValue(val)
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === 'string' && needsDecryption(v) ? decryptValue(v) : v)
    }
  }
  if (out.jellyfin && typeof out.jellyfin === 'object') {
    const jf = { ...(out.jellyfin as Record<string, unknown>) }
    for (const k of ['token', 'url']) {
      if (typeof jf[k] === 'string' && needsDecryption(jf[k] as string)) {
        jf[k] = decryptValue(jf[k] as string)
      }
    }
    out.jellyfin = jf
  }
  // 解密 jellyfin:servers 数组中每个服务器的 url 和 token
  if (Array.isArray(out['jellyfin:servers'])) {
    out['jellyfin:servers'] = (out['jellyfin:servers'] as Record<string, unknown>[]).map(s => {
      const sv = { ...s }
      if (typeof sv.url === 'string' && needsDecryption(sv.url)) sv.url = decryptValue(sv.url)
      if (typeof sv.token === 'string' && needsDecryption(sv.token)) sv.token = decryptValue(sv.token)
      return sv
    })
  }
  return out
}

function loadConfigFile(): void {
  try {
    if (!configPath) {
      configPath = join(app.getPath('userData'), 'config.json')
    }
    console.log('[Config] Loading from:', configPath)
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      configData = decryptConfig(JSON.parse(raw))
      console.log('[Config] Loaded successfully, keys:', Object.keys(configData))
      // 清理因解密失败变成空字符串的 server 条目
      if (Array.isArray(configData['jellyfin:servers'])) {
        const servers = configData['jellyfin:servers'] as Record<string, unknown>[]
        const validServers = servers.filter(s => {
          const url = typeof s.url === 'string' ? s.url : ''
          if (!url || !/^https?:\/\//.test(url)) {
            console.warn('[Config] Removing server with invalid/missing url:', s.name, url && '(corrupted)')
            return false
          }
          return true
        })
        if (validServers.length !== servers.length) {
          configData['jellyfin:servers'] = validServers
          console.log('[Config] Cleaned jellyfin:servers, remaining:', validServers.length)
        }
      }
    } else {
      console.log('[Config] Config file does not exist')
    }
  } catch (err) {
    console.error('[Config] Failed to load:', err)
    configData = {}
  }
}

function saveConfigFile(): void {
  try {
    if (!configPath) {
      configPath = join(app.getPath('userData'), 'config.json')
    }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(encryptConfig(configData), null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}

// 初始化：加载已有配置
loadConfigFile()
migrateLegacyConfig()
// 保存清洗后的配置（移除因解密失败而损坏的 server 条目）
saveConfigFile()

/** 递归清理值中的 enc:/xor: 前缀密文，防止解密失败时泄露加密 blob */
function sanitizeEncryptedBlobs(value: unknown): unknown {
  if (typeof value === 'string' && isEncrypted(value)) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeEncryptedBlobs)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeEncryptedBlobs(v)
    }
    return out
  }
  return value
}

ipcMain.handle('store:get', async (_event, key: string) => {
  const raw = configData[key] ?? null
  // 安全检查：确保解密失败的 enc: 密文不会泄露到渲染进程
  return sanitizeEncryptedBlobs(raw)
})

ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
  configData[key] = value
  saveConfigFile()
  return true
})

ipcMain.handle('store:delete', async (_event, key: string) => {
  delete configData[key]
  saveConfigFile()
  return true
})

// ==================== 窗口控制 ====================

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

// ==================== 窗口置顶 ====================

ipcMain.handle('window:always-on-top', async (_event, enabled?: boolean) => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  isAlwaysOnTop = enabled ?? !isAlwaysOnTop
  mainWindow.setAlwaysOnTop(isAlwaysOnTop, 'screen-saver')
  return { success: true, data: isAlwaysOnTop }
})

// ==================== MPV 截图（带文件保存对话框） ====================

// 截图保存 — 通过 dialog 选择路径后保存
ipcMain.handle('mpv:screenshot-save', async () => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存截图',
      defaultPath: `screenshot_${Date.now()}.png`,
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
    // 返回用户选择的保存路径，让渲染进程用 Canvas 截图后写入
    return { success: false, filePath: result.filePath, error: 'use-canvas-fallback' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ==================== IPC: 播放历史 ====================

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

const HISTORY_KEY = 'history'

function loadHistory(): PlayHistoryItem[] {
  try {
    const raw = configData[HISTORY_KEY]
    if (Array.isArray(raw)) return raw as PlayHistoryItem[]
  } catch { /* ignore */ }
  return []
}

function saveHistory(items: PlayHistoryItem[]): void {
  configData[HISTORY_KEY] = items
  saveConfigFile()
}

ipcMain.handle('history:save', async (_event, item: PlayHistoryItem) => {
  const items = loadHistory()
  // 去重：同名同 itemId 覆盖更新
  const idx = items.findIndex((h) => h.itemId === item.itemId)
  const now = Date.now()
  const entry: PlayHistoryItem = { ...item, watchedAt: now }
  if (idx >= 0) {
    items.splice(idx, 1)
  }
  items.unshift(entry)
  // 最多保留 100 条
  if (items.length > 100) {
    items.length = 100
  }
  saveHistory(items)
  return { success: true }
})

ipcMain.handle('history:list', async () => {
  const items = loadHistory()
  return { success: true, data: items }
})

ipcMain.handle('history:delete', async (_event, itemId: string) => {
  let items = loadHistory()
  items = items.filter((h) => h.itemId !== itemId)
  saveHistory(items)
  return { success: true }
})

ipcMain.handle('history:clear', async () => {
  saveHistory([])
  return { success: true }
})

// ==================== IPC: 文件 ====================

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.rmvb'
])

// 静态正则：B站弹幕 XML 解析（避免每次调用重新编译）
const DANMAKU_XML_REGEX = /<d\s+p="([^"]*)"[^>]*>(.*?)<\/d>/gs

/**
 * 解析 B 站格式 XML 弹幕
 * @param xml XML 内容
 * @returns 弹幕数组
 */
function parseBilibiliXml(xml: string): DanmakuComment[] {
  DANMAKU_XML_REGEX.lastIndex = 0
  const comments: DanmakuComment[] = []
  let match: RegExpExecArray | null
  while ((match = DANMAKU_XML_REGEX.exec(xml)) !== null) {
    const pStr = match[1]
    const text = match[2].trim()
    const parts = pStr.split(',')
    const time = parseFloat(parts[0]) || 0
    const mode = parseInt(parts[1]) || 1
    const color = parseInt(parts[3]) || 0xFFFFFF
    if (text) {
      comments.push({ time, mode, color, text })
    }
  }
  return comments
}

async function scanVideoFolder(folderPath: string): Promise<{ success: boolean; data?: { files: string[]; folderPath: string }; error?: string }> {
  try {
    const files: string[] = []
    const entries = readdirSync(folderPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (VIDEO_EXTENSIONS.has(ext)) {
          files.push(join(folderPath, entry.name))
        }
      }
    }
    console.log(`file:scan-folder found ${files.length} video files in ${folderPath}`)
    return { success: true, data: { files, folderPath } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`file:scan-folder error:`, msg)
    return { success: false, error: msg }
  }
}

// ==================== 本地视频文件信息（ffprobe） ====================

import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)

/** 获取本地视频文件的技术参数 */
async function getLocalVideoInfo(filePath: string): Promise<{
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
}> {
  try {
    // 尝试使用 ffprobe
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { timeout: 10000 })

    const probe = JSON.parse(stdout)
    const format = probe.format || {}
    const videoStream = (probe.streams || []).find((s: any) => s.codec_type === 'video')
    const audioStream = (probe.streams || []).find((s: any) => s.codec_type === 'audio')

    return {
      success: true,
      data: {
        format: format.format_name || 'unknown',
        duration: parseFloat(format.duration) || 0,
        size: parseInt(format.size) || 0,
        bitRate: parseInt(format.bit_rate) || 0,
        video: videoStream ? {
          codec: videoStream.codec_name || 'unknown',
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          frameRate: videoStream.r_frame_rate || '0/1',
          bitRate: parseInt(videoStream.bit_rate) || 0,
          profile: videoStream.profile || '',
          level: videoStream.level ? String(videoStream.level) : ''
        } : {
          codec: 'unknown', width: 0, height: 0, frameRate: '0/1', bitRate: 0, profile: '', level: ''
        },
        audio: audioStream ? {
          codec: audioStream.codec_name || 'unknown',
          sampleRate: parseInt(audioStream.sample_rate) || 0,
          channels: audioStream.channels || 0,
          channelLayout: audioStream.channel_layout || '',
          bitRate: parseInt(audioStream.bit_rate) || 0
        } : {
          codec: 'unknown', sampleRate: 0, channels: 0, channelLayout: '', bitRate: 0
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('ffprobe error:', msg)
    return { success: false, error: `ffprobe 不可用: ${msg}` }
  }
}

ipcMain.handle('video:get-info', async (_event, filePath: string) => {
  return await getLocalVideoInfo(filePath)
})

ipcMain.handle('file:open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '打开视频文件',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '未选择文件' }
  }
  const filePath = result.filePaths[0]
  console.log('file:open-file selected:', filePath)
  return { success: true, data: { filePath } }
})

ipcMain.handle('file:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '打开文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '未选择文件夹' }
  }
  const folderPath = result.filePaths[0]
  console.log('file:open-folder selected:', folderPath)
  const scanResult = await scanVideoFolder(folderPath)
  return scanResult
})

ipcMain.handle('file:scan-folder', async (_event, folderPath: string) => {
  console.log('file:scan-folder', folderPath)
  return await scanVideoFolder(folderPath)
})

ipcMain.handle('file:get-url', async (_event, filePath: string) => {
  try {
    const url = pathToFileURL(filePath).toString()
    return { success: true, data: { url } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// ==================== IPC: 弹幕 ====================

// ==================== 弹幕 API（DandanPlay） ====================

function getDanmakuApiConfig(): { primary: string; mirrors: string[]; appId: string; appSecret: string } {
  const storePrimary = configData['danmaku:api-primary'] as string | undefined
  const storeMirrors = configData['danmaku:api-mirrors'] as string[] | undefined
  const appId = (configData['dandanplay:appid'] as string) || ''
  const appSecret = (configData['dandanplay:appsecret'] as string) || ''

  return {
    primary: storePrimary || 'https://api.dandanplay.net',
    mirrors: (storeMirrors && storeMirrors.length > 0) ? storeMirrors : [],
    appId,
    appSecret
  }
}

/** 生成 DandanPlay 签名验证头 */
function generateDandanHeaders(path: string, appId: string, appSecret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const apiPath = path.split('?')[0]  // 只取路径部分，不含查询参数
  const data = `${appId}${timestamp}${apiPath}${appSecret}`
  const signature = crypto.createHash('sha256').update(data).digest('base64')
  return {
    'X-AppId': appId,
    'X-Timestamp': String(timestamp),
    'X-Signature': signature
  }
}

ipcMain.handle('danmaku:get-config', async () => {
  const config = getDanmakuApiConfig()
  // 返回给前端时脱敏：不暴露完整 appSecret
  return {
    primary: config.primary,
    mirrors: config.mirrors,
    appId: config.appId,
    appSecretHint: config.appSecret ? '••••' + config.appSecret.slice(-4) : ''
  }
})

ipcMain.handle('danmaku:set-config', async (_event, config: { primary?: string; mirrors?: string[]; appId?: string; appSecret?: string }) => {
  if (config.primary !== undefined) {
    configData['danmaku:api-primary'] = config.primary
  }
  if (config.mirrors !== undefined) {
    configData['danmaku:api-mirrors'] = config.mirrors
  }
  if (config.appId !== undefined) {
    configData['dandanplay:appid'] = config.appId
  }
  if (config.appSecret !== undefined) {
    configData['dandanplay:appsecret'] = config.appSecret
  }
  saveConfigFile()
  return { success: true }
})

ipcMain.handle('danmaku:test-api', async (_event, url: string) => {
  const startTime = Date.now()
  const config = getDanmakuApiConfig()
  try {
    const testPath = '/api/v2/search/episodes'
    const authHeaders: Record<string, string> = config.appId && config.appSecret
      ? generateDandanHeaders(testPath, config.appId, config.appSecret)
      : {}

    const response = await nodeFetch(
      `${url}${testPath}?anime=${encodeURIComponent('测试')}`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'mplay/1.0 (Electron)',
          ...authHeaders
        }
      }
    )
    const elapsed = Date.now() - startTime

    if (!response.ok) {
      const bodyText = await readResponseBody(response).catch(() => '')
      return { success: false, error: `HTTP ${response.status}`, detail: bodyText.slice(0, 300), elapsed }
    }

    const contentType = response.headers.get('content-type') || ''
    const bodyText = await readResponseBody(response)

    if (!contentType.includes('application/json')) {
      return { success: false, error: '返回非 JSON', detail: bodyText.slice(0, 300), elapsed }
    }

    const data = JSON.parse(bodyText) as Record<string, unknown>
    const animes = data.animes as Array<Record<string, unknown>> | undefined
    const animeCount = animes?.length || 0
    const epCount = animes?.reduce(
      (sum: number, a: Record<string, unknown>) =>
        sum + ((a.episodes as Array<unknown>)?.length || 0),
      0
    ) || 0

    return { success: true, elapsed, animeCount, epCount }
  } catch (err) {
    return { success: false, error: String(err), elapsed: Date.now() - startTime }
  }
})

// 本地 XML 弹幕解析（B站格式）
ipcMain.handle('danmaku:parse-local-xml', async (_event, xmlPath: string) => {
  if (!existsSync(xmlPath)) {
    return { success: false, error: `文件不存在: ${xmlPath}` }
  }
  try {
    const xml = readFileSync(xmlPath, 'utf-8')
    const comments = parseBilibiliXml(xml)

    const result = { count: comments.length, comments }
    // 使用 XML 文件名作为 episodeId 缓存弹幕
    const cacheKey = parseInt(basename(xmlPath)) || Date.now()
    writeCachedComments(cacheKey, result)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: `XML 解析失败: ${String(err)}` }
  }
})

ipcMain.handle('danmaku:find-local-xml', async (_event, videoPath: string) => {
  // 兼容 Windows \ 和 Unix / 路径分隔符
  const lastSep = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  const dir = videoPath.substring(0, lastSep)
  const baseName = videoPath.substring(lastSep + 1).replace(/\.[^.]+$/, '')
  const candidates = [
    join(dir, `${baseName}.xml`),
    join(dir, `${baseName}.cmt.xml`),
    join(dir, `${baseName}.danmaku.xml`)
  ]

  for (const xmlPath of candidates) {
    if (existsSync(xmlPath)) {
      try {
        const xml = readFileSync(xmlPath, 'utf-8')
        const comments = parseBilibiliXml(xml)
        return { success: true, data: { count: comments.length, comments, source: xmlPath } }
      } catch (err) {
        return { success: false, error: `XML 解析失败: ${String(err)}` }
      }
    }
  }

  return { success: false, error: '未找到本地弹幕 XML 文件' }
})

function nodeFetch(url: string, options?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json<T>(): Promise<T> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const timeout = options?.timeoutMs ?? 15000
    const req = mod.get(parsed, { headers: options?.headers, timeout }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const body = buffer.toString('utf-8')
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode!,
          headers: { get(name: string): string | null { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : (v ?? null) } },
          text: async () => body,
          json: async () => JSON.parse(body)
        })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeout}ms`))
    })
    req.on('error', reject)
  })
}

async function readResponseBody(response: { text(): Promise<string> }): Promise<string> {
  return response.text()
}

async function dandanRequest<T>(path: string, retries = 2): Promise<T> {
  let lastError: Error | null = null
  const config = getDanmakuApiConfig()
  const allUrls = [config.primary, ...config.mirrors]

  console.log(`[danmaku] Using primary=${config.primary}, mirrors=${config.mirrors.join(',')}`)

  for (const baseUrl of allUrls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[danmaku] 重试 ${baseUrl} (第${attempt}次)`)
          await new Promise(r => setTimeout(r, 500 * attempt))
        }
        const url = `${baseUrl}${path}`
        console.log(`[danmaku] GET ${url}`)

        const authHeaders: Record<string, string> = config.appId && config.appSecret
          ? generateDandanHeaders(path, config.appId, config.appSecret)
          : {}

        const response = await nodeFetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'mplay/1.0 (Electron)',
            ...authHeaders
          },
          timeoutMs: 10000
        })

        console.log(`[danmaku] ${baseUrl} → HTTP ${response.status}, content-type=${response.headers.get('content-type')}`)

        if (!response.ok) {
          const bodyText = await readResponseBody(response).catch(() => '')
          const detail = bodyText.slice(0, 500) || '(empty body)'
          const msg = `DandanPlay ${baseUrl} 返回 HTTP ${response.status}: ${detail}`
          console.error(`[danmaku] ${msg}`)
          lastError = new Error(msg)
          continue
        }

        const contentType = response.headers.get('content-type') || ''
        const bodyText = await readResponseBody(response)

        if (!contentType.includes('application/json')) {
          const msg = `DandanPlay ${baseUrl} 返回非 JSON (Content-Type: ${contentType}): ${bodyText.slice(0, 500)}`
          console.error(`[danmaku] ${msg}`)
          lastError = new Error(msg)
          continue
        }

        const data = JSON.parse(bodyText) as T
        console.log(`[danmaku] ${baseUrl} 响应: ${bodyText.slice(0, 400)}`)
        return data
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const isRetryable = errMsg.includes('socket hang up') || errMsg.includes('timeout') || errMsg.includes('ECONNRESET')
        if (isRetryable && attempt < retries) {
          console.warn(`[danmaku] ${baseUrl} 可重试错误 (${errMsg})，准备重试...`)
          continue
        }
        if (err instanceof SyntaxError) {
          lastError = new Error(`DandanPlay JSON 解析失败: ${String(err)}`)
        } else {
          lastError = err instanceof Error ? err : new Error(String(err))
        }
        console.error(`[danmaku] ${baseUrl} 错误:`, lastError.message)
        break // 跳出重试循环，尝试下一个 URL
      }
    }
  }

  throw lastError || new Error('DandanPlay 所有 API 镜像均不可用')
}


// ==================== 弹幕 API（Bilibili 回退） ====================

interface BilibiliEpisode {
  aid: number
  cid: number
  title: string
  long_title: string
}

// B站搜索结果内存缓存（标题 → 匹配结果，最多 200 条）
const bilibiliMatchCache = new Map<string, { cid: number; animeTitle: string; episodeTitle: string; seasonId: number } | null>()
const BILIBILI_CACHE_MAX = 200

async function bilibiliAutoMatch(title: string): Promise<{
  cid: number
  animeTitle: string
  episodeTitle: string
  seasonId: number
} | null> {
  // 检查缓存
  if (bilibiliMatchCache.has(title)) {
    console.log(`[bilibili] 命中缓存: "${title}"`)
    return bilibiliMatchCache.get(title) ?? null
  }

  // Step 1: Clean title and extract episode number
  const cleanTitle = title
    .replace(/\.[^.]+$/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/【.*?】/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\d{4}[./-]\d{2}[./-]\d{2}/g, '')
    .replace(/1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL/gi, '')
    .replace(/x264|x265|H264|HEVC|AVC|AAC|FLAC/gi, '')
    .trim()

  // Extract episode number
  let epNum = -1
  const epMatch = cleanTitle.match(/EP?\s*(\d{1,3})/i)
    || cleanTitle.match(/第\s*(\d{1,3})\s*[话集]/)
    || cleanTitle.match(/S\d+E(\d{1,3})/i)
  if (epMatch) epNum = parseInt(epMatch[1])

  // Get search keyword: remove episode markers
  let searchKey = cleanTitle.replace(/E?P?\s*\d{1,3}/gi, '').trim()
  if (!searchKey) searchKey = title

  // Step 2: Search B站
  console.log(`Bilibili search: ${searchKey}`)
  const searchResp = await nodeFetch(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(searchKey)}`,
    {
      headers: {
        'User-Agent': 'mplay/1.0',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json'
      }
    }
  )
  if (!searchResp.ok) {
    console.error(`Bilibili search HTTP ${searchResp.status}`)
    bilibiliMatchCache.set(title, null)
    return null
  }

  const searchData = await searchResp.json() as { code: number; data: { result: Array<{ season_id: number; title: string }> } }
  if (searchData.code !== 0 || !searchData.data?.result?.length) {
    console.error('Bilibili search: no results')
    bilibiliMatchCache.set(title, null)
    return null
  }

  const firstResult = searchData.data.result[0]
  const seasonId = firstResult.season_id

  // Step 3: Get episode list
  const epResp = await nodeFetch(
    `https://api.bilibili.com/pgc/web/season/section?season_id=${seasonId}`,
    {
      headers: {
        'User-Agent': 'mplay/1.0',
        'Referer': 'https://www.bilibili.com/'
      }
    }
  )
  if (!epResp.ok) {
    console.error(`Bilibili episodes HTTP ${epResp.status}`)
    bilibiliMatchCache.set(title, null)
    return null
  }

  const epData = await epResp.json() as { code: number; result: { main_section: { episodes: BilibiliEpisode[] } } }
  if (epData.code !== 0 || !epData.result?.main_section?.episodes?.length) {
    console.error('Bilibili episodes: empty')
    bilibiliMatchCache.set(title, null)
    return null
  }

  const episodes = epData.result.main_section.episodes

  // Step 4: Match episode by number
  let matchedEp: BilibiliEpisode
  if (epNum > 0 && epNum <= episodes.length) {
    matchedEp = episodes[epNum - 1]
  } else {
    matchedEp = episodes[0]
  }

  const result = {
    cid: matchedEp.cid,
    animeTitle: firstResult.title.replace(/<[^>]*>/g, ''),
    episodeTitle: matchedEp.long_title || matchedEp.title,
    seasonId
  }

  // 写入缓存
  if (bilibiliMatchCache.size >= BILIBILI_CACHE_MAX) {
    const firstKey = bilibiliMatchCache.keys().next().value
    if (firstKey) bilibiliMatchCache.delete(firstKey)
  }
  bilibiliMatchCache.set(title, result)

  return result
}

ipcMain.handle('danmaku:bilibili-match', async (_event, title: string) => {
  try {
    const result = await bilibiliAutoMatch(title)
    if (result) {
      return {
        success: true,
        data: {
          episodeId: result.cid,
          animeTitle: result.animeTitle,
          episodeTitle: result.episodeTitle,
          seasonId: result.seasonId,
          source: 'bilibili'
        }
      }
    }
    return { success: false, error: 'B站未找到匹配番剧' }
  } catch (err) {
    console.error('bilibili match failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('danmaku:bilibili-comments', async (_event, cid: number) => {
  try {
    // 先查缓存
    const cached = getCachedComments(cid)
    if (cached) {
      console.log(`[danmaku:bilibili] 命中缓存 cid=${cid}`)
      return { success: true, data: cached }
    }

    const response = await nodeFetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: {
        'User-Agent': 'mplay/1.0',
        'Referer': 'https://www.bilibili.com/'
      }
    })
    if (!response.ok) {
      return { success: false, error: `B站弹幕 HTTP ${response.status}` }
    }
    const xml = await readResponseBody(response)
    const comments = parseBilibiliXml(xml)
    return { success: true, data: { count: comments.length, comments } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// ==================== 弹幕搜索 ====================

ipcMain.handle('danmaku:search', async (_event, keyword: string) => {
  try {
    const result = await dandanRequest<DanmakuSearchResponse>(
      `/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`
    )
    return { success: true, data: result }
  } catch (err) {
    console.error('danmaku:search failed:', err)
    return { success: false, error: String(err) }
  }
})

function extractEpisodeInfo(title: string): { animeKeyword: string; epNum: string } {
  const clean = title
    .replace(/\.[^.]+$/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/【.*?】/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\d{4}[./-]\d{2}[./-]\d{2}/g, '')
    .replace(/1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL/gi, '')
    .replace(/x264|x265|H264|HEVC|AVC|AAC|FLAC|AUTO/gi, '')
    .trim()

  let epNum = ''
  const epMatch = clean.match(/E(?:P(?:isode)?)?\s*(\d{1,3})/i)
    || clean.match(/第\s*(\d{1,3})\s*[话集]/)
    || clean.match(/S\d+E(\d{1,3})/i)
    || clean.match(/\s(\d{1,3})\s*[话集]?$/)
    || clean.match(/^(.+?)(\d{1,3})$/);
  if (epMatch) {
    epNum = epMatch[epMatch.length === 3 ? 2 : 1].padStart(2, '0')
  }

  let animeKeyword = clean
    .replace(/E(?:P(?:isode)?)?\s*\d{1,3}/gi, '')
    .replace(/第\s*\d{1,3}\s*[话集]/g, '')
    .replace(/S\d+E\d{1,3}/gi, '')
    .replace(/\s(\d{1,3})\s*[话集]?$/, '')
    .replace(/^(.+?)(\d{1,3})$/, '$1')
    .trim()

  if (!animeKeyword) {
    animeKeyword = title
      .replace(/\.[^.]+$/, '')
      .replace(/\[.*?\]/g, '')
      .trim()
  }

  return { animeKeyword, epNum }
}

ipcMain.handle('danmaku:match', async (_event, title: string) => {
  console.log(`[danmaku:match] 原始标题: "${title}"`)

  try {
    const cached = getCachedMatch(title)
    if (cached) {
      console.log(`[danmaku:match] 命中缓存 episodeId=${cached.episodeId}`)
      return {
        success: true,
        data: {
          episodeId: cached.episodeId,
          animeTitle: cached.animeTitle,
          episodeTitle: cached.episodeTitle,
          animeId: cached.animeId,
          seasonId: cached.seasonId,
          source: cached.source
        }
      }
    }

    const { animeKeyword, epNum } = extractEpisodeInfo(title)
    console.log(`[danmaku:match] 关键词: "${animeKeyword}", 集号: "${epNum || '无'}"`)

    const searchResult = await dandanRequest<DanmakuSearchResponse>(
      `/api/v2/search/episodes?anime=${encodeURIComponent(animeKeyword)}`
    )

    const animes = searchResult.animes || []
    if (animes.length === 0) {
      console.log('[danmaku:match] 未找到动漫，回退 B站')
      const blResult = await bilibiliAutoMatch(title)
      if (blResult) {
        writeCachedMatch(title, {
          episodeId: blResult.cid,
          animeTitle: blResult.animeTitle,
          episodeTitle: blResult.episodeTitle,
          seasonId: blResult.seasonId,
          source: 'bilibili',
          cachedAt: Date.now()
        })
        return {
          success: true,
          data: {
            episodeId: blResult.cid,
            animeTitle: blResult.animeTitle,
            episodeTitle: blResult.episodeTitle,
            seasonId: blResult.seasonId,
            source: 'bilibili'
          }
        }
      }
      return { success: false, error: '未找到匹配弹幕' }
    }

    const firstAnime = animes[0]
    const episodes = firstAnime.episodes || []
    console.log(`[danmaku:match] 匹配动漫: ${firstAnime.animeTitle} (${episodes.length} 集)`)

    let matchedEp = episodes[0]
    if (epNum && episodes.length > 0) {
      const epIndex = parseInt(epNum) - 1
      if (epIndex >= 0 && epIndex < episodes.length) {
        matchedEp = episodes[epIndex]
        console.log(`[danmaku:match] 集号匹配: #${epNum} → ${matchedEp.episodeTitle}`)
      } else {
        console.log(`[danmaku:match] 集号 #${epNum} 超出范围 (1-${episodes.length})，使用第1集`)
      }
    }

    if (matchedEp) {
      writeCachedMatch(title, {
        episodeId: matchedEp.episodeId,
        animeTitle: matchedEp.animeTitle,
        episodeTitle: matchedEp.episodeTitle,
        animeId: matchedEp.animeId,
        source: 'dandanplay',
        cachedAt: Date.now()
      })
      return {
        success: true,
        data: {
          episodeId: matchedEp.episodeId,
          animeTitle: matchedEp.animeTitle,
          episodeTitle: matchedEp.episodeTitle,
          animeId: matchedEp.animeId,
          source: 'dandanplay'
        }
      }
    }

    return { success: false, error: '未找到匹配弹幕' }
  } catch (err) {
    console.error('[danmaku:match] 致命错误:', err)
    return { success: false, error: String(err) }
  }
})

// ==================== 弹幕缓存系统 ====================

function getDanmakuCacheDir(): string {
  const dir = join(app.getPath('userData'), 'danmaku_cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getMatchCacheDir(): string {
  const dir = join(app.getPath('userData'), 'danmaku_match_cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

interface MatchCacheEntry {
  episodeId: number
  animeTitle?: string
  animeId?: number
  source?: string
  episodeTitle?: string
  seasonId?: number
  cachedAt: number
}

function getCachedMatch(title: string): MatchCacheEntry | null {
  try {
    const cacheDir = getMatchCacheDir()
    const cacheKey = title.toLowerCase().trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
    const cacheFile = join(cacheDir, `${cacheKey}.json`)
    if (!existsSync(cacheFile)) return null
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8')) as MatchCacheEntry
    if (!data || !data.episodeId) return null
    const age = Date.now() - data.cachedAt
    if (age > 7 * 24 * 60 * 60 * 1000) return null
    return data
  } catch {
    return null
  }
}

function writeCachedMatch(title: string, data: MatchCacheEntry): void {
  try {
    const cacheDir = getMatchCacheDir()
    const cacheKey = title.toLowerCase().trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
    const cacheFile = join(cacheDir, `${cacheKey}.json`)
    writeFileSync(cacheFile, JSON.stringify({ ...data, cachedAt: Date.now() }), 'utf-8')
  } catch (err) {
    console.warn(`[danmaku:match-cache] 写入缓存失败 title="${title}":`, err)
  }
}

function getCachedComments(episodeId: number): DanmakuCommentsResponse | null {
  try {
    const cacheDir = getDanmakuCacheDir()
    const cacheFile = join(cacheDir, `${episodeId}.json`)
    if (!existsSync(cacheFile)) return null
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    if (!data || !data.comments) return null
    return { count: data.count, comments: data.comments }
  } catch {
    return null
  }
}

function writeCachedComments(episodeId: number, data: DanmakuCommentsResponse): void {
  try {
    const cacheDir = getDanmakuCacheDir()
    const cacheFile = join(cacheDir, `${episodeId}.json`)
    const payload = { count: data.count, comments: data.comments, cachedAt: Date.now() }
    writeFileSync(cacheFile, JSON.stringify(payload), 'utf-8')
  } catch (err) {
    console.warn(`[danmaku:cache] 写入缓存失败 episodeId=${episodeId}:`, err)
  }
}

ipcMain.handle('danmaku:get-comments', async (_event, episodeId: string, source?: string) => {
  // B站弹幕
  if (source === 'bilibili') {
    const cid = parseInt(episodeId)
    try {
      // B站弹幕先查缓存
      const cached = getCachedComments(cid)
      if (cached) {
        return { success: true, data: cached }
      }
      const response = await nodeFetch(`https://comment.bilibili.com/${cid}.xml`, {
        headers: {
          'User-Agent': 'mplay/1.0',
          'Referer': 'https://www.bilibili.com/'
        }
      })
      if (!response.ok) {
        return { success: false, error: `B站弹幕 HTTP ${response.status}` }
      }
      const xml = await readResponseBody(response)
      const comments = parseBilibiliXml(xml)
      const result = { count: comments.length, comments }
      writeCachedComments(cid, result)
      return { success: true, data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[danmaku:bilibili-comments] 获取弹幕失败 cid=${cid}:`, msg)
      return { success: false, error: `B 站弹幕获取失败：${msg}` }
    }
  }

  // DandanPlay（默认）
  try {
    const eid = parseInt(episodeId)
    // 先查缓存
    const cached = getCachedComments(eid)
    if (cached) {
      console.log(`[danmaku:cache] 命中缓存 episodeId=${eid}`)
      return { success: true, data: cached }
    }
    const result = await dandanRequest<{ count: number; comments: DanmakuCommentRaw[] }>(
      `/api/v2/comment/${episodeId}?withRelated=true`
    )
    // 解析 p 字段为结构化数据
    const parsed = (result.comments || []).map((c: DanmakuCommentRaw) => {
      const parts = c.p.split(',')
      return {
        time: parseFloat(parts[0]) || 0,      // 秒
        mode: parseInt(parts[1]) || 1,          // 1=滚动 4=底部 5=顶部
        color: parseInt(parts[2]) || 0xFFFFFF,   // 十进制颜色值
        text: c.m
      }
    })
    const finalResult = { count: result.count, comments: parsed as DanmakuComment[] }
    writeCachedComments(eid, finalResult)
    return { success: true, data: finalResult }
  } catch (err) {
    console.error('danmaku:get-comments failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('danmaku:get-segment-comments', async (_event, params: { episodeId: string; from: number; to: number }) => {
  // 复用 get-comments handler 的逻辑
  const episodeId = params.episodeId
  const eid = parseInt(episodeId)
  const cached = getCachedComments(eid)
  if (cached) {
    return { success: true, data: cached }
  }
  try {
    const result = await dandanRequest<{ count: number; comments: DanmakuCommentRaw[] }>(
      `/api/v2/comment/${episodeId}?withRelated=true`
    )
    const parsed = (result.comments || []).map((c: DanmakuCommentRaw) => {
      const parts = c.p.split(',')
      return {
        time: parseFloat(parts[0]) || 0,
        mode: parseInt(parts[1]) || 1,
        color: parseInt(parts[2]) || 0xFFFFFF,
        text: c.m
      }
    })
    const finalResult = { count: result.count, comments: parsed as DanmakuComment[] }
    writeCachedComments(eid, finalResult)
    return { success: true, data: finalResult }
  } catch (err) {
    console.error('danmaku:get-segment-comments failed:', err)
    return { success: false, error: String(err) }
  }
})

// ==================== 弹幕预下载 ====================

interface BangumiEpisode {
  episodeId: number
  animeId: number
  episodeTitle: string
}

ipcMain.handle('danmaku:prefetch-series', async (_event, animeId: number) => {
  console.log(`[danmaku:prefetch] 开始预下载 animeId=${animeId}`)
  try {
    // 获取全季剧集列表
    const bangumiResult = await dandanRequest<{ bangumi?: { episodes?: BangumiEpisode[] } }>(
      `/api/v2/bangumi/${animeId}`
    )
    const episodes = bangumiResult.bangumi?.episodes || []
    console.log(`[danmaku:prefetch] animeId=${animeId} 共 ${episodes.length} 集`)

    let cachedCount = 0
    let fetchedCount = 0
    for (const ep of episodes) {
      // 检查缓存中是否已有
      if (getCachedComments(ep.episodeId)) {
        cachedCount++
        continue
      }
      try {
        const result = await dandanRequest<{ count: number; comments: DanmakuCommentRaw[] }>(
          `/api/v2/comment/${ep.episodeId}?withRelated=true`
        )
        const parsed = (result.comments || []).map((c: DanmakuCommentRaw) => {
          const parts = c.p.split(',')
          return {
            time: parseFloat(parts[0]) || 0,
            mode: parseInt(parts[1]) || 1,
            color: parseInt(parts[2]) || 0xFFFFFF,
            text: c.m
          }
        })
        writeCachedComments(ep.episodeId, { count: result.count, comments: parsed as DanmakuComment[] })
        fetchedCount++
      } catch (err) {
        console.warn(`[danmaku:prefetch] 下载失败 ep=${ep.episodeId}:`, err)
      }
    }
    console.log(`[danmaku:prefetch] animeId=${animeId} 完成: 缓存命中 ${cachedCount}, 新下载 ${fetchedCount}`)
    return { success: true, data: { cached: cachedCount, fetched: fetchedCount, total: episodes.length } }
  } catch (err) {
    console.error('[danmaku:prefetch] 失败:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('danmaku:get-cached-comments', async (_event, episodeId: string) => {
  const eid = parseInt(episodeId)
  const cached = getCachedComments(eid)
  if (cached) {
    return { success: true, data: cached }
  }
  return { success: false, error: '缓存未命中' }
})

// ==================== 文件操作 ====================

// ==================== 自定义协议: douban-img (豆瓣图片反盗链) ====================

const DOUBAN_IMG_CACHE = new Map<string, { buffer: Buffer; mime: string }>()

function registerDoubanImageProtocol(): void {
  protocol.handle('douban-img', (request) => {
    const url = decodeURIComponent(request.url.replace('douban-img://', ''))
    
    return new Promise((resolve) => {
      const cached = DOUBAN_IMG_CACHE.get(url)
      if (cached) {
        resolve(new Response(Buffer.from(cached.buffer), {
          status: 200,
          headers: { 'content-type': cached.mime, 'cache-control': 'max-age=86400' }
        }))
        return
      }
      
      fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://movie.douban.com/'
        },
        signal: AbortSignal.timeout(10000)
      })
      .then(async (res) => {
        if (!res.ok) throw new Error('fetch failed')
        const buffer = Buffer.from(await res.arrayBuffer())
        const mime = res.headers.get('content-type') || 'image/jpeg'
        DOUBAN_IMG_CACHE.set(url, { buffer, mime })
        resolve(new Response(buffer, {
          status: 200,
          headers: { 'content-type': mime, 'cache-control': 'max-age=86400' }
        }))
      })
      .catch(() => {
        resolve(new Response('Image not found', { status: 404 }))
      })
    })
  })
}


// ==================== 自定义协议: jellyfin-image ====================


function registerJellyfinImageProtocol(): void {
  protocol.handle('jellyfin-image', (request) => {
    // 将 jellyfin-image://host:port/path 转换为 http://host:port/path
    const realUrl = request.url.replace('jellyfin-image://', 'http://')
    return net.fetch(realUrl, {
      signal: AbortSignal.timeout(15000),
      bypassCustomProtocolHandlers: true
    })
  })
}


// ==================== 自定义协议: local-file ====================


const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.ts': 'video/mp2t',
  '.rmvb': 'application/vnd.rn-realmedia'
}

function registerLocalFileProtocol(): void {
  protocol.handle('local-file', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && url.hostname && /^[a-zA-Z]$/.test(url.hostname)) {
      filePath = `${url.hostname.toUpperCase()}:${filePath}`
    } else if (process.platform === 'win32' && filePath.length > 1 && filePath[0] === '/') {
      filePath = filePath.slice(1)
    }
    const ext = require('path').extname(filePath.toLowerCase()).toLowerCase()
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'

    return new Promise((resolve) => {
      try {
        const { existsSync, createReadStream } = require('fs')
        if (!existsSync(filePath)) {
          resolve(new Response('File not found', { status: 404 }))
          return
        }
        const stream = createReadStream(filePath)
        const responseStream = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk: unknown) => controller.enqueue(chunk))
            stream.on('end', () => controller.close())
            stream.on('error', (err: unknown) => controller.error(err))
          },
          cancel() {
            stream.destroy()
          }
        })
        resolve(
          new Response(responseStream, {
            status: 200,
            headers: {
              'content-type': mimeType,
              'accept-ranges': 'bytes'
            }
          })
        )
      } catch (err) {
        resolve(new Response('File not found', { status: 404 }))
      }
    })
  })
}

// ==================== 窗口管理 ====================

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: getResourcePath('build/icon.png'),
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const levelMap: Record<number, LogEntry['level']> = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' }
    addLog(levelMap[level] || 'info', 'renderer', message)
  })

  // 捕获渲染进程崩溃
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Render process gone:', details.reason, details.exitCode)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const iconPath = getResourcePath('build/icon-32.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    // fallback to 256px and resize
    icon = nativeImage.createFromPath(getResourcePath('build/icon.png'))
    icon = icon.resize({ width: 32, height: 32 })
  }
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: '日志窗口',
      click: () => toggleLogWindow()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setToolTip('mplay')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ==================== 应用生命周期 ====================

// 注册自定义协议为 privileged，使渲染进程的 <img> 标签可以加载
protocol.registerSchemesAsPrivileged([
  { scheme: 'jellyfin-image', privileges: { bypassCSP: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.mplay.player')

  // 注册自定义协议
  registerJellyfinImageProtocol()
  registerLocalFileProtocol()
  registerDoubanImageProtocol()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  Menu.setApplicationMenu(null)

  createWindow()
  createTray()

  // 启动时自动连接上次活跃的服务器
  const activeId = getActiveServerId()
  if (activeId) {
    connectToServer(activeId).catch(err => {
      console.warn('[server] 启动时自动连接失败:', err)
    })
  }

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    toggleLogWindow()
  })

  // F12 打开 DevTools（开发/调试用）
  globalShortcut.register('F12', () => {
    if (mainWindow) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools()
      }
    }
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 全局异常捕获，写入日志文件
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})













