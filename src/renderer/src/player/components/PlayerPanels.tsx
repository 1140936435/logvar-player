import type { ReactElement } from 'react'
import { X } from 'lucide-react'
import type { DanmakuSearchResult } from '../../../../shared/types'
import type { PlayerContextMenuState } from '../types'
import { formatTime } from '../utils'

interface DanmakuSearchPanelProps {
  open: boolean
  keyword: string
  loading: boolean
  results: DanmakuSearchResult[]
  hasLocalFile: boolean
  onKeywordChange: (keyword: string) => void
  onSearch: () => void
  onSelect: (result: DanmakuSearchResult) => void
  onLoadLocalXml: () => void
  onClose: () => void
}

export function DanmakuSearchPanel({
  open,
  keyword,
  loading,
  results,
  hasLocalFile,
  onKeywordChange,
  onSearch,
  onSelect,
  onLoadLocalXml,
  onClose
}: DanmakuSearchPanelProps): ReactElement | null {
  if (!open) return null

  return (
    <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="danmaku-search-popup w-72 player-glass-panel z-50 p-4">
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onSearch() }}
          placeholder="搜索弹幕"
          className="flex-1 bg-white/5 border border-white/5 rounded-md px-3 py-2 text-xs text-white/90 placeholder-white/25 focus:outline-none focus:border-[#8b82f6]/40 focus:bg-white/8"
          autoFocus
        />
        <button onClick={onSearch} disabled={loading} className="px-3 py-2 bg-[#8b82f6] hover:bg-[#7a72e5] rounded-md text-xs font-medium text-white disabled:opacity-40 transition-colors">
          {loading ? '...' : '搜索'}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6">
          <svg className="animate-spin h-5 w-5 text-[#8b82f6]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="ml-2 text-xs text-white/40">搜索中...</span>
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="max-h-60 overflow-y-auto space-y-0.5">
          {results.map((episode, index) => (
            <button key={`${episode.episodeId}-${index}`} onClick={() => onSelect(episode)} className="w-full text-left px-3 py-2 rounded hover:bg-white/5 transition-colors">
              <div className="text-xs text-white truncate">{episode.animeTitle}</div>
              <div className="text-[10px] text-white/35 mt-0.5">{episode.episodeTitle} &middot; {episode.typeDescription}</div>
            </button>
          ))}
        </div>
      )}

      {!loading && results.length === 0 && keyword.trim() && (
        <div className="text-center py-4 text-xs text-white/25">无搜索结果</div>
      )}

      {hasLocalFile && (
        <button onClick={onLoadLocalXml} className="mt-2 w-full text-[10px] text-white/30 hover:text-[#8b82f6] py-2 border-t border-white/5 transition-colors">
          加载本地 XML 弹幕
        </button>
      )}
      <button onClick={onClose} className="mt-2 w-full text-[10px] text-white/25 hover:text-white/70 py-1 transition-colors">关闭</button>
    </div>
  )
}

interface DanmakuSettingsPanelProps {
  open: boolean
  opacity: number
  fontSize: number
  speed: number
  maxCount: number
  offset: number
  topBoundary: number
  bottomBoundary: number
  onOpacityChange: (value: number) => void
  onFontSizeChange: (value: number) => void
  onSpeedChange: (value: number) => void
  onMaxCountChange: (value: number) => void
  onOffsetChange: (value: number) => void
  onTopBoundaryChange: (value: number) => void
  onBottomBoundaryChange: (value: number) => void
  onClose: () => void
}

