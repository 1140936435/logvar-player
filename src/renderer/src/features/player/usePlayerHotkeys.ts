import { useEffect } from 'react'

/**
 * 播放页键盘快捷键（从 pages/Player.tsx 的 handleKeyDown 拆出）。
 * 行为与原实现逐键一致：方向键跳转/音量、空格播放暂停、f 全屏、s 截图、
 * p 置顶、d 画中画、[ ] 弹幕偏移、v 字幕循环、Esc 关闭信息覆盖层/退出全屏。
 */
export function usePlayerHotkeys(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isMpvFamily: () => boolean
  currentTime: number
  duration: number
  volume: number
  windowFullscreen: boolean
  infoOverlay: boolean
  engineSeekTo: (target: number) => void
  engineSetVolume: (value: number) => void
  handlePlayPause: () => void
  handleFullscreen: () => void
  handleScreenshot: () => void
  handlePictureInPicture: () => void
  danmakuOffsetRef: React.MutableRefObject<number>
  handleOffsetChange: (value: number) => void
  subtitleTracks: { label: string }[]
  activeSubtitleIndex: number
  handleSubtitleSelect: (index: number) => void
  handleCloseInfo: () => void
  setAlwaysOnTop: (v: boolean) => void
  showStatus: (msg: string) => void
}) {
  const {
    videoRef, containerRef, isMpvFamily, currentTime, duration, volume, windowFullscreen,
    infoOverlay, engineSeekTo, engineSetVolume, handlePlayPause, handleFullscreen,
    handleScreenshot, handlePictureInPicture, danmakuOffsetRef, handleOffsetChange,
    subtitleTracks, activeSubtitleIndex, handleSubtitleSelect, handleCloseInfo,
    setAlwaysOnTop, showStatus
  } = options

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
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
    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [
    containerRef, videoRef, isMpvFamily, currentTime, duration, volume, windowFullscreen,
    infoOverlay, engineSeekTo, engineSetVolume, handlePlayPause, handleFullscreen,
    handleScreenshot, handlePictureInPicture, danmakuOffsetRef, handleOffsetChange,
    subtitleTracks, activeSubtitleIndex, handleSubtitleSelect, handleCloseInfo,
    setAlwaysOnTop, showStatus
  ])
}
