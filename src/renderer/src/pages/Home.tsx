import { useNavigate, Link } from 'react-router-dom'
import { useRef, useState, useEffect, useCallback, useMemo, memo, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, FolderOpen, Video, ChevronRight, ArrowLeft,
  Clock, Trash2, X, Loader2, TvMinimal, Film, Folder, Database, ChevronDown, CircleDot
} from 'lucide-react'

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

/* ==================== 子组件 ==================== */

const MediaCard = memo(function MediaCard({ item, posterUrl, displayName, communityRating, onClick }: {
  item: MediaItem
  posterUrl: string | null
  displayName: string
  communityRating?: number | null
  onClick: () => void
}): ReactElement {
  const isFolder = item.IsFolder || (!!item.ChildCount && item.ChildCount > 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any
  const isTv = anyItem.CollectionType === 'tvshows'
  const isMovie = anyItem.CollectionType === 'movies'
  const collectionIcon = isTv
    ? <TvMinimal size={28} className="text-[var(--text-quaternary)]" />
    : isMovie
      ? <Film size={28} className="text-[var(--text-quaternary)]" />
      : <Folder size={28} className="text-[var(--text-quaternary)]" />

  return (
    <motion.div
      onClick={onClick}
      className="media-card group"
      style={{ aspectRatio: '2/3' }}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <div className="media-card-poster w-full h-full">
        {posterUrl ? (
          <img
            src={posterUrl}
            alt={item.Name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={(e) => {
              const target = e.target as HTMLImageElement
              target.style.display = 'none'
              const parent = target.parentElement
              if (parent && !parent.querySelector('.fallback-icon')) {
                const div = document.createElement('div')
                div.className = 'fallback-icon w-full h-full flex items-center justify-center bg-[var(--bg-elevated)]'
                div.innerHTML = isFolder ? '📁' : '🎬'
                parent.appendChild(div)
              }
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-[var(--bg-elevated)]">
            {collectionIcon}
          </div>
        )}
      </div>

      {/* 评分角标 */}
      {communityRating != null && communityRating > 0 && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[var(--accent)]/90 text-white backdrop-blur-sm shadow-sm z-10">
          ★ {communityRating.toFixed(1)}
        </div>
      )}

      {/* 底部标题条 */}
      <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/70 via-black/30 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
        <p className="text-[11px] text-white/90 font-medium truncate drop-shadow-lg group-hover:text-white transition-colors duration-200">{displayName}</p>
      </div>

      {/* 文件夹角标 — 电视剧不显示 */}
      {isFolder && item.Type !== 'Series' && (
        <div className="absolute top-2 left-2 px-2 py-0.5 bg-[var(--accent)]/90 backdrop-blur-sm rounded-md text-[10px] font-semibold text-white z-10">
          {item.ChildCount ? `${item.ChildCount}项` : '文件夹'}
        </div>
      )}
    </motion.div>
  )
})

const HistoryCard = memo(function HistoryCard({ item, onClick, onDelete }: {
  item: PlayHistoryItem
  onClick: () => void
  onDelete: (e: React.MouseEvent) => void
}): ReactElement {
  const progressPercent = item.duration > 0 ? (item.position / item.duration) * 100 : 0

  return (
    <motion.div
      onClick={onClick}
      className="flex-shrink-0 group cursor-pointer relative w-[180px] sm:w-[200px] lg:w-[240px]"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <div className="aspect-video rounded-[var(--radius-lg)] overflow-hidden relative bg-[var(--bg-elevated)] border border-[var(--separator)]">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt={item.name}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video size={24} className="text-[var(--text-quaternary)]" />
          </div>
        )}

        {/* 播放进度条 */}
        <div className="absolute bottom-0 inset-x-0 h-[3px] bg-[var(--separator)]">
          <div
            className="h-full bg-[var(--accent)] transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Hover 播放图标 */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
          <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white" className="ml-0.5"><polygon points="6,3 20,12 6,21" /></svg>
          </div>
        </div>

        {/* 删除按钮 */}
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
    </motion.div>
  )
})

/* ==================== 工具函数 ==================== */

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

/* ==================== Home 主组件 ==================== */

function Home(): ReactElement {
  const navigate = useNavigate()
  const [pageState, setPageState] = useState<PageState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [libraries, setLibraries] = useState<Library[]>([])
  const [libraryItems, setLibraryItems] = useState<Record<string, MediaItem[]>>({})
  const [connectedServer, setConnectedServer] = useState('')
  const [jellyfinToken, setJellyfinToken] = useState('')

  // 多服务器
  const [servers, setServers] = useState<ServerConfig[]>([])
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [showServerDropdown, setShowServerDropdown] = useState(false)
  const [switchingServer, setSwitchingServer] = useState(false)

  const [historyItems, setHistoryItems] = useState<PlayHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const [drillStack, setDrillStack] = useState<DrillLevel[]>([])
  const [drillLoading, setDrillLoading] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MediaItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [isSearching, setIsSearching] = useState(false)

  // 分类快捷跳转（使用 Jellyfin 媒体库分类）
  const [activeLibrary, setActiveLibrary] = useState('')

  const searchInputRef = useRef<HTMLInputElement>(null)

  const isFolderItem = (item: MediaItem): boolean => {
    return !!(item.IsFolder || (item.ChildCount && item.ChildCount > 0))
  }

  const loadMediaData = useCallback(async () => {
    setPageState('loading')
    setErrorMsg('')
    setDrillStack([])

    try {
      let libResult = await window.api.jellyfin.getLibraries()
      if (!libResult.success && libResult.error === '未连接到 Jellyfin 服务器') {
        const saved = await window.api.store.get('jellyfin') as { url?: string; token?: string } | null
        if (!saved?.url || !saved?.token) {
          setPageState('not_connected')
          return
        }
        const connectResult = await window.api.jellyfin.connect(saved.url, saved.token)
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
        return
      }

      setLibraries(libs)

      const itemsMap: Record<string, MediaItem[]> = {}
      await Promise.all(libs.map(async (lib) => {
        try {
          const itemsResult = await window.api.jellyfin.getItems(lib.Id, 0, 50)
          if (itemsResult.success && itemsResult.data) {
            const itemData = itemsResult.data as { Items?: MediaItem[] }
            itemsMap[lib.Id] = itemData.Items || []
          }
        } catch {
          itemsMap[lib.Id] = []
        }
      }))
      setLibraryItems(itemsMap)

      try {
        const saved = await window.api.store.get('jellyfin') as { url?: string; token?: string } | null
        if (saved?.url) setConnectedServer(saved.url.replace(/\/+$/, ''))
        if (saved?.token) setJellyfinToken(saved.token)
      } catch { /* ignore */ }

      const hasItems = Object.values(itemsMap).some((items) => items.length > 0)
      setPageState(hasItems ? 'ready' : 'empty')
    } catch (err) {
      setPageState('error')
      setErrorMsg(err instanceof Error ? err.message : '发生未知错误')
    }
  }, [])

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
        }
      }
    } catch { /* ignore */ }
  }, [])

  const handleSwitchServer = useCallback(async (id: string): Promise<void> => {
    setSwitchingServer(true)
    setShowServerDropdown(false)
    try {
      const result = await window.api.server.switch(id)
      if (result.success) {
        await loadServers()
        await loadMediaData()
        await loadHistory()
      }
    } catch { /* ignore */ }
    setSwitchingServer(false)
  }, [loadServers, loadMediaData, loadHistory])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  useEffect(() => {
    loadMediaData()
    loadHistory()
  }, [loadMediaData, loadHistory])

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

  const getPosterUrl = useCallback((item: MediaItem): string | null => {
    if (!item.ImageTags?.Primary) return null
    const base = connectedServer || 'http://localhost:8096'
    const authParam = jellyfinToken ? `&api_key=${jellyfinToken}` : ''
    return `${base}/Items/${item.Id}/Images/Primary?maxHeight=400&tag=${item.ImageTags.Primary}&quality=90${authParam}`
  }, [connectedServer, jellyfinToken])

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
            <motion.button onClick={loadMediaData} className="ios-btn ios-btn-primary" whileTap={{ scale: 0.96 }}>重试</motion.button>
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

        {/* 顶栏：搜索 + 服务器切换 */}
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

        {/* 快捷操作 */}
        {!isSearching && !activeLibrary && drillStack.length === 0 && (
          <div className="flex gap-3 mb-12">
            <motion.button
              onClick={async () => {
                const result = await window.api.file.openFile()
                if (result.success && result.data) {
                  const data = result.data as { filePath: string }
                  const fname = data.filePath.split(/[/\\]/).pop() || '本地视频'
                  navigate(`/player?file=${encodeURIComponent(data.filePath)}&name=${encodeURIComponent(fname)}`)
                }
              }}
              className="ios-btn ios-btn-primary"
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
        )}

        {/* 播放历史 */}
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
            <motion.button onClick={loadMediaData} className="ios-btn ios-btn-secondary" whileTap={{ scale: 0.96 }}>刷新</motion.button>
          </div>
        )}

        {/* 媒体库内容 */}
        {!isSearching && !activeLibrary && !drillLoading && !currentDrill && pageState === 'ready' &&
          libraries.map((lib) => {
            const items = libraryItems[lib.Id] || []
            if (items.length === 0) return null
            return (
              <section key={lib.Id} className="mb-12">
                <h2 className="section-title mb-4">{lib.Name}</h2>
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
                    />
                  ))}
                </div>
              </section>
            )
          })}
      </div>
    </div>
  )
}

export default Home
