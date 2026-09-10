export type ServerType = 'emby' | 'jellyfin'

export interface PosterUrlOptions {
  baseUrl: string
  serverType: ServerType
  itemId: string
  imageTag?: string
  maxHeight?: number
  doubanPosterPath?: string
}

/**
 * 构建海报 URL（jellyfin-image/emby-image 协议链接，不含任何凭据）。
 * 认证由主进程按 URL host 匹配已配置服务器后注入 X-Emby-Token 请求头。
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

  if (options.serverType === 'emby') {
    const imgBase = options.baseUrl
      .replace(/^https:\/\//, 'emby-image://https/')
      .replace(/^http:\/\//, 'emby-image://http/')
    return `${imgBase}/Items/${options.itemId}/Images/Primary?maxHeight=${maxHeight}&tag=${encodeURIComponent(options.imageTag)}&quality=90&format=webp`
  }

  // scheme 编码进 URL（与 emby-image 一致），主进程按前缀还原 https/http
  const imgBase = options.baseUrl
    .replace(/^https:\/\//, 'jellyfin-image://https/')
    .replace(/^http:\/\//, 'jellyfin-image://http/')
  return `${imgBase}/Items/${options.itemId}/Images/Primary?maxHeight=${maxHeight}&tag=${encodeURIComponent(options.imageTag)}&quality=90&format=webp`
}

export function getOptimalPosterHeight(): number {
  if (typeof window === 'undefined') return 240
  if (window.innerWidth >= 1280) return 320
  if (window.innerWidth >= 1024) return 280
  if (window.innerWidth >= 768) return 240
  return 200
}
