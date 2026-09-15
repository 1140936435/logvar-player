import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import {
  DanmakuSearchPanel,
  DanmakuSettingsPanel,
  MediaInfoOverlays,
  PlayerContextMenu,
  SubtitleSettingsPanel,
  PlayerPopups,
  PlayerControls
} from '../../player'
import { usePlaybackProgress } from './usePlaybackProgress'
import { usePlayerEpisodes } from './usePlayerEpisodes'
import { usePlayerSubtitles } from './usePlayerSubtitles'
import { usePlayerDanmaku } from './usePlayerDanmaku'
import { usePlayerOverlays } from './usePlayerOverlays'
import { usePlaybackEngine } from './usePlaybackEngine'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { PlayerSurface } from './PlayerSurface'

// 播放页组装层：URL 参数解析 + hooks 编排 + 布局拼装（时间更新走 store 节流，不带动整页重绘）
function PlayerPage(): ReactElement {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const itemId = searchParams.get('itemId') || ''
  const itemName = searchParams.get('name') || '未知视频'
  const localFile = searchParams.get('file') || ''
  const baseUrl = searchParams.get('base') || 'http://localhost:8096'
  const seriesName = searchParams.get('seriesName') || ''
  const seriesId = searchParams.get('seriesId') || ''
  const seasonId = searchParams.get('seasonId') || ''

  const [videoLoadKey, setVideoLoadKey] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const blurBgCanvasRef = useRef<HTMLCanvasElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const progress = usePlaybackProgress({ itemId, localFile, itemName, baseUrl, seriesName })
  const { duration, playbackRate, isPlaying, volume, buffered, loading, error } = progress
  const { volumeRef, playbackRateRef, preMuteVolumeRef, playerActions } = progress
  const episodes = usePlayerEpisodes({
    itemId, localFile, seriesId, seasonId,
    setVideoLoadKey, playerActions, navigate, searchParams
  })
  const { episodeList, currentEpisodeIndex, episodePopup, setEpisodePopup, folderVideos } = episodes
  const { setEpisodeList, setCurrentEpisodeIndex, episodeFetchDone, handleSwitchEpisode } = episodes
  const [volumePopup, setVolumePopup] = useState(false)
  const [speedPopup, setSpeedPopup] = useState(false)
  const [subtitlePopup, setSubtitlePopup] = useState(false)
  const subtitles = usePlayerSubtitles({
    closeSubtitlePopup: () => setSubtitlePopup(false)
  })
  const {
    subtitleTracks, activeSubtitleIndex,
    currentSubtitleText, subtitleBottom, subtitleFontSize, subtitleLetterSpacing,
    subtitleSettingsOpen, setSubtitleSettingsOpen,
    subtitleCuesRef, activeSubIdxRef, currentSubTextRef, subtitleGenRef,
    renderSubtitleAtTime, handleSubtitleSelect,
    handleSubtitleBottomChange, handleSubtitleFontSizeChange,
    handleSubtitleLetterSpacingChange, handleSubtitleSettingsReset,
    setSubtitleTracks, setSubtitleCues, setActiveSubtitleIndex
  } = subtitles

  const [isPortrait, setIsPortrait] = useState(false)
  const [displayMode, setDisplayMode] = useState<'contain' | 'cover'>('contain')
  const isPortraitRef = useRef(isPortrait)
  isPortraitRef.current = isPortrait
  const displayModeRef = useRef(displayMode)
  displayModeRef.current = displayMode
  // 覆盖层（右键菜单/信息/截图/PiP/置顶/控制栏自动隐藏）—— getMpvCtl 延迟绑定，引擎初始化后指向真实 mpvCtl
  const mpvCtlRef = useRef<() => typeof window.api.mpv | typeof window.api.mpvRender>(() => window.api.mpv)
  const overlays = usePlayerOverlays({
    videoRef,
    itemId: itemId || null,
    getMpvCtl: () => mpvCtlRef.current()
  })
  const {
    showStatus, speedToast, setSpeedToast,
    setAlwaysOnTop, pipActive, contextMenu, infoOverlay,
    itemInfo, itemInfoLoading, videoSourceInfo,
    controlsVisible, handleMouseMove, handleContextMenu, handleCloseContextMenu,
    handleShowInfo, handleCloseInfo, handleVideoSourceInfo, handleCloseVideoInfo,
    handleScreenshot, handlePictureInPicture
  } = overlays
  const closeAllPopups = useCallback(() => {
    setVolumePopup(false)
    setSpeedPopup(false)
    setSubtitlePopup(false)
    setSubtitleSettingsOpen(false)
    setSettingsOpen(false)
    setSearchOpen(false)
  }, [])

  const danmaku = usePlayerDanmaku({
    canvasRef, itemId, itemName, localFile, baseUrl, seriesName, seriesId, seasonId,
    episodeList, currentEpisodeIndex, episodeFetchDone,
    showStatus, closeAllPopups
  })
  const {
    danmakuEnabled, setDanmakuEnabled,
    danmakuEnabledRef, danmakuLoading, currentDanmakuCount, danmakuCountVisible,
    danmakuComments, matchCandidates, setMatchCandidates, matchLogs,
    searchOpen, setSearchOpen, searchKeyword, setSearchKeyword,
    searchResults, setSearchResults,
    searchLoading, settingsOpen, setSettingsOpen,
    danmakuOpacity, danmakuFontSize, danmakuSpeed, danmakuMaxCount,
    danmakuOffset, danmakuOffsetRef, danmakuTopBoundary, danmakuBottomBoundary,
    engineRef, handleDanmakuToggle,
    handleOpacityChange, handleFontSizeChange, handleSpeedChange, handleDensityChange,
    handleOffsetChange, handleTopBoundaryChange, handleBottomBoundaryChange,
    handleDanmakuSearch, handleOpenDanmakuSearch, handleDanmakuSelect,
    handleSelectCandidate, handleLoadLocalXml
  } = danmaku

  const engine = usePlaybackEngine({
    videoRef, blurBgCanvasRef, itemId, localFile, videoLoadKey,
    volumeRef, playbackRateRef, preMuteVolumeRef,
    danmakuEnabledRef, engineRef, isPortraitRef, displayModeRef,
    subtitle: {
      subtitleCuesRef, activeSubIdxRef, currentSubTextRef, subtitleGenRef,
      renderSubtitleAtTime, setSubtitleTracks, setSubtitleCues, setActiveSubtitleIndex
    },
    ui: { setSpeedToast, closeContextMenu: handleCloseContextMenu }
  })
  const {
    engineMode, mpvActive, windowFullscreen, mpvSlotRef, isMpvFamily, mpvCtl,
    engineSeekTo, engineSetVolume, handlePlayPause, handleSeek, handleFullscreen,
    handlePlaybackRateChange, handleVolumeChange, handleToggleMute
  } = engine
  mpvCtlRef.current = mpvCtl
  usePlayerHotkeys({
    videoRef, containerRef, isMpvFamily,
    windowFullscreen, infoOverlay,
    engineSeekTo, engineSetVolume, handlePlayPause, handleFullscreen,
    handleScreenshot, handlePictureInPicture,
    danmakuOffsetRef, handleOffsetChange,
    subtitleTracks, activeSubtitleIndex, handleSubtitleSelect,
    handleCloseInfo, setAlwaysOnTop, showStatus
  })

  const detectVideoOrientation = useCallback(() => {
    if (videoRef.current) {
      const { videoWidth, videoHeight } = videoRef.current
      if (videoWidth > 0 && videoHeight > 0) {
        const ratio = videoWidth / videoHeight
        setIsPortrait(videoHeight > videoWidth)
        console.log(`[Player] 视频方向: ${videoHeight > videoWidth ? '竖屏' : '横屏'}, 比例: ${ratio.toFixed(2)}`)
      }
    }
  }, [])

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
  useEffect(() => { containerRef.current?.focus() }, [])
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

  const episodeTitle = episodeList.length > 0 && currentEpisodeIndex >= 0
    ? (episodeList[currentEpisodeIndex]?.Name || `第 ${currentEpisodeIndex + 1} 集`)
    : undefined

  return (
    // 修复全屏黑条: 容器改为纯 relative，子元素均 absolute 定位，控件悬浮覆盖视频
    <div ref={containerRef} className={`h-full relative outline-none ${engineMode === 'mpv' && mpvActive ? 'bg-transparent' : 'bg-black'}`} tabIndex={0}>

      {/* 视频表面层（视频/字幕/弹幕状态/加载/错误/顶部信息栏） */}
      <PlayerSurface
        engineMode={engineMode}
        mpvActive={mpvActive}
        isPortrait={isPortrait}
        displayMode={displayMode}
        controlsVisible={controlsVisible}
        mpvSlotRef={mpvSlotRef}
        videoRef={videoRef}
        blurBgCanvasRef={blurBgCanvasRef}
        canvasRef={canvasRef}
        itemName={itemName}
        episodeTitle={episodeTitle}
        currentSubtitleText={currentSubtitleText}
        activeSubtitleIndex={activeSubtitleIndex}
        subtitleBottom={subtitleBottom}
        subtitleFontSize={subtitleFontSize}
        subtitleLetterSpacing={subtitleLetterSpacing}
        danmakuLoading={danmakuLoading}
        currentDanmakuCount={currentDanmakuCount}
        danmakuCountVisible={danmakuCountVisible}
        speedToast={speedToast}
        loading={loading}
        error={error}
        onNavigateBack={() => navigate(-1)}
        onContextMenu={handleContextMenu}
        onClick={handlePlayPause}
        onMouseMove={handleMouseMove}
      />
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

export default PlayerPage
