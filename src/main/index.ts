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
  safeStorage,
  screen,
  session,
  type NativeImage
} from 'electron'
import * as crypto from 'crypto'
import { join, dirname, basename, resolve as pathResolve, sep as pathSep } from 'path'
import { pathToFileURL } from 'url'

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, renameSync, copyFileSync } from 'fs'
import { stat as fsStat, open as fsOpen, appendFile as fsAppendFile, type FileHandle } from 'fs/promises'
import type { DanmakuComment, DanmakuCommentRaw, DanmakuCommentsResponse, DanmakuSearchResponse, JellyfinServerInfo, ServerType, DanmakuMatchMeta, DanmakuMatchResultV2, DanmakuMatchCandidate, DanmakuBindEntry, DanmakuMatchLevel } from '../shared/types'
import * as http from 'http'
import * as https from 'https'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { posterCache } from './services/poster-cache'
import { MpvController } from './mpv-controller'
import {
  ENCRYPTED_KEYS,
  CREDENTIAL_NAMESPACES,
  isEncrypted,
  isCredentialKey,
  sanitizeEncryptedBlobs,
  stripSensitiveFields,
  deepMerge,
  isAllowedDoubanImageUrl,
  parseRangeHeader,
  maskSecret,
  resolveAppSecretInput,
  matchServerByUrlPrefix,
  isPlainObject
} from './lib/security'

// ==================== 清除代理环境变量（必须在任何子进程/原生库启动前） ====================
// mpv / libmpv（ffmpeg）会读取 http_proxy 等环境变量并把媒体流请求发给代理。
// 当系统开着代理软件（env 模式）时，Jellyfin/Tailscale（100.x.x.x）等内网地址会被代理劫持，
// 导致 mpv 打开网络流 "loading failed" → 播放黑屏（本地文件不受影响，难以排查）。
// 媒体服务器均在局域网/Tailscale，直连才是正确行为。
// Chromium 自身走 Windows 系统代理设置，不受 env 删除影响；Node 侧 http/fetch 也不会自动使用这些变量。
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[key]
}

// ==================== 并发请求控制 ====================

class ConcurrencyLimiter {
  private maxConcurrent: number;
  private queue: Array<() => void>;
  private running: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.queue = [];
    this.running = 0;
  }

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const imageFetchLimiter = new ConcurrencyLimiter(6);

// ==================== 资源路径工具 ====================

function getResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, relativePath)
  }
  return join(__dirname, '../../', relativePath)
}

// ==================== 统一图标资源入口 ====================
// 全局图标统一入口：所有图标（窗口/托盘/任务栏）均从 build/ 读取透明派生资源
// 开发环境：从项目根/build 读取透明派生资源
// 打包环境：extraResources 将透明派生资源复制到 resources/icon
// assets/icon 下的原图始终只读，不直接用于系统图标渲染。

/** 获取统一图标资源路径（开发/打包环境自适应） */
function getIconPath(name: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icon', name)
  }
  return join(__dirname, '../../', 'build', name)
}

/** 读取透明 PNG，不创建画布、不填充背景色。 */
function loadNativeIcon(name: string, size?: number): NativeImage {
  const icon = nativeImage.createFromPath(getIconPath(name))
  if (icon.isEmpty()) return icon
  return size ? icon.resize({ width: size, height: size, quality: 'best' }) : icon
}

/** 窗口图标：完整保留 PNG Alpha，适配高 DPI 任务栏。 */
function getWindowIcon(): NativeImage {
  return loadNativeIcon('icon-256.png')
}

/** 托盘图标：完整保留 PNG Alpha。 */
function getTrayIcon(): NativeImage {
  return loadNativeIcon('icon-32.png', 32)
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
    logWriteQueue.push(line)
    if (logWriteQueue.length > 2000) logWriteQueue.shift()
    scheduleLogFlush()
  } catch {}
}

// 异步日志写入：appendFileSync 会在每条日志时同步阻塞事件循环（mpv/图片抓取
// 高频日志场景下造成卡顿）。改为内存队列 + 串行 Promise 链异步落盘，保证顺序
// 且不阻塞；进程退出时由 flushLogQueueSync 兜底刷盘。
const logWriteQueue: string[] = []
let logFlushScheduled = false
let logWriteChain: Promise<void> = Promise.resolve()

function scheduleLogFlush(): void {
  if (logFlushScheduled) return
  logFlushScheduled = true
  queueMicrotask(() => {
    logFlushScheduled = false
    if (logWriteQueue.length === 0) return
    const pending = logWriteQueue.splice(0, logWriteQueue.length).join('')
    logWriteChain = logWriteChain
      .then(() => fsAppendFile(getLogFile(), pending, 'utf-8'))
      .catch(() => {})
  })
}

/** 同步兜底刷盘：进程退出等场景调用，避免异步队列中的日志丢失 */
function flushLogQueueSync(): void {
  if (logWriteQueue.length === 0) return
  try {
    appendFileSync(getLogFile(), logWriteQueue.splice(0, logWriteQueue.length).join(''), 'utf-8')
  } catch {}
}
app.on('will-quit', flushLogQueueSync)

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
    title: '环影 - 日志',
    backgroundColor: '#0d0d0d',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
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
  type: ServerType
}

