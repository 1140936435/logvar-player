import { useState, useEffect, useCallback, useMemo, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ServerConfig as ApiServerConfig, ServerInfo, ServerTestResult as ApiServerTestResult } from '../../shared/preload-types'
import type { JellyfinServerInfo } from '../../shared/types'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Database, Plug, WifiOff, Save, Loader2, CheckCircle,
  MessageCircleMore, Radar, MonitorPlay, Info,
  ChevronDown, Key, Link as LinkIcon, CirclePlus, Trash2, Settings as SettingsIcon,
  CircleDot
} from 'lucide-react'

/* ==================== 类型 ==================== */

interface DanmakuTestResult {
  success: boolean
  error?: string
  detail?: string
  elapsed: number
  animeCount?: number
  epCount?: number
}

type ServerConfig = ApiServerConfig
type ServerTestResult = ApiServerTestResult

/* ==================== 毛玻璃亚克力卡片 ==================== */

function GlassCard({ title, icon: Icon, children }: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
}): ReactElement {
  return (
    <motion.div
      className="glass-thick rounded-[var(--radius-2xl)] overflow-hidden"
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="flex items-center gap-3 px-7 pt-7 pb-4">
        <div className="w-9 h-9 rounded-[var(--radius-md)] bg-[var(--accent-bg)] flex items-center justify-center flex-shrink-0">
          <Icon size={18} className="text-[var(--accent)]" strokeWidth={1.5} />
        </div>
        <h2 className="text-[17px] font-semibold text-[var(--text-primary)] tracking-tight">{title}</h2>
      </div>
      <div className="mx-7 h-px bg-[var(--separator)]" />
      <div className="p-7 space-y-6">
        {children}
      </div>
    </motion.div>
  )
}

/* ==================== iOS 可折叠区块 ==================== */

