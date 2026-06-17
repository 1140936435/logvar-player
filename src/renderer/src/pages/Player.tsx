import { useRef, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem, MpvTrack } from '../../shared/types'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Volume2, VolumeX, Volume1, Gauge, List, X, ChevronLeft, ChevronRight, TvMinimalPlay, ArrowLeft } from 'lucide-react'
import { cachedFetch } from '../utils/apiCache'

// ==================== 弹幕类型 ====================

interface ActiveComment {
  text: string
  x: number
  y: number
  color: string
  speed: number
  width: number
  mode: number
  bornAt: number
  duration: number
}

// ==================== 弹幕引擎 ====================

const DANMAKU_TRACK_COUNT = 12
const DANMAKU_TRACK_HEIGHT = 32
const DANMAKU_FIXED_DURATION = 4

// 弹幕颜色缓存（避免重复转换）
const colorCache = new Map<number, string>()
function decToRgb(dec: number): string {
  let cached = colorCache.get(dec)
  if (cached) return cached
  const r = (dec >> 16) & 0xff
  const g = (dec >> 8) & 0xff
  const b = dec & 0xff
  cached = `rgb(${r},${g},${b})`
  if (colorCache.size > 256) colorCache.clear()
  colorCache.set(dec, cached)
  return cached
}

class DanmakuEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private allComments: DanmakuComment[] = []  // 保存所有原始弹幕
  private displayedIndex = 0  // 记录已经处理到哪一条弹幕（不删除）
  private active: ActiveComment[] = []
  private trackOccupied: number[] = new Array(DANMAKU_TRACK_COUNT).fill(0)
  private lastTime = 0
  private enabled = true
  private opacity = 1.0
  private fontSize = 24
  private speed = 120
  private maxCount = 300 // 密度 50-500，控制活跃轨道数
  private timeDensity = 20 // 每秒最多显示条数
  private lastAddTime = 0
  private addedThisSecond = 0
  private lastVideoTime = 0 // 用于检测跳播

  // 密度值 → 活跃轨道数（线性映射 50→3, 500→12）
  private activeTrackCount(): number {
    return Math.round(3 + (this.maxCount - 50) / 450 * 9)
  }

  private fontString = ''
  private trackTemp = new Array(DANMAKU_TRACK_COUNT)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.buildFont()
  }

  private buildFont(): void {
    this.fontString = `bold ${this.fontSize}px "Microsoft YaHei", sans-serif`
  }

  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    this.canvas.width = parent.clientWidth
    this.canvas.height = parent.clientHeight
  }

  loadComments(comments: DanmakuComment[]): void {
    const sorted = [...comments].sort((a, b) => a.time - b.time)
    // 保存所有原始弹幕
    this.allComments = sorted
    // 重置播放状态，确保新弹幕从头开始显示
    this.displayedIndex = 0
    this.lastAddTime = 0
    this.addedThisSecond = 0
    this.lastVideoTime = 0
  }

  getCommentCount(): number {
    return this.allComments.length  // 返回总弹幕数，不是当前显示数
  }

  clear(): void {
    this.allComments = []
    this.active = []
    this.trackOccupied = new Array(DANMAKU_TRACK_COUNT).fill(0)
    this.displayedIndex = 0
    this.lastAddTime = 0
    this.addedThisSecond = 0
    this.lastVideoTime = 0
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity))
  }

  setFontSize(size: number): void {
    this.fontSize = Math.max(12, Math.min(48, size))
    this.buildFont()
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(60, Math.min(300, speed))
  }

  setMaxCount(count: number): void {
    const oldTracks = this.activeTrackCount()
    this.maxCount = Math.max(50, Math.min(500, count))
    const newTracks = this.activeTrackCount()
    // 降低密度：移除超出新轨道范围的弹幕，即时视觉反馈
    if (newTracks < oldTracks) {
      this.active = this.active.filter(a => {
        const track = Math.floor(a.y / DANMAKU_TRACK_HEIGHT)
        return track < newTracks
      })
    }
  }

  setTimeDensity(density: number): void {
    this.timeDensity = Math.max(5, Math.min(50, density))
  }

  private getTrackForScroll(): number {
    const numTracks = this.activeTrackCount()
    // 优先选空轨道
    for (let i = 0; i < numTracks; i++) {
      if (this.trackOccupied[i] <= 0) return i
    }
    // 选现有弹幕已过半屏的轨道（最多同时 2 条同轨，不重叠）
    for (let i = 0; i < numTracks; i++) {
      if (this.trackOccupied[i] <= this.canvas.width * 0.5) return i
    }
    // 全忙，选最空闲的
    let best = 0
    let bestRight = Infinity
    for (let i = 0; i < numTracks; i++) {
      if (this.trackOccupied[i] < bestRight) {
        bestRight = this.trackOccupied[i]
        best = i
      }
    }
    return best
  }

  private addComment(c: DanmakuComment, now: number): boolean {
    // 时间密度控制 - 限制每秒显示的弹幕数
    const elapsed = now - this.lastAddTime
    if (elapsed >= 1) {
      this.addedThisSecond = 0
      this.lastAddTime = now
    }
    if (this.addedThisSecond >= this.timeDensity) {
      return false
    }
    this.addedThisSecond++

    const colorStr = decToRgb(c.color)
    this.ctx.font = this.fontString
    const metrics = this.ctx.measureText(c.text)
    const textWidth = metrics.width

    if (c.mode === 1) {
      const track = this.getTrackForScroll()
      const y = track * DANMAKU_TRACK_HEIGHT + DANMAKU_TRACK_HEIGHT * 0.8
      // 在前一条弹幕后紧跟，间距 = 字号，绝不重叠
      const startX = Math.max(this.canvas.width + 10, this.trackOccupied[track] + this.fontSize)
      this.trackOccupied[track] = startX + textWidth
      this.active.push({
        text: c.text, x: startX, y,
        color: colorStr, speed: this.speed, width: textWidth,
        mode: 1, bornAt: now, duration: 0
      })
    } else {
      // 固定弹幕：在活跃轨道范围内找最空的轨道
      const numTracks = this.activeTrackCount()
      const isTop = c.mode === 5
      const half = Math.floor(numTracks / 2)
      const tStart = isTop ? 0 : half
      const tEnd = isTop ? half : numTracks
      let bestTrack = tStart
      let bestRight = Infinity
      for (let i = tStart; i < tEnd; i++) {
        if (this.trackOccupied[i] < bestRight) {
          bestRight = this.trackOccupied[i]
          bestTrack = i
        }
      }
      const y = bestTrack * DANMAKU_TRACK_HEIGHT + DANMAKU_TRACK_HEIGHT * 0.8
      this.trackOccupied[bestTrack] = textWidth
      this.active.push({
        text: c.text, x: (this.canvas.width - textWidth) / 2, y,
        color: colorStr, speed: 0, width: textWidth,
        mode: c.mode, bornAt: now, duration: DANMAKU_FIXED_DURATION
      })
    }
    return true
  }

  update(videoTime: number): void {
    if (this.allComments.length === 0 || !this.enabled) return

    const delta = videoTime - this.lastVideoTime

    // 检测跳播（时间跳跃超过 1 秒视为 seek 操作）
    if (Math.abs(delta) > 1) {
      this.active = []
      this.trackOccupied = new Array(DANMAKU_TRACK_COUNT).fill(0)
      this.lastAddTime = videoTime
      this.addedThisSecond = 0

      if (delta > 0) {
        // 前进跳播：快速跳过已错过的弹幕（预留 2 秒缓冲，显示即将出现的弹幕）
        while (this.displayedIndex < this.allComments.length &&
               this.allComments[this.displayedIndex].time < videoTime - 2) {
          this.displayedIndex++
        }
      } else {
        // 后退跳播：从头定位到当前时间附近的弹幕
        this.displayedIndex = 0
        while (this.displayedIndex < this.allComments.length &&
               this.allComments[this.displayedIndex].time < videoTime - 2) {
          this.displayedIndex++
        }
      }
    }

    this.lastVideoTime = videoTime

    // 从 allComments 中取出应该显示的弹幕（连续流动，不丢弃被阻塞的弹幕）
    let addedThisFrame = 0
    while (this.displayedIndex < this.allComments.length &&
           this.allComments[this.displayedIndex].time <= videoTime &&
           addedThisFrame < 3) {
      const c = this.allComments[this.displayedIndex]
      if (this.addComment(c, videoTime)) {
        this.displayedIndex++
        addedThisFrame++
      } else {
        // 时间密度超限，跳过本条，下帧继续下一条
        this.displayedIndex++
        break
      }
    }

    const now = performance.now()
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 0.016
    this.lastTime = now

    // 单次遍历：更新位置 + 过滤 + 重建轨道占用
    let wi = 0
    const arr = this.active
    const ln = arr.length
    const occ = this.trackTemp
    for (let i = 0; i < DANMAKU_TRACK_COUNT; i++) occ[i] = 0

    for (let i = 0; i < ln; i++) {
      const a = arr[i]
      if (a.mode === 1) {
        a.x -= a.speed * dt
        if (a.x <= -a.width - 20) continue
        const tk = Math.floor(a.y / DANMAKU_TRACK_HEIGHT)
        if (tk >= 0 && tk < DANMAKU_TRACK_COUNT) {
          const r = a.x + a.width
          if (r > occ[tk]) occ[tk] = r
        }
      } else if (videoTime - a.bornAt >= a.duration) {
        continue
      }
      arr[wi++] = a
    }
    arr.length = wi
    this.trackOccupied = occ
  }

  draw(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!this.enabled) return
    this.ctx.globalAlpha = this.opacity
    this.ctx.font = this.fontString
    this.ctx.textBaseline = 'middle'
    this.ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    this.ctx.lineWidth = 3

    for (const a of this.active) {
      this.ctx.strokeText(a.text, a.x, a.y)
      this.ctx.fillStyle = a.color
      this.ctx.fillText(a.text, a.x, a.y)
    }
    this.ctx.globalAlpha = 1.0
  }

  enable(): void { this.enabled = true; this.lastTime = 0 }
  disable(): void { this.enabled = false; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height) }
  isEnabled(): boolean { return this.enabled }
  start(): void { this.lastTime = 0 }
  stop(): void { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height) }
}

