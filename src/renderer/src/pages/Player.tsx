import { useRef, useState, useEffect, useCallback } from 'react'
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem } from '../../shared/types'
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
    const sorted = comments.sort((a, b) => a.time - b.time)
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

  const [speedToast, setSpeedToast] = useState('')
  const [volumePopup, setVolumePopup] = useState(false)
  const [speedPopup, setSpeedPopup] = useState(false)

  // P2: 窗口置顶
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  // P2: 画中画 (PiP)
  const [pipActive, setPipActive] = useState(false)

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

  useEffect(() => {
    // 只要有 localFile 或 seriesName 就尝试加载弹幕，itemName 可以是未知视频
    if (!localFile && !seriesName && (!itemName || itemName === '未知视频')) return
    engineRef.current?.clear()
    setCurrentDanmakuCount(0)
    setDanmakuLoading(true)
    setDanmakuError('')

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

  useEffect(() => {
    setLoading(true); setError('')
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
        setError('无法读取本地文件'); setLoading(false)
      }).catch(() => { setError('无法读取本地文件'); setLoading(false) })
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
      const ct = video.currentTime
      currentTimeRef.current = ct
      // 每 250ms 更新一次 React state，减少重渲染
      if (Math.abs(ct - currentTime) > 0.5) setCurrentTime(ct)
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1))
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
  }, [srcReady, danmakuEnabled])

  useEffect(() => {
    if (!danmakuEnabled || !engineRef.current) return
    let animId = 0
    const loop = (): void => {
      const video = videoRef.current
      if (video && !video.paused && engineRef.current) engineRef.current.update(video.currentTime)
      engineRef.current?.draw(); animId = requestAnimationFrame(loop)
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
    console.log('[EpisodeSwitch] handleSwitchEpisode called with newIndex=%d, episodeList.length=%d, currentEpisodeIndex=%d', newIndex, episodeList.length, currentEpisodeIndex)
    
    if (newIndex < 0 || newIndex >= episodeList.length) {
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
    
    // 重置状态
    setCurrentEpisodeIndex(newIndex)
    setCurrentTime(0)
    setPlaying(false)
    setError('')
    setLoading(true)
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
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); setVolume(Math.round(video.volume * 100)); break
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); setVolume(Math.round(video.volume * 100)); break
      case 'f': case 'F': e.preventDefault(); handleFullscreen(); break
      case 's': case 'S': e.preventDefault(); handleScreenshot(); break
      case 'p': case 'P': e.preventDefault(); { const result = await window.api.window.alwaysOnTop(); if (result.success) { setAlwaysOnTop(!!result.data); showStatus(result.data ? '窗口置顶' : '取消置顶') } }; break
      case 'd': case 'D': e.preventDefault(); handlePictureInPicture(); break
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
    <div ref={containerRef} className="h-full flex flex-col bg-black relative outline-none" onKeyDown={handleKeyDown} tabIndex={0}>

      {/* 视频区域 */}
      <div className="flex-1 relative bg-black overflow-hidden" onContextMenu={handleContextMenu} onClick={handlePlayPause} onMouseMove={handleMouseMove}>
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
                  setVolume(v)
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
                  const muted = !video.muted; video.muted = muted; setVolume(muted ? 0 : Math.round(video.volume * 100))
                }}
                className="text-[10px] text-white/40 hover:text-white/80 transition-colors"
              >
                {volume === 0 ? '取消静音' : '静音'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default Player
