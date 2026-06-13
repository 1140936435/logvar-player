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
import { join, extname, dirname } from 'path'
import { platform } from 'os'
import { readdirSync, createReadStream, readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

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
    title: '慢播 - 日志',
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

async function jellyfinRequest<T>(
  auth: JellyfinAuth,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
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
    return (await response.json()) as T
  }
  return (await response.text()) as unknown as T
}

// ==================== IPC: Jellyfin ====================

let jellyfinAuth: JellyfinAuth | null = null

ipcMain.handle('jellyfin:connect', async (_event, url: string, token: string) => {
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
    // 第1步：获取 item 详情，提取真实 MediaSourceId
    const item = await jellyfinRequest<{
      MediaSources?: { Id: string; Name?: string; Container?: string }[]
    }>(jellyfinAuth, `/Users/${jellyfinAuth.userId}/Items/${itemId}`)

    const mediaSources = item?.MediaSources
    if (!mediaSources || mediaSources.length === 0) {
      console.warn(`No MediaSources for item ${itemId}, trying itemId as fallback`)
      // fallback: 某些情况下 itemId 就是 MediaSourceId
      const baseUrl = normalizeUrl(jellyfinAuth.url)
      const url = `${baseUrl}/Videos/${itemId}/stream?Static=true&api_key=${jellyfinAuth.token}`
      console.log(`get-playback-url (fallback): ${url}`)
      return { success: true, data: { url } }
    }

    const mediaSourceId = mediaSources[0].Id
    const container = mediaSources[0].Container || ''
    console.log(`get-playback-url: mediaSourceId=${mediaSourceId}, container=${container}, itemId=${itemId}`)

    const baseUrl = normalizeUrl(jellyfinAuth.url)
    const url = `${baseUrl}/Videos/${itemId}/stream?Static=true&MediaSourceId=${mediaSourceId}&api_key=${jellyfinAuth.token}`
    console.log(`get-playback-url (final): ${url}`)
    return { success: true, data: { url } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`jellyfin:get-playback-url failed:`, msg)
    return { success: false, error: `获取播放地址失败: ${msg}` }
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

// ==================== IPC: Store ====================

let configPath = ''
let configData: Record<string, unknown> = {}

// ==================== 敏感数据加密（safeStorage） ====================

/** 需要加密存储的 key 列表 */
const ENCRYPTED_KEYS = new Set([
  'jellyfin.token',
  'jellyfin.url',
  'danmaku:api-primary',
  'danmaku:api-mirrors',
])

/** 日志脱敏：移除可能的 token/密钥 */
function sanitizeLog(msg: string): string {
  return msg
    .replace(/api_key=[^&\s"']+/gi, 'api_key=***')
    .replace(/token["']?\s*[=:]\s*["']?[A-Za-z0-9_\-\.]+/gi, 'token=***')
}

function encryptValue(plain: string): string {
  // 临时禁用加密，确保应用能正常工作
  return plain
  // try {
  //   if (safeStorage.isEncryptionAvailable()) {
  //     const buf = safeStorage.encryptString(plain)
  //     return 'enc:' + buf.toString('base64')
  //   }
  // } catch { /* fallthrough */ }
  // return plain
}

function decryptValue(stored: string): string {
  // 临时禁用解密，确保应用能正常工作
  return stored
  // if (!stored.startsWith('enc:')) return stored
  // try {
  //   const buf = Buffer.from(stored.slice(4), 'base64')
  //   return safeStorage.decryptString(buf)
  // } catch {
  //   return stored
  // }
}

/** 递归加密 configData 中的敏感字段 */
function encryptConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const key of ENCRYPTED_KEYS) {
    const val = out[key]
    if (typeof val === 'string' && val && !val.startsWith('enc:')) {
      out[key] = encryptValue(val)
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === 'string' && v && !v.startsWith('enc:') ? encryptValue(v) : v)
    }
  }
  // 对象形式（如 jellyfin: { url, token }）
  if (out.jellyfin && typeof out.jellyfin === 'object') {
    const jf = { ...(out.jellyfin as Record<string, unknown>) }
    for (const k of ['token', 'url']) {
      if (typeof jf[k] === 'string' && jf[k] && !(jf[k] as string).startsWith('enc:')) {
        jf[k] = encryptValue(jf[k] as string)
      }
    }
    out.jellyfin = jf
  }
  return out
}

/** 递归解密 configData 中的敏感字段 */
function decryptConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const key of ENCRYPTED_KEYS) {
    const val = out[key]
    if (typeof val === 'string' && val.startsWith('enc:')) {
      out[key] = decryptValue(val)
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === 'string' && v.startsWith('enc:') ? decryptValue(v) : v)
    }
  }
  if (out.jellyfin && typeof out.jellyfin === 'object') {
    const jf = { ...(out.jellyfin as Record<string, unknown>) }
    for (const k of ['token', 'url']) {
      if (typeof jf[k] === 'string' && (jf[k] as string).startsWith('enc:')) {
        jf[k] = decryptValue(jf[k] as string)
      }
    }
    out.jellyfin = jf
  }
  return out
}

