import { useRef, useState, useEffect, useCallback, type ReactElement } from 'react'
// 修复点 1.15: pages 目录下深一层，从 ../../ → ../../../shared/types
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem } from '../../../shared/types'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Volume2, VolumeX, Volume1, Gauge, List, X, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { cachedFetch } from '../utils/apiCache'
import { MediaTimeBus, createMediaTimeBus } from '../utils/mediaTimeBus'
import { usePlayerStore } from '../utils/playerStore'
import { DanmakuEngine } from '../utils/danmakuEngine'
import { danmakuRequestManager } from '../utils/danmakuRequestManager'

// ==================== 字幕类型 ====================

interface SubtitleCue {
  start: number
  end: number
  text: string
}

function parseVTT(vtt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = vtt.split(/\r?\n/)
  // 跳过 WEBVTT 头部
  let i = 0
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('WEBVTT') || lines[i].startsWith('Kind:') || lines[i].startsWith('Language:'))) {
    i++
  }
  // 解析时间轴块
  const timeRe = /^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
  function parseTime(s: string): number {
    const parts = s.split(':')
    const secParts = parts[2].split(/[.,]/)
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(secParts[0]) + parseInt(secParts[1]) / 1000
  }
  while (i < lines.length) {
    const line = lines[i].trim()
    const m = line.match(timeRe)
    if (m) {
      const start = parseTime(m[1])
      const end = parseTime(m[2])
      i++
      const textLines: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim())
        i++
      }
      // 过滤掉 VTT 标签（如 <v ...>）
      const text = textLines.join('\n').replace(/<[^>]+>/g, '').trim()
      if (text) cues.push({ start, end, text })
    } else {
      i++
    }
  }
  return cues
}



// ==================== 工具 ====================

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function cleanTitleForMatch(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\[.*?\]/g, '').replace(/【.*?】/g, '').replace(/\(.*?\)/g, '')
    .replace(/\d{4}[./-]\d{2}[./-]\d{2}/g, '')
    .replace(/1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL/gi, '')
    .replace(/x264|x265|H264|HEVC|AVC|AAC|FLAC|AUTO/gi, '')
    .trim()
}

