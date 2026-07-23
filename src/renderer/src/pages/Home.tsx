import { useNavigate, Link } from 'react-router-dom'
import { useRef, useState, useEffect, useCallback, useMemo, memo, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, FolderOpen, Video, ChevronRight, ArrowLeft,
  Clock, Trash2, X, Loader2, TvMinimal, Film, Folder, Database, ChevronDown, CircleDot, ImagePlus, Download, Globe
} from 'lucide-react'
import { cachedFetch, clearCache } from '../utils/apiCache'
import { formatTimeAgo } from '../utils/time'
import { useHomeStore } from '../providers/HomeStoreProvider'
import { RecentlyAddedRow } from '../components/RecentlyAddedRow'
import { MediaCard } from '../components/MediaCard'
import { VirtualMediaGrid } from '../components/VirtualMediaGrid'
import { LazyImage } from '../components/LazyImage'
import { getPosterUrl as buildPosterUrl, getOptimalPosterHeight } from '../utils/posterUrl'
import {
  getRecentlyAddedConfig,
  saveRecentlyAddedConfig
} from '../utils/recentlyAdded'
import type { RecentlyAddedItem } from '../../../shared/types'

/* ==================== 类型 ==================== */

interface Library {
  Id: string
  Name: string
  CollectionType?: string
}

interface MediaItem {
  Id: string
  Name: string
  Type: string
  ProductionYear?: number
  Overview?: string
  ImageTags?: Record<string, string>
  SeriesName?: string
  SeriesId?: string
  SeasonId?: string
  IndexNumber?: number
  ParentIndexNumber?: number
  IsFolder?: boolean
  ChildCount?: number
  CommunityRating?: number
}

interface PlayHistoryItem {
  itemId: string
  name: string
  duration: number
  position: number
  posterUrl: string
  watchedAt: number
  localFile?: string
  baseUrl?: string
  seriesName?: string
  seriesId?: string
  seasonId?: string
}

type PageState = 'loading' | 'not_connected' | 'error' | 'empty' | 'ready'

interface DrillLevel {
  parentName: string
  parentId: string
  items: MediaItem[]
}

interface ServerConfig {
  id: string
  name: string
  url: string
  token: string
}

interface ServerInfo {
  id: string
  server: ServerConfig | null
}

const HistoryCard = memo(function HistoryCard({ item, onClick, onDelete }: {
  item: PlayHistoryItem
  onClick: () => void
  onDelete: (e: React.MouseEvent) => void
}): ReactElement {
  const progressPercent = item.duration > 0 ? (item.position / item.duration) * 100 : 0

  return (
    <div
      onClick={onClick}
      className="flex-shrink-0 group cursor-pointer relative w-[180px] sm:w-[200px] lg:w-[240px]"
    >
      <div className="aspect-video rounded-[var(--radius-lg)] overflow-hidden relative bg-[var(--bg-elevated)] border border-[var(--separator)]">
        <LazyImage
          src={item.posterUrl || null}
          alt={item.name}
          className="w-full h-full relative"
          fallback={
            <div className="w-full h-full flex items-center justify-center">
              <Video size={24} className="text-[var(--text-quaternary)]" />
            </div>
          }
        />

        <div className="absolute bottom-0 inset-x-0 h-[3px] bg-[var(--separator)]">
          <div
            className="h-full bg-[var(--accent)] transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
          <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white" className="ml-0.5"><polygon points="6,3 20,12 6,21" /></svg>
          </div>
        </div>

        <button
          onClick={onDelete}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-black/50 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--error)]/50"
        >
          <X size={12} className="text-white/70" />
        </button>
      </div>

      <div className="mt-2">
        <p className="text-[12px] text-[var(--text-primary)] font-medium truncate" title={item.name}>{item.name}</p>
        <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{formatTimeAgo(item.watchedAt)}</p>
      </div>
    </div>
  )
})

/* ==================== Home 主组件 ==================== */