// ==================== 工具 ====================

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
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

function Player(): JSX.Element {
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
  
  // 剧集列表状态
  const [episodeList, setEpisodeList] = useState<JellyfinItem[]>([])
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(-1)
  const [showEpisodeList, setShowEpisodeList] = useState(false)
  const [episodePopup, setEpisodePopup] = useState(false)
  
  // 本地文件夹视频列表
  const [folderVideos, setFolderVideos] = useState<{name: string; path: string}[]>([])

  useEffect(() => {
    window.api.store.get('jellyfin').then(async (saved: unknown) => {
      const s = saved as { token?: string } | null
      if (s?.token) {
        setJellyfinToken(s.token)
      } else {
        try {
          const servers = await window.api.store.get('jellyfin:servers') as Array<{ id?: string; token?: string }> | null
          const activeId = await window.api.store.get('jellyfin:activeServerId') as string | null
          if (servers && servers.length > 0) {
            const active = activeId ? servers.find(s => s.id === activeId) : servers[0]
            if (active?.token) setJellyfinToken(active.token)
          }
        } catch { /* ignore */ }
      }
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
          console.error('[EpisodeList] fetchEpisodes error:', err)
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
          console.error('[EpisodeList] fetchDetail error:', err)
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
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<DanmakuEngine | null>(null)
  const resumePosRef = useRef(parseFloat(searchParams.get('position') || '0'))
  const hasResumedRef = useRef(false)

  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(100)
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeRef = useRef(0) // 性能优化：ref 避免逐帧 setState
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  const [danmakuLoading, setDanmakuLoading] = useState(false)
  // const [danmakuCount, setDanmakuCount] = useState(0) // deprecated, use currentDanmakuCount instead
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
  // const [danmakuSmartMode, setDanmakuSmartMode] = useState(false) // removed
  // const [danmakuTimeDensity, setDanmakuTimeDensity] = useState(20) // removed // 每秒最多显示条数

  const [playbackRate, setPlaybackRate] = useState(1)

  // MPV 状态
  const [useMpv, setUseMpv] = useState(false)
  const [mpvReady, setMpvReady] = useState(false)
  const [mpvTracks, setMpvTracks] = useState<MpvTrack[]>([])
  // HTML5 轨道检测
  const [html5AudioTracks, setHtml5AudioTracks] = useState<{ id: string; label: string; language: string; enabled: boolean }[]>([])
  const [html5TextTracks, setHtml5TextTracks] = useState<{ id: string; label: string; language: string; mode: string }[]>([])
  const [showTrackMenu, setShowTrackMenu] = useState(false)
  const [trackMenuTab, setTrackMenuTab] = useState<'audio' | 'subtitle'>('audio')

  const [speedToast, setSpeedToast] = useState('')
  const [volumePopup, setVolumePopup] = useState(false)
  const [speedPopup, setSpeedPopup] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)

  // P2: 窗口置顶
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  // P2: 画中画 (PiP)
  const [pipActive, setPipActive] = useState(false)

  // P2: AB 循环
  const abPointARef = useRef<number | null>(null)
  const abPointBRef = useRef<number | null>(null)
  const [abLoopActive, setAbLoopActive] = useState(false)

  // P2: 缩略图预览
  const thumbVideoRef = useRef<HTMLVideoElement>(null)
  const thumbCanvasRef = useRef<HTMLCanvasElement>(null)
  const thumbTooltipRef = useRef<HTMLDivElement>(null)
  const [thumbVisible, setThumbVisible] = useState(false)
  const thumbRafRef = useRef<number>(0)
  const thumbPendingTimeRef = useRef<number>(0)
  const thumbCacheRef = useRef<Map<number, ImageBitmap>>(new Map())
  const thumbReadyRef = useRef(false) // HTML5 缩略图视频是否已加载就绪
  const thumbMpvRequestIdRef = useRef(0) // mpv 缩略图请求 ID（用于取消过期请求）
  const thumbMpvLoadingRef = useRef(false) // mpv 缩略图是否正在加载中

  // 检测是否为网络 URL
  const isNetworkUrl = (s: string): boolean => /^https?:\/\//.test(s) || /^rtsp:\/\//.test(s) || /^rtmp:\/\//.test(s) || /^mms:\/\//.test(s) || /^udp:\/\//.test(s)

  // P2: 自动连播
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null)
  const autoplayTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 点击其它地方关闭弹出面板
  useEffect(() => {
    if (!volumePopup && !speedPopup) return
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.volume-popup') && !target.closest('.speed-popup')) {
        setVolumePopup(false)
        setSpeedPopup(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [volumePopup, speedPopup])

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
  const [infoOverlay, setInfoOverlay] = useState(false)
  const [itemInfo, setItemInfo] = useState<Record<string, unknown> | null>(null)
  const [itemInfoLoading, setItemInfoLoading] = useState(false)
  const [videoSourceInfo, setVideoSourceInfo] = useState<Record<string, string> | null>(null)

  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showStatus = (msg: string): void => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    setStatusMsg(msg)
    statusTimerRef.current = setTimeout(() => { setStatusMsg(''); statusTimerRef.current = null }, 2000)
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
    const interval = setInterval(savePlayHistory, 5000)
    return () => clearInterval(interval)
  }, [savePlayHistory])

  useEffect(() => { return () => { savePlayHistory() } }, [savePlayHistory])

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
        if (maxCount !== null) { setDanmakuMaxCount(Number(maxCount)); engineRef.current?.setMaxCount(Number(maxCount)) }
      } catch (err) { /* ignore */ }
    }
    loadSettings()

    const handleResize = (): void => engineRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize); engineRef.current?.stop() }
  }, [canvasRef.current])

  // P2: 清理自动连播计时器
  useEffect(() => {
    return () => {
      if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
    }
  }, [])

  // P2: 开始播放时取消自动连播倒计时
  useEffect(() => {
    if (playing && autoplayCountdown !== null) {
      if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
      setAutoplayCountdown(null)
    }
  }, [playing, autoplayCountdown])

  useEffect(() => {
    // 只要有 localFile 或 seriesName 就尝试加载弹幕，itemName 可以是未知视频
    if (!localFile && !seriesName && (!itemName || itemName === '未知视频')) return
    engineRef.current?.clear()
    setCurrentDanmakuCount(0)
    setDanmakuLoading(true)
    setDanmakuError('')
    const loadId = ++danmakuLoadIdRef.current

    if (localFile) {
      window.api.danmaku.findLocalXml(localFile).then((xmlResult) => {
        if (xmlResult.success && xmlResult.data) {
          const data = xmlResult.data as { count: number; comments: DanmakuComment[]; source?: string }
          engineRef.current?.loadComments(data.comments)
          setCurrentDanmakuCount(data.count)
          setDanmakuCountVisible(true)
          setTimeout(() => setDanmakuCountVisible(false), 3000)
          setDanmakuLoading(false)
          return
        }
        tryDanmakuApiMatch()
      }).catch(() => tryDanmakuApiMatch())
      return
    }
    tryDanmakuApiMatch()

    function tryDanmakuApiMatch(): void {
      const matchTitle = seriesName || (localFile ? extractSeriesNameFromFilename(localFile.split(/[/\\]/).pop() || itemName) || itemName : itemName)
      const title = cleanTitleForMatch(matchTitle)
      if (!title) { setDanmakuLoading(false); return }
      window.api.danmaku.match(matchTitle).then((result) => {
        if (!result.success || !result.data) { setDanmakuError(result.error || '自动匹配失败'); setDanmakuLoading(false); return }
        const match = result.data as { episodeId: number; animeTitle?: string; animeId?: number; source?: string }
        if (match.animeId) { window.api.danmaku.prefetchSeries(match.animeId).catch(() => {}) }
        window.api.danmaku.getComments(String(match.episodeId), match.source).then((commentResult) => {
          if (commentResult.success && commentResult.data) {
            const data = commentResult.data as { count: number; comments: DanmakuComment[] }
            engineRef.current?.loadComments(data.comments)
            setCurrentDanmakuCount(data.count)
            setDanmakuCountVisible(true)
            setTimeout(() => setDanmakuCountVisible(false), 3000)
          } else { setDanmakuError(commentResult.error || '获取弹幕失败') }
        }).catch(() => setDanmakuError('获取弹幕失败')).finally(() => setDanmakuLoading(false))
      }).catch(() => { setDanmakuError('自动匹配失败'); setDanmakuLoading(false) })
    }
  }, [itemId, itemName, localFile, seriesName])

  const handleDanmakuToggle = (): void => {
    const next = !danmakuEnabled; setDanmakuEnabled(next)
    window.api.store.set('danmakuEnabled', next)
    next ? engineRef.current?.enable() : engineRef.current?.disable()
    if (next) engineRef.current?.start()
  }

  const handleOpacityChange = (value: number): void => { setDanmakuOpacity(value); engineRef.current?.setOpacity(value); window.api.store.set('danmakuOpacity', value) }
  const handleFontSizeChange = (value: number): void => { setDanmakuFontSize(value); engineRef.current?.setFontSize(value); window.api.store.set('danmakuFontSize', value) }
  const handleSpeedChange = (value: number): void => { setDanmakuSpeed(value); engineRef.current?.setSpeed(value); window.api.store.set('danmakuSpeed', value) }

  // 弹幕密度控制 - 简单滑块
  const handleDensityChange = (value: number): void => {
    setDanmakuMaxCount(value)
    window.api.store.set('danmakuMaxCount', value)
    if (engineRef.current) {
      engineRef.current.setMaxCount(value)
    }
  }

  const handleDanmakuSearch = async (keyword?: string): Promise<void> => {
    const kw = (keyword || searchKeyword).trim()
    if (!kw) return; setSearchLoading(true)
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
    setSearchOpen(true)
    handleDanmakuSearch(searchTitle)
  }

  const handleDanmakuSelect = async (ep: DanmakuSearchResult): Promise<void> => {
    setSearchOpen(false); setSearchResults([]); setDanmakuLoading(true); setDanmakuError('')
    try {
      const result = await window.api.danmaku.getComments(String(ep.episodeId))
      if (result.success && result.data) {
        const data = result.data as { count: number; comments: DanmakuComment[] }
        engineRef.current?.loadComments(data.comments); setCurrentDanmakuCount(data.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000)
      } else { setDanmakuError(result.error || '获取弹幕失败') }
    } catch { setDanmakuError('获取弹幕失败') }
    setDanmakuLoading(false)
  }

  const handleLoadLocalXml = async (): Promise<void> => {
    if (!localFile) { showStatus('仅本地文件支持加载 XML 弹幕'); return }
    setSearchOpen(false); setDanmakuLoading(true); setDanmakuError('')
    try {
      const result = await window.api.danmaku.findLocalXml(localFile)
      if (result.success && result.data) {
        const data = result.data as { count: number; comments: DanmakuComment[]; source?: string }
        engineRef.current?.loadComments(data.comments); setCurrentDanmakuCount(data.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000); showStatus(`已加载本地弹幕: ${data.source || ''}`)
      } else { setDanmakuError(result.error || '未找到本地弹幕 XML') }
    } catch (err) { setDanmakuError(`本地 XML 加载失败: ${String(err)}`) }
    setDanmakuLoading(false)
  }

  // ==================== 视频源 & 事件 ====================

  // mpv 启动失败时的回退标志
  const mpvFailedRef = useRef(false)
  // 防止快速切换视频时的竞态
  const videoLoadIdRef = useRef(0)
  const danmakuLoadIdRef = useRef(0)

  // 缩略图 helper：将 dataUrl/Image 绘制到 canvas 并缓存 ImageBitmap
  const drawThumbToCanvas = useCallback((source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, cacheKey: number, sourceWidth: number, sourceHeight: number): void => {
    const canvas = thumbCanvasRef.current
    if (!canvas || !sourceWidth || !sourceHeight) return
    const w = 160
    const h = Math.round(160 * (sourceHeight / sourceWidth))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    try {
      ctx.drawImage(source, 0, 0, w, h)
      // 异步创建 ImageBitmap 用于缓存
      if (!thumbCacheRef.current.has(cacheKey)) {
        createImageBitmap(canvas).then(bmp => {
          thumbCacheRef.current.set(cacheKey, bmp)
          if (thumbCacheRef.current.size > 300) {
            const firstKey = thumbCacheRef.current.keys().next().value
            if (firstKey !== undefined) {
              const old = thumbCacheRef.current.get(firstKey)
              thumbCacheRef.current.delete(firstKey)
              old?.close()
            }
          }
        }).catch(() => {})
      }
    } catch { /* canvas may be tainted */ }
  }, [])

  // 缩略图 seek 完成后绘制到 canvas（HTML5 回退模式：直接绘制 + ImageBitmap 缓存）
  useEffect(() => {
    const thumbVideo = thumbVideoRef.current
    if (!thumbVideo) return

    const handleLoadedData = (): void => {
      thumbReadyRef.current = true
    }
    const handleError = (): void => {
      thumbReadyRef.current = false
    }
    thumbVideo.addEventListener('loadeddata', handleLoadedData)
    thumbVideo.addEventListener('error', handleError)

    const handleSeeked = (): void => {
      requestAnimationFrame(() => {
        if (!thumbVideo.videoWidth) return
        const cacheKey = Math.floor(thumbVideo.currentTime * 2)
        drawThumbToCanvas(thumbVideo, cacheKey, thumbVideo.videoWidth, thumbVideo.videoHeight)
      })
    }
    thumbVideo.addEventListener('seeked', handleSeeked)
    return () => {
      thumbVideo.removeEventListener('seeked', handleSeeked)
      thumbVideo.removeEventListener('loadeddata', handleLoadedData)
      thumbVideo.removeEventListener('error', handleError)
    }
  }, [drawThumbToCanvas])

  // 缩略图视频源同步：仅依赖 localFile（HTML5 回退模式）
  useEffect(() => {
    const thumbVideo = thumbVideoRef.current
    if (!thumbVideo || !localFile) return
    thumbReadyRef.current = false
    thumbCacheRef.current.clear()
    const isUrl = isNetworkUrl(localFile)
    if (isUrl) {
      // 网络 URL：直接加载
      thumbVideo.src = localFile
      thumbVideo.load()
    } else {
      // 本地文件：通过 file:// 协议加载（支持 Range seek）
      window.api.file.getLocalFileUrl(localFile).then((result) => {
        if (result.success && result.data) {
          const data = result.data as { url: string }
          if (data.url && thumbVideoRef.current) {
            thumbVideoRef.current.src = data.url
            thumbVideoRef.current.load()
          }
        }
      }).catch((err) => console.warn('[Thumb] getLocalFileUrl failed:', err))
    }
  }, [localFile])

  // MPV 嵌入窗口辅助函数：在播放前先创建子窗口，让 mpv 渲染到 Electron 窗口内
  const embedMpvIfNeeded = async (): Promise<void> => {
    const area = videoAreaRef.current
    if (!area) throw new Error('视频区域未就绪')
    const rect = area.getBoundingClientRect()
    // 使用整数坐标，避免子窗口偏移
    const result = await window.api.mpv.embed(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height))
    if (!result.success) throw new Error(result.error || '嵌入窗口失败')
  }

  // 监听视频区域大小变化，更新 mpv 子窗口尺寸
  useEffect(() => {
    const area = videoAreaRef.current
    if (!area || !useMpv) return
    const ro = new ResizeObserver(() => {
      const rect = area.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        window.api.mpv.updateEmbed(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height))
      }
    })
    ro.observe(area)
    return () => { ro.disconnect() }
  }, [useMpv])

  useEffect(() => {
    setLoading(true); setError('')
    // 切换视频源时重置 HTML5 轨道
    setHtml5AudioTracks([]); setHtml5TextTracks([])
    // 重置缩略图缓存
    thumbCacheRef.current.clear()
    // 递增加载 ID 用于竞态检测
    const loadId = ++videoLoadIdRef.current
    if (localFile) {
      const isUrl = isNetworkUrl(localFile)
      // MPV 模式：直接用本地文件路径或网络 URL 加载
      if (useMpv && !mpvFailedRef.current) {
        embedMpvIfNeeded().then(() => window.api.mpv.play(localFile)).then(result => {
          if (!result.success) {
            console.warn('[Player] mpv failed, falling back to HTML5:', result.error)
            mpvFailedRef.current = true
            // 回退到 HTML5 模式
            if (isUrl) {
              if (videoRef.current) { videoRef.current.src = localFile; videoRef.current.load(); setSrcReady(true) }
              else { setError('mpv 加载失败'); setLoading(false) }
            } else {
              window.api.file.getLocalFileUrl(localFile).then((r) => {
                if (r.success && r.data && videoRef.current) {
                  const url = (r.data as { url: string }).url
                  videoRef.current.src = url; videoRef.current.load(); setSrcReady(true)
                } else { setError('无法读取本地文件'); setLoading(false) }
              }).catch(() => { setError('无法读取本地文件'); setLoading(false) })
            }
          } else {
            // mpv 播放成功
            setSrcReady(true)
          }
        }).catch(err => {
          console.warn('[Player] mpv failed, falling back to HTML5:', err)
          mpvFailedRef.current = true
          if (isUrl) {
            if (videoRef.current) { videoRef.current.src = localFile; videoRef.current.load(); setSrcReady(true) }
            else { setError('mpv 加载失败'); setLoading(false) }
          } else {
            window.api.file.getLocalFileUrl(localFile).then((r) => {
              if (r.success && r.data && videoRef.current) {
                const url = (r.data as { url: string }).url
                videoRef.current.src = url; videoRef.current.load(); setSrcReady(true)
              } else { setError('无法读取本地文件'); setLoading(false) }
            }).catch(() => { setError('无法读取本地文件'); setLoading(false) })
          }
        })
        return
      }
      // HTML5 模式
      if (isUrl) {
        // 网络 URL：直接设置 src（支持 http/https 流）
        if (videoRef.current) {
          videoRef.current.src = localFile
          videoRef.current.load()
          setSrcReady(true)
        } else { setError('播放器未就绪'); setLoading(false) }
        return
      }
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
        setError('无法读取本地文件'); setLoading(false)
      }).catch(() => { setError('无法读取本地文件'); setLoading(false) })
      return
    }
    if (!itemId) { setLoading(false); return }
    // MPV 模式：通过 Jellyfin API 获取播放 URL
    if (useMpv && !mpvFailedRef.current) {
      window.api.jellyfin.getPlaybackUrl(itemId).then((result) => {
        if (result.success) {
          const data = result.data as { url?: string }
          if (data?.url) {
            embedMpvIfNeeded().then(() => window.api.mpv.play(data.url!)).then(playResult => {
              if (!playResult.success) {
                console.warn('[Player] mpv play failed, falling back to HTML5:', playResult.error)
                mpvFailedRef.current = true
                // 回退 HTML5
                if (videoRef.current && data.url) { videoRef.current.src = data.url; setSrcReady(true) }
                else { setError(playResult.error || 'mpv 加载失败'); setLoading(false) }
              }
            }).catch(err => {
              console.warn('[Player] mpv play failed, falling back to HTML5:', err)
              mpvFailedRef.current = true
              if (videoRef.current && data.url) { videoRef.current.src = data.url; setSrcReady(true) }
              else { setError(`mpv 加载失败: ${String(err)}`); setLoading(false) }
            })
            return
          }
        }
        setError('获取播放地址失败'); setLoading(false)
      }).catch((err) => { setError(`获取播放地址失败: ${String(err)}`); setLoading(false) })
      return
    }
    // HTML5 模式
    window.api.jellyfin.getPlaybackUrl(itemId).then((result) => {
      if (result.success) {
        const data = result.data as { url?: string }
        if (data?.url && videoRef.current) { videoRef.current.src = data.url; setSrcReady(true); return }
      }
      setError('获取播放地址失败'); setLoading(false)
    }).catch((err) => { setError(`获取播放地址失败: ${String(err)}`); setLoading(false) })
  }, [itemId, localFile, useMpv])

  useEffect(() => {
    const video = videoRef.current; if (!video) return

    const onLoadedMetadata = (): void => {
      setDuration(video.duration || 0); setLoading(false)
      if (!hasResumedRef.current && resumePosRef.current > 0) { hasResumedRef.current = true; video.currentTime = resumePosRef.current }
      video.play().then(() => setPlaying(true)).catch(() => {})

      // 检测 HTML5 音频轨道
      try {
        const at = (video as any).audioTracks
        if (at && at.length > 0) {
          const tracks = Array.from(at).map((t: any, i: number) => ({
            id: String(t.id || i),
            label: t.label || t.language || `音轨 ${i + 1}`,
            language: t.language || '',
            enabled: t.enabled
          }))
          setHtml5AudioTracks(tracks)
        } else { setHtml5AudioTracks([]) }
      } catch { setHtml5AudioTracks([]) }

      // 检测 HTML5 字幕轨道
      try {
        const tt = video.textTracks
        if (tt && tt.length > 0) {
          const tracks: { id: string; label: string; language: string; mode: string }[] = []
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i]
            // 只显示字幕类型的轨道
            if (t.kind === 'subtitles' || t.kind === 'captions' || t.kind === 'metadata') {
              tracks.push({
                id: String(t.id || i),
                label: t.label || t.language || `字幕 ${tracks.length + 1}`,
                language: t.language || '',
                mode: t.mode || 'hidden'
              })
            }
          }
          setHtml5TextTracks(tracks)
        } else { setHtml5TextTracks([]) }
      } catch { setHtml5TextTracks([]) }
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    const onEnded = (): void => {
      setPlaying(false)
      // P2: 自动连播 — 播完后倒计时 5 秒自动播放下一集
      const totalEpisodes = episodeList.length || folderVideos.length
      if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
      if (totalEpisodes > 0 && currentEpisodeIndex < totalEpisodes - 1) {
        let countdown = 5
        setAutoplayCountdown(countdown)
        autoplayTimerRef.current = setInterval(() => {
          countdown--
          if (countdown <= 0) {
            if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
            setAutoplayCountdown(null)
            handleSwitchEpisode(currentEpisodeIndex + 1)
          } else {
            setAutoplayCountdown(countdown)
          }
        }, 1000)
      }
    }
    const onTimeUpdate = (): void => {
      const ct = video.currentTime
      currentTimeRef.current = ct
      // 每 250ms 更新一次 React state，减少重渲染
      if (Math.abs(ct - currentTime) > 0.5) setCurrentTime(ct)
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1))
      // P2: AB 循环 — 到达 B 点时跳回 A 点
      if (abLoopActive && abPointARef.current !== null && abPointBRef.current !== null) {
        if (ct >= abPointBRef.current) {
          video.currentTime = abPointARef.current
          showStatus('AB 循环')
        }
      }
    }
    const onWaiting = (): void => setLoading(true)
    const onCanPlay = (): void => setLoading(false)
    const onError = (): void => {
      const errMsg = (() => {
        switch (video.error?.code) {
          case 1: return '视频加载中止'; case 2: return '网络错误'; case 3: return '视频解码失败'; case 4: return '视频源不可用'; default: return '视频加载失败'
        }
      })(); setError(errMsg); setLoading(false)
    }
    const onVolumeChange = (): void => { setVolume(Math.round(video.volume * 100)) }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError)
    video.addEventListener('volumechange', onVolumeChange)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('error', onError)
      video.removeEventListener('volumechange', onVolumeChange)
    }
  }, [srcReady, danmakuEnabled, abLoopActive, currentEpisodeIndex, episodeList.length, folderVideos.length])

  // ==================== MPV 事件监听 ====================

  // 组件是否已挂载（防止卸载后 setState）
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    // 检查 mpv 是否可用
    window.api.mpv.isAvailable().then(result => {
      if (mountedRef.current && result.success && result.data) {
        setUseMpv(true)
      }
    }).catch(() => {})

    // 监听 mpv 事件
    const eventHandler = (event: string, data: unknown): void => {
      if (!mountedRef.current) return // 组件已卸载，忽略事件
      switch (event) {
        case 'ready':
          setMpvReady(true)
          setLoading(false)
          break
        case 'time':
          if (typeof data === 'number') {
            currentTimeRef.current = data
            if (Math.abs(data - currentTimeRef.current) > 0.5) setCurrentTime(data)
            // P2: AB 循环 — 到达 B 点时跳回 A 点
            if (abLoopActive && abPointARef.current !== null && abPointBRef.current !== null) {
              if (data >= abPointBRef.current) {
                window.api.mpv.seek(abPointARef.current)
                showStatus('AB 循环')
              }
            }
          }
          break
        case 'duration':
          if (typeof data === 'number') {
            setDuration(data)
            setLoading(false)
            // 恢复播放位置
            if (!hasResumedRef.current && resumePosRef.current > 0) {
              hasResumedRef.current = true
              window.api.mpv.seek(resumePosRef.current)
            }
          }
          break
        case 'pause':
          setPlaying(data !== true)
          break
        case 'volume':
          if (typeof data === 'number') setVolume(Math.round(data))
          break
        case 'speed':
          if (typeof data === 'number') setPlaybackRate(data)
          break
        case 'track-list':
          if (Array.isArray(data)) {
            setMpvTracks(data as MpvTrack[])
          }
          break
        case 'file-loaded':
          setLoading(false)
          setError('')
          // 获取轨道列表
          window.api.mpv.getTracks().then(result => {
            if (result.success && result.data) setMpvTracks(result.data)
          }).catch(() => {})
          break
        case 'stop':
          setPlaying(false)
          break
        case 'start':
          setPlaying(true)
          break
        case 'error': {
          const errMsg = typeof data === 'string' ? data : 'mpv 播放错误'
          console.warn('[Player] mpv error, falling back to HTML5:', errMsg)
          mpvFailedRef.current = true
          setUseMpv(false)
          setError(errMsg)
          setLoading(false)
          break
        }
        case 'quit': {
          console.log('[Player] mpv process quit, falling back to HTML5')
          mpvFailedRef.current = true
          setUseMpv(false)
          setMpvReady(false)
          setPlaying(false)
          break
        }
      }
    }

    window.api.mpv.onEvent(eventHandler)
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!danmakuEnabled || !engineRef.current) return
    let animId = 0
    const loop = (): void => {
      if (engineRef.current) {
        // 优先使用 mpv 时间，否则使用 HTML5 video 时间
        const time = useMpv ? currentTimeRef.current : (videoRef.current?.currentTime || 0)
        const isPlayingNow = useMpv ? playing : (videoRef.current && !videoRef.current.paused)
        if (isPlayingNow) engineRef.current.update(time)
        engineRef.current.draw()
      }
      animId = requestAnimationFrame(loop)
    }
    animId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animId)
  }, [danmakuEnabled, srcReady, useMpv, playing])

  // ==================== 控制 ====================

  const handlePlayPause = (): void => {
    if (useMpv && mpvReady) {
      if (playing) {
        window.api.mpv.pause()
      } else {
        window.api.mpv.resume()
      }
      return
    }
    const video = videoRef.current; if (!video) return
    video.paused ? video.play().catch(() => showStatus('播放失败')) : video.pause()
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (useMpv && mpvReady) {
      window.api.mpv.seek(ratio * duration)
      return
    }
    const video = videoRef.current; if (!video || !duration) return
    video.currentTime = ratio * duration
  }

  const handleFullscreen = (): void => {
    if (useMpv && mpvReady) {
      window.api.mpv.toggleFullscreen()
      return
    }
    const container = containerRef.current; if (!container) return
    document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : container.requestFullscreen().catch(() => showStatus('全屏切换失败'))
  }

  const handlePlaybackRateChange = (rate: number): void => {
    if (useMpv && mpvReady) {
      window.api.mpv.setSpeed(rate)
      setPlaybackRate(rate)
      setContextMenu({ x: 0, y: 0, visible: false })
      setSpeedToast(`${rate}x`); setTimeout(() => setSpeedToast(''), 2000)
      return
    }
    const video = videoRef.current; if (!video) return
    video.playbackRate = rate; setPlaybackRate(rate)
    setContextMenu({ x: 0, y: 0, visible: false })
    setSpeedToast(`${rate}x`); setTimeout(() => setSpeedToast(''), 2000)
  }

  // ==================== 轨道管理 ====================

  // 统一的轨道列表：mpv 模式使用 mpvTracks，HTML5 模式使用 video.audioTracks/textTracks
  const isMpvMode = useMpv && mpvReady
  const audioTracks = isMpvMode
    ? mpvTracks.filter(t => t.type === 'audio')
    : html5AudioTracks.map((t, i) => ({ id: i, type: 'audio' as const, selected: t.enabled, title: t.label, lang: t.language, codec: '', 'demux-w': 0, 'demux-h': 0 }))
  const subtitleTracks = isMpvMode
    ? mpvTracks.filter(t => t.type === 'sub')
    : html5TextTracks.map((t, i) => ({ id: i, type: 'sub' as const, selected: t.mode === 'showing', title: t.label, lang: t.language, codec: '', 'demux-w': 0, 'demux-h': 0 }))
  const hasMultipleTracks = audioTracks.length > 1 || subtitleTracks.length > 0

  /**
   * 截图：优先使用 mpv 截图，mpv 不可用时使用 Canvas 截取当前视频帧
   */
  const handleScreenshot = useCallback(async (): Promise<void> => {
    // 先尝试 mpv 截图（mpv 模式下）
    if (isMpvMode) {
      try {
        const result = await window.api.mpv.screenshotSave()
        if (result.success) { showStatus('截图已保存'); return }
      } catch { /* mpv 不可用，fallback 到 Canvas */ }
    }
    // Canvas 截取视频帧
    const video = videoRef.current
    if (!video || !video.videoWidth) { showStatus('无可截取的视频帧'); return }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) { showStatus('截图失败：无法生成图片'); return }
      // 下载截图
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showStatus('截图已保存')
    } catch (err) {
      showStatus('截图失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [isMpvMode, showStatus])

  /**
   * 画中画：HTML5 模式使用原生 PiP API，mpv 模式使用迷你窗口
   */
  const handlePictureInPicture = useCallback(async (): Promise<void> => {
    // HTML5 模式 — 使用浏览器原生 PiP API
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
      } catch (err) {
        // PiP 失败，尝试 mpv 方案
      }
    }
    // mpv 模式或 PiP 不可用 — 使用窗口置顶 + 缩小窗口
    try {
      const result = await window.api.window.alwaysOnTop()
      if (result.success) {
        setAlwaysOnTop(!!result.data)
        setPipActive(!!result.data)
        showStatus(result.data ? '画中画（置顶小窗）' : '退出画中画')
      }
    } catch {
      showStatus('画中画不可用')
    }
  }, [showStatus])

  // 监听 PiP 事件（原生 PiP 退出时同步状态）
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
  })

  const handleSelectAudioTrack = (trackId: number): void => {
    if (isMpvMode) {
      window.api.mpv.selectTrack(trackId)
    } else {
      // HTML5 模式：切换 audioTracks
      try {
        const at = (videoRef.current as any)?.audioTracks
        if (at) {
          for (let i = 0; i < at.length; i++) {
            at[i].enabled = i === trackId
          }
          setHtml5AudioTracks(Array.from(at).map((t: any, i: number) => ({
            id: String(t.id || i), label: t.label || t.language || `音轨 ${i + 1}`,
            language: t.language || '', enabled: t.enabled
          })))
        }
      } catch { /* ignore */ }
    }
    setShowTrackMenu(false)
  }

  const handleSelectSubtitle = (trackId: number): void => {
    if (isMpvMode) {
      window.api.mpv.selectSubtitle(trackId)
    } else {
      // HTML5 模式：切换 textTrack mode
      try {
        const tt = videoRef.current?.textTracks
        if (tt) {
          for (let i = 0; i < tt.length; i++) {
            const kind = tt[i].kind
            if (kind === 'subtitles' || kind === 'captions' || kind === 'metadata') {
              tt[i].mode = i === trackId ? 'showing' : 'hidden'
            }
          }
          const tracks: { id: string; label: string; language: string; mode: string }[] = []
          for (let i = 0; i < tt.length; i++) {
            if (tt[i].kind === 'subtitles' || tt[i].kind === 'captions' || tt[i].kind === 'metadata') {
              tracks.push({ id: String(i), label: tt[i].label || tt[i].language || `字幕 ${tracks.length + 1}`, language: tt[i].language || '', mode: tt[i].mode || 'hidden' })
            }
          }
          setHtml5TextTracks(tracks)
        }
      } catch { /* ignore */ }
    }
    setShowTrackMenu(false)
  }

  const handleDisableSubtitle = (): void => {
    if (isMpvMode) {
      window.api.mpv.disableSubtitle()
    } else {
      // HTML5 模式：关闭所有字幕
      try {
        const tt = videoRef.current?.textTracks
        if (tt) {
          for (let i = 0; i < tt.length; i++) {
            if (tt[i].kind === 'subtitles' || tt[i].kind === 'captions' || tt[i].kind === 'metadata') {
              tt[i].mode = 'hidden'
            }
          }
          setHtml5TextTracks(prev => prev.map(t => ({ ...t, mode: 'hidden' })))
        }
      } catch { /* ignore */ }
    }
    setShowTrackMenu(false)
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

  // 缩略图预览：鼠标在进度条上移动时生成缩略图
  // mpv 模式：通过 IPC 调用 mpv screenshot → 适用于所有 mpv 支持的格式（MKV/HEVC/AV1 等）
  // HTML5 模式：通过隐藏 <video> 元素 seek → 仅适用于 Chromium 支持的格式
  const handleProgressMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    resetAutoHide()
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const hoverTime = ratio * duration
    const thumbX = e.clientX
    const thumbY = rect.top

    // 立即通过 ref 更新 tooltip 位置（不触发 React 重渲染）
    if (thumbTooltipRef.current) {
      thumbTooltipRef.current.style.left = `${thumbX}px`
      thumbTooltipRef.current.style.top = `${thumbY - 110}px`
      const label = thumbTooltipRef.current.querySelector<HTMLElement>('.thumb-time')
      if (label) label.textContent = formatTime(hoverTime)
    }
    if (!thumbVisible) setThumbVisible(true)

    // 缓存查找（0.5s 粒度）
    const cacheKey = Math.floor(hoverTime * 2)
    const cached = thumbCacheRef.current.get(cacheKey)
    if (cached && thumbCanvasRef.current) {
      const ctx = thumbCanvasRef.current.getContext('2d')
      if (ctx && cached.width > 0) {
        if (thumbCanvasRef.current.width !== cached.width || thumbCanvasRef.current.height !== cached.height) {
          thumbCanvasRef.current.width = cached.width
          thumbCanvasRef.current.height = cached.height
        }
        ctx.drawImage(cached, 0, 0)
      }
      return
    }

    thumbPendingTimeRef.current = hoverTime

    // 用 rAF 限流，确保每帧最多处理一次
    if (thumbRafRef.current) return
    thumbRafRef.current = requestAnimationFrame(() => {
      thumbRafRef.current = 0
      const targetTime = thumbPendingTimeRef.current

      // mpv 模式：通过 IPC 获取缩略图（适用于所有格式）
      if (useMpv && mpvReady) {
        // 如果正在加载中，跳过（避免堆积请求）
        if (thumbMpvLoadingRef.current) return
        const reqId = ++thumbMpvRequestIdRef.current
        thumbMpvLoadingRef.current = true
        console.log(`[Thumb][mpv] requesting thumbnail for t=${targetTime.toFixed(2)} reqId=${reqId}`)
        window.api.mpv.thumbnail(targetTime).then((result) => {
          // 检查是否为最新请求
          if (reqId !== thumbMpvRequestIdRef.current) { console.log(`[Thumb][mpv] stale req ${reqId}, current=${thumbMpvRequestIdRef.current}`); return }
          console.log(`[Thumb][mpv] result: success=${result.success} hasDataUrl=${!!result.data?.dataUrl} dataUrlLen=${result.data?.dataUrl?.length || 0}`)
          if (result.success && result.data?.dataUrl) {
            const img = new Image()
            img.onload = () => {
              console.log(`[Thumb][mpv] image loaded: ${img.naturalWidth}x${img.naturalHeight}`)
              if (reqId !== thumbMpvRequestIdRef.current) return
              drawThumbToCanvas(img, cacheKey, img.naturalWidth, img.naturalHeight)
              thumbMpvLoadingRef.current = false
            }
            img.onerror = (e) => {
              console.error(`[Thumb][mpv] image load error`, e)
              thumbMpvLoadingRef.current = false
            }
            img.src = result.data.dataUrl
          } else {
            console.warn(`[Thumb][mpv] no dataUrl, result error:`, result.error)
            thumbMpvLoadingRef.current = false
          }
        }).catch((e) => {
          console.error(`[Thumb][mpv] IPC error:`, e)
          thumbMpvLoadingRef.current = false
        })
        return
      }

      // HTML5 回退模式
      const thumbVideo = thumbVideoRef.current
      if (!thumbVideo || !thumbReadyRef.current) return
      thumbVideo.currentTime = targetTime
    })
  }, [duration, resetAutoHide, thumbVisible, useMpv, mpvReady, drawThumbToCanvas])

  const handleProgressMouseLeave = useCallback((): void => {
    setThumbVisible(false)
  }, [])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      if (thumbRafRef.current) cancelAnimationFrame(thumbRafRef.current)
    }
  }, [])

  const handleContextMenu = (e: React.MouseEvent): void => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, visible: true }) }
  const handleCloseContextMenu = (): void => { setContextMenu({ x: 0, y: 0, visible: false }) }

  const handleShowInfo = async (): Promise<void> => {
    setContextMenu({ x: 0, y: 0, visible: false })
    if (!itemId) return; setItemInfoLoading(true); setInfoOverlay(true)
    try { const result = await window.api.jellyfin.getItemDetails(itemId); if (result.success) setItemInfo(result.data as Record<string, unknown>) } catch { /* ignore */ }
    setItemInfoLoading(false)
  }
  const handleCloseInfo = (): void => { setInfoOverlay(false); setItemInfo(null) }

  const fd = (s) => { const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const sec=Math.floor(s%60);return h>0?h+":"+String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0"):m+":"+String(sec).padStart(2,"0") }
  const fb = (b) => b>=1e9?(b/1e9).toFixed(1)+" GB":b>=1e6?(b/1e6).toFixed(1)+" MB":b>=1e3?(b/1e3).toFixed(1)+" KB":b+" B"

  const handleVideoSourceInfo = async () => {
    setContextMenu({ x: 0, y: 0, visible: false })
    const info = {}
    const v = videoRef.current
    if (v) {
      info["视频分辨率"] = (v.videoWidth || "--") + " × " + (v.videoHeight || "--")
      info["时长"] = fd(v.duration || 0)
      const q = v.getVideoPlaybackQuality?.()
      if (q) {
        info["总帧数"] = String(q.totalVideoFrames || "--")
        info["丢帧"] = String(q.droppedVideoFrames || "--")
      }
    }
    if (itemId) {
      try {
        const r = await window.api.jellyfin.getItemDetails(itemId)
        if (r.success) {
          const d = r.data; const ms = d.MediaSources?.[0]
          if (ms) {
            if (ms.Container) info["封装格式"] = ms.Container
            if (ms.Bitrate) info["码率"] = (ms.Bitrate/1e6).toFixed(1) + " Mbps"
            if (ms.Size) info["文件大小"] = fb(ms.Size)
            const vs = ms.MediaStreams?.find(s => s.Type==="Video")
            if (vs) {
              info["视频编码"] = vs.DisplayTitle || vs.Codec || "--"
              if (vs.RealFrameRate) info["帧率"] = vs.RealFrameRate.toFixed(2) + " fps"
              if (vs.BitRate) info["视频码率"] = (vs.BitRate/1e6).toFixed(1) + " Mbps"
              if (vs.BitDepth) info["色深"] = vs.BitDepth + " bit"
              if (vs.PixelFormat) info["像素格式"] = vs.PixelFormat
              if (vs.VideoRange==="HDR"||vs.HDRType) info["HDR"] = vs.HDRType||"HDR"
            }
            const ast = ms.MediaStreams?.filter(s => s.Type==="Audio")||[]
            ast.forEach((a,i) => {
              const p = ast.length>1?"音蹨"+(i+1):"音频"
              info[p+"编码"] = a.DisplayTitle || a.Codec || "--"
              if (a.Channels) info[p+"声道"] = a.Channels + "ch"
              if (a.SampleRate) info[p+"采样率"] = (a.SampleRate/1000).toFixed(1) + " kHz"
            })
            const subs = ms.MediaStreams?.filter(s => s.Type==="Subtitle")||[]
            if (subs.length) info["字幕"] = subs.map(s => s.DisplayTitle||s.Language||s.Codec).join(", ")
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
    if (newIndex < 0 || newIndex >= episodeList.length) return
    
    const newEp = episodeList[newIndex]
    // Jellyfin API 返回的是 Id (大写)，不是 id
    const episodeId = (newEp as any).Id || (newEp as any).id
    if (!episodeId) return
    
    // 构建新的 URL
    const newParams = new URLSearchParams(searchParams)
    newParams.set('itemId', episodeId)
    if (newEp.Name) newParams.set('name', newEp.Name)
    
    // 跳转到新集
    navigate({ search: newParams.toString() }, { replace: true })
    
    // 重置状态
    setCurrentEpisodeIndex(newIndex)
    setCurrentTime(0)
    setPlaying(false)
    setError('')
    setLoading(true)
  }

  const handleKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return

    const isMpvMode = useMpv && mpvReady

    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); if (isMpvMode) { const pos = Math.max(0, currentTime - (e.ctrlKey ? 30 : 5)); window.api.mpv.seek(pos); showStatus(e.ctrlKey ? '后退 30s' : '后退 5s') } else { const video = videoRef.current; if (video) { video.currentTime = Math.max(0, video.currentTime - (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '后退 30s' : '后退 5s') } }; break
      case 'ArrowRight': e.preventDefault(); if (isMpvMode) { const pos = Math.min(duration, currentTime + (e.ctrlKey ? 30 : 5)); window.api.mpv.seek(pos); showStatus(e.ctrlKey ? '前进 30s' : '前进 5s') } else { const video = videoRef.current; if (video) { video.currentTime = Math.min(video.duration, video.currentTime + (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '前进 30s' : '前进 5s') } }; break
      case ' ': e.preventDefault(); handlePlayPause(); break
      case 'ArrowUp': e.preventDefault(); if (isMpvMode) { const vol = Math.min(150, volume + 10); window.api.mpv.setVolume(vol); setVolume(vol) } else { const video = videoRef.current; if (video) { video.volume = Math.min(1, video.volume + 0.1); setVolume(Math.round(video.volume * 100)) } }; break
      case 'ArrowDown': e.preventDefault(); if (isMpvMode) { const vol = Math.max(0, volume - 10); window.api.mpv.setVolume(vol); setVolume(vol) } else { const video = videoRef.current; if (video) { video.volume = Math.max(0, video.volume - 0.1); setVolume(Math.round(video.volume * 100)) } }; break
      case 'f': case 'F': e.preventDefault(); handleFullscreen(); break
      case 'm': case 'M': e.preventDefault(); { const video = videoRef.current; if (isMpvMode) { const newVol = volume > 0 ? 0 : (parseInt(localStorage.getItem('prevVolume') || '50') || 50); if (volume > 0) localStorage.setItem('prevVolume', String(volume)); window.api.mpv.setVolume(newVol); setVolume(newVol); showStatus(newVol === 0 ? '已静音' : `音量 ${newVol}`) } else if (video) { if (video.volume > 0) { localStorage.setItem('prevVolume', String(Math.round(video.volume * 100))); video.volume = 0; setVolume(0); showStatus('已静音') } else { const prev = parseInt(localStorage.getItem('prevVolume') || '50') || 50; video.volume = prev / 100; setVolume(prev); showStatus(`音量 ${prev}`) } } }; break
      case '[': e.preventDefault(); { const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]; const idx = speeds.indexOf(playbackRate); const newRate = idx > 0 ? speeds[idx - 1] : 0.25; handlePlaybackRateChange(newRate) }; break
      case ']': e.preventDefault(); { const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]; const idx = speeds.indexOf(playbackRate); const newRate = idx < speeds.length - 1 ? speeds[idx + 1] : 2; handlePlaybackRateChange(newRate) }; break
      case '\\': e.preventDefault(); handlePlaybackRateChange(1); showStatus('正常速度 1x'); break
      case '?': e.preventDefault(); setShowShortcutsHelp(prev => !prev); break
      case 'Escape': e.preventDefault(); if (showShortcutsHelp) { setShowShortcutsHelp(false) } else if (infoOverlay) handleCloseInfo(); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); break
      // P2: 截图
      case 's': case 'S': e.preventDefault(); handleScreenshot(); break
      // P2: 窗口置顶
      case 'p': case 'P': e.preventDefault(); { const result = await window.api.window.alwaysOnTop(); if (result.success) { setAlwaysOnTop(!!result.data); showStatus(result.data ? '窗口置顶' : '取消置顶') } }; break
      // P2: 画中画 (PiP)
      case 'd': case 'D': e.preventDefault(); handlePictureInPicture(); break
      // P2: AB 循环
      case 'a': case 'A': e.preventDefault(); { const t = isMpvMode ? currentTimeRef.current : (videoRef.current?.currentTime || 0); abPointARef.current = t; showStatus(`A 点: ${formatTime(t)}`) }; break
      case 'b': case 'B': e.preventDefault(); { const t = isMpvMode ? currentTimeRef.current : (videoRef.current?.currentTime || 0); if (abPointARef.current !== null) { abPointBRef.current = t; setAbLoopActive(true); showStatus(`AB 循环: ${formatTime(abPointARef.current)} → ${formatTime(t)}`) } else { showStatus('请先按 A 设置起点') } }; break
      case 'x': case 'X': e.preventDefault(); if (abLoopActive) { abPointARef.current = null; abPointBRef.current = null; setAbLoopActive(false); showStatus('AB 循环已关闭') } break
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
    <div ref={containerRef} className="h-full flex flex-col bg-black relative outline-none" onKeyDown={handleKeyDown} tabIndex={0}>

      {/* 视频区域 */}
      <div ref={videoAreaRef} className="flex-1 relative bg-black overflow-hidden" onContextMenu={handleContextMenu} onClick={handlePlayPause} onMouseMove={handleMouseMove}>
        {/* 顶部信息栏 */}
        <div className={`absolute top-0 left-0 right-0 z-30 transition-all duration-500 ${controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'}`}>
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

        {/* 缩略图预览：隐藏的离屏视频（canvas 在 portal 中渲染） */}
        {/* 注意：不能用 className="hidden"（display:none 会导致 Chromium 不解码帧） */}
        {/* 使用 overflow:hidden 容器确保视频有真实尺寸，Chromium 才会解码帧 */}
        <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          <video ref={thumbVideoRef} muted playsInline preload="auto" style={{ width: 320, height: 180 }} />
        </div>

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

        {/* 状态提示 */}
        {statusMsg && !speedToast && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
            <div className="player-glass-toast px-4 py-2 rounded-lg">
              <span className="text-[15px] font-medium text-white/90">{statusMsg}</span>
            </div>
          </div>
        )}

        {/* P2: 自动连播倒计时 */}
        {autoplayCountdown !== null && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="text-center">
              <div className="text-white/80 text-lg mb-4">{episodeList[currentEpisodeIndex + 1]?.Name || `下一集`}</div>
              <div className="text-5xl font-bold text-[#8b82f6] mb-4 animate-pulse">{autoplayCountdown}</div>
              <div className="text-white/50 text-sm mb-6">秒后自动播放</div>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => {
                    if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
                    setAutoplayCountdown(null)
                    handleSwitchEpisode(currentEpisodeIndex + 1)
                  }}
                  className="px-6 py-2 bg-[#8b82f6] hover:bg-[#7a72e5] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  立即播放
                </button>
                <button
                  onClick={() => {
                    if (autoplayTimerRef.current) clearInterval(autoplayTimerRef.current)
                    setAutoplayCountdown(null)
                  }}
                  className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white/80 rounded-lg text-sm transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* P2: 窗口置顶指示 */}
        {alwaysOnTop && (
          <div className="absolute top-4 left-4 z-30 pointer-events-none">
            <div className="player-glass-badge px-2 py-1 rounded text-[10px] text-[#8b82f6] flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              置顶
            </div>
          </div>
        )}

        {/* P2: AB 循环指示 */}
        {abLoopActive && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
            <div className="player-glass-badge px-3 py-1 rounded text-[11px] text-[#8b82f6] flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
              AB: {formatTime(abPointARef.current || 0)} → {formatTime(abPointBRef.current || 0)}
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

        {/* 快捷键帮助 */}
        {showShortcutsHelp && (
          <div className="absolute inset-0 z-40 flex items-center justify-center" onClick={() => setShowShortcutsHelp(false)}>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <div className="relative bg-[#1a1a2e]/95 backdrop-blur-xl rounded-2xl border border-white/10 p-6 w-[420px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-[16px] font-semibold text-white">键盘快捷键</h3>
                <button onClick={() => setShowShortcutsHelp(false)} className="w-7 h-7 rounded-full hover:bg-white/10 flex items-center justify-center text-white/50 hover:text-white">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <div className="space-y-3">
                {[
                  { keys: ['Space'], desc: '播放 / 暂停' },
                  { keys: ['←'], desc: '后退 5 秒' },
                  { keys: ['Ctrl', '←'], desc: '后退 30 秒' },
                  { keys: ['→'], desc: '前进 5 秒' },
                  { keys: ['Ctrl', '→'], desc: '前进 30 秒' },
                  { keys: ['↑'], desc: '音量 +10' },
                  { keys: ['↓'], desc: '音量 -10' },
                  { keys: ['F'], desc: '全屏切换' },
                  { keys: ['M'], desc: '静音切换' },
                  { keys: ['['], desc: '减速 (0.25x)' },
                  { keys: [']'], desc: '加速 (0.25x)' },
                  { keys: ['\\'], desc: '恢复正常速度' },
                  { keys: ['S'], desc: '截图保存' },
                  { keys: ['P'], desc: '窗口置顶' },
                  { keys: ['D'], desc: '画中画' },
                  { keys: ['A'], desc: '设置 AB 循环起点' },
                  { keys: ['B'], desc: '设置 AB 循环终点' },
                  { keys: ['X'], desc: '关闭 AB 循环' },
                  { keys: ['?'], desc: '显示此帮助' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-[13px] text-white/60">{item.desc}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((k, j) => (
                        <span key={j}>
                          {j > 0 && <span className="text-white/20 text-[11px] mx-0.5">+</span>}
                          <kbd className="inline-block px-2 py-0.5 rounded-md bg-white/10 border border-white/15 text-[11px] text-white/80 font-mono min-w-[28px] text-center">{k}</kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 弹幕搜索面板 */}
      {searchOpen && (
        <div style={{ position: 'fixed', bottom: '80px', right: '20px' }} className="w-72 player-glass-panel z-50 p-4">
          <div className="flex gap-2 mb-3">
            <input type="text" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleDanmakuSearch() }} placeholder="搜索弹幕" className="flex-1 bg-white/5 border border-white/5 rounded-md px-3 py-2 text-xs text-white/90 placeholder-white/25 focus:outline-none focus:border-[#8b82f6]/40 focus:bg-white/8" autoFocus />
            <button onClick={handleDanmakuSearch} disabled={searchLoading} className="px-3 py-2 bg-[#8b82f6] hover:bg-[#7a72e5] rounded-md text-xs font-medium text-white disabled:opacity-40 transition-colors">{searchLoading ? '...' : '搜索'}</button>
          </div>
          {searchResults.length > 0 && (
            <div className="max-h-60 overflow-y-auto space-y-0.5">
              {searchResults.map((ep, i) => (
                <button key={`${ep.episodeId}-${i}`} onClick={() => handleDanmakuSelect(ep)} className="w-full text-left px-3 py-2 rounded hover:bg-white/5 transition-colors">
                  <div className="text-xs text-white truncate">{ep.animeTitle}</div>
                  <div className="text-[10px] text-white/35 mt-0.5">{ep.episodeTitle} &middot; {ep.typeDescription}</div>
                </button>
              ))}
            </div>
          )}
          {localFile && (
            <button onClick={handleLoadLocalXml} className="mt-2 w-full text-[10px] text-white/30 hover:text-[#8b82f6] py-2 border-t border-white/5 transition-colors">加载本地 XML 弹幕</button>
          )}
          <button onClick={() => { setSearchOpen(false); setSearchResults([]) }} className="mt-2 w-full text-[10px] text-white/25 hover:text-white/70 py-1 transition-colors">关闭</button>
        </div>
      )}

      {/* 弹幕设置面板 */}
      {settingsOpen && (
        <div style={{ position: 'fixed', bottom: '80px', right: '20px' }} className="w-60 player-glass-panel z-50 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-medium">弹幕设置</h3>
            <button onClick={() => setSettingsOpen(false)} className="text-white/30 hover:text-white/80 transition-colors text-sm">&times;</button>
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
            {hasMultipleTracks && (
              <>
                <hr className="border-white/5 my-0.5" />
                <div className="px-3 py-1 text-[10px] text-white/35">音频轨道</div>
                {audioTracks.map(t => (
                  <button key={`a${t.id}`} onClick={() => handleSelectAudioTrack(t.id)} className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${t.selected ? 'text-[#8b82f6]' : 'text-white/60 hover:bg-white/5'}`}>
                    {t.lang || t.title || `轨道 ${t.id + 1}`}{t.selected ? ' ✓' : ''}
                  </button>
                ))}
                <div className="px-3 py-1 text-[10px] text-white/35">字幕轨道</div>
                <button onClick={handleDisableSubtitle} className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${subtitleTracks.every(t => !t.selected) ? 'text-[#8b82f6]' : 'text-white/60 hover:bg-white/5'}`}>
                  关闭字幕{subtitleTracks.every(t => !t.selected) ? ' ✓' : ''}
                </button>
                {subtitleTracks.map(t => (
                  <button key={`s${t.id}`} onClick={() => handleSelectSubtitle(t.id)} className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${t.selected ? 'text-[#8b82f6]' : 'text-white/60 hover:bg-white/5'}`}>
                    {t.lang || t.title || `字幕 ${t.id + 1}`}{t.selected ? ' ✓' : ''}
                  </button>
                ))}
              </>
            )}
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
              <div className="space-y-4 text-xs">
                <div className="flex justify-between"><span className="text-white/35">片名</span><span className="text-white/80">{String(itemInfo.Name || '-')}</span></div>
                {itemInfo.OriginalTitle && <div className="flex justify-between"><span className="text-white/35">原名</span><span className="text-white/50">{String(itemInfo.OriginalTitle)}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">年份</span><span className="text-white/50">{itemInfo.ProductionYear || '-'}</span></div>
                {itemInfo.Genres && (itemInfo.Genres as string[]).length > 0 && <div className="flex justify-between"><span className="text-white/35">类型</span><span className="text-white/50">{(itemInfo.Genres as string[]).join(' / ')}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">时长</span><span className="text-white/50">{itemInfo.RunTimeTicks ? formatTime((Number(itemInfo.RunTimeTicks) / 10000000)) : '-'}</span></div>
                {itemInfo.CommunityRating && <div className="flex justify-between"><span className="text-white/35">评分</span><span className="text-[#8b82f6] font-medium">{String(itemInfo.CommunityRating)}</span></div>}
                {itemInfo.Overview && <div><div className="text-white/35 mb-2">简介</div><p className="text-white/50 leading-relaxed">{String(itemInfo.Overview)}</p></div>}
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
      {/* 控制栏 — 64px 纯黑 95% 不透明 */}
      <div className={`player-glass-bar h-16 flex items-center px-5 gap-6 shrink-0 relative z-20 transition-all duration-500 ${controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3 pointer-events-none'}`} onMouseMove={handleMouseMove}>
        {/* 播放/暂停 */}
        <button onClick={handlePlayPause} className="glass-btn-sm text-white/80 hover:text-white" title={playing ? '暂停' : '播放'}>
          {playing ? (
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
        <div className="flex-1 h-6 flex items-center cursor-pointer group relative" onClick={handleSeek} onMouseMove={handleProgressMouseMove} onMouseLeave={handleProgressMouseLeave}>
          <div className="absolute left-0 right-0 h-[2px] bg-white/5 rounded-full group-hover:h-[4px] transition-all">
            <div className="h-full bg-white/10 rounded-full" style={{ width: `${bufferedPercent}%` }} />
            <div className="h-full bg-[#8b82f6] rounded-full absolute top-0 left-0" style={{ width: `${progressPercent}%` }} />
            {/* P2: AB 循环区间标记 */}
            {abPointARef.current !== null && duration > 0 && (
              <div
                className="absolute top-0 h-full bg-[#8b82f6]/30"
                style={{
                  left: `${(abPointARef.current / duration) * 100}%`,
                  width: abPointBRef.current !== null
                    ? `${((abPointBRef.current - abPointARef.current) / duration) * 100}%`
                    : `${100 - (abPointARef.current / duration) * 100}%`
                }}
              />
            )}
            {abPointARef.current !== null && duration > 0 && (
              <div className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-[#8b82f6] rounded" style={{ left: `${(abPointARef.current / duration) * 100}%` }} />
            )}
            {abPointBRef.current !== null && duration > 0 && (
              <div className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-[#8b82f6] rounded" style={{ left: `${(abPointBRef.current / duration) * 100}%` }} />
            )}
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
            onClick={() => { setSpeedPopup(!speedPopup); setVolumePopup(false) }}
            className={`glass-btn-sm text-xs font-medium ${playbackRate !== 1 ? 'text-[#8b82f6]' : 'text-white/60 hover:text-white/80'}`}
            title="播放速度"
          >
            <span className="flex items-center gap-1"><Gauge size={13} />{playbackRate}x</span>
          </button>
        </div>

        {/* 音量 */}
        <div className="volume-popup">
          <button
            onClick={() => { setVolumePopup(!volumePopup); setSpeedPopup(false) }}
            className="glass-btn-icon text-white/50 hover:text-white/80"
            title="音量"
          >
            {volume === 0 ? <VolumeX size={17} /> : volume < 50 ? <Volume1 size={17} /> : <Volume2 size={17} />}
          </button>
        </div>

        {/* 弹幕按钮 */}
        <button onClick={handleDanmakuToggle} className={`glass-btn-sm text-xs ${danmakuEnabled ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/70'}`} title="弹幕">
          弹
        </button>
        <button onClick={handleOpenDanmakuSearch} className="glass-btn-icon text-white/50 hover:text-white/80" title="搜索弹幕">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button onClick={() => setSettingsOpen((v) => !v)} className="glass-btn-icon text-white/50 hover:text-white/80" title="弹幕设置">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>

        {/* P2: 截图 */}
        <button
          onClick={handleScreenshot}
          className="glass-btn-icon text-white/50 hover:text-white/80"
          title="截图 (S)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>

        {/* P2: 窗口置顶 */}
        <button
          onClick={async () => {
            const result = await window.api.window.alwaysOnTop()
            if (result.success) {
              setAlwaysOnTop(!!result.data)
              showStatus(result.data ? '窗口置顶' : '取消置顶')
            }
          }}
          className={`glass-btn-icon ${alwaysOnTop ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`}
          title="窗口置顶 (P)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={alwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a2 2 0 00-2-2H9a2 2 0 00-2 2v1a1 1 0 001 1 1 1 0 011 1z"/></svg>
        </button>

        {/* P2: 画中画 (PiP) */}
        <button
          onClick={handlePictureInPicture}
          className={`glass-btn-icon ${pipActive ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`}
          title="画中画 (D)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={pipActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="11" y="9" width="9" height="7" rx="1" fill={pipActive ? 'currentColor' : 'none'} opacity="0.7"/></svg>
        </button>

        {/* 全屏 */}
        <button onClick={handleFullscreen} className="glass-btn-icon text-white/50 hover:text-white/80" title="全屏">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>

        {/* 轨道选择按钮 */}
        {hasMultipleTracks && (
          <div className="relative">
            <button onClick={() => { setShowTrackMenu(!showTrackMenu); setContextMenu({ x: 0, y: 0, visible: false }) }} className="glass-btn-icon text-white/50 hover:text-white/80" title="音轨/字幕">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="12" y2="16"/></svg>
            </button>
          </div>
        )}
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
                  setVolume(v)
                  if (useMpv && mpvReady) {
                    window.api.mpv.setVolume(v)
                  } else {
                    const video = videoRef.current
                    if (video) { video.volume = v / 100; video.muted = v === 0 }
                  }
                }}
                className="flex-1 h-1 appearance-none bg-white/8 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => {
                  if (useMpv && mpvReady) {
                    const muted = volume === 0
                    if (muted) { window.api.mpv.setVolume(100); setVolume(100) }
                    else { window.api.mpv.setVolume(0); setVolume(0) }
                  } else {
                    const video = videoRef.current; if (!video) return
                    const muted = !video.muted; video.muted = muted; setVolume(muted ? 0 : Math.round(video.volume * 100))
                  }
                }}
                className="text-[10px] text-white/40 hover:text-white/80 transition-colors"
              >
                {volume === 0 ? '取消静音' : '静音'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 轨道选择弹窗 */}
      <AnimatePresence>
        {showTrackMenu && (audioTracks.length > 0 || subtitleTracks.length > 0) && (
          <motion.div
            className="fixed bottom-20 right-4 player-glass-panel rounded-lg p-3 z-50 w-64"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex gap-2">
                <button
                  onClick={() => setTrackMenuTab('audio')}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${trackMenuTab === 'audio' ? 'text-[#8b82f6] bg-white/5' : 'text-white/40 hover:text-white/60'}`}
                >音频 ({audioTracks.length})</button>
                <button
                  onClick={() => setTrackMenuTab('subtitle')}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${trackMenuTab === 'subtitle' ? 'text-[#8b82f6] bg-white/5' : 'text-white/40 hover:text-white/60'}`}
                >字幕 ({subtitleTracks.length})</button>
              </div>
              <button onClick={() => setShowTrackMenu(false)} className="text-white/30 hover:text-white/80 transition-colors text-xs">&times;</button>
            </div>

            {trackMenuTab === 'audio' && (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {audioTracks.map(t => (
                  <button
                    key={`a${t.id}`}
                    onClick={() => handleSelectAudioTrack(t.id)}
                    className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors ${t.selected ? 'text-[#8b82f6] bg-white/5' : 'text-white/60 hover:bg-white/5'}`}
                  >
                    <span className="truncate block">{t.lang || t.title || `轨道 ${t.id + 1}`}</span>
                    {t.codec && <span className="text-[9px] text-white/25">{t.codec}{t['demux-w'] > 0 ? ` ${t['demux-w']}x${t['demux-h']}` : ''}</span>}
                    {t.selected && <span className="float-right text-[#8b82f6]">✓</span>}
                  </button>
                ))}
              </div>
            )}

            {trackMenuTab === 'subtitle' && (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                <button
                  onClick={handleDisableSubtitle}
                  className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors ${subtitleTracks.every(t => !t.selected) ? 'text-[#8b82f6] bg-white/5' : 'text-white/60 hover:bg-white/5'}`}
                >
                  关闭字幕
                  {subtitleTracks.every(t => !t.selected) && <span className="float-right text-[#8b82f6]">✓</span>}
                </button>
                {subtitleTracks.map(t => (
                  <button
                    key={`s${t.id}`}
                    onClick={() => handleSelectSubtitle(t.id)}
                    className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors ${t.selected ? 'text-[#8b82f6] bg-white/5' : 'text-white/60 hover:bg-white/5'}`}
                  >
                    <span className="truncate block">{t.lang || t.title || `字幕 ${t.id + 1}`}</span>
                    {t.codec && <span className="text-[9px] text-white/25">{t.codec}</span>}
                    {t.selected && <span className="float-right text-[#8b82f6]">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 缩略图预览浮层 — createPortal 到 document.body + ref 直接操作 DOM */}
      {thumbVisible && duration > 0 && createPortal(
        <div
          ref={thumbTooltipRef}
          className="fixed z-[100] pointer-events-none"
          style={{ left: 0, top: 0, transform: 'translateX(-50%)', display: thumbVisible ? 'block' : 'none' }}
        >
          <div className="bg-black/90 rounded-lg border border-white/20 shadow-2xl overflow-hidden">
            <canvas ref={thumbCanvasRef} className="w-[160px] block" />
            <div className="thumb-time text-center text-[11px] text-white/80 py-1 font-mono">{formatTime(0)}</div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default Player