export function DanmakuSettingsPanel({
  open,
  opacity,
  fontSize,
  speed,
  maxCount,
  offset,
  topBoundary,
  bottomBoundary,
  onOpacityChange,
  onFontSizeChange,
  onSpeedChange,
  onMaxCountChange,
  onOffsetChange,
  onTopBoundaryChange,
  onBottomBoundaryChange,
  onClose
}: DanmakuSettingsPanelProps): ReactElement | null {
  if (!open) return null

  return (
    <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="danmaku-settings-popup w-60 player-glass-panel z-50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-medium">弹幕设置</h3>
        <button onClick={onClose} className="text-white/30 hover:text-white/80 transition-colors text-sm">&times;</button>
      </div>
      <div className="space-y-4">
        <RangeSetting label="透明度" valueLabel={`${Math.round(opacity * 100)}%`} min={0} max={1} step={0.1} value={opacity} onChange={onOpacityChange} />
        <RangeSetting label="字体大小" valueLabel={`${fontSize}px`} min={12} max={48} step={1} value={fontSize} onChange={onFontSizeChange} />
        <RangeSetting label="速度" valueLabel={`${speed}px/s`} min={60} max={300} step={10} value={speed} onChange={onSpeedChange} />

        <RangeSetting label="弹幕密度" valueLabel={`${maxCount} 条`} min={50} max={500} step={50} value={maxCount} onChange={onMaxCountChange} minLabel="稀疏 (50)" maxLabel="密集 (500)" />

        <div>
          <div className="flex justify-between text-[10px] text-white/35 mb-1.5">
            <span>时间偏移</span>
            <span className={offset !== 0 ? 'text-[#8b82f6]' : ''}>{offset > 0 ? `+${offset.toFixed(1)}` : offset.toFixed(1)}s</span>
          </div>
          <input type="range" min="-30" max="30" step="0.5" value={offset} onChange={(event) => onOffsetChange(parseFloat(event.target.value))} className="w-full" />
          <div className="flex justify-between text-[9px] text-white/25 mt-1"><span>提前 (-30s)</span><span>延后 (+30s)</span></div>
          {offset !== 0 && (
            <button onClick={() => onOffsetChange(0)} className="mt-2 w-full text-[10px] text-[#8b82f6] hover:text-[#a29bfe] py-1 transition-colors">重置偏移</button>
          )}
        </div>

        <RangeSetting
          label="上边界"
          valueLabel={`${topBoundary}%`}
          min={0}
          max={100}
          step={1}
          value={topBoundary}
          onChange={(value) => onTopBoundaryChange(Math.min(value, bottomBoundary - 1))}
          minLabel="顶部"
          maxLabel="向下"
        />
        <RangeSetting
          label="下边界"
          valueLabel={`${bottomBoundary}%`}
          min={0}
          max={100}
          step={1}
          value={bottomBoundary}
          onChange={(value) => onBottomBoundaryChange(Math.max(value, topBoundary + 1))}
          minLabel="向上"
          maxLabel="底部"
        />

        <div className="flex gap-1.5 mt-1">
          <PresetButton label="全屏" onClick={() => { onTopBoundaryChange(0); onBottomBoundaryChange(100) }} />
          <PresetButton label="上半屏" onClick={() => { onTopBoundaryChange(0); onBottomBoundaryChange(50) }} />
          <PresetButton label="下半屏" onClick={() => { onTopBoundaryChange(50); onBottomBoundaryChange(100) }} />
        </div>
      </div>
    </div>
  )
}

interface RangeSettingProps {
  label: string
  valueLabel: string
  min: number
  max: number
  step: number
  value: number
  minLabel?: string
  maxLabel?: string
  onChange: (value: number) => void
}

function RangeSetting({ label, valueLabel, min, max, step, value, minLabel, maxLabel, onChange }: RangeSettingProps): ReactElement {
  return (
    <div>
      <div className="flex justify-between text-[10px] text-white/35 mb-1.5"><span>{label}</span><span>{valueLabel}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(parseFloat(event.target.value))} className="w-full" />
      {minLabel && maxLabel && <div className="flex justify-between text-[9px] text-white/25 mt-1"><span>{minLabel}</span><span>{maxLabel}</span></div>}
    </div>
  )
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return <button onClick={onClick} className="flex-1 text-[9px] py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors">{label}</button>
}

interface SubtitleSettingsPanelProps {
  open: boolean
  bottom: number
  fontSize: number
  letterSpacing: number
  onBottomChange: (value: number) => void
  onFontSizeChange: (value: number) => void
  onLetterSpacingChange: (value: number) => void
  onReset: () => void
  onClose: () => void
}

export function SubtitleSettingsPanel({
  open,
  bottom,
  fontSize,
  letterSpacing,
  onBottomChange,
  onFontSizeChange,
  onLetterSpacingChange,
  onReset,
  onClose
}: SubtitleSettingsPanelProps): ReactElement | null {
  if (!open) return null

  return (
    <div style={{ position: 'fixed', bottom: '72px', right: '20px' }} className="subtitle-settings-popup w-60 player-glass-panel z-50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-medium">字幕设置</h3>
        <button onClick={onClose} className="text-white/30 hover:text-white/80 transition-colors text-sm">&times;</button>
      </div>
      <div className="space-y-4">
        <RangeSetting label="上下位置" valueLabel={`${bottom}%`} min={0} max={30} step={1} value={bottom} onChange={onBottomChange} minLabel="靠上" maxLabel="靠下" />
        <RangeSetting label="字体大小" valueLabel={`${fontSize}px`} min={12} max={48} step={1} value={fontSize} onChange={onFontSizeChange} minLabel="小" maxLabel="大" />
        <RangeSetting label="字间距" valueLabel={`${letterSpacing}px`} min={0} max={12} step={0.5} value={letterSpacing} onChange={onLetterSpacingChange} minLabel="紧凑" maxLabel="宽松" />
        <button onClick={onReset} className="w-full text-[10px] text-[#8b82f6] hover:text-[#a29bfe] py-1 transition-colors">恢复默认</button>
      </div>
    </div>
  )
}

interface PlayerContextMenuProps {
  state: PlayerContextMenuState
  playbackRate: number
  danmakuEnabled: boolean
  onClose: () => void
  onShowInfo: () => void
  onShowVideoSourceInfo: () => void
  onPlaybackRateChange: (rate: number) => void
  onToggleDanmaku: () => void
  onOpenDanmakuSearch: () => void
  onLoadLocalXml: () => void
}

