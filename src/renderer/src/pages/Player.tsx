import { useRef, useState, useEffect, useCallback, type ReactElement } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Settings,
  MessageSquare, Search, Loader2, ArrowLeft, Info,
  ChevronRight, X as XIcon
} from 'lucide-react'

// ==================== 弹幕类型 ====================

interface DanmakuComment {
  time: number
  mode: number
  color: number
  text: string
}

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

interface DanmakuSearchResult {
  animeId: number
  animeTitle: string
  episodeId: number
  episodeTitle: string
  type: string
  typeDescription: string
}

interface DanmakuSearchResponse {
  hasMore: boolean
  animes: Array<{ animeId: number; animeTitle: string; episodes: DanmakuSearchResult[] }>
}

// ==================== 弹幕引擎 ====================

const DANMAKU_TRACK_COUNT = 12
const DANMAKU_TRACK_HEIGHT = 32
const DANMAKU_FIXED_DURATION = 4

function decToRgb(dec: number): string {
  const r = (dec >> 16) & 0xff
  const g = (dec >> 8) & 0xff
  const b = dec & 0xff
  return `rgb(${r},${g},${b})`
}

class DanmakuEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private comments: DanmakuComment[] = []
  private active: ActiveComment[] = []
  private trackOccupied: Float64Array = new Float64Array(DANMAKU_TRACK_COUNT)
  private lastTime = 0
  private enabled = true
  private opacity = 1.0
  private fontSize = 24
  private speed = 120
  private displayArea: 'full' | 'top' | 'bottom' = 'full'
  // 预分配 font 字符串，避免每帧拼接
  private fontStr = `bold 24px "Microsoft YaHei", sans-serif`

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
  }

  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    this.canvas.width = parent.clientWidth
    this.canvas.height = parent.clientHeight
  }

  loadComments(comments: DanmakuComment[]): void {
    this.comments = comments.sort((a, b) => a.time - b.time)
  }

  clear(): void {
    this.comments = []
    this.active.length = 0
    this.trackOccupied.fill(0)
  }

  setOpacity(opacity: number): void { this.opacity = Math.max(0, Math.min(1, opacity)) }
  setFontSize(size: number): void {
    this.fontSize = Math.max(12, Math.min(48, size))
    this.fontStr = `bold ${this.fontSize}px "Microsoft YaHei", sans-serif`
  }
  setSpeed(speed: number): void { this.speed = Math.max(60, Math.min(300, speed)) }
  setDisplayArea(area: 'full' | 'top' | 'bottom'): void { this.displayArea = area }

  private getTrackForScroll(): number {
    let best = 0
    let bestRight = Infinity
    for (let i = 0; i < DANMAKU_TRACK_COUNT; i++) {
      if (this.trackOccupied[i] < bestRight) { bestRight = this.trackOccupied[i]; best = i }
    }
    return best
  }

  private addComment(c: DanmakuComment, now: number): void {
    const colorStr = decToRgb(c.color)
    this.ctx.font = this.fontStr
    const textWidth = this.ctx.measureText(c.text).width

    if (c.mode === 1) {
      const track = this.getTrackForScroll()
      const y = track * DANMAKU_TRACK_HEIGHT + DANMAKU_TRACK_HEIGHT * 0.8
      this.trackOccupied[track] = this.canvas.width + textWidth
      this.active.push({ text: c.text, x: this.canvas.width + 10, y, color: colorStr, speed: this.speed, width: textWidth, mode: 1, bornAt: now, duration: 0 })
    } else {
      const isTop = c.mode === 5
      const track = isTop ? 0 : DANMAKU_TRACK_COUNT - 1
      const y = track * DANMAKU_TRACK_HEIGHT + DANMAKU_TRACK_HEIGHT * 0.8
      this.active.push({ text: c.text, x: (this.canvas.width - textWidth) / 2, y, color: colorStr, speed: 0, width: textWidth, mode: c.mode, bornAt: now, duration: DANMAKU_FIXED_DURATION })
    }
  }

  update(videoTime: number): void {
    if (this.comments.length === 0 || !this.enabled) return

    while (this.comments.length > 0 && this.comments[0].time <= videoTime) {
      const c = this.comments.shift()!
      this.addComment(c, videoTime)
    }

    const now = performance.now()
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 0.016
    this.lastTime = now

    // 原地过滤，避免每帧创建新数组
    let writeIdx = 0
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i]
      if (a.mode === 1) {
        a.x -= a.speed * dt
        if (a.x > -a.width - 20) {
          this.active[writeIdx++] = a
        }
      } else {
        if (videoTime - a.bornAt < a.duration) {
          this.active[writeIdx++] = a
        }
      }
    }
    this.active.length = writeIdx

    // 重置轨道占用（Float64Array.fill 比 new Array 快）
    this.trackOccupied.fill(0)
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i]
      if (a.mode === 1) {
        const track = (a.y / DANMAKU_TRACK_HEIGHT) | 0
        if (track >= 0 && track < DANMAKU_TRACK_COUNT) {
          if (a.x + a.width > this.trackOccupied[track]) {
            this.trackOccupied[track] = a.x + a.width
          }
        }
      }
    }
  }

  draw(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!this.enabled) return
    this.ctx.globalAlpha = this.opacity
    this.ctx.font = this.fontStr
    this.ctx.textBaseline = 'middle'
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i]
      if (this.displayArea === 'top' && a.y > this.canvas.height * 0.3) continue
      if (this.displayArea === 'bottom' && a.y < this.canvas.height * 0.7) continue
      this.ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      this.ctx.lineWidth = 3
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

