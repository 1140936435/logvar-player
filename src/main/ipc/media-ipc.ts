import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import {
  isAllowedDoubanImageUrl,
  MAX_IMAGE_BYTES,
  assertAllowedImageResponse,
  readBodyWithLimit
} from '../lib/security'
import { secureHandleRaw } from './secure-handle'
import { V } from './secure-schema'


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

secureHandleRaw('poster:load-all', [], async () => {
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

secureHandleRaw('poster:save-mapping', [V.string(), V.string()], async (_event, itemId: string, localPath: string) => {
  const map = loadPosterMap()
  map[itemId] = localPath
  savePosterMap(map)
  return { success: true }
})


// ==================== IPC: 豆瓣刮削 ====================

secureHandleRaw('media:search-douban', [V.shape({ query: V.string(), year: V.optional(V.number()), type: V.optional(V.string()) })], async (_event, params: { query: string; year?: number; type?: string }) => {
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

secureHandleRaw('media:fetch-douban-poster', [V.shape({ doubanId: V.string(), posterUrl: V.string() })], async (_event, params: { doubanId: string; posterUrl: string }) => {
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
    // 统一走 redirect-safe 抓取：每跳校验豆瓣白名单 + MIME/大小校验
    const { buffer } = await fetchDoubanImage(params.posterUrl, 15000)
    writeFileSync(localPath, buffer)
    console.log(`[douban] poster saved: ${localPath}`)
    return { success: true, data: { localPath } }
  } catch (e: any) {
    return { success: false, error: e?.message || '下载失败' }
  }
})

/**
 * 抓取豆瓣图片（协议与海报下载共用）：
 * - 手动处理重定向，每一跳都必须仍命中豆瓣白名单域名，防止 302 跳到内网/任意主机（SSRF）
 * - 校验响应 MIME 与大小上限，避免非图片/超大响应进入缓存或落盘
 */
export async function fetchDoubanImage(
  url: string,
  timeoutMs: number
): Promise<{ buffer: Buffer; mime: string }> {
  let current = url
  for (let hop = 0; ; hop++) {
    if (!isAllowedDoubanImageUrl(current)) {
      throw new Error('豆瓣图片重定向到非白名单地址')
    }
    const res = await fetch(current, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://movie.douban.com/'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (res.status >= 300 && res.status < 400) {
      if (hop >= 3) throw new Error('豆瓣图片重定向次数过多')
      const loc = res.headers.get('location')
      if (!loc) throw new Error('豆瓣图片重定向缺少 Location')
      current = new URL(loc, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`下载失败: ${res.status}`)
    // 只信任实际字节数：边读边计数，超限立即中止（防缺 content-length 的无限流撑爆内存）
    const buffer = await readBodyWithLimit(res.body, MAX_IMAGE_BYTES)
    const mime = assertAllowedImageResponse(res.headers.get('content-type'), buffer.length)
    return { buffer, mime }
  }
}

