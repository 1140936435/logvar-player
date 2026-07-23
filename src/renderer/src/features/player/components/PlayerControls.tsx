import type { MouseEvent, ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Gauge, List, Volume1, Volume2, VolumeX } from 'lucide-react'
import { formatTime } from '../utils'

interface PlayerControlsProps {
  visible: boolean
  isPortrait: boolean
  isPlaying: boolean
  displayMode: 'contain' | 'cover'
  episodeCount: number
  currentEpisodeIndex: number
  currentTime: number
  duration: number
  buffered: number
  playbackRate: number
  volume: number
  subtitleTrackCount: number
  activeSubtitleIndex: number
  danmakuEnabled: boolean
  danmakuOffset: number
  pipActive: boolean
  subtitleSettingsOpen: boolean
  onMouseMove: () => void
  onPlayPause: () => void
  onPreviousEpisode: () => void
  onNextEpisode: () => void
  onToggleEpisodePopup: () => void
  onSeek: (event: MouseEvent<HTMLDivElement>) => void
  onToggleSpeedPopup: () => void
  onToggleVolumePopup: () => void
  onToggleSubtitlePopup: () => void
  onToggleSubtitleSettings: () => void
  onToggleDanmaku: () => void
  onOpenDanmakuSearch: () => void
  onResetDanmakuOffset: () => void
  onToggleDanmakuSettings: () => void
  onScreenshot: () => void
  onPictureInPicture: () => void
  onFullscreen: () => void
  onToggleDisplayMode: () => void
}

