import type { ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import MpvCanvasView from '../../player/components/MpvCanvasView'
import type { EngineMode } from './usePlaybackEngine'

/**
 * 视频表面层（从 pages/Player.tsx 拆出）：
 * - 视频区域（<video> / mpv 打孔 slot / mpv-canvas 画布视图 / 弹幕 canvas / 竖屏模糊背景）
 * - 顶部信息栏、自定义字幕覆盖层、弹幕状态 badge、倍速 toast、加载/错误覆盖层
 * 纯展示组件：全部状态由 PlayerPage 注入，内部无业务副作用。
 */
export function PlayerSurface(props: {
  engineMode: EngineMode
  mpvActive: boolean
  isPortrait: boolean
  displayMode: 'contain' | 'cover'
  controlsVisible: boolean
  mpvSlotRef: React.RefObject<HTMLDivElement | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
  blurBgCanvasRef: React.RefObject<HTMLCanvasElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  itemName: string
  episodeTitle?: string
  currentSubtitleText: string
  activeSubtitleIndex: number
  subtitleBottom: number
  subtitleFontSize: number
  subtitleLetterSpacing: number
  danmakuLoading: boolean
  currentDanmakuCount: number
  danmakuCountVisible: boolean
  speedToast: string
  loading: boolean
  error: string
  onNavigateBack: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onClick: () => void
  onMouseMove: () => void
}): ReactElement {
  const {
    engineMode, mpvActive, isPortrait, displayMode, controlsVisible,
    mpvSlotRef, videoRef, blurBgCanvasRef, canvasRef,
    itemName, episodeTitle,
    currentSubtitleText, activeSubtitleIndex, subtitleBottom, subtitleFontSize, subtitleLetterSpacing,
    danmakuLoading, currentDanmakuCount, danmakuCountVisible, speedToast, loading, error,
    onNavigateBack, onContextMenu, onClick, onMouseMove
  } = props

  const transparent = engineMode === 'mpv' && mpvActive

  return (
    <div className={`absolute inset-0 overflow-hidden flex items-center justify-center ${isPortrait ? 'portrait-mode' : ''} ${transparent ? 'bg-transparent' : 'bg-black'}`} onContextMenu={onContextMenu} onClick={onClick} onMouseMove={onMouseMove}>
      {/* 顶部信息栏 */}
      <div className={`absolute top-0 left-0 right-0 z-30 transition-opacity duration-300 ease-in-out ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="player-glass-bar bg-gradient-to-b from-black/60 to-black/30 px-4 py-3 flex items-center gap-3 border-none">
          <button
            onClick={onNavigateBack}
            className="glass-btn-icon text-white/80 hover:text-white"
            title="返回"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-white font-medium truncate">
              {itemName}
            </div>
            {episodeTitle && (
              <div className="text-xs text-white/40 truncate">
                {episodeTitle}
              </div>
            )}
          </div>
        </div>
      </div>

      <div ref={mpvSlotRef} className={`relative w-full h-full ${transparent ? 'bg-transparent' : 'bg-black'}`}>
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
  )
}
