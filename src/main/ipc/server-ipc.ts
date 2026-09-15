/**
 * server-ipc.ts — 服务器管理 IPC（P1 拆分）
 *
 * server:* 全部通道 + 连接/登录/运行态重建逻辑从 index.ts 下沉。
 * 共享运行态（ServerManager 单例 / Jellyfin API 客户端 / 播放流代理）
 * 统一来自 ./server-runtime.ts，本模块不再自行维护 config 读写。
 * 通道名 / 参数 / 返回结构与原实现完全一致（renderer 零改动）。
 */
import { registerIpc } from './secure-handle'
import {
  serverManager,
  getServers,
  saveServers,
  getActiveServerId,
  setActiveServerId,
  generateServerId,
  jellyfinRequest,
  normalizeUrl,
  isUnresolvedEncrypted,
  getStreamProxy,
  getRuntimeConfig,
  setRuntimeConfigValue
} from './server-runtime'
import { toPublicServer } from '../services/server-manager'
import type { ServerAuth as JellyfinAuth, ServerConfig as JellyfinServerConfig } from '../services/server-manager'
import type { JellyfinServerInfo, ServerType } from '../../shared/types'

/** config 快照读别名：server 专用逻辑统一经 server-runtime 宿主注入读取最新配置 */
function runtimeData(): Record<string, unknown> {
  return getRuntimeConfig()
}

/** 从旧的单服务器配置迁移 */
export function migrateLegacyConfig(): void {
  const servers = getServers()
  if (servers.length > 0) return // 已迁移过
  const oldUrl = runtimeData()['jellyfin.url'] as string | undefined
  const oldToken = runtimeData()['jellyfin.token'] as string | undefined
  if (oldUrl && oldToken) {
    const id = generateServerId()
    const server: JellyfinServerConfig = {
      id,
      name: (runtimeData()['serverDisplayName'] as string) || 'Jellyfin',
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

export async function connectToServer(id: string): Promise<{ success: boolean; data?: JellyfinServerInfo; error?: string; users?: Array<{ id: string; name?: string }> }> {
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
      serverManager.markConnected(id, auth)
      setActiveServerId(id)
      // 同步旧 key（兼容 Home.tsx 的 connectedServer/token 读取逻辑）
      setRuntimeConfigValue('jellyfin', { url: server.url, token: server.token })
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
    serverManager.markConnected(id, auth)

    // 更新 userId
    server.userId = auth.userId
    saveServers(servers)
    setActiveServerId(id)

    // 同步旧 key（兼容性）
    setRuntimeConfigValue('jellyfin', { url: server.url, token: server.token })

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
  // 一次性消费：取用后立即销毁暂存登录，杜绝同一份凭据被重复用于多次保存
  const consumed = { token: pendingEmbyLogin.token, userId: pendingEmbyLogin.userId }
  pendingEmbyLogin = null
  return consumed
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


// ==================== 服务器 IPC 注册 ====================
export function registerServerIpc(): void {
  // ==================== 多服务器 IPC ====================

  registerIpc('server:list', async () => {
    // DTO 边界：凭据不出主进程
    return { success: true, data: getServers().map(toPublicServer) }
  })

  registerIpc('server:get-active', async () => {
    const id = getActiveServerId()
    const servers = getServers()
    const active = servers.find(s => s.id === id) || null
    return { success: true, data: { id, server: active ? toPublicServer(active) : null } }
  })

  /** Renderer 请求重连：主进程用自持凭据连接活跃服务器，Renderer 不接触 token */
  registerIpc('server:ensure-connected', async () => {
    if (serverManager.auth) return { success: true }
    const id = getActiveServerId()
    if (!id) return { success: false, error: '无活跃服务器，请在设置中配置' }
    return connectToServer(id)
  })

  registerIpc('server:add', async (_event, params: { name: string; url: string; token: string }) => {
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

  registerIpc('server:update', async (_event, params: {
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
    // 避免校验失败（如 Emby 暂存登录失效）时已就地修改 runtimeData() 中的对象，
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

    // 一致性：当前活跃服务器的 url/token/userId/type 变化必须同步到 serverManager.auth，
    // 保证下一次 API 调用立即使用新凭据（而不是等重连）
    if (wasActive && serverManager.auth) {
      // 一致性：当前活跃服务器的 url/token/userId/type 变化后，立即同步运行时凭据
      serverManager.syncAuthFromServer(next)
      console.log(`[server] 活跃服务器配置已更新，auth 已同步 (type=${serverManager.auth.type})`)
    }
    return { success: true, data: toPublicServer(next) }
  })

  registerIpc('server:remove', async (_event, id: string) => {
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
          serverManager.clearConnection()
          return { success: true, warning: `已删除服务器，但切换到 "${next.name}" 失败：${connectResult.error}` }
        }
      } else {
        setActiveServerId('')
        serverManager.clearConnection()
      }
    }
    return { success: true }
  })

  registerIpc('server:switch', async (_event, id: string) => {
    const result = await connectToServer(id)
    return result
  })

  /** 列出 Jellyfin 服务器的用户（多用户 API Key 场景，供用户显式选择） */
  registerIpc('server:list-users', async (_event, id: string) => {
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
  registerIpc('server:set-user', async (_event, id: string, userId: string) => {
    const servers = getServers()
    const server = servers.find(s => s.id === id)
    if (!server) return { success: false, error: '服务器不存在' }
    server.userId = userId
    saveServers(servers)
    // 若是当前活跃服务器，立即同步 auth，保证下一次 API 使用所选用户
    if (getActiveServerId() === id && serverManager.auth) {
      serverManager.auth = { ...serverManager.auth, userId }
    }
    return { success: true, data: toPublicServer(server) }
  })

  registerIpc('server:test', async (_event, url: string, token: string) => {
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

  registerIpc('server:test-emby', async (_event, params: { url: string; username: string; password: string }) => {
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

  registerIpc('server:add-emby', async (_event, params: {
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

}

/**
 * 通用 store / data:import 触碰服务器运行态键后，强制按持久化配置重建运行时连接：
 * 先断开旧凭据并失效播放会话，再重连活跃服务器，杜绝「改了 servers/activeServerId 但 auth 未重建」。
 */
export async function rebuildServerRuntime(): Promise<void> {
  serverManager.clearConnection()
  getStreamProxy().invalidateAll()
  const id = getActiveServerId()
  if (id && serverManager.getServerById(id)) {
    const r = await connectToServer(id).catch((err) => {
      console.warn('[server] 运行时重建连接失败:', err)
      return { success: false as const, error: String(err) }
    })
    if (!r.success) console.warn('[server] 运行时重建未成功:', r.error)
  }
}

