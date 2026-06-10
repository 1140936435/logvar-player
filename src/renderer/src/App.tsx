import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Player from './pages/Player'
import Settings from './pages/Settings'

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col overflow-hidden">
        {/* 顶部导航栏 */}
        <header className="h-12 flex items-center px-4 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm shrink-0">
          <h1 className="text-lg font-semibold bg-gradient-to-r from-purple-400 to-pink-500 bg-clip-text text-transparent">
            🎬 LogVar Player
          </h1>
          <nav className="ml-auto flex gap-4 text-sm">
            <a href="/" className="hover:text-purple-400 transition-colors">媒体库</a>
            <a href="/settings" className="hover:text-purple-400 transition-colors">设置</a>
          </nav>
        </header>

        {/* 主内容区 */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/player" element={<Player />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
