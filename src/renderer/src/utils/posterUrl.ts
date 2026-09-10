export type ServerType = 'emby' | 'jellyfin'

export interface PosterUrlOptions {
  /** 服务器 ID：优先用于构建 serverId 格式协议 URL（精确匹配服务器，无 host 冲突） */
  serverId?: string
  baseUrl: string
  serverType: ServerType
  itemId: string
  imageTag?: string
  maxHeight?: number
  doubanPosterPath?: string
}

/**
 * 构建海报 URL（jellyfin-image/emby-image 协议链接，不含任何凭据）。
 *
 * serverId 格式（推荐）：`<proto>://<serverId>/Items/...`
 *   - 主进程按 serverId 精确匹配服务器，同 host 不同 basePath 不会串 token
 *   - scheme/base-path 由服务器配置决定，HTTPS 服务器不可能被降级
 *
 * legacy 格式（无 serverId 时兜底）：`<proto>://<scheme>/<host><basePath>/Items/...`
 *   - 主进程按 origin+basePath 最长前缀匹配，scheme 必须与配置一致
 */
export function getPosterUrl(options: PosterUrlOptions): string | null {
  if (options.doubanPosterPath) {
    let urlPath = options.doubanPosterPath.replace(/\\/g, '/')
    if (urlPath.match(/^[A-Z]:/i)) urlPath = '/' + urlPath
    return `local-file://${urlPath}`
  }

  if (!options.imageTag) {
    return null
  }

  const maxHeight = options.maxHeight ?? getOptimalPosterHeight()
  const query = `maxHeight=${maxHeight}&tag=${encodeURIComponent(options.imageTag)}&quality=90&format=webp`

  // serverId 格式：path 不含 base-path，主进程按服务器配置拼接
  if (options.serverId) {
    const proto = options.serverType === 'emby' ? 'emby-image' : 'jellyfin-image'
    return `${proto}://${options.serverId}/Items/${options.itemId}/Images/Primary?${query}`
  }

  // legacy 兜底：scheme 编码进 URL，base-path 保留在路径中
  const protoPrefix = options.serverType === 'emby' ? 'emby-image' : 'jellyfin-image'
  const imgBase = options.baseUrl
    .replace(/^https:\/\//, `${protoPrefix}://https/`)
    .replace(/^http:\/\//, `${protoPrefix}://http/`)
  return `${imgBase}/Items/${options.itemId}/Images/Primary?${query}`
}

/** 构建 serverId 格式的图片协议 URL 前缀（Detail 页 Backdrop/人物头像等多路径场景）。
 * 无 serverId 时回退 legacy 格式（scheme+host 编码）。 */
export function getImageBase(options: { serverId?: string; baseUrl: string; serverType: ServerType }): string {
  if (options.serverId) {
    const proto = options.serverType === 'emby' ? 'emby-image' : 'jellyfin-image'
    return `${proto}://${options.serverId}`
  }
  const protoPrefix = options.serverType === 'emby' ? 'emby-image' : 'jellyfin-image'
  return options.baseUrl
    .replace(/^https:\/\//, `${protoPrefix}://https/`)
    .replace(/^http:\/\//, `${protoPrefix}://http/`)
}

export function getOptimalPosterHeight(): number {
  if (typeof window === 'undefined') return 240
  if (window.innerWidth >= 1280) return 320
  if (window.innerWidth >= 1024) return 280
  if (window.innerWidth >= 768) return 240
  return 200
}
