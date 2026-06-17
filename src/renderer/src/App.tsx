import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { Settings, Play, Home as HomeIcon, History as HistoryIcon, Minus, X as XIcon, Copy, Sun, Moon } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState, useEffect, lazy, Suspense, type ReactElement } from 'react'
import AppLogo from './components/AppLogo'

/* 路由懒加载 — Player 最重，按需加载 */
const Home = lazy(() => import('./pages/Home'))
const Player = lazy(() => import('./pages/Player'))
const Detail = lazy(() => import('./pages/Detail'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const HistoryPage = lazy(() => import('./pages/History'))

function LoadingFallback(): ReactElement {
  return <div className="flex-1 flex items-center justify-center"><div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" /></div>
}

/* iOS 风格窗口控制按钮 */
function WindowControls(): ReactElement {
  return (
    <div className="flex items-center gap-0.5 no-drag ml-auto">
      <button
        onClick={() => window.api.window.close()}
        className="w-3 h-3 rounded-full bg-[#FF5F57] hover:brightness-90 transition-all flex items-center justify-center group"
      >
        <XIcon size={7} className="text-transparent group-hover:text-[#4A0002] transition-colors" strokeWidth={2.5} />
      </button>
      <button
        onClick={() => window.api.window.minimize()}
        className="w-3 h-3 rounded-full bg-[#FEBC2E] hover:brightness-90 transition-all flex items-center justify-center group"
      >
        <Minus size={7} className="text-transparent group-hover:text-[#5A3E00] transition-colors" strokeWidth={2.5} />
      </button>
      <button
        onClick={() => window.api.window.maximize()}
        className="w-3 h-3 rounded-full bg-[#28C840] hover:brightness-90 transition-all flex items-center justify-center group"
      >
        <Copy size={6} className="text-transparent group-hover:text-[#005500] transition-colors" strokeWidth={2.5} />
      </button>
    </div>
  )
}

function NavItem({ to, icon: Icon, label, active }: { to: string; icon: React.ElementType; label: string; active: boolean }): ReactElement {
  return (
    <Link
      to={to}
      className="no-underline no-drag"
    >
      <motion.div
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium ${
          active
            ? 'text-[var(--accent)] bg-[var(--accent-bg)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      >
        <Icon size={15} strokeWidth={active ? 2 : 1.5} />
        <span>{label}</span>
      </motion.div>
    </Link>
  )
}

function TopBar({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }): ReactElement {
  const location = useLocation()
  const isPlayer = location.pathname === '/player'

  return (
    <header
      className={`h-[52px] flex items-center px-5 shrink-0 z-50 relative drag-region ${
        isPlayer
          ? 'absolute inset-x-0 top-0'
          : 'glass-thick'
      }`}
    >
      {/* Logo */}
      <Link to="/" className="no-underline no-drag">
        <AppLogo />
      </Link>

      {/* Navigation */}
      {!isPlayer && (
        <nav className="ml-3 flex items-center gap-0.5 no-drag">
          <NavItem to="/" icon={HomeIcon} label="媒体库" active={location.pathname === '/'} />
          <NavItem to="/history" icon={HistoryIcon} label="历史" active={location.pathname === '/history'} />
          <NavItem to="/settings" icon={Settings} label="设置" active={location.pathname === '/settings'} />
        </nav>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Theme toggle */}
      {!isPlayer && (
        <motion.button
          onClick={toggleTheme}
          className="glass-btn-icon w-9 h-9 text-[var(--text-secondary)] hover:text-[var(--text-primary)] mr-2 no-drag"
          whileTap={{ scale: 0.9 }}
          aria-label={dark ? '切换亮色模式' : '切换暗色模式'}
        >
          <AnimatePresence mode="wait" initial={false}>
            {dark ? (
              <motion.div key="sun" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} transition={{ duration: 0.2 }}>
                <Sun size={18} strokeWidth={1.5} />
              </motion.div>
            ) : (
              <motion.div key="moon" initial={{ rotate: 90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -90, opacity: 0 }} transition={{ duration: 0.2 }}>
                <Moon size={18} strokeWidth={1.5} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.button>
      )}

      {/* Window controls — 所有页面都显示 */}
      <WindowControls />
    </header>
  )
}

/* 页面切换动画包裹器 */
function PageTransition({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 0.8 }}
      className="h-full"
    >
      {children}
    </motion.div>
  )
}

/* ==================== 暗色模式 Hook ==================== */
function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(() => {
    // 优先读取缓存
    const saved = localStorage.getItem('theme')
    if (saved) return saved === 'dark'
    // 跟随系统
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  const toggle = () => setDark((prev) => !prev)

  return { dark, toggle }
}

/* 应用 backdrop-filter 内联样式（绕过 Lightning CSS） */
const GLASS_SELECTORS = '.glass, .glass-thick, .glass-card, .media-card'
function applyGlassStyles() {
  document.querySelectorAll(GLASS_SELECTORS).forEach((el) => {
    const html = el as HTMLElement
    const isDark = document.documentElement.classList.contains('dark')
    if (el.classList.contains('glass')) {
      html.style.backdropFilter = isDark ? 'blur(30px) saturate(180%)' : 'blur(24px) saturate(160%)'
    } else if (el.classList.contains('glass-thick')) {
      html.style.backdropFilter = isDark ? 'blur(50px) saturate(200%)' : 'blur(40px) saturate(180%)'
    } else if (el.classList.contains('glass-card') || el.classList.contains('media-card')) {
      html.style.backdropFilter = isDark ? 'blur(24px) saturate(160%)' : 'blur(20px) saturate(150%)'
    }
    html.style.webkitBackdropFilter = html.style.backdropFilter
  })
}

/* Router 内部布局 — useLocation 必须在 BrowserRouter 内 */
function AppLayout(): ReactElement {
  const location = useLocation()
  const { dark, toggle } = useTheme()

  // 修复: Electron loadFile 产生的 file:// 路径泄漏为 pathname（如 /C:/...）
  // HashRouter 应只解析 hash，但初始加载可能出现此问题
  useEffect(() => {
    const p = location.pathname
    if (p.includes('://') || /^[A-Z]:/i.test(p) || p.endsWith('.html')) {
      window.location.hash = '#/'
    }
  }, [])

  useEffect(() => {
    applyGlassStyles()
    const observer = new MutationObserver(() => applyGlassStyles())
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return (
    <div className="h-screen flex flex-col overflow-hidden relative" style={{ background: 'var(--bg-page)' }}>
      <TopBar dark={dark} toggleTheme={toggle} />
      <main className="flex-1 overflow-auto relative z-10">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<PageTransition><Suspense fallback={<LoadingFallback />}><Home /></Suspense></PageTransition>} />
            <Route path="/detail/:itemId" element={<PageTransition><Suspense fallback={<LoadingFallback />}><Detail /></Suspense></PageTransition>} />
            <Route path="/player" element={<PageTransition><Suspense fallback={<LoadingFallback />}><Player /></Suspense></PageTransition>} />
            <Route path="/history" element={<PageTransition><Suspense fallback={<LoadingFallback />}><HistoryPage /></Suspense></PageTransition>} />
            <Route path="/settings" element={<PageTransition><Suspense fallback={<LoadingFallback />}><SettingsPage /></Suspense></PageTransition>} />
          </Routes>
        </AnimatePresence>
      </main>
    </div>
  )
}

function App(): ReactElement {
  return (
    <HashRouter>
      <AppLayout />
    </HashRouter>
  )
}

export default App