function buildJellyfinHeaders(token: string, serverType: ServerType): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }
  const cleanToken = token.trim()
  if (cleanToken) {
    headers['X-Emby-Token'] = cleanToken
  }
  return headers
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
  const headers: Record<string, string> = { ...buildJellyfinHeaders(auth.token, auth.type) }
  const method = (options.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json'
  }
  Object.assign(headers, (options.headers as Record<string, string>) || {})

  console.log(`[jellyfinRequest] ${method} ${url}`)
  console.log(`[jellyfinRequest] serverType=${auth.type}, token_length=${auth.token.length}, userId=${auth.userId || '(empty)'}`)
  console.log(`[jellyfinRequest] headers=${JSON.stringify(headers)}`)

  const response = await fetch(url, {
    ...options,
    headers,
    // 合并调用方取消信号与默认超时：任何一方触发都会中断请求
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000)
  })

  console.log(`[jellyfinRequest] response status=${response.status}, statusText=${response.statusText}`)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[jellyfinRequest] ERROR ${response.status}: ${text || response.statusText}`)
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
  /** 服务器类型，旧配置无该字段时默认按 'jellyfin' 处理 */
  type?: ServerType
  /** Emby 专属：登录账号 */
  username?: string
  /** Emby 专属：加密保存的密码（密文） */
  password?: string
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

/** Renderer 可见的服务器公开信息：绝不包含 token/password 等凭据 */
interface PublicServerConfig {
  id: string
  name: string
  url: string
  type?: 'jellyfin' | 'emby'
  username?: string
  userId?: string
  hasToken: boolean
  hasPassword: boolean
}

function toPublicServer(s: JellyfinServerConfig): PublicServerConfig {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    type: s.type,
    username: s.username,
    userId: s.userId,
    hasToken: !!s.token,
    hasPassword: !!s.password
  }
}

/** 按 URL 匹配已配置服务器（实现见 ./lib/security.ts 的 matchServerByUrlPrefix）：
 * origin + basePath 最长前缀匹配，scheme 必须一致 —— 同 host 不同 basePath 不串 token，
 * https 配置的服务器不会被 http 请求命中（防降级） */
function findServerByUrlPrefix(url: string): { server: JellyfinServerConfig; prefix: string } | null {
  return matchServerByUrlPrefix(url, getServers())
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

/** 解析 Jellyfin 用户 ID：
 * 1) /Users/Me（普通 token 直接返回）
 * 2) API Key 模式 /Users/Me 返回 400 → 回退 /Users：
 *    - 已保存显式 userId（来自用户选择）→ 校验存在后使用
 *    - 单用户服务器 → 允许自动选择
 *    - 多用户 → 抛 MULTI_USER（附带用户列表），禁止静默取 users[0] */
class MultiUserError extends Error {
  users: Array<{ id: string; name?: string }>
  constructor(users: Array<{ id: string; name?: string }>) {
    super('该服务器有多个用户，请选择要使用的用户')
    this.name = 'MultiUserError'
    this.users = users
  }
}

async function resolveJellyfinUserId(
  server: { userId?: string } | null,
  auth: JellyfinAuth
): Promise<string> {
  try {
    const me = await jellyfinRequest<{ Id: string; Name?: string }>(auth, '/Users/Me')
    if (me?.Id) {
      console.log(`[server] 使用 /Users/Me 获取用户: ${me.Id} (${me.Name || 'unknown'})`)
      return me.Id
    }
    throw new Error('/Users/Me 响应缺少 Id')
  } catch (meErr) {
    console.warn(`[server] /Users/Me 请求失败（API Key 模式），尝试 /Users 回退: ${meErr}`)
  }
  const users = await jellyfinRequest<Array<{ Id: string; Name?: string }>>(auth, '/Users')
  if (!users || users.length === 0) {
    throw new Error('无法获取用户列表，API Key 可能没有足够权限')
  }
  // 已保存的显式 userId（多用户场景下必须来自用户选择）
  if (server?.userId) {
    const saved = users.find(u => u.Id === server.userId)
    if (saved) {
      console.log(`[server] 使用已保存的用户选择: ${saved.Id} (${saved.Name || 'unknown'})`)
      return saved.Id
    }
    console.warn(`[server] 已保存的 userId 不在服务器用户列表中，忽略`)
  }
  // 仅单用户服务器允许自动选择；多用户禁止静默 users[0]
  if (users.length === 1) {
    console.log(`[server] 单用户服务器，自动选择: ${users[0].Id}`)
    return users[0].Id
  }
  throw new MultiUserError(users.map(u => ({ id: u.Id, name: u.Name })))
}

/** 连接到指定服务器并更新 auth */
async function connectToServer(id: string): Promise<{ success: boolean; data?: JellyfinServerInfo; error?: string; users?: Array<{ id: string; name?: string }> }> {
  const servers = getServers()
  const server = servers.find(s => s.id === id)
  if (!server) return { success: false, error: '服务器不存在' }
  if (isUnresolvedEncrypted(server.url) || isUnresolvedEncrypted(server.token)) {
    return { success: false, error: `服务器 "${server.name}" 的凭据无法解密（safeStorage 版本变更），请在设置中重新输入 URL 和 Token` }
  }

  // Emby 服务器：使用登录时保存的 token + userId，直接校验可用性
  if (server.type === 'emby') {
    try {
      if (!server.userId) {
        throw new Error('Emby 服务器缺少 userId，请重新输入账号密码')
      }
      const auth: JellyfinAuth = { url: server.url, token: server.token, userId: server.userId, type: 'emby' }
      // 调用 /System/Info 校验 token 是否有效
      const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
        auth, '/System/Info'
      )
      jellyfinAuth = auth
      setActiveServerId(id)
      // 同步旧 key（兼容 Home.tsx 的 connectedServer/token 读取逻辑）
      configData['jellyfin'] = { url: server.url, token: server.token }
      saveConfigFile()
      console.log(`[server][emby] 已连接: ${info.ServerName} v${info.Version}, userId=${auth.userId}`)
      return { success: true, data: info }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[server][emby] 连接失败 (${server.name}): ${msg}`)
      return { success: false, error: msg }
    }
  }

  // Jellyfin 服务器：通过 /Users/Me 获取当前用户 ID（不需要管理员权限）
  try {
    const auth: JellyfinAuth = { url: server.url, token: server.token, userId: '', type: 'jellyfin' }
    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth, '/System/Info'
    )
    // 用户解析：/Users/Me 优先；API Key 多用户服务器禁止静默选第一个
    const userId = await resolveJellyfinUserId(server, auth)
    auth.userId = userId
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
    if (err instanceof MultiUserError) {
      // 多用户 API Key 服务器：返回用户列表，由用户显式选择
      return { success: false, error: 'MULTI_USER', users: err.users }
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[server] 连接失败 (${server.name}): ${msg}`)
    return { success: false, error: msg }
  }
}

// ==================== Emby 登录认证 ====================

/** 最近一次 testEmby 登录成功的结果（token 只存在主进程内存，不落 Renderer）。
 * addEmby / server:update 保存时按 url+username 匹配后取用 */
let pendingEmbyLogin: {
  url: string
  username: string
  token: string
  userId: string
  serverName?: string
  version?: string
  at: number
} | null = null

/** pendingEmbyLogin 10 分钟内有效，过期要求重新测试 */
const PENDING_EMBY_LOGIN_TTL = 10 * 60 * 1000

function takePendingEmbyLogin(url: string, username: string): { token: string; userId: string } | null {
  if (!pendingEmbyLogin) return null
  if (Date.now() - pendingEmbyLogin.at > PENDING_EMBY_LOGIN_TTL) {
    pendingEmbyLogin = null
    return null
  }
  if (normalizeUrl(pendingEmbyLogin.url) !== normalizeUrl(url) || pendingEmbyLogin.username !== username) {
    return null
  }
  return { token: pendingEmbyLogin.token, userId: pendingEmbyLogin.userId }
}

/** Emby 客户端标识，用于 X-Emby-Authorization 头 */
const EMBY_CLIENT_INFO = 'MediaBrowser Client="logvar-player", Device="PC", DeviceId="logvar-player-' + 
  (process.env.COMPUTERNAME || 'unknown') + '", Version="1.0.0"'

/**
 * Emby 账号密码登录：调用 /Users/AuthenticateByName 获取 AccessToken + User.Id
 * @returns token, userId, 可选 serverName/version
 */
async function embyLogin(
  url: string,
  username: string,
  password: string
): Promise<{ success: boolean; data?: { token: string; userId: string; serverName?: string; version?: string; username?: string }; error?: string }> {
  try {
    const baseUrl = normalizeUrl(url)
    if (!baseUrl) throw new Error('Emby 服务器地址不能为空')
    const endpoint = `${baseUrl}/Users/AuthenticateByName`
    console.log(`[emby:login] POST ${endpoint}, username=${username}`)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Emby-Authorization': EMBY_CLIENT_INFO,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 401 = 账号密码错误
      if (response.status === 401) {
        throw new Error('账号或密码错误')
      }
      throw new Error(`Emby 登录失败 HTTP ${response.status}: ${text || response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    const text = new TextDecoder('utf-8').decode(buffer)
    const data = JSON.parse(text) as {
      AccessToken?: string
      User?: { Id?: string; Name?: string; ConnectUserName?: string }
      SessionInfo?: unknown
    }

    if (!data.AccessToken || !data.User?.Id) {
      throw new Error('Emby 登录响应缺少 AccessToken 或 User.Id')
    }

    // 获取服务器信息（不阻塞登录成功）
    let serverName: string | undefined
    let version: string | undefined
    try {
      const info = await fetch(`${baseUrl}/System/Info`, {
        headers: { 'X-Emby-Token': data.AccessToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      if (info.ok) {
        const infoData = await info.json() as { ServerName?: string; Version?: string }
        serverName = infoData.ServerName
        version = infoData.Version
      }
    } catch { /* ignore — 登录已成功，服务器信息可选 */ }

    console.log(`[emby:login] 登录成功: user=${data.User.Name || username}, userId=${data.User.Id}, server=${serverName || 'unknown'}`)
    return {
      success: true,
      data: {
        token: data.AccessToken,
        userId: data.User.Id,
        serverName,
        version,
        username: data.User.Name || username
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[emby:login] 失败: ${msg}`)
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
    const normalizedUrl = normalizeUrl(url)
    
    // 检查是否为 Emby 服务器（通过 URL 匹配已保存的服务器配置）
    const servers = getServers()
    const matchedServer = servers.find(s => normalizeUrl(s.url) === normalizedUrl)
    const serverType: ServerType = matchedServer?.type === 'emby' ? 'emby' : 'jellyfin'
    
    const auth: JellyfinAuth = { url: normalizedUrl, token, userId: '', type: serverType }

    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth,
      '/System/Info'
    )

    if (serverType === 'emby' && matchedServer?.userId) {
      // Emby 服务器：使用登录时保存的 userId（Emby 不支持 /Users/Me 接口）
      auth.userId = matchedServer.userId
      console.log(`[server][emby] 使用已保存的 userId: ${auth.userId}`)
    } else {
      // 用户解析统一走 resolveJellyfinUserId：多用户 API Key 禁止静默选第一个
      auth.userId = await resolveJellyfinUserId(matchedServer, auth)
    }

    jellyfinAuth = auth
    console.log(`Jellyfin connected: ${info.ServerName} v${info.Version}, userId=${auth.userId}`)
    return { success: true, data: info }
  } catch (err) {
    if (err instanceof MultiUserError) {
      return { success: false, error: 'MULTI_USER', users: err.users }
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Jellyfin connect failed: ${msg}`)
    return { success: false, error: msg }
  }
})

// ==================== 多服务器 IPC ====================

ipcMain.handle('server:list', async () => {
  // DTO 边界：凭据不出主进程
  return { success: true, data: getServers().map(toPublicServer) }
})

ipcMain.handle('server:get-active', async () => {
  const id = getActiveServerId()
  const servers = getServers()
  const active = servers.find(s => s.id === id) || null
  return { success: true, data: { id, server: active ? toPublicServer(active) : null } }
})

/** Renderer 请求重连：主进程用自持凭据连接活跃服务器，Renderer 不接触 token */
ipcMain.handle('server:ensure-connected', async () => {
  if (jellyfinAuth) return { success: true }
  const id = getActiveServerId()
  if (!id) return { success: false, error: '无活跃服务器，请在设置中配置' }
  return connectToServer(id)
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
  return { success: true, data: toPublicServer(server) }
})

ipcMain.handle('server:update', async (_event, params: {
  id: string
  name?: string
  url?: string
  token?: string
  type?: 'jellyfin' | 'emby'
  username?: string
  password?: string
  userId?: string
  /** Emby 编辑：true 时 token/userId 取自主进程暂存的最近一次测试登录结果 */
  useTestedEmbyLogin?: boolean
}) => {
  const servers = getServers()
  const server = servers.find(s => s.id === params.id)
  if (!server) return { success: false, error: '服务器不存在' }

  // 原子性：先在副本 next 上应用全部变更并完成校验，全部通过后才一次性写回。
  // 避免校验失败（如 Emby 暂存登录失效）时已就地修改 configData 中的对象，
  // 造成半更新状态被后续任意一次落盘固化。
  const next: JellyfinServerConfig = { ...server }
  if (params.name !== undefined) next.name = params.name
  if (params.url !== undefined) next.url = params.url.replace(/\/+$/, '')
  if (params.type !== undefined) next.type = params.type
  if (params.username !== undefined) next.username = params.username
  if (params.password !== undefined) next.password = params.password
  if (params.useTestedEmbyLogin) {
    // Emby 凭据收回主进程：从暂存的测试登录取 token/userId，不经 Renderer。
    // 用「变更后」的 url/username 匹配，确保暂存登录与即将保存的表单一致。
    const login = takePendingEmbyLogin(next.url, next.username || '')
    if (!login) {
      return { success: false, error: '登录凭证已失效或与表单不匹配，请重新点击「测试连接」' }
    }
    next.token = login.token
    next.userId = login.userId
  }
  if (params.token !== undefined) next.token = params.token
  if (params.userId !== undefined) next.userId = params.userId

  const wasActive = getActiveServerId() === params.id
  // 校验全部通过后才提交：用 next 替换目标项后一次性保存
  saveServers(servers.map(s => (s.id === params.id ? next : s)))

  // 一致性：当前活跃服务器的 url/token/userId/type 变化必须同步到 jellyfinAuth，
  // 保证下一次 API 调用立即使用新凭据（而不是等重连）
  if (wasActive && jellyfinAuth) {
    jellyfinAuth = {
      url: next.url,
      token: next.token,
      userId: next.userId || '',
      type: next.type === 'emby' ? 'emby' : 'jellyfin'
    }
    console.log(`[server] 活跃服务器配置已更新，auth 已同步 (type=${jellyfinAuth.type})`)
  }
  return { success: true, data: toPublicServer(next) }
})

ipcMain.handle('server:remove', async (_event, id: string) => {
  let servers = getServers()
  servers = servers.filter(s => s.id !== id)
  saveServers(servers)
  if (getActiveServerId() === id) {
    if (servers.length > 0) {
      // 删除的是当前活跃服务器：切换到剩余的第一台并重建 auth，
      // 避免后续 API 仍带着已删除服务器的凭据
      const next = servers[0]
      setActiveServerId(next.id)
      const connectResult = await connectToServer(next.id).catch(err => {
        console.warn('[server] 删除后自动切换连接失败:', err)
        return { success: false as const, error: String(err) }
      })
      if (!connectResult.success) {
        jellyfinAuth = null
        return { success: true, warning: `已删除服务器，但切换到 "${next.name}" 失败：${connectResult.error}` } }
      }
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

/** 列出 Jellyfin 服务器的用户（多用户 API Key 场景，供用户显式选择） */
ipcMain.handle('server:list-users', async (_event, id: string) => {
  const server = getServers().find(s => s.id === id)
  if (!server) return { success: false, error: '服务器不存在' }
  if (server.type === 'emby') return { success: false, error: 'Emby 服务器使用账号密码登录，无需选择用户' }
  try {
    const auth: JellyfinAuth = { url: server.url, token: server.token, userId: '', type: 'jellyfin' }
    const users = await jellyfinRequest<Array<{ Id: string; Name?: string }>>(auth, '/Users')
    if (!users) return { success: false, error: '无法获取用户列表' }
    return { success: true, data: users.map(u => ({ id: u.Id, name: u.Name })) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/** 为 Jellyfin API Key 服务器保存显式选择的用户 */
ipcMain.handle('server:set-user', async (_event, id: string, userId: string) => {
  const servers = getServers()
  const server = servers.find(s => s.id === id)
  if (!server) return { success: false, error: '服务器不存在' }
  server.userId = userId
  saveServers(servers)
  // 若是当前活跃服务器，立即同步 auth，保证下一次 API 使用所选用户
  if (getActiveServerId() === id && jellyfinAuth) {
    jellyfinAuth = { ...jellyfinAuth, userId }
  }
  return { success: true, data: toPublicServer(server) }
})

ipcMain.handle('server:test', async (_event, url: string, token: string) => {
  const startTime = Date.now()
  try {
    const auth: JellyfinAuth = { url: url.replace(/\/+$/, ''), token, userId: '', type: 'jellyfin' }
    const info = await jellyfinRequest<{ ServerName?: string; Version?: string; Id?: string }>(
      auth, '/System/Info'
    )
    const elapsed = Date.now() - startTime
    return { success: true, data: info, elapsed }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), elapsed: Date.now() - startTime }
  }
})

// ==================== Emby 登录 / 测试 / 添加 IPC ====================

// emby:login 已移除：登录统一走 server:test-emby，AccessToken 只留在主进程

ipcMain.handle('server:test-emby', async (_event, params: { url: string; username: string; password: string }) => {
  const startTime = Date.now()
  const result = await embyLogin(params.url, params.username, params.password)
  const elapsed = Date.now() - startTime
  if (!result.success || !result.data) {
    pendingEmbyLogin = null
    return { success: false, error: result.error, elapsed }
  }
  // token 暂存主进程，供后续 addEmby / server:update 使用；Renderer 只拿到服务器信息
  pendingEmbyLogin = {
    url: params.url,
    username: params.username,
    token: result.data.token,
    userId: result.data.userId,
    serverName: result.data.serverName,
    version: result.data.version,
    at: Date.now()
  }
  return {
    success: true,
    data: {
      ServerName: result.data.serverName,
      Version: result.data.version,
      username: result.data.username
    },
    elapsed
  }
})

ipcMain.handle('server:add-emby', async (_event, params: {
  name: string
  url: string
  username: string
  password: string
}) => {
  try {
    // 凭据收回主进程：token/userId 来自最近一次 testEmby 登录，不经 Renderer 传递
    const login = takePendingEmbyLogin(params.url, params.username)
    if (!login) {
      return { success: false, error: '登录凭证已失效或未测试，请先点击「测试连接」' }
    }
    const servers = getServers()
    const id = generateServerId()
    const server: JellyfinServerConfig = {
      id,
      name: params.name || `Emby (${params.username})`,
      url: params.url.replace(/\/+$/, ''),
      token: login.token,
      userId: login.userId,
      type: 'emby',
      username: params.username,
      password: params.password
    }
    servers.push(server)
    saveServers(servers)
    console.log(`[server][emby] 已添加服务器: ${server.name} (userId=${server.userId})`)
    return { success: true, data: toPublicServer(server) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
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

// ==================== 播放流代理（凭据不出主进程） ====================
// Renderer 只拿到 127.0.0.1 回环 URL，真正的服务器地址与 token 由主进程注入。
// mpv（独立/画布）与 html5 各引擎都只是普通 http 客户端，因此统一走本代理，
// 避免 api_key 明文出现在渲染端（也无需各引擎单独适配请求头）。
let streamProxyServer: http.Server | null = null
let streamProxyPort = 0

function startStreamProxy(): void {
  if (streamProxyServer) return
  streamProxyServer = http.createServer((req, res) => {
    handleStreamProxyRequest(req, res)
  })
  streamProxyServer.on('error', (err) => {
    console.error('[stream-proxy] server error:', err)
  })
  streamProxyServer.listen(0, '127.0.0.1', () => {
    const addr = streamProxyServer?.address()
    if (addr && typeof addr === 'object') {
      streamProxyPort = addr.port
      console.log(`[stream-proxy] listening on 127.0.0.1:${streamProxyPort}`)
    }
  })
}

/** 构造回环播放 URL：/__stream/<serverId>/<内网路径与查询>，不含任何凭据 */
function buildStreamUrl(serverId: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `http://127.0.0.1:${streamProxyPort}/__stream/${encodeURIComponent(serverId)}${suffix}`
}

function handleStreamProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const fail = (code: number, msg: string): void => {
    if (!res.headersSent) res.writeHead(code)
    res.end(msg)
  }
  // 仅接受本机回环请求，防止被同机其他进程以外的来源当作跳板
  const remote = req.socket.remoteAddress || ''
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    fail(403, 'Forbidden')
    return
  }
  const m = (req.url || '').match(/^\/__stream\/([^/]+)(\/.*)?$/)
  if (!m) {
    fail(404, 'Not Found')
    return
  }
  const serverId = decodeURIComponent(m[1])
  const rest = m[2] || '/'
  const server = getServers().find(s => s.id === serverId)
  if (!server || !server.token) {
    fail(404, 'Server Not Found')
    return
  }
  let target: URL
  try {
    target = new URL(`${normalizeUrl(server.url)}${rest}`)
  } catch {
    fail(400, 'Bad Target')
    return
  }
  const headers: Record<string, string> = { 'X-Emby-Token': server.token }
  if (req.headers.range) headers['Range'] = String(req.headers.range)
  if (req.headers['user-agent']) headers['User-Agent'] = String(req.headers['user-agent'])
  const transport = target.protocol === 'https:' ? https : http
  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers
    },
    (upstream) => {
      const out: Record<string, string | string[]> = {}
      for (const key of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
        const v = upstream.headers[key]
        if (v !== undefined) out[key] = v
      }
      res.writeHead(upstream.statusCode || 502, out)
      upstream.pipe(res)
    }
  )
  proxyReq.on('error', (err) => {
    console.error('[stream-proxy] upstream error:', err)
    fail(502, 'Bad Gateway')
  })
  res.on('close', () => proxyReq.destroy())
  proxyReq.end()
}

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
      const activeId = getActiveServerId()
      if (!activeId) return { success: false, error: '未找到活跃服务器' }
      const url = buildStreamUrl(activeId, `/Videos/${itemId}/stream?Static=true`)
      console.log(`get-playback-url (fallback): ${url}`)
      return { success: true, data: { url, subtitles: [] } }
    }

    const mediaSourceId = mediaSources[0].Id
    const container = mediaSources[0].Container || ''
    console.log(`get-playback-url: mediaSourceId=${mediaSourceId}, container=${container}, itemId=${itemId}`)

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

    const activeId = getActiveServerId()
    if (!activeId) return { success: false, error: '未找到活跃服务器' }
    const url = buildStreamUrl(activeId, `/Videos/${itemId}/stream?Static=true&MediaSourceId=${mediaSourceId}`)
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
  
  if (!isAllowedDoubanImageUrl(params.posterUrl)) {
    return { success: false, error: '封面地址不在豆瓣允许域名内' }
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
    const response = await fetch(url, { headers: buildJellyfinHeaders(jellyfinAuth.token, jellyfinAuth.type) })
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

// ==================== IPC: Jellyfin 最近入库（官方 getLatestMedia 接口） ====================

ipcMain.handle('jellyfin:get-latest-media', async (_event, limit: number = 16) => {
  if (!jellyfinAuth) return { success: false, error: '未连接到 Jellyfin 服务器' }
  try {
    const params = new URLSearchParams({
      limit: String(limit),
      includeItemTypes: 'Movie,Series',
      enableImages: 'true',
      enableUserData: 'true',
      groupItems: 'false',
      fields: 'Overview,PremiereDate,CommunityRating,DateCreated'
    })
    const endpoint = `/Users/${jellyfinAuth.userId}/Items/Latest?${params.toString()}`
    console.log(`[jellyfin:get-latest-media] 请求参数: userId=${jellyfinAuth.userId}, limit=${limit}, includeItemTypes=Movie,Series`)

    const data = await jellyfinRequest<unknown[]>(jellyfinAuth, endpoint)

    if (!Array.isArray(data)) {
      console.warn('[jellyfin:get-latest-media] 接口返回非数组，返回空列表')
      return { success: true, data: [] }
    }

    console.log(`[jellyfin:get-latest-media] 接口返回 ${data.length} 条数据`)
    data.forEach((item: any, idx: number) => {
      console.log(`[jellyfin:get-latest-media] #${idx + 1} 名称: "${item.Name}" | 类型: ${item.Type} | DateCreated: ${item.DateCreated || '无'} | Id: ${item.Id}`)
    })

    return { success: true, data }
  } catch (err) {
    console.error('[jellyfin:get-latest-media] 请求失败:', err)
    return { success: false, error: String(err) }
  }
})

// ==================== IPC: Store ====================

// ==================== 敏感数据加密（safeStorage） ====================

/** 需要加密存储的 key 列表（ENCRYPTED_KEYS 定义见 ./lib/security.ts） */
// 注意：jellyfin.url / servers[].url 故意不加密——服务器地址不是秘密（出现在播放/图片
// URL 与日志中），加密零安全收益；反而 safeStorage 不可用时 url 被清空会导致整条服务器
// 记录被启动清理逻辑删除（表现为"每次重启都要重新输入服务器"）。url 明文持久化。

/** safeStorage 跨会话可用性检测。
 * 关键：必须在 app ready 之后调用——Windows 上 safeStorage.isEncryptionAvailable()
 * 依赖 DPAPI，在 app 就绪前调用恒返回 false，会导致 safeStorageWorking 被永久误判，
 * 进而所有敏感字段（token/url）加密时写成空串、重启后服务器信息全部丢失。 */
let safeStorageWorking = false
let safeStorageChecked = false
function initSafeStorage(): void {
  if (safeStorageChecked) return
  safeStorageChecked = true
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const testPlain = '__huanying_safestorage_test__'
      const encrypted = safeStorage.encryptString(testPlain)
      const decrypted = safeStorage.decryptString(encrypted)
      safeStorageWorking = decrypted === testPlain
    }
  } catch { safeStorageWorking = false }
  if (safeStorageWorking) {
    console.log('[Config] safeStorage encryption available')
  } else {
    console.warn('[Config] safeStorage encryption unavailable — sensitive fields will NOT be persisted (no insecure fallback)')
  }
}

/** 机器相关的 XOR 混淆密钥（基于机器名+用户名+固定盐，仅用于读取历史遗留 xor: 值） */
function xorKey(): Buffer {
  const seed = `${process.env.COMPUTERNAME ?? 'unknown'}|${process.env.USERNAME ?? 'unknown'}|mplay-v1`
  return crypto.createHash('sha256').update(seed).digest()
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

// isEncrypted 已移至 ./lib/security.ts

/** 日志脱敏：移除可能的 token/密钥 */
function sanitizeLog(msg: string): string {
  return msg
    .replace(/api_key=[^&\s"']+/gi, 'api_key=***')
    .replace(/token["']?\s*[=:]\s*["']?[A-Za-z0-9_\-\.]+/gi, 'token=***')
}

function encryptValue(plain: string): string {
  if (!needsEncryption(plain)) return plain
  initSafeStorage() // 懒兜底：确保 app ready 后已正确检测
  if (safeStorageWorking) {
    try {
      const buf = safeStorage.encryptString(plain)
      return 'enc:' + buf.toString('base64')
    } catch { /* fallthrough */ }
  }
  // M3: safeStorage 不可用时拒绝降级为 XOR 混淆（密钥仅由 COMPUTERNAME/USERNAME
  // 派生，同机任意进程可还原）。返回空串放弃持久化该敏感字段，重启后需重新配置
  console.warn('[Config] safeStorage 不可用，拒绝持久化敏感字段（该值本轮不落盘，重启后需重新配置）')
  return ''
}

function decryptValue(stored: string): string {
  if (!needsDecryption(stored)) return stored
  if (stored.startsWith('enc:')) {
    initSafeStorage() // 懒兜底：确保 app ready 后已正确检测
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
  // 对象形式（如 jellyfin: { url, token }）——url 明文，只加密 token
  if (out.jellyfin && typeof out.jellyfin === 'object') {
    const jf = { ...(out.jellyfin as Record<string, unknown>) }
    for (const k of ['token']) {
      if (typeof jf[k] === 'string' && needsEncryption(jf[k] as string)) {
        jf[k] = encryptValue(jf[k] as string)
      }
    }
    out.jellyfin = jf
  }
  // jellyfin:servers 数组：url 明文（非秘密），只加密凭证 token/password
  if (Array.isArray(out['jellyfin:servers'])) {
    out['jellyfin:servers'] = (out['jellyfin:servers'] as Record<string, unknown>[]).map(s => {
      const sv = { ...s }
      if (typeof sv.token === 'string' && needsEncryption(sv.token)) sv.token = encryptValue(sv.token)
      // Emby 专属：加密 password
      if (typeof sv.password === 'string' && needsEncryption(sv.password)) sv.password = encryptValue(sv.password)
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
  // 解密 jellyfin:servers 数组中每个服务器的 url / token / password
  if (Array.isArray(out['jellyfin:servers'])) {
    out['jellyfin:servers'] = (out['jellyfin:servers'] as Record<string, unknown>[]).map(s => {
      const sv = { ...s }
      if (typeof sv.url === 'string' && needsDecryption(sv.url)) sv.url = decryptValue(sv.url)
      if (typeof sv.token === 'string' && needsDecryption(sv.token)) sv.token = decryptValue(sv.token)
      if (typeof sv.password === 'string' && needsDecryption(sv.password)) sv.password = decryptValue(sv.password)
      return sv
    })
  }
  return out
}

let configLoadOk = false

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
    configLoadOk = true
  } catch (err) {
    console.error('[Config] Failed to load:', err)
    if (configPath && existsSync(configPath)) {
      // 配置文件损坏：保留原文件用于排查，备份后不覆盖为空白配置
      try {
        copyFileSync(configPath, `${configPath}.corrupted-${Date.now()}`)
        console.error('[Config] Corrupted config backed up; keeping previous in-memory state')
      } catch (e) { console.error('[Config] Backup failed:', e) }
    }
    configData = {}
  }
}

function saveConfigFile(): void {
  try {
    if (!configPath) {
      configPath = join(app.getPath('userData'), 'config.json')
    }
    mkdirSync(dirname(configPath), { recursive: true })
    // 原子写入：先写临时文件再重命名，避免写盘中途崩溃产生半截配置
    const tmpPath = `${configPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(encryptConfig(configData), null, 2), 'utf-8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}

/**
 * 配置初始化：必须在 app ready 之后执行。
 * 原因：loadConfigFile → decryptConfig 依赖 safeStorage（Windows DPAPI），
 * 而 safeStorage 只有在 app ready 后才可用；ready 前加载会把 enc: 凭据误判为不可解密。
 */
function initConfig(): void {
  initSafeStorage()
  loadConfigFile()
  migrateLegacyConfig()
  // 仅当配置成功加载后再落盘清洗结果，避免用空白配置覆盖损坏的原文件
  if (configLoadOk) {
    saveConfigFile()
  }
}

// sanitizeEncryptedBlobs 已移至 ./lib/security.ts

// ==================== 凭据边界：敏感 key / 字段识别 ====================
// 原则：configData 内存中持有的是解密后的明文。任何离开主进程的路径
// （导出文件、store:get 返回给 Renderer）都必须经过这里的显式过滤，
// 不能依赖"值看起来还是密文"这种隐式假设。

/** 整体视为凭据的配置命名空间：默认禁止导出，Renderer 读取时剥离敏感字段 */
// 凭据边界（isCredentialKey / stripSensitiveFields / CREDENTIAL_NAMESPACES）实现见 ./lib/security.ts

ipcMain.handle('store:get', async (_event, key: string) => {
  const raw = configData[key] ?? null
  // 安全边界：Renderer 不持有凭据。先清理解密失败的 enc: 密文，
  // 再递归抹除 token/password/appSecret/apiKey 等字段（url/username 等非敏感字段保留）
  return stripSensitiveFields(sanitizeEncryptedBlobs(raw))
})

ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
  // 防止原型污染与非法键写入（__proto__/constructor/prototype）
  if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
    console.warn('[store:set] rejected invalid key:', key)
    return false
  }
  // M2: 敏感键（jellyfin.token/url 等）由专用登录 handler 管理，拒绝渲染端直接
  // 覆写 —— 对象/嵌套值可绕过 encryptConfig 的字符串加密路径落盘明文
  if (ENCRYPTED_KEYS.has(key)) {
    console.warn('[store:set] rejected sensitive key:', key)
    return false
  }
  // 凭据命名空间整体走 server:* / emby:* 专用 IPC，拒绝通用 store 通道写入
  if (CREDENTIAL_NAMESPACES.has(key)) {
    console.warn('[store:set] rejected credential namespace key:', key)
    return false
  }
  configData[key] = value
  saveConfigFile()
  return true
})

ipcMain.handle('store:delete', async (_event, key: string) => {
  // 与 store:set 同理，敏感键的清除也走专用 handler（登出流程）
  if (typeof key === 'string' && (ENCRYPTED_KEYS.has(key) || CREDENTIAL_NAMESPACES.has(key))) {
    console.warn('[store:delete] rejected sensitive key:', key)
    return false
  }
  delete configData[key]
  saveConfigFile()
  return true
})

// ==================== 数据导入导出 ====================

// 导出配置数据
ipcMain.handle('data:export', async (_event, options?: { format?: 'json' | 'csv'; includeKeys?: string[]; includeSensitive?: boolean }) => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出数据',
      defaultPath: `huanying_config_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    
    if (result.canceled || !result.filePath) {
      return { success: false, error: '用户取消导出' }
    }
    
    const exportData: { version: string; exportedAt: string; data: Record<string, unknown> } = {
      version: '13.0.0',
      exportedAt: new Date().toISOString(),
      data: {}
    }
    
    const keysToExport = options?.includeKeys || Object.keys(configData)
    const includeSensitive = options?.includeSensitive === true
    const excludedSensitive: string[] = []

    for (const key of keysToExport) {
      if (configData[key] === undefined) continue
      // 白名单原则：凭据命名空间（服务器 token/密码、弹幕 AppSecret 等）默认禁止导出，
      // 即使 Renderer 显式勾选也只认 includeSensitive 开关，防止凭据混进导出文件
      if (!includeSensitive && isCredentialKey(key)) {
        excludedSensitive.push(key)
        continue
      }
      // 非凭据 key 也可能嵌套敏感字段（如对象里的 token 字段），递归抹除兜底
      exportData.data[key] = stripSensitiveFields(sanitizeEncryptedBlobs(configData[key]))
    }
    
    let content: string
    const ext = result.filePath.split('.').pop()?.toLowerCase()
    
    if (ext === 'csv' && options?.format === 'csv') {
      const rows: string[][] = [['Key', 'Value']]
      for (const [key, value] of Object.entries(exportData.data)) {
        const valueStr = typeof value === 'object' ? JSON.stringify(value).replace(/"/g, '""') : String(value ?? '')
        rows.push([key, valueStr])
      }
      content = rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
    } else {
      content = JSON.stringify(exportData, null, 2)
    }
    
    writeFileSync(result.filePath, content, 'utf-8')
    
    return {
      success: true,
      data: {
        filePath: result.filePath,
        keyCount: Object.keys(exportData.data).length,
        size: Buffer.byteLength(content, 'utf-8'),
        excludedSensitive
      }
    }
  } catch (err) {
    return { success: false, error: `导出失败: ${String(err)}` }
  }
})

// 导入配置数据
ipcMain.handle('data:import', async (_event, options?: { merge?: boolean; selectedKeys?: string[] }) => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入数据',
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: '用户取消导入' }
    }
    
    const filePath = result.filePaths[0]
    const content = readFileSync(filePath, 'utf-8')
    
    let importedData: Record<string, unknown>
    let warnings: string[] = []
    
    const ext = filePath.split('.').pop()?.toLowerCase()
    
    if (ext === 'csv') {
      const rows = content.split('\n').filter(row => row.trim())
      const headers = rows[0].split(',').map(h => h.replace(/^"|"$/g, ''))
      if (headers.length < 2 || headers[0] !== 'Key' || headers[1] !== 'Value') {
        return { success: false, error: 'CSV 格式错误：需要 "Key,Value" 表头' }
      }
      importedData = {}
      for (let i = 1; i < rows.length; i++) {
        const match = rows[i].match(/^"([^"]*)",(.*)$/)
        if (match) {
          const key = match[1]
          let value: unknown = match[2].replace(/^"|"$/g, '').replace(/""/g, '"')
          try {
            value = JSON.parse(value as string)
          } catch {
            // 保持为字符串
          }
          importedData[key] = value
        }
      }
    } else {
      try {
        const parsed = JSON.parse(content)
        if (parsed.version && parsed.data) {
          importedData = parsed.data
        } else {
          importedData = parsed
        }
      } catch {
        return { success: false, error: 'JSON 格式错误' }
      }
    }
    
    const selectedKeys = options?.selectedKeys || Object.keys(importedData)
    const merge = options?.merge ?? true
    const skippedKeys: string[] = []
    const importedKeys: string[] = []
    
    for (const key of selectedKeys) {
      if (importedData[key] === undefined) {
        skippedKeys.push(key)
        continue
      }
      
      // 安全检查：防止注入危险的配置
      if (key.startsWith('__') || key.startsWith('system:')) {
        warnings.push(`跳过系统保护的键: ${key}`)
        skippedKeys.push(key)
        continue
      }
      
      if (merge && isPlainObject(configData[key]) && isPlainObject(importedData[key])) {
        // 深合并：保留现有配置中导入文件未覆盖的字段（嵌套对象递归合并）
        configData[key] = deepMerge(
          configData[key] as Record<string, unknown>,
          importedData[key] as Record<string, unknown>
        )
      } else {
        configData[key] = importedData[key]
      }
      importedKeys.push(key)
    }
    
    saveConfigFile()
    
    return { 
      success: true, 
      data: { 
        importedCount: importedKeys.length,
        skippedCount: skippedKeys.length,
        warnings,
        importedKeys,
        skippedKeys
      }
    }
  } catch (err) {
    return { success: false, error: `导入失败: ${String(err)}` }
  }
})

// 获取可导出的配置键列表
ipcMain.handle('data:list-keys', async () => {
  const keys = Object.keys(configData).filter(k => !k.startsWith('__') && !k.startsWith('system:'))
  const keyInfo = keys.map(k => ({
    key: k,
    // 精确匹配凭据命名空间，避免误伤 'jellyfin:activeServerId' 这类普通配置项
    hasSensitive: isCredentialKey(k)
  }))
  return { success: true, data: keyInfo }
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

// ==================== 播放页窗口级全屏（透明窗口模拟全屏） ====================
// Electron 33 Windows：透明窗口被强制去掉 WS_THICKFRAME，setFullScreen 走
// SetBounds 模拟路径（进入时保存 bounds 并铺满显示器、退出时恢复），且
// widget 的原生全屏状态从未被置位 —— isFullScreen() 恒为 false。
// 因此不能用 isFullScreen() 判断当前状态：否则 toggle 永远算出 target=true，
// 第二次点击仍执行 setFullScreen(true)，还会把 restore_bounds 覆盖成全屏尺寸，
// 表现为"无法退出全屏"。状态由本模块布尔量维护，enter/leave 事件兜底同步。
let windowFullscreenState = false

function toggleWindowFullscreen(): boolean {
  if (!mainWindow) return false
  windowFullscreenState = !windowFullscreenState
  mainWindow.setFullScreen(windowFullscreenState)
  return windowFullscreenState
}

ipcMain.handle('window:toggle-fullscreen', () => ({ success: true, data: toggleWindowFullscreen() }))

// ==================== MPV 播放引擎 ====================
// 与 HTML5 <video> 并存的第二条播放链路：主进程 spawn mpv.exe，
// 通过命名管道 JSON IPC 控制；Windows 下用 koffi 创建子窗口（--wid）嵌入主窗口。
// 渲染端传入的坐标均为 CSS 像素（视口左上角原点），主进程按显示器 DPI 换算物理像素。

let mpvController: MpvController | null = null

/** 需要转发到渲染进程的 mpv 事件 */
const MPV_FORWARD_EVENTS = [
  'ready', 'quit', 'error',
  'time', 'duration', 'pause', 'volume', 'speed',
  'track-list', 'fullscreen',
  'file-loaded', 'start', 'stop', 'seek', 'idle'
]

function getMpvPlayerSettings(): { hardwareDecode: boolean; hdrToneMapping: boolean; debugLog: boolean } {
  const saved = configData['player'] as { hardwareDecode?: boolean; hdrToneMapping?: boolean; debugLog?: boolean } | undefined
  return {
    hardwareDecode: saved?.hardwareDecode !== false,
    hdrToneMapping: saved?.hdrToneMapping === true,
    debugLog: saved?.debugLog === true
  }
}

/** 获取（惰性创建）mpv 控制器单例，并转发事件到渲染进程 */
function getMpvController(): MpvController {
  if (!mpvController) {
    const controller = new MpvController(getMpvPlayerSettings())
    for (const ev of MPV_FORWARD_EVENTS) {
      controller.on(ev, (data: unknown) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mpv:event', { event: ev, data })
        }
      })
    }
    mpvController = controller
  }
  return mpvController
}

/** 统一执行 mpv 操作，未运行/异常时返回标准失败响应 */
async function runMpv<T>(fn: (c: MpvController) => Promise<T> | T): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    if (!mpvController || !mpvController.isMpvRunning()) {
      return { success: false, error: 'mpv 未运行' }
    }
    const data = await fn(mpvController)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// mpv 是否可用（二进制存在性检查）
ipcMain.handle('mpv:is-available', async () => {
  try {
    return { success: true, data: getMpvController().isAvailable() }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// 嵌入：创建 mpv 渲染窗口（主窗口身后打孔架构）并启动 mpv（--wid 只能在启动时传入）；
// 已运行时仅更新渲染窗口位置。坐标为渲染端视口 DIP（主进程换算屏幕物理像素）
ipcMain.handle('mpv:embed', async (_event, x: number, y: number, width: number, height: number) => {
  try {
    if (!mainWindow) return { success: false, error: '主窗口未创建' }
    const controller = getMpvController()
    if (!controller.isAvailable()) return { success: false, error: '未找到 mpv 可执行文件' }

    if (!controller.isMpvRunning()) {
      // 复用已有渲染窗口：渲染端在挂载 effect 与起播流程会各调用一次 embed，
      // 若第二次重建窗口，mpv --wid 仍指向已销毁的旧句柄 → 音频正常但画面黑屏
      if (!controller.hasChildWindow()) {
        const ok = controller.createChildWindow(mainWindow, x, y, width, height)
        if (!ok) return { success: false, error: '创建 mpv 嵌入窗口失败' }
      } else {
        controller.updateChildWindowPosition(x, y, width, height)
      }
      await controller.start()
    } else {
      controller.updateChildWindowPosition(x, y, width, height)
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// 更新嵌入窗口位置/大小（窗口缩放、全屏、布局变化；DIP 视口坐标）
ipcMain.handle('mpv:update-embed', async (_event, x: number, y: number, width: number, height: number) => {
  if (mpvController && mpvController.isMpvRunning()) {
    mpvController.updateChildWindowPosition(x, y, width, height)
  }
  return { success: true }
})

// 加载并播放（URL 或本地路径；未嵌入时以独立窗口模式启动）
ipcMain.handle('mpv:play', async (_event, url: string) => {
  try {
    // L1: scheme 白名单 —— 防止渲染端被控时借 mpv 进程访问任意协议/内网
    const s = String(url)
    const lower = s.toLowerCase()
    const isHttp = lower.startsWith('http://') || lower.startsWith('https://')
    const isFileUrl = lower.startsWith('file://')
    const isLocalPath = /^[a-z]:[\\/]/.test(lower) || lower.startsWith('\\\\')
    if (!isHttp && !isFileUrl && !isLocalPath) {
      return { success: false, error: 'mpv:play 仅支持 http/https/file 或本地磁盘路径' }
    }
    const controller = getMpvController()
    if (!controller.isAvailable()) return { success: false, error: '未找到 mpv 可执行文件' }
    if (!controller.isMpvRunning()) {
      await controller.start()
    }
    await controller.loadFile(url)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// 离开播放页：销毁子窗口与 mpv 进程（原生子窗口会覆盖其他页面，必须回收）
ipcMain.handle('mpv:hide', async () => {
  if (mpvController) {
    const controller = mpvController
    mpvController = null
    try { await controller.destroy() } catch { /* ignore */ }
  }
  return { success: true }
})

ipcMain.handle('mpv:stop', () => runMpv((c) => c.stop()))
ipcMain.handle('mpv:pause', () => runMpv((c) => c.pause_()))
ipcMain.handle('mpv:resume', () => runMpv((c) => c.play()))
ipcMain.handle('mpv:seek', (_event, position: number) => runMpv((c) => c.seek(position)))
ipcMain.handle('mpv:set-volume', (_event, volume: number) => runMpv((c) => c.setVolume(volume)))
ipcMain.handle('mpv:set-speed', (_event, speed: number) => runMpv((c) => c.setSpeed(speed)))

// 嵌入模式下全屏由 Electron 页面控制（子窗口跟随几何更新）；
// 独立窗口模式才切换 mpv 自身全屏
ipcMain.handle('mpv:toggle-fullscreen', () => {
  // 打孔架构下不能 cycle mpv 自身 fullscreen（--wid 下 mpv 会调整渲染窗口尺寸导致错位），
  // 嵌入与否都统一切换 Electron 主窗口的窗口级全屏
  return { success: true, data: toggleWindowFullscreen() }
})

ipcMain.handle('mpv:get-state', () => runMpv((c) => c.getState()))
ipcMain.handle('mpv:get-tracks', () => runMpv((c) => c.getTrackList()))
ipcMain.handle('mpv:select-track', (_event, trackId: number) => runMpv((c) => c.selectTrack(trackId)))
ipcMain.handle('mpv:select-subtitle', (_event, trackId: number) => runMpv((c) => c.selectSubtitle(trackId)))
ipcMain.handle('mpv:disable-subtitle', () => runMpv((c) => c.disableSubtitle()))
ipcMain.handle('mpv:load-subtitle', (_event, subtitlePath: string) => runMpv((c) => c.loadExternalSubtitle(subtitlePath)))
ipcMain.handle('mpv:get-property', (_event, name: string) => runMpv((c) => c.getProperty(name)))
ipcMain.handle('mpv:set-property', (_event, name: string, value: unknown) => runMpv((c) => c.setProperty(name, value)))
ipcMain.handle('mpv:screenshot', (_event, filePath: string) => runMpv((c) => c.screenshot(filePath)))

// 截图保存 — 弹保存对话框；mpv 运行中由 mpv 原生截图，
// 否则返回 use-canvas-fallback 让渲染端走 Canvas 截图
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
    if (mpvController && mpvController.isMpvRunning()) {
      await mpvController.screenshot(result.filePath)
      return { success: true, data: result.filePath }
    }
    // mpv 未运行：渲染端用 Canvas 截图后写入该路径
    return { success: false, filePath: result.filePath, error: 'use-canvas-fallback' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// 画布引擎（方案 C）截图保存：preload 取当前帧（已转 BGRA）→ nativeImage 存 PNG
ipcMain.handle('mpv:save-frame-png', async (_event, payload: { width: number; height: number; pixels: Uint8Array }) => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  try {
    const { width, height, pixels } = payload
    if (!width || !height || !pixels || pixels.length < width * height * 4) {
      return { success: false, error: '帧数据无效' }
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存截图',
      defaultPath: `screenshot_${Date.now()}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
    const image = nativeImage.createFromBitmap(Buffer.from(pixels), { width, height })
    writeFileSync(result.filePath, image.toPNG())
    return { success: true, data: result.filePath }
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

// M10: 历史记录写入字段白名单 + 长度校验，watchedAt 由主进程强制覆盖，
// 防止渲染端伪造任意字段或时间戳置顶刷屏
function sanitizeHistoryItem(item: unknown): PlayHistoryItem | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  if (typeof it.itemId !== 'string' || !it.itemId || typeof it.name !== 'string' || !it.name) return null
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0)
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
  return {
    itemId: it.itemId.slice(0, 128),
    name: it.name.slice(0, 256),
    duration: num(it.duration),
    position: num(it.position),
    // 海报 URL 不信任渲染端传值（历史上曾把 api_key 拼进 URL 落盘），由主进程统一派生
    posterUrl: '',
    watchedAt: Date.now(),
    localFile: str(it.localFile, 1024),
    baseUrl: str(it.baseUrl, 256),
    seriesName: str(it.seriesName, 256)
  }
}

/** 由服务器配置派生历史海报 URL：serverId 格式协议链接（不含任何凭据）。
 * base-path 由主进程按 serverId 对应的服务器配置自动拼接（https://host/jellyfin 的 /jellyfin 会保留），
 * 展示时主进程注入认证头 */
function buildHistoryPosterUrl(baseUrl: string, itemId: string): string {
  try {
    const matched = findServerByUrlPrefix(normalizeUrl(baseUrl))
    if (!matched) return ''
    const proto = matched.server.type === 'emby' ? 'emby-image' : 'jellyfin-image'
    return `${proto}://${matched.server.id}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=300`
  } catch {
    return ''
  }
}

/** 一次性迁移：
 * 1) 旧历史 posterUrl 内嵌 api_key/token/access_token 明文 → 重写为协议 URL（重写失败则清空海报，凭据绝不保留）
 * 2) host 格式协议 URL / 明文服务器 URL（上一版迁移产物，存在 host 冲突、丢 base-path 问题）→ 升级为 serverId 格式 */
function migrateHistoryPosters(): void {
  try {
    const items = loadHistory()
    let changed = false
    for (const it of items) {
      if (!it.posterUrl) continue
      const hasCredential = /[?&](api_key|token|access_token)=/i.test(it.posterUrl)
      const isLegacy =
        /^https?:\/\//i.test(it.posterUrl) ||
        /^jellyfin-image:\/\/(https?)\//i.test(it.posterUrl) ||
        /^emby-image:\/\/(https?)\//i.test(it.posterUrl)
      if (!hasCredential && !isLegacy) continue
      const migrated = (!it.localFile && it.baseUrl && it.itemId)
        ? buildHistoryPosterUrl(it.baseUrl, it.itemId)
        : ''
      if (migrated === it.posterUrl) continue
      it.posterUrl = migrated
      changed = true
    }
    if (changed) {
      saveHistory(items)
      console.log('[history] 已迁移历史海报 URL：升级为 serverId 协议链接（无凭据、保留 base-path）')
    }
  } catch (err) {
    console.warn('[history] 海报 URL 迁移失败:', err)
  }
}

ipcMain.handle('history:save', async (_event, item: PlayHistoryItem) => {
  const sanitized = sanitizeHistoryItem(item)
  if (!sanitized) return { success: false, error: 'invalid history item' }
  // 海报 URL 由主进程按服务器配置派生（不含凭据）
  if (!sanitized.localFile && sanitized.baseUrl && sanitized.itemId) {
    sanitized.posterUrl = buildHistoryPosterUrl(sanitized.baseUrl, sanitized.itemId)
  }
  const items = loadHistory()
  // 去重：同名同 itemId 覆盖更新
  const idx = items.findIndex((h) => h.itemId === sanitized.itemId)
  const entry: PlayHistoryItem = sanitized
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

// ==================== IPC: 最近入库 ====================

interface RecentlyAddedItem {
  itemId: string
  name: string
  type: 'Movie' | 'Series' | 'Episode'
  productionYear?: number
  imageTag?: string
  seriesName?: string
  seriesId?: string
  seasonId?: string
  indexNumber?: number
  parentIndexNumber?: number
  addedAt: number
  serverId?: string
}

interface RecentlyAddedConfig {
  enabled: boolean
  displayCount: number
  scrollSpeed: number
  scrollPosition: number
}

const RECENTLY_ADDED_KEY = 'recentlyAdded'
const RECENTLY_ADDED_CONFIG_KEY = 'recentlyAddedConfig'
const MAX_RECENTLY_ADDED = 200

function loadRecentlyAdded(): RecentlyAddedItem[] {
  try {
    const raw = configData[RECENTLY_ADDED_KEY]
    if (Array.isArray(raw)) return raw as RecentlyAddedItem[]
  } catch { /* ignore */ }
  return []
}

function saveRecentlyAdded(items: RecentlyAddedItem[]): void {
  configData[RECENTLY_ADDED_KEY] = items
  saveConfigFile()
}

function loadRecentlyAddedConfig(): RecentlyAddedConfig {
  try {
    const raw = configData[RECENTLY_ADDED_CONFIG_KEY]
    if (raw && typeof raw === 'object') {
      return {
        enabled: (raw as any).enabled !== false,
        displayCount: (raw as any).displayCount || 12,
        scrollSpeed: (raw as any).scrollSpeed || 1,
        scrollPosition: (raw as any).scrollPosition || 0
      }
    }
  } catch { /* ignore */ }
  return {
    enabled: true,
    displayCount: 12,
    scrollSpeed: 1,
    scrollPosition: 0
  }
}

function saveRecentlyAddedConfig(config: RecentlyAddedConfig): void {
  configData[RECENTLY_ADDED_CONFIG_KEY] = config
  saveConfigFile()
}

ipcMain.handle('recentlyAdded:list', async (_event, limit?: number) => {
  try {
    let items = loadRecentlyAdded()

    items = items.filter(item => {
      const isValid = typeof item.addedAt === 'number' && item.addedAt > 0 && item.addedAt < Date.now() + 86400000
      if (!isValid) {
        console.warn(`[RecentlyAdded] 过滤无效记录: "${item.name}" | itemId: ${item.itemId} | addedAt: ${item.addedAt}`)
      }
      return isValid
    })

    const beforeSort = items.map(i => `${i.name}(${i.addedAt})`).join(', ')
    console.log(`[RecentlyAdded] 查询列表 - 过滤前: ${items.length} 条, 排序前: [${beforeSort.slice(0, 200)}${beforeSort.length > 200 ? '...' : ''}]`)

    items = items.sort((a, b) => b.addedAt - a.addedAt)

    const afterSort = items.map(i => `${i.name}(${i.addedAt})`).join(', ')
    console.log(`[RecentlyAdded] 查询列表 - 排序后: [${afterSort.slice(0, 200)}${afterSort.length > 200 ? '...' : ''}]`)

    if (limit && limit > 0) {
      items = items.slice(0, limit)
    }

    console.log(`[RecentlyAdded] 查询列表 - 返回: ${items.length} 条, 第一条: ${items[0]?.name || '空'}`)

    return { success: true, data: items }
  } catch (err) {
    console.error('recentlyAdded:list failed:', err)
    return { success: false, error: String(err) }
  }
})

// M10: 最近入库写入字段白名单 + addedAt 主进程强制覆盖，防伪造置顶刷屏
function sanitizeRecentlyAddedItem(item: unknown, forcedAt: number): RecentlyAddedItem | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  if (typeof it.itemId !== 'string' || !it.itemId || typeof it.name !== 'string' || !it.name) return null
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)
  return {
    itemId: it.itemId.slice(0, 128),
    name: it.name.slice(0, 256),
    type: it.type === 'Episode' ? 'Episode' : it.type === 'Series' ? 'Series' : 'Movie',
    productionYear: num(it.productionYear),
    imageTag: str(it.imageTag, 128),
    seriesName: str(it.seriesName, 256),
    seriesId: str(it.seriesId, 128),
    seasonId: str(it.seasonId, 128),
    indexNumber: num(it.indexNumber),
    parentIndexNumber: num(it.parentIndexNumber),
    addedAt: forcedAt
  }
}

ipcMain.handle('recentlyAdded:add', async (_event, item: RecentlyAddedItem) => {
  try {
    const entry = sanitizeRecentlyAddedItem(item, Date.now())
    if (!entry) return { success: false, error: 'invalid recentlyAdded item' }
    const items = loadRecentlyAdded()
    const idx = items.findIndex((i) => i.itemId === entry.itemId)
    if (idx >= 0) {
      items.splice(idx, 1)
    }
    items.unshift(entry)
    if (items.length > MAX_RECENTLY_ADDED) {
      items.length = MAX_RECENTLY_ADDED
    }
    saveRecentlyAdded(items)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:add failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('recentlyAdded:addBatch', async (_event, newItems: RecentlyAddedItem[]) => {
  try {
    const items = loadRecentlyAdded()
    const now = Date.now()

    console.log(`[RecentlyAdded] 批量添加 - 待添加: ${newItems.length} 条`)

    for (let i = 0; i < newItems.length; i++) {
      // addedAt 由主进程按批次顺序生成，不接受渲染端传入值
      const entry = sanitizeRecentlyAddedItem(newItems[i], now + i)
      if (!entry) continue
      const idx = items.findIndex((it) => it.itemId === entry.itemId)
      if (idx >= 0) {
        items.splice(idx, 1)
        console.log(`[RecentlyAdded] 批量添加 - 更新已有记录: "${entry.name}"`)
      }
      items.unshift(entry)
      console.log(`[RecentlyAdded] 批量添加 - 新增记录: "${entry.name}" | 时间戳: ${entry.addedAt}`)
    }

    if (items.length > MAX_RECENTLY_ADDED) {
      const removed = items.length - MAX_RECENTLY_ADDED
      items.length = MAX_RECENTLY_ADDED
      console.log(`[RecentlyAdded] 批量添加 - 超出最大限制，移除 ${removed} 条旧记录`)
    }

    saveRecentlyAdded(items)
    console.log(`[RecentlyAdded] 批量添加 - 完成，总数: ${items.length} 条`)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:addBatch failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('recentlyAdded:clear', async () => {
  try {
    saveRecentlyAdded([])
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:clear failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('recentlyAdded:getConfig', async () => {
  try {
    const config = loadRecentlyAddedConfig()
    return { success: true, data: config }
  } catch (err) {
    console.error('recentlyAdded:getConfig failed:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('recentlyAdded:saveConfig', async (_event, partialConfig: Partial<RecentlyAddedConfig>) => {
  try {
    const current = loadRecentlyAddedConfig()
    const updated = { ...current, ...partialConfig }
    saveRecentlyAddedConfig(updated)
    return { success: true }
  } catch (err) {
    console.error('recentlyAdded:saveConfig failed:', err)
    return { success: false, error: String(err) }
  }
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

// ==================== 本地路径访问控制（M1 纵深防御） ====================
// 渲染进程若被 XSS 攻陷，路径类 IPC（file:get-url / video:get-info /
// danmaku:parse-local-xml 等）可被当作任意文件读取原语。这里维护一个持久化的
// "允许目录根"清单：仅用户通过系统对话框明确打开过的目录（及 userData）
// 放行，路径类 IPC 一律校验归属前缀

const LOCAL_ALLOWED_ROOTS_KEY = 'local:allowed-roots'
const allowedPathRoots = new Set<string>(
  Array.isArray(configData[LOCAL_ALLOWED_ROOTS_KEY])
    ? (configData[LOCAL_ALLOWED_ROOTS_KEY] as string[])
    : []
)

function normPathForCompare(p: string): string {
  const resolved = pathResolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function addAllowedRoot(p: string): void {
  try {
    const norm = normPathForCompare(p)
    if (!allowedPathRoots.has(norm)) {
      allowedPathRoots.add(norm)
      configData[LOCAL_ALLOWED_ROOTS_KEY] = Array.from(allowedPathRoots)
      saveConfigFile()
    }
  } catch { /* ignore invalid path */ }
}

function isPathAllowed(p: string): boolean {
  try {
    const norm = normPathForCompare(p)
    // userData 下的文件（弹幕缓存/XML 等）始终允许
    const udNorm = normPathForCompare(app.getPath('userData'))
    if (norm === udNorm || norm.startsWith(udNorm + pathSep)) return true
    for (const root of allowedPathRoots) {
      if (norm === root || norm.startsWith(root + pathSep)) return true
    }
    return false
  } catch { return false }
}

function denyPath(reason = '路径不在允许目录内（请通过"打开文件/文件夹"重新授权访问）'): { success: false; error: string } {
  return { success: false, error: reason }
}

ipcMain.handle('video:get-info', async (_event, filePath: string) => {
  if (!isPathAllowed(filePath)) {
    console.warn('[video:get-info] rejected path:', filePath)
    return denyPath()
  }
  return await getLocalVideoInfo(filePath)
})

ipcMain.handle('file:open-file', async () => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  const result = await dialog.showOpenDialog(mainWindow, {
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
  addAllowedRoot(dirname(filePath))
  return { success: true, data: { filePath } }
})

ipcMain.handle('file:open-folder', async () => {
  if (!mainWindow) return { success: false, error: '主窗口未创建' }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '未选择文件夹' }
  }
  const folderPath = result.filePaths[0]
  console.log('file:open-folder selected:', folderPath)
  addAllowedRoot(folderPath)
  const scanResult = await scanVideoFolder(folderPath)
  return scanResult
})

ipcMain.handle('file:scan-folder', async (_event, folderPath: string) => {
  console.log('file:scan-folder', folderPath)
  if (!isPathAllowed(folderPath)) {
    console.warn('[file:scan-folder] rejected path:', folderPath)
    return denyPath()
  }
  return await scanVideoFolder(folderPath)
})

ipcMain.handle('file:get-url', async (_event, filePath: string) => {
  try {
    if (!isPathAllowed(filePath)) {
      console.warn('[file:get-url] rejected path:', filePath)
      return denyPath()
    }
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
  const storeAppId = configData['danmaku:app-id'] as string | undefined
  const storeAppSecret = configData['danmaku:app-secret'] as string | undefined

  return {
    primary: storePrimary || 'https://api.dandanplay.net',
    mirrors: (storeMirrors && storeMirrors.length > 0) ? storeMirrors : [],
    appId: storeAppId || '',
    appSecret: storeAppSecret || ''
  }
}

// maskSecret 已移至 ./lib/security.ts

ipcMain.handle('danmaku:get-config', async () => {
  const config = getDanmakuApiConfig()
  // 凭据不出主进程：只返回掩码提示，不返回 App-Secret 原文
  return {
    primary: config.primary,
    mirrors: config.mirrors,
    appId: config.appId,
    appSecretHint: config.appSecret ? maskSecret(config.appSecret) : '',
    hasAppSecret: !!config.appSecret
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
    configData['danmaku:app-id'] = config.appId
  }
  // App-Secret 留空 = 保持不变：防止"打开设置不修改再保存"把已配置的 secret 清空
  const nextSecret = resolveAppSecretInput(config.appSecret)
  if (nextSecret !== undefined) {
    configData['danmaku:app-secret'] = nextSecret
  }
  saveConfigFile()
  return { success: true }
})

ipcMain.handle('danmaku:test-api', async (_event, url: string) => {
  const startTime = Date.now()
  try {
    const testPath = '/api/v2/search/episodes'
    const config = getDanmakuApiConfig()

    const testHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'huanying/1.0 (Electron)'
    }
    if (config.appId) testHeaders['App-ID'] = config.appId
    if (config.appSecret) testHeaders['App-Secret'] = config.appSecret

    const response = await nodeFetch(
      `${url}${testPath}?anime=${encodeURIComponent('测试')}`,
      {
        headers: testHeaders
      }
    )
    const elapsed = Date.now() - startTime

    if (!response.ok) {
      const bodyText = await readResponseBody(response).catch(() => '')
      return {
        success: true,
        data: { success: false, error: `HTTP ${response.status}`, detail: bodyText.slice(0, 300), elapsed }
      }
    }

    const contentType = response.headers.get('content-type') || ''
    const bodyText = await readResponseBody(response)

    if (!contentType.includes('application/json')) {
      return {
        success: true,
        data: { success: false, error: '返回非 JSON', detail: bodyText.slice(0, 300), elapsed }
      }
    }

    const data = JSON.parse(bodyText) as Record<string, unknown>
    const animes = data.animes as Array<Record<string, unknown>> | undefined
    const animeCount = animes?.length || 0
    const epCount = animes?.reduce(
      (sum: number, a: Record<string, unknown>) =>
        sum + ((a.episodes as Array<unknown>)?.length || 0),
      0
    ) || 0

    return { success: true, data: { success: true, elapsed, animeCount, epCount } }
  } catch (err) {
    return {
      success: true,
      data: { success: false, error: String(err), elapsed: Date.now() - startTime }
    }
  }
})

// 本地 XML 弹幕解析（B站格式）
ipcMain.handle('danmaku:parse-local-xml', async (_event, xmlPath: string) => {
  if (!isPathAllowed(xmlPath)) {
    console.warn('[danmaku:parse-local-xml] rejected path:', xmlPath)
    return denyPath()
  }
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
  // 只在视频同目录找同名 XML，videoPath 本身必须归属允许目录
  if (!isPathAllowed(videoPath)) {
    console.warn('[danmaku:find-local-xml] rejected path:', videoPath)
    return denyPath()
  }
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

// 弹幕 HTTP 请求：使用全局 fetch。
// 关键修复：用 Promise.race 实现超时，而非 AbortController。
// 原因：Electron 主进程中 fetch 的 AbortSignal 对 Tailscale IP (100.66.x.x) 无法真正中断连接，
// 导致 fetch 挂起至 OS TCP 超时 (30-60s)。Promise.race 可立即返回超时错误。
async function nodeFetch(url: string, options?: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string }): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json<T>(): Promise<T> }> {
  const timeout = options?.timeoutMs ?? 10000
  let fetchResult: { ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json: <T>() => Promise<T> } | null = null
  let fetchError: Error | null = null

  let timer: ReturnType<typeof setTimeout> | null = null
  const fetchPromise = fetch(url, {
    method: options?.method || 'GET',
    headers: options?.headers || {},
    body: options?.body
  }).then((response) => {
    if (timer) clearTimeout(timer)
    fetchResult = {
      ok: response.ok,
      status: response.status,
      headers: { get: (name: string): string | null => response.headers.get(name) },
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>
    }
  }).catch((err: unknown) => {
    if (timer) clearTimeout(timer)
    fetchError = err instanceof Error ? err : new Error(String(err))
  })

  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout)
  })

  try {
    await Promise.race([fetchPromise, timeoutPromise])
  } catch (err) {
    // 超时或 fetch 错误
    if (timer) clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg)
  }

  // fetch 完成但可能已超时被忽略（不影响我们，因 race 已返回）
  if (fetchError) throw fetchError
  if (!fetchResult) throw new Error(`Request failed: no result`)
  return fetchResult
}

async function readResponseBody(response: { text(): Promise<string> }): Promise<string> {
  return response.text()
}

async function dandanRequest<T>(path: string, retries = 1, body?: unknown, timeoutMs = 5000): Promise<T> {
  let lastError: Error | null = null
  const config = getDanmakuApiConfig()
  const allUrls = [config.primary, ...config.mirrors]

  const isPost = body !== undefined
  console.log(`[danmaku] Using primary=${config.primary}, mirrors=${config.mirrors.join(',')}, appId=${config.appId ? 'configured' : 'missing'}, method=${isPost ? 'POST' : 'GET'}, timeoutMs=${timeoutMs}`)

  const authHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'huanying/1.0 (Electron)'
  }
  if (config.appId) authHeaders['App-ID'] = config.appId
  if (config.appSecret) authHeaders['App-Secret'] = config.appSecret
  if (isPost) authHeaders['Content-Type'] = 'application/json'

  for (const baseUrl of allUrls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[danmaku] 重试 ${baseUrl} (第${attempt}次)`)
          await new Promise(r => setTimeout(r, 300 * attempt))
        }
        const url = `${baseUrl}${path}`
        console.log(`[danmaku] ${isPost ? 'POST' : 'GET'} ${url}`)

        const fetchOpts: { headers: Record<string, string>; timeoutMs: number; method?: string; body?: string } = {
          headers: authHeaders,
          timeoutMs
        }
        if (isPost) {
          fetchOpts.method = 'POST'
          fetchOpts.body = JSON.stringify(body)
        }

        const response = await nodeFetch(url, fetchOpts)

        console.log(`[danmaku] ${baseUrl} → HTTP ${response.status}, content-type=${response.headers.get('content-type')}`)

        if (!response.ok) {
          const bodyText = await readResponseBody(response).catch(() => '')
          const errMsg = response.headers.get('x-error-message') || ''
          const detail = bodyText.slice(0, 500) || errMsg || '(empty body)'
          let msg = `DandanPlay ${baseUrl} 返回 HTTP ${response.status}: ${detail}`
          if (response.status === 403 && !config.appId) {
            msg = `DandanPlay API 需要认证 (HTTP 403)。请在设置中配置 App-ID 和 App-Secret（在 https://api.dandanplay.net/registerApp 免费注册）`
          }
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
        'User-Agent': 'huanying/1.0',
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
        'User-Agent': 'huanying/1.0',
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

  // Step 4: Match episode by number（不强制回退第1集）
  let matchedEp: BilibiliEpisode | null = null
  if (epNum > 0 && epNum <= episodes.length) {
    matchedEp = episodes[epNum - 1]
  }

  if (!matchedEp) {
    console.warn(`[bilibili] 未匹配到集号 epNum=${epNum}（共 ${episodes.length} 集），不强制回退第1集`)
    bilibiliMatchCache.set(title, null)
    return null
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
        'User-Agent': 'huanying/1.0',
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
    // 预加载系列弹幕期间自建 API 繁忙（每集 comment ~10s），search 默认 5s 会
    // 超时落入 Bilibili fallback（其结果 episodes 全空，导致 UI 显示"搜不到"），
    // 放宽到 10s 优先拿到真实搜索结果
    const result = await dandanRequest<DanmakuSearchResponse>(
      `/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`,
      1,
      undefined,
      10000
    )
    return { success: true, data: result }
  } catch (err) {
    console.error('danmaku:search failed:', err)
    // 回退到 Bilibili 搜索
    try {
      const searchResp = await nodeFetch(
        `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(keyword)}`,
        {
          headers: {
            'User-Agent': 'huanying/1.0',
            'Referer': 'https://www.bilibili.com/',
            'Accept': 'application/json'
          }
        }
      )
      if (searchResp.ok) {
        const searchData = await searchResp.json() as { code: number; data: { result: Array<{ season_id: number; title: string }> } }
        if (searchData.code === 0 && searchData.data?.result?.length) {
          // Bilibili fallback 拿不到集列表（episodes 全空），渲染端会拼出 0 条结果。
          // 若当作 success 返回，UI 显示"未找到匹配弹幕"误导用户；改为明确失败
          return { success: false, error: '弹幕 API 搜索超时（Bilibili 备用源无集列表）' }
        }
      }
    } catch (blErr) {
      console.error('danmaku:search bilibili fallback failed:', blErr)
    }
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
  // 匹配集号模式，同时记录匹配位置以截取动漫名称
  // 注意：S\d+E\d+ 必须在 E\d+ 之前，否则 "S01E02" 会被 "E02" 部分匹配
  const epMatch = clean.match(/S\d+E(\d{1,3})/i)
    || clean.match(/E(?:P(?:isode)?)?\s*(\d{1,3})/i)
    || clean.match(/第\s*(\d{1,3})\s*[话集]/)
    || clean.match(/\s(\d{1,3})\s*[话集]?$/)
    || clean.match(/^(.+?)(\d{1,3})$/);
  if (epMatch) {
    epNum = epMatch[epMatch.length === 3 ? 2 : 1].padStart(2, '0')
  }

  // 只取集号模式之前的文本作为动漫名称，丢弃集号后的描述（如 "- 门派夺密宝江湖风波起"）
  let animeKeyword = clean
  if (epMatch && epMatch.index !== undefined) {
    animeKeyword = clean.slice(0, epMatch.index)
  } else {
    animeKeyword = clean
      .replace(/E(?:P(?:isode)?)?\s*\d{1,3}/gi, '')
      .replace(/第\s*\d{1,3}\s*[话集]/g, '')
      .replace(/S\d+E\d{1,3}/gi, '')
      .replace(/\s(\d{1,3})\s*[话集]?$/, '')
      .replace(/^(.+?)(\d{1,3})$/, '$1')
  }
  // 清理尾部标点和空格
  animeKeyword = animeKeyword.replace(/[\s\-—_·:：]+$/, '').trim()

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
          'User-Agent': 'huanying/1.0',
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
      `/api/v2/comment/${episodeId}`,
      1,
      undefined,
      25000
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
      `/api/v2/comment/${episodeId}`,
      1,
      undefined,
      25000
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

ipcMain.handle('danmaku:prefetch-series', async (_event, animeId: number, currentEpisodeId?: number) => {
  console.log(`[danmaku:prefetch] 开始预下载 animeId=${animeId}, 跳过当前集=${currentEpisodeId ?? 'none'}`)
  try {
    // 获取全季剧集列表
    const bangumiResult = await dandanRequest<{ bangumi?: { episodes?: BangumiEpisode[] } }>(
      `/api/v2/bangumi/${animeId}`
    )
    const episodes = bangumiResult.bangumi?.episodes || []
    console.log(`[danmaku:prefetch] animeId=${animeId} 共 ${episodes.length} 集`)

    let cachedCount = 0
    let fetchedCount = 0
    let skippedCount = 0
    for (const ep of episodes) {
      // 跳过当前正在播放的集，避免预下载与当前集请求竞争导致超时
      if (currentEpisodeId != null && ep.episodeId === currentEpisodeId) {
        skippedCount++
        continue
      }
      // 检查缓存中是否已有
      if (getCachedComments(ep.episodeId)) {
        cachedCount++
        continue
      }
      try {
        const result = await dandanRequest<{ count: number; comments: DanmakuCommentRaw[] }>(
          `/api/v2/comment/${ep.episodeId}`,
          1,
          undefined,
          25000
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
        // 限流：每集间延迟 2 秒，避免轰炸 API 触发 429
        await new Promise(r => setTimeout(r, 2000))
      } catch (err) {
        console.warn(`[danmaku:prefetch] 下载失败 ep=${ep.episodeId}:`, err)
        // 遇到 429 限流时延长等待
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('429')) {
          console.log(`[danmaku:prefetch] 检测到 429 限流，等待 10 秒后继续`)
          await new Promise(r => setTimeout(r, 10000))
        }
      }
    }
    console.log(`[danmaku:prefetch] animeId=${animeId} 完成: 缓存命中 ${cachedCount}, 新下载 ${fetchedCount}, 跳过 ${skippedCount}`)
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

// ====================================================================
// 弹幕剧集匹配引擎 V2（多级优先级架构，对标弹弹play / Animeko / Jellyfin 弹幕插件）
//
// 匹配优先级（命中即停止降级）：
//   ① manual     手动绑定缓存（用户曾手动指定，最高优先级，精准不复用错集）
//   ② id         媒体源外部ID精准匹配（providerIds: imdb/tvdb，弹弹play暂不支持直查，预留）
//   ③ hash       视频文件特征值匹配（弹弹play /api/v2/match，需文件hash，预留）
//   ④ metadata   结构化元数据严格配对（seriesName + year + season + episode）
//   ⑤ regex      文件名正则解析（独立 season/episode 字段）补充元数据缺失后走 ④
//   ⑥ candidates 以上全部低置信度 → 返回候选列表，UI 手动选择 → 持久化为 ①
//
// 核心 BUG 修复（解决"切第2集仍显示第1集弹幕"）：
//   - 缓存 Key = mediaSourceId + seriesId + season + episode（一集一条独立缓存）
//   - season / episode 独立数值强校验，禁止只匹配剧名忽略集号
//   - 切集时渲染层强制 cancel + 清状态，主进程按结构化 Key 隔离
// ====================================================================

// ---------- 中文数字转阿拉伯 ----------
function cn2num(s: string): number {
  const map: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s === '十') return 10
  if (s.startsWith('十')) return 10 + (map[s[1]] || 0)
  if (s.endsWith('十')) return (map[s[0]] || 0) * 10
  if (s.includes('十')) { const parts = s.split('十'); return (map[parts[0]] || 0) * 10 + (map[parts[1]] || 0) }
  return map[s] || 0
}

// ---------- 文件名/标题 清洗 ----------
function cleanName(s: string): string {
  return (s || '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-—_·:：]+$/, '')
    .replace(/^[\s\-—_·:：]+/, '')
    .trim()
}

// ---------- 文件名正则解析器（独立 season / episode 字段，覆盖业界通用命名） ----------
// 覆盖：S01E02, 1x02, EP02, 第2集/第二话, [02], -02-, 末尾独立数字 02
// 必须区分季、集两个独立字段，不能混为一谈
function parseSeasonEpisode(input: string): { season: number | null; episode: number | null; animeName: string } {
  if (!input) return { season: null, episode: null, animeName: '' }
  // 去扩展名 + 去封装标记
  let s = input.replace(/\.[A-Za-z0-9]{2,4}$/, '')
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ').replace(/\([^)]*\)/g, ' ')
  // 去分辨率/编码噪音
  s = s.replace(/\b(1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL|BluRay|x264|x265|H264|HEVC|AVC|AAC|FLAC|AUTO)\b/gi, ' ')

  let season: number | null = null
  let episode: number | null = null
  let matchIdx = -1
  let m: RegExpMatchArray | null

  // S01E02 / s01e02（季+集成对，最高优先级，必须先于 E02 匹配）
  m = s.match(/S(\d{1,2})\s*E(\d{1,3})/i)
  if (m) { season = +m[1]; episode = +m[2]; matchIdx = m.index! }
  // 1x02（季x集）
  if (episode == null) { m = s.match(/(\d{1,2})[xX](\d{1,3})/); if (m) { season = +m[1]; episode = +m[2]; matchIdx = m.index! } }
  // EP02 / Episode 02 / E02
  if (episode == null) { m = s.match(/E(?:P(?:isode)?)?\s*(\d{1,3})/i); if (m) { episode = +m[1]; matchIdx = m.index! } }
  // 第2集 / 第02话 / 第二集（中文）
  if (episode == null) { m = s.match(/第\s*([0-9一二三四五六七八九十]+)\s*[话集篇章]/); if (m) { episode = cn2num(m[1]); matchIdx = m.index! } }
  // [02] 单独方括号集号
  if (episode == null) { m = s.match(/\[(\d{1,3})\]/); if (m) { episode = +m[1]; matchIdx = m.index! } }
  // -02- / _02_ 短横线/下划线集号
  if (episode == null) { m = s.match(/[-_]\s*(\d{1,3})\s*[-_]/); if (m) { episode = +m[1]; matchIdx = m.index! } }
  // 末尾独立数字  Name 02
  if (episode == null) { m = s.match(/[\s._](\d{1,3})\s*$/); if (m) { episode = +m[1]; matchIdx = m.index! } }

  const animeName = matchIdx >= 0 ? cleanName(s.slice(0, matchIdx)) : cleanName(s)
  return { season, episode, animeName }
}

// ---------- 从 animeTitle 推断季号（如 "庆余年 第二季" → 2, "Xxx Season 3" → 3） ----------
function inferSeasonFromTitle(title: string): number | null {
  if (!title) return null
  let m = title.match(/第\s*([0-9一二三四五六七八九十]+)\s*季/)
  if (m) return cn2num(m[1])
  m = title.match(/Season\s*(\d{1,2})/i)
  if (m) return +m[1]
  return null
}

// ---------- 标题归一化（去"第X季/Season X"后比较） ----------
function normalizeTitle(t: string): string {
  return (t || '')
    .replace(/第\s*[0-9一二三四五六七八九十]+\s*季/g, '')
    .replace(/Season\s*\d{1,2}/gi, '')
    .replace(/[\s\-_·:：]+/g, '')
    .toLowerCase()
    .trim()
}

// ---------- 标题相似度打分（0-1） ----------
function scoreTitleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  // 字符重叠率（兜底模糊）
  let common = 0
  for (const ch of na) if (nb.includes(ch)) common++
  return Math.min(0.6, common / Math.max(na.length, nb.length))
}

// ---------- anime 候选打分（标题 + 季号严格配对 + 年份） ----------
function scoreAnimeCandidate(
  meta: DanmakuMatchMeta,
  anime: { animeId: number; animeTitle: string }
): { score: number; seasonHint: number | null } {
  const titleScore = scoreTitleSimilarity(meta.seriesName || meta.title || '', anime.animeTitle)
  const seasonHint = inferSeasonFromTitle(anime.animeTitle)
  let score = titleScore
  // 季号严格配对：元数据有 parentIndexNumber 且能从 animeTitle 推断季号
  if (meta.parentIndexNumber != null && seasonHint != null) {
    if (seasonHint === meta.parentIndexNumber) score += 0.15   // 季号吻合，加分
    else score -= 0.3                                          // 季号不符，重罚（防止跨季串弹幕）
  }
  // 元数据是第1季且 animeTitle 无季号标记（默认第1季），轻微加分
  if (meta.parentIndexNumber === 1 && seasonHint == null) score += 0.05
  return { score: Math.max(0, Math.min(1, score)), seasonHint }
}

// ---------- 结构化匹配缓存 V2 ----------
// Key = mediaSourceId + seriesId + season + episode（一集一条独立缓存，杜绝按剧名单键串集）
interface MatchCacheV2Entry {
  episodeId: number
  animeId?: number
  animeTitle?: string
  episodeTitle?: string
  source: string
  matchLevel: DanmakuMatchLevel
  confidence: number
  cachedAt: number
}

function getMatchCacheDirV2(): string {
  const dir = join(app.getPath('userData'), 'danmaku_match_cache_v2')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function matchCacheKeyV2(meta: DanmakuMatchMeta): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
  const season = meta.parentIndexNumber ?? 0
  const episode = meta.indexNumber ?? 0
  const series = meta.seriesId || meta.seriesName || 'unknown'
  return `${safe(meta.mediaSourceId)}__${safe(series)}__S${season}__E${episode}`
}

function getCachedMatchV2(meta: DanmakuMatchMeta): MatchCacheV2Entry | null {
  // 修复串集：season/episode 缺失时不读缓存，避免 S0E0 错误缓存导致所有集都命中第1集
  if (meta.indexNumber == null || meta.parentIndexNumber == null) return null
  try {
    const file = join(getMatchCacheDirV2(), `${matchCacheKeyV2(meta)}.json`)
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf-8')) as MatchCacheV2Entry
    if (!data || !data.episodeId) return null
    if (Date.now() - data.cachedAt > 7 * 24 * 60 * 60 * 1000) return null
    return data
  } catch { return null }
}

function writeCachedMatchV2(meta: DanmakuMatchMeta, data: Omit<MatchCacheV2Entry, 'cachedAt'>): void {
  // 修复串集：season/episode 缺失时不写缓存，避免 S0E0 错误缓存污染
  if (meta.indexNumber == null || meta.parentIndexNumber == null) return
  try {
    const file = join(getMatchCacheDirV2(), `${matchCacheKeyV2(meta)}.json`)
    writeFileSync(file, JSON.stringify({ ...data, cachedAt: Date.now() }), 'utf-8')
  } catch (err) {
    console.warn(`[danmaku:match-cache-v2] 写入失败:`, err)
  }
}

// ---------- 手动绑定缓存（Key = mediaSourceId:itemId，每集唯一） ----------
function getBindCacheDir(): string {
  const dir = join(app.getPath('userData'), 'danmaku_bind_cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function bindCacheKey(mediaSourceId: string, itemId: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
  return `${safe(mediaSourceId)}__${safe(itemId)}`
}

function getBoundEpisode(mediaSourceId: string, itemId: string): DanmakuBindEntry | null {
  try {
    const file = join(getBindCacheDir(), `${bindCacheKey(mediaSourceId, itemId)}.json`)
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf-8')) as DanmakuBindEntry
    if (!data || !data.episodeId) return null
    return data
  } catch { return null }
}

function setBoundEpisode(entry: DanmakuBindEntry): void {
  try {
    const file = join(getBindCacheDir(), `${bindCacheKey(entry.mediaSourceId, entry.itemId)}.json`)
    writeFileSync(file, JSON.stringify({ ...entry, boundAt: Date.now() }), 'utf-8')
  } catch (err) {
    console.warn(`[danmaku:bind-cache] 写入失败:`, err)
  }
}

function clearBoundEpisode(mediaSourceId: string, itemId: string): void {
  try {
    const file = join(getBindCacheDir(), `${bindCacheKey(mediaSourceId, itemId)}.json`)
    if (existsSync(file)) unlinkSync(file)
  } catch { /* ignore */ }
}

// ---------- 文件 hash 计算（dandanplay 算法：≤16MB 全量 SHA1，>16MB 取首尾各 16MB） ----------
// 异步 I/O：避免主进程同步阻塞 32MB 读取导致播放启动卡顿
async function computeFileHash(filePath: string): Promise<{ hash: string; size: number } | null> {
  let fh: FileHandle | null = null
  try {
    const fileStat = await fsStat(filePath)
    const fileSize = fileStat.size
    const CHUNK = 16 * 1024 * 1024 // 16MB
    const hash = crypto.createHash('sha1')
    fh = await fsOpen(filePath, 'r')
    if (fileSize <= CHUNK) {
      const buf = Buffer.alloc(fileSize)
      await fh.read(buf, 0, fileSize, 0)
      hash.update(buf)
    } else {
      const head = Buffer.alloc(CHUNK)
      await fh.read(head, 0, CHUNK, 0)
      hash.update(head)
      const tail = Buffer.alloc(CHUNK)
      await fh.read(tail, 0, CHUNK, fileSize - CHUNK)
      hash.update(tail)
    }
    return { hash: hash.digest('hex'), size: fileSize }
  } catch (err) {
    console.error('[danmaku:hash] Failed to compute hash:', err)
    return null
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore close error */ })
  }
}

// ---------- 多级匹配引擎主逻辑 ----------
async function matchEpisodeEngine(meta: DanmakuMatchMeta): Promise<DanmakuMatchResultV2> {
  const logs: string[] = []
  const pushLog = (m: string): void => { console.log(`[danmaku:match-episode] ${m}`); logs.push(m) }
  pushLog(`=== 开始多级匹配 ===`)
  pushLog(`元数据: series="${meta.seriesName ?? ''}", season=${meta.parentIndexNumber ?? '?'}, ep=${meta.indexNumber ?? '?'}, year=${meta.productionYear ?? '?'}, itemId=${meta.itemId}`)

  // ① manual：手动绑定缓存（最高优先级）
  const bound = getBoundEpisode(meta.mediaSourceId, meta.itemId)
  if (bound) {
    pushLog(`① manual 命中: episodeId=${bound.episodeId}, source=${bound.source}`)
    return {
      success: true,
      data: { episodeId: bound.episodeId, animeId: bound.animeId, animeTitle: bound.animeTitle, episodeTitle: bound.episodeTitle, source: bound.source, matchLevel: 'manual', confidence: 1 },
      log: logs
    }
  }
  pushLog(`① manual 未命中`)

  // ② id：外部ID精准匹配（弹弹play API 暂不支持 tvdb/imdb 直查，预留降级）
  if (meta.providerIds && Object.keys(meta.providerIds).length) {
    pushLog(`② id: 检测到 providerIds=${Object.keys(meta.providerIds).join(',')}，弹弹play不支持外部ID直查，降级到元数据层`)
  } else {
    pushLog(`② id: 无 providerIds，跳过`)
  }

  // ③ hash：视频文件特征值匹配（本地文件计算 SHA1 → POST /api/v2/match）
  if (meta.filePath) {
    pushLog(`③ hash: 计算文件 hash "${meta.filePath}"`)
    const hashResult = await computeFileHash(meta.filePath)
    if (hashResult) {
      pushLog(`③ hash: ${hashResult.hash}, size=${hashResult.size}`)
      try {
        const matchResp = await dandanRequest<{
          isMatched: boolean
          matches: Array<{ animeId: number; episodeId: number; animeTitle: string; episodeTitle: string; type: string }>
        }>('/api/v2/match', 1, {
          fileName: meta.fileName || meta.title || '',
          fileHash: hashResult.hash,
          fileSize: String(hashResult.size)
        })
        if (matchResp.isMatched && matchResp.matches && matchResp.matches.length > 0) {
          const m = matchResp.matches[0]
          pushLog(`③ hash 命中: animeId=${m.animeId}, episodeId=${m.episodeId}, title="${m.animeTitle} - ${m.episodeTitle}"`)
          const entry = {
            episodeId: m.episodeId, animeId: m.animeId, animeTitle: m.animeTitle,
            episodeTitle: m.episodeTitle, source: 'dandanplay',
            matchLevel: 'hash' as DanmakuMatchLevel, confidence: 1
          }
          writeCachedMatchV2(meta, entry)
          return { success: true, data: { ...entry }, log: logs }
        }
        pushLog(`③ hash 未命中（API 返回 isMatched=false 或无 matches）`)
      } catch (err) {
        pushLog(`③ hash 请求失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      pushLog(`③ hash 计算失败，跳过`)
    }
  } else {
    pushLog(`③ hash: 无本地文件路径，跳过`)
  }

  // 计算有效 season / episode（④元数据优先，缺失则⑤正则补充）
  let season: number | null = meta.parentIndexNumber ?? null
  let episode: number | null = meta.indexNumber ?? null
  let searchName = meta.seriesName || ''

  // ⑤ regex：元数据缺失时用文件名正则补充独立 season/episode
  if ((episode == null || season == null || !searchName) && (meta.fileName || meta.title)) {
    const parsed = parseSeasonEpisode(meta.fileName || meta.title || '')
    pushLog(`⑤ regex 解析 "${meta.fileName || meta.title}": season=${parsed.season}, ep=${parsed.episode}, name="${parsed.animeName}"`)
    if (season == null && parsed.season != null) season = parsed.season
    if (episode == null && parsed.episode != null) episode = parsed.episode
    if (!searchName && parsed.animeName) searchName = parsed.animeName
  }

  if (!searchName) {
    pushLog(`❌ 无可用搜索名（seriesName/正则均未提取到）`)
    return { success: false, error: '无可用搜索名', log: logs }
  }

  // ④ metadata：结构化元数据匹配（主力层）
  pushLog(`④ metadata 搜索: anime="${searchName}", season=${season ?? '?'}, ep=${episode ?? '?'}`)
  let searchResult: DanmakuSearchResponse
  try {
    searchResult = await dandanRequest<DanmakuSearchResponse>(
      `/api/v2/search/episodes?anime=${encodeURIComponent(searchName)}`
    )
  } catch (err) {
    pushLog(`❌ 搜索请求失败: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, error: String(err), log: logs }
  }

  const animes = searchResult.animes || []
  pushLog(`搜索返回 ${animes.length} 个番剧候选`)
  if (animes.length === 0) {
    // B站回退
    pushLog(`未找到动漫，尝试 B站回退`)
    const bl = await bilibiliAutoMatch(meta.title || searchName)
    if (bl) {
      pushLog(`B站回退命中: cid=${bl.cid}, title="${bl.animeTitle}"`)
      const entry = { episodeId: bl.cid, animeTitle: bl.animeTitle, episodeTitle: bl.episodeTitle, source: 'bilibili', matchLevel: 'metadata' as DanmakuMatchLevel, confidence: 0.5 }
      writeCachedMatchV2(meta, entry)
      return { success: true, data: { ...entry }, log: logs }
    }
    return { success: false, error: '未找到匹配弹幕', log: logs }
  }

  // 对每个 anime 候选打分排序
  const scored = animes.map((a) => {
    const { score, seasonHint } = scoreAnimeCandidate(meta, a)
    return { anime: a, score, seasonHint }
  }).sort((x, y) => y.score - x.score)

  for (const s of scored.slice(0, 8)) {
    pushLog(`候选: animeId=${s.anime.animeId}, title="${s.anime.animeTitle}", score=${s.score.toFixed(2)}, seasonHint=${s.seasonHint ?? '?'}`)
  }

  const best = scored[0]
  // 最高分过低 → 返回候选列表供手动选择（⑥ candidates）
  if (!best || best.score < 0.4) {
    pushLog(`⚠️ 最高分 ${best?.score.toFixed(2) ?? 'N/A'} < 0.4，返回候选列表供手动选择`)
    const candidates: DanmakuMatchCandidate[] = []
    for (const s of scored.slice(0, 10)) {
      for (const ep of (s.anime.episodes || [])) {
        candidates.push({
          episodeId: ep.episodeId, animeId: s.anime.animeId, animeTitle: s.anime.animeTitle,
          episodeTitle: ep.episodeTitle, source: ep.source || 'dandanplay', score: s.score, seasonHint: s.seasonHint ?? undefined
        })
      }
    }
    return { success: false, error: '低置信度，需手动选择', candidates: candidates.slice(0, 30), log: logs }
  }

  // 在最优 anime 的 episodes 中用集号定位（集号强校验，不强制回退第1集）
  const episodes = best.anime.episodes || []
  pushLog(`最优番剧: "${best.anime.animeTitle}" (${episodes.length} 集)，用 ep=${episode ?? '?'} 定位`)
  let matchedEp: typeof episodes[0] | null = null
  let confidence = best.score
  if (episode != null && episodes.length > 0) {
    const epIndex = episode - 1
    if (epIndex >= 0 && epIndex < episodes.length) {
      matchedEp = episodes[epIndex]
      pushLog(`集号定位: ep#${episode} → "${matchedEp.episodeTitle}"`)
    } else {
      // 集号超出范围：按 episodeTitle 中的数字兜底匹配
      pushLog(`⚠️ 集号 #${episode} 超出范围 (1-${episodes.length})，按 episodeTitle 数字匹配`)
      const byTitle = episodes.find((e) => {
        const m = e.episodeTitle.match(/(\d{1,3})/)
        return m && +m[1] === episode
      })
      if (byTitle) {
        matchedEp = byTitle
        confidence = best.score * 0.9
        pushLog(`按标题匹配: "${byTitle.episodeTitle}"`)
      }
    }
  }

  // 无集号或集号未命中 → 不强制回退第1集，返回候选列表供手动选择
  if (!matchedEp) {
    pushLog(`⚠️ 未能定位到具体集（episode=${episode ?? 'null'}），返回候选列表（不强制回退第1集）`)
    const candidates: DanmakuMatchCandidate[] = []
    for (const s of scored.slice(0, 10)) {
      for (const ep of (s.anime.episodes || [])) {
        candidates.push({
          episodeId: ep.episodeId, animeId: s.anime.animeId, animeTitle: s.anime.animeTitle,
          episodeTitle: ep.episodeTitle, source: ep.source || 'dandanplay', score: s.score, seasonHint: s.seasonHint ?? undefined
        })
      }
    }
    return { success: false, error: '未定位到集号，需手动选择', candidates: candidates.slice(0, 30), log: logs }
  }

  // 季号严格校验：元数据有 parentIndexNumber 且 best 推断季号不符 → 置信度减半
  if (meta.parentIndexNumber != null && best.seasonHint != null && best.seasonHint !== meta.parentIndexNumber) {
    confidence *= 0.5
    pushLog(`⚠️ 季号不符 (meta=${meta.parentIndexNumber}, anime=${best.seasonHint})，置信度减半`)
  }

  const level: DanmakuMatchLevel = (meta.indexNumber == null && episode != null) ? 'regex' : 'metadata'
  pushLog(`✅ 匹配完成: episodeId=${matchedEp.episodeId}, level=${level}, confidence=${confidence.toFixed(2)}`)

  // 写结构化缓存（一集一条，Key 含 season+episode，杜绝串集）
  writeCachedMatchV2(meta, {
    episodeId: matchedEp.episodeId, animeId: best.anime.animeId, animeTitle: best.anime.animeTitle,
    episodeTitle: matchedEp.episodeTitle, source: matchedEp.source || 'dandanplay',
    matchLevel: level, confidence
  })

  const result: DanmakuMatchResultV2 = {
    success: true,
    data: {
      episodeId: matchedEp.episodeId, animeId: best.anime.animeId, animeTitle: best.anime.animeTitle,
      episodeTitle: matchedEp.episodeTitle, source: matchedEp.source || 'dandanplay',
      matchLevel: level, confidence
    },
    log: logs
  }

  // 低置信度同时返回候选（UI 手动确认兜底）
  if (confidence < 0.6) {
    const candidates: DanmakuMatchCandidate[] = []
    for (const s of scored.slice(0, 5)) {
      for (const ep of (s.anime.episodes || [])) {
        candidates.push({
          episodeId: ep.episodeId, animeId: s.anime.animeId, animeTitle: s.anime.animeTitle,
          episodeTitle: ep.episodeTitle, source: ep.source || 'dandanplay', score: s.score, seasonHint: s.seasonHint ?? undefined
        })
      }
    }
    result.candidates = candidates.slice(0, 20)
    pushLog(`置信度 < 0.6，附带 ${result.candidates.length} 个候选供手动确认`)
  }
  return result
}

// ---------- IPC: 多级匹配 ----------
ipcMain.handle('danmaku:match-episode', async (_event, meta: DanmakuMatchMeta): Promise<DanmakuMatchResultV2> => {
  try {
    // 查结构化匹配缓存（按 season+episode 隔离）
    // 关键：有本地文件路径（hash-eligible）时，仅信任 hash/manual 级缓存；
    // 弱结果（metadata/regex）缓存必须跳过，让 hash 分支有机会执行更精准匹配
    const cached = getCachedMatchV2(meta)
    if (cached) {
      const isHashEligible = !!meta.filePath
      const isHighConfidence = cached.matchLevel === 'hash' || cached.matchLevel === 'manual'
      if (!isHashEligible || isHighConfidence) {
        console.log(`[danmaku:match-episode] 命中结构化缓存: episodeId=${cached.episodeId}, level=${cached.matchLevel}`)
        return {
          success: true,
          data: {
            episodeId: cached.episodeId, animeId: cached.animeId, animeTitle: cached.animeTitle,
            episodeTitle: cached.episodeTitle, source: cached.source, matchLevel: cached.matchLevel, confidence: cached.confidence
          },
          log: [`命中结构化匹配缓存 (episodeId=${cached.episodeId})`]
        }
      }
      console.log(`[danmaku:match-episode] 跳过弱缓存(level=${cached.matchLevel})，有本地文件路径，优先尝试 hash 匹配`)
    }
    return await matchEpisodeEngine(meta)
  } catch (err) {
    console.error('[danmaku:match-episode] 致命错误:', err)
    return { success: false, error: String(err) }
  }
})

// ---------- IPC: 手动绑定弹幕源（持久化，下次直接复用精准ID） ----------
ipcMain.handle('danmaku:bind-episode', async (_event, entry: DanmakuBindEntry) => {
  setBoundEpisode(entry)
  console.log(`[danmaku:bind-episode] 已绑定 ${entry.mediaSourceId}:${entry.itemId} → episodeId=${entry.episodeId} (${entry.source})`)
  return { success: true }
})

// ---------- IPC: 清除手动绑定 ----------
ipcMain.handle('danmaku:clear-bind', async (_event, mediaSourceId: string, itemId: string) => {
  clearBoundEpisode(mediaSourceId, itemId)
  console.log(`[danmaku:clear-bind] 已清除绑定 ${mediaSourceId}:${itemId}`)
  return { success: true }
})

// ---------- IPC: 获取候选列表（强制重新匹配，不读缓存） ----------
ipcMain.handle('danmaku:get-candidates', async (_event, meta: DanmakuMatchMeta): Promise<DanmakuMatchResultV2> => {
  return await matchEpisodeEngine(meta)
})

// ==================== 文件操作 ====================

// ==================== 自定义协议: douban-img (豆瓣图片反盗链) ====================

const DOUBAN_IMG_CACHE = new Map<string, { buffer: Buffer; mime: string }>()
const DOUBAN_IMG_CACHE_MAX = 50

function registerDoubanImageProtocol(): void {
  protocol.handle('douban-img', (request) => {
    const url = decodeURIComponent(request.url.replace('douban-img://', ''))
    // 白名单：douban-img 协议仅允许抓取豆瓣官方图片域名，防止被当作任意 URL 抓取跳板
    if (!isAllowedDoubanImageUrl(url)) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }))
    }

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
        // 写入前若已达上限，淘汰最旧条目，防止内存无限增长
        if (DOUBAN_IMG_CACHE.size >= DOUBAN_IMG_CACHE_MAX && !DOUBAN_IMG_CACHE.has(url)) {
          const oldestKey = DOUBAN_IMG_CACHE.keys().next().value
          if (oldestKey !== undefined) DOUBAN_IMG_CACHE.delete(oldestKey)
        }
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

// 图片协议专用 fetch：手动处理重定向。net.fetch 自动跟随重定向时会把自定义请求头
// （X-Emby-Token）原样带到重定向目标域，被控服务器可 302 到第三方域窃取令牌。
// 策略：仅允许同源重定向一次，跨域 3xx 一律拒绝
async function fetchImageWithToken(realUrl: string, headers: Record<string, string>): Promise<Response> {
  const fetchOnce = (target: string): Promise<Response> =>
    net.fetch(target, {
      signal: AbortSignal.timeout(15000),
      bypassCustomProtocolHandlers: true,
      headers,
      redirect: 'manual'
    })

  const first = await fetchOnce(realUrl)
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get('location')
    if (!loc) throw new Error(`${first.status} redirect without location`)
    const next = new URL(loc, realUrl)
    if (next.origin !== new URL(realUrl).origin) {
      throw new Error(`cross-origin redirect blocked: ${next.origin}`)
    }
    return await fetchOnce(next.toString())
  }
  return first
}


/** 图片协议统一解析。支持两种 URL 格式：
 * 1. 新格式（推荐）：<proto>://<serverId>/Items/...?query
 *    serverId 精确匹配服务器，真实 URL = 服务器 origin + basePath + path，
 *    scheme 完全由服务器配置决定 —— 配置 https 的服务器不可能被降级为 http
 * 2. 旧格式（兼容已落盘的历史链接）：<proto>://<scheme>/<host><basePath>/Items/...
 *    按 origin+basePath 最长前缀匹配服务器 —— 同 host 不同 basePath 不会串 token，
 *    scheme 必须与服务器配置一致（https 配置拒绝 http 请求）
 * 匹配失败返回 null（协议层回 403），防止协议被滥用于任意内网探测 */
/** 仅允许访问图片 API：Jellyfin/Emby 图片端点形如 /Items/{id}/Images/{type}[/...]。
 * 协议不得被当作任意 API 代理（如 /Videos/*/stream、/Users 等），
 * 否则持凭据的请求可越过图片范围访问其他接口。 */
function isImageApiPath(pathname: string): boolean {
  return /\/Items\/[^/]+\/Images\//i.test(pathname)
}

function resolveImageRequest(
  requestUrl: string,
  protoPrefix: string
): { server: JellyfinServerConfig; realUrl: string; cachePath: string } | null {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return null
  }
  const servers = getServers()

  // 新格式：host 位置是 serverId（generateServerId 为 base36 小写，可与 host 复用解析）
  const byId = servers.find(s => s.id === u.host)
  if (byId) {
    try {
      const base = new URL(normalizeUrl(byId.url))
      const basePath = base.pathname.replace(/\/+$/, '')
      // 兼容旧链接：剥离内嵌凭据参数，认证一律由主进程注入
      u.searchParams.delete('api_key')
      u.searchParams.delete('token')
      // 图片范围限制：仅放行 /Items/{id}/Images/... 端点
      if (!isImageApiPath(u.pathname)) {
        console.warn(`[image] 拒绝非图片 API 路径: ${u.pathname}`)
        return null
      }
      const realUrl = `${base.origin}${basePath}${u.pathname}${u.search}`
      return { server: byId, realUrl, cachePath: `${u.pathname}${u.search}` }
    } catch {
      return null
    }
  }

  // 旧格式：scheme 编码在 host 位置（<proto>://https/host...）
  const m = requestUrl.match(new RegExp(`^${protoPrefix}(https?)/(.+)$`))
  if (!m) return null
  let ru: URL
  try {
    ru = new URL(`${m[1]}://${m[2]}`)
  } catch {
    return null
  }
  ru.searchParams.delete('api_key')
  ru.searchParams.delete('token')
  // 图片范围限制：仅放行 /Items/{id}/Images/... 端点
  if (!isImageApiPath(ru.pathname)) {
    console.warn(`[image] 拒绝非图片 API 路径: ${ru.pathname}`)
    return null
  }
  const realUrl = ru.toString()
  const matched = findServerByUrlPrefix(realUrl)
  if (!matched) {
    console.warn(`[image] 请求未匹配到已配置服务器: ${ru.host}${ru.pathname}`)
    return null
  }
  const cachePath = realUrl.slice(matched.prefix.length) || '/'
  return { server: matched.server, realUrl, cachePath }
}

/** jellyfin-image / emby-image 共用处理器：解析 → 缓存 → 注入认证抓取 */
function makeServerImageHandler(proto: 'jellyfin-image' | 'emby-image') {
  return async (request: Request): Promise<Response> => {
    try {
      const resolved = resolveImageRequest(request.url, `${proto}://`)
      if (!resolved) {
        return new Response('Forbidden', { status: 403 })
      }
      const { server, realUrl, cachePath } = resolved
      // 缓存 key 含 serverId，避免多服务器同 path 撞图；使用 SHA-256 摘要，
      // 不受原始路径中的特殊字符影响，落盘文件名稳定且不泄露原始 URL 结构
      const cacheKey = crypto
        .createHash('sha256')
        .update(`${proto}\u0000${server.id}\u0000${cachePath}`)
        .digest('hex')
      // 等待缓存初始化（建目录 + v1→v2 迁移）完成，避免早期读写与迁移清理竞争
      await posterCache.ready()
      const cachedData = await posterCache.get(cacheKey)
      if (cachedData) {
        return new Response(cachedData.data, {
          headers: {
            'Content-Type': cachedData.mimeType,
            'Cache-Control': 'public, max-age=604800',
          },
        })
      }

      // token 通过请求头传递（X-Emby-Token 对 Jellyfin/Emby 均有效），避免凭据明文出现在代理/日志中
      const headers: Record<string, string> = {}
      if (server.token) {
        headers['X-Emby-Token'] = server.token
      }

      try {
        await imageFetchLimiter.acquire()
        try {
          const response = await fetchImageWithToken(realUrl, headers)

          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`)
          }

          const mimeType = response.headers.get('content-type') || 'image/png'
          const buffer = Buffer.from(await response.arrayBuffer())
          await posterCache.set(cacheKey, buffer, realUrl, mimeType)

          return new Response(buffer, {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'public, max-age=604800',
            },
          })
        } finally {
          imageFetchLimiter.release()
        }
      } catch (err) {
        console.error(`[${proto}] 请求失败: ${err}`)
        return new Response('Error loading image', { status: 500 })
      }
    } catch (err) {
      console.error(`[${proto}] 解析失败: ${err}`)
      return new Response('Invalid URL', { status: 400 })
    }
  }
}

function registerJellyfinImageProtocol(): void {
  protocol.handle('jellyfin-image', makeServerImageHandler('jellyfin-image'))
}

// ==================== 自定义协议: emby-image ====================

function registerEmbyImageProtocol(): void {
  protocol.handle('emby-image', makeServerImageHandler('emby-image'))
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
  const { existsSync, createReadStream, realpathSync } = require('fs')
  const path = require('path')
  const userDataRoot = app.getPath('userData')
  protocol.handle('local-file', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && url.hostname && /^[a-zA-Z]$/.test(url.hostname)) {
      filePath = `${url.hostname.toUpperCase()}:${filePath}`
    } else if (process.platform === 'win32' && filePath.length > 1 && filePath[0] === '/') {
      filePath = filePath.slice(1)
    }
    // 安全限制：仅允许访问应用用户数据目录内的文件，防止任意本地文件读取
    // L2: realpathSync 解析符号链接后校验，防止 userData 内链接绕过前缀检查
    let realPath = path.resolve(filePath)
    try {
      realPath = realpathSync(realPath)
    } catch { /* 不存在 → 下方 404 */ }
    const withinUserData = realPath === userDataRoot || realPath.startsWith(userDataRoot + path.sep)
    if (!withinUserData) {
      return new Response('Forbidden', { status: 403 })
    }
    const ext = path.extname(realPath.toLowerCase())
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'

    return new Promise((resolve) => {
      try {
        if (!existsSync(realPath)) {
          resolve(new Response('File not found', { status: 404 }))
          return
        }
        const { statSync } = require('fs')
        const size = statSync(realPath).size
        const rangeHeader = request.headers.get('range')
        const range = parseRangeHeader(rangeHeader, size)
        // 客户端请求了 Range 但无法满足（越界 / 多段 / 非法）→ 416
        if (rangeHeader && !range) {
          resolve(new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'content-range': `bytes */${size}` }
          }))
          return
        }
        const stream = range
          ? createReadStream(realPath, { start: range.start, end: range.end })
          : createReadStream(realPath)
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
        const headers: Record<string, string> = {
          'content-type': mimeType,
          'accept-ranges': 'bytes'
        }
        if (range) {
          // 206 Partial Content：视频拖动进度依赖正确的 Range 语义
          headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
          headers['content-length'] = String(range.end - range.start + 1)
        } else {
          headers['content-length'] = String(size)
        }
        resolve(
          new Response(responseStream, {
            status: range ? 206 : 200,
            headers
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
    icon: getWindowIcon(),  // 统一图标入口：窗口图标读取 build/icon-256.png（透明派生资源）
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  // 窗口关闭后清除引用，避免后续代码使用已销毁的窗口对象
  mainWindow.on('closed', () => { mainWindow = null })

  // 原生全屏状态 → 渲染端（UI 隐藏顶栏、ESC 退出等以此为准）；
  // 透明窗口的 setFullScreen 是 SetBounds 模拟路径，不会隐藏任务栏，
  // 全屏期间用 screen-saver 级置顶盖住任务栏，退出后还原应用自身置顶设置。
  mainWindow.on('enter-full-screen', () => {
    windowFullscreenState = true
    mainWindow?.setAlwaysOnTop(true, 'screen-saver')
    mainWindow?.webContents.send('window:fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    windowFullscreenState = false
    mainWindow?.setAlwaysOnTop(isAlwaysOnTop, 'screen-saver') // 还原应用自身的置顶设置
    mainWindow?.webContents.send('window:fullscreen-changed', false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const u = new URL(details.url)
      // 仅允许 http/https 交由系统处理，杜绝 file:/自定义协议等逃逸路径
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        shell.openExternal(details.url)
      }
    } catch {
      // 忽略无法解析的 URL
    }
    return { action: 'deny' }
  })

  // L3: 显式拒绝所有权限请求（通知/剪贴板/媒体设备/地理位置等），纵深防御
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn('[permission] denied:', permission)
    callback(false)
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
  // 直接读取带 Alpha 的派生 PNG，不使用白色画布或背景填充。
  let icon = getTrayIcon()
  if (icon.isEmpty()) {
    // 回退：从 256px 母版缩放到 32px
    console.warn('[tray] 32px 图标缺失，从 256px 母版缩放')
    icon = loadNativeIcon('icon-256.png', 32)
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

  tray.setToolTip('环影')
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
  { scheme: 'jellyfin-image', privileges: { bypassCSP: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'emby-image', privileges: { bypassCSP: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

app.whenReady().then(() => {
  // 最先初始化配置：safeStorage 检测 + 加载 config.json 必须在 app ready 后，
  // 否则 Windows DPAPI 未就绪会导致凭据被误清空（服务器信息存不住）
  initConfig()

  electronApp.setAppUserModelId('com.huanying.player')

  // 注册自定义协议
  registerJellyfinImageProtocol()
  registerEmbyImageProtocol()
  registerLocalFileProtocol()
  registerDoubanImageProtocol()

  // 启动播放流代理：Renderer 只拿回环 URL，凭据留在主进程
  startStreamProxy()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  Menu.setApplicationMenu(null)

  createWindow()
  createTray()

  // 一次性迁移：清理旧历史记录海报 URL 中内嵌的 api_key/token 明文
  migrateHistoryPosters()

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
}).catch((err) => {
  console.error('whenReady failed:', err)
  writeCrashLog('whenReady', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 全局异常捕获，写入日志文件（双击 start.bat 闪退时用于定位真实错误）
function writeCrashLog(tag: string, err: unknown): void {
  try {
    const content = `[${new Date().toISOString()}] [${tag}]\n${err instanceof Error ? (err.stack || err.message) : String(err)}\n\n`
    writeFileSync(join(process.cwd(), 'startup-crash.log'), content, { flag: 'a' })
  } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
  writeCrashLog('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
  writeCrashLog('unhandledRejection', reason)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // 同步强杀 mpv 子进程，避免退出后 mpv.exe 残留（--wid 子窗口一起销毁）
  try { mpvController?.killSync() } catch { /* ignore */ }
})