function Home(): ReactElement {
  const navigate = useNavigate()
  const homeStore = useHomeStore()
  const [pageState, setPageState] = useState<PageState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [libraries, setLibraries] = useState<Library[]>([])
  const [libraryItems, setLibraryItems] = useState<Record<string, MediaItem[]>>({})
  const [libraryTotalCounts, setLibraryTotalCounts] = useState<Record<string, number>>({})
  const [libraryLoadCounts, setLibraryLoadCounts] = useState<Record<string, number>>({})
  const [libraryLoadingMore, setLibraryLoadingMore] = useState<Record<string, boolean>>({})
  const LIBRARY_PAGE_SIZE = 50
  const [connectedServer, setConnectedServer] = useState('')
  const [jellyfinToken, setJellyfinToken] = useState('')
  // 当前连接的服务器类型：'jellyfin' | 'emby'
  const [serverType, setServerType] = useState<'jellyfin' | 'emby'>('jellyfin')

  // 多服务器
  const [servers, setServers] = useState<ServerConfig[]>([])
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [showServerDropdown, setShowServerDropdown] = useState(false)
  const [switchingServer, setSwitchingServer] = useState(false)

  const [historyItems, setHistoryItems] = useState<PlayHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // 最近入库
  const [recentlyAddedItems, setRecentlyAddedItems] = useState<RecentlyAddedItem[]>([])
  const [recentlyAddedEnabled, setRecentlyAddedEnabled] = useState(true)
  const [recentlyAddedLoading, setRecentlyAddedLoading] = useState(false)
  const [recentlyAddedScrollPos, setRecentlyAddedScrollPos] = useState(0)
  const [recentlyAddedScrollSpeed, setRecentlyAddedScrollSpeed] = useState(1)

  const [drillStack, setDrillStack] = useState<DrillLevel[]>([])
  const [drillLoading, setDrillLoading] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MediaItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [isSearching, setIsSearching] = useState(false)

  // 分类快捷跳转（使用 Jellyfin 媒体库分类）
  const [activeLibrary, setActiveLibrary] = useState('')

  // 豆瓣刮削 + 本地封面
  const [doubanPosters, setDoubanPosters] = useState<Record<string, string>>({})
  const [scrapeItem, setScrapeItem] = useState<MediaItem | null>(null)
  const [scrapeLoading, setScrapeLoading] = useState(false)
  const [scrapeResults, setScrapeResults] = useState<Array<{id: number; title: string; year: string; poster: string; overview: string}>>([])
  const [scrapeError, setScrapeError] = useState('')

  const searchInputRef = useRef<HTMLInputElement>(null)

  // 加载本地海报映射
  useEffect(() => {
    let cancelled = false
    // 加载持久化的海报映射
    window.api.store.get('poster-map').then((data: any) => {
      if (!cancelled && data) {
        setDoubanPosters(data as Record<string, string>)
      }
    })
    return () => { cancelled = true }
  }, [])

  const isFolderItem = (item: MediaItem): boolean => {
    return !!(item.IsFolder || (item.ChildCount && item.ChildCount > 0))
  }

  const loadMediaData = useCallback(async () => {
    if (homeStore.isFresh()) {
      console.log('[Home] 使用缓存数据，跳过 API 请求')
      const { state } = homeStore
      if (state.libraries.length > 0) {
        setLibraries(state.libraries as Library[])
        setLibraryItems(state.libraryItems as Record<string, MediaItem[]>)
        setLibraryTotalCounts(state.libraryTotalCounts)
        const loadCountMap: Record<string, number> = {}
        Object.entries(state.libraryItems).forEach(([id, items]) => {
          loadCountMap[id] = items.length
        })
        setLibraryLoadCounts(loadCountMap)
        if (state.recentlyAdded.length > 0) {
          setRecentlyAddedItems(state.recentlyAdded as RecentlyAddedItem[])
        }
        const hasItems = Object.values(state.libraryItems).some((items) => items.length > 0)
        setPageState(hasItems ? 'ready' : 'empty')
      } else {
        setPageState('empty')
        setLibraries([])
      }
      return
    }

    setPageState('loading')
    setErrorMsg('')
    setDrillStack([])

    try {
      let libResult = await window.api.jellyfin.getLibraries()
      if (!libResult.success && libResult.error === '未连接到 Jellyfin 服务器') {
        // 优先从旧 key 恢复，如果未连接则从多服务器列表获取活跃服务器
        const saved = await window.api.store.get('jellyfin') as { url?: string; token?: string } | null
        const servers = await window.api.store.get('jellyfin:servers') as Array<{ id?: string; url: string; token: string }> | null
        const activeId = await window.api.store.get('jellyfin:activeServerId') as string | null

        let url = saved?.url
        let token = saved?.token

        // enc: 值表示解密失败，视为空值
        if (url?.startsWith('enc:')) url = undefined
        if (token?.startsWith('enc:')) token = undefined

        // 旧 key 没有数据，从多服务器列表获取活跃服务器
        if ((!url || !token) && servers && servers.length > 0) {
          const active = activeId ? servers.find(s => s.id === activeId) : servers[0]
          if (active) {
            url = active.url?.startsWith('enc:') ? undefined : active.url
            token = active.token?.startsWith('enc:') ? undefined : active.token
          }
        }

        if (!url || !token) {
          setPageState('error')
          setErrorMsg('Jellyfin 服务器凭据未配置或无法解密，请在设置中重新输入 URL 和 Token')
          return
        }
        const connectResult = await window.api.jellyfin.connect(url, token)
        if (!connectResult.success) {
          setPageState('error')
          setErrorMsg(connectResult.error || '重新连接失败')
          return
        }
        libResult = await window.api.jellyfin.getLibraries()
      }

      if (!libResult.success) {
        setPageState('error')
        setErrorMsg(libResult.error || '获取媒体库失败')
        return
      }

      const libData = libResult.data as { Items?: Library[] }
      const libs = libData?.Items || []

      if (libs.length === 0) {
        setPageState('empty')
        setLibraries([])
        homeStore.setLibraries([])
        return
      }

      setLibraries(libs)
      homeStore.setLibraries(libs)

      const itemsMap: Record<string, MediaItem[]> = {}
      const totalMap: Record<string, number> = {}
      const loadCountMap: Record<string, number> = {}
      await Promise.all(libs.map(async (lib) => {
        try {
          const itemsResult = await cachedFetch(
            'jellyfin.getItems',
            [lib.Id, 0, LIBRARY_PAGE_SIZE],
            () => window.api.jellyfin.getItems(lib.Id, 0, LIBRARY_PAGE_SIZE),
            5 * 60 * 1000 // 5 分钟缓存
          )
          if (itemsResult.success && itemsResult.data) {
            const itemData = itemsResult.data as { Items?: MediaItem[]; TotalRecordCount?: number }
            itemsMap[lib.Id] = itemData.Items || []
            totalMap[lib.Id] = itemData.TotalRecordCount ?? 0
            loadCountMap[lib.Id] = (itemData.Items || []).length
            homeStore.setLibraryItems(lib.Id, itemData.Items || [])
            homeStore.setLibraryTotalCount(lib.Id, itemData.TotalRecordCount ?? 0)
          }
        } catch {
          itemsMap[lib.Id] = []
          totalMap[lib.Id] = 0
          loadCountMap[lib.Id] = 0
          homeStore.setLibraryItems(lib.Id, [])
          homeStore.setLibraryTotalCount(lib.Id, 0)
        }
      }))
      setLibraryItems(itemsMap)
      setLibraryTotalCounts(totalMap)
      setLibraryLoadCounts(loadCountMap)

      try {
        // 优先使用 server.getActive() 获取当前活跃服务器（包含正确的 type 字段）
        const activeResult = await window.api.server.getActive()
        if (activeResult.success && activeResult.data?.server) {
          const srv = activeResult.data.server
          if (srv.url) setConnectedServer(srv.url.replace(/\/+$/, ''))
          if (srv.token) setJellyfinToken(srv.token)
          const detectedType = (srv as any).type === 'emby' ? 'emby' : 'jellyfin'
          setServerType(detectedType)
          console.log(`[Home] 从 server.getActive 检测到服务器类型: ${detectedType}`)
        } else {
          // 降级：从旧配置读取
          const saved = await window.api.store.get('jellyfin') as { url?: string; token?: string } | null
          if (saved?.url) {
            setConnectedServer(saved.url.replace(/\/+$/, ''))
            setServerType('jellyfin')
          }
          if (saved?.token) setJellyfinToken(saved.token)
        }
      } catch { /* ignore */ }

      const hasItems = Object.values(itemsMap).some((items) => items.length > 0)
      setPageState(hasItems ? 'ready' : 'empty')

      // 媒体库数据加载完成后刷新最近入库列表（调用 Jellyfin 官方 getLatestMedia 接口）
      if (hasItems && recentlyAddedEnabled) {
        try {
          const config = await getRecentlyAddedConfig(true)
          const result = await window.api.jellyfin.getLatestMedia(config.displayCount)
          if (result.success && result.data && Array.isArray(result.data)) {
            const items: RecentlyAddedItem[] = (result.data as any[]).map((item: any) => ({
              itemId: item.Id,
              name: item.Name,
              type: (item.Type === 'Movie' ? 'Movie' : 'Series') as 'Movie' | 'Series',
              productionYear: item.ProductionYear,
              imageTag: item.ImageTags?.Primary,
              seriesName: item.SeriesName,
              seriesId: item.SeriesId,
              seasonId: item.SeasonId,
              indexNumber: item.IndexNumber,
              parentIndexNumber: item.ParentIndexNumber,
              addedAt: item.DateCreated ? new Date(item.DateCreated).getTime() : Date.now(),
              serverId: activeServerId || undefined
            }))
            setRecentlyAddedItems(items)
            homeStore.setRecentlyAdded(items)
          }
        } catch (err) {
          console.error('[Home] 刷新最近入库失败:', err)
        }
      }
    } catch (err) {
      setPageState('error')
      setErrorMsg(err instanceof Error ? err.message : '发生未知错误')
    }
  }, [activeServerId, homeStore])

  const refreshLibrary = useCallback(async () => {
    homeStore.invalidate()
    await loadMediaData()
  }, [homeStore, loadMediaData])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const result = await window.api.history.list()
      if (result.success && result.data) {
        setHistoryItems((result.data as PlayHistoryItem[]).slice(0, 20))
      }
    } catch { /* ignore */ }
    setHistoryLoading(false)
  }, [])

  // 加载最近入库数据 - 使用 Jellyfin 官方 getLatestMedia 接口
  const loadRecentlyAdded = useCallback(async (): Promise<void> => {
    setRecentlyAddedLoading(true)
    try {
      // 先加载配置
      const config = await getRecentlyAddedConfig(true)
      setRecentlyAddedEnabled(config.enabled)
      setRecentlyAddedScrollSpeed(config.scrollSpeed)
      setRecentlyAddedScrollPos(config.scrollPosition)

      if (config.enabled) {
        // 调用 Jellyfin 官方 getLatestMedia 接口
        // 该接口按 DateCreated 倒序返回最新入库媒体，无需本地排序
        const result = await window.api.jellyfin.getLatestMedia(config.displayCount)
        if (result.success && result.data && Array.isArray(result.data)) {
          // 将 Jellyfin 原始数据映射为 RecentlyAddedItem 格式
          const items: RecentlyAddedItem[] = (result.data as any[]).map((item: any) => ({
            itemId: item.Id,
            name: item.Name,
            type: (item.Type === 'Movie' ? 'Movie' : 'Series') as 'Movie' | 'Series',
            productionYear: item.ProductionYear,
            imageTag: item.ImageTags?.Primary,
            seriesName: item.SeriesName,
            seriesId: item.SeriesId,
            seasonId: item.SeasonId,
            indexNumber: item.IndexNumber,
            parentIndexNumber: item.ParentIndexNumber,
            addedAt: item.DateCreated ? new Date(item.DateCreated).getTime() : Date.now(),
            serverId: activeServerId || undefined
          }))

          console.log(`[Home] 最近入库加载完成: ${items.length} 条, 第一条: ${items[0]?.name || '空'}`)
          setRecentlyAddedItems(items)
        } else {
          console.warn('[Home] 最近入库接口返回空数据，隐藏板块')
          setRecentlyAddedItems([])
        }
      }
    } catch (err) {
      console.error('[Home] 加载最近入库失败:', err)
      setRecentlyAddedItems([])
    }
    setRecentlyAddedLoading(false)
  }, [activeServerId])

  // 处理最近入库项点击 - 直接播放
  const handleRecentlyAddedClick = useCallback((item: RecentlyAddedItem): void => {
    const base = connectedServer || 'http://localhost:8096'
    const displayName = item.type === 'Series'
      ? item.name
      : item.seriesName
        ? `${item.seriesName} - ${item.name}`
        : item.name

    const seriesName = item.seriesName || ''
    const seriesId = item.seriesId || ''
    const seasonId = item.seasonId || ''

    if (item.type === 'Series') {
      // 剧集跳转到详情页
      navigate(`/detail/${item.itemId}`)
    } else {
      // 电影直接播放
      navigate(`/player?itemId=${encodeURIComponent(item.itemId)}&name=${encodeURIComponent(displayName)}&base=${encodeURIComponent(base)}&seriesName=${encodeURIComponent(seriesName)}&seriesId=${encodeURIComponent(seriesId)}&seasonId=${encodeURIComponent(seasonId)}`)
    }
  }, [connectedServer, navigate])

  // 保存滚动位置
  const handleScrollPositionChange = useCallback((position: number): void => {
    setRecentlyAddedScrollPos(position)
    // 防抖保存
    const timer = window.setTimeout(() => {
      saveRecentlyAddedConfig({ scrollPosition: position }).catch(() => {})
    }, 500)
    return () => window.clearTimeout(timer)
  }, [])

  const loadMoreLoadingRef = useRef<Record<string, boolean>>({})

  const loadMoreLibraryItems = useCallback(async (libId: string): Promise<void> => {
    // 防止重复加载
    if (loadMoreLoadingRef.current[libId]) return
    loadMoreLoadingRef.current[libId] = true
    const currentCount = libraryLoadCounts[libId] || 0
    setLibraryLoadingMore(prev => ({ ...prev, [libId]: true }))
    try {
      const itemsResult = await window.api.jellyfin.getItems(libId, currentCount, LIBRARY_PAGE_SIZE)
      if (itemsResult.success && itemsResult.data) {
        const itemData = itemsResult.data as { Items?: MediaItem[]; TotalRecordCount?: number }
        const newItems = itemData.Items || []
        setLibraryItems(prev => ({
          ...prev,
          [libId]: [...(prev[libId] || []), ...newItems]
        }))
        setLibraryLoadCounts(prev => ({
          ...prev,
          [libId]: currentCount + newItems.length
        }))
        if (itemData.TotalRecordCount != null) {
          setLibraryTotalCounts(prev => ({ ...prev, [libId]: itemData.TotalRecordCount! }))
        }
      }
    } catch (err) { console.error('[Library] 加载更多失败:', err) }
    loadMoreLoadingRef.current[libId] = false
    setLibraryLoadingMore(prev => ({ ...prev, [libId]: false }))
  }, [libraryLoadCounts])

  const loadServers = useCallback(async (): Promise<void> => {
    try {
      const listResult = await window.api.server.list()
      if (listResult.success && listResult.data) {
        setServers(listResult.data as ServerConfig[])
      }
      const activeResult = await window.api.server.getActive()
      if (activeResult.success && activeResult.data) {
        const d = activeResult.data as ServerInfo
        setActiveServerId(d.id)
        if (d.server) {
          setConnectedServer(d.server.url.replace(/\/+$/, ''))
          setJellyfinToken(d.server.token)
          // 获取服务器类型，默认 jellyfin
          setServerType((d.server as any).type === 'emby' ? 'emby' : 'jellyfin')
        }
      }
    } catch { /* ignore */ }
  }, [])

  const handleSwitchServer = useCallback(async (id: string): Promise<void> => {
    setSwitchingServer(true)
    setShowServerDropdown(false)
    setErrorMsg('')
    try {
      const result = await window.api.server.switch(id)
      if (result.success) {
        // 关键：使 homeStore 缓存失效，否则 loadMediaData 会直接使用旧服务器缓存
        homeStore.invalidate()
        // 清除 API 内存缓存
        clearCache('jellyfin.')
        clearCache('emby.')
        // 重置分类和搜索状态
        setActiveLibrary('')
        setIsSearching(false)
        setSearchResults([])
        setSearchQuery('')
        setDrillStack([])
        // 重新加载数据
        await loadServers()
        await loadMediaData()
        await loadHistory()
        await loadRecentlyAdded()
      } else {
        setErrorMsg(result.error || '切换服务器失败')
        console.error('[Home] 切换服务器失败:', result.error)
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '切换服务器时发生未知错误')
      console.error('[Home] 切换服务器异常:', err)
    }
    setSwitchingServer(false)
  }, [homeStore, loadServers, loadMediaData, loadHistory, loadRecentlyAdded])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  useEffect(() => {
    loadMediaData()
    loadHistory()
    loadRecentlyAdded()
  }, [loadMediaData, loadHistory, loadRecentlyAdded])

  const handleDrillDown = async (item: MediaItem): Promise<void> => {
    setDrillLoading(true)
    try {
      const result = await window.api.jellyfin.getChildren(item.Id)
      if (result.success && result.data) {
        const data = result.data as { Items?: MediaItem[] }
        setDrillStack((prev) => [
          ...prev,
          { parentName: item.Name, parentId: item.Id, items: data.Items || [] }
        ])
      }
    } catch { /* ignore */ }
    setDrillLoading(false)
  }

  const handleGoBack = (): void => {
    if (isSearching) {
      // 搜索模式下：如果已在顶层，退出搜索
      if (drillStack.length === 0) {
        handleClearSearch()
        return
      }
    }
    setDrillStack((prev) => prev.slice(0, -1))
  }

  const handlePlay = (item: MediaItem): void => {
    const base = connectedServer || 'http://localhost:8096'
    const displayName = item.Type === 'Episode' && item.IndexNumber != null
      ? `EP${String(item.IndexNumber).padStart(2, '0')} - ${item.Name}`
      : item.SeriesName
        ? `${item.SeriesName} S${String(item.IndexNumber ?? '?').padStart(2, '0')} - ${item.Name}`
        : item.Name

    const seriesName = item.SeriesName || ''
    const seriesId = item.SeriesId || ''
    const seasonId = item.SeasonId || ''
    navigate(`/player?itemId=${encodeURIComponent(item.Id)}&name=${encodeURIComponent(displayName)}&base=${encodeURIComponent(base)}&seriesName=${encodeURIComponent(seriesName)}&seriesId=${encodeURIComponent(seriesId)}&seasonId=${encodeURIComponent(seasonId)}`)
  }

  const handleSearch = async (): Promise<void> => {
    const q = searchQuery.trim()
    if (!q) return
    setSearchLoading(true)
    setIsSearching(true)
    setSearchResults([])
    try {
      const result = await window.api.jellyfin.search(q)
      if (result.success && result.data) {
        const data = result.data as { Items?: MediaItem[] }
        setSearchResults(data.Items || [])
      } else {
        setSearchResults([])
      }
    } catch {
      setSearchResults([])
    }
    setSearchLoading(false)
  }

  const handleClearSearch = (): void => {
    setSearchQuery('')
    setSearchResults([])
    setIsSearching(false)
    setDrillStack([])
  }

  const handleLibraryClick = (libId: string): void => {
    if (activeLibrary === libId) {
      setActiveLibrary('')
      return
    }
    setActiveLibrary(libId)
    setIsSearching(false)
    setSearchResults([])
    setDrillStack([])
  }

  const handleHistoryPlay = (item: PlayHistoryItem): void => {
    if (item.localFile) {
      navigate(`/player?file=${encodeURIComponent(item.localFile)}&name=${encodeURIComponent(item.name)}&position=${item.position}`)
    } else {
      const base = item.baseUrl || 'http://localhost:8096'
      const seriesName = item.seriesName || ''
      const seriesId = item.seriesId || ''
      const seasonId = item.seasonId || ''
      navigate(`/player?itemId=${encodeURIComponent(item.itemId)}&name=${encodeURIComponent(item.name)}&base=${encodeURIComponent(base)}&seriesName=${encodeURIComponent(seriesName)}&seriesId=${encodeURIComponent(seriesId)}&seasonId=${encodeURIComponent(seasonId)}&position=${item.position}`)
    }
  }

  const handleHistoryDelete = async (e: React.MouseEvent, itemId: string): Promise<void> => {
    e.stopPropagation()
    try {
      await window.api.history.delete(itemId)
      setHistoryItems((prev) => prev.filter((h) => h.itemId !== itemId))
    } catch { /* ignore */ }
  }

  const handleHistoryClear = async (): Promise<void> => {
    try {
      await window.api.history.clear()
      setHistoryItems([])
    } catch { /* ignore */ }
  }

  const handleItemClick = useCallback((item: MediaItem): void => {
    // 电视剧和电影直接进详情页
    if (item.Type === 'Series' || item.Type === 'Movie') {
      navigate(`/detail/${item.Id}`)
      return
    }
    if (isFolderItem(item)) {
      handleDrillDown(item)
    } else {
      navigate(`/detail/${item.Id}`)
    }
  }, [navigate, handleDrillDown])

  // 豆瓣刮削
  const handleScrape = useCallback(async (item: MediaItem): Promise<void> => {
    setScrapeItem(item)
    setScrapeLoading(true)
    setScrapeResults([])
    setScrapeError('')
    try {
      let name = item.Name
      let year: number | undefined
      const yearMatch = name.match(/\(?(19\d{2}|20\d{2})\)?/)
      if (yearMatch) {
        year = parseInt(yearMatch[1])
        name = name.replace(/\s*\(?(19\d{2}|20\d{2})\)?/, '').trim()
      }
      const r = await window.api.jellyfin.scrape.search({
        query: name,
        year,
        type: item.Type === 'Movie' ? 'movie' : 'tv'
      })
      if (r.success && r.data) {
        setScrapeResults(r.data.map((item: { id: string; title: string; year: string; poster: string; overview: string }) => ({
          ...item,
          id: Number(item.id)
        })))
      } else {
        setScrapeError(r.error || '豆瓣搜索失败')
      }
    } catch (e: any) {
      setScrapeError(e?.message || '搜索异常')
    } finally {
      setScrapeLoading(false)
    }
  }, [])

  const handleSelectPoster = useCallback(async (doubanId: string, posterUrl: string): Promise<void> => {
    if (!scrapeItem) return
    setScrapeLoading(true)
    try {
      const r = await window.api.jellyfin.scrape.fetch({ doubanId, posterUrl })
      if (!r || !r.success || !r.data) {
        setScrapeError(r?.error || '下载封面失败')
        setScrapeLoading(false)
        return
      }
      if (r.data.localPath) {
        setDoubanPosters(prev => {
          const next = { ...prev, [scrapeItem.Id]: r.data!.localPath }
          window.api.store.get('poster-map').then((map: any) => {
            window.api.store.set('poster-map', { ...(map || {}), [scrapeItem.Id]: r.data!.localPath })
          })
          return next
        })
        setScrapeItem(null)
        setScrapeResults([])
      } else {
        setScrapeError(r.error || '下载封面失败')
      }
    } catch (e: any) {
      setScrapeError(e?.message || '下载异常')
    } finally {
      setScrapeLoading(false)
    }
  }, [scrapeItem])


  const getPosterUrl = useCallback((item: MediaItem): string | null => {
    return buildPosterUrl({
      baseUrl: connectedServer || 'http://localhost:8096',
      token: jellyfinToken,
      serverType,
      itemId: item.Id,
      imageTag: item.ImageTags?.Primary,
      doubanPosterPath: doubanPosters[item.Id],
    })
  }, [connectedServer, jellyfinToken, serverType, doubanPosters])

  const breadcrumb = drillStack.map((d) => d.parentName)
  const currentDrill = drillStack.length > 0 ? drillStack[drillStack.length - 1] : null

  /* ==================== 加载状态 ==================== */
  if (pageState === 'loading') {
    return (
      <div className="w-full flex justify-center">
        <div className="max-w-6xl px-6 py-16 w-full flex items-center justify-center">
          <Loader2 size={20} className="text-[var(--accent)] animate-spin" />
          <span className="text-[15px] text-[var(--text-tertiary)] ml-3">加载中...</span>
        </div>
      </div>
    )
  }

  /* ==================== 未连接 ==================== */
  if (pageState === 'not_connected') {
    return (
      <div className="w-full flex justify-center">
        <div className="max-w-6xl px-6 py-16 w-full">
          <motion.div
            className="text-center py-24"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <div className="w-16 h-16 mx-auto mb-6 rounded-[var(--radius-xl)] bg-[var(--accent-bg)] flex items-center justify-center">
              <TvMinimal size={28} className="text-[var(--accent)]" />
            </div>
            <h2 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">连接你的媒体服务器</h2>
            <p className="text-[15px] text-[var(--text-secondary)] mb-10 max-w-sm mx-auto">
              配置 Jellyfin 服务器后，即可浏览和播放你的媒体库内容
            </p>
            <Link to="/settings" className="ios-btn ios-btn-primary no-underline">
              前往设置
              <ChevronRight size={16} />
            </Link>
          </motion.div>

          {/* 本地文件快捷入口 */}
          <div className="mt-6 text-center">
            <p className="text-[13px] text-[var(--text-tertiary)] mb-5">或直接打开本地文件</p>
            <div className="flex justify-center gap-3">
              <motion.button
                onClick={async () => {
                  const result = await window.api.file.openFile()
                  if (result.success && result.data) {
                    const data = result.data as { filePath: string }
                    const fname = data.filePath.split(/[/\\]/).pop() || '本地视频'
                    navigate(`/player?file=${encodeURIComponent(data.filePath)}&name=${encodeURIComponent(fname)}`)
                  }
                }}
                className="ios-btn ios-btn-secondary"
                whileTap={{ scale: 0.96 }}
              >
                <Video size={16} />
                打开文件
              </motion.button>
              <motion.button
                onClick={async () => {
                  const result = await window.api.file.openFolder()
                  if (result.success && result.data) {
                    const data = result.data as { files: string[]; folderPath: string }
                    if (data.files.length === 0) {
                      alert('文件夹中未找到视频文件')
                    } else {
                      const firstPath = data.files[0]
                      const fname = firstPath.split(/[/\\]/).pop() || '本地视频'
                      navigate(`/player?file=${encodeURIComponent(firstPath)}&name=${encodeURIComponent(fname)}`)
                    }
                  }
                }}
                className="ios-btn ios-btn-secondary"
                whileTap={{ scale: 0.96 }}
              >
                <FolderOpen size={16} />
                打开文件夹
              </motion.button>
            </div>
          </div>

          {/* 网络串流 */}
          <div className="mt-6 text-center">
            <p className="text-[13px] text-[var(--text-tertiary)] mb-5">或输入串流地址</p>
            <div className="flex justify-center gap-2 max-w-md mx-auto">
              <input
                type="text"
                placeholder="rtsp://  rtmp://  http://  m3u8..."
                className="flex-1 px-4 py-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] text-sm placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const url = (e.target as HTMLInputElement).value.trim()
                    if (url && (url.startsWith('rtsp://') || url.startsWith('rtmp://') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mms://'))) {
                      navigate(`/player?file=${encodeURIComponent(url)}&name=${encodeURIComponent(url.split('/').pop() || url)}`)
                    }
                  }
                }}
              />
              <button
                onClick={(e) => {
                  const input = (e.currentTarget.parentElement as HTMLElement).querySelector('input') as HTMLInputElement
                  const url = input?.value.trim()
                  if (url && (url.startsWith('rtsp://') || url.startsWith('rtmp://') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mms://'))) {
                    navigate(`/player?file=${encodeURIComponent(url)}&name=${encodeURIComponent(url.split('/').pop() || url)}`)
                  }
                }}
                className="ios-btn ios-btn-secondary flex items-center gap-1.5"
              >
                <Globe size={14} />
                播放
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ==================== 错误 ==================== */
  if (pageState === 'error') {
    return (
      <div className="w-full flex justify-center">
        <div className="max-w-6xl px-6 py-16 w-full">
          <div className="text-center py-24">
            <h2 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">加载失败</h2>
            <p className="text-[15px] text-[var(--text-secondary)] mb-10">{errorMsg}</p>
            <motion.button onClick={refreshLibrary} className="ios-btn ios-btn-primary" whileTap={{ scale: 0.96 }}>重试</motion.button>
          </div>
        </div>
      </div>
    )
  }

  /* ==================== 主内容 ==================== */
  return (
    <div className="w-full flex justify-center">
      <div className="px-4 sm:px-6 lg:px-8 py-6 w-full">

        {/* 面包屑导航 */}
        <AnimatePresence>
          {breadcrumb.length > 0 && (
            <motion.div
              className="flex items-center gap-2 text-[13px] text-[var(--text-tertiary)] mb-6"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <button onClick={handleGoBack} className="flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors ios-btn ios-btn-ghost !px-2 !h-8">
                <ArrowLeft size={14} />
                返回
              </button>
              <ChevronRight size={12} className="text-[var(--text-quaternary)]" />
              <span>媒体库</span>
              {breadcrumb.map((name, idx) => (
                <span key={idx} className={idx === breadcrumb.length - 1 ? 'text-[var(--text-primary)] font-medium' : ''}>
                  <ChevronRight size={12} className="text-[var(--text-quaternary)] mx-0.5 inline" />
                  {name}
                </span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 顶栏：搜索 + 打开文件/文件夹 + 服务器切换 */}
        <div className="mb-10">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
              placeholder="搜索媒体内容..."
              className="w-full ios-input !pl-11 !pr-28 !rounded-[var(--radius-md)]"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              {isSearching && (
                <button onClick={handleClearSearch} className="glass-btn-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  清空
                </button>
              )}
              <motion.button
                onClick={handleSearch}
                disabled={searchLoading || !searchQuery.trim()}
                className="ios-btn ios-btn-primary !h-8 !px-4 !text-[13px] disabled:!opacity-35"
                whileTap={{ scale: 0.96 }}
              >
                {searchLoading ? <Loader2 size={14} className="animate-spin" /> : '搜索'}
              </motion.button>
            </div>
          </div>

          {/* 打开文件 / 打开文件夹 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <motion.button
              onClick={async () => {
                const result = await window.api.file.openFile()
                if (result.success && result.data) {
                  const data = result.data as { filePath: string }
                  const fname = data.filePath.split(/[/\\]/).pop() || '本地视频'
                  navigate(`/player?file=${encodeURIComponent(data.filePath)}&name=${encodeURIComponent(fname)}`)
                }
              }}
              className="ios-btn ios-btn-secondary !h-10 !px-3 flex items-center gap-2"
              whileTap={{ scale: 0.96 }}
              title="打开本地视频文件"
            >
              <Video size={15} />
              <span className="text-[13px] hidden sm:inline">打开文件</span>
            </motion.button>
            <motion.button
              onClick={async () => {
                const result = await window.api.file.openFolder()
                if (result.success && result.data) {
                  const data = result.data as { files: string[]; folderPath: string }
                  if (data.files.length === 0) {
                    alert('文件夹中未找到视频文件')
                  } else {
                    const firstPath = data.files[0]
                    const fname = firstPath.split(/[/\\]/).pop() || '本地视频'
                    navigate(`/player?file=${encodeURIComponent(firstPath)}&name=${encodeURIComponent(fname)}`)
                  }
                }
              }}
              className="ios-btn ios-btn-secondary !h-10 !px-3 flex items-center gap-2"
              whileTap={{ scale: 0.96 }}
              title="打开视频文件夹"
            >
              <FolderOpen size={15} />
              <span className="text-[13px] hidden sm:inline">打开文件夹</span>
            </motion.button>
          </div>

          {/* 服务器切换器 */}
          {servers.length > 1 && (
            <div className="relative flex-shrink-0">
              <motion.button
                onClick={() => setShowServerDropdown(!showServerDropdown)}
                disabled={switchingServer}
                className="ios-btn ios-btn-secondary !h-10 !px-3 flex items-center gap-2"
                whileTap={{ scale: 0.96 }}
              >
                {switchingServer ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Database size={14} />
                )}
                <span className="text-[13px] truncate max-w-[120px]">
                  {servers.find(s => s.id === activeServerId)?.name || '切换服务器'}
                </span>
                <ChevronDown size={14} className={`transition-transform ${showServerDropdown ? 'rotate-180' : ''}`} />
              </motion.button>

              <AnimatePresence>
                {showServerDropdown && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowServerDropdown(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: -4, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.95 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className="absolute right-0 top-full mt-2 w-56 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--separator)] shadow-lg z-50 overflow-hidden"
                    >
                      <div className="p-1.5">
                        {servers.map((server) => (
                          <button
                            key={server.id}
                            onClick={() => handleSwitchServer(server.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-left transition-colors ${
                              server.id === activeServerId
                                ? 'bg-[var(--accent-bg)] text-[var(--accent)]'
                                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                            }`}
                          >
                            <Database size={14} className="flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-medium truncate">{server.name}</div>
                              <div className="text-[11px] text-[var(--text-tertiary)] truncate">{server.url}</div>
                            </div>
                            {server.id === activeServerId && (
                              <CircleDot size={12} className="text-[var(--accent)] flex-shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        </div>

        {/* 分类快捷跳转 — Jellyfin 媒体库 */}
        {!isSearching && drillStack.length === 0 && libraries.length > 0 && (
          <div className="mb-8">
            <div className="flex gap-2 overflow-x-auto pt-1 pb-2">
              {libraries.filter(lib => {
                const t = lib.CollectionType
                // 显示影视类库：有明确媒体类型 + 无类型的自定义库，排除合集/书籍/音乐等
                return !t || ['movies', 'tvshows', 'mixed', 'homevideos'].includes(t)
              }).map((lib) => (
                <motion.button
                  key={lib.Id}
                  onClick={() => handleLibraryClick(lib.Id)}
                  className={`flex-shrink-0 px-4 py-2 rounded-full text-[13px] font-medium transition-all duration-200 ${
                    activeLibrary === lib.Id
                      ? 'bg-[var(--accent)] text-white shadow-[0_2px_8px_rgba(0,122,255,0.3)]'
                      : 'bg-[var(--bg-grouped)] text-[var(--text-secondary)] border border-[var(--separator)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                  }`}
                  whileTap={{ scale: 0.95 }}
                >
                  {lib.Name}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* 分类内容 */}
        {!isSearching && activeLibrary && (() => {
          const items = libraryItems[activeLibrary] || []
          const activeLib = libraries.find(l => l.Id === activeLibrary)
          return (
            <section className="mb-12">
              <div className="flex items-center gap-2 mb-4">
                <button onClick={() => setActiveLibrary('')} className="flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-light)]">
                  <ArrowLeft size={14} /> 返回全部
                </button>
                <span className="text-[13px] text-[var(--text-tertiary)]">
                  {activeLib?.Name || activeLibrary} — {items.length} 部
                </span>
              </div>
              {items.length === 0 ? (
                <p className="text-[15px] text-[var(--text-tertiary)] py-20 text-center">该分类暂无内容</p>
              ) : (
                <div className="responsive-grid">
                  {items.map((item) => (
                    <MediaCard
                      key={item.Id}
                      item={item}
                      posterUrl={getPosterUrl(item)}
                      displayName={item.Name}
                      communityRating={item.CommunityRating}
                      onClick={() => handleItemClick(item)}
                      onScrape={() => handleScrape(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })()}

        {/* 搜索结果 */}
        {isSearching && !currentDrill && (
          <section className="mb-12">
            {searchLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={20} className="text-[var(--accent)] animate-spin" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="text-center py-20">
                <Search size={32} className="mx-auto text-[var(--text-quaternary)] mb-4" />
                <p className="text-[15px] text-[var(--text-tertiary)]">未找到相关内容</p>
                <p className="text-[13px] text-[var(--text-quaternary)] mt-1">尝试使用不同关键词</p>
              </div>
            ) : (
              <>
                <p className="text-[13px] text-[var(--text-tertiary)] mb-4">
                  搜索 &quot;{searchQuery}&quot; — {searchResults.length} 个结果
                </p>
                <div className="responsive-grid">
                  {searchResults.map((item) => (
                    <MediaCard
                      key={item.Id}
                      item={item}
                      posterUrl={getPosterUrl(item)}
                      displayName={
                        item.Type === 'Episode' && item.IndexNumber != null
                          ? `EP${String(item.IndexNumber).padStart(2, '0')} - ${item.Name}`
                          : item.Name
                      }
                      communityRating={item.CommunityRating}
                      onClick={() => handleItemClick(item)}
                      onScrape={() => handleScrape(item)}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* 搜索 drill-down */}
        {isSearching && currentDrill && (
          <section className="mb-12">
            <div className="flex items-center gap-2 text-[13px] text-[var(--text-tertiary)] mb-4">
              <button onClick={handleGoBack} className="flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-light)]">
                <ArrowLeft size={14} /> 返回
              </button>
              <ChevronRight size={12} className="text-[var(--text-quaternary)]" />
              <span>搜索: {searchQuery}</span>
              {breadcrumb.map((name, idx) => (
                <span key={idx} className={idx === breadcrumb.length - 1 ? 'text-[var(--text-primary)]' : ''}>
                  <ChevronRight size={12} className="text-[var(--text-quaternary)] mx-0.5 inline" />
                  {name}
                </span>
              ))}
            </div>
            <div className="responsive-grid">
              {currentDrill.items.map((item) => (
                <MediaCard
                  key={item.Id}
                  item={item}
                  posterUrl={getPosterUrl(item)}
                  displayName={item.Name}
                  communityRating={item.CommunityRating}
                  onClick={() => handleItemClick(item)}
                />
              ))}
            </div>
          </section>
        )}

        {/* 播放历史 - 最近播放 */}
        {!isSearching && !activeLibrary && drillStack.length === 0 && (pageState === 'ready' || pageState === 'empty') && (
          <section className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-title flex items-center gap-2">
                <Clock size={14} />
                最近播放
              </h2>
              {historyItems.length > 0 && (
                <button onClick={handleHistoryClear} className="text-[13px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1">
                  <Trash2 size={12} />
                  清空
                </button>
              )}
            </div>
            {historyLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={18} className="text-[var(--accent)] animate-spin" />
              </div>
            ) : historyItems.length === 0 ? (
              <p className="text-[13px] text-[var(--text-quaternary)] py-8 text-center">暂无播放记录</p>
            ) : (
              <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-2 px-2">
                {historyItems.map((item) => (
                  <HistoryCard
                    key={item.itemId}
                    item={item}
                    onClick={() => handleHistoryPlay(item)}
                    onDelete={(e) => handleHistoryDelete(e, item.itemId)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* 最近入库 */}
        {!isSearching && !activeLibrary && drillStack.length === 0 && recentlyAddedEnabled && recentlyAddedItems.length > 0 && (
          recentlyAddedLoading ? (
            <div className="flex items-center justify-center py-12 mb-12">
              <Loader2 size={18} className="text-[var(--accent)] animate-spin" />
              <span className="text-[13px] text-[var(--text-tertiary)] ml-3">加载中...</span>
            </div>
          ) : (
            <RecentlyAddedRow
              items={recentlyAddedItems}
              onItemClick={handleRecentlyAddedClick}
              baseUrl={connectedServer || 'http://localhost:8096'}
              token={jellyfinToken}
              serverType={serverType}
              scrollSpeed={recentlyAddedScrollSpeed}
              savedScrollPosition={recentlyAddedScrollPos}
              onScrollPositionChange={handleScrollPositionChange}
              doubanPosters={doubanPosters}
            />
          )
        )}

        {/* Drill-down 加载中 */}
        {!isSearching && drillLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={20} className="text-[var(--accent)] animate-spin" />
          </div>
        )}

        {/* Drill-down 子集 */}
        {!isSearching && !activeLibrary && !drillLoading && currentDrill && (
          <section className="mb-12">
            {currentDrill.items.length === 0 ? (
              <p className="text-[15px] text-[var(--text-tertiary)] py-20 text-center">此文件夹中暂无内容</p>
            ) : (
              <div className="responsive-grid">
                {currentDrill.items.map((item) => (
                  <MediaCard
                    key={item.Id}
                    item={item}
                    posterUrl={getPosterUrl(item)}
                    displayName={
                      item.Type === 'Episode' && item.IndexNumber != null
                        ? `EP${String(item.IndexNumber).padStart(2, '0')} - ${item.Name}`
                        : item.SeriesName
                          ? `${item.SeriesName} ${item.IndexNumber != null ? `S${String(item.IndexNumber).padStart(2, '0')}` : ''}`
                          : item.Name
                    }
                    communityRating={item.CommunityRating}
                    onClick={() => handleItemClick(item)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* 空媒体库 */}
        {!isSearching && !activeLibrary && !drillLoading && !currentDrill && pageState === 'empty' && (
          <div className="text-center py-20">
            <p className="text-[15px] text-[var(--text-tertiary)] mb-4">
              {libraries.length > 0 ? '媒体库中没有找到视频文件' : 'Jellyfin 服务器上没有配置媒体库'}
            </p>
            <motion.button onClick={refreshLibrary} className="ios-btn ios-btn-secondary" whileTap={{ scale: 0.96 }}>刷新</motion.button>
          </div>
        )}

        {/* 媒体库内容 */}
        {!isSearching && !activeLibrary && !drillLoading && !currentDrill && pageState === 'ready' &&
          libraries.map((lib) => {
            const items = libraryItems[lib.Id] || []
            if (items.length === 0) return null
            const total = libraryTotalCounts[lib.Id] || 0
            const loaded = libraryLoadCounts[lib.Id] || items.length
            const hasMore = loaded < total
            const isLoadingMore = libraryLoadingMore[lib.Id]
            return (
              <section key={lib.Id} className="mb-12">
                <h2 className="section-title mb-4">{lib.Name}{total > 0 ? ` (${total})` : ''}</h2>
                <div className="responsive-grid">
                  {items.map((item) => (
                    <MediaCard
                      key={item.Id}
                      item={item}
                      posterUrl={getPosterUrl(item)}
                      displayName={
                        item.Type === 'Episode' && item.IndexNumber != null
                          ? `EP${String(item.IndexNumber).padStart(2, '0')} - ${item.Name}`
                          : item.SeriesName
                            ? `${item.SeriesName} ${item.IndexNumber != null ? `S${String(item.IndexNumber).padStart(2, '0')}` : ''}`
                            : item.Name
                      }
                      communityRating={item.CommunityRating}
                      onClick={() => handleItemClick(item)}
                      onScrape={() => handleScrape(item)}
                    />
                  ))}
                </div>
                {hasMore && (
                  <div className="flex justify-center mt-6">
                    <motion.button
                      onClick={() => loadMoreLibraryItems(lib.Id)}
                      disabled={isLoadingMore}
                      className="ios-btn ios-btn-secondary !px-6"
                      whileTap={{ scale: 0.96 }}
                    >
                      {isLoadingMore ? (
                        <Loader2 size={14} className="animate-spin mr-2" />
                      ) : null}
                      {isLoadingMore ? '加载中...' : `加载更多 (${loaded}/${total})`}
                    </motion.button>
                  </div>
                )}
              </section>
            )
          })}
      {/* 豆瓣刮削弹窗 */}
      <AnimatePresence>
        {scrapeItem && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { setScrapeItem(null); setScrapeResults([]); setScrapeError('') }}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div
              className="relative glass-thick p-6 rounded-[var(--radius-xl)] w-full max-w-lg max-h-[80vh] overflow-y-auto"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">

                </div>
                <h3 className="text-[15px] font-semibold">选择豆瓣封面</h3>
                <button
                  onClick={() => { setScrapeItem(null); setScrapeResults([]); setScrapeError('') }}
                  className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-[13px] text-[var(--text-tertiary)] mb-4">
                为 <span className="text-[var(--text-primary)] font-medium">{scrapeItem.Name}</span> 选择豆瓣封面
              </p>

              {scrapeLoading && scrapeResults.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={20} className="text-[var(--accent)] animate-spin" />
                  <span className="text-[14px] text-[var(--text-tertiary)] ml-3">搜索中...</span>
                </div>
              ) : scrapeError ? (
                <div className="text-center py-8">
                  <p className="text-[13px] text-red-400 mb-3">{scrapeError}</p>
                  <motion.button
                    onClick={() => scrapeItem && handleScrape(scrapeItem)}
                    className="ios-btn ios-btn-secondary text-[13px]"
                    whileTap={{ scale: 0.96 }}
                  >
                    重试
                  </motion.button>
                </div>
              ) : scrapeResults.length > 0 ? (
                <div className="space-y-3">
                  {scrapeResults.map((r) => (
                    <motion.div
                      key={r.id}
                      className="flex gap-4 p-3 rounded-[var(--radius-lg)] hover:bg-white/5 cursor-pointer transition-colors"
                      whileHover={{ x: 2 }}
                      onClick={() => handleSelectPoster(String(r.id), r.poster)}
                    >
                      <div className="w-16 h-24 rounded-[var(--radius-md)] overflow-hidden bg-[var(--surface-secondary)] flex-shrink-0">
                        {r.poster ? (
                          <img
                            src={r.poster ? `douban-img://${encodeURIComponent(r.poster)}` : undefined}
                            alt={r.title}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[var(--text-quaternary)]">
                            <ImagePlus size={20} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium text-[var(--text-primary)] truncate">{r.title}</p>
                        <p className="text-[12px] text-[var(--accent)]">{r.year}</p>
                        <p className="text-[12px] text-[var(--text-tertiary)] mt-1 line-clamp-2">{r.overview}</p>
                      </div>
                      <div className="flex items-center">
                        <Download size={16} className="text-[var(--text-quaternary)]" />
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Search size={32} className="mx-auto text-[var(--text-quaternary)] mb-3" />
                  <p className="text-[13px] text-[var(--text-tertiary)]">未找到豆瓣结果</p>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  )
}

export default Home













