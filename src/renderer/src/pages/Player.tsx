import { useRef, useState, useEffect, useCallback, type ReactElement } from 'react'
// 修复点 1.15: pages 目录下深一层，从 ../../ → ../../../shared/types
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem } from '../../../shared/types'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { cachedFetch } from '../utils/apiCache'
import { MediaTimeBus, createMediaTimeBus } from '../utils/mediaTimeBus'
import { usePlayerStore } from '../utils/playerStore'
import { DanmakuEngine } from '../utils/danmakuEngine'
import { danmakuRequestManager } from '../utils/danmakuRequestManager'
import {
  type FolderVideo,
  type PlayerContextMenuState,
  type SubtitleCue,
  type SubtitleTrack,
  cleanTitleForMatch,
  extractSeriesNameFromFilename,
  formatBytes,
  formatTime,
  parseVTT,
  DanmakuSearchPanel,
  DanmakuSettingsPanel,
  MediaInfoOverlays,
  PlayerContextMenu,
  SubtitleSettingsPanel,
  PlayerPopups,
  PlayerControls
} from '../features/player'

// ==================== Player ====================

function Player(): ReactElement {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const itemId = searchParams.get('itemId') || ''
  const itemName = searchParams.get('name') || '未知视频'
  const localFile = searchParams.get('file') || ''
  const baseUrl = searchParams.get('base') || 'http://localhost:8096'
  const seriesName = searchParams.get('seriesName') || ''
  const seriesId = searchParams.get('seriesId') || ''
  const seasonId = searchParams.get('seasonId') || ''

  const [jellyfinToken, setJellyfinToken] = useState('')

  // 修复点 1.13: videoLoadKey 必须在引用它的"视频 src useEffect"（约 L586）之前声明，
  // 避免 const 声明的 TDZ（Temporal Dead Zone）导致 "Block-scoped variable used before its declaration"
  const [videoLoadKey, setVideoLoadKey] = useState(0)

  // 剧集列表状态
  const [episodeList, setEpisodeList] = useState<JellyfinItem[]>([])
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(-1)
  const [episodePopup, setEpisodePopup] = useState(false)
  
  // 本地文件夹视频列表
  const [folderVideos, setFolderVideos] = useState<FolderVideo[]>([])

  useEffect(() => {
    window.api.store.get('jellyfin').then((saved: unknown) => {
      const s = saved as { token?: string } | null
      if (s?.token) setJellyfinToken(s.token)
    }).catch(() => {})
  }, [])
  
  // 获取剧集列表（电视剧）— 合并 token 加载与请求，避免双重请求
  const episodeFetchedRef = useRef(false)
  useEffect(() => {
    // 本地文件不需要剧集列表
    if (localFile) return
    // 已经获取过则跳过
    if (episodeFetchedRef.current) return

    const fetchEpisodes = async (token: string): Promise<void> => {
      if (seriesId) {
        // 条件 1: seriesId 直接可用
        try {
          const result = await cachedFetch(
            'jellyfin.getEpisodes',
            [seriesId, seasonId || undefined],
            () => window.api.jellyfin.getEpisodes(seriesId, seasonId || undefined),
            2 * 60 * 1000 // 2 分钟缓存
          )
          if (result.success && result.data) {
            const data = result.data as { Items?: JellyfinItem[]; episodes?: JellyfinItem[] }
            const episodes = data.Items || data.episodes || []
            setEpisodeList(episodes)
            const idx = episodes.findIndex(ep => (ep as any).Id === itemId || (ep as any).id === itemId)
            setCurrentEpisodeIndex(idx)
          }
        } catch (err) {
          console.error('[EpisodeList] Error:', err)
        }
      } else if (itemId) {
        // 条件 2: seriesId 为空，先获取详情
        try {
          const detailResult = await cachedFetch(
            'jellyfin.getItemDetails',
            [itemId],
            () => window.api.jellyfin.getItemDetails(itemId),
            2 * 60 * 1000
          )
          if (detailResult.success && detailResult.data) {
            const data = detailResult.data as { SeriesId?: string; SeasonId?: string }
            const fetchedSeriesId = data.SeriesId
            const fetchedSeasonId = data.SeasonId || seasonId
            if (fetchedSeriesId) {
              const epResult = await cachedFetch(
                'jellyfin.getEpisodes',
                [fetchedSeriesId, fetchedSeasonId || undefined],
                () => window.api.jellyfin.getEpisodes(fetchedSeriesId, fetchedSeasonId || undefined),
                2 * 60 * 1000
              )
              if (epResult.success && epResult.data) {
                const epData = epResult.data as { Items?: JellyfinItem[]; episodes?: JellyfinItem[] }
                const episodes = epData.Items || epData.episodes || []
                setEpisodeList(episodes)
                const idx = episodes.findIndex(ep => (ep as any).Id === itemId || (ep as any).id === itemId)
                setCurrentEpisodeIndex(idx)
              }
            }
          }
        } catch (err) {
          console.error('[EpisodeList] Error:', err)
        }
      }
    }

    // 先尝试直接用已有 token，没有则先加载
    if (jellyfinToken) {
      episodeFetchedRef.current = true
      fetchEpisodes(jellyfinToken)
    } else {
      window.api.store.get('jellyfin').then((saved: unknown) => {
        const s = saved as { token?: string } | null
        if (s?.token) {
          setJellyfinToken(s.token)
          episodeFetchedRef.current = true
          fetchEpisodes(s.token)
        }
      }).catch(() => {})
    }
  }, [seriesId, seasonId, itemId, localFile]) // 移除 jellyfinToken 依赖

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blurBgCanvasRef = useRef<HTMLCanvasElement>(null)
  const subtitleCuesRef = useRef<SubtitleCue[][]>([])
  const activeSubIdxRef = useRef(-1)
  const currentSubTextRef = useRef('')
  const engineRef = useRef<DanmakuEngine | null>(null)
  const resumePosRef = useRef(parseFloat(searchParams.get('position') || '0'))
  const hasResumedRef = useRef(false)
  const timeBusRef = useRef<MediaTimeBus | null>(null)

  const [playerState, playerActions] = usePlayerStore()
  const { currentTime, duration, playbackRate, isPlaying, volume, buffered, error, loading } = playerState

  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  const [danmakuLoading, setDanmakuLoading] = useState(false)
  const [currentDanmakuCount, setCurrentDanmakuCount] = useState(0)
  const [danmakuCountVisible, setDanmakuCountVisible] = useState(false)
  const [danmakuError, setDanmakuError] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<DanmakuSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [srcReady, setSrcReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [danmakuOpacity, setDanmakuOpacity] = useState(1.0)
  const [danmakuFontSize, setDanmakuFontSize] = useState(24)
  const [danmakuSpeed, setDanmakuSpeed] = useState(120)
  const [danmakuMaxCount, setDanmakuMaxCount] = useState(300)
  const [danmakuOffset, setDanmakuOffset] = useState(0)
  const danmakuOffsetRef = useRef(0)

  // 弹幕显示区域边界（百分比，0-100）
  const [danmakuTopBoundary, setDanmakuTopBoundary] = useState(0)
  const [danmakuBottomBoundary, setDanmakuBottomBoundary] = useState(100)

  const [speedToast, setSpeedToast] = useState('')
  const [volumePopup, setVolumePopup] = useState(false)
  const [speedPopup, setSpeedPopup] = useState(false)
  const [subtitlePopup, setSubtitlePopup] = useState(false)
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([])
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(-1)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [currentSubtitleText, setCurrentSubtitleText] = useState('')
  const [subtitleBottom, setSubtitleBottom] = useState(8) // 字幕距底部百分比
  const [subtitleFontSize, setSubtitleFontSize] = useState(22) // 字幕字体大小 px
  const [subtitleLetterSpacing, setSubtitleLetterSpacing] = useState(0) // 字间距 px
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false)

  // 竖屏视频检测
  const [isPortrait, setIsPortrait] = useState(false)
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9)
  // 视频显示模式: 'contain'=完整显示(默认), 'cover'=裁切填充
  const [displayMode, setDisplayMode] = useState<'contain' | 'cover'>('contain')

  // P2: 窗口置顶
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  // P2: 画中画 (PiP)
  const [pipActive, setPipActive] = useState(false)

  // 关闭所有弹出面板
  const closeAllPopups = useCallback(() => {
    setVolumePopup(false)
    setSpeedPopup(false)
    setSubtitlePopup(false)
    setSubtitleSettingsOpen(false)
    setSettingsOpen(false)
    setSearchOpen(false)
  }, [])

  const detectVideoOrientation = useCallback(() => {
    if (videoRef.current) {
      const { videoWidth, videoHeight } = videoRef.current
      if (videoWidth > 0 && videoHeight > 0) {
        const ratio = videoWidth / videoHeight
        setVideoAspectRatio(ratio)
        setIsPortrait(videoHeight > videoWidth)
        console.log(`[Player] 视频方向: ${videoHeight > videoWidth ? '竖屏' : '横屏'}, 比例: ${ratio.toFixed(2)}`)
      }
    }
  }, [])

  // 点击其它地方关闭弹出面板
  useEffect(() => {
    if (!volumePopup && !speedPopup && !subtitlePopup && !subtitleSettingsOpen && !settingsOpen && !searchOpen) return
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.volume-popup') && !target.closest('.speed-popup') && !target.closest('.subtitle-popup') && !target.closest('.subtitle-settings-popup') && !target.closest('.danmaku-settings-popup') && !target.closest('.danmaku-search-popup')) {
        closeAllPopups()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [volumePopup, speedPopup, subtitlePopup, subtitleSettingsOpen, settingsOpen, searchOpen, closeAllPopups])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.addEventListener('loadedmetadata', detectVideoOrientation)
    video.addEventListener('play', detectVideoOrientation)

    return () => {
      video.removeEventListener('loadedmetadata', detectVideoOrientation)
      video.removeEventListener('play', detectVideoOrientation)
    }
  }, [detectVideoOrientation])

  const [contextMenu, setContextMenu] = useState<PlayerContextMenuState>({ x: 0, y: 0, visible: false })
  const [infoOverlay, setInfoOverlay] = useState(false)
  const [itemInfo, setItemInfo] = useState<Record<string, unknown> | null>(null)
  const [itemInfoLoading, setItemInfoLoading] = useState(false)
  const [videoSourceInfo, setVideoSourceInfo] = useState<Record<string, string> | null>(null)

  const showStatus = (msg: string): void => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(''), 2000)
  }

  const savePlayHistory = useCallback(async () => {
    if (!itemId && !localFile) return
    if (duration <= 0) return
    if (currentTime < 5) return
    try {
      const authParam = jellyfinToken ? `&api_key=${jellyfinToken}` : ''
      const posterUrl = localFile ? '' : `${baseUrl}/Items/${itemId}/Images/Primary?maxHeight=300${authParam}`
      const historyName = seriesName && !itemName.startsWith(seriesName)
        ? `${seriesName} - ${itemName}` : itemName
      await window.api.history.save({
        itemId: itemId || `local:${localFile}`,
        name: historyName, duration, position: currentTime, posterUrl,
        watchedAt: Date.now(), localFile: localFile || undefined,
        baseUrl: localFile ? undefined : baseUrl,
        seriesName: seriesName || undefined
      })
    } catch (err) { console.error('保存播放历史失败:', err) }
  }, [itemId, localFile, itemName, duration, currentTime, baseUrl, seriesName])

  useEffect(() => {
    if (duration <= 0 || currentTime < 5) return
    const interval = setInterval(savePlayHistory, 30000)
    return () => {
      clearInterval(interval)
      savePlayHistory()
    }
  }, [savePlayHistory])

  useEffect(() => { containerRef.current?.focus() }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    engineRef.current = new DanmakuEngine(canvasRef.current)
    engineRef.current.resize()

    const loadSettings = async (): Promise<void> => {
      try {
        const enabled = await window.api.store.get('danmakuEnabled')
        if (enabled !== null) setDanmakuEnabled(!!enabled)
        const opacityRaw = await window.api.store.get('danmakuOpacity')
        if (opacityRaw !== null) {
          const v = Number(opacityRaw)
          const opacity = v > 1 ? v / 100 : v
          setDanmakuOpacity(opacity)
          engineRef.current?.setOpacity(opacity)
        }
        const fontSize = await window.api.store.get('danmakuFontSize')
        if (fontSize !== null) { setDanmakuFontSize(Number(fontSize)); engineRef.current?.setFontSize(Number(fontSize)) }
        let speed = await window.api.store.get('danmakuSpeed')
        if (speed === null) {
          const legacySpeed = await window.api.store.get('danmakuScrollSpeed')
          if (legacySpeed === 'slow') speed = 90
          else if (legacySpeed === 'fast') speed = 180
          else if (legacySpeed === 'medium') speed = 120
        }
        if (speed !== null) { setDanmakuSpeed(Number(speed)); engineRef.current?.setSpeed(Number(speed)) }
        const maxCount = await window.api.store.get('danmakuMaxCount')
        if (maxCount !== null) { setDanmakuMaxCount(Number(maxCount)); engineRef.current?.setMaxActiveComments(Number(maxCount)) }
        const offset = await window.api.store.get('danmakuOffset')
        if (offset !== null) { const v = Number(offset); setDanmakuOffset(v); danmakuOffsetRef.current = v; engineRef.current?.setTimeOffset(v) }
        // 修复 TS-4: 闭包 bug - 使用局部变量暂存加载的边界值，避免引用过期的 React state
        // 修复前：setBoundary(v, danmakuBottomBoundary) 中 danmakuBottomBoundary 是闭包中的过期值（默认100）
        let loadedTop = danmakuTopBoundary
        let loadedBottom = danmakuBottomBoundary
        const savedTopBoundary = await window.api.store.get('danmakuTopBoundary')
        if (savedTopBoundary !== null) { loadedTop = Number(savedTopBoundary); setDanmakuTopBoundary(loadedTop) }
        const savedBottomBoundary = await window.api.store.get('danmakuBottomBoundary')
        if (savedBottomBoundary !== null) { loadedBottom = Number(savedBottomBoundary); setDanmakuBottomBoundary(loadedBottom) }
        // 两个值都加载完成后统一调用一次 setBoundary，确保参数正确
        engineRef.current?.setBoundary(loadedTop, loadedBottom)
        // 字幕设置持久化
        const savedSubBottom = await window.api.store.get('subtitleBottom')
        if (savedSubBottom !== null) setSubtitleBottom(Number(savedSubBottom))
        const savedSubFontSize = await window.api.store.get('subtitleFontSize')
        if (savedSubFontSize !== null) setSubtitleFontSize(Number(savedSubFontSize))
        const savedSubLetterSpacing = await window.api.store.get('subtitleLetterSpacing')
        if (savedSubLetterSpacing !== null) setSubtitleLetterSpacing(Number(savedSubLetterSpacing))
      } catch (err) {
        // 修复 ARCH-2: 补全错误日志，避免吞掉配置加载失败问题
        console.error('[Player:loadSettings] 配置加载失败:', err instanceof Error ? err.message : String(err))
      }
    }
    loadSettings()

    const handleResize = (): void => engineRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize); engineRef.current?.destroy() }
  // 修复点 1.4: 禁止把 useRef.current 放进 useEffect 依赖数组（mutable，不会触发重渲染，只会造成每次渲染都重新初始化）
  }, [])

  useEffect(() => {
    console.log(`[Player:danmakuEffect] ==================== 弹幕加载Effect触发 ====================`)
    console.log(`[Player:danmakuEffect] 依赖值: itemId="${itemId}", itemName="${itemName}", localFile="${localFile || 'none'}", seriesName="${seriesName || 'none'}"`)

    if (!localFile && !seriesName && (!itemName || itemName === '未知视频')) {
      console.log(`[Player:danmakuEffect] ⚠️ 跳过: 无有效匹配参数`)
      return
    }

    danmakuRequestManager.cancel()

    engineRef.current?.clear()
    setCurrentDanmakuCount(0)
    setDanmakuLoading(true)
    setDanmakuError('')

    const matchTitle = (() => {
      const base = seriesName || (itemName && itemName !== '未知视频' ? itemName : '')
      const hint = itemName && itemName !== '未知视频' ? itemName : ''
      if (base && hint && !hint.includes(base)) {
        return base + ' ' + hint
      }
      return base || (localFile ? extractSeriesNameFromFilename(localFile.split(/[/\\]/).pop() || itemName) || itemName : itemName)
    })()

    console.log(`[Player:danmakuEffect] 构建匹配标题: "${matchTitle}"`)

    // 修复 BUG-2: 调用 cleanTitleForMatch 清洗匹配标题，去除分辨率/编码等干扰信息
    const cleanedTitle = cleanTitleForMatch(matchTitle)
    console.log(`[Player:danmakuEffect] 清洗后匹配标题: "${cleanedTitle}"`)

    const isValidTitle = cleanedTitle && cleanedTitle !== '未知视频' && cleanedTitle.trim().length > 0
    if (!isValidTitle) {
      console.log(`[Player:danmakuEffect] ⚠️ 跳过: 清洗后匹配标题无效`)
      setDanmakuLoading(false)  // 修复 BUG-1: 确保 loading 状态重置
      return
    }

    const loadDanmaku = async (): Promise<void> => {
      const log = (msg: string) => {
        console.log(`[Player:danmakuEffect] ${msg}`)
        window.api.log?.send?.('info', 'renderer', `[Player:danmakuEffect] ${msg}`)
      }
      log(`开始执行loadDanmaku`)
      try {
        log(`调用danmakuRequestManager.loadDanmaku("${cleanedTitle}", "${localFile || 'none'}")`)
        const result = await danmakuRequestManager.loadDanmaku(cleanedTitle, localFile)
        log(`loadDanmaku返回: ${result ? `成功，数量=${result.count}` : 'null'}`)
        if (result) {
          log(`✅ 弹幕加载成功，数量: ${result.count}, 来源: ${result.source || '未知'}`)
          log(`调用engineRef.current?.loadComments(${result.count}条弹幕)`)
          engineRef.current?.loadComments(result.comments)
          setCurrentDanmakuCount(result.count)
          if (result.count > 0) {
            setDanmakuCountVisible(true)
            setTimeout(() => setDanmakuCountVisible(false), 3000)
          } else {
            // 修复点 3.3: 成功但 0 条弹幕也要明确提示用户，不要静默“显示成功但一条都没有”
            setDanmakuError('该集暂无弹幕，可尝试手动搜索')
          }
        } else {
          log(`⚠️ 弹幕加载返回null (未找到匹配)`)
          setDanmakuError('未找到匹配弹幕')
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`❌ 弹幕加载异常: ${errMsg}`)
        console.error(`[Player:danmakuEffect] ❌ 弹幕加载异常:`, err)
        setDanmakuError('弹幕加载失败，请手动搜索')
      } finally {
        log(`设置danmakuLoading=false`)
        setDanmakuLoading(false)
      }
    }

    const delayMs = localFile ? 100 : 500
    console.log(`[Player:danmakuEffect] 延迟 ${delayMs}ms 后触发加载`)

    const timer = setTimeout(() => {
      loadDanmaku()
    }, delayMs)

    return () => {
      console.log(`[Player:danmakuEffect] 清理: 取消定时器和请求`)
      clearTimeout(timer)
      danmakuRequestManager.cancel()
    }
  }, [itemId, itemName, localFile, seriesName])

  const handleDanmakuToggle = (): void => {
    const next = !danmakuEnabled; setDanmakuEnabled(next)
    window.api.store.set('danmakuEnabled', next)
    next ? engineRef.current?.enable() : engineRef.current?.disable()
  }

  const handleOpacityChange = (value: number): void => { setDanmakuOpacity(value); engineRef.current?.setOpacity(value); window.api.store.set('danmakuOpacity', value) }
  const handleFontSizeChange = (value: number): void => { setDanmakuFontSize(value); engineRef.current?.setFontSize(value); window.api.store.set('danmakuFontSize', value) }
  const handleSpeedChange = (value: number): void => { setDanmakuSpeed(value); engineRef.current?.setSpeed(value); window.api.store.set('danmakuSpeed', value) }

  const handleDensityChange = (value: number): void => {
    setDanmakuMaxCount(value)
    engineRef.current?.setMaxActiveComments(value)
    window.api.store.set('danmakuMaxCount', value)
  }

  // 弹幕时间偏移控制
  const handleOffsetChange = (value: number): void => {
    setDanmakuOffset(value)
    danmakuOffsetRef.current = value
    engineRef.current?.setTimeOffset(value)
    window.api.store.set('danmakuOffset', value)
  }

  // 弹幕显示区域边界控制
  const handleTopBoundaryChange = (value: number): void => {
    setDanmakuTopBoundary(value)
    engineRef.current?.setBoundary(value, danmakuBottomBoundary)
    window.api.store.set('danmakuTopBoundary', value)
  }

  const handleBottomBoundaryChange = (value: number): void => {
    setDanmakuBottomBoundary(value)
    engineRef.current?.setBoundary(danmakuTopBoundary, value)
    window.api.store.set('danmakuBottomBoundary', value)
  }

  const handleSubtitleBottomChange = (value: number): void => {
    setSubtitleBottom(value)
    window.api.store.set('subtitleBottom', value)
  }

  const handleSubtitleFontSizeChange = (value: number): void => {
    setSubtitleFontSize(value)
    window.api.store.set('subtitleFontSize', value)
  }

  const handleSubtitleLetterSpacingChange = (value: number): void => {
    setSubtitleLetterSpacing(value)
    window.api.store.set('subtitleLetterSpacing', value)
  }

  const handleSubtitleSettingsReset = (): void => {
    handleSubtitleBottomChange(8)
    handleSubtitleFontSizeChange(22)
    handleSubtitleLetterSpacingChange(0)
  }

  const handleDanmakuSearch = async (keyword?: string): Promise<void> => {
    const kw = (typeof keyword === 'string' ? keyword : searchKeyword).trim()
    if (!kw) return; setSearchLoading(true); setSearchResults([])
    try {
      const result = await window.api.danmaku.search(kw)
      if (result.success && result.data) {
        const data = result.data as DanmakuSearchResponse
        const eps: DanmakuSearchResult[] = []
        for (const anime of (data.animes || [])) {
          for (const ep of (anime.episodes || [])) { eps.push({ ...ep, animeTitle: anime.animeTitle }) }
        }
        setSearchResults(eps)
      }
    } catch { showStatus('搜索弹幕失败') }
    setSearchLoading(false)
  }

  // 打开弹幕搜索并自动填入影片名
  const handleOpenDanmakuSearch = (): void => {
    const searchTitle = seriesName || (localFile ? extractSeriesNameFromFilename(localFile.split(/[/\\]/).pop() || itemName) || itemName : itemName)
    setSearchKeyword(searchTitle)
    closeAllPopups()
    setSearchOpen(true)
    handleDanmakuSearch(searchTitle)
  }

  const handleDanmakuSelect = async (ep: DanmakuSearchResult): Promise<void> => {
    closeAllPopups(); setSearchResults([]); setDanmakuLoading(true); setDanmakuError('')
    try {
      const result = await danmakuRequestManager.getComments(String(ep.episodeId), ep.source)
      if (result) {
        engineRef.current?.loadComments(result.comments); setCurrentDanmakuCount(result.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000)
      } else { setDanmakuError('获取弹幕失败') }
    } catch { setDanmakuError('获取弹幕失败') }
    setDanmakuLoading(false)
  }

  const handleLoadLocalXml = async (): Promise<void> => {
    if (!localFile) { showStatus('仅本地文件支持加载 XML 弹幕'); return }
    closeAllPopups(); setDanmakuLoading(true); setDanmakuError('')
    try {
      console.log(`[Player:handleLoadLocalXml] 开始加载本地弹幕，文件: "${localFile}"`)
      const xmlResult = await window.api.danmaku.findLocalXml(localFile)
      if (xmlResult.success && xmlResult.data) {
        const data = xmlResult.data as { count: number; comments: DanmakuComment[]; source?: string }
        console.log(`[Player:handleLoadLocalXml] 本地弹幕加载成功，数量: ${data.count}，来源: ${data.source || '未知'}`)
        engineRef.current?.loadComments(data.comments); setCurrentDanmakuCount(data.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000); showStatus(`已加载本地弹幕: ${data.source || ''}`)
      } else {
        console.log(`[Player:handleLoadLocalXml] 本地弹幕加载失败，错误: ${xmlResult.error || '未知'}`)
        setDanmakuError(xmlResult.error || '未找到本地弹幕 XML')
      }
    } catch (err) {
      console.error(`[Player:handleLoadLocalXml] 本地 XML 加载异常:`, err)
      setDanmakuError(`本地 XML 加载失败: ${String(err)}`)
    }
    setDanmakuLoading(false)
  }

  // ==================== 视频源 & 事件 ====================

  useEffect(() => {
    playerActions.setLoading(true); playerActions.setError('')
    if (localFile) {
      window.api.file.getLocalFileUrl(localFile).then((result) => {
        if (result.success && result.data) {
          const data = result.data as { url: string }
          if (data.url && videoRef.current) {
            videoRef.current.src = data.url
            videoRef.current.load()
            setSrcReady(true)
            return
          }
        }
        playerActions.setError('无法读取本地文件'); playerActions.setLoading(false)
      }).catch(() => { playerActions.setError('无法读取本地文件'); playerActions.setLoading(false) })
      return
    }
    if (!itemId) { playerActions.setLoading(false); return }
    window.api.jellyfin.getPlaybackUrl(itemId).then((result) => {
      if (result.success) {
        const data = result.data as { url?: string; subtitles?: { index: number; label: string; language: string; codec: string; url: string }[] }
        if (data?.url && videoRef.current) {
          const video = videoRef.current
          const oldTracks = video.querySelectorAll('track')
          oldTracks.forEach(t => t.remove())
          const subs = data.subtitles || []
          setSubtitleTracks(subs)
          let defaultIdx = -1
          for (let i = 0; i < subs.length; i++) {
            const sub = subs[i]
            const isDefault = subs.length === 1 || sub.language === 'chi' || sub.language === 'zho' || sub.language === 'chs' || sub.language === 'cht'
            if (isDefault && defaultIdx === -1) defaultIdx = i
          }
          video.src = data.url
          video.load()
          setSrcReady(true)
          if (subs.length > 0) {
            subs.forEach((sub, i) => {
              window.api.jellyfin.fetchSubtitle(sub.url).then((result) => {
                if (result.success && result.data) {
                  const cues = parseVTT(result.data)
                  if (i === defaultIdx) {
                    setSubtitleCues(cues)
                    setActiveSubtitleIndex(i)
                    activeSubIdxRef.current = i
                  }
                  subtitleCuesRef.current[i] = cues
                } else {
                  console.warn(`字幕加载失败: ${sub.label}`, result.error)
                }
              }).catch((err) => {
                console.warn(`字幕加载异常: ${sub.label}`, err)
              })
            })
          }
          return
        }
      }
      playerActions.setError('获取播放地址失败'); playerActions.setLoading(false)
    }).catch((err) => { playerActions.setError(`获取播放地址失败: ${String(err)}`); playerActions.setLoading(false) })
  // 修复点 2.6: videoLoadKey 作为依赖，handleSwitchEpisode 递增后会重新触发此 Effect 重新加载 src
  }, [itemId, localFile, videoLoadKey])

  useEffect(() => {
    const video = videoRef.current; if (!video) return

    if (timeBusRef.current) {
      timeBusRef.current.destroy()
    }

    timeBusRef.current = createMediaTimeBus()
    timeBusRef.current.attachVideo(video)

    // 性能优化：弹幕引擎使用 RAF 订阅，每帧更新不经过 React state，避免 60fps 重渲染
    let frameCount = 0
    const unsubRAF = timeBusRef.current.subscribeRAF((time, playbackRate) => {
      if (danmakuEnabled && engineRef.current) {
        engineRef.current.update(time, playbackRate)
      }
      frameCount++
      if (frameCount % 8 === 0 && isPortrait && displayMode === 'contain') {
        const blurCanvas = blurBgCanvasRef.current
        const blurCtx = blurCanvas?.getContext('2d')
        if (blurCanvas && blurCtx && video.videoWidth > 0) {
          blurCanvas.width = video.videoWidth / 4
          blurCanvas.height = video.videoHeight / 4
          blurCtx.drawImage(video, 0, 0, blurCanvas.width, blurCanvas.height)
        }
      }
    })

    // UI 状态更新使用常规订阅（store 层已做节流，约 200ms 通知一次）
    const unsubscribe = timeBusRef.current.subscribe((time, state) => {
      playerActions.setCurrentTime(time)
      playerActions.setDuration(state.duration)
      playerActions.setPlaybackRate(state.playbackRate)
      playerActions.setIsPlaying(state.isPlaying)
      playerActions.setBuffered(state.buffered)

      const cues = subtitleCuesRef.current[activeSubIdxRef.current]
      if (cues && cues.length > 0) {
        let lo = 0, hi = cues.length - 1, found = -1
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1
          if (time >= cues[mid].start && time < cues[mid].end) { found = mid; break }
          if (time < cues[mid].start) hi = mid - 1
          else lo = mid + 1
        }
        const newText = found >= 0 ? cues[found].text : ''
        if (newText !== currentSubTextRef.current) {
          currentSubTextRef.current = newText
          setCurrentSubtitleText(newText)
        }
      }
    })

    const onLoadedMetadata = (): void => {
      const duration = video.duration || 0
      playerActions.setDuration(duration)
      timeBusRef.current?.updateDuration(duration)
      playerActions.setLoading(false)
      if (!hasResumedRef.current && resumePosRef.current > 0) {
        hasResumedRef.current = true
        video.currentTime = resumePosRef.current
      }
      video.play().then(() => {
        playerActions.setIsPlaying(true)
      }).catch(() => {})
    }

    const onWaiting = (): void => playerActions.setLoading(true)
    const onCanPlay = (): void => playerActions.setLoading(false)
    const onError = (): void => {
      const errMsg = (() => {
        switch (video.error?.code) {
          case 1: return '视频加载中止'; case 2: return '网络错误'; case 3: return '视频解码失败'; case 4: return '视频源不可用'; default: return '视频加载失败'
        }
      })()
      playerActions.setError(errMsg)
      playerActions.setLoading(false)
    }
    const onVolumeChange = (): void => playerActions.setVolume(Math.round(video.volume * 100))

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError)
    video.addEventListener('volumechange', onVolumeChange)

    return () => {
      unsubscribe()
      unsubRAF()
      timeBusRef.current?.destroy()
      timeBusRef.current = null
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('error', onError)
      video.removeEventListener('volumechange', onVolumeChange)
    }
  }, [srcReady])

  

  // ==================== 控制 ====================

  const handlePlayPause = (): void => {
    const video = videoRef.current; if (!video) return
    video.paused ? video.play().catch(() => showStatus('播放失败')) : video.pause()
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const video = videoRef.current; if (!video || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    video.currentTime = ratio * duration
    // 性能优化：seek 后强制立即通知 UI，确保进度条即时响应
    playerActions.forceNotifyCurrentTime()
  }

  // 字幕轨道选择（自定义渲染，不使用 textTracks）
  const handleSubtitleSelect = (index: number): void => {
    if (index >= 0 && index < subtitleCuesRef.current.length) {
      setSubtitleCues(subtitleCuesRef.current[index])
      setActiveSubtitleIndex(index)
      activeSubIdxRef.current = index
      currentSubTextRef.current = ''
      setCurrentSubtitleText('')
    } else {
      setSubtitleCues([])
      setActiveSubtitleIndex(-1)
      activeSubIdxRef.current = -1
      currentSubTextRef.current = ''
      setCurrentSubtitleText('')
    }
    setSubtitlePopup(false)
  }

  const handleFullscreen = (): void => {
    const container = containerRef.current; if (!container) return
    document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : container.requestFullscreen().catch(() => showStatus('全屏切换失败'))
  }

  const handlePlaybackRateChange = (rate: number): void => {
    const video = videoRef.current; if (!video) return
    video.playbackRate = rate
    playerActions.setPlaybackRate(rate)
    setContextMenu({ x: 0, y: 0, visible: false })
    setSpeedToast(`${rate}x`); setTimeout(() => setSpeedToast(''), 2000)
  }

  const handleVolumeChange = (value: number): void => {
    playerActions.setVolume(value)
    const video = videoRef.current
    if (video) {
      video.volume = value / 100
      video.muted = value === 0
    }
  }

  const handleToggleMute = (): void => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    playerActions.setVolume(video.muted ? 0 : Math.round(video.volume * 100))
  }

  // 沉浸式控制栏 — 鼠标不动 3 秒自动隐藏
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)

  const resetAutoHide = (): void => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
    }, 3000)
  }

  const handleMouseMove = (): void => {
    resetAutoHide()
  }

  useEffect(() => {
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
  }, [])

  const handleContextMenu = (e: React.MouseEvent): void => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, visible: true }) }
  const handleCloseContextMenu = (): void => { setContextMenu({ x: 0, y: 0, visible: false }) }

  const handleShowInfo = async (): Promise<void> => {
    setContextMenu({ x: 0, y: 0, visible: false })
    if (!itemId) return; setItemInfoLoading(true); setInfoOverlay(true)
    try {
      const result = await window.api.jellyfin.getItemDetails(itemId)
      // 修复点 1.16: JellyfinItem 是 interface（无索引签名），不能直接 as Record<string,unknown>，要先 as unknown 中转
      if (result.success) setItemInfo(result.data as unknown as Record<string, unknown>)
    } catch { /* ignore */ }
    setItemInfoLoading(false)
  }
  const handleCloseInfo = (): void => { setInfoOverlay(false); setItemInfo(null) }

  const handleVideoSourceInfo = async (): Promise<void> => {
    setContextMenu({ x: 0, y: 0, visible: false })
    const info: Record<string, string> = {}
    const v = videoRef.current
    if (v) {
      info["视频分辨率"] = `${v.videoWidth || '--'} × ${v.videoHeight || '--'}`
      info["时长"] = formatTime(v.duration || 0)
      const q = v.getVideoPlaybackQuality?.()
      if (q) {
        info["总帧数"] = String(q.totalVideoFrames || '--')
        info["丢帧"] = String(q.droppedVideoFrames || '--')
      }
    }
    if (itemId) {
      try {
        const r = await window.api.jellyfin.getItemDetails(itemId)
        if (r.success) {
          // 修复点 1.16: JellyfinItem → Record 需要先转 unknown
          const d = r.data as unknown as Record<string, unknown>
          type MediaStream = {
            Type?: string
            DisplayTitle?: string
            Codec?: string
            RealFrameRate?: number
            BitRate?: number
            BitDepth?: number
            PixelFormat?: string
            VideoRange?: string
            HDRType?: string
            Channels?: number
            SampleRate?: number
            Language?: string
          }
          const ms = (d.MediaSources as MediaStream[] | undefined)?.[0]
          if (ms) {
            const anyMs = ms as Record<string, unknown>
            if (anyMs.Container) info["封装格式"] = String(anyMs.Container)
            if (anyMs.Bitrate) info["码率"] = `${(Number(anyMs.Bitrate) / 1e6).toFixed(1)} Mbps`
            if (anyMs.Size) info["文件大小"] = formatBytes(Number(anyMs.Size))
            const streams = (anyMs.MediaStreams as MediaStream[] | undefined) || []
            const vs = streams.find(s => s.Type === "Video")
            if (vs) {
              info["视频编码"] = vs.DisplayTitle || vs.Codec || "--"
              if (vs.RealFrameRate) info["帧率"] = `${vs.RealFrameRate.toFixed(2)} fps`
              if (vs.BitRate) info["视频码率"] = `${(vs.BitRate / 1e6).toFixed(1)} Mbps`
              if (vs.BitDepth) info["色深"] = `${vs.BitDepth} bit`
              if (vs.PixelFormat) info["像素格式"] = vs.PixelFormat
              if (vs.VideoRange === "HDR" || vs.HDRType) info["HDR"] = vs.HDRType || "HDR"
            }
            const ast = streams.filter(s => s.Type === "Audio") || []
            ast.forEach((a, i) => {
              // 修复点 1.7: 错别字 "音蹨" → "音频"
              const p = ast.length > 1 ? `音频${i + 1}` : "音频"
              info[`${p}编码`] = a.DisplayTitle || a.Codec || "--"
              if (a.Channels) info[`${p}声道`] = `${a.Channels}ch`
              if (a.SampleRate) info[`${p}采样率`] = `${(a.SampleRate / 1000).toFixed(1)} kHz`
            })
            const subs = streams.filter(s => s.Type === "Subtitle") || []
            if (subs.length) {
              info["字幕"] = subs.map(s => s.DisplayTitle || s.Language || s.Codec || "--").join(", ")
            }
          }
        }
      } catch { /* ignore */ }
    }
    setVideoSourceInfo(info)
  }
  const handleCloseVideoInfo = () => { setVideoSourceInfo(null) }

  // ==================== 键盘 ====================

  // 切换剧集
  const handleSwitchEpisode = (newIndex: number): void => {
    console.log('[EpisodeSwitch] handleSwitchEpisode called with newIndex=%d, episodeList.length=%d, currentEpisodeIndex=%d', newIndex, episodeList.length, currentEpisodeIndex)
    
    const totalEpisodes = Math.max(episodeList.length, folderVideos.length)
    if (newIndex < 0 || newIndex >= totalEpisodes) {
      console.log('[EpisodeSwitch] Index out of range, returning')
      return
    }
    
    const newEp = episodeList[newIndex]
    console.log('[EpisodeSwitch] newEp=%o', newEp)
    // Jellyfin API 返回的是 Id (大写)，不是 id
    const episodeId = (newEp as any).Id || (newEp as any).id
    if (!episodeId) {
      console.log('[EpisodeSwitch] episodeId is empty, returning')
      return
    }
    
    console.log('[EpisodeSwitch] Switching to episode %d: %s', newIndex + 1, newEp.Name || episodeId)
    
    // 构建新的 URL
    const newParams = new URLSearchParams(searchParams)
    newParams.set('itemId', episodeId)
    if (newEp.Name) newParams.set('name', newEp.Name)
    
    // 跳转到新集
    navigate({ search: newParams.toString() }, { replace: true })
    
    // 递增 videoLoadKey 触发 useEffect 重新加载视频（navigate replace 不会卸载组件）
    setVideoLoadKey(prev => prev + 1)
    
    // 重置状态
    setCurrentEpisodeIndex(newIndex)
    playerActions.setCurrentTime(0)
    playerActions.setIsPlaying(false)
    playerActions.setError('')
    playerActions.setLoading(true)
  }

  // P2: 截图
  const handleScreenshot = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.mpv.screenshotSave()
      if (result.success) { showStatus('截图已保存'); return }
    } catch { /* mpv 不可用 */ }
    // Canvas fallback
    const video = videoRef.current
    if (!video || !video.videoWidth) { showStatus('无可截取的视频帧'); return }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) { showStatus('截图失败'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      a.click()
      URL.revokeObjectURL(url)
      showStatus('截图已保存')
    } catch { showStatus('截图失败') }
  }, [showStatus])

  // P2: 画中画
  const handlePictureInPicture = useCallback(async (): Promise<void> => {
    const video = videoRef.current
    if (video && document.pictureInPictureEnabled) {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture()
          setPipActive(false)
          showStatus('已退出画中画')
          return
        }
        if (video.readyState >= 2) {
          await video.requestPictureInPicture()
          setPipActive(true)
          showStatus('画中画模式')
          return
        }
      } catch { /* PiP 失败，尝试 mpv 方案 */ }
    }
    try {
      const result = await window.api.window.alwaysOnTop()
      if (result.success) {
        setAlwaysOnTop(!!result.data)
        setPipActive(!!result.data)
        showStatus(result.data ? '画中画（置顶小窗）' : '退出画中画')
      }
    } catch { showStatus('画中画不可用') }
  }, [showStatus])

  // P2: 监听 PiP 事件
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnter = (): void => setPipActive(true)
    const onLeave = (): void => setPipActive(false)
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  const handleKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    const video = videoRef.current; if (!video) return
    const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return

    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '后退 30s' : '后退 5s'); break
      case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '前进 30s' : '前进 5s'); break
      case ' ': e.preventDefault(); handlePlayPause(); break
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); playerActions.setVolume(Math.round(video.volume * 100)); break
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); playerActions.setVolume(Math.round(video.volume * 100)); break
      case 'f': case 'F': e.preventDefault(); handleFullscreen(); break
      case 's': case 'S': e.preventDefault(); handleScreenshot(); break
      case 'p': case 'P': e.preventDefault(); window.api.window.alwaysOnTop().then(result => { if (result.success) { setAlwaysOnTop(!!result.data); showStatus(result.data ? '窗口置顶' : '取消置顶') } }).catch(() => {}); break
      case 'd': case 'D': e.preventDefault(); handlePictureInPicture(); break
      case '[': e.preventDefault(); { const v = Math.max(-30, danmakuOffsetRef.current - 0.5); handleOffsetChange(v); showStatus(`弹幕偏移 ${v.toFixed(1)}s`); } break
      case ']': e.preventDefault(); { const v = Math.min(30, danmakuOffsetRef.current + 0.5); handleOffsetChange(v); showStatus(`弹幕偏移 ${v.toFixed(1)}s`); } break
      case 'v': case 'V': e.preventDefault(); { if (subtitleTracks.length > 0) { const nextIdx = activeSubtitleIndex + 1 >= subtitleTracks.length ? -1 : activeSubtitleIndex + 1; handleSubtitleSelect(nextIdx); showStatus(nextIdx === -1 ? '字幕关闭' : `字幕: ${subtitleTracks[nextIdx].label}`); } } break
      case 'Escape': e.preventDefault(); if (infoOverlay) handleCloseInfo(); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); break
    }
  }

  // ==================== 渲染 ====================

  if (!itemId && !localFile) {
    return (
      <div className="h-full flex items-center justify-center bg-black">
        <div className="text-center">
          <p className="text-sm text-white/35 mb-8">未选择视频</p>
          <Link to="/" className="inline-block px-6 py-2.5 bg-[#8b82f6] hover:bg-[#7a72e5] rounded-md text-sm font-medium transition-colors no-underline">
            返回媒体库
          </Link>
        </div>
      </div>
    )
  }

  return (
    // 修复全屏黑条: 容器改为纯 relative，子元素均 absolute 定位，控件悬浮覆盖视频
    <div ref={containerRef} className="h-full relative bg-black outline-none" onKeyDown={handleKeyDown} tabIndex={0}>

      {/* 视频区域 — 全屏铺满容器 */}
      <div className={`absolute inset-0 bg-black overflow-hidden flex items-center justify-center ${isPortrait ? 'portrait-mode' : ''}`} onContextMenu={handleContextMenu} onClick={handlePlayPause} onMouseMove={handleMouseMove}>
        {/* 顶部信息栏 */}
        <div className={`absolute top-0 left-0 right-0 z-30 transition-opacity duration-300 ease-in-out ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <div className="player-glass-bar bg-gradient-to-b from-black/60 to-black/30 px-4 py-3 flex items-center gap-3 border-none">
            <button
              onClick={() => navigate(-1)}
              className="glass-btn-icon text-white/80 hover:text-white"
              title="返回"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white font-medium truncate">
                {itemName}
              </div>
              {episodeList.length > 0 && currentEpisodeIndex >= 0 && (
                <div className="text-xs text-white/40 truncate">
                  {episodeList[currentEpisodeIndex]?.Name || `第 ${currentEpisodeIndex + 1} 集`}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="relative w-full h-full bg-black">
          {isPortrait && displayMode === 'contain' && (
            <div className="absolute inset-0 overflow-hidden -z-10">
              <canvas
                ref={blurBgCanvasRef}
                className="w-full h-full object-cover scale-110"
                style={{ filter: 'blur(20px) brightness(0.5)' }}
              />
            </div>
          )}
          <video
            ref={videoRef}
            className={`w-full h-full ${displayMode === 'cover' ? 'object-cover' : 'object-contain'}`}
            controls={false}
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
          />
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />
        </div>

        {/* 自定义字幕渲染（位置/大小/字间距可调） */}
        {currentSubtitleText && activeSubtitleIndex >= 0 && (
          <div className="absolute left-0 right-0 z-20 flex justify-center pointer-events-none" style={{ bottom: `${subtitleBottom}%` }}>
            <div className="px-4 py-1.5 rounded" style={{
              textShadow: '0 1px 3px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
              fontSize: `${subtitleFontSize}px`,
              letterSpacing: `${subtitleLetterSpacing}px`,
              color: '#fff',
              textAlign: 'center',
              lineHeight: 1.5,
              whiteSpace: 'pre-line'
            }}>
              {currentSubtitleText}
            </div>
          </div>
        )}

        {/* 弹幕状态 */}
        {danmakuLoading && (
          <div className="absolute top-4 right-4 player-glass-badge px-3 py-1.5 rounded text-[11px] text-[#bbb] z-20 flex items-center gap-2">
            <div className="w-3 h-3 border border-[#8b82f6] border-t-transparent rounded-full animate-spin" />匹配弹幕
          </div>
        )}
        {currentDanmakuCount > 0 && !danmakuLoading && (
          <div className={`absolute top-4 right-4 player-glass-badge px-2 py-1 rounded text-[10px] text-[#999] z-20 transition-opacity duration-500 ${danmakuCountVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>{currentDanmakuCount} 条弹幕</div>
        )}

        {/* 倍速提示 */}
        {speedToast && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none animate-speed-toast">
            <div className="player-glass-toast px-5 py-2.5 rounded-lg">
              <span className="text-2xl font-bold text-white">{speedToast}</span>
            </div>
          </div>
        )}

        {/* 加载中 */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
            <div className="w-6 h-6 border-2 border-[#8b82f6] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* 错误 */}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
            <div className="text-center">
              <p className="text-sm text-white/40 mb-6">{error}</p>
              <Link to="/" className="text-[#8b82f6] hover:text-[#a29bfe] text-xs transition-colors">返回媒体库</Link>
            </div>
          </div>
        )}
      </div>

      {/* 弹幕搜索面板 */}
      <DanmakuSearchPanel
        open={searchOpen}
        keyword={searchKeyword}
        loading={searchLoading}
        results={searchResults}
        hasLocalFile={Boolean(localFile)}
        onKeywordChange={setSearchKeyword}
        onSearch={() => { void handleDanmakuSearch() }}
        onSelect={(result) => { void handleDanmakuSelect(result) }}
        onLoadLocalXml={() => { void handleLoadLocalXml() }}
        onClose={() => { closeAllPopups(); setSearchResults([]) }}
      />

      {/* 弹幕设置面板 */}
      <DanmakuSettingsPanel
        open={settingsOpen}
        opacity={danmakuOpacity}
        fontSize={danmakuFontSize}
        speed={danmakuSpeed}
        maxCount={danmakuMaxCount}
        offset={danmakuOffset}
        topBoundary={danmakuTopBoundary}
        bottomBoundary={danmakuBottomBoundary}
        onOpacityChange={handleOpacityChange}
        onFontSizeChange={handleFontSizeChange}
        onSpeedChange={handleSpeedChange}
        onMaxCountChange={handleDensityChange}
        onOffsetChange={handleOffsetChange}
        onTopBoundaryChange={handleTopBoundaryChange}
        onBottomBoundaryChange={handleBottomBoundaryChange}
        onClose={closeAllPopups}
      />

      {/* 字幕设置面板 */}
      <SubtitleSettingsPanel
        open={subtitleSettingsOpen}
        bottom={subtitleBottom}
        fontSize={subtitleFontSize}
        letterSpacing={subtitleLetterSpacing}
        onBottomChange={handleSubtitleBottomChange}
        onFontSizeChange={handleSubtitleFontSizeChange}
        onLetterSpacingChange={handleSubtitleLetterSpacingChange}
        onReset={handleSubtitleSettingsReset}
        onClose={closeAllPopups}
      />

      {/* 右键菜单 */}
      <PlayerContextMenu
        state={contextMenu}
        playbackRate={playbackRate}
        danmakuEnabled={danmakuEnabled}
        onClose={handleCloseContextMenu}
        onShowInfo={() => { void handleShowInfo() }}
        onShowVideoSourceInfo={() => { void handleVideoSourceInfo() }}
        onPlaybackRateChange={handlePlaybackRateChange}
        onToggleDanmaku={handleDanmakuToggle}
        onOpenDanmakuSearch={handleOpenDanmakuSearch}
        onLoadLocalXml={() => { void handleLoadLocalXml() }}
      />

      {/* 影片信息覆盖层 */}
      <MediaInfoOverlays
        itemInfoOpen={infoOverlay}
        itemInfoLoading={itemInfoLoading}
        itemInfo={itemInfo}
        videoSourceInfo={videoSourceInfo}
        onCloseItemInfo={handleCloseInfo}
        onCloseVideoSourceInfo={handleCloseVideoInfo}
      />
      {/* 控制栏 — 悬浮在视频底部，不占据固定高度，修复全屏黑条 */}
      <div className="absolute bottom-0 left-0 right-0 z-30">
        <PlayerControls
          visible={controlsVisible}
          isPortrait={isPortrait}
          isPlaying={isPlaying}
          displayMode={displayMode}
          episodeCount={Math.max(episodeList.length, folderVideos.length)}
          currentEpisodeIndex={currentEpisodeIndex}
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          playbackRate={playbackRate}
          volume={volume}
          subtitleTrackCount={subtitleTracks.length}
          activeSubtitleIndex={activeSubtitleIndex}
          danmakuEnabled={danmakuEnabled}
          danmakuOffset={danmakuOffset}
          pipActive={pipActive}
          subtitleSettingsOpen={subtitleSettingsOpen}
          onMouseMove={handleMouseMove}
          onPlayPause={handlePlayPause}
          onPreviousEpisode={() => handleSwitchEpisode(currentEpisodeIndex - 1)}
          onNextEpisode={() => handleSwitchEpisode(currentEpisodeIndex + 1)}
          onToggleEpisodePopup={() => setEpisodePopup((open) => !open)}
          onSeek={handleSeek}
          onToggleSpeedPopup={() => { if (speedPopup) setSpeedPopup(false); else { closeAllPopups(); setSpeedPopup(true) } }}
          onToggleVolumePopup={() => { if (volumePopup) setVolumePopup(false); else { closeAllPopups(); setVolumePopup(true) } }}
          onToggleSubtitlePopup={() => { if (subtitlePopup) setSubtitlePopup(false); else { closeAllPopups(); setSubtitlePopup(true) } }}
          onToggleSubtitleSettings={() => { if (subtitleSettingsOpen) setSubtitleSettingsOpen(false); else { closeAllPopups(); setSubtitleSettingsOpen(true) } }}
          onToggleDanmaku={handleDanmakuToggle}
          onOpenDanmakuSearch={handleOpenDanmakuSearch}
          onResetDanmakuOffset={() => handleOffsetChange(0)}
          onToggleDanmakuSettings={() => { if (settingsOpen) setSettingsOpen(false); else { closeAllPopups(); setSettingsOpen(true) } }}
          onScreenshot={() => { void handleScreenshot() }}
          onPictureInPicture={() => { void handlePictureInPicture() }}
          onFullscreen={handleFullscreen}
          onToggleDisplayMode={() => setDisplayMode(prev => prev === 'contain' ? 'cover' : 'contain')}
        />
      </div>

      <PlayerPopups
        episodeOpen={episodePopup}
        episodes={episodeList}
        folderVideos={folderVideos}
        currentEpisodeIndex={currentEpisodeIndex}
        speedOpen={speedPopup}
        playbackRate={playbackRate}
        volumeOpen={volumePopup}
        volume={volume}
        subtitleOpen={subtitlePopup}
        subtitleTracks={subtitleTracks}
        activeSubtitleIndex={activeSubtitleIndex}
        onEpisodeClose={() => setEpisodePopup(false)}
        onEpisodeSwitch={handleSwitchEpisode}
        onSpeedClose={() => setSpeedPopup(false)}
        onPlaybackRateChange={handlePlaybackRateChange}
        onVolumeChange={handleVolumeChange}
        onToggleMute={handleToggleMute}
        onSubtitleSelect={handleSubtitleSelect}
      />
    </div>
  )
}

export default Player
