import {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog,
  protocol,
  net,
  safeStorage,
  type NativeImage
} from 'electron'
import * as crypto from 'crypto'
import { join, dirname, resolve as pathResolve, sep as pathSep } from 'path'

import { readdirSync, readFileSync, realpathSync, existsSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, renameSync, copyFileSync, createReadStream } from 'fs'
import { stat as fsStat, realpath as fsRealpath, appendFile as fsAppendFile } from 'fs/promises'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { posterCache } from './services/poster-cache'
import { PathAccessService, canonicalizePath } from './services/path-access-service'
import type { ServerConfig as JellyfinServerConfig } from './services/server-manager'
import { PlaybackEngine } from './playback-engine'
import { registerIpc } from './ipc/secure-handle'
import { MainWindowController } from './windows/main-window'
import { LogWindowController, type LogEntry, registerLogIpc } from './windows/log-window'
import { registerFileIpc, restorePathAccess, isPathAllowed, denyPath } from './ipc/file-ipc'
import { registerSettingsIpc } from './ipc/settings-ipc'
import { registerHistoryIpc, migrateHistoryPosters } from './ipc/history-ipc'
import { registerDanmakuIpc } from './ipc/danmaku-ipc'
import { fetchDoubanImage } from './ipc/media-ipc'
import {
  initServerRuntime,
  getServers,
  findServerByUrlPrefix,
  normalizeUrl,
  getActiveServerId,
  getStreamProxy,
  startStreamProxy
} from './ipc/server-runtime'
import { registerServerIpc, connectToServer, rebuildServerRuntime, migrateLegacyConfig } from './ipc/server-ipc'
import { registerJellyfinIpc } from './ipc/jellyfin-ipc'

import {
  ENCRYPTED_KEYS,
  CREDENTIAL_NAMESPACES,
  isCredentialKey,
  sanitizeEncryptedBlobs,
  stripSensitiveFields,
  isAllowedDoubanImageUrl,
  MAX_IMAGE_BYTES,
  assertAllowedImageResponse,
  parseRangeHeader,
  readBodyWithLimit
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

// ==================== IPC sender 校验 ====================
// sender 校验已下沉到 ./ipc/secure-handle.ts（P1 统一 IPC 注册基建）：
// 所有 IPC 统一经 secureHandle / secureHandleRaw / registerIpc 注册，
// 由框架自动完成 sender 校验、参数运行时校验（schema）与异常捕获。
// index.ts 对 ipcMain.handle 的 monkey-patch 已移除。

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

const logHistory: LogEntry[] = [] // LogEntry 定义见 ./windows/log-window
let tray: Tray | null = null

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

  logWindowController.pushLogEntry(entry)
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

// 日志窗口的创建、log preload 关联与生命周期已下沉到 windows/log-window.ts，
// 此处仅注入历史快照数据源并持有控制器实例。
const logWindowController = new LogWindowController({
  getHistory: () => logHistory
})

// log:send / log:toggle 已随日志窗口模块内聚（见 ./windows/log-window.ts 的 registerLogIpc）

// server:* / jellyfin:* IPC 已下沉 ./ipc/server-ipc.ts 与 ./ipc/jellyfin-ipc.ts（共享运行态在 ./ipc/server-runtime.ts）


// 配置文件路径和数据（需要在函数定义前声明）
let configPath = ''
let configData: Record<string, unknown> = {}



// ==================== IPC: 豆瓣评分 ====================
// 使用 Jellyfin 的 CommunityRating，无需外部 API
registerIpc('douban:get-rating', async (_event, _title: string) => {
  return { success: true, data: null }
})

registerIpc('douban:get-ratings-batch', async (_event, _titles: string[]) => {
  return { success: true, data: {} }
})

// IPC: 海报映射持久化 / 本地媒体元数据（poster:* / media:*）已下沉至 ./ipc/media-ipc.ts
// （注册见下方「IPC 分模块注册区」，通道名与参数保持完全兼容）

// ==================== IPC: 剧集列表 ====================


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
  // 配置真正加载到内存后，再把持久化的授权根目录恢复到 PathAccessService。
  // 模块初始化时 configData 还是空的，没有这一步重启后授权目录会全部丢失
  restorePathAccess()
  // 仅当配置成功加载后再落盘清洗结果，避免用空白配置覆盖损坏的原文件
  if (configLoadOk) {
    saveConfigFile()
  }
}