function extractSeriesNameFromFilename(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, '')
  return name
    .replace(/E?P?\s*\d{1,3}/gi, '').replace(/第\s*\d{1,3}\s*[话集]/g, '')
    .replace(/S\d+E\d{1,3}/gi, '').replace(/\s*-\s*\d{1,3}/, '')
    .replace(/\[.*?\]/g, '').replace(/【.*?】/g, '').replace(/\(.*?\)/g, '')
    .trim()
}

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
  const [showEpisodeList, setShowEpisodeList] = useState(false)
  const [episodePopup, setEpisodePopup] = useState(false)
  
  // 本地文件夹视频列表
  const [folderVideos, setFolderVideos] = useState<{name: string; path: string}[]>([])

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
  const [subtitleTracks, setSubtitleTracks] = useState<{ index: number; label: string; language: string; url: string }[]>([])
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(-1)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [currentSubtitleText, setCurrentSubtitleText] = useState('')
  const [subtitleBottom, setSubtitleBottom] = useState(8) // 字幕距底部百分比
  const [subtitleFontSize, setSubtitleFontSize] = useState(22) // 字幕字体大小 px
  const [subtitleLetterSpacing, setSubtitleLetterSpacing] = useState(0) // 字间距 px
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false)

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

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
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
    const unsubRAF = timeBusRef.current.subscribeRAF((time, playbackRate) => {
      if (danmakuEnabled && engineRef.current) {
        engineRef.current.update(time, playbackRate)
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

  // 修复点 1.5: 补齐 fd / fb 的参数类型与返回值类型，消除严格模式下 implicit any
  const fd = (s: number): string => {
    const safe = isFinite(s) ? Math.max(0, s) : 0
    const h = Math.floor(safe / 3600)
    const m = Math.floor((safe % 3600) / 60)
    const sec = Math.floor(safe % 60)
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  const fb = (b: number): string => {
    const safe = isFinite(b) ? Math.max(0, b) : 0
    return safe >= 1e9 ? `${(safe / 1e9).toFixed(1)} GB`
      : safe >= 1e6 ? `${(safe / 1e6).toFixed(1)} MB`
      : safe >= 1e3 ? `${(safe / 1e3).toFixed(1)} KB`
      : `${safe} B`
  }

  const handleVideoSourceInfo = async (): Promise<void> => {
    setContextMenu({ x: 0, y: 0, visible: false })
    const info: Record<string, string> = {}
    const v = videoRef.current
    if (v) {
      info["视频分辨率"] = `${v.videoWidth || '--'} × ${v.videoHeight || '--'}`
      info["时长"] = fd(v.duration || 0)
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
            if (anyMs.Size) info["文件大小"] = fb(Number(anyMs.Size))
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

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    // 修复全屏黑条: 容器改为纯 relative，子元素均 absolute 定位，控件悬浮覆盖视频
    <div ref={containerRef} className="h-full relative bg-black outline-none" onKeyDown={handleKeyDown} tabIndex={0}>

      {/* 视频区域 — 全屏铺满容器 */}
      <div className="absolute inset-0 bg-black overflow-hidden" onContextMenu={handleContextMenu} onClick={handlePlayPause} onMouseMove={handleMouseMove}>
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

        <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" controls={false} playsInline preload="metadata" crossOrigin="anonymous" />
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />

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
      {searchOpen && (
        <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="danmaku-search-popup w-72 player-glass-panel z-50 p-4">
          <div className="flex gap-2 mb-3">
            <input type="text" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleDanmakuSearch() }} placeholder="搜索弹幕" className="flex-1 bg-white/5 border border-white/5 rounded-md px-3 py-2 text-xs text-white/90 placeholder-white/25 focus:outline-none focus:border-[#8b82f6]/40 focus:bg-white/8" autoFocus />
            <button onClick={() => handleDanmakuSearch()} disabled={searchLoading} className="px-3 py-2 bg-[#8b82f6] hover:bg-[#7a72e5] rounded-md text-xs font-medium text-white disabled:opacity-40 transition-colors">{searchLoading ? '...' : '搜索'}</button>
          </div>
          {searchLoading && (
            <div className="flex items-center justify-center py-6">
              <svg className="animate-spin h-5 w-5 text-[#8b82f6]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="ml-2 text-xs text-white/40">搜索中...</span>
            </div>
          )}
          {!searchLoading && searchResults.length > 0 && (
            <div className="max-h-60 overflow-y-auto space-y-0.5">
              {searchResults.map((ep, i) => (
                <button key={`${ep.episodeId}-${i}`} onClick={() => handleDanmakuSelect(ep)} className="w-full text-left px-3 py-2 rounded hover:bg-white/5 transition-colors">
                  <div className="text-xs text-white truncate">{ep.animeTitle}</div>
                  <div className="text-[10px] text-white/35 mt-0.5">{ep.episodeTitle} &middot; {ep.typeDescription}</div>
                </button>
              ))}
            </div>
          )}
          {!searchLoading && searchResults.length === 0 && searchKeyword.trim() && (
            <div className="text-center py-4 text-xs text-white/25">无搜索结果</div>
          )}
          {localFile && (
            <button onClick={handleLoadLocalXml} className="mt-2 w-full text-[10px] text-white/30 hover:text-[#8b82f6] py-2 border-t border-white/5 transition-colors">加载本地 XML 弹幕</button>
          )}
          <button onClick={() => { closeAllPopups(); setSearchResults([]) }} className="mt-2 w-full text-[10px] text-white/25 hover:text-white/70 py-1 transition-colors">关闭</button>
        </div>
      )}

      {/* 弹幕设置面板 */}
      {settingsOpen && (
        <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="danmaku-settings-popup w-60 player-glass-panel z-50 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-medium">弹幕设置</h3>
            <button onClick={closeAllPopups} className="text-white/30 hover:text-white/80 transition-colors text-sm">&times;</button>
          </div>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>透明度</span><span>{Math.round(danmakuOpacity * 100)}%</span></div>
              <input type="range" min="0" max="1" step="0.1" value={danmakuOpacity} onChange={(e) => handleOpacityChange(parseFloat(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>字体大小</span><span>{danmakuFontSize}px</span></div>
              <input type="range" min="12" max="48" step="1" value={danmakuFontSize} onChange={(e) => handleFontSizeChange(parseInt(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>速度</span><span>{danmakuSpeed}px/s</span></div>
              <input type="range" min="60" max="300" step="10" value={danmakuSpeed} onChange={(e) => handleSpeedChange(parseInt(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5">
                <span>弹幕密度</span>
                <span>{danmakuMaxCount} 条</span>
              </div>
              <input
                type="range"
                min="50"
                max="500"
                step="50"
                value={danmakuMaxCount}
                onChange={(e) => handleDensityChange(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/25 mt-1">
                <span>稀疏 (50)</span>
                <span>密集 (500)</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5">
                <span>时间偏移</span>
                <span className={danmakuOffset !== 0 ? 'text-[#8b82f6]' : ''}>{danmakuOffset > 0 ? `+${danmakuOffset.toFixed(1)}` : danmakuOffset.toFixed(1)}s</span>
              </div>
              <input
                type="range"
                min="-30"
                max="30"
                step="0.5"
                value={danmakuOffset}
                onChange={(e) => handleOffsetChange(parseFloat(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/25 mt-1">
                <span>提前 (-30s)</span>
                <span>延后 (+30s)</span>
              </div>
              {danmakuOffset !== 0 && (
                <button
                  onClick={() => handleOffsetChange(0)}
                  className="mt-2 w-full text-[10px] text-[#8b82f6] hover:text-[#a29bfe] py-1 transition-colors"
                >
                  重置偏移
                </button>
              )}
            </div>
            {/* 弹幕显示区域边界 */}
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5">
                <span>上边界</span>
                <span>{danmakuTopBoundary}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={danmakuTopBoundary}
                onChange={(e) => handleTopBoundaryChange(Math.min(parseInt(e.target.value), danmakuBottomBoundary - 1))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/25 mt-1">
                <span>顶部</span>
                <span>向下</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5">
                <span>下边界</span>
                <span>{danmakuBottomBoundary}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={danmakuBottomBoundary}
                onChange={(e) => handleBottomBoundaryChange(Math.max(parseInt(e.target.value), danmakuTopBoundary + 1))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/25 mt-1">
                <span>向上</span>
                <span>底部</span>
              </div>
            </div>
            {/* 快捷预设按钮 */}
            <div className="flex gap-1.5 mt-1">
              <button
                onClick={() => { handleTopBoundaryChange(0); handleBottomBoundaryChange(100) }}
                className="flex-1 text-[9px] py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
              >
                全屏
              </button>
              <button
                onClick={() => { handleTopBoundaryChange(0); handleBottomBoundaryChange(50) }}
                className="flex-1 text-[9px] py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
              >
                上半屏
              </button>
              <button
                onClick={() => { handleTopBoundaryChange(50); handleBottomBoundaryChange(100) }}
                className="flex-1 text-[9px] py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
              >
                下半屏
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 字幕设置面板 */}
      {subtitleSettingsOpen && (
        <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="subtitle-settings-popup w-60 player-glass-panel z-50 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-medium">字幕设置</h3>
            <button onClick={closeAllPopups} className="text-white/30 hover:text-white/80 transition-colors text-sm">&times;</button>
          </div>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>上下位置</span><span>{subtitleBottom}%</span></div>
              <input type="range" min="0" max="30" step="1" value={subtitleBottom} onChange={(e) => { const v = parseInt(e.target.value); setSubtitleBottom(v); window.api.store.set('subtitleBottom', v) }} className="w-full" />
              <div className="flex justify-between text-[9px] text-white/25 mt-1"><span>靠上</span><span>靠下</span></div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>字体大小</span><span>{subtitleFontSize}px</span></div>
              <input type="range" min="12" max="48" step="1" value={subtitleFontSize} onChange={(e) => { const v = parseInt(e.target.value); setSubtitleFontSize(v); window.api.store.set('subtitleFontSize', v) }} className="w-full" />
              <div className="flex justify-between text-[9px] text-white/25 mt-1"><span>小</span><span>大</span></div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>字间距</span><span>{subtitleLetterSpacing}px</span></div>
              <input type="range" min="0" max="12" step="0.5" value={subtitleLetterSpacing} onChange={(e) => { const v = parseFloat(e.target.value); setSubtitleLetterSpacing(v); window.api.store.set('subtitleLetterSpacing', v) }} className="w-full" />
              <div className="flex justify-between text-[9px] text-white/25 mt-1"><span>紧凑</span><span>宽松</span></div>
            </div>
            <button
              onClick={() => { setSubtitleBottom(8); setSubtitleFontSize(22); setSubtitleLetterSpacing(0); window.api.store.set('subtitleBottom', 8); window.api.store.set('subtitleFontSize', 22); window.api.store.set('subtitleLetterSpacing', 0) }}
              className="w-full text-[10px] text-[#8b82f6] hover:text-[#a29bfe] py-1 transition-colors"
            >
              恢复默认
            </button>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <>
          <div className="fixed inset-0 z-40" onClick={handleCloseContextMenu} onContextMenu={(e) => { e.preventDefault(); handleCloseContextMenu() }} />
          <div className="fixed z-50 w-40 player-glass-panel rounded-md py-1" style={{ left: Math.min(contextMenu.x, window.innerWidth - 170), top: Math.min(contextMenu.y, window.innerHeight - 280) }}>
            <button onClick={handleShowInfo} className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 transition-colors">影片信息</button>
            <hr className="border-white/5 my-0.5" />
            <button onClick={handleVideoSourceInfo} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">视频源信息</button>
            <div className="px-3 py-1 text-[10px] text-white/35">播放速度</div>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <button key={rate} onClick={() => handlePlaybackRateChange(rate)} className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${playbackRate === rate ? 'text-[#8b82f6]' : 'text-white/60 hover:bg-white/5'}`}>{rate}x</button>
            ))}
            <hr className="border-white/5 my-0.5" />
            <button onClick={() => { handleDanmakuToggle(); handleCloseContextMenu() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">{danmakuEnabled ? '关闭弹幕' : '开启弹幕'}</button>
            <button onClick={() => { handleOpenDanmakuSearch(); handleCloseContextMenu() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">搜索弹幕</button>
            <button onClick={() => { handleLoadLocalXml(); handleCloseContextMenu() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">加载本地弹幕</button>
          </div>
        </>
      )}

      {/* 影片信息覆盖层 */}
      {infoOverlay && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center animate-page-in" onClick={handleCloseInfo}>
          <div className="w-[480px] max-h-[70vh] player-glass-panel p-8 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium">影片信息</h3>
              <button onClick={handleCloseInfo} className="w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all text-sm">&times;</button>
            </div>
            {itemInfoLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="w-5 h-5 border border-[#8b82f6] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : itemInfo ? (
              // 修复点 1.14: Record<string,unknown> 里的所有属性都是 unknown，渲染前必须显式 String() 化，
              // 消除 Type 'unknown' is not assignable to type 'ReactNode'
              <div className="space-y-4 text-xs">
                <div className="flex justify-between"><span className="text-white/35">片名</span><span className="text-white/80">{String(itemInfo.Name ?? '-')}</span></div>
                {/* 修复点 1.17: strict 模式下 unknown 不能作为条件表达式，否则整个 && 表达式类型=unknown 无法作为 ReactNode。
                    先显式转为 boolean（!!）或做 nullish 比较。 */}
                {!!itemInfo.OriginalTitle && <div className="flex justify-between"><span className="text-white/35">原名</span><span className="text-white/50">{String(itemInfo.OriginalTitle)}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">年份</span><span className="text-white/50">{String(itemInfo.ProductionYear ?? '-')}</span></div>
                {Array.isArray(itemInfo.Genres) && (itemInfo.Genres as unknown[]).length > 0 && <div className="flex justify-between"><span className="text-white/35">类型</span><span className="text-white/50">{(itemInfo.Genres as unknown[]).map((g) => String(g)).join(' / ')}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">时长</span><span className="text-white/50">{itemInfo.RunTimeTicks ? formatTime((Number(itemInfo.RunTimeTicks) / 10000000)) : '-'}</span></div>
                {itemInfo.CommunityRating != null && <div className="flex justify-between"><span className="text-white/35">评分</span><span className="text-[#8b82f6] font-medium">{String(itemInfo.CommunityRating)}</span></div>}
                {itemInfo.Overview != null && <div><div className="text-white/35 mb-2">简介</div><p className="text-white/50 leading-relaxed">{String(itemInfo.Overview)}</p></div>}
              </div>
            ) : <p className="text-xs text-white/25 text-center py-10">无法获取影片信息</p>}
          </div>
        </div>
      )}


      {/* 视频源信息覆盖层 */}
      {videoSourceInfo && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center animate-page-in" onClick={handleCloseVideoInfo}>
          <div className="w-[520px] max-h-[75vh] player-glass-panel p-8 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium">视频源信息</h3>
              <button onClick={handleCloseVideoInfo} className="w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/5 transition-colors"><X size={15} /></button>
            </div>
            <div className="space-y-2 text-xs">
              {Object.entries(videoSourceInfo).map(([key, val]) => (
                <div key={key} className="flex justify-between py-1.5 border-b border-white/5 last:border-0">
                  <span className="text-white/40 min-w-[120px]">{key}</span>
                  <span className="text-white/80 text-right font-mono">{val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* 控制栏 — 悬浮在视频底部，不占据固定高度，修复全屏黑条 */}
      <div className={`absolute bottom-0 left-0 right-0 player-glass-bar h-16 flex items-center px-5 gap-6 z-20 transition-opacity duration-300 ease-in-out ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onMouseMove={handleMouseMove}>
        {/* 播放/暂停 */}
        <button onClick={handlePlayPause} className="glass-btn-sm text-white/80 hover:text-white" title={isPlaying ? '暂停' : '播放'}>
          {isPlaying ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
          )}
        </button>

        {/* 剧集切换按钮 */}
        {(episodeList.length > 0 || folderVideos.length > 0) && (
          <div className="relative flex items-center gap-2">
            <button
              onClick={() => handleSwitchEpisode(currentEpisodeIndex - 1)}
              disabled={currentEpisodeIndex <= 0}
              className="glass-btn-sm text-white/60 hover:text-white/80 disabled:opacity-20 disabled:cursor-not-allowed"
              title="上一集"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-xs text-[#8b82f6] font-medium tabular-nums whitespace-nowrap min-w-[80px] text-center">
              第 {currentEpisodeIndex + 1} / {Math.max(episodeList.length, folderVideos.length)} 集
            </span>
            <button
              onClick={() => handleSwitchEpisode(currentEpisodeIndex + 1)}
              disabled={currentEpisodeIndex >= Math.max(episodeList.length, folderVideos.length) - 1}
              className="glass-btn-sm text-white/60 hover:text-white/80 disabled:opacity-20 disabled:cursor-not-allowed"
              title="下一集"
            >
              <ChevronRight size={18} />
            </button>
            <div className="w-[1px] h-4 bg-white/8 mx-1" />
            <button
              onClick={() => setEpisodePopup(!episodePopup)}
              className="glass-btn-sm text-white/60 hover:text-white/80 flex items-center gap-1"
              title="剧集列表"
            >
              <List size={18} />
              <span className="text-xs text-white/40">{Math.max(episodeList.length, folderVideos.length)}集</span>
            </button>
          </div>
        )}

        {/* 进度条 */}
        <div className="flex-1 h-6 flex items-center cursor-pointer group relative" onClick={handleSeek}>
          <div className="absolute left-0 right-0 h-[2px] bg-white/5 rounded-full group-hover:h-[4px] transition-all">
            <div className="h-full bg-white/10 rounded-full" style={{ width: `${bufferedPercent}%` }} />
            <div className="h-full bg-[#8b82f6] rounded-full absolute top-0 left-0" style={{ width: `${progressPercent}%` }} />
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-[#8b82f6] rounded-full opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `${progressPercent}%` }} />
          </div>
        </div>

        {/* 时间 */}
        <span className="text-xs text-white/40 font-mono tabular-nums w-[90px] text-right whitespace-nowrap">
          {formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(duration)}
        </span>

        {/* 倍速 */}
        <div className="speed-popup">
          <button
            onClick={() => { if (speedPopup) { setSpeedPopup(false) } else { closeAllPopups(); setSpeedPopup(true) } }}
            className={`glass-btn-sm text-xs font-medium ${playbackRate !== 1 ? 'text-[#8b82f6]' : 'text-white/60 hover:text-white/80'}`}
            title="播放速度"
          >
            <span className="flex items-center gap-1"><Gauge size={13} />{playbackRate}x</span>
          </button>
        </div>

        {/* 音量 */}
        <div className="volume-popup">
          <button
            onClick={() => { if (volumePopup) { setVolumePopup(false) } else { closeAllPopups(); setVolumePopup(true) } }}
            className="glass-btn-icon text-white/50 hover:text-white/80"
            title="音量"
          >
            {volume === 0 ? <VolumeX size={17} /> : volume < 50 ? <Volume1 size={17} /> : <Volume2 size={17} />}
          </button>
        </div>

        {/* 字幕选择按钮 */}
        {subtitleTracks.length > 0 && (
          <button
            onClick={() => { if (subtitlePopup) { setSubtitlePopup(false) } else { closeAllPopups(); setSubtitlePopup(true) } }}
            className={`glass-btn-icon ${activeSubtitleIndex >= 0 ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`}
            title="字幕轨道"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h2M11 15h6M7 11h10"/></svg>
          </button>
        )}
        {activeSubtitleIndex >= 0 && (
          <button
            onClick={() => { if (subtitleSettingsOpen) { setSubtitleSettingsOpen(false) } else { closeAllPopups(); setSubtitleSettingsOpen(true) } }}
            className={`glass-btn-icon ${subtitleSettingsOpen ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`}
            title="字幕设置"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>
          </button>
        )}

        {/* 弹幕按钮 */}
        <button onClick={handleDanmakuToggle} className={`glass-btn-sm text-xs ${danmakuEnabled ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/70'}`} title="弹幕">
          弹
        </button>
        <button onClick={handleOpenDanmakuSearch} className="glass-btn-icon text-white/50 hover:text-white/80" title="搜索弹幕">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        {danmakuOffset !== 0 && (
          <button onClick={() => handleOffsetChange(0)} className="glass-btn-sm text-[10px] text-[#8b82f6] hover:text-[#a29bfe]" title={`弹幕偏移 ${danmakuOffset > 0 ? '+' : ''}${danmakuOffset.toFixed(1)}s，点击重置`}>
            {danmakuOffset > 0 ? '+' : ''}{danmakuOffset.toFixed(1)}s
          </button>
        )}
        <button onClick={() => { if (settingsOpen) { setSettingsOpen(false) } else { closeAllPopups(); setSettingsOpen(true) } }} className="glass-btn-icon text-white/50 hover:text-white/80" title="弹幕设置">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>

        {/* P2: 截图 */}
        <button onClick={handleScreenshot} className="glass-btn-icon text-white/50 hover:text-white/80" title="截图 (S)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>

        {/* P2: 画中画 */}
        <button onClick={handlePictureInPicture} className={`glass-btn-icon ${pipActive ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`} title="画中画 (D)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill={pipActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="11" y="9" width="9" height="7" rx="1" fill={pipActive ? 'currentColor' : 'none'} opacity="0.7"/></svg>
        </button>

        {/* 全屏 */}
        <button onClick={handleFullscreen} className="glass-btn-icon text-white/50 hover:text-white/80" title="全屏">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
      </div>

      {/* 剧集列表弹窗 — fixed 定位，不受视频 overflow 影响 */}
      <AnimatePresence>
        {episodePopup && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-20 right-4 player-glass-panel p-3 z-50 max-h-[400px] overflow-y-auto"
          >
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/5">
              <span className="text-xs text-white/60 font-medium">剧集列表</span>
              <button onClick={() => setEpisodePopup(false)} className="text-white/40 hover:text-white transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-6 gap-2" style={{ minWidth: '280px' }}>
              {episodeList.length > 0 ? episodeList.map((ep, idx) => {
                const epId = (ep as any).Id || (ep as any).id
                const isActive = idx === currentEpisodeIndex
                return (
                  <button
                    key={epId}
                    onClick={() => {
                      handleSwitchEpisode(idx)
                      setEpisodePopup(false)
                    }}
                    className={`text-xs py-1.5 px-2 rounded transition-colors truncate ${
                      isActive 
                        ? 'bg-[#8b82f6] text-white shadow-[0_0_12px_rgba(139,130,246,0.3)]' 
                        : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90'
                    }`}
                    title={ep.Name || `第${idx + 1}集`}
                  >
                    {idx + 1}
                  </button>
                )
              }) : folderVideos.map((video, idx) => (
                <button
                  key={video.path}
                  onClick={() => {
                    handleSwitchEpisode(idx)
                    setEpisodePopup(false)
                  }}
                  className={`text-xs py-1.5 px-2 rounded transition-colors truncate ${
                    idx === currentEpisodeIndex
                      ? 'bg-[#8b82f6] text-white shadow-[0_0_12px_rgba(139,130,246,0.3)]' 
                      : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90'
                  }`}
                  title={video.name}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 倍速弹窗 */}
      <AnimatePresence>
        {speedPopup && (
          <motion.div
            className="fixed bottom-20 right-4 speed-popup player-glass-panel rounded-lg py-2 min-w-[120px] z-50"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <button
                key={rate}
                onClick={() => { handlePlaybackRateChange(rate); setSpeedPopup(false) }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${playbackRate === rate ? 'text-[#8b82f6] bg-white/5' : 'text-white/60 hover:bg-white/5'}`}
              >
                {rate === 1 ? '正常' : `${rate}x`}
                {playbackRate === rate && <span className="float-right text-[#8b82f6]">✓</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 音量弹窗 */}
      <AnimatePresence>
        {volumePopup && (
          <motion.div
            className="fixed bottom-20 right-4 volume-popup player-glass-panel rounded-lg p-3 z-50 w-52"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-white/40 w-8 text-right">{volume}%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  playerActions.setVolume(v)
                  const video = videoRef.current
                  if (video) { video.volume = v / 100; video.muted = v === 0 }
                }}
                className="flex-1 h-1 appearance-none bg-white/8 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => {
                  const video = videoRef.current; if (!video) return
                  const muted = !video.muted; video.muted = muted; playerActions.setVolume(muted ? 0 : Math.round(video.volume * 100))
                }}
                className="text-[10px] text-white/40 hover:text-white/80 transition-colors"
              >
                {volume === 0 ? '取消静音' : '静音'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 字幕弹窗 */}
      <AnimatePresence>
        {subtitlePopup && (
          <motion.div
            className="fixed bottom-20 right-4 subtitle-popup player-glass-panel rounded-lg py-1 min-w-[160px] z-50"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <button
              onClick={() => handleSubtitleSelect(-1)}
              className={`w-full text-left px-4 py-2 text-xs hover:bg-white/5 flex items-center gap-2 ${activeSubtitleIndex === -1 ? 'text-[#8b82f6]' : 'text-white/70'}`}
            >
              <span className="w-3 text-center">{activeSubtitleIndex === -1 ? '✓' : ''}</span>
              关闭字幕
            </button>
            {subtitleTracks.map((track, i) => (
              <button
                key={i}
                onClick={() => handleSubtitleSelect(i)}
                className={`w-full text-left px-4 py-2 text-xs hover:bg-white/5 flex items-center gap-2 ${activeSubtitleIndex === i ? 'text-[#8b82f6]' : 'text-white/70'}`}
              >
                <span className="w-3 text-center">{activeSubtitleIndex === i ? '✓' : ''}</span>
                {track.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default Player
