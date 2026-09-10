import { useRef, useState, useEffect, useCallback, type ReactElement } from 'react'
// 修复点 1.15: pages 目录下深一层，从 ../../ → ../../../shared/types
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem, DanmakuMatchMeta, DanmakuMatchCandidate } from '../../../shared/types'
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
} from '../player'
import MpvCanvasView from '../player/components/MpvCanvasView'

/** 播放引擎：html5=内置 <video>；mpv=打孔嵌入（旧架构）；mpv-canvas=libmpv 画布渲染（方案 C） */
type EngineMode = 'html5' | 'mpv' | 'mpv-canvas'

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

  // 凭据保留在主进程（DTO 边界）：Player 不再持有 jellyfinToken，
  // 历史海报 URL 由主进程按服务器配置派生，Jellyfin 请求一律走 Main 注入认证
  // M4: itemId 镜像 ref —— 手动选择弹幕（ignoreEpoch）在 await 返回后用它判断
  // 是否已切集，防止旧集选择结果污染新集
  const itemIdRef = useRef(itemId)
  itemIdRef.current = itemId

  // 修复点 1.13: videoLoadKey 必须在引用它的"视频 src useEffect"（约 L586）之前声明，
  // 避免 const 声明的 TDZ（Temporal Dead Zone）导致 "Block-scoped variable used before its declaration"
  const [videoLoadKey, setVideoLoadKey] = useState(0)

  // 剧集列表状态
  const [episodeList, setEpisodeList] = useState<JellyfinItem[]>([])
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(-1)
  const [episodePopup, setEpisodePopup] = useState(false)
  // 修复 R-S3: 标记剧集拉取是否完成（含电影/本地文件无剧集场景），
  // 否则电影（无 seriesId/episodeList）永远命中 danmaku effect 的早退条件，弹幕无法加载
  const [episodeFetchDone, setEpisodeFetchDone] = useState(false)
  
  // 本地文件夹视频列表
  const [folderVideos, setFolderVideos] = useState<FolderVideo[]>([])

  // ===== 播放引擎与共享状态（必须在引用它们的 useEffect 之前声明，避免 TDZ）=====
  const [playerState, playerActions] = usePlayerStore()
  const { currentTime, duration, playbackRate, isPlaying, volume, buffered, error, loading } = playerState

  // 播放引擎：'html5'（内置 <video>）、'mpv'（打孔嵌入，旧架构）、'mpv-canvas'（libmpv 画布渲染，方案 C）
  const [engineMode, setEngineMode] = useState<EngineMode>('html5')
  const engineModeRef = useRef<EngineMode>('html5')
  const [mpvAvailable, setMpvAvailable] = useState(false)
  // mpv 已实际出画（file-loaded 后主进程揭示渲染窗口）；此期间视频区域必须切透明
  const [mpvActive, setMpvActive] = useState(false)
  // 窗口级全屏（主进程 setBounds 假全屏，替代 HTML Fullscreen API）
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  // mpv 视频画面嵌入区域（替代 <video> 的可视位置）
  const mpvSlotRef = useRef<HTMLDivElement>(null)
  // 当前播放源是否为本地文件（影响 file-loaded 时是否关闭 mpv 内建字幕）
  const mpvSourceLocalRef = useRef(false)
  // mpv 模式静音前的音量（恢复时用，避免硬编码 100）
  const preMuteVolumeRef = useRef(100)

  // mpv 家族（打孔 embed / 画布 canvas）控制面分发：方法名一致，按当前引擎路由
  const mpvCtl = (): typeof window.api.mpv | typeof window.api.mpvRender =>
    engineModeRef.current === 'mpv-canvas' ? window.api.mpvRender : window.api.mpv
  const isMpvFamily = (): boolean => engineModeRef.current !== 'html5'
  // libmpv 画布引擎的实例参数（硬解/HDR），initEngine 时从设置读入
  const mpvRenderOptsRef = useRef({ hardwareDecode: true, hdrToneMapping: false })

  // 续播位置 / 手动时钟总线（mpv 事件同步锚点）
  const resumePosRef = useRef(parseFloat(searchParams.get('position') || '0'))
  const hasResumedRef = useRef(false)
  const timeBusRef = useRef<MediaTimeBus | null>(null)

  // 镜像音量/倍速到 ref：mpv 新进程启动时同步（mpv 默认 100/1.0）。
  // 不能把 volume/playbackRate 加入 startPlayback 依赖（变化会触发视频源 effect 误重载）
  const volumeRef = useRef(100)
  const playbackRateRef = useRef(1)
  volumeRef.current = volume
  playbackRateRef.current = playbackRate

  // 获取剧集列表（电视剧）— Jellyfin 请求由主进程持凭据发起，Renderer 无需 token
  const episodeFetchedRef = useRef(false)
  useEffect(() => {
    // 本地文件不需要剧集列表
    if (localFile) {
      setEpisodeFetchDone(true)
      return
    }
    // 已经获取过则跳过
    if (episodeFetchedRef.current) return

    const fetchEpisodes = async (): Promise<void> => {
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
        // 条件 2: seriesId 为空，先获取详情（电影走此分支，无 SeriesId 时不拉剧集）
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
      // 修复 R-S3: 无论是否取到剧集（电影无剧集），拉取流程结束即放行 danmaku effect
      setEpisodeFetchDone(true)
    }

    // 剧集/详情请求均走主进程认证，直接拉取即可
    episodeFetchedRef.current = true
    void fetchEpisodes()
  }, [seriesId, seasonId, itemId, localFile])

  // 初始化播放引擎：读取设置偏好 + 探测可用性。
  // 优先级：显式偏好 > 默认。默认在 libmpv 画布引擎（方案 C）可用时优先选用，
  // 其次打孔 mpv，最后内置 HTML5；任一环节不可用自动降级。
  useEffect(() => {
    let cancelled = false
    const initEngine = async (): Promise<void> => {
      try {
        const [saved, availRes, canvasRes] = await Promise.all([
          window.api.store.get('player').catch(() => null),
          window.api.mpv.isAvailable().catch(() => ({ success: false as const })),
          window.api.mpvRender.isAvailable().catch(() => ({ success: false as const }))
        ])
        if (cancelled) return
        const avail = !!(availRes && availRes.success && availRes.data === true)
        const canvasAvail = !!(canvasRes && canvasRes.success && canvasRes.data === true)
        setMpvAvailable(avail || canvasAvail)
        const savedPlayer = saved as { engine?: string; hardwareDecode?: boolean; hdrToneMapping?: boolean } | null
        mpvRenderOptsRef.current = {
          hardwareDecode: savedPlayer?.hardwareDecode !== false,
          hdrToneMapping: savedPlayer?.hdrToneMapping === true
        }
        const pref = savedPlayer?.engine
        let engine: EngineMode = 'html5'
        if (pref === 'mpv-canvas') {
          engine = canvasAvail ? 'mpv-canvas' : avail ? 'mpv' : 'html5'
        } else if (pref === 'mpv') {
          engine = avail ? 'mpv' : canvasAvail ? 'mpv-canvas' : 'html5'
        } else {
          engine = canvasAvail ? 'mpv-canvas' : avail ? 'mpv' : 'html5'
        }
        if ((pref === 'mpv-canvas' && !canvasAvail) || (pref === 'mpv' && !avail)) {
          console.warn(`[Player] 偏好引擎 ${pref} 不可用，降级为 ${engine}`)
        }
        console.log(`[Player] 播放引擎就绪: ${engine}（偏好=${pref ?? '默认'}, mpv可用=${avail}, 画布可用=${canvasAvail}, 硬解=${mpvRenderOptsRef.current.hardwareDecode}）`)
        engineModeRef.current = engine
        setEngineMode(engine)
      } catch { /* 默认 html5 */ }
    }
    void initEngine()
    return () => { cancelled = true }
  }, [])

  // 离开播放页：回收两种 mpv 引擎（打孔子窗口 / 画布渲染实例）
  useEffect(() => {
    return () => {
      void window.api.mpv.hide()
      void window.api.mpvRender.destroy()
    }
  }, [])

  // mpv 引擎事件 → 手动时钟 / playerStore
  useEffect(() => {
    if (!isMpvFamily()) return
    const engine = mpvCtl()
    const onMpvEvent = (event: string, data: unknown): void => {
      const bus = timeBusRef.current
      switch (event) {
        case 'time': {
          const t = Number(data)
          if (Number.isFinite(t)) {
            bus?.syncFromEngine({ currentTime: t })
            playerActions.setCurrentTime(t)
          }
          break
        }
        case 'duration': {
          const d = Number(data)
          if (Number.isFinite(d) && d > 0) {
            bus?.syncFromEngine({ duration: d })
            playerActions.setDuration(d)
          }
          break
        }
        case 'pause': {
          const paused = data === true
          playerActions.setIsPlaying(!paused)
          bus?.syncFromEngine({ isPlaying: !paused })
          break
        }
        case 'volume': {
          const v = Math.round(Number(data))
          if (Number.isFinite(v)) playerActions.setVolume(v)
          break
        }
        case 'speed': {
          const s = Number(data)
          if (Number.isFinite(s)) {
            playerActions.setPlaybackRate(s)
            bus?.syncFromEngine({ playbackRate: s })
          }
          break
        }
        case 'file-loaded':
        case 'start':
          playerActions.setLoading(false)
          playerActions.setError('')
          bus?.syncFromEngine({ isPlaying: true })
          // file-loaded 后主进程揭示 mpv 渲染窗口（打孔），视频区域需切透明
          if (event === 'file-loaded') setMpvActive(true)
          // 服务器字幕由本应用 HTML 自绘，关闭 mpv 内建字幕避免双字幕；
          // 本地文件保留 mpv 默认行为（外挂/内嵌 ASS 由 mpv 渲染）
          if (!mpvSourceLocalRef.current) {
            void mpvCtl().disableSubtitle()
          }
          // 续播跳转（每次进入播放页仅一次）
          if (!hasResumedRef.current && resumePosRef.current > 0) {
            hasResumedRef.current = true
            void mpvCtl().seek(resumePosRef.current)
          }
          break
        case 'stop':
        case 'idle':
          bus?.syncFromEngine({ isPlaying: false })
          playerActions.setIsPlaying(false)
          setMpvActive(false)
          break
        case 'error': {
          // 优先展示主进程带过来的具体错误信息（如"视频解码失败"），缺省时用通用提示
          const detail = data instanceof Error
            ? data.message
            : typeof data === 'string'
              ? data
              : (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
                  ? (data as { message: string }).message
                  : '')
          playerActions.setError(detail || 'mpv 播放错误，请查看日志或在设置中切换回内置播放器')
          playerActions.setLoading(false)
          setMpvActive(false)
          break
        }
        case 'quit': {
          // mpv 进程退出：渲染窗口已销毁，必须立即恢复黑底，防止打孔透出桌面
          setMpvActive(false)
          break
        }
      }
    }
    engine.onEvent(onMpvEvent)
    return () => { engine.offEvent() }
  }, [engineMode, playerActions])

  // 窗口级全屏：隐藏顶栏（TopBar），主内容占满窗口；退出全屏时恢复
  useEffect(() => {
    if (!windowFullscreen) return
    document.body.classList.add('app-fullscreen')
    return () => { document.body.classList.remove('app-fullscreen') }
  }, [windowFullscreen])

  // 原生全屏状态同步（主进程 setFullScreen 的 enter/leave-full-screen 事件为唯一真源）
  useEffect(() => {
    return window.api.window.onFullscreenChanged((fullscreen) => {
      setWindowFullscreen(fullscreen)
    })
  }, [])

  // mpv 打孔模式：#root 与 .app-shell 切透明，让主窗口身后的 mpv 渲染窗口透出；
  // 离开播放页/播放结束立即恢复，防止透明区域露出桌面
  useEffect(() => {
    const root = document.getElementById('root')
    const shell = document.querySelector('.app-shell')
    if (engineMode === 'mpv' && mpvActive) {
      root?.classList.add('mpv-hole')
      shell?.classList.add('mpv-hole')
      return () => {
        root?.classList.remove('mpv-hole')
        shell?.classList.remove('mpv-hole')
      }
    }
  }, [engineMode, mpvActive])

  // mpv 嵌入几何同步：挂载/窗口缩放/全屏/布局变化时跟随视频区域
  useEffect(() => {
    if (engineMode !== 'mpv') return
    const update = (embed: boolean): void => {
      const slot = mpvSlotRef.current
      if (!slot) return
      const rect = slot.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      if (embed) {
        window.api.mpv.embed(rect.left, rect.top, rect.width, rect.height).catch(() => {})
      } else {
        void window.api.mpv.updateEmbed(rect.left, rect.top, rect.width, rect.height)
      }
    }
    const onResize = (): void => update(false)
    const ro = new ResizeObserver(() => update(false))
    if (mpvSlotRef.current) ro.observe(mpvSlotRef.current)
    window.addEventListener('resize', onResize)
    // 首次嵌入（startPlayback 也会 embed，此处兜底确保子窗口先创建）
    const t1 = window.setTimeout(() => update(true), 60)
    const t2 = window.setTimeout(() => update(false), 400)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [engineMode])

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blurBgCanvasRef = useRef<HTMLCanvasElement>(null)
  const subtitleCuesRef = useRef<SubtitleCue[][]>([])
  const activeSubIdxRef = useRef(-1)
  const currentSubTextRef = useRef('')
  const engineRef = useRef<DanmakuEngine | null>(null)
  // 修复 R-S6: 字幕拉取代号，切集/切源递增，旧 .then() 检测到过期即丢弃，避免覆盖新字幕
  const subtitleGenRef = useRef(0)

  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  // R-S2: ref 镜像，时间总线 effect 内读 ref，避免开关弹幕销毁重建整条 timeBus
  const danmakuEnabledRef = useRef(danmakuEnabled)
  danmakuEnabledRef.current = danmakuEnabled
  const [danmakuLoading, setDanmakuLoading] = useState(false)
  const [currentDanmakuCount, setCurrentDanmakuCount] = useState(0)
  const [danmakuCountVisible, setDanmakuCountVisible] = useState(false)
  const [danmakuError, setDanmakuError] = useState('')
  // 弹幕热力图：存储当前集弹幕数据（与 loadComments 同步设置，切集时清空）
  const [danmakuComments, setDanmakuComments] = useState<DanmakuComment[]>([])
  // V2 多级匹配：低置信度/失败时展示候选列表供手动绑定
  const [matchCandidates, setMatchCandidates] = useState<DanmakuMatchCandidate[]>([])
  const [matchLogs, setMatchLogs] = useState<string[]>([])
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
  // R-S2: ref 镜像，时间总线 effect 内读 ref，避免切竖屏/显示模式时销毁重建 timeBus
  const isPortraitRef = useRef(isPortrait)
  isPortraitRef.current = isPortrait
  const displayModeRef = useRef(displayMode)
  displayModeRef.current = displayMode

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

  // 用 ref 持有最新播放进度，避免 savePlayHistory 随 currentTime 变化而重建，
  // 否则 30s 周期保存的 interval 会每 ~200ms 被销毁/重建，退化为高频写盘
  const playHistoryTimeRef = useRef(currentTime)
  playHistoryTimeRef.current = currentTime

  const savePlayHistory = useCallback(async () => {
    if (!itemId && !localFile) return
    if (duration <= 0) return
    const t = playHistoryTimeRef.current
    if (t < 5) return
    try {
      // 海报 URL 由主进程按服务器配置派生（协议链接，不含凭据），Renderer 只传 itemId + baseUrl
      const historyName = seriesName && !itemName.startsWith(seriesName)
        ? `${seriesName} - ${itemName}` : itemName
      await window.api.history.save({
        itemId: itemId || `local:${localFile}`,
        name: historyName, duration, position: t,
        watchedAt: Date.now(), localFile: localFile || undefined,
        baseUrl: localFile ? undefined : baseUrl,
        seriesName: seriesName || undefined
      })
    } catch (err) { console.error('保存播放历史失败:', err) }
  }, [itemId, localFile, itemName, duration, baseUrl, seriesName])

  useEffect(() => {
    if (duration <= 0) return
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
    return () => {
      window.removeEventListener('resize', handleResize)
      engineRef.current?.destroy()
      // L5: destroy 后置 null，防止 StrictMode 双挂载时旧实例被误用
      engineRef.current = null
    }
  // 修复点 1.4: 禁止把 useRef.current 放进 useEffect 依赖数组（mutable，不会触发重渲染，只会造成每次渲染都重新初始化）
  }, [])

  useEffect(() => {
    console.log(`[Player:danmakuEffect] ==================== 弹幕加载Effect触发 ====================`)
    console.log(`[Player:danmakuEffect] 依赖值: itemId="${itemId}", currentEpisodeIndex=${currentEpisodeIndex}, localFile="${localFile || 'none'}", seriesName="${seriesName || 'none'}"`)

    if (!localFile && !seriesName && (!itemName || itemName === '未知视频')) {
      console.log(`[Player:danmakuEffect] ⚠️ 跳过: 无有效匹配参数`)
      return
    }

    // 修复串集：剧集列表未加载完（currentEpisodeIndex=-1）时延迟加载，等元数据就绪
    // 否则 meta 缺失 IndexNumber/ParentIndexNumber，cacheKey 退化成 S0E0 命中错误缓存
    // 修复 R-S3/M5: 仅以 episodeFetchDone 为准（fetchEpisodes 中 setEpisodeList/
    // setCurrentEpisodeIndex/setEpisodeFetchDone 同一同步块批量提交，不存在中间态），
    // 避免 episodeList 先提交而 fetchDone 未提交时首集双重加载弹幕
    if (!localFile && !episodeFetchDone) {
      console.log(`[Player:danmakuEffect] ⚠️ 跳过: 剧集列表未加载完，等元数据就绪后再触发`)
      return
    }

    // 切集强制销毁上一集弹幕状态：cancel 挂起请求 + 清空引擎 + 清候选
    danmakuRequestManager.cancel()
    engineRef.current?.clear()
    setCurrentDanmakuCount(0)
    setDanmakuLoading(true)
    setDanmakuError('')
    setMatchCandidates([])
    setMatchLogs([])
    setDanmakuComments([])

    // ===== 构建结构化元数据（V2 多级匹配核心） =====
    // 从 episodeList[currentEpisodeIndex] 提取 Jellyfin 原生 IndexNumber/ParentIndexNumber，
    // 这是切集不串弹幕的关键：每集的 season+episode 独立数值，缓存 Key 按此隔离
    const currentEp: JellyfinItem | null = (currentEpisodeIndex >= 0 && episodeList[currentEpisodeIndex]) ? episodeList[currentEpisodeIndex] : null
    const meta: DanmakuMatchMeta = {
      mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
      itemId,
      seriesId: seriesId || (currentEp?.SeriesId as string | undefined) || undefined,
      seasonId: seasonId || (currentEp?.SeasonId as string | undefined) || undefined,
      seriesName: seriesName || (currentEp?.SeriesName as string | undefined) || undefined,
      seasonName: currentEp?.SeasonName,
      indexNumber: currentEp?.IndexNumber,
      parentIndexNumber: currentEp?.ParentIndexNumber,
      productionYear: currentEp?.ProductionYear,
      fileName: localFile ? (localFile.split(/[/\\]/).pop() || localFile) : (currentEp?.Name || itemName),
      filePath: localFile || undefined,
      title: itemName
    }
    console.log(`[Player:danmakuEffect] 构建元数据: series="${meta.seriesName}", S${meta.parentIndexNumber ?? '?'}E${meta.indexNumber ?? '?'}, itemId=${meta.itemId}, fileName="${meta.fileName}"`)

    const loadDanmaku = async (): Promise<void> => {
      const log = (msg: string) => {
        console.log(`[Player:danmakuEffect] ${msg}`)
        window.api.log?.send?.('info', 'renderer', `[Player:danmakuEffect] ${msg}`)
      }
      log(`开始执行 loadDanmaku（V2 多级匹配）`)
      try {
        const result = await danmakuRequestManager.loadDanmaku(meta, localFile || undefined)
        log(`loadDanmaku返回: ${result ? `ok=${result.ok}, count=${result.count ?? 0}, candidates=${result.candidates?.length ?? 0}` : 'null(cancelled)'}`)
        if (result === null) {
          // 已取消（切集），不更新 UI
          return
        }
        if (result.logs && result.logs.length) setMatchLogs(result.logs)
        if (result.ok && result.comments) {
          log(`✅ 弹幕加载成功，数量: ${result.count}, 来源: ${result.source || '未知'}, 层级: ${result.matchLevel || '?'}, 置信度: ${result.confidence ?? '?'}`)
          engineRef.current?.loadComments(result.comments)
          setDanmakuComments(result.comments)
          setCurrentDanmakuCount(result.count ?? 0)
          if ((result.count ?? 0) > 0) {
            setDanmakuCountVisible(true)
            setTimeout(() => setDanmakuCountVisible(false), 3000)
            // 低置信度但已加载：附带候选供用户确认修正
            if (result.candidates && result.candidates.length) {
              setMatchCandidates(result.candidates)
              setDanmakuError(`已加载弹幕（置信度较低），可点击候选修正`)
            }
          } else {
            setDanmakuError('该集暂无弹幕，可尝试手动搜索')
          }
        } else {
          // 未命中精准资源
          log(`⚠️ 未命中精准资源${result.candidates?.length ? `，${result.candidates.length} 个候选供手动选择` : ''}`)
          if (result.candidates && result.candidates.length) {
            setMatchCandidates(result.candidates)
            setDanmakuError('自动匹配置信度低，请从候选列表选择正确弹幕')
          } else {
            setDanmakuError('未找到匹配弹幕，可尝试手动搜索')
          }
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
  }, [itemId, itemName, localFile, seriesName, currentEpisodeIndex, episodeList, episodeFetchDone])

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
    if (!kw) return
    setSearchLoading(true); setSearchResults([])
    try {
      const result = await danmakuRequestManager.search(kw)
      if (result.success && result.data) {
        const data = result.data as DanmakuSearchResponse
        const eps: DanmakuSearchResult[] = []
        for (const anime of (data.animes || [])) {
          for (const ep of (anime.episodes || [])) {
            eps.push({ ...ep, animeTitle: anime.animeTitle, source: ep.source || 'dandanplay' })
          }
        }
        setSearchResults(eps)
        if (eps.length === 0) {
          setDanmakuError('未找到匹配弹幕，可尝试其他关键词')
        }
      } else {
        const errMsg = result.error || '搜索失败'
        setDanmakuError(errMsg.includes('App-ID') ? errMsg : '搜索弹幕失败')
        showStatus(errMsg.includes('App-ID') ? '请在设置中配置弹幕 API 认证' : '搜索弹幕失败')
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
    // M4: 快照当前 itemId，await 返回后比对 —— 已切集则丢弃，防串集
    const contextItemId = itemIdRef.current
    try {
      // ignoreEpoch: 用户手动选择的结果不允许被无关 cancel() 静默丢弃
      const result = await danmakuRequestManager.getComments(String(ep.episodeId), ep.source, false, undefined, true)
      if (itemIdRef.current !== contextItemId) {
        console.log(`[Player:handleDanmakuSelect] 已切换视频，丢弃过期选择结果`)
        return
      }
      if (result) {
        engineRef.current?.loadComments(result.comments); setDanmakuComments(result.comments); setCurrentDanmakuCount(result.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000)
        // 手动搜索选择 → 持久化绑定，下次播放该集直接复用精准ID（走 manual 层）
        await danmakuRequestManager.bindEpisode({
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          episodeId: ep.episodeId,
          animeTitle: ep.animeTitle,
          episodeTitle: ep.episodeTitle,
          source: ep.source || 'dandanplay'
        }, {
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          seriesName,
          indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
          parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber,
          filePath: localFile
        }).catch(() => {})
      } else { setDanmakuError('获取弹幕失败') }
    } catch { setDanmakuError('获取弹幕失败') }
    finally { setDanmakuLoading(false) }
  }

  // V2: 从候选列表手动选择弹幕源 → 持久化绑定 + 立即加载（下次该集走 manual 层精准命中）
  const handleSelectCandidate = async (c: DanmakuMatchCandidate): Promise<void> => {
    setDanmakuLoading(true); setDanmakuError(''); setMatchCandidates([])
    try {
      console.log(`[Player:handleSelectCandidate] 手动绑定: episodeId=${c.episodeId}, source=${c.source}, title="${c.animeTitle} - ${c.episodeTitle}"`)
      // 1. 持久化绑定（manual 层，下次直接复用）+ 清除该集匹配缓存
      await danmakuRequestManager.bindEpisode({
        mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
        itemId,
        episodeId: c.episodeId,
        animeId: c.animeId,
        animeTitle: c.animeTitle,
        episodeTitle: c.episodeTitle,
        source: c.source
      }, {
        mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
        itemId,
        seriesName,
        indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
        parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber,
        filePath: localFile
      })
      // 2. 立即加载该弹幕源
      const result = await danmakuRequestManager.loadByBind(
        {
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          seriesName, indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
          parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber
        },
        c.episodeId,
        c.source
      )
      if (result && result.ok && result.comments) {
        engineRef.current?.loadComments(result.comments)
        setDanmakuComments(result.comments)
        setCurrentDanmakuCount(result.count ?? 0)
        setDanmakuCountVisible(true)
        setTimeout(() => setDanmakuCountVisible(false), 3000)
        showStatus(`已绑定弹幕源: ${c.animeTitle} - ${c.episodeTitle}`)
      } else {
        setDanmakuError('获取弹幕失败，请重试或选择其他候选')
      }
    } catch (err) {
      console.error(`[Player:handleSelectCandidate] 异常:`, err)
      setDanmakuError('绑定弹幕失败')
    }
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
        engineRef.current?.loadComments(data.comments); setDanmakuComments(data.comments); setCurrentDanmakuCount(data.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000); showStatus(`已加载本地弹幕: ${data.source || ''}`)
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

  /**
   * 统一播放入口：拿到可播放 URL 后按引擎分发。
   * - html5：写入 <video>.src
   * - mpv：创建/更新 Win32 嵌入子窗口并 loadfile
   * 服务器字幕两种引擎都走应用 HTML 自绘（位置/字号/字间距可调）
   */
  const startPlayback = useCallback(async (
    url: string,
    isLocal: boolean,
    subs?: { index: number; label: string; language: string; codec: string; url: string }[]
  ): Promise<void> => {
    // 修复 R-S5: 清空旧字幕 cues，避免切源后旧字幕残留显示
    subtitleCuesRef.current = []
    // 修复 R-S6: 递增字幕拉取代号，过期的 .then() 回调检测后丢弃
    const subGen = ++subtitleGenRef.current
    mpvSourceLocalRef.current = isLocal
    const subtitleList = subs || []
    setSubtitleTracks(subtitleList)
    let defaultIdx = -1
    for (let i = 0; i < subtitleList.length; i++) {
      const sub = subtitleList[i]
      const isDefault = subtitleList.length === 1 || sub.language === 'chi' || sub.language === 'zho' || sub.language === 'chs' || sub.language === 'cht'
      if (isDefault && defaultIdx === -1) defaultIdx = i
    }
    if (subtitleList.length > 0) {
      subtitleList.forEach((sub, i) => {
        window.api.jellyfin.fetchSubtitle(sub.url).then((result) => {
          // 修复 R-S6: 切集/切源后丢弃过期的字幕响应，避免覆盖新字幕状态
          if (subGen !== subtitleGenRef.current) return
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

    if (engineModeRef.current === 'mpv-canvas') {
      // ===== 画布引擎（方案 C）：libmpv 实例渲染到 WebGL canvas，无任何窗口嵌入 =====
      playerActions.setLoading(true)
      playerActions.setError('')
      const playRes = await window.api.mpvRender.play(url, mpvRenderOptsRef.current)
      if (!playRes.success) {
        playerActions.setError(`mpv 播放失败: ${playRes.error}`)
        playerActions.setLoading(false)
        return
      }
      // 新实例默认音量 100/倍速 1.0，同步应用当前设置
      void window.api.mpvRender.setVolume(volumeRef.current)
      void window.api.mpvRender.setSpeed(playbackRateRef.current)
      setSrcReady(true)
      return
    }

    if (engineModeRef.current === 'mpv') {
      playerActions.setLoading(true)
      playerActions.setError('')
      const slot = mpvSlotRef.current
      if (slot) {
        const rect = slot.getBoundingClientRect()
        const embedRes = await window.api.mpv.embed(rect.left, rect.top, rect.width, rect.height)
        if (!embedRes.success) {
          // 嵌入失败（Win32 不可用等）→ play 会以 mpv 独立窗口模式继续
          console.warn('[Player] mpv 嵌入失败，回退独立窗口模式:', embedRes.error)
        }
      }
      const playRes = await window.api.mpv.play(url)
      if (!playRes.success) {
        playerActions.setError(`mpv 播放失败: ${playRes.error}`)
        playerActions.setLoading(false)
        return
      }
      // 新 mpv 进程默认音量 100/倍速 1.0，同步应用当前音量/倍速设置
      void window.api.mpv.setVolume(volumeRef.current)
      void window.api.mpv.setSpeed(playbackRateRef.current)
      setSrcReady(true)
      return
    }

    const video = videoRef.current
    if (!video) return
    const oldTracks = video.querySelectorAll('track')
    oldTracks.forEach(t => t.remove())
    video.src = url
    video.load()
    setSrcReady(true)
  }, [playerActions])

  useEffect(() => {
    // 修复 R-S5: 切集/切源竞态保护，旧请求完成时若已取消则不再调用 startPlayback
    let cancelled = false
    playerActions.setLoading(true); playerActions.setError('')
    if (localFile) {
      window.api.file.getLocalFileUrl(localFile).then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          const data = result.data as { url: string }
          if (data.url) {
            void startPlayback(data.url, true)
            return
          }
        }
        playerActions.setError('无法读取本地文件'); playerActions.setLoading(false)
      }).catch(() => { if (cancelled) return; playerActions.setError('无法读取本地文件'); playerActions.setLoading(false) })
      return () => { cancelled = true }
    }
    if (!itemId) { playerActions.setLoading(false); return () => { cancelled = true } }
    window.api.jellyfin.getPlaybackUrl(itemId).then((result) => {
      if (cancelled) return
      if (result.success) {
        const data = result.data as { url?: string; subtitles?: { index: number; label: string; language: string; codec: string; url: string }[] }
        if (data?.url) {
          void startPlayback(data.url, false, data.subtitles)
          return
        }
      }
      playerActions.setError('获取播放地址失败'); playerActions.setLoading(false)
    }).catch((err) => { if (cancelled) return; playerActions.setError(`获取播放地址失败: ${String(err)}`); playerActions.setLoading(false) })
    return () => { cancelled = true }
  // videoLoadKey：切集递增后重新加载；engineMode：引擎初始化完成/切换后重新加载
  }, [itemId, localFile, videoLoadKey, engineMode, startPlayback])

  // 字幕二分查找：由时间总线驱动（两种引擎共用）
  const renderSubtitleAtTime = useCallback((time: number): void => {
    const cues = subtitleCuesRef.current[activeSubIdxRef.current]
    if (!cues || cues.length === 0) {
      if (currentSubTextRef.current) {
        currentSubTextRef.current = ''
        setCurrentSubtitleText('')
      }
      return
    }
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
  }, [])

  useEffect(() => {
    // ===== mpv 家族引擎（打孔/画布）：手动时钟（事件同步锚点 + RAF 按速率外推）=====
    if (engineMode !== 'html5') {
      if (timeBusRef.current) timeBusRef.current.destroy()
      timeBusRef.current = createMediaTimeBus()
      const bus = timeBusRef.current
      bus.attachManual()

      // 弹幕引擎仍走 RAF 订阅，与 HTML5 路径完全一致
      const unsubRAF = bus.subscribeRAF((time, playbackRate) => {
        if (danmakuEnabledRef.current && engineRef.current) {
          engineRef.current.update(time, playbackRate)
        }
      })

      const unsubscribe = bus.subscribe((time, state) => {
        playerActions.setCurrentTime(time)
        playerActions.setDuration(state.duration)
        playerActions.setPlaybackRate(state.playbackRate)
        playerActions.setIsPlaying(state.isPlaying)
        renderSubtitleAtTime(time)
      })

      return () => {
        unsubscribe()
        unsubRAF()
        bus.destroy()
        timeBusRef.current = null
      }
    }

    // ===== HTML5 引擎：绑定 <video> =====
    const video = videoRef.current; if (!video) return

    if (timeBusRef.current) {
      timeBusRef.current.destroy()
    }

    timeBusRef.current = createMediaTimeBus()
    timeBusRef.current.attachVideo(video)

    // 性能优化：弹幕引擎使用 RAF 订阅，每帧更新不经过 React state，避免 60fps 重渲染
    let frameCount = 0
    const unsubRAF = timeBusRef.current.subscribeRAF((time, playbackRate) => {
      if (danmakuEnabledRef.current && engineRef.current) {
        engineRef.current.update(time, playbackRate)
      }
      frameCount++
      if (frameCount % 8 === 0 && isPortraitRef.current && displayModeRef.current === 'contain') {
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
      renderSubtitleAtTime(time)
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

    // 修复弹幕进度不匹配：seek（拖动进度条/方向键跳转）后必须重置弹幕引擎 position，
    // 否则 engine.position 仍停在旧位置，弹幕时间轴与视频脱节（后退漏弹幕/前进堆叠错位）
    const onSeeked = (): void => {
      if (danmakuEnabledRef.current && engineRef.current) {
        engineRef.current.seek(video.currentTime)
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('seeked', onSeeked)

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
      video.removeEventListener('seeked', onSeeked)
    }
    // R-S2: danmakuEnabled/isPortrait/displayMode 通过 ref 读取（danmakuEnabledRef 等），
    // 不再进入依赖 —— 开关弹幕/切竖屏/切显示模式不会销毁重建整条 timeBus
  }, [srcReady, engineMode, renderSubtitleAtTime, playerActions])

  // ==================== 控制（双引擎分发） ====================

  /** 跳转到绝对时间（秒），HTML5 / mpv 家族共用 */
  const engineSeekTo = useCallback((target: number): void => {
    const t = Math.max(0, target)
    if (isMpvFamily()) {
      void mpvCtl().seek(t)
      // 立即同步本地时钟与弹幕位置，不等事件回环（进度条/弹幕无延迟感）
      timeBusRef.current?.syncFromEngine({ currentTime: t })
      engineRef.current?.seek(t)
    } else {
      const video = videoRef.current
      if (video) video.currentTime = t
    }
    playerActions.forceNotifyCurrentTime()
  }, [playerActions])

  /** 设置音量 0-100+，HTML5 / mpv 家族共用 */
  const engineSetVolume = useCallback((value: number): void => {
    const v = Math.max(0, Math.min(150, Math.round(value)))
    playerActions.setVolume(v)
    if (isMpvFamily()) {
      void mpvCtl().setVolume(v)
      return
    }
    const video = videoRef.current
    if (video) {
      video.volume = v / 100
      video.muted = v === 0
    }
  }, [playerActions])

  const handlePlayPause = (): void => {
    if (isMpvFamily()) {
      if (isPlaying) void mpvCtl().pause()
      else void mpvCtl().resume()
      return
    }
    const video = videoRef.current; if (!video) return
    video.paused ? video.play().catch(() => showStatus('播放失败')) : video.pause()
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    engineSeekTo(ratio * duration)
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
    // 原生窗口全屏（主进程 setFullScreen）；状态以 onFullscreenChanged 事件为真源
    void window.api.window.toggleFullscreen().then((res) => {
      if (res?.success) setWindowFullscreen(!!res.data)
    }).catch(() => {})
  }

  const handlePlaybackRateChange = (rate: number): void => {
    if (isMpvFamily()) {
      void mpvCtl().setSpeed(rate)
      timeBusRef.current?.syncFromEngine({ playbackRate: rate })
    } else {
      const video = videoRef.current
      if (video) video.playbackRate = rate
    }
    playerActions.setPlaybackRate(rate)
    setContextMenu({ x: 0, y: 0, visible: false })
    setSpeedToast(`${rate}x`); setTimeout(() => setSpeedToast(''), 2000)
  }

  const handleVolumeChange = (value: number): void => {
    engineSetVolume(value)
  }

  const handleToggleMute = (): void => {
    if (isMpvFamily()) {
      // mpv 无独立 mute 状态：音量 0 即静音，恢复到静音前的音量
      if (volume === 0) {
        engineSetVolume(preMuteVolumeRef.current)
      } else {
        preMuteVolumeRef.current = volume
        engineSetVolume(0)
      }
      return
    }
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
      const result = await mpvCtl().screenshotSave()
      if (result.success) { showStatus('截图已保存'); return }
    } catch { /* mpv 家族引擎不可用 */ }
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
    const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const video = videoRef.current
    const useMpv = isMpvFamily()

    switch (e.key) {
      case 'ArrowLeft': {
        e.preventDefault()
        const delta = e.ctrlKey ? 30 : 5
        if (useMpv) engineSeekTo(Math.max(0, currentTime - delta))
        else if (video) video.currentTime = Math.max(0, video.currentTime - delta)
        showStatus(e.ctrlKey ? '后退 30s' : '后退 5s')
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const delta = e.ctrlKey ? 30 : 5
        if (useMpv) engineSeekTo(Math.min(duration || currentTime + delta, currentTime + delta))
        else if (video) video.currentTime = Math.min(video.duration || 0, video.currentTime + delta)
        showStatus(e.ctrlKey ? '前进 30s' : '前进 5s')
        break
      }
      case ' ': e.preventDefault(); handlePlayPause(); break
      case 'ArrowUp': e.preventDefault(); engineSetVolume((useMpv ? volume : Math.round((video?.volume ?? 0) * 100)) + 10); break
      case 'ArrowDown': e.preventDefault(); engineSetVolume((useMpv ? volume : Math.round((video?.volume ?? 0) * 100)) - 10); break
      case 'f': case 'F': e.preventDefault(); handleFullscreen(); break
      case 's': case 'S': e.preventDefault(); handleScreenshot(); break
      case 'p': case 'P': e.preventDefault(); window.api.window.alwaysOnTop().then(result => { if (result.success) { setAlwaysOnTop(!!result.data); showStatus(result.data ? '窗口置顶' : '取消置顶') } }).catch(() => {}); break
      case 'd': case 'D': e.preventDefault(); handlePictureInPicture(); break
      case '[': e.preventDefault(); { const v = Math.max(-30, danmakuOffsetRef.current - 0.5); handleOffsetChange(v); showStatus(`弹幕偏移 ${v.toFixed(1)}s`); } break
      case ']': e.preventDefault(); { const v = Math.min(30, danmakuOffsetRef.current + 0.5); handleOffsetChange(v); showStatus(`弹幕偏移 ${v.toFixed(1)}s`); } break
      case 'v': case 'V': e.preventDefault(); { if (subtitleTracks.length > 0) { const nextIdx = activeSubtitleIndex + 1 >= subtitleTracks.length ? -1 : activeSubtitleIndex + 1; handleSubtitleSelect(nextIdx); showStatus(nextIdx === -1 ? '字幕关闭' : `字幕: ${subtitleTracks[nextIdx].label}`); } } break
      case 'Escape': e.preventDefault(); if (infoOverlay) handleCloseInfo(); else if (windowFullscreen) handleFullscreen(); break
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
    <div ref={containerRef} className={`h-full relative outline-none ${engineMode === 'mpv' && mpvActive ? 'bg-transparent' : 'bg-black'}`} onKeyDown={handleKeyDown} tabIndex={0}>

      {/* 视频区域 — 全屏铺满容器 */}
      <div className={`absolute inset-0 overflow-hidden flex items-center justify-center ${isPortrait ? 'portrait-mode' : ''} ${engineMode === 'mpv' && mpvActive ? 'bg-transparent' : 'bg-black'}`} onContextMenu={handleContextMenu} onClick={handlePlayPause} onMouseMove={handleMouseMove}>
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

        <div ref={mpvSlotRef} className={`relative w-full h-full ${engineMode === 'mpv' && mpvActive ? 'bg-transparent' : 'bg-black'}`}>
          {isPortrait && engineMode === 'html5' && displayMode === 'contain' && (
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
            style={engineMode !== 'html5' ? { display: 'none' } : undefined}
            controls={false}
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
          />
          {/* 画布引擎（方案 C）：libmpv 帧直接绘制为 DOM canvas，控件/弹幕/字幕天然悬浮其上 */}
          {engineMode === 'mpv-canvas' && <MpvCanvasView />}
          {/* 打孔引擎画面绘制在主窗口身后的原生窗口（透明孔透出）；弹幕/字幕 canvas 悬浮其上 */}
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

      {/* V2 候选列表（低置信度/失败时展示，手动绑定兜底） */}
      {matchCandidates.length > 0 && (
        <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="danmaku-search-popup w-80 player-glass-panel z-50 p-4 max-h-[60vh] overflow-auto">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-white/90 font-medium">候选弹幕源（点击绑定）</span>
            <button onClick={() => setMatchCandidates([])} className="text-white/50 hover:text-white text-xs">✕</button>
          </div>
          {matchLogs.length > 0 && (
            <details className="mb-2 text-[10px] text-white/40">
              <summary className="cursor-pointer">匹配日志 ({matchLogs.length})</summary>
              <pre className="whitespace-pre-wrap mt-1 max-h-24 overflow-auto">{matchLogs.join('\n')}</pre>
            </details>
          )}
          <div className="space-y-1">
            {matchCandidates.map((c, i) => (
              <button
                key={`${c.episodeId}-${i}`}
                onClick={() => { void handleSelectCandidate(c) }}
                className="w-full text-left px-3 py-2 rounded hover:bg-white/5 transition-colors"
              >
                <div className="text-xs text-white/90 truncate">{c.animeTitle}</div>
                <div className="text-[11px] text-white/60 truncate">{c.episodeTitle}</div>
                <div className="text-[10px] text-white/40">
                  {c.source} · 分数 {c.score.toFixed(2)}
                  {c.seasonHint != null ? ` · 季${c.seasonHint}` : ''}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

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
          danmakuComments={danmakuComments}
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