// sanitizeEncryptedBlobs 已移至 ./lib/security.ts

// IPC: 设置与数据（store:* / data:* / 凭据边界）已下沉至 ./ipc/settings-ipc.ts
// （注册见下方「IPC 分模块注册区」；凭据边界实现见 ./lib/security.ts）

// ==================== 窗口控制 ====================

// window:minimize / maximize / close / always-on-top / toggle-fullscreen
// 控制 IPC 与主窗口创建逻辑已下沉到 windows/main-window.ts
// （MainWindowController.registerIpc），由 mainWindowController 统一管理，
// renderer 调用面保持不变。

// ==================== MPV 播放引擎（实现见 ./playback-engine） ====================

const playbackEngine = new PlaybackEngine({
  getMainWindow: () => mainWindowController.getMainWindow(),
  getPlayerSettings: getMpvPlayerSettings,
  isPathAllowed,
  denyPath,
  toggleWindowFullscreen: () => mainWindowController.toggleWindowFullscreen(),
  // 新增：StreamProxy 校验（playback-source-guard L1.5 组件）
  isValidStreamSessionUrl: (url) => getStreamProxy().ownsSessionUrl(url)
})
playbackEngine.registerIpc()

function getMpvPlayerSettings(): { hardwareDecode: boolean; hdrToneMapping: boolean; debugLog: boolean } {
  const saved = configData['player'] as { hardwareDecode?: boolean; hdrToneMapping?: boolean; debugLog?: boolean } | undefined
  return {
    hardwareDecode: saved?.hardwareDecode !== false,
    hdrToneMapping: saved?.hdrToneMapping === true,
    debugLog: saved?.debugLog === true
  }
}

// IPC: 播放历史 / 最近入库（history:* / recentlyAdded:*）已下沉至 ./ipc/history-ipc.ts
// （注册见下方「IPC 分模块注册区」）

// IPC: 文件/目录/本地媒体扫描/路径权限（file:* / video:get-info）已下沉至 ./ipc/file-ipc.ts
// （isPathAllowed / denyPath / restorePathAccess 由此模块导出；注册见下方「IPC 分模块注册区」）

// IPC: 弹幕（danmaku:*，DandanPlay / 本地 XML / 本地回退）已下沉至 ./ipc/danmaku-ipc.ts
// （注册见下方「IPC 分模块注册区」）

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
      
      fetchDoubanImage(url, 10000)
      .then(({ buffer, mime }) => {
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
 * 协议不得被当作任意 API 代理（如 /Videos/…/stream、/Users 等），
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

          // 只信任实际字节数：边读边计数，超限立即中止（防缺 content-length 的无限流撑爆内存）
          const buffer = await readBodyWithLimit(response.body, MAX_IMAGE_BYTES)
          // 校验 MIME/大小：非图片或超限直接失败，不写入缓存
          const mimeType = assertAllowedImageResponse(response.headers.get('content-type'), buffer.length)
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
  const { createReadStream } = require('fs')
  const path = require('path')
  // userData 根目录也做一次 canonicalize，与目标文件 realpath 后的结果同口径比较
  const userDataRoot = canonicalizePath(app.getPath('userData'))
  protocol.handle('local-file', async (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && url.hostname && /^[a-zA-Z]$/.test(url.hostname)) {
      filePath = `${url.hostname.toUpperCase()}:${filePath}`
    } else if (process.platform === 'win32' && filePath.length > 1 && filePath[0] === '/') {
      filePath = filePath.slice(1)
    }
    // 安全限制：仅允许访问应用用户数据目录内的文件，防止任意本地文件读取
    // L2: realpath（异步）解析符号链接后校验，防止 userData 内链接绕过前缀检查；
    //     网盘 / 慢盘上同步 FS 会阻塞主进程事件循环
    let realPath = path.resolve(filePath)
    try {
      realPath = await fsRealpath(realPath)
    } catch { /* 不存在 → 下方 404 */ }
    const realNorm = process.platform === 'win32' ? realPath.toLowerCase() : realPath
    const rootNorm = process.platform === 'win32' ? userDataRoot.toLowerCase() : userDataRoot
    const withinUserData = realNorm === rootNorm || realNorm.startsWith(rootNorm + path.sep)
    if (!withinUserData) {
      return new Response('Forbidden', { status: 403 })
    }
    const ext = path.extname(realPath.toLowerCase())
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'

    try {
      let size: number
      try {
        size = (await fsStat(realPath)).size
      } catch {
        return new Response('File not found', { status: 404 })
      }
      const rangeHeader = request.headers.get('range')
      const range = parseRangeHeader(rangeHeader, size)
      // 客户端请求了 Range 但无法满足（越界 / 多段 / 非法）→ 416
      if (rangeHeader && !range) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'content-range': `bytes */${size}` }
        })
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
      return new Response(responseStream, {
        status: range ? 206 : 200,
        headers
      })
    } catch (err) {
      console.warn('[local-file] handler error:', err)
      return new Response('File not found', { status: 404 })
    }
  })
}

