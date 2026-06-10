function Player(): JSX.Element {
  return (
    <div className="h-full flex flex-col bg-black">
      {/* 视频区域（mpv 嵌入位置） */}
      <div className="flex-1 relative" id="mpv-container">
        {/* 弹幕 Canvas 层将在这里渲染 */}
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
          <div className="text-center">
            <div className="text-6xl mb-4">🎬</div>
            <div>选择要播放的视频</div>
          </div>
        </div>
      </div>

      {/* 播放控制栏 */}
      <div className="h-16 bg-zinc-900 border-t border-zinc-800 flex items-center px-4 gap-4 shrink-0">
        {/* 播放/暂停 */}
        <button className="text-2xl hover:text-purple-400 transition-colors">▶</button>

        {/* 进度条 */}
        <div className="flex-1 h-1 bg-zinc-700 rounded-full cursor-pointer">
          <div className="h-full bg-purple-500 rounded-full" style={{ width: '0%' }} />
        </div>

        {/* 时间 */}
        <span className="text-sm text-zinc-400 font-mono">00:00 / 00:00</span>

        {/* 音量 */}
        <button className="hover:text-purple-400 transition-colors">🔊</button>

        {/* 弹幕开关 */}
        <button className="hover:text-purple-400 transition-colors px-2 py-1 border border-zinc-600 rounded text-sm">
          💬 弹幕
        </button>

        {/* 全屏 */}
        <button className="hover:text-purple-400 transition-colors">⛶</button>
      </div>
    </div>
  )
}

export default Player