export function PlayerContextMenu({
  state,
  playbackRate,
  danmakuEnabled,
  onClose,
  onShowInfo,
  onShowVideoSourceInfo,
  onPlaybackRateChange,
  onToggleDanmaku,
  onOpenDanmakuSearch,
  onLoadLocalXml
}: PlayerContextMenuProps): ReactElement | null {
  if (!state.visible) return null

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose() }} />
      <div className="fixed z-50 w-40 player-glass-panel rounded-md py-1" style={{ left: Math.min(state.x, window.innerWidth - 170), top: Math.min(state.y, window.innerHeight - 280) }}>
        <button onClick={onShowInfo} className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 transition-colors">影片信息</button>
        <hr className="border-white/5 my-0.5" />
        <button onClick={onShowVideoSourceInfo} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">视频源信息</button>
        <div className="px-3 py-1 text-[10px] text-white/35">播放速度</div>
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
          <button key={rate} onClick={() => onPlaybackRateChange(rate)} className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${playbackRate === rate ? 'text-[#8b82f6]' : 'text-white/60 hover:bg-white/5'}`}>{rate}x</button>
        ))}
        <hr className="border-white/5 my-0.5" />
        <button onClick={() => { onToggleDanmaku(); onClose() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">{danmakuEnabled ? '关闭弹幕' : '开启弹幕'}</button>
        <button onClick={() => { onOpenDanmakuSearch(); onClose() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">搜索弹幕</button>
        <button onClick={() => { onLoadLocalXml(); onClose() }} className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 transition-colors">加载本地弹幕</button>
      </div>
    </>
  )
}

interface MediaInfoOverlaysProps {
  itemInfoOpen: boolean
  itemInfoLoading: boolean
  itemInfo: Record<string, unknown> | null
  videoSourceInfo: Record<string, string> | null
  onCloseItemInfo: () => void
  onCloseVideoSourceInfo: () => void
}

export function MediaInfoOverlays({
  itemInfoOpen,
  itemInfoLoading,
  itemInfo,
  videoSourceInfo,
  onCloseItemInfo,
  onCloseVideoSourceInfo
}: MediaInfoOverlaysProps): ReactElement {
  return (
    <>
      {itemInfoOpen && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center animate-page-in" onClick={onCloseItemInfo}>
          <div className="w-[480px] max-h-[70vh] player-glass-panel p-8 overflow-y-auto" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium">影片信息</h3>
              <button onClick={onCloseItemInfo} className="w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all text-sm">&times;</button>
            </div>
            {itemInfoLoading ? (
              <div className="flex items-center justify-center py-10"><div className="w-5 h-5 border border-[#8b82f6] border-t-transparent rounded-full animate-spin" /></div>
            ) : itemInfo ? (
              <div className="space-y-4 text-xs">
                <div className="flex justify-between"><span className="text-white/35">片名</span><span className="text-white/80">{String(itemInfo.Name ?? '-')}</span></div>
                {!!itemInfo.OriginalTitle && <div className="flex justify-between"><span className="text-white/35">原名</span><span className="text-white/50">{String(itemInfo.OriginalTitle)}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">年份</span><span className="text-white/50">{String(itemInfo.ProductionYear ?? '-')}</span></div>
                {Array.isArray(itemInfo.Genres) && itemInfo.Genres.length > 0 && <div className="flex justify-between"><span className="text-white/35">类型</span><span className="text-white/50">{itemInfo.Genres.map(String).join(' / ')}</span></div>}
                <div className="flex justify-between"><span className="text-white/35">时长</span><span className="text-white/50">{itemInfo.RunTimeTicks ? formatTime(Number(itemInfo.RunTimeTicks) / 10000000) : '-'}</span></div>
                {itemInfo.CommunityRating != null && <div className="flex justify-between"><span className="text-white/35">评分</span><span className="text-[#8b82f6] font-medium">{String(itemInfo.CommunityRating)}</span></div>}
                {itemInfo.Overview != null && <div><div className="text-white/35 mb-2">简介</div><p className="text-white/50 leading-relaxed">{String(itemInfo.Overview)}</p></div>}
              </div>
            ) : <p className="text-xs text-white/25 text-center py-10">无法获取影片信息</p>}
          </div>
        </div>
      )}

      {videoSourceInfo && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center animate-page-in" onClick={onCloseVideoSourceInfo}>
          <div className="w-[520px] max-h-[75vh] player-glass-panel p-8 overflow-y-auto" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium">视频源信息</h3>
              <button onClick={onCloseVideoSourceInfo} className="w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/5 transition-colors"><X size={15} /></button>
            </div>
            <div className="space-y-2 text-xs">
              {Object.entries(videoSourceInfo).map(([key, value]) => (
                <div key={key} className="flex justify-between py-1.5 border-b border-white/5 last:border-0">
                  <span className="text-white/40 min-w-[120px]">{key}</span>
                  <span className="text-white/80 text-right font-mono">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}