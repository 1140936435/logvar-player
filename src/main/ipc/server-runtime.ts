/**
 * server-runtime.ts — 服务器运行态共享模块（P1 拆分）
 *
 * server:* / jellyfin:* 两类 IPC 共用的运行态与工具函数统一收拢于此：
 *   - ServerManager 单例（持久化服务器列表 / activeServerId + 运行时凭据 auth）
 *   - Jellyfin API 客户端辅助（buildJellyfinHeaders / normalizeUrl / jellyfinRequest）
 *   - 服务器配置访问（getServers/saveServers/findServerByUrlPrefix/...）
 *   - 播放流代理 StreamProxy 单例
 *
 * 宿主注入：index 通过 initServerRuntime(host) 注入 config 读写，
 * 唯一的落盘通道仍由 index 的 saveConfigFile() 承担，本模块不直接触碰文件。
 */
import { StreamProxyService } from '../services/stream-proxy-service'
import { ServerManager } from '../services/server-manager'
import type { ServerAuth as JellyfinAuth, ServerConfig as JellyfinServerConfig } from '../services/server-manager'
import type { ServerType } from '../../shared/types'
import { isEncrypted, matchServerByUrlPrefix } from '../lib/security'

// ==================== 运行态宿主注入 ====================

export interface ServerRuntimeHost {
  getConfig(): Record<string, unknown>
  setConfigValue(key: string, value: unknown): void
  saveConfigFile(): void
}

let runtimeHost: ServerRuntimeHost | null = null

/** 由 index 在模块初始化阶段注入 config 读写（saveConfigFile 仍是唯一落盘通道） */
export function initServerRuntime(host: ServerRuntimeHost): void {
  runtimeHost = host
}

/** 读取配置快照（index 的 configData 引用，惰性取值） */
export function getRuntimeConfig(): Record<string, unknown> {
  return runtimeHost!.getConfig()
}

/** 写入配置并落盘（经 index 的 setConfigValue + saveConfigFile） */
export function setRuntimeConfigValue(key: string, value: unknown): void {
  runtimeHost!.setConfigValue(key, value)
}

// ==================== 服务器状态唯一真源 ====================

/** 统一 servers / activeServerId（持久化）与 auth / connectedServerId（运行时） */
export const serverManager = new ServerManager({
  readServers: () => {
    const raw = getRuntimeConfig()['jellyfin:servers']
    return Array.isArray(raw) ? (raw as JellyfinServerConfig[]) : []
  },
  writeServers: (servers) => {
    setRuntimeConfigValue('jellyfin:servers', servers)
  },
  readActiveServerId: () => (getRuntimeConfig()['jellyfin:activeServerId'] as string) || null,
  writeActiveServerId: (id) => {
    setRuntimeConfigValue('jellyfin:activeServerId', id ?? '')
  }
})

/**
 * 服务器运行态配置键：只能经 server:* 专用 IPC 修改。
 * 通用 store / data:import 触碰这些键时，必须重建运行时连接（rebuildServerRuntime），
 * 否则会出现 activeServerId 与 auth 脱节的带病状态。
 */
export const SERVER_RUNTIME_KEYS = new Set(['jellyfin:servers', 'jellyfin:activeServerId'])

// ==================== Jellyfin API 辅助函数 ====================

export function buildJellyfinHeaders(token: string, serverType: ServerType): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }
  const cleanToken = token.trim()
  if (cleanToken) {
    headers['X-Emby-Token'] = cleanToken
  }
  return headers
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export function isUnresolvedEncrypted(val: string): boolean {
  return typeof val === 'string' && isEncrypted(val)
}

export async function jellyfinRequest<T>(
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


export function getServers(): JellyfinServerConfig[] {
  return serverManager.getServers()
}

export function saveServers(servers: JellyfinServerConfig[]): void {
  serverManager.saveServers(servers)
}

/** 按 URL 匹配已配置服务器（实现见 ./lib/security.ts 的 matchServerByUrlPrefix）：
 * origin + basePath 最长前缀匹配，scheme 必须一致 —— 同 host 不同 basePath 不串 token，
 * https 配置的服务器不会被 http 请求命中（防降级） */
export function findServerByUrlPrefix(url: string): { server: JellyfinServerConfig; prefix: string } | null {
  return matchServerByUrlPrefix(url, getServers())
}

export function getActiveServerId(): string | null {
  return serverManager.getActiveServerId()
}

export function setActiveServerId(id: string): void {
  serverManager.setActiveServerId(id)
}

export function generateServerId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 从旧的单服务器配置迁移 */

let streamProxy: StreamProxyService | null = null

export function getStreamProxy(): StreamProxyService {
  if (!streamProxy) {
    streamProxy = new StreamProxyService((serverId) => {
      const server = getServers().find(s => s.id === serverId)
      if (!server || !server.token) return null
      return { url: normalizeUrl(server.url), token: server.token }
    })
  }
  return streamProxy
}

export async function startStreamProxy(): Promise<void> {
  await getStreamProxy().start()
}

