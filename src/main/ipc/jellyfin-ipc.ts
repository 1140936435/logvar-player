/**
 * jellyfin-ipc.ts — Jellyfin 内容浏览 IPC（P1 拆分）
 *
 * jellyfin:* 全部通道从 index.ts 下沉。共享运行态与 Jellyfin API 客户端
 * 统一来自 ./server-runtime.ts。通道名 / 参数 / 返回结构完全兼容（renderer 零改动）。
 */
import { registerIpc } from './secure-handle'
import {
  serverManager,
  jellyfinRequest,
  normalizeUrl,
  buildJellyfinHeaders,
  getStreamProxy,
  getActiveServerId
} from './server-runtime'
import { isSameServerOrigin } from '../lib/security'

// ==================== Jellyfin IPC 注册 ====================
export function registerJellyfinIpc(): void {
  registerIpc('jellyfin:get-libraries', async () => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      const data = await jellyfinRequest<{ Items: unknown[] }>(
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Views`
      )
      return { success: true, data }
    } catch (err) {
      console.error(`jellyfin:get-libraries failed:`, err)
      return { success: false, error: String(err) }
    }
  })

  registerIpc('jellyfin:get-items', async (_event, parentId: string, startIndex = 0, limit = 50) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
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
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items?${params.toString()}`
      )
      return { success: true, data }
    } catch (err) {
      console.error(`jellyfin:get-items failed:`, err)
      return { success: false, error: String(err) }
    }
  })

  registerIpc('jellyfin:get-children', async (_event, parentId: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
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
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items?${params.toString()}`
      )
      return { success: true, data }
    } catch (err) {
      console.error(`jellyfin:get-children failed:`, err)
      return { success: false, error: String(err) }
    }
  })

  registerIpc('jellyfin:search', async (_event, query: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      const params = new URLSearchParams({
        searchTerm: query,
        includeItemTypes: 'Movie,Series,Episode',
        recursive: 'true',
        limit: '30'
      })
      const data = await jellyfinRequest<{ Items: unknown[] }>(
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items?${params.toString()}`
      )
      return { success: true, data }
    } catch (err) {
      console.error(`jellyfin:search failed:`, err)
      return { success: false, error: String(err) }
    }
  })

  registerIpc('jellyfin:get-item-details', async (_event, itemId: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      const data = await jellyfinRequest(
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items/${itemId}?Fields=MediaSources,MediaStreams,People,Genres,Studios,OfficialRating,CommunityRating,VoteCount`
      )
      return { success: true, data }
    } catch (err) {
      console.error(`jellyfin:get-item-details failed:`, err)
      return { success: false, error: String(err) }
    }
  })

  // ==================== 播放流代理（凭据不出主进程） ====================

  registerIpc('jellyfin:get-playback-url', async (_event, itemId: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }

    try {
      // 确保回环代理已监听（幂等），否则 createSession 会拿到 port=0 的不可用 URL
      await getStreamProxy().start()
      // 第1步：获取 item 详情，提取真实 MediaSourceId 和字幕轨道
      const item = await jellyfinRequest<{
        MediaSources?: {
          Id: string; Name?: string; Container?: string
          MediaStreams?: { Index: number; Type: string; DisplayTitle?: string; Language?: string; Codec?: string; IsExternal?: boolean; DeliveryUrl?: string }[]
        }[]
      }>(serverManager.auth, `/Users/${serverManager.auth.userId}/Items/${itemId}?Fields=MediaSources,MediaStreams`)

      const mediaSources = item?.MediaSources
      if (!mediaSources || mediaSources.length === 0) {
        console.warn(`No MediaSources for item ${itemId}, trying itemId as fallback`)
        const activeId = getActiveServerId()
        if (!activeId) return { success: false, error: '未找到活跃服务器' }
        const url = getStreamProxy().createSession(activeId, `/Videos/${itemId}/stream?Static=true`)
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
      const url = getStreamProxy().createSession(activeId, `/Videos/${itemId}/stream?Static=true&MediaSourceId=${mediaSourceId}`)
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
  registerIpc('jellyfin:fetch-subtitle', async (_event, endpoint: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      console.log(`fetch-subtitle: requesting endpoint=${endpoint}`)
      // 如果 endpoint 是完整 URL（DeliveryUrl），提取路径部分
      let path = endpoint
      if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
        const u = new URL(endpoint)
        path = u.pathname + u.search
      }
      const baseUrl = normalizeUrl(serverManager.auth.url)
      const url = `${baseUrl}${path}`
      // capability 限制：本通道会带上服务器 token，只允许取字幕资源，
      // 防止 Renderer 把它当作“带 token 的任意服务器请求”跳板
      if (!isSameServerOrigin(url, serverManager.auth.url)) {
        console.warn(`fetch-subtitle: 目标越权，已拒绝 endpoint=${endpoint}`)
        return { success: false, error: '字幕请求越权：目标不属于当前服务器' }
      }
      const looksLikeSubtitle =
        /\/Subtitles\//i.test(path) || /\.(vtt|srt|ass|ssa|sub)([?#]|$)/i.test(path)
      if (!looksLikeSubtitle) {
        console.warn(`fetch-subtitle: 非字幕资源，已拒绝 path=${path}`)
        return { success: false, error: '字幕请求越权：非字幕资源' }
      }
      console.log(`fetch-subtitle: full url=${url}`)
      const response = await fetch(url, {
        headers: { 'X-Emby-Token': serverManager.auth.token }
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

  registerIpc('jellyfin:report-progress', async (_event, itemId: string, position: number, isPaused: boolean) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      await jellyfinRequest(serverManager.auth, `/Sessions/Playing/Progress`, {
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

  registerIpc('jellyfin:toggle-favorite', async (_event, itemId: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      const item = await jellyfinRequest<{ UserData?: { IsFavorite?: boolean } }>(
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items/${itemId}`
      )
      const isFav = item?.UserData?.IsFavorite ?? false
      await jellyfinRequest(
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/FavoriteItems/${itemId}`,
        { method: isFav ? 'DELETE' : 'POST' }
      )
      return { success: true, data: { isFavorite: !isFav } }
    } catch (err) {
      console.error(`jellyfin:toggle-favorite failed:`, err)
      return { success: false, error: String(err) }
    }
  })


  registerIpc('jellyfin:get-episodes', async (_event, seriesId: string, seasonId?: string) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
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
          serverManager.auth,
          `/Users/${serverManager.auth.userId}/Items?${params.toString()}`
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
        serverManager.auth,
        `/Users/${serverManager.auth.userId}/Items?${seasonsParams.toString()}`
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
          serverManager.auth,
          `/Users/${serverManager.auth.userId}/Items?${epsParams.toString()}`
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
          serverManager.auth,
          `/Users/${serverManager.auth.userId}/Items?${epsParams.toString()}`
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

  registerIpc('jellyfin:get-genres', async () => {
    try {
      if (!serverManager.auth) return { success: false, error: '未连接 Jellyfin' }
      const result = await jellyfinRequest<{ Items?: Array<{ Id: string; Name: string }> }>(
        serverManager.auth, '/Genres?userId=' + serverManager.auth.userId
      )
      return { success: true, data: result.Items || [] }
    } catch (err) {
      console.error('jellyfin:get-genres failed:', err)
      return { success: false, error: String(err) }
    }
  })

  registerIpc('jellyfin:get-genre-items', async (_event, genre: string, startIndex?: number) => {
    try {
      if (!serverManager.auth) return { success: false, error: '未连接 Jellyfin' }
      const baseUrl = normalizeUrl(serverManager.auth.url)
      const url = `${baseUrl}/Items?userId=${serverManager.auth.userId}&genres=${encodeURIComponent(genre)}&recursive=true&includeItemTypes=Movie,Series&sortBy=SortName&startIndex=${startIndex || 0}&limit=50`
      console.log(`[jellyfin:get-genre-items] GET ${url}`)
      const response = await fetch(url, { headers: buildJellyfinHeaders(serverManager.auth.token, serverManager.auth.type) })
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

  registerIpc('jellyfin:get-latest-media', async (_event, limit: number = 16) => {
    if (!serverManager.auth) return { success: false, error: '未连接到 Jellyfin 服务器' }
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        includeItemTypes: 'Movie,Series',
        enableImages: 'true',
        enableUserData: 'true',
        groupItems: 'false',
        fields: 'Overview,PremiereDate,CommunityRating,DateCreated'
      })
      const endpoint = `/Users/${serverManager.auth.userId}/Items/Latest?${params.toString()}`
      console.log(`[jellyfin:get-latest-media] 请求参数: userId=${serverManager.auth.userId}, limit=${limit}, includeItemTypes=Movie,Series`)

      const data = await jellyfinRequest<unknown[]>(serverManager.auth, endpoint)

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

}