function CollapseSection({ title, subtitle, icon: Icon, defaultOpen = true, children }: {
  title: string
  subtitle?: string
  icon: React.ElementType
  defaultOpen?: boolean
  children: React.ReactNode
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-t border-[var(--separator)]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 py-4 text-left group"
      >
        <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--accent-bg)] flex items-center justify-center flex-shrink-0">
          <Icon size={15} className="text-[var(--accent)]" strokeWidth={1.5} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium text-[var(--text-primary)]">{title}</div>
          {subtitle && <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 truncate">{subtitle}</div>}
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="flex-shrink-0"
        >
          <ChevronDown size={16} className="text-[var(--text-quaternary)]" />
        </motion.div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="pb-2 space-y-5">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ==================== 标签 + 输入行 ==================== */

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <div>
      <label className="block text-[13px] text-[var(--text-secondary)] font-medium mb-2">
        {label}
        {hint && <span className="font-normal text-[var(--text-quaternary)] ml-1">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

/* ==================== Settings 主组件 ==================== */

function Settings(): ReactElement {
  // 多服务器管理
  const navigate = useNavigate()
  const [servers, setServers] = useState<ServerConfig[]>([])
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [serverForm, setServerForm] = useState({ name: '', url: '', token: '' })
  const [serverConnecting, setServerConnecting] = useState(false)
  const [serverTesting, setServerTesting] = useState(false)
  const [serverTestResult, setServerTestResult] = useState<ServerTestResult | null>(null)
  const [serverStatus, setServerStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)

  // 弹幕 API
  const [danmakuPrimary, setDanmakuPrimary] = useState('')
  const [danmakuMirrors, setDanmakuMirrors] = useState('')
  const [danmakuTestResult, setDanmakuTestResult] = useState<DanmakuTestResult | null>(null)
  const [danmakuTesting, setDanmakuTesting] = useState(false)
  const [danmakuSaveMsg, setDanmakuSaveMsg] = useState('')
  const [danmakuInfo, setDanmakuInfo] = useState('')

  // 网络代理

  // 播放器
  const [hardwareDecode, setHardwareDecode] = useState(true)
  const [hdrToneMapping, setHdrToneMapping] = useState(false)
  const [playerSaveMsg, setPlayerSaveMsg] = useState('')

  const loadServers = useCallback(async (): Promise<void> => {
    try {
      const listResult = await window.api.server.list()
      if (listResult.success && listResult.data) {
        setServers(listResult.data as ServerConfig[])
      }
      const activeResult = await window.api.server.getActive()
      if (activeResult.success && activeResult.data) {
        const d = activeResult.data as ServerInfo
        setActiveServerId(d.id)
      }
    } catch { /* ignore */ }
  }, [])

  const handleTestServer = useCallback(async (): Promise<void> => {
    if (!serverForm.url.trim() || !serverForm.token.trim()) return
    setServerTesting(true)
    setServerTestResult(null)
    try {
      const result = await window.api.server.test(serverForm.url.trim(), serverForm.token.trim())
      setServerTestResult(result as ServerTestResult)
    } catch (err) { setServerTestResult({ success: false, error: err instanceof Error ? err.message : String(err), elapsed: 0 }) }
    setServerTesting(false)
  }, [serverForm.url, serverForm.token])

  const handleSaveServer = useCallback(async (): Promise<void> => {
    if (!serverForm.url.trim() || !serverForm.token.trim()) return
    try {
      if (editingServer) {
        await window.api.server.update({
          id: editingServer.id,
          name: serverForm.name.trim() || 'Jellyfin',
          url: serverForm.url.trim(),
          token: serverForm.token.trim()
        })
        setServerStatus({ type: 'success', message: '服务器已更新' })
      } else {
        const result = await window.api.server.add({
          name: serverForm.name.trim() || 'Jellyfin',
          url: serverForm.url.trim(),
          token: serverForm.token.trim()
        })
        if (result.success && result.data) {
          const newServer = result.data as ServerConfig
          setServerStatus({ type: 'success', message: '服务器已添加' })
          handleConnectServer(newServer.id)
        }
      }
      setShowAddForm(false)
      setEditingServer(null)
      setServerForm({ name: '', url: '', token: '' })
      setServerTestResult(null)
      await loadServers()
      setTimeout(() => setServerStatus(null), 3000)
    } catch (err) {
      setServerStatus({ type: 'error', message: err instanceof Error ? err.message : '操作失败' })
    }
  }, [serverForm, editingServer, loadServers])

  const handleConnectServer = useCallback(async (id: string): Promise<void> => {
    setServerConnecting(true)
    setServerStatus({ type: 'info', message: '正在连接...' })
    try {
      const result = await window.api.server.switch(id)
      if (result.success) {
        const info = result.data as JellyfinServerInfo
        setActiveServerId(id)
        const server = servers.find(s => s.id === id)
        setServerStatus({ type: 'success', message: `已连接 - ${info.ServerName || server?.name || 'Jellyfin'}` })
        await loadServers()
        // 导航回 Home 页面，触发媒体库刷新
        navigate('/')
      } else {
        setServerStatus({ type: 'error', message: result.error || '连接失败' })
      }
    } catch (err) {
      setServerStatus({ type: 'error', message: err instanceof Error ? err.message : '连接失败' })
    }
    setServerConnecting(false)
  }, [servers, loadServers, navigate])

  const handleRemoveServer = useCallback(async (id: string): Promise<void> => {
    if (!confirm('确定要删除此服务器吗？')) return
    try {
      await window.api.server.remove(id)
      await loadServers()
      if (activeServerId === id) {
        setActiveServerId(null)
        setServerStatus({ type: 'info', message: '已断开连接' })
      }
    } catch { /* ignore */ }
  }, [activeServerId, loadServers])

  const handleEditServer = useCallback((server: ServerConfig): void => {
    setEditingServer(server)
    setServerForm({ name: server.name, url: server.url, token: server.token })
    setShowAddForm(true)
    setServerTestResult(null)
  }, [])

  useEffect(() => {
    loadServers()

    window.api.danmaku.getConfig().then((cfg) => {
      setDanmakuPrimary(cfg.primary)
      setDanmakuMirrors(cfg.mirrors.join('\n'))
    }).catch(() => {})

    // 加载播放器设置
    window.api.store.get('player').then((data: any) => {
      if (data) {
        if (typeof data.hardwareDecode === 'boolean') setHardwareDecode(data.hardwareDecode)
        if (typeof data.hdrToneMapping === 'boolean') setHdrToneMapping(data.hdrToneMapping)
      }
    }).catch(() => {})
  }, [])

  const handleDanmakuTest = async (): Promise<void> => {
    const url = danmakuPrimary.trim()
    if (!url) return
    setDanmakuTesting(true)
    setDanmakuTestResult(null)
    setDanmakuInfo('')
    try {
      const result = await window.api.danmaku.testApi(url)
      setDanmakuTestResult(result)
      if (result.success) {
        setDanmakuInfo(`主 API 可用 - ${result.elapsed}ms - 测试关键词返回 ${result.animeCount ?? 0} 部 ${result.epCount ?? 0} 集`)
      } else {
        setDanmakuInfo('主 API 不可用，将自动尝试备用地址')
      }
    } catch (err) { setDanmakuTestResult({ success: false, error: String(err), elapsed: 0 }) }
    setDanmakuTesting(false)
  }

  const handleDanmakuSave = async (): Promise<void> => {
    const mirrors = danmakuMirrors.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    await window.api.danmaku.setConfig({ primary: danmakuPrimary.trim(), mirrors })
    setDanmakuSaveMsg('已保存')
    setTimeout(() => setDanmakuSaveMsg(''), 2000)
  }

  const savePlayerSettings = useCallback(async (hw?: boolean, hdr?: boolean): Promise<void> => {
    const currentHw = hw ?? hardwareDecode
    const currentHdr = hdr ?? hdrToneMapping
    try {
      await window.api.store.set('player', { hardwareDecode: currentHw, hdrToneMapping: currentHdr })
      setPlayerSaveMsg('已保存')
      setTimeout(() => setPlayerSaveMsg(''), 2000)
    } catch { /* ignore */ }
  }, [hardwareDecode, hdrToneMapping])

  const activeServer = useMemo(() => servers.find(s => s.id === activeServerId), [servers, activeServerId])

  return (
    <div className="w-full flex justify-center">
      <motion.div
        className="px-8 py-8 w-full max-w-[1100px]"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        {/* 页面标题 */}
        <div className="mb-10">
          <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight">设置</h1>
          <p className="text-[15px] text-[var(--text-secondary)] mt-1">配置你的播放器、媒体源和弹幕偏好</p>
        </div>

        {/* ======== 双栏布局 ======== */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

          {/* ======== 左栏：Jellyfin 服务器 ======== */}
          <GlassCard title="Jellyfin 服务器" icon={Database}>
            {/* 连接状态 */}
            <AnimatePresence>
              {serverStatus && (
                <motion.div
                  className={`px-4 py-3 rounded-[var(--radius-md)] text-[13px] flex items-center gap-2.5 ${
                    serverStatus.type === 'success' ? 'status-success' :
                    serverStatus.type === 'error' ? 'status-error' :
                    'status-info'
                  }`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  {serverStatus.type === 'success' ? <CheckCircle size={16} /> :
                   serverStatus.type === 'error' ? <WifiOff size={16} /> :
                   <Loader2 size={16} className="animate-spin" />}
                  {serverStatus.message}
                </motion.div>
              )}
            </AnimatePresence>

            {/* 服务器列表 */}
            <div className="space-y-3">
              {servers.length === 0 && !showAddForm && (
                <div className="text-center py-8">
                  <Database size={32} className="mx-auto text-[var(--text-quaternary)] mb-3" />
                  <p className="text-[14px] text-[var(--text-tertiary)] mb-1">还没有保存的服务器</p>
                  <p className="text-[12px] text-[var(--text-quaternary)]">点击下方按钮添加你的第一个 Jellyfin 服务器</p>
                </div>
              )}

              {servers.map((server) => (
                <div
                  key={server.id}
                  className={`p-4 rounded-[var(--radius-lg)] border transition-colors ${
                    server.id === activeServerId
                      ? 'border-[var(--accent)] bg-[var(--accent-bg)]/50'
                      : 'border-[var(--separator)] bg-[var(--bg-elevated)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {server.id === activeServerId ? (
                        <CircleDot size={18} className="text-[var(--accent)] flex-shrink-0" />
                      ) : (
                        <Database size={18} className="text-[var(--text-quaternary)] flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-[var(--text-primary)] truncate">{server.name}</span>
                          {server.id === activeServerId && (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-[var(--accent)] text-white rounded-full">当前</span>
                          )}
                        </div>
                        <p className="text-[12px] text-[var(--text-tertiary)] truncate mt-0.5">{server.url}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {server.id !== activeServerId && (
                        <motion.button
                          onClick={() => handleConnectServer(server.id)}
                          disabled={serverConnecting}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--accent)] disabled:opacity-40"
                          whileTap={{ scale: 0.9 }}
                          title="连接"
                        >
                          <Plug size={15} />
                        </motion.button>
                      )}
                      <motion.button
                        onClick={() => handleEditServer(server)}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]"
                        whileTap={{ scale: 0.9 }}
                        title="编辑"
                      >
                        <SettingsIcon size={14} />
                      </motion.button>
                      <motion.button
                        onClick={() => handleRemoveServer(server.id)}
                        className="p-1.5 rounded-lg hover:bg-[var(--error-bg)] text-[var(--text-quaternary)] hover:text-[var(--error)]"
                        whileTap={{ scale: 0.9 }}
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </motion.button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 添加/编辑表单 */}
            <AnimatePresence>
              {showAddForm && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--accent)]/30 bg-[var(--bg-elevated)] space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[14px] font-medium text-[var(--text-primary)]">
                        {editingServer ? '编辑服务器' : '添加服务器'}
                      </h3>
                      <button
                        onClick={() => { setShowAddForm(false); setEditingServer(null); setServerForm({ name: '', url: '', token: '' }); setServerTestResult(null) }}
                        className="text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                      >
                        取消
                      </button>
                    </div>

                    <Field label="服务器名称" hint="可选">
                      <input
                        type="text"
                        value={serverForm.name}
                        onChange={(e) => setServerForm({ ...serverForm, name: e.target.value })}
                        placeholder="我的 Jellyfin"
                        className="ios-input"
                      />
                    </Field>

                    <Field label="服务器地址">
                      <div className="relative">
                        <LinkIcon size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                        <input
                          type="text"
                          value={serverForm.url}
                          onChange={(e) => setServerForm({ ...serverForm, url: e.target.value })}
                          placeholder="http://192.168.1.100:8096"
                          className="ios-input !pl-10"
                        />
                      </div>
                    </Field>

                    <Field label="API Token" hint="Jellyfin 控制台 → API 密钥">
                      <div className="relative">
                        <Key size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                        <input
                          type="password"
                          value={serverForm.token}
                          onChange={(e) => setServerForm({ ...serverForm, token: e.target.value })}
                          placeholder="输入你的 API Token"
                          className="ios-input !pl-10"
                        />
                      </div>
                    </Field>

                    {/* 测试结果 */}
                    {serverTestResult && (
                      <div className={`px-4 py-3 rounded-[var(--radius-md)] text-[12px] ${
                        serverTestResult.success ? 'status-success' : 'status-error'
                      }`}>
                        {serverTestResult.success ? (
                          <div className="flex items-center gap-2">
                            <CheckCircle size={14} />
                            连接成功 — {serverTestResult.data?.ServerName} v{serverTestResult.data?.Version} ({serverTestResult.elapsed}ms)
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <WifiOff size={14} />
                            {serverTestResult.error}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <motion.button
                        onClick={handleTestServer}
                        disabled={serverTesting || !serverForm.url.trim() || !serverForm.token.trim()}
                        className="ios-btn ios-btn-secondary flex-1"
                        whileTap={{ scale: 0.96 }}
                      >
                        {serverTesting ? <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> : <Radar size={15} strokeWidth={1.5} />}
                        {serverTesting ? '测试中...' : '测试连接'}
                      </motion.button>
                      <motion.button
                        onClick={handleSaveServer}
                        disabled={!serverForm.url.trim() || !serverForm.token.trim()}
                        className="ios-btn ios-btn-primary flex-1"
                        whileTap={{ scale: 0.96 }}
                      >
                        <Save size={15} strokeWidth={1.5} />
                        {editingServer ? '保存修改' : '添加服务器'}
                      </motion.button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 添加按钮 */}
            {!showAddForm && (
              <motion.button
                onClick={() => { setShowAddForm(true); setEditingServer(null); setServerForm({ name: '', url: '', token: '' }); setServerTestResult(null) }}
                className="ios-btn ios-btn-secondary w-full"
                whileTap={{ scale: 0.96 }}
              >
                <CirclePlus size={16} strokeWidth={1.5} />
                添加服务器
              </motion.button>
            )}
          </GlassCard>

          {/* ======== 右栏：弹幕 + 播放器 ======== */}
          <div className="space-y-8">

            {/* ---- 弹幕设置 ---- */}
            <GlassCard title="弹幕" icon={MessageCircleMore}>
              <div className="space-y-5">
                <p className="text-[12px] text-[var(--text-tertiary)] mb-1">{danmakuPrimary || 'DandanPlay API'}</p>
                <Field label="主 API 地址">
                  <input
                    type="text"
                    value={danmakuPrimary}
                    onChange={(e) => setDanmakuPrimary(e.target.value)}
                    placeholder="https://api.dandanplay.net"
                    className="ios-input"
                  />
                </Field>

                <div className="flex items-center gap-3 mt-1 mb-3">
                  <motion.button
                    onClick={handleDanmakuTest}
                    disabled={danmakuTesting || !danmakuPrimary.trim()}
                    className={danmakuTesting || !danmakuPrimary.trim() ? 'ios-btn ios-btn-secondary opacity-40 cursor-not-allowed' : 'ios-btn ios-btn-secondary'}
                    whileTap={(danmakuTesting || !danmakuPrimary.trim()) ? {} : { scale: 0.96 }}
                  >
                    {danmakuTesting ? <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> : <Radar size={15} strokeWidth={1.5} />}
                    {danmakuTesting ? '测试中...' : '测试连接'}
                  </motion.button>
                  {danmakuTestResult && (
                    <span className={`text-[13px] flex items-center gap-1.5 ${danmakuTestResult.success ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                      {danmakuTestResult.success ? <><CheckCircle size={14} strokeWidth={1.5} /> OK {danmakuTestResult.elapsed}ms</> : <><WifiOff size={14} strokeWidth={1.5} /> {danmakuTestResult.error}</>}
                    </span>
                  )}
                </div>

                {danmakuTestResult && !danmakuTestResult.success && danmakuTestResult.detail && (
                  <div className="px-4 py-3 rounded-[var(--radius-md)] bg-[var(--error-bg)]">
                    <p className="text-[12px] text-[var(--error)] break-all font-mono leading-relaxed">{danmakuTestResult.detail}</p>
                  </div>
                )}

                <Field label="备用 API 地址" hint="每行一个">
                  <textarea
                    value={danmakuMirrors}
                    onChange={(e) => setDanmakuMirrors(e.target.value)}
                    placeholder="https://danmu.smilion.cn"
                    rows={3}
                    className="ios-textarea"
                  />
                </Field>

                <div className="flex items-center gap-3 mt-1">
                  <motion.button
                    onClick={handleDanmakuSave}
                    disabled={!danmakuPrimary.trim()}
                    className={!danmakuPrimary.trim() ? 'ios-btn ios-btn-primary opacity-40 cursor-not-allowed' : 'ios-btn ios-btn-primary'}
                    whileTap={!danmakuPrimary.trim() ? {} : { scale: 0.96 }}
                  >
                    <Save size={15} strokeWidth={1.5} />
                    保存配置
                  </motion.button>
                  {danmakuSaveMsg && (
                    <motion.span
                      className="text-[13px] text-[var(--success)] flex items-center gap-1.5"
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                    >
                      <CheckCircle size={14} strokeWidth={1.5} /> {danmakuSaveMsg}
                    </motion.span>
                  )}
                </div>

                {danmakuInfo && (
                  <div className="px-4 py-3 rounded-[var(--radius-md)] bg-[var(--bg-input)]">
                    <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">{danmakuInfo}</p>
                  </div>
                )}
              </div>
            </GlassCard>

            {/* ---- 播放器设置 ---- */}
            <GlassCard title="播放器" icon={MonitorPlay}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">启用硬件解码</div>
                  <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">使用 GPU 加速视频解码，降低 CPU 占用</div>
                </div>
                <button
                  onClick={() => { const next = !hardwareDecode; setHardwareDecode(next); savePlayerSettings(next, undefined) }}
                  className={`ios-toggle ${hardwareDecode ? 'active' : ''}`}
                  aria-label="切换硬件解码"
                />
              </div>

              <div className="h-px bg-[var(--separator)]" />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">自动 HDR 色调映射</div>
                  <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">播放 HDR 内容时自动进行色彩映射</div>
                </div>
                <button
                  onClick={() => { const next = !hdrToneMapping; setHdrToneMapping(next); savePlayerSettings(undefined, next) }}
                  className={`ios-toggle ${hdrToneMapping ? 'active' : ''}`}
                  aria-label="切换HDR色调映射"
                />
              </div>

              <div className="h-px bg-[var(--separator)]" />

              {/* 保存提示 */}
              {playerSaveMsg && (
                <motion.div
                  className="flex items-center gap-2 text-[13px] text-[var(--success)]"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                >
                  <CheckCircle size={14} strokeWidth={1.5} /> {playerSaveMsg}
                </motion.div>
              )}

              <div className="h-px bg-[var(--separator)]" />

              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--bg-input)] flex items-center justify-center flex-shrink-0">
                  <Info size={15} className="text-[var(--text-tertiary)]" strokeWidth={1.5} />
                </div>
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-tertiary)]">视频渲染器</div>
                  <div className="text-[12px] text-[var(--text-quaternary)] mt-0.5">内置 HTML5 Video 渲染器</div>
                </div>
              </div>
            </GlassCard>

          </div>
          {/* 右栏结束 */}

        </div>
        {/* 双栏布局结束 */}

        <div className="h-16" />
      </motion.div>
    </div>
  )
}

export default Settings