function Player(): ReactElement {
  const [searchParams] = useSearchParams()
  const itemId = searchParams.get('itemId') || ''
  const itemName = searchParams.get('name') || '未知视频'
  const localFile = searchParams.get('file') || ''
  const baseUrl = searchParams.get('base') || 'http://localhost:8096'
  const seriesName = searchParams.get('seriesName') || ''

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<DanmakuEngine | null>(null)
  const resumePosRef = useRef(parseFloat(searchParams.get('position') || '0'))
  const hasResumedRef = useRef(false)

  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(100)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  const [danmakuLoading, setDanmakuLoading] = useState(false)
  const [danmakuCount, setDanmakuCount] = useState(0)
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
  const [danmakuArea, setDanmakuArea] = useState<'full' | 'top' | 'bottom'>('full')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [speedToast, setSpeedToast] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
  const [infoOverlay, setInfoOverlay] = useState(false)
  const [itemInfo, setItemInfo] = useState<Record<string, unknown> | null>(null)
  const [itemInfoLoading, setItemInfoLoading] = useState(false)
  const [videoFileInfo, setVideoFileInfo] = useState<VideoInfoResponse['data'] | null>(null)

  const showStatus = (msg: string): void => { setStatusMsg(msg); setTimeout(() => setStatusMsg(''), 2000) }

  const savePlayHistory = useCallback(async () => {
    if (!itemId && !localFile) return
    if (duration <= 0 || currentTime < 5) return
    try {
      const posterUrl = localFile ? '' : `${baseUrl}/Items/${itemId}/Images/Primary?maxHeight=300`
      const historyName = seriesName && !itemName.startsWith(seriesName) ? `${seriesName} - ${itemName}` : itemName
      await window.api.history.save({
        itemId: itemId || `local:${localFile}`, name: historyName, duration, position: currentTime, posterUrl,
        watchedAt: Date.now(), localFile: localFile || undefined, baseUrl: localFile ? undefined : baseUrl, seriesName: seriesName || undefined
      })
    } catch { /* ignore */ }
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
        const opacity = await window.api.store.get('danmakuOpacity')
        if (opacity !== null) { setDanmakuOpacity(Number(opacity)); engineRef.current?.setOpacity(Number(opacity)) }
        const fontSize = await window.api.store.get('danmakuFontSize')
        if (fontSize !== null) { setDanmakuFontSize(Number(fontSize)); engineRef.current?.setFontSize(Number(fontSize)) }
        const speed = await window.api.store.get('danmakuSpeed')
        if (speed !== null) { setDanmakuSpeed(Number(speed)); engineRef.current?.setSpeed(Number(speed)) }
        const area = await window.api.store.get('danmakuArea')
        if (area !== null) { setDanmakuArea(area as 'full' | 'top' | 'bottom'); engineRef.current?.setDisplayArea(area as 'full' | 'top' | 'bottom') }
      } catch { /* ignore */ }
    }
    loadSettings()

    const handleResize = (): void => engineRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize); engineRef.current?.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!itemName || itemName === '未知视频') return
    setDanmakuLoading(true)
    setDanmakuError('')

    if (localFile) {
      window.api.danmaku.findLocalXml(localFile).then((xmlResult) => {
        if (xmlResult.success && xmlResult.data) {
          const data = xmlResult.data as { count: number; comments: DanmakuComment[]; source?: string }
          engineRef.current?.loadComments(data.comments)
          setDanmakuCount(data.count)
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
            setDanmakuCount(data.count)
          } else { setDanmakuError(commentResult.error || '获取弹幕失败') }
        }).catch(() => setDanmakuError('获取弹幕失败')).finally(() => setDanmakuLoading(false))
      }).catch(() => { setDanmakuError('自动匹配失败'); setDanmakuLoading(false) })
    }
  }, [itemName, localFile, seriesName])

  const handleDanmakuToggle = (): void => {
    const next = !danmakuEnabled; setDanmakuEnabled(next)
    window.api.store.set('danmakuEnabled', next)
    next ? engineRef.current?.enable() : engineRef.current?.disable()
    if (next) engineRef.current?.start()
  }

  const handleOpacityChange = (value: number): void => { setDanmakuOpacity(value); engineRef.current?.setOpacity(value); window.api.store.set('danmakuOpacity', value) }
  const handleFontSizeChange = (value: number): void => { setDanmakuFontSize(value); engineRef.current?.setFontSize(value); window.api.store.set('danmakuFontSize', value) }
  const handleSpeedChange = (value: number): void => { setDanmakuSpeed(value); engineRef.current?.setSpeed(value); window.api.store.set('danmakuSpeed', value) }
  const handleAreaChange = (area: 'full' | 'top' | 'bottom'): void => { setDanmakuArea(area); engineRef.current?.setDisplayArea(area); window.api.store.set('danmakuArea', area) }

  const handleDanmakuSearch = async (keyword?: string): Promise<void> => {
    const q = (keyword ?? searchKeyword).trim()
    if (!q) return; setSearchLoading(true)
    try {
      const result = await window.api.danmaku.search(q)
      if (result.success && result.data) {
        const data = result.data as DanmakuSearchResponse
        const eps: DanmakuSearchResult[] = []
        for (const anime of (data.animes || [])) { for (const ep of (anime.episodes || [])) { eps.push({ ...ep, animeTitle: anime.animeTitle }) } }
        setSearchResults(eps)
      }
    } catch { showStatus('搜索弹幕失败') }
    setSearchLoading(false)
  }

  // 弹幕搜索防抖：输入停止 400ms 后自动搜索
  const danmakuSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!searchOpen || !searchKeyword.trim()) return
    if (danmakuSearchTimerRef.current) clearTimeout(danmakuSearchTimerRef.current)
    danmakuSearchTimerRef.current = setTimeout(() => {
      handleDanmakuSearch(searchKeyword)
    }, 400)
    return () => { if (danmakuSearchTimerRef.current) clearTimeout(danmakuSearchTimerRef.current) }
  }, [searchKeyword, searchOpen])

  const handleDanmakuSelect = async (ep: DanmakuSearchResult): Promise<void> => {
    setSearchOpen(false); setSearchResults([]); setDanmakuLoading(true); setDanmakuError('')
    try {
      const result = await window.api.danmaku.getComments(String(ep.episodeId))
      if (result.success && result.data) {
        const data = result.data as { count: number; comments: DanmakuComment[] }
        engineRef.current?.loadComments(data.comments); setDanmakuCount(data.count)
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
        engineRef.current?.loadComments(data.comments); setDanmakuCount(data.count); showStatus(`已加载本地弹幕: ${data.source || ''}`)
      } else { setDanmakuError(result.error || '未找到本地弹幕 XML') }
    } catch (err) { setDanmakuError(`本地 XML 加载失败: ${String(err)}`) }
    setDanmakuLoading(false)
  }

  // ==================== 视频源 & 事件 ====================

  useEffect(() => {
    setLoading(true); setError('')
    if (localFile) {
      const safePath = localFile.replace(/\\/g, '/')
      if (videoRef.current) { videoRef.current.src = `local-file:///${encodeURI(safePath)}`; setSrcReady(true) }
      return
    }
    if (!itemId) { setLoading(false); return }
    window.api.jellyfin.getPlaybackUrl(itemId).then((result) => {
      if (result.success) {
        const data = result.data as { url?: string }
        if (data?.url && videoRef.current) { videoRef.current.src = data.url; setSrcReady(true); return }
      }
      setError('获取播放地址失败'); setLoading(false)
    }).catch((err) => { setError(`获取播放地址失败: ${String(err)}`); setLoading(false) })
  }, [itemId, localFile])

  useEffect(() => {
    const video = videoRef.current; if (!video) return

    const onLoadedMetadata = (): void => {
      setDuration(video.duration || 0); setLoading(false)
      if (!hasResumedRef.current && resumePosRef.current > 0) { hasResumedRef.current = true; video.currentTime = resumePosRef.current }
      video.play().then(() => setPlaying(true)).catch(() => {})
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    const onEnded = (): void => setPlaying(false)
    const onTimeUpdate = (): void => {
      setCurrentTime(video.currentTime)
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1))
    }
    const onWaiting = (): void => setLoading(true)
    const onCanPlay = (): void => setLoading(false)
    const onError = (): void => {
      const errMsg = (() => {
        switch (video.error?.code) { case 1: return '视频加载中止'; case 2: return '网络错误'; case 3: return '视频解码失败'; case 4: return '视频源不可用'; default: return '视频加载失败' }
      })(); setError(errMsg); setLoading(false)
    }
    const onVolumeChange = (): void => { setVolume(Math.round(video.volume * 100)) }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('play', onPlay); video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded); video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('waiting', onWaiting); video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError); video.addEventListener('volumechange', onVolumeChange)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('play', onPlay); video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded); video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('waiting', onWaiting); video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('error', onError); video.removeEventListener('volumechange', onVolumeChange)
    }
  }, [srcReady, danmakuEnabled])

  // 弹幕渲染循环（单一 rAF，update + draw 合并）
  useEffect(() => {
    if (!danmakuEnabled || !engineRef.current) return
    let animId = 0
    const loop = (): void => {
      const video = videoRef.current
      if (video && !video.paused && engineRef.current) engineRef.current.update(video.currentTime)
      engineRef.current?.draw()
      animId = requestAnimationFrame(loop)
    }
    animId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animId)
  }, [danmakuEnabled, srcReady])

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
  }

  const handleFullscreen = (): void => {
    const container = containerRef.current; if (!container) return
    document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : container.requestFullscreen().catch(() => showStatus('全屏切换失败'))
  }

  const handlePlaybackRateChange = (rate: number): void => {
    const video = videoRef.current; if (!video) return
    video.playbackRate = rate; setPlaybackRate(rate)
    setContextMenu({ x: 0, y: 0, visible: false })
    setSpeedToast(`${rate}x`); setTimeout(() => setSpeedToast(''), 2000)
  }

  const handleContextMenu = (e: React.MouseEvent): void => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, visible: true }) }
  const handleCloseContextMenu = (): void => { setContextMenu({ x: 0, y: 0, visible: false }) }

  const handleShowInfo = async (): Promise<void> => {
    setContextMenu({ x: 0, y: 0, visible: false })
    setInfoOverlay(true)
    setItemInfoLoading(true)
    setVideoFileInfo(null)
    
    // 并行获取 Jellyfin 元数据和本地视频文件信息
    const promises: Promise<void>[] = []
    
    if (itemId) {
      promises.push(
        window.api.jellyfin.getItemDetails(itemId)
          .then(result => { if (result.success) setItemInfo(result.data as Record<string, unknown>) })
          .catch(() => {})
      )
    }
    
    if (localFile) {
      promises.push(
        window.api.video.getInfo(localFile)
          .then(result => { if (result.success && result.data) setVideoFileInfo(result.data) })
          .catch(() => {})
      )
    }
    
    await Promise.all(promises)
    setItemInfoLoading(false)
  }
  const handleCloseInfo = (): void => { setInfoOverlay(false); setItemInfo(null); setVideoFileInfo(null) }

  // ==================== 键盘 ====================

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const video = videoRef.current; if (!video) return
    const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return

    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '后退 30s' : '后退 5s'); break
      case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + (e.ctrlKey ? 30 : 5)); showStatus(e.ctrlKey ? '前进 30s' : '前进 5s'); break
      case ' ': e.preventDefault(); handlePlayPause(); break
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); setVolume(Math.round(video.volume * 100)); break
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); setVolume(Math.round(video.volume * 100)); break
      case 'f': case 'F': e.preventDefault(); handleFullscreen(); break
      case 'Escape': e.preventDefault(); if (infoOverlay) handleCloseInfo(); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); break
    }
  }

  // ==================== 渲染 ====================

  if (!itemId && !localFile) {
    return (
      <div className="h-full flex items-center justify-center bg-black">
        <div className="text-center">
          <p className="text-[15px] text-[var(--text-tertiary)] mb-6">未选择视频</p>
          <Link to="/" className="ios-btn ios-btn-primary no-underline">
            <ArrowLeft size={15} />
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
      <div className="flex-1 relative bg-black overflow-hidden group" onContextMenu={handleContextMenu} onClick={handlePlayPause}>
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" controls={false} playsInline preload="auto" />
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />

        {/* 中央播放按钮（暂停状态） */}
        <AnimatePresence>
          {!playing && !loading && !error && (
            <motion.div
              className="absolute inset-0 flex items-center justify-center z-15 pointer-events-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="w-16 h-16 rounded-full bg-black/40 backdrop-blur-xl flex items-center justify-center"
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              >
                <Play size={28} fill="white" className="text-white ml-1" />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 弹幕状态 */}
        {danmakuLoading && (
          <div className="absolute top-5 right-5 glass px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-[var(--text-secondary)] z-20 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
            匹配弹幕
          </div>
        )}
        {danmakuCount > 0 && !danmakuLoading && (
          <div className="absolute top-4 right-4 glass px-2.5 py-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--text-tertiary)] z-20">{danmakuCount} 条弹幕</div>
        )}

        {/* 倍速提示 */}
        {speedToast && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none animate-speed-toast">
            <div className="px-6 py-3 bg-[var(--accent)]/90 backdrop-blur-xl rounded-[var(--radius-lg)]">
              <span className="text-2xl font-bold text-white">{speedToast}</span>
            </div>
          </div>
        )}

        {/* 加载中 */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-10">
            <Loader2 size={28} className="text-[var(--accent)] animate-spin" />
          </div>
        )}

        {/* 错误 */}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
            <div className="text-center">
              <p className="text-[15px] text-[var(--text-tertiary)] mb-6">{error}</p>
              <Link to="/" className="text-[var(--accent)] hover:text-[var(--accent-light)] text-[13px] transition-colors inline-flex items-center gap-1 no-underline">
                <ArrowLeft size={13} /> 返回媒体库
              </Link>
            </div>
          </div>
        )}

        {/* 状态消息 */}
        {statusMsg && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none animate-speed-toast">
            <div className="px-4 py-2 bg-black/60 backdrop-blur-xl rounded-[var(--radius-md)]">
              <span className="text-[15px] text-white/80">{statusMsg}</span>
            </div>
          </div>
        )}
      </div>

      {/* 弹幕搜索面板 */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            className="absolute top-20 right-5 w-72 glass-thick rounded-[var(--radius-xl)] z-30 p-4"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <div className="flex gap-2 mb-3">
              <input type="text" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleDanmakuSearch() }} placeholder="搜索弹幕..." className="flex-1 ios-input !h-9 !text-[13px] !rounded-[var(--radius-sm)]" autoFocus />
              <motion.button onClick={handleDanmakuSearch} disabled={searchLoading} className="ios-btn ios-btn-primary !h-9 !px-3 disabled:!opacity-40" whileTap={{ scale: 0.96 }}>
                {searchLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              </motion.button>
            </div>
            {searchResults.length > 0 && (
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {searchResults.map((ep, i) => (
                  <button key={`${ep.episodeId}-${i}`} onClick={() => handleDanmakuSelect(ep)} className="w-full text-left px-3 py-2.5 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] transition-colors">
                    <div className="text-[13px] text-white truncate">{ep.animeTitle}</div>
                    <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{ep.episodeTitle} · {ep.typeDescription}</div>
                  </button>
                ))}
              </div>
            )}
            {localFile && (
              <button onClick={handleLoadLocalXml} className="mt-3 w-full text-[12px] text-[var(--accent)] hover:text-[var(--accent-light)] py-2 border-t border-[var(--separator)] transition-colors">加载本地 XML 弹幕</button>
            )}
            <button onClick={() => { setSearchOpen(false); setSearchResults([]) }} className="mt-2 w-full text-[11px] text-[var(--text-quaternary)] hover:text-[var(--text-tertiary)] py-1 transition-colors">关闭</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 弹幕设置面板 */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            className="absolute top-20 right-5 w-64 glass-thick rounded-[var(--radius-xl)] z-30 p-5"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[13px] font-semibold text-white/80">弹幕设置</h3>
              <button onClick={() => setSettingsOpen(false)} className="text-white/25 hover:text-white/60 transition-colors">
                <XIcon size={14} />
              </button>
            </div>
            <div className="space-y-5">
              <div>
                <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-2"><span>透明度</span><span className="text-white/50">{Math.round(danmakuOpacity * 100)}%</span></div>
                <input type="range" min="0" max="1" step="0.1" value={danmakuOpacity} onChange={(e) => handleOpacityChange(parseFloat(e.target.value))} className="w-full" />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-2"><span>字体大小</span><span className="text-white/50">{danmakuFontSize}px</span></div>
                <input type="range" min="12" max="48" step="1" value={danmakuFontSize} onChange={(e) => handleFontSizeChange(parseInt(e.target.value))} className="w-full" />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-2"><span>速度</span><span className="text-white/50">{danmakuSpeed}px/s</span></div>
                <input type="range" min="60" max="300" step="10" value={danmakuSpeed} onChange={(e) => handleSpeedChange(parseInt(e.target.value))} className="w-full" />
              </div>
              <div>
                <div className="text-[11px] text-[var(--text-tertiary)] mb-2">显示区域</div>
                <div className="flex gap-2">
                  {(['full', 'top', 'bottom'] as const).map((area) => (
                    <motion.button
                      key={area}
                      onClick={() => handleAreaChange(area)}
                      className={`flex-1 py-1.5 text-[11px] rounded-[var(--radius-sm)] font-medium transition-colors ${danmakuArea === area ? 'bg-[var(--accent)] text-white' : 'bg-white/5 text-white/30 hover:text-white'}`}
                      whileTap={{ scale: 0.96 }}
                    >
                      {area === 'full' ? '全屏' : area === 'top' ? '顶部' : '底部'}
                    </motion.button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <>
          <div className="fixed inset-0 z-40" onClick={handleCloseContextMenu} onContextMenu={(e) => { e.preventDefault(); handleCloseContextMenu() }} />
          <motion.div
            className="fixed z-50 w-44 glass-thick rounded-[var(--radius-lg)] py-1.5"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 190), top: Math.min(contextMenu.y, window.innerHeight - 300) }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          >
            <button onClick={handleShowInfo} className="w-full text-left px-3.5 py-2 text-[13px] text-white/70 hover:text-white hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2">
              <Info size={13} /> 影片信息
            </button>
            <div className="border-t border-white/[0.06] my-1" />
            <div className="px-3.5 py-1 text-[11px] text-[var(--text-quaternary)]">播放速度</div>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <button key={rate} onClick={() => handlePlaybackRateChange(rate)} className={`w-full text-left px-3.5 py-1.5 text-[13px] transition-colors ${playbackRate === rate ? 'text-[var(--accent)] bg-[var(--accent-bg)]' : 'text-white/50 hover:bg-[var(--bg-hover)]'}`}>
                {rate}x
              </button>
            ))}
            <div className="border-t border-white/[0.06] my-1" />
            <button onClick={() => { handleDanmakuToggle(); handleCloseContextMenu() }} className="w-full text-left px-3.5 py-2 text-[13px] text-white/70 hover:text-white hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2">
              <MessageSquare size={13} /> {danmakuEnabled ? '关闭弹幕' : '开启弹幕'}
            </button>
            <button onClick={() => { handleLoadLocalXml(); handleCloseContextMenu() }} className="w-full text-left px-3.5 py-2 text-[13px] text-white/70 hover:text-white hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2">
              <Search size={13} /> 加载本地弹幕
            </button>
          </motion.div>
        </>
      )}

      {/* 影片信息覆盖层 */}
      <AnimatePresence>
        {infoOverlay && (
          <motion.div
            className="absolute inset-0 z-30 bg-black/70 backdrop-blur-xl flex items-center justify-center"
            onClick={handleCloseInfo}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="w-[480px] max-h-[70vh] glass-thick rounded-[var(--radius-xl)] p-7 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.92, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.92, y: 20 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-[15px] font-semibold text-white/90">影片信息</h3>
                <button onClick={handleCloseInfo} className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-white/25 hover:text-white hover:bg-[var(--bg-hover)] transition-all">
                  <XIcon size={14} />
                </button>
              </div>
              {itemInfoLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={18} className="text-[var(--accent)] animate-spin" />
                </div>
              ) : (
                <div className="space-y-7 text-[13px]">
                  {/* Jellyfin 元数据 */}
                  {itemInfo && (
                    <div className="space-y-4">
                      <div className="text-[11px] text-[var(--accent)] font-medium uppercase tracking-wider mb-3">元数据</div>
                      <div className="flex justify-between py-1.5"><span className="text-white/30">片名</span><span className="text-white/90">{String(itemInfo.Name ?? '-')}</span></div>
                      {itemInfo.OriginalTitle ? <div className="flex justify-between py-1.5"><span className="text-white/30">原名</span><span className="text-white/50">{String(itemInfo.OriginalTitle)}</span></div> : null}
                      <div className="flex justify-between py-1.5"><span className="text-white/30">年份</span><span className="text-white/50">{String(itemInfo.ProductionYear ?? '-')}</span></div>
                      {itemInfo.Genres ? <div className="flex justify-between py-1.5"><span className="text-white/30">类型</span><span className="text-white/50">{(itemInfo.Genres as string[]).join(' / ')}</span></div> : null}
                      <div className="flex justify-between py-1.5"><span className="text-white/30">时长</span><span className="text-white/50">{itemInfo.RunTimeTicks ? formatTime(Number(itemInfo.RunTimeTicks) / 10000000) : '-'}</span></div>
                      {itemInfo.CommunityRating ? <div className="flex justify-between py-1.5"><span className="text-white/30">评分</span><span className="text-[var(--warning)] font-medium">{String(itemInfo.CommunityRating)}</span></div> : null}
                      {itemInfo.Overview ? <div className="pt-1"><div className="text-white/30 mb-2">简介</div><p className="text-white/50 leading-relaxed line-clamp-3">{String(itemInfo.Overview)}</p></div> : null}
                    </div>
                  )}
                  
                  {/* 视频文件技术参数 */}
                  {videoFileInfo && (
                    <div className="space-y-4">
                      {itemInfo && <div className="border-t border-white/[0.06] pt-6" />}
                      <div className="text-[11px] text-[var(--accent)] font-medium uppercase tracking-wider mb-3">文件参数</div>
                      <div className="flex justify-between py-1.5"><span className="text-white/30">格式</span><span className="text-white/70">{videoFileInfo.format}</span></div>
                      <div className="flex justify-between py-1.5"><span className="text-white/30">大小</span><span className="text-white/70">{(videoFileInfo.size / 1024 / 1024).toFixed(1)} MB</span></div>
                      {videoFileInfo.bitRate > 0 ? <div className="flex justify-between py-1.5"><span className="text-white/30">总码率</span><span className="text-white/70">{(videoFileInfo.bitRate / 1000).toFixed(0)} kbps</span></div> : null}
                      
                      {/* 视频流 */}
                      {videoFileInfo.video.codec !== 'unknown' && (
                        <>
                          <div className="border-t border-white/[0.06] pt-4 mt-2">
                            <div className="text-[11px] text-[var(--text-quaternary)] mb-3">视频流</div>
                          </div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">编码</span><span className="text-white/70">{videoFileInfo.video.codec.toUpperCase()}{videoFileInfo.video.profile ? ` ${videoFileInfo.video.profile}` : ''}</span></div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">分辨率</span><span className="text-white/70">{videoFileInfo.video.width}×{videoFileInfo.video.height}</span></div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">帧率</span><span className="text-white/70">{videoFileInfo.video.frameRate}</span></div>
                          {videoFileInfo.video.bitRate > 0 ? <div className="flex justify-between py-1.5"><span className="text-white/30">视频码率</span><span className="text-white/70">{(videoFileInfo.video.bitRate / 1000).toFixed(0)} kbps</span></div> : null}
                        </>
                      )}
                      
                      {/* 音频流 */}
                      {videoFileInfo.audio.codec !== 'unknown' && (
                        <>
                          <div className="border-t border-white/[0.06] pt-4 mt-2">
                            <div className="text-[11px] text-[var(--text-quaternary)] mb-3">音频流</div>
                          </div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">编码</span><span className="text-white/70">{videoFileInfo.audio.codec.toUpperCase()}</span></div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">声道</span><span className="text-white/70">{videoFileInfo.audio.channelLayout || `${videoFileInfo.audio.channels}ch`}</span></div>
                          <div className="flex justify-between py-1.5"><span className="text-white/30">采样率</span><span className="text-white/70">{(videoFileInfo.audio.sampleRate / 1000).toFixed(1)} kHz</span></div>
                          {videoFileInfo.audio.bitRate > 0 ? <div className="flex justify-between py-1.5"><span className="text-white/30">音频码率</span><span className="text-white/70">{(videoFileInfo.audio.bitRate / 1000).toFixed(0)} kbps</span></div> : null}
                        </>
                      )}
                    </div>
                  )}
                  
                  {!itemInfo && !videoFileInfo && (
                    <p className="text-[13px] text-white/20 text-center py-10">无法获取影片信息</p>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 控制栏 — iOS 风格 */}
      <div className="h-14 bg-black/80 backdrop-blur-xl flex items-center px-6 gap-5 shrink-0 relative z-20 animate-control-up">
        {/* 播放/暂停 */}
        <motion.button
          onClick={handlePlayPause}
          className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center text-white hover:bg-white/10 transition-colors"
          title={playing ? '暂停' : '播放'}
          whileTap={{ scale: 0.9 }}
        >
          {playing ? <Pause size={18} /> : <Play size={18} fill="white" className="ml-0.5" />}
        </motion.button>

        {/* 进度条 */}
        <div className="flex-1 progress-bar group relative" onClick={handleSeek}>
          <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-full rounded-full">
            <div className="h-full bg-white/10 rounded-full" style={{ width: `${bufferedPercent}%` }} />
            <div className="h-full bg-[var(--accent)] rounded-full absolute top-0 left-0" style={{ width: `${progressPercent}%` }} />
            <div className="progress-thumb" style={{ left: `${progressPercent}%` }} />
          </div>
        </div>

        {/* 时间 */}
        <span className="text-[12px] text-white/40 font-mono tabular-nums w-[88px] text-right whitespace-nowrap select-none">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* 倍速 */}
        <button
          onClick={() => {
            const rates = [0.5, 0.75, 1, 1.25, 1.5, 2]
            const idx = rates.indexOf(playbackRate)
            handlePlaybackRateChange(rates[(idx + 1) % rates.length])
          }}
          className={`text-[12px] font-medium transition-colors px-2 py-1 rounded-[var(--radius-sm)] hover:bg-white/10 ${playbackRate !== 1 ? 'text-[var(--accent)]' : 'text-white/40 hover:text-white/60'}`}
          title="切换倍速"
        >
          {playbackRate}x
        </button>

        {/* 音量 */}
        <motion.button
          onClick={() => {
            const video = videoRef.current; if (!video) return
            const muted = !video.muted; video.muted = muted; setVolume(muted ? 0 : Math.round(video.volume * 100))
          }}
          className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors"
          title="静音"
          whileTap={{ scale: 0.9 }}
        >
          {volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </motion.button>

        {/* 弹幕按钮 */}
        <motion.button
          onClick={handleDanmakuToggle}
          className={`w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors ${danmakuEnabled ? 'text-[var(--accent)] bg-[var(--accent-bg)]' : 'text-white/40 hover:text-white/60 hover:bg-white/10'}`}
          title={danmakuEnabled ? '关闭弹幕' : '开启弹幕'}
          whileTap={{ scale: 0.9 }}
        >
          <MessageSquare size={16} />
        </motion.button>

        {/* 弹幕搜索 */}
        <motion.button
          onClick={() => { setSearchOpen(!searchOpen); setSettingsOpen(false) }}
          className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
          title="搜索弹幕"
          whileTap={{ scale: 0.9 }}
        >
          <Search size={15} />
        </motion.button>

        {/* 弹幕设置 */}
        <motion.button
          onClick={() => { setSettingsOpen(!settingsOpen); setSearchOpen(false) }}
          className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
          title="弹幕设置"
          whileTap={{ scale: 0.9 }}
        >
          <Settings size={15} />
        </motion.button>

        {/* 全屏 */}
        <motion.button
          onClick={handleFullscreen}
          className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors"
          title="全屏"
          whileTap={{ scale: 0.9 }}
        >
          <Maximize size={16} />
        </motion.button>
      </div>
    </div>
  )
}

export default Player
