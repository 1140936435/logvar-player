import { useCallback, useEffect, useRef, useState } from 'react'
import type { SubtitleCue, SubtitleTrack } from '../../player'

/**
 * 字幕状态与行为（从 pages/Player.tsx 拆出）。
 * - 字幕轨道/当前字幕/显示设置全部集中于此
 * - renderSubtitleAtTime 由时间总线驱动（两种引擎共用二分查找）
 * - startPlayback 通过 subtitleCuesRef/subtitleGenRef/activeSubIdxRef/setSubtitleTracks 协作
 */
export function usePlayerSubtitles(options: {
  closeSubtitlePopup: () => void
}) {
  const { closeSubtitlePopup } = options

  const subtitleCuesRef = useRef<SubtitleCue[][]>([])
  const activeSubIdxRef = useRef(-1)
  const currentSubTextRef = useRef('')
  // 修复 R-S6: 字幕拉取代号，切集/切源递增，旧 .then() 检测到过期即丢弃，避免覆盖新字幕
  const subtitleGenRef = useRef(0)

  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([])
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(-1)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [currentSubtitleText, setCurrentSubtitleText] = useState('')
  const [subtitleBottom, setSubtitleBottom] = useState(8) // 字幕距底部百分比
  const [subtitleFontSize, setSubtitleFontSize] = useState(22) // 字幕字体大小 px
  const [subtitleLetterSpacing, setSubtitleLetterSpacing] = useState(0) // 字间距 px
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false)

  // 字幕显示设置持久化加载（原 DanmakuEngine 初始化 effect 中一并加载）
  useEffect(() => {
    void (async () => {
      try {
        const savedSubBottom = await window.api.store.get('subtitleBottom')
        if (savedSubBottom !== null) setSubtitleBottom(Number(savedSubBottom))
        const savedSubFontSize = await window.api.store.get('subtitleFontSize')
        if (savedSubFontSize !== null) setSubtitleFontSize(Number(savedSubFontSize))
        const savedSubLetterSpacing = await window.api.store.get('subtitleLetterSpacing')
        if (savedSubLetterSpacing !== null) setSubtitleLetterSpacing(Number(savedSubLetterSpacing))
      } catch (err) {
        console.error('[usePlayerSubtitles] 字幕设置加载失败:', err instanceof Error ? err.message : String(err))
      }
    })()
  }, [])

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
    closeSubtitlePopup()
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

  return {
    // state
    subtitleTracks,
    setSubtitleTracks,
    activeSubtitleIndex,
    subtitleCues,
    setSubtitleCues,
    setActiveSubtitleIndex,
    currentSubtitleText,
    subtitleBottom,
    subtitleFontSize,
    subtitleLetterSpacing,
    subtitleSettingsOpen,
    setSubtitleSettingsOpen,
    // refs（供 startPlayback / 时间总线协作）
    subtitleCuesRef,
    activeSubIdxRef,
    currentSubTextRef,
    subtitleGenRef,
    // handlers
    renderSubtitleAtTime,
    handleSubtitleSelect,
    handleSubtitleBottomChange,
    handleSubtitleFontSizeChange,
    handleSubtitleLetterSpacingChange,
    handleSubtitleSettingsReset
  }
}
