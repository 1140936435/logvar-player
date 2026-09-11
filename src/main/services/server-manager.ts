import type { ServerType } from '../../shared/types'

/**
 * 运行时连接凭据（只存在于主进程内存，绝不离开主进程、绝不回传 Renderer）。
 */
export interface ServerAuth {
  url: string
  token: string
  userId: string
  type: ServerType
}

/**
 * 持久化的服务器配置（含凭据；落盘由 config 加密层处理）。
 * 与 index.ts 之前的 JellyfinServerConfig 字段完全一致，迁移时零行为变化。
 */
export interface ServerConfig {
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

/** Renderer 可见的服务器公开信息：绝不包含 token/password 等凭据 */
export interface PublicServerConfig {
  id: string
  name: string
  url: string
  type?: 'jellyfin' | 'emby'
  username?: string
  userId?: string
  hasToken: boolean
  hasPassword: boolean
}

/**
 * 持久化宿主：由 index.ts 注入 config 读写，
 * 保证 configData + saveConfigFile() 仍是唯一的落盘通道，ServerManager 不自行触碰文件。
 */
export interface ServerManagerHost {
  readServers(): ServerConfig[]
  writeServers(servers: ServerConfig[]): void
  readActiveServerId(): string | null
  writeActiveServerId(id: string | null): void
}

/** 剥离凭据，产出可安全发往 Renderer 的服务器公开信息 */
export function toPublicServer(s: ServerConfig): PublicServerConfig {
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

/**
 * 服务器状态唯一真源：统一管理
 * - 持久化的服务器列表与 activeServerId（通过注入的 host 读写）
 * - 运行时连接凭据 auth 与 connectedServerId（仅主进程内存）
 *
 * auth 与 connectedServerId 同生命周期更新，从结构上避免
 * 「有 auth 却不知道连的是哪台服务器」以及「activeServerId 与凭据脱节」的问题。
 */
export class ServerManager {
  /** 当前已连接服务器的运行时凭据；未连接为 null */
  auth: ServerAuth | null = null

  /** 当前连接对应的服务器 id；与 auth 同步维护 */
  connectedServerId: string | null = null

  constructor(private readonly host: ServerManagerHost) {}

  getServers(): ServerConfig[] {
    return this.host.readServers()
  }

  saveServers(servers: ServerConfig[]): void {
    this.host.writeServers(servers)
  }

  getActiveServerId(): string | null {
    return this.host.readActiveServerId()
  }

  /**
   * 设置活跃服务器。强制 invariant：已连接状态下活跃服务器必须与已连接服务器
   * （connectedServerId）一致。若新的活跃 id 与当前连接不同，说明运行时凭据已与
   * 新活跃服务器脱节，必须先断开连接，由调用方（connectToServer）用新服务器重建后再登记。
   */
  setActiveServerId(id: string | null): void {
    if (this.auth !== null && id !== this.connectedServerId) {
      this.clearConnection()
    }
    this.host.writeActiveServerId(id)
    this.assertInvariant()
  }

  getServerById(id: string): ServerConfig | undefined {
    return this.getServers().find((s) => s.id === id)
  }

  /**
   * 连接成功：登记运行时凭据，并原子地把 activeServerId 落为同一 id。
   * 使「activeServerId === connectedServerId」在同一步内成立，无需调用方再补写。
   */
  markConnected(id: string | null, auth: ServerAuth): void {
    this.connectedServerId = id
    this.auth = auth
    this.host.writeActiveServerId(id)
    this.assertInvariant()
  }

  /** 断开 / 清除连接：auth 与 connectedServerId 一并清空 */
  clearConnection(): void {
    this.connectedServerId = null
    this.auth = null
  }

  isConnected(): boolean {
    return this.auth !== null
  }

  /**
   * 不变式自检：auth 与 connectedServerId 必须同生同灭，且已连接时
   * activeServerId 必须等于 connectedServerId。由关键写入点调用，违反即抛错，
   * 避免「活跃服务器」与「运行时凭据」脱节、或残留旧 id 的带病状态被静默掩盖。
   */
  assertInvariant(): void {
    if (this.auth === null) {
      // 断开态必须彻底：connectedServerId 不得残留旧 id
      if (this.connectedServerId !== null) {
        throw new Error(
          `[ServerManager] invariant violated: auth is null but connectedServerId=${String(this.connectedServerId)}`
        )
      }
      return
    }
    // 连接态必须有确定的 connectedServerId，且与 activeServerId 一致
    if (this.connectedServerId === null) {
      throw new Error('[ServerManager] invariant violated: connected but connectedServerId is null')
    }
    const active = this.host.readActiveServerId()
    if (this.connectedServerId !== active) {
      throw new Error(
        `[ServerManager] invariant violated: connectedServerId=${String(this.connectedServerId)} !== activeServerId=${String(active)}`
      )
    }
  }

  /**
   * 活跃服务器配置（url/token/userId/type）变化后同步运行时凭据，
   * 保证下一次 API 调用立即使用新凭据（仅当它正是当前连接时才同步）。
   */
  syncAuthFromServer(server: ServerConfig): void {
    if (this.auth === null) return
    if (this.getActiveServerId() !== server.id) return
    this.auth = {
      url: server.url,
      token: server.token,
      userId: server.userId || '',
      type: server.type === 'emby' ? 'emby' : 'jellyfin'
    }
    this.connectedServerId = server.id
    this.assertInvariant()
  }
}
