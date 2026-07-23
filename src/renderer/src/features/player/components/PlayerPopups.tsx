import type { ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import type { JellyfinItem } from '../../../../../shared/types'
import type { FolderVideo, SubtitleTrack } from '../types'

interface PlayerPopupsProps {
  episodeOpen: boolean
  episodes: JellyfinItem[]
  folderVideos: FolderVideo[]
  currentEpisodeIndex: number
  speedOpen: boolean
  playbackRate: number
  volumeOpen: boolean
  volume: number
  subtitleOpen: boolean
  subtitleTracks: SubtitleTrack[]
  activeSubtitleIndex: number
  onEpisodeClose: () => void
  onEpisodeSwitch: (index: number) => void
  onSpeedClose: () => void
  onPlaybackRateChange: (rate: number) => void
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  onSubtitleSelect: (index: number) => void
}

export function PlayerPopups({
  episodeOpen,
  episodes,
  folderVideos,
  currentEpisodeIndex,
  speedOpen,
  playbackRate,
  volumeOpen,
  volume,
  subtitleOpen,
  subtitleTracks,
  activeSubtitleIndex,
  onEpisodeClose,
  onEpisodeSwitch,
  onSpeedClose,
  onPlaybackRateChange,
  onVolumeChange,
  onToggleMute,
  onSubtitleSelect
}: PlayerPopupsProps): ReactElement {
  return (
    <>
      <AnimatePresence>
        {episodeOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-20 right-4 player-glass-panel p-3 z-50 max-h-[400px] overflow-y-auto"
          >
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/5">
              <span className="text-xs text-white/60 font-medium">剧集列表</span>
              <button onClick={onEpisodeClose} className="text-white/40 hover:text-white transition-colors"><X size={14} /></button>
            </div>
            <div className="grid grid-cols-6 gap-2" style={{ minWidth: '280px' }}>
              {episodes.length > 0 ? episodes.map((episode, index) => {
                const episodeId = episode.Id || (episode as JellyfinItem & { id?: string }).id
                const active = index === currentEpisodeIndex
                return (
                  <button
                    key={episodeId}
                    onClick={() => { onEpisodeSwitch(index); onEpisodeClose() }}
                    className={`text-xs py-1.5 px-2 rounded transition-colors truncate ${active ? 'bg-[#8b82f6] text-white shadow-[0_0_12px_rgba(139,130,246,0.3)]' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90'}`}
                    title={episode.Name || `第${index + 1}集`}
                  >
                    {index + 1}
                  </button>
                )
              }) : folderVideos.map((video, index) => (
                <button
                  key={video.path}
                  onClick={() => { onEpisodeSwitch(index); onEpisodeClose() }}
                  className={`text-xs py-1.5 px-2 rounded transition-colors truncate ${index === currentEpisodeIndex ? 'bg-[#8b82f6] text-white shadow-[0_0_12px_rgba(139,130,246,0.3)]' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90'}`}
                  title={video.name}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {speedOpen && (
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
                onClick={() => { onPlaybackRateChange(rate); onSpeedClose() }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${playbackRate === rate ? 'text-[#8b82f6] bg-white/5' : 'text-white/60 hover:bg-white/5'}`}
              >
                {rate === 1 ? '正常' : `${rate}x`}
                {playbackRate === rate && <span className="float-right text-[#8b82f6]">✓</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {volumeOpen && (
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
                onChange={(event) => onVolumeChange(Number(event.target.value))}
                className="flex-1 h-1 appearance-none bg-white/8 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button onClick={onToggleMute} className="text-[10px] text-white/40 hover:text-white/80 transition-colors">{volume === 0 ? '取消静音' : '静音'}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {subtitleOpen && (
          <motion.div
            className="fixed bottom-20 right-4 subtitle-popup player-glass-panel rounded-lg py-1 min-w-[160px] z-50"
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <button onClick={() => onSubtitleSelect(-1)} className={`w-full text-left px-4 py-2 text-xs hover:bg-white/5 flex items-center gap-2 ${activeSubtitleIndex === -1 ? 'text-[#8b82f6]' : 'text-white/70'}`}>
              <span className="w-3 text-center">{activeSubtitleIndex === -1 ? '✓' : ''}</span>
              关闭字幕
            </button>
            {subtitleTracks.map((track, index) => (
              <button key={track.index} onClick={() => onSubtitleSelect(index)} className={`w-full text-left px-4 py-2 text-xs hover:bg-white/5 flex items-center gap-2 ${activeSubtitleIndex === index ? 'text-[#8b82f6]' : 'text-white/70'}`}>
                <span className="w-3 text-center">{activeSubtitleIndex === index ? '✓' : ''}</span>
                {track.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
