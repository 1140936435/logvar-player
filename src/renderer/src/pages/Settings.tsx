function Settings(): JSX.Element {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">设置</h2>

      {/* Jellyfin 配置 */}
      <section className="mb-8 p-4 bg-zinc-900 rounded-lg border border-zinc-800">
        <h3 className="text-lg font-semibold mb-4"> Jellyfin 服务器</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">服务器地址</label>
            <input
              type="text"
              placeholder="http://192.168.1.100:8096"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm focus:outline-none focus:border-purple-500"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">API Token</label>
            <input
              type="password"
              placeholder="在 Jellyfin 控制台 → API 密钥 中获取"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm focus:outline-none focus:border-purple-500"
            />
          </div>
          <button className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-sm font-medium transition-colors">
            连接
          </button>
        </div>
      </section>

      {/* 弹幕 API 配置 */}
      <section className="mb-8 p-4 bg-zinc-900 rounded-lg border border-zinc-800">
        <h3 className="text-lg font-semibold mb-4">💬 弹幕 API</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">API 地址</label>
            <input
              type="text"
              defaultValue="http://aning.asia:9321"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>
      </section>

      {/* 弹幕默认设置 */}
      <section className="mb-8 p-4 bg-zinc-900 rounded-lg border border-zinc-800">
        <h3 className="text-lg font-semibold mb-4">弹幕显示</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">文字大小: 24px</label>
            <input type="range" min="12" max="36" defaultValue="24" className="w-full" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">显示区域: 70%</label>
            <input type="range" min="10" max="100" defaultValue="70" className="w-full" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">滚动速度</label>
            <select className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm">
              <option value="slow">慢</option>
              <option value="medium" selected>中</option>
              <option value="fast">快</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">透明度: 100%</label>
            <input type="range" min="20" max="100" defaultValue="100" className="w-full" />
          </div>
        </div>
      </section>

      {/* 播放器配置 */}
      <section className="mb-8 p-4 bg-zinc-900 rounded-lg border border-zinc-800">
        <h3 className="text-lg font-semibold mb-4">播放器</h3>
        <div className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" defaultChecked className="w-4 h-4 accent-purple-500" />
            <span className="text-sm">启用硬件解码</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" defaultChecked className="w-4 h-4 accent-purple-500" />
            <span className="text-sm">自动 HDR 色调映射</span>
          </label>
        </div>
      </section>
    </div>
  )
}

export default Settings