// ==================== 窗口管理 ====================

// 主窗口的创建、navigation policy（导航拦截/限制）、window open handler、
// 全屏/置顶状态维护与 window:* 控制 IPC 已下沉到 windows/main-window.ts。
// index 仅注入图标与日志回调，并通过 mainWindowController 驱动窗口。
const mainWindowController = new MainWindowController({
  getWindowIcon,
  log: (level, message) => addLog(level as LogEntry['level'], 'renderer', message)
})
// 注册 window:minimize / maximize / close / always-on-top / toggle-fullscreen
// （renderer 调用面保持兼容；须在任何窗口加载前完成注册）
mainWindowController.registerIpc()
// ==================== IPC 分模块注册区（P1 拆分 ./ipc/*） ====================
// file: / settings: / history: / recentlyAdded: / danmaku: / media: / video:get-info / poster:
// 五类 IPC 已拆分为独立模块，通道名/参数/返回与原实现完全一致，renderer 调用面零改动。
registerSettingsIpc({
  getMainWindow: () => mainWindowController.getMainWindow(),
  getConfig: () => configData,
  setConfigValue: (key, value) => { configData[key] = value; saveConfigFile() },
  deleteConfigKey: (key) => { delete configData[key]; saveConfigFile() },
  saveConfigFile,
  rebuildServerRuntime
})
registerHistoryIpc({
  getConfig: () => configData,
  setConfigValue: (key, value) => { configData[key] = value; saveConfigFile() },
  saveConfigFile,
  findServerByUrlPrefix,
  normalizeUrl
})
registerFileIpc({
  getMainWindow: () => mainWindowController.getMainWindow(),
  userDataPath: () => app.getPath('userData'),
  getConfig: () => configData,
  setConfigValue: (key, value) => { configData[key] = value; saveConfigFile() },
  saveConfigFile
})
registerDanmakuIpc({
  getConfig: () => configData,
  setConfigValue: (key, value) => { configData[key] = value; saveConfigFile() },
  saveConfigFile,
  isPathAllowed,
  denyPath
})
// media-ipc 为顶层副作用注册（poster:* / media:* 通道），import 即完成注册

// server: / jellyfin: / log: IPC 已下沉 server-ipc / jellyfin-ipc / log-window（P1 拆分）
initServerRuntime({
  getConfig: () => configData,
  setConfigValue: (key, value) => { configData[key] = value; saveConfigFile() },
  saveConfigFile
})
registerLogIpc({
  addLog,
  toggle: () => logWindowController.toggle()
})
registerServerIpc()
registerJellyfinIpc()


function createWindow(): void {
  mainWindowController.create()
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
        const target = mainWindowController.getMainWindow()
        if (target) {
          target.show()
          target.focus()
        }
      }
    },
    {
      label: '日志窗口',
      click: () => logWindowController.toggle()
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
    const target = mainWindowController.getMainWindow()
    if (target) {
      target.show()
      target.focus()
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
  startStreamProxy().catch(err => console.warn('[stream-proxy] 启动失败:', err))

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
    logWindowController.toggle()
  })

  // F12 打开 DevTools（开发/调试用）
  globalShortcut.register('F12', () => {
    const win = mainWindowController.getMainWindow()
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      } else {
        win.webContents.openDevTools()
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
  try { playbackEngine.killSync() } catch { /* ignore */ }
})













