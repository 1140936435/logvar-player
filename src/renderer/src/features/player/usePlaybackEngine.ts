import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMediaTimeBus, type MediaTimeBus } from '../../utils/mediaTimeBus'
import { usePlayerStore } from '../../utils/playerStore'
import type { DanmakuEngine } from '../../utils/danmakuEngine'
import { parseVTT, type SubtitleCue, type SubtitleTrack } from '../../player'
import { createPlaybackEngine, type EngineMode, type PlaybackEngine, type PlaybackEvent } from './engines'
import { resolveEngineMode } from './engines/select'

export type { EngineMode } from './engines'

interface SubtitleApi {
  subtitleCuesRef: React.MutableRefObject<SubtitleCue[][]>
  activeSubIdxRef: React.MutableRefObject<number>
  currentSubTextRef: React.MutableRefObject<string>
  subtitleGenRef: React.MutableRefObject<number>
  renderSubtitleAtTime: (time: number) => void
  setSubtitleTracks: (tracks: SubtitleTrack[]) => void
  setSubtitleCues: (cues: SubtitleCue[]) => void
  setActiveSubtitleIndex: (index: number) => void
}

interface UIApi {
  setSpeedToast: (msg: string) => void
  closeContextMenu: () => void
}

/**
 * 播放引擎层（从 pages/Player.tsx 拆出，P1 重构为统一引擎工厂）：
 * - 引擎偏好初始化 / 按 engineMode 创建统一 PlaybackEngine 实例
 * - 统一事件订阅：各引擎归一化的 PlaybackEvent → playerStore / timeBus / 弹幕 / 字幕
 * - timeBus 两条数据管道：mpv 家族手动时钟（事件锚点 + RAF 外推）；HTML5 直接 attachVideo
 * - 字幕预取（服务器字幕 HTML 自绘）、视频源解析、续播、控制 handlers 均面向统一 engine 接口
 * 注意：timeBus 只订阅 React state 节流结果，绝不把逐帧 timeupdate 拉进 PlayerPage 重绘。
 */
export function usePlaybackEngine(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  blurBgCanvasRef: React.RefObject<HTMLCanvasElement | null>
  itemId: string
  localFile: string
  videoLoadKey: number
  volumeRef: React.MutableRefObject<number>
  playbackRateRef: React.MutableRefObject<number>
  preMuteVolumeRef: React.MutableRefObject<number>
  danmakuEnabledRef: React.MutableRefObject<boolean>
  engineRef: React.MutableRefObject<DanmakuEngine | null>
  isPortraitRef: React.MutableRefObject<boolean>
  displayModeRef: React.MutableRefObject<'contain' | 'cover'>
  subtitle: SubtitleApi
  ui: UIApi
}) {
  const {
    videoRef, blurBgCanvasRef, itemId, localFile, videoLoadKey,
    volumeRef, playbackRateRef, preMuteVolumeRef,
    danmakuEnabledRef, engineRef, isPortraitRef, displayModeRef, subtitle, ui
  } = options
  const {
    subtitleCuesRef, activeSubIdxRef, currentSubTextRef, subtitleGenRef,
    renderSubtitleAtTime, setSubtitleTracks, setSubtitleCues, setActiveSubtitleIndex
  } = subtitle

  // 按字段订阅（shallow）：只依赖低频控制字段，currentTime 高频更新不带动本组件重渲染
  const [playState, playerActions] = usePlayerStore(
    (s) => ({ isPlaying: s.isPlaying, duration: s.duration, volume: s.volume }),
    true
  )
  const { isPlaying, duration, volume } = playState

  const [engineMode, setEngineMode] = useState<EngineMode>('html5')
  const engineModeRef = useRef<EngineMode>('html5')
  // 引擎探测是否完成（完成前不得把视频源交给引擎，避免用未定型的 html5 抢跑）
  const [engineReady, setEngineReady] = useState(false)
  const [mpvAvailable, setMpvAvailable] = useState(false)
  // mpv 已实际出画（file-loaded 后主进程揭示渲染窗口）；此期间视频区域必须切透明
  const [mpvActive, setMpvActive] = useState(false)
  // 窗口级全屏（主进程 setBounds 假全屏，替代 HTML Fullscreen API）
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  // mpv 视频画面嵌入区域（替代 <video> 的可视位置）
  const mpvSlotRef = useRef<HTMLDivElement>(null)
  const resumePosRef = useRef(parseFloat(new URLSearchParams(window.location.search).get('position') || '0'))
  const hasResumedRef = useRef(false)
  const timeBusRef = useRef<MediaTimeBus | null>(null)
  // 画布引擎（mpv-canvas）渲染参数：硬解 / HDR tone-mapping
  const mpvRenderOptsRef = useRef<{ hardwareDecode: boolean; hdrToneMapping: boolean }>({ hardwareDecode: true, hdrToneMapping: false })
  // 视频源是否已交给引擎（HTML5 src 已写入 / mpv 已 loadfile），驱动 timeBus 绑定
  const [srcReady, setSrcReady] = useState(false)

  const mpvCtl = (): typeof window.api.mpv | typeof window.api.mpvRender =>
    engineModeRef.current === 'mpv-canvas' ? window.api.mpvRender : window.api.mpv
  const isMpvFamily = (): boolean => engineModeRef.current !== 'html5'

  // 引擎偏好初始化：显式偏好 > 默认。默认在 libmpv 画布引擎（方案 C）可用时优先选用，
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
        // 选择逻辑收敛为纯函数：显式 html5 偏好优先；默认 canvas > mpv > html5；不可用自动降级
        const engine = resolveEngineMode(pref, avail, canvasAvail)
        if ((pref === 'mpv-canvas' && !canvasAvail) || (pref === 'mpv' && !avail)) {
          console.warn(`[Player] 偏好引擎 ${pref} 不可用，降级为 ${engine}`)
        }
        console.log(`[Player] 播放引擎就绪: ${engine}（偏好=${pref ?? '默认'}, mpv可用=${avail}, 画布可用=${canvasAvail}, 硬解=${mpvRenderOptsRef.current.hardwareDecode}）`)
        engineModeRef.current = engine
        setEngineMode(engine)
        setEngineReady(true)
      } catch {
        // 探测失败（IPC 不可用/超时）：兜底 html5，仍允许正常播放
        engineModeRef.current = 'html5'
        setEngineMode('html5')
        setEngineReady(true)
      }
    }
    void initEngine()
    return () => { cancelled = true }
  }, [])

  // 统一引擎实例：按 engineMode 工厂创建。引擎持有各自实现细节（<video> / mpv IPC / canvas 渲染）
  const engine = useMemo<PlaybackEngine>(() => createPlaybackEngine(engineMode, {
    videoRef,
    slotRef: mpvSlotRef,
    renderOptsRef: mpvRenderOptsRef,
    volumeRef,
    playbackRateRef
  }), [engineMode, videoRef, volumeRef, playbackRateRef])

  // 离开播放页：回收引擎资源（mpv 打孔子窗口 / 画布渲染实例 / <video> 事件与 rAF）
  useEffect(() => {
    return () => { void engine.dispose() }
  }, [engine])

  // 统一引擎事件 → playerStore / timeBus / 弹幕 / 字幕
  // （各引擎已把 mpv IPC 字符串事件与 <video> DOM 事件归一化为同一 PlaybackEvent）
  const handleEngineEvent = useCallback((event: PlaybackEvent): void => {
    const bus = timeBusRef.current
    switch (event.type) {
      case 'time':
        // mpv：手动时钟锚点；html5：attachVideo 已由 video 驱动，此处同步同值无害
        bus?.syncFromEngine({ currentTime: event.currentTime, buffered: event.buffered })
        playerActions.setCurrentTime(event.currentTime)
        break
      case 'duration': {
        const d = event.duration
        bus?.syncFromEngine({ duration: d })
        playerActions.setDuration(d)
        break
      }
      case 'play':
        playerActions.setIsPlaying(true)
        bus?.syncFromEngine({ isPlaying: true })
        break
      case 'pause':
        playerActions.setIsPlaying(false)
        bus?.syncFromEngine({ isPlaying: false })
        break
      case 'volume':
        playerActions.setVolume(event.volume)
        break
      case 'speed':
        playerActions.setPlaybackRate(event.speed)
        bus?.syncFromEngine({ playbackRate: event.speed })
        break
      case 'loaded':
        playerActions.setLoading(false)
        playerActions.setError('')
        // P1：播放态单一真源 —— 不再在 loaded 处改写 isPlaying；
        // 播放/暂停只由 play/pause 事件驱动（html5 的 DOM play / mpv 的 pause=false 归一化事件）
        // file-loaded 后主进程揭示 mpv 渲染窗口（打孔），视频区域需切透明
        if (event.active) setMpvActive(true)
        // 续播跳转（每次进入播放页仅一次）；HTML5 引擎 loaded 后自播放
        if (!hasResumedRef.current && resumePosRef.current > 0) {
          hasResumedRef.current = true
          void engine.seek(resumePosRef.current)
        }
        break
      case 'waiting':
        playerActions.setLoading(true)
        break
      case 'canplay':
        playerActions.setLoading(false)
        break
      case 'seeked':
        // 修复弹幕进度不匹配：seek 后重置弹幕引擎 position（HTML5 路径）
        if (danmakuEnabledRef.current && engineRef.current) {
          engineRef.current.seek(event.currentTime)
        }
        break
      case 'error':
        playerActions.setError(event.message)
        playerActions.setLoading(false)
        setMpvActive(false)
        break
      case 'inactive':
        // stop/idle/quit：同步暂停态并恢复黑底，防止打孔透出桌面
        playerActions.setIsPlaying(false)
        bus?.syncFromEngine({ isPlaying: false })
        setMpvActive(false)
        break
    }
  }, [engine, playerActions, engineRef, danmakuEnabledRef])

  // 订阅统一引擎事件
  useEffect(() => {
    return engine.onEvent(handleEngineEvent)
  }, [engine, handleEngineEvent])

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

  /**
   * 统一播放入口：拿到可播放 URL 后交给统一引擎实例。
   * 引擎各自实现加载细节（html5 写 <video>.src / mpv 创建嵌入子窗口并 loadfile / canvas 渲染实例）。
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

    // 统一交给引擎：成功即 srcReady（HTML5 src 已写入 / mpv 已 loadfile / canvas 已 play）
    playerActions.setLoading(true)
    playerActions.setError('')
    try {
      await engine.load({
        url,
        isLocal,
        subtitles: subtitleList,
        renderOptions: mpvRenderOptsRef.current
      })
      setSrcReady(true)
    } catch (err) {
      playerActions.setError(err instanceof Error ? err.message : String(err))
      playerActions.setLoading(false)
    }
  }, [engine, playerActions, subtitleCuesRef, subtitleGenRef, setSubtitleTracks, setSubtitleCues, setActiveSubtitleIndex, activeSubIdxRef])

  // 视频源解析 effect：本地文件 / Jellyfin 播放地址 → startPlayback
  useEffect(() => {
    let cancelled = false
    playerActions.setLoading(true); playerActions.setError('')
    // 引擎探测未完成时挂起加载：探测完成后 engineReady 变化会重跑本 effect，用定型引擎加载
    if (!engineReady) return () => { cancelled = true }
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
  // videoLoadKey：切集递增后重新加载；engineMode：引擎初始化完成/切换后重新加载；engineReady：探测完成后才放行加载
  }, [itemId, localFile, videoLoadKey, engineMode, engineReady, startPlayback, playerActions])

  // 时间总线：mpv 家族手动时钟（事件锚点 + RAF 外推）；HTML5 直接 attach <video>
  // （数据管道适配：不属于引擎控制细节，保留双路径以维持原有性能特征与缓冲计算）
  useEffect(() => {
    if (engineMode === 'html5') {
      const video = videoRef.current; if (!video) return
      if (timeBusRef.current) {
        timeBusRef.current.destroy()
      }
      timeBusRef.current = createMediaTimeBus()
      timeBusRef.current.attachVideo(video)

      // 性能优化：弹幕引擎使用 RAF 订阅，每帧更新不经过 React state，避免 60fps 重渲染
      let frameCount = 0
      // 竖屏模糊背景画布尺寸缓存：尺寸未变时不再重设 canvas.width/height
      // （重设会重新分配 backing store 并重置上下文状态，代价远高于一次 drawImage）
      let blurCanvasW = 0
      let blurCanvasH = 0
      const unsubRAF = timeBusRef.current.subscribeRAF((time, playbackRate) => {
        if (danmakuEnabledRef.current && engineRef.current) {
          engineRef.current.update(time, playbackRate)
        }
        frameCount++
        if (frameCount % 8 === 0 && isPortraitRef.current && displayModeRef.current === 'contain') {
          const blurCanvas = blurBgCanvasRef.current
          const blurCtx = blurCanvas?.getContext('2d')
          if (blurCanvas && blurCtx && video.videoWidth > 0) {
            const w = Math.floor(video.videoWidth / 4)
            const h = Math.floor(video.videoHeight / 4)
            if (blurCanvasW !== w || blurCanvasH !== h) {
              blurCanvas.width = w
              blurCanvas.height = h
              blurCanvasW = w
              blurCanvasH = h
            }
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

      return () => {
        unsubscribe()
        unsubRAF()
        timeBusRef.current?.destroy()
        timeBusRef.current = null
      }
    }

    // ===== mpv 家族：手动时钟 =====
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
    // R-S2: danmakuEnabled/isPortrait/displayMode 通过 ref 读取（danmakuEnabledRef 等），
    // 不再进入依赖 —— 开关弹幕/切竖屏/切显示模式不会销毁重建整条 timeBus
  }, [srcReady, engineMode, playerActions, renderSubtitleAtTime, videoRef, blurBgCanvasRef, danmakuEnabledRef, engineRef, isPortraitRef, displayModeRef])

  // ==================== 控制（统一引擎分发） ====================

  /** 跳转到绝对时间（秒），HTML5 / mpv 家族共用 */
  const engineSeekTo = useCallback((target: number): void => {
    const t = Math.max(0, target)
    void engine.seek(t)
    // 立即同步本地时钟与弹幕位置，不等事件回环（进度条/弹幕无延迟感）
    timeBusRef.current?.syncFromEngine({ currentTime: t })
    engineRef.current?.seek(t)
    playerActions.forceNotifyCurrentTime()
  }, [engine, playerActions, engineRef])

  /** 设置音量：入口统一 clamp 引擎音量语义。
   * - HTML5：DOM <video> volume 上限 100，入口即 clamp 到 100，store/DOM/volume 事件三者在
   *   setVolume(150) 等越界调用时也不会出现「store 暂存 150、DOM 停在 1.0、事件回环才收敛」的中间态；
   *   也避免 DOM 已处于 1.0 时 volumechange 不触发导致 store 永久停在越界值。
   * - mpv 家族：原生支持 150 上限，保留放大能力。
   */
  const engineSetVolume = useCallback((value: number): void => {
    const max = engineModeRef.current === 'html5' ? 100 : 150
    const v = Math.max(0, Math.min(max, Math.round(value)))
    playerActions.setVolume(v)
    void engine.setVolume(v)
  }, [engine, playerActions])

  const handlePlayPause = (): void => {
    if (isPlaying) void engine.pause()
    else void engine.play()
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    engineSeekTo(ratio * duration)
  }

  const handleFullscreen = (): void => {
    // 原生窗口全屏（主进程 setFullScreen）；状态以 onFullscreenChanged 事件为真源
    void window.api.window.toggleFullscreen().then((res) => {
      if (res?.success) setWindowFullscreen(!!res.data)
    }).catch(() => {})
  }

  const handlePlaybackRateChange = (rate: number): void => {
    void engine.setSpeed(rate)
    timeBusRef.current?.syncFromEngine({ playbackRate: rate })
    playerActions.setPlaybackRate(rate)
    ui.closeContextMenu()
    ui.setSpeedToast(`${rate}x`); setTimeout(() => ui.setSpeedToast(''), 2000)
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
    // HTML5：引擎内切换 muted，volumechange 事件回环更新 UI
    engine.toggleMute?.()
  }

  return {
    engine,
    engineMode,
    mpvAvailable,
    mpvActive,
    windowFullscreen,
    mpvSlotRef,
    isMpvFamily,
    mpvCtl,
    engineSeekTo,
    engineSetVolume,
    handlePlayPause,
    handleSeek,
    handleFullscreen,
    handlePlaybackRateChange,
    handleVolumeChange,
    handleToggleMute
  }
}