export function PlayerControls({
  visible,
  isPortrait,
  isPlaying,
  displayMode,
  episodeCount,
  currentEpisodeIndex,
  currentTime,
  duration,
  buffered,
  playbackRate,
  volume,
  subtitleTrackCount,
  activeSubtitleIndex,
  danmakuEnabled,
  danmakuOffset,
  pipActive,
  subtitleSettingsOpen,
  onMouseMove,
  onPlayPause,
  onPreviousEpisode,
  onNextEpisode,
  onToggleEpisodePopup,
  onSeek,
  onToggleSpeedPopup,
  onToggleVolumePopup,
  onToggleSubtitlePopup,
  onToggleSubtitleSettings,
  onToggleDanmaku,
  onOpenDanmakuSearch,
  onResetDanmakuOffset,
  onToggleDanmakuSettings,
  onScreenshot,
  onPictureInPicture,
  onFullscreen,
  onToggleDisplayMode
}: PlayerControlsProps): ReactElement {
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0

  /* ==================== 进度条组件（复用） ==================== */
  const progressBar = (
    <div className={`flex items-center cursor-pointer group relative ${isPortrait ? 'w-full h-5' : 'flex-1 h-6'}`} onClick={onSeek}>
      <div className="absolute left-0 right-0 h-[2px] bg-white/5 rounded-full group-hover:h-[4px] transition-all">
        <div className="h-full bg-white/10 rounded-full" style={{ width: `${bufferedPercent}%` }} />
        <div className="h-full bg-[#8b82f6] rounded-full absolute top-0 left-0" style={{ width: `${progressPercent}%` }} />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-[#8b82f6] rounded-full opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `${progressPercent}%` }} />
      </div>
    </div>
  )

  /* ==================== 播放按钮 ==================== */
  const playBtn = (
    <button onClick={onPlayPause} className="glass-btn-sm text-white/80 hover:text-white shrink-0" title={isPlaying ? '暂停' : '播放'}>
      {isPlaying ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
      ) : (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
      )}
    </button>
  )

  /* ==================== 时间显示 ==================== */
  const timeDisplay = (
    <span className="text-xs text-white/40 font-mono tabular-nums whitespace-nowrap">
      {formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(duration)}
    </span>
  )

  /* ==================== 倍速按钮 ==================== */
  const speedBtn = (
    <div className="speed-popup">
      <button onClick={onToggleSpeedPopup} className={`glass-btn-sm text-xs font-medium shrink-0 ${playbackRate !== 1 ? 'text-[#8b82f6]' : 'text-white/60 hover:text-white/80'}`} title="播放速度">
        <span className="flex items-center gap-1"><Gauge size={12} />{playbackRate}x</span>
      </button>
    </div>
  )

  /* ==================== 音量按钮 ==================== */
  const volumeBtn = (
    <div className="volume-popup">
      <button onClick={onToggleVolumePopup} className="glass-btn-icon text-white/50 hover:text-white/80 shrink-0" title="音量">
        {volume === 0 ? <VolumeX size={16} /> : volume < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  )

  /* ==================== 字幕按钮 ==================== */
  const subtitleBtns = (
    <>
      {subtitleTrackCount > 0 && (
        <button onClick={onToggleSubtitlePopup} className={`glass-btn-icon shrink-0 ${activeSubtitleIndex >= 0 ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`} title="字幕轨道">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h2M11 15h6M7 11h10"/></svg>
        </button>
      )}
      {activeSubtitleIndex >= 0 && (
        <button onClick={onToggleSubtitleSettings} className={`glass-btn-icon shrink-0 ${subtitleSettingsOpen ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`} title="字幕设置">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>
        </button>
      )}
    </>
  )

  /* ==================== 弹幕按钮 ==================== */
  const danmakuBtns = (
    <>
      <button onClick={onToggleDanmaku} className={`glass-btn-sm text-xs shrink-0 ${danmakuEnabled ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/70'}`} title="弹幕">弹</button>
      <button onClick={onOpenDanmakuSearch} className="glass-btn-icon text-white/50 hover:text-white/80 shrink-0" title="搜索弹幕">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
      {danmakuOffset !== 0 && (
        <button onClick={onResetDanmakuOffset} className="glass-btn-sm text-[10px] text-[#8b82f6] hover:text-[#a29bfe] shrink-0" title={`弹幕偏移 ${danmakuOffset > 0 ? '+' : ''}${danmakuOffset.toFixed(1)}s，点击重置`}>
          {danmakuOffset > 0 ? '+' : ''}{danmakuOffset.toFixed(1)}s
        </button>
      )}
      <button onClick={onToggleDanmakuSettings} className="glass-btn-icon text-white/50 hover:text-white/80 shrink-0" title="弹幕设置">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      </button>
    </>
  )

  /* ==================== 截图 / PiP / 全屏 ==================== */
  const actionBtns = (
    <>
      <button onClick={onScreenshot} className="glass-btn-icon text-white/50 hover:text-white/80 shrink-0" title="截图 (S)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </button>
      <button onClick={onPictureInPicture} className={`glass-btn-icon shrink-0 ${pipActive ? 'text-[#8b82f6]' : 'text-white/50 hover:text-white/80'}`} title="画中画 (D)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill={pipActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="11" y="9" width="9" height="7" rx="1" fill={pipActive ? 'currentColor' : 'none'} opacity="0.7"/></svg>
      </button>
      <button onClick={onFullscreen} className="glass-btn-icon text-white/50 hover:text-white/80 shrink-0" title="全屏">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </>
  )

  /* ==================== 显示模式切换按钮（竖屏专用） ==================== */
  const displayModeBtn = isPortrait ? (
    <button onClick={onToggleDisplayMode} className={`glass-btn-sm text-xs shrink-0 ${displayMode === 'cover' ? 'text-[#8b82f6]' : 'text-white/60 hover:text-white/80'}`} title={displayMode === 'contain' ? '切换为全屏填充' : '切换为完整显示'}>
      {displayMode === 'contain' ? '完整' : '填充'}
    </button>
  ) : null

  /* ==================== 剧集切换 ==================== */
  const episodeNav = episodeCount > 0 ? (
    <div className="flex items-center gap-1.5 shrink-0">
      <button onClick={onPreviousEpisode} disabled={currentEpisodeIndex <= 0} className="glass-btn-sm text-white/60 hover:text-white/80 disabled:opacity-20 disabled:cursor-not-allowed" title="上一集">
        <ChevronLeft size={16} />
      </button>
      <span className="text-xs text-[#8b82f6] font-medium tabular-nums whitespace-nowrap min-w-[60px] text-center">
        {currentEpisodeIndex + 1}/{episodeCount}
      </span>
      <button onClick={onNextEpisode} disabled={currentEpisodeIndex >= episodeCount - 1} className="glass-btn-sm text-white/60 hover:text-white/80 disabled:opacity-20 disabled:cursor-not-allowed" title="下一集">
        <ChevronRight size={16} />
      </button>
      <button onClick={onToggleEpisodePopup} className="glass-btn-sm text-white/60 hover:text-white/80 flex items-center gap-1" title="剧集列表">
        <List size={14} />
      </button>
    </div>
  ) : null

  /* ==================== 横屏布局（保持原样） ==================== */
  if (!isPortrait) {
    return (
      <div className={`absolute bottom-0 left-0 right-0 player-glass-bar h-16 flex items-center px-5 gap-5 z-20 transition-opacity duration-300 ease-in-out ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onMouseMove={onMouseMove}>
        {playBtn}
        {episodeNav}
        {progressBar}
        {timeDisplay}
        {speedBtn}
        {volumeBtn}
        {subtitleBtns}
        {danmakuBtns}
        {actionBtns}
      </div>
    )
  }

  /* ==================== 竖屏布局（专属适配） ==================== */
  return (
    <div className={`absolute bottom-0 left-0 right-0 player-glass-bar flex flex-col px-4 py-3 gap-2 z-20 transition-opacity duration-300 ease-in-out ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onMouseMove={onMouseMove}>
      {/* 第一行：进度条 */}
      <div className="w-full">{progressBar}</div>
      {/* 第二行：播放控制 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onPlayPause} className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/20 transition-colors" title={isPlaying ? '暂停' : '播放'}>
            {isPlaying ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
            )}
          </button>
          {episodeNav}
          <span className="text-xs text-white/40 font-mono tabular-nums whitespace-nowrap">
            {formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(duration)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {displayModeBtn}
          {speedBtn}
          {volumeBtn}
          {subtitleBtns}
          {danmakuBtns}
          {actionBtns}
        </div>
      </div>
    </div>
  )
}
