export type ServerType = 'emby' | 'jellyfin'

export interface PosterUrlOptions {
  baseUrl: string
  token?: string
  serverType: ServerType
  itemId: string
  imageTag?: string
  maxHeight?: number
  doubanPosterPath?: string
}

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
    const tokenParam = options.token ? `&token=${encodeURIComponent(options.token)}` : ''
    return `${imgBase}/Items/${options.itemId}/Images/Primary?maxHeight=${maxHeight}&tag=${encodeURIComponent(options.imageTag)}&quality=90&format=webp${tokenParam}`
  }

  const authParam = options.token ? `&api_key=${encodeURIComponent(options.token)}` : ''
  const imgBase = options.baseUrl.replace(/^https?:\/\//, 'jellyfin-image://')
  return `${imgBase}/Items/${options.itemId}/Images/Primary?maxHeight=${maxHeight}&tag=${encodeURIComponent(options.imageTag)}&quality=90&format=webp${authParam}`
}

export function getOptimalPosterHeight(): number {
  if (typeof window === 'undefined') return 240
  if (window.innerWidth >= 1280) return 320
  if (window.innerWidth >= 1024) return 280
  if (window.innerWidth >= 768) return 240
  return 200
}