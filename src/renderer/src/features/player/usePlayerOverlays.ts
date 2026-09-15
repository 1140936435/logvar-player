import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes, formatTime } from '../../player'
import type { PlayerContextMenuState } from '../../player'

/**
 * 覆盖层与杂项 UI 状态（从 pages/Player.tsx 拆出）：
 * 右键菜单 / 影片信息 / 视频源信息 / 控制栏自动隐藏 / 截图 / 画中画 / 置顶 / toast。
 * 依赖 videoRef 与 mpvCtl（由 usePlaybackEngine 提供），通过 mpv 家族走截图 IPC、HTML5 走 canvas 兜底。
 */
export function usePlayerOverlays(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  itemId: string | null
  getMpvCtl: () => typeof window.api.mpv | typeof window.api.mpvRender
}) {
  const { videoRef, itemId, getMpvCtl } = options

  const [statusMsg, setStatusMsg] = useState('')
  const [speedToast, setSpeedToast] = useState('')
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  const [contextMenu, setContextMenu] = useState<PlayerContextMenuState>({ x: 0, y: 0, visible: false })
  const [infoOverlay, setInfoOverlay] = useState(false)
  const [itemInfo, setItemInfo] = useState<Record<string, unknown> | null>(null)
  const [itemInfoLoading, setItemInfoLoading] = useState(false)
  const [videoSourceInfo, setVideoSourceInfo] = useState<Record<string, string> | null>(null)

  // 沉浸式控制栏 — 鼠标不动 3 秒自动隐藏
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)

  const showStatus = (msg: string): void => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(''), 2000)
  }

  const resetAutoHide = useCallback((): void => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
    }, 3000)
  }, [])

  useEffect(() => {
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
  }, [])

  const handleMouseMove = (): void => {
    resetAutoHide()
  }

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
  const handleCloseVideoInfo = (): void => { setVideoSourceInfo(null) }

  // P2: 截图
  const handleScreenshot = useCallback(async (): Promise<void> => {
    try {
      const result = await getMpvCtl().screenshotSave()
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
  }, [getMpvCtl, videoRef])

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
  }, [videoRef, showStatus])
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
  }, [videoRef])

  return {
    showStatus,
    statusMsg,
    speedToast,
    setSpeedToast,
    alwaysOnTop,
    setAlwaysOnTop,
    pipActive,
    contextMenu,
    infoOverlay,
    itemInfo,
    itemInfoLoading,
    videoSourceInfo,
    controlsVisible,
    handleMouseMove,
    handleContextMenu,
    handleCloseContextMenu,
    handleShowInfo,
    handleCloseInfo,
    handleVideoSourceInfo,
    handleCloseVideoInfo,
    handleScreenshot,
    handlePictureInPicture
  }
}
