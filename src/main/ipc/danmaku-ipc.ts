import { app } from 'electron'
import * as crypto from 'crypto'
import { join, basename } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { stat as fsStat, open as fsOpen, type FileHandle } from 'fs/promises'
import type {
  DanmakuComment,
  DanmakuCommentRaw,
  DanmakuCommentsResponse,
  DanmakuSearchResponse,
  DanmakuMatchMeta,
  DanmakuMatchResultV2,
  DanmakuMatchCandidate,
  DanmakuBindEntry,
  DanmakuMatchLevel
} from '../../shared/types'
import { maskSecret, resolveAppSecretInput } from '../lib/security'
import { registerIpc } from './secure-handle'

export interface DanmakuIpcHost {
  getConfig(): Record<string, unknown>
  setConfigValue(key: string, value: unknown): void
  saveConfigFile(): void
  isPathAllowed(p: string): boolean
  denyPath(message?: string): { success: false; error: string }
}

let _host: DanmakuIpcHost | null = null

function danmakuCfg(): Record<string, unknown> {
  return _host!.getConfig()
}

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


export function registerDanmakuIpc(host: DanmakuIpcHost): void {
  _host = host

// ==================== IPC: 弹幕 ====================

// ==================== 弹幕 API（DandanPlay） ====================

function getDanmakuApiConfig(): { primary: string; mirrors: string[]; appId: string; appSecret: string } {
  const storePrimary = danmakuCfg()['danmaku:api-primary'] as string | undefined
  const storeMirrors = danmakuCfg()['danmaku:api-mirrors'] as string[] | undefined
  const storeAppId = danmakuCfg()['danmaku:app-id'] as string | undefined
  const storeAppSecret = danmakuCfg()['danmaku:app-secret'] as string | undefined

  return {
    primary: storePrimary || 'https://api.dandanplay.net',
    mirrors: (storeMirrors && storeMirrors.length > 0) ? storeMirrors : [],
    appId: storeAppId || '',
    appSecret: storeAppSecret || ''
  }
}

// maskSecret 已移至 ./lib/security.ts

registerIpc('danmaku:get-config', async () => {
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

registerIpc('danmaku:set-config', async (_event, config: { primary?: string; mirrors?: string[]; appId?: string; appSecret?: string }) => {
  if (config.primary !== undefined) {
    host.setConfigValue('danmaku:api-primary', config.primary)
  }
  if (config.mirrors !== undefined) {
    host.setConfigValue('danmaku:api-mirrors', config.mirrors)
  }
  if (config.appId !== undefined) {
    host.setConfigValue('danmaku:app-id', config.appId)
  }
  // App-Secret 留空 = 保持不变：防止"打开设置不修改再保存"把已配置的 secret 清空
  const nextSecret = resolveAppSecretInput(config.appSecret)
  if (nextSecret !== undefined) {
    host.setConfigValue('danmaku:app-secret', nextSecret)
  }
  _host!.saveConfigFile()
  return { success: true }
})

registerIpc('danmaku:test-api', async (_event, url: string) => {
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
registerIpc('danmaku:parse-local-xml', async (_event, xmlPath: string) => {
  if (!_host!.isPathAllowed(xmlPath)) {
    console.warn('[danmaku:parse-local-xml] rejected path:', xmlPath)
    return _host!.denyPath()
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

registerIpc('danmaku:find-local-xml', async (_event, videoPath: string) => {
  // 只在视频同目录找同名 XML，videoPath 本身必须归属允许目录
  if (!_host!.isPathAllowed(videoPath)) {
    console.warn('[danmaku:find-local-xml] rejected path:', videoPath)
    return _host!.denyPath()
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

registerIpc('danmaku:bilibili-match', async (_event, title: string) => {
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

registerIpc('danmaku:bilibili-comments', async (_event, cid: number) => {
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

registerIpc('danmaku:search', async (_event, keyword: string) => {
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

registerIpc('danmaku:match', async (_event, title: string) => {
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

registerIpc('danmaku:get-comments', async (_event, episodeId: string, source?: string) => {
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

registerIpc('danmaku:get-segment-comments', async (_event, params: { episodeId: string; from: number; to: number }) => {
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

registerIpc('danmaku:prefetch-series', async (_event, animeId: number, currentEpisodeId?: number) => {
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

registerIpc('danmaku:get-cached-comments', async (_event, episodeId: string) => {
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
registerIpc('danmaku:match-episode', async (_event, meta: DanmakuMatchMeta): Promise<DanmakuMatchResultV2> => {
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
registerIpc('danmaku:bind-episode', async (_event, entry: DanmakuBindEntry) => {
  setBoundEpisode(entry)
  console.log(`[danmaku:bind-episode] 已绑定 ${entry.mediaSourceId}:${entry.itemId} → episodeId=${entry.episodeId} (${entry.source})`)
  return { success: true }
})

// ---------- IPC: 清除手动绑定 ----------
registerIpc('danmaku:clear-bind', async (_event, mediaSourceId: string, itemId: string) => {
  clearBoundEpisode(mediaSourceId, itemId)
  console.log(`[danmaku:clear-bind] 已清除绑定 ${mediaSourceId}:${itemId}`)
  return { success: true }
})

// ---------- IPC: 获取候选列表（强制重新匹配，不读缓存） ----------
registerIpc('danmaku:get-candidates', async (_event, meta: DanmakuMatchMeta): Promise<DanmakuMatchResultV2> => {
  return await matchEpisodeEngine(meta)
})
}