function loadConfigFile(): void {
  try {
    if (!configPath) {
      configPath = join(app.getPath('userData'), 'config.json')
    }
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      configData = decryptConfig(JSON.parse(raw))
    }
  } catch {
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

ipcMain.handle('store:get', async (_event, key: string) => {
  return configData[key] ?? null
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

// ==================== IPC: 弹幕 ====================

// ==================== 弹幕 API（DandanPlay） ====================

function getDanmakuApiConfig(): { primary: string; mirrors: string[] } {
  const storePrimary = configData['danmaku:api-primary'] as string | undefined
  const storeMirrors = configData['danmaku:api-mirrors'] as string[] | undefined

  return {
    primary: storePrimary || 'https://api.dandanplay.net',
    mirrors: storeMirrors || ['https://danmu.smilion.cn']
  }
}

ipcMain.handle('danmaku:get-config', async () => {
  return getDanmakuApiConfig()
})

ipcMain.handle('danmaku:set-config', async (_event, config: { primary?: string; mirrors?: string[] }) => {
  if (config.primary !== undefined) {
    configData['danmaku:api-primary'] = config.primary
  }
  if (config.mirrors !== undefined) {
    configData['danmaku:api-mirrors'] = config.mirrors
  }
  saveConfigFile()
  return true
})

ipcMain.handle('danmaku:test-api', async (_event, url: string) => {
  const startTime = Date.now()
  try {
    const response = await net.fetch(
      `${url}/api/v2/search/episodes?anime=${encodeURIComponent('测试')}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'LogVarPlayer/1.0 (Electron)'
        }
      }
    )
    const elapsed = Date.now() - startTime

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { success: false, error: `HTTP ${response.status}`, detail: bodyText.slice(0, 300), elapsed }
    }

    const contentType = response.headers.get('content-type') || ''
    const bodyText = await response.text()

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
    // 解析 <d p="time,mode,size,color,ts,pool,user,rowid">text</d>
    DANMAKU_XML_REGEX.lastIndex = 0
    const comments: Array<{ time: number; mode: number; color: number; text: string }> = []

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

    const result = { count: comments.length, comments }
    writeCachedComments(cid, result)
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
        DANMAKU_XML_REGEX.lastIndex = 0
        const comments: Array<{ time: number; mode: number; color: number; text: string }> = []
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
        return { success: true, data: { count: comments.length, comments, source: xmlPath } }
      } catch (err) {
        return { success: false, error: `XML 解析失败: ${String(err)}` }
      }
    }
  }

  return { success: false, error: '未找到本地弹幕 XML 文件' }
})

async function dandanRequest<T>(path: string): Promise<T> {
  let lastError: Error | null = null
  const config = getDanmakuApiConfig()
  const allUrls = [config.primary, ...config.mirrors]

  console.log(`[danmaku] Using primary=${config.primary}, mirrors=${config.mirrors.join(',')}`)

  for (const baseUrl of allUrls) {
    try {
      const url = `${baseUrl}${path}`
      console.log(`[danmaku] GET ${url}`)

      const response = await net.fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'LogVarPlayer/1.0 (Electron)'
        }
      })

      console.log(`[danmaku] ${baseUrl} → HTTP ${response.status}, content-type=${response.headers.get('content-type')}`)

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        const detail = bodyText.slice(0, 500) || '(empty body)'
        const msg = `DandanPlay ${baseUrl} 返回 HTTP ${response.status}: ${detail}`
        console.error(`[danmaku] ${msg}`)
        lastError = new Error(msg)
        continue
      }

      const contentType = response.headers.get('content-type') || ''
      const bodyText = await response.text()

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
      if (err instanceof SyntaxError) {
        lastError = new Error(`DandanPlay JSON 解析失败: ${String(err)}`)
      } else if (err instanceof Error && err.message.includes('fetch')) {
        lastError = new Error(`DandanPlay 网络请求失败: ${err.message}`)
      } else {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
      console.error(`[danmaku] ${baseUrl} 错误:`, lastError.message)
    }
  }

  throw lastError || new Error('DandanPlay 所有 API 镜像均不可用')
}

interface DanmakuMatchResult {
  animeId: number
  animeTitle: string
  episodeId: number
  episodeTitle: string
  type: string
  typeDescription: string
}

interface DanmakuSearchResponse {
  hasMore: boolean
  animes: Array<{ animeId: number; animeTitle: string; episodes: DanmakuMatchResult[] }>
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
  const searchResp = await net.fetch(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(searchKey)}`,
    {
      headers: {
        'User-Agent': 'LogVarPlayer/1.0',
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
  const epResp = await net.fetch(
    `https://api.bilibili.com/pgc/web/season/section?season_id=${seasonId}`,
    {
      headers: {
        'User-Agent': 'LogVarPlayer/1.0',
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

    const response = await net.fetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: {
        'User-Agent': 'LogVarPlayer/1.0',
        'Referer': 'https://www.bilibili.com/'
      }
    })
    if (!response.ok) {
      return { success: false, error: `B站弹幕 HTTP ${response.status}` }
    }
    const xml = await response.text()
    DANMAKU_XML_REGEX.lastIndex = 0
    const comments: Array<{ time: number; mode: number; color: number; text: string }> = []
    let match: RegExpExecArray | null
    while ((match = DANMAKU_XML_REGEX.exec(xml)) !== null) {
      const pStr = match[1]
      const text = match[2].trim()
      const parts = pStr.split(',')
      const time = parseFloat(parts[0]) || 0
      const mode = parseInt(parts[1]) || 1
      const color = parseInt(parts[3]) || 0xFFFFFF
      if (text) comments.push({ time, mode, color, text })
    }
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

ipcMain.handle('danmaku:match', async (_event, title: string) => {
  console.log(`[danmaku:match] 原始标题: "${title}"`)

  try {
    // 策略 0: 先尝试直接使用原始标题搜索（与手动搜索相同）
    try {
      const result = await dandanRequest<DanmakuSearchResponse>(
        `/api/v2/search/episodes?anime=${encodeURIComponent(title)}`
      )
      const animeCount = result.animes?.length || 0
      const firstAnime = result.animes?.[0]
      const firstEp = firstAnime?.episodes?.[0]
      console.log(`[danmaku:match] 策略0(原始标题) 返回: ${animeCount} 部动漫, firstEp=${firstEp?.episodeTitle || 'null'}`)

      if (firstEp) {
        return {
          success: true,
          data: {
            episodeId: firstEp.episodeId,
            animeTitle: firstEp.animeTitle,
            episodeTitle: firstEp.episodeTitle,
            animeId: firstEp.animeId,
            source: 'dandanplay'
          }
        }
      }
    } catch (err0) {
      console.log('[danmaku:match] 策略0失败:', err0)
    }

    // 清理标题：去掉文件扩展名、分辨率标签、压制组等
    const clean = title
      .replace(/\.[^.]+$/, '')                 // 去扩展名
      .replace(/\[.*?\]/g, '')                  // 去方括号标签
      .replace(/【.*?】/g, '')                  // 去中文方括号
      .replace(/\(.*?\)/g, '')                  // 去圆括号
      .replace(/\d{4}[./-]\d{2}[./-]\d{2}/g, '') // 去日期
      .replace(/1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL/gi, '')
      .replace(/x264|x265|H264|HEVC|AVC|AAC|FLAC/gi, '')
      .trim()

    console.log(`[danmaku:match] 清洗后标题: "${clean}"`)

    // 尝试提取集数关键词：EP01, 第01话, S01E01, 第1集
    let epNum = ''
    const epMatch = clean.match(/EP?\s*(\d{1,3})/i)
      || clean.match(/第\s*(\d{1,3})\s*[话集]/)
      || clean.match(/S\d+E(\d{1,3})/i)
    if (epMatch) {
      epNum = epMatch[1].padStart(2, '0')
      console.log(`[danmaku:match] 提取集数: "${epNum}"`)
    } else {
      console.log(`[danmaku:match] 未提取到集数`)
    }

    // 构建搜索关键词：剧名 + 集数
    let searchKey = clean.replace(/E?P?\s*\d{1,3}/i, '').trim()
    if (!searchKey) searchKey = title
    if (epNum) searchKey = `${searchKey} 第${epNum}话`
    console.log(`[danmaku:match] 搜索关键词: "${searchKey}"`)

    // ===== 策略 A: 直接搜索剧集 =====
    try {
      const result = await dandanRequest<DanmakuSearchResponse>(
        `/api/v2/search/episodes?anime=${encodeURIComponent(searchKey)}`
      )

      const animeCount = result.animes?.length || 0
      const firstAnime = result.animes?.[0]
      const firstEp = firstAnime?.episodes?.[0]
      console.log(`[danmaku:match] search/episodes 返回: ${animeCount} 部动漫, firstEp=${firstEp?.episodeTitle || 'null'}`)

      if (firstEp) {
        return {
          success: true,
          data: {
            episodeId: firstEp.episodeId,
            animeTitle: firstEp.animeTitle,
            episodeTitle: firstEp.episodeTitle,
            animeId: firstEp.animeId,
            source: 'dandanplay'
          }
        }
      }

      // DandanPlay 返回空结果
      console.log('[danmaku:match] search/episodes 返回空，尝试 search/anime')
    } catch (ddErr) {
      console.log('[danmaku:match] search/episodes 失败，尝试 search/anime:', ddErr)
    }

    // ===== 策略 B: 先通过 search/anime 找动漫，再查剧集 =====
    try {
      const animeKeyword = clean.replace(/E?P?\s*\d{1,3}/i, '').replace(/第\s*\d{1,3}\s*[话集]/, '').trim()
      console.log(`[danmaku:match] search/anime 关键词: "${animeKeyword}"`)

      interface AnimeSearchResult {
        animes?: Array<{ animeId: number; animeTitle: string; episodeCount?: number }>
      }

      const animeResult = await dandanRequest<AnimeSearchResult>(
        `/api/v2/search/anime?keyword=${encodeURIComponent(animeKeyword)}`
      )

      const animes = animeResult.animes || []
      console.log(`[danmaku:match] search/anime 返回: ${animes.length} 部动漫`)

      if (animes.length > 0) {
        const animeId = animes[0].animeId
        const animeTitle = animes[0].animeTitle
        console.log(`[danmaku:match] 选中动漫: ${animeTitle} (id=${animeId})`)

        // 用 animeId 搜索剧集
        const epResult = await dandanRequest<DanmakuSearchResponse>(
          `/api/v2/search/episodes?anime=${encodeURIComponent(animeTitle)}`
        )

        const epAnime = epResult.animes?.[0]
        const episodes = epAnime?.episodes || []
        console.log(`[danmaku:match] search/episodes(按动漫) 返回: ${episodes.length} 集`)

        // 按集数匹配
        let matchedEp = episodes[0]
        if (epNum && episodes.length > 0) {
          const epIndex = parseInt(epNum) - 1
          if (epIndex >= 0 && epIndex < episodes.length) {
            matchedEp = episodes[epIndex]
            console.log(`[danmaku:match] 按集数匹配: #${epNum} → ${matchedEp.episodeTitle}`)
          } else {
            console.log(`[danmaku:match] 集数 #${epNum} 超出范围(1-${episodes.length}), 使用第1集`)
          }
        }

        if (matchedEp) {
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
      }

      console.log('[danmaku:match] search/anime 也未找到，回退 B站')
    } catch (animeErr) {
      console.log('[danmaku:match] search/anime 失败，回退 B站:', animeErr)
    }

    // B站回退
    const blResult = await bilibiliAutoMatch(title)
    if (blResult) {
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
  } catch (err) {
    console.error('[danmaku:match] 致命错误:', err)
    return { success: false, error: String(err) }
  }
})

interface DanmakuComment {
  cid: number
  p: string  // "time,mode,color,timestamp"
  m: string  // 弹幕文本
}

interface DanmakuCommentsResponse {
  count: number
  comments: DanmakuComment[]
}

// ==================== 弹幕缓存系统 ====================

function getDanmakuCacheDir(): string {
  const dir = join(app.getPath('userData'), 'danmaku_cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
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
    try {
      const cid = parseInt(episodeId)
      // B站弹幕先查缓存
      const cached = getCachedComments(cid)
      if (cached) {
        return { success: true, data: cached }
      }
      const response = await net.fetch(`https://comment.bilibili.com/${cid}.xml`, {
        headers: {
          'User-Agent': 'LogVarPlayer/1.0',
          'Referer': 'https://www.bilibili.com/'
        }
      })
      if (!response.ok) {
        return { success: false, error: `B站弹幕 HTTP ${response.status}` }
      }
      const xml = await response.text()
      DANMAKU_XML_REGEX.lastIndex = 0
      const comments: Array<{ time: number; mode: number; color: number; text: string }> = []
      let match: RegExpExecArray | null
      while ((match = DANMAKU_XML_REGEX.exec(xml)) !== null) {
        const pStr = match[1]
        const text = match[2].trim()
        const parts = pStr.split(',')
        const time = parseFloat(parts[0]) || 0
        const mode = parseInt(parts[1]) || 1
        const color = parseInt(parts[3]) || 0xFFFFFF
        if (text) comments.push({ time, mode, color, text })
      }
      const result = { count: comments.length, comments }
      writeCachedComments(cid, result)
      return { success: true, data: result }
    } catch (err) {
      console.error('danmaku:bilibili get-comments failed:', err)
      return { success: false, error: String(err) }
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
    const result = await dandanRequest<DanmakuCommentsResponse>(
      `/api/v2/comment/${episodeId}?withRelated=true`
    )
    // 解析 p 字段为结构化数据
    const parsed = (result.comments || []).map((c) => {
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
    const result = await dandanRequest<DanmakuCommentsResponse>(
      `/api/v2/comment/${episodeId}?withRelated=true`
    )
    const parsed = (result.comments || []).map((c) => {
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
        const result = await dandanRequest<DanmakuCommentsResponse>(
          `/api/v2/comment/${ep.episodeId}?withRelated=true`
        )
        const parsed = (result.comments || []).map((c: DanmakuComment) => {
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
    // URL 格式: local-file:///C:/path/to/video.mp4
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    // Windows: 去掉开头的 /
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1)
    }
    const ext = extname(filePath).toLowerCase()
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'

    return new Promise((resolve) => {
      try {
        const stream = createReadStream(filePath)
        resolve(
          new Response(stream as unknown as ReadableStream, {
            status: 200,
            headers: {
              'content-type': mimeType,
              'accept-ranges': 'bytes'
            }
          })
        )
      } catch {
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
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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
  const icon = nativeImage.createEmpty()
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

  tray.setToolTip('慢播')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ==================== 应用生命周期 ====================

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.logvar.player')

  // 注册 local-file 协议
  registerLocalFileProtocol()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  Menu.setApplicationMenu(null)

  createWindow()
  createTray()

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
