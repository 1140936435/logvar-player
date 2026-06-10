function Home(): JSX.Element {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">媒体库</h2>
        <p className="text-zinc-400">连接 Jellyfin 或打开本地文件开始播放</p>
      </div>

      {/* 快捷操作 */}
      <div className="flex gap-4 mb-8">
        <button className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium transition-colors">
          📂 打开文件
        </button>
        <button className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-medium transition-colors">
          📁 打开文件夹
        </button>
      </div>

      {/* 继续观看 */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-3 text-zinc-300">继续观看</h3>
        <div className="text-zinc-500 text-sm">暂无播放记录</div>
      </section>

      {/* 电影 */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-3 text-zinc-300">电影</h3>
        <div className="text-zinc-500 text-sm">请先在设置中连接 Jellyfin 服务器</div>
      </section>

      {/* 剧集 */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-3 text-zinc-300">剧集</h3>
        <div className="text-zinc-500 text-sm">请先在设置中连接 Jellyfin 服务器</div>
      </section>
    </div>
  )
}

export default Home
