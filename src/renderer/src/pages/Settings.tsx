import { useState, useEffect, useCallback, useMemo, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
// 修复点 1.21: preload-types 实际上没有导出 ServerInfo/ServerTestResult，只有 ServerConfig。
// ServerInfo / ServerTestResult 是 Settings 里内聚的本地类型，自行定义。
import type { ServerConfig as ApiServerConfig, EmbyTestResponse } from '../../../shared/preload-types'
import type { JellyfinServerInfo, ServerType } from '../../../shared/types'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Database, Plug, WifiOff, Save, Loader2, CheckCircle,
  MessageCircleMore, Radar, MonitorPlay, Info,
  ChevronDown, Key, Link as LinkIcon, CirclePlus, Trash2, Settings as SettingsIcon,
  CircleDot, Sparkles, User, Lock, Server
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
// 修复点 1.21: server.getActive() 返回的 data = { id: string; server: ApiServerConfig|null }
type ServerInfo = { id: string; server: ApiServerConfig | null }
// 修复点 1.21: server.test() 返回 ApiResponse<void>（无业务信息），Settings UI 扩展为带 elapsed 及可选 ServerName/Version 的结构
type ServerTestResult = {
  success: boolean
  error?: string
  elapsed?: number
  data?: { ServerName?: string; Version?: string }
}

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
  // 服务类型：'jellyfin' 使用 API Token；'emby' 使用账号密码
  const [serverType, setServerType] = useState<ServerType>('jellyfin')
  // 通用字段：name / url；jellyfin 用 token；emby 用 username / password
  // 测试成功后 emby 还会暂存 loginResult（含 token/userId），供保存时使用
  const [serverForm, setServerForm] = useState({ name: '', url: '', token: '', username: '', password: '' })
  const [embyLoginResult, setEmbyLoginResult] = useState<{ token: string; userId: string } | null>(null)
  const [serverConnecting, setServerConnecting] = useState(false)
  const [serverTesting, setServerTesting] = useState(false)
  const [serverTestResult, setServerTestResult] = useState<ServerTestResult | null>(null)
  const [serverStatus, setServerStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)

  // 弹幕 API
  const [danmakuPrimary, setDanmakuPrimary] = useState('')
  const [danmakuMirrors, setDanmakuMirrors] = useState('')
  const [danmakuAppId, setDanmakuAppId] = useState('')
  const [danmakuAppSecret, setDanmakuAppSecret] = useState('')
  const [danmakuTestResult, setDanmakuTestResult] = useState<DanmakuTestResult | null>(null)
  const [danmakuTesting, setDanmakuTesting] = useState(false)
  const [danmakuSaveMsg, setDanmakuSaveMsg] = useState('')
  const [danmakuInfo, setDanmakuInfo] = useState('')

  // 网络代理

  // 播放器
  const [hardwareDecode, setHardwareDecode] = useState(true)
  const [hdrToneMapping, setHdrToneMapping] = useState(false)
  const [playerSaveMsg, setPlayerSaveMsg] = useState('')

  // 最近入库
  const [recentlyAddedEnabled, setRecentlyAddedEnabled] = useState(true)
  const [recentlyAddedCount, setRecentlyAddedCount] = useState(12)
  const [recentlyAddedSpeed, setRecentlyAddedSpeed] = useState(1)
  const [recentlyAddedSaveMsg, setRecentlyAddedSaveMsg] = useState('')

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
    if (!serverForm.url.trim()) return
    setServerTesting(true)
    setServerTestResult(null)
    setEmbyLoginResult(null)
    try {
      if (serverType === 'emby') {
        if (!serverForm.username.trim() || !serverForm.password) return
        const result = await window.api.server.testEmby({
          url: serverForm.url.trim(),
          username: serverForm.username.trim(),
          password: serverForm.password
        }) as EmbyTestResponse
        // 测试成功后保存 token/userId 供"添加服务器"使用
        if (result.success && result.data) {
          // 调用 emby.login 获取完整 token/userId（testEmby 仅返回校验信息）
          const loginRes = await window.api.emby.login(
            serverForm.url.trim(),
            serverForm.username.trim(),
            serverForm.password
          )
          if (loginRes.success && loginRes.data) {
            setEmbyLoginResult({ token: loginRes.data.token, userId: loginRes.data.userId })
          }
        }
        setServerTestResult({
          success: result.success,
          error: result.error,
          elapsed: result.elapsed,
          data: result.data ? { ServerName: result.data.ServerName, Version: result.data.Version } : undefined
        })
      } else {
        if (!serverForm.token.trim()) return
        const result = await window.api.server.test(serverForm.url.trim(), serverForm.token.trim())
        setServerTestResult(result as ServerTestResult)
      }
    } catch (err) {
      setServerTestResult({ success: false, error: err instanceof Error ? err.message : String(err), elapsed: 0 })
    }
    setServerTesting(false)
  }, [serverForm.url, serverForm.token, serverForm.username, serverForm.password, serverType])

  const handleSaveServer = useCallback(async (): Promise<void> => {
    if (!serverForm.url.trim()) return
    try {
      if (serverType === 'emby') {
        // Emby：必须先测试成功拿到 token/userId 才能保存
        if (!embyLoginResult) {
          setServerStatus({ type: 'error', message: '请先点击「测试连接」验证账号密码' })
          return
        }
        if (!serverForm.username.trim() || !serverForm.password) {
          setServerStatus({ type: 'error', message: '请填写账号和密码' })
          return
        }
        if (editingServer) {
          // 编辑模式下更新 Emby 服务器（仅 name/url/账号密码/token/userId 可变）
          // 复用 server.update 更新基础字段，再用 store 直接写回 type/username/password/userId
          await window.api.server.update({
            id: editingServer.id,
            name: serverForm.name.trim() || `Emby (${serverForm.username.trim()})`,
            url: serverForm.url.trim(),
            token: embyLoginResult.token
          })
          // 直接更新 servers 数组中的 Emby 专属字段
          const listRes = await window.api.server.list()
          if (listRes.success && listRes.data) {
            const updated = listRes.data.map((s) => {
              if (s.id === editingServer.id) {
                return {
                  ...s,
                  type: 'emby' as ServerType,
                  username: serverForm.username.trim(),
                  password: serverForm.password,
                  userId: embyLoginResult.userId,
                  token: embyLoginResult.token,
                  url: serverForm.url.trim(),
                  name: serverForm.name.trim() || `Emby (${serverForm.username.trim()})`
                }
              }
              return s
            })
            await window.api.store.set('jellyfin:servers', updated)
          }
          setServerStatus({ type: 'success', message: '服务器已更新' })
        } else {
          const result = await window.api.server.addEmby({
            name: serverForm.name.trim() || `Emby (${serverForm.username.trim()})`,
            url: serverForm.url.trim(),
            username: serverForm.username.trim(),
            password: serverForm.password,
            token: embyLoginResult.token,
            userId: embyLoginResult.userId
          })
          if (result.success && result.data) {
            const newServer = result.data as ServerConfig
            setServerStatus({ type: 'success', message: 'Emby 服务器已添加' })
            handleConnectServer(newServer.id)
          } else {
            setServerStatus({ type: 'error', message: result.error || '添加失败' })
            return
          }
        }
      } else {
        // Jellyfin：使用原有逻辑
        if (!serverForm.token.trim()) return
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
      }
      setShowAddForm(false)
      setEditingServer(null)
      setServerForm({ name: '', url: '', token: '', username: '', password: '' })
      setServerTestResult(null)
      setEmbyLoginResult(null)
      await loadServers()
      setTimeout(() => setServerStatus(null), 3000)
    } catch (err) {
      setServerStatus({ type: 'error', message: err instanceof Error ? err.message : '操作失败' })
    }
  }, [serverForm, editingServer, loadServers, serverType, embyLoginResult])

  const handleConnectServer = useCallback(async (id: string): Promise<void> => {
    setServerConnecting(true)
    setServerStatus({ type: 'info', message: '正在连接...' })
    try {
      const result = await window.api.server.switch(id)
      if (result.success) {
        // 修复点 1.22: server.switch() 的 data 是 void/undefined，不能直接转 JellyfinServerInfo
        // 要先转 unknown 中转。这里 info 实际没依赖 data 内容，只有 fallback server.name 所以没问题。
        const info = (result.data as unknown as JellyfinServerInfo) ?? ({} as JellyfinServerInfo)
        setActiveServerId(id)
        const server = servers.find(s => s.id === id)
        const fallbackName = server?.name || (server?.type === 'emby' ? 'Emby' : 'Jellyfin')
        setServerStatus({ type: 'success', message: `已连接 - ${info.ServerName || fallbackName}` })
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
    setServerType(server.type || 'jellyfin')
    setServerForm({
      name: server.name,
      url: server.url,
      token: server.token,
      username: server.username || '',
      password: server.password || ''
    })
    // 编辑模式下清空登录缓存，要求用户重新测试以刷新 token
    setEmbyLoginResult(null)
    setShowAddForm(true)
    setServerTestResult(null)
  }, [])

  useEffect(() => {
    loadServers()

    window.api.danmaku.getConfig().then((cfg) => {
      setDanmakuPrimary(cfg.primary)
      setDanmakuMirrors(cfg.mirrors.join('\n'))
      if (cfg.appId) setDanmakuAppId(cfg.appId)
      if (cfg.appSecretHint) setDanmakuInfo(`已保存密钥: ${cfg.appSecretHint}`)
    }).catch(() => {})

    // 加载播放器设置
    window.api.store.get('player').then((saved: unknown) => {
      const data = saved as { hardwareDecode?: boolean; hdrToneMapping?: boolean } | null
      if (data) {
        if (typeof data.hardwareDecode === 'boolean') setHardwareDecode(data.hardwareDecode)
        if (typeof data.hdrToneMapping === 'boolean') setHdrToneMapping(data.hdrToneMapping)
      }
    }).catch(() => {})

    // 加载最近入库配置
    window.api.recentlyAdded.getConfig().then((result) => {
      if (result.success && result.data) {
        setRecentlyAddedEnabled(result.data.enabled)
        setRecentlyAddedCount(result.data.displayCount)
        setRecentlyAddedSpeed(result.data.scrollSpeed)
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
      if (result.data) {
        setDanmakuTestResult(result.data)
        if (result.data.success) {
          setDanmakuInfo(`主 API 可用 - ${result.data.elapsed}ms - 测试关键词返回 ${result.data.animeCount ?? 0} 部 ${result.data.epCount ?? 0} 集`)
        } else {
          setDanmakuInfo('主 API 不可用，将自动尝试备用地址')
        }
      }
    } catch (err) { setDanmakuTestResult({ success: false, error: String(err), elapsed: 0 }) }
    setDanmakuTesting(false)
  }

  const handleDanmakuSave = async (): Promise<void> => {
    const mirrors = danmakuMirrors.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    const updates: { primary: string; mirrors: string[]; appId?: string; appSecret?: string } = {
      primary: danmakuPrimary.trim(),
      mirrors
    }
    if (danmakuAppId.trim()) updates.appId = danmakuAppId.trim()
    if (danmakuAppSecret.trim() && danmakuAppSecret.trim() !== '••••') updates.appSecret = danmakuAppSecret.trim()
    await window.api.danmaku.setConfig(updates)
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

  // 保存最近入库配置
  const saveRecentlyAddedSettings = useCallback(async (updates: {
    enabled?: boolean
    displayCount?: number
    scrollSpeed?: number
  }): Promise<void> => {
    try {
      await window.api.recentlyAdded.saveConfig(updates)
      setRecentlyAddedSaveMsg('已保存')
      setTimeout(() => setRecentlyAddedSaveMsg(''), 2000)
    } catch { /* ignore */ }
  }, [])

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

          {/* ======== 左栏：媒体服务器（Jellyfin / Emby） ======== */}
          <GlassCard title="媒体服务器" icon={Server}>
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
                  <Server size={32} className="mx-auto text-[var(--text-quaternary)] mb-3" />
                  <p className="text-[14px] text-[var(--text-tertiary)] mb-1">还没有保存的服务器</p>
                  <p className="text-[12px] text-[var(--text-quaternary)]">点击下方按钮添加你的第一个 Jellyfin 或 Emby 服务器</p>
                </div>
              )}

              {servers.map((server) => {
                const isEmby = server.type === 'emby'
                return (
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
                        <Server size={18} className="text-[var(--text-quaternary)] flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[14px] font-medium text-[var(--text-primary)] truncate">{server.name}</span>
                          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${
                            isEmby
                              ? 'bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/30'
                              : 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                          }`}>
                            {isEmby ? 'Emby' : 'Jellyfin'}
                          </span>
                          {server.id === activeServerId && (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-[var(--accent)] text-white rounded-full">当前</span>
                          )}
                        </div>
                        <p className="text-[12px] text-[var(--text-tertiary)] truncate mt-0.5">
                          {isEmby && server.username ? `${server.username} @ ` : ''}{server.url}
                        </p>
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
                )
              })}
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
                        onClick={() => {
                          setShowAddForm(false)
                          setEditingServer(null)
                          setServerForm({ name: '', url: '', token: '', username: '', password: '' })
                          setServerType('jellyfin')
                          setServerTestResult(null)
                          setEmbyLoginResult(null)
                        }}
                        className="text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                      >
                        取消
                      </button>
                    </div>

                    {/* 服务类型切换 — 编辑模式下锁定（避免类型混淆） */}
                    <div>
                      <label className="block text-[13px] text-[var(--text-secondary)] font-medium mb-2">服务类型</label>
                      <div className="grid grid-cols-2 gap-2 p-1 rounded-[var(--radius-md)] bg-[var(--bg-hover)]">
                        <button
                          type="button"
                          disabled={!!editingServer}
                          onClick={() => {
                            setServerType('jellyfin')
                            setServerTestResult(null)
                            setEmbyLoginResult(null)
                          }}
                          className={`py-2 text-[13px] rounded-[var(--radius-sm)] transition-colors ${
                            serverType === 'jellyfin'
                              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium shadow-sm'
                              : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                          } ${editingServer ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                        >
                          <Database size={13} className="inline -mt-0.5 mr-1" strokeWidth={1.5} />
                          Jellyfin
                        </button>
                        <button
                          type="button"
                          disabled={!!editingServer}
                          onClick={() => {
                            setServerType('emby')
                            setServerTestResult(null)
                            setEmbyLoginResult(null)
                          }}
                          className={`py-2 text-[13px] rounded-[var(--radius-sm)] transition-colors ${
                            serverType === 'emby'
                              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium shadow-sm'
                              : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                          } ${editingServer ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                        >
                          <Server size={13} className="inline -mt-0.5 mr-1" strokeWidth={1.5} />
                          Emby
                        </button>
                      </div>
                      {editingServer && (
                        <p className="text-[11px] text-[var(--text-quaternary)] mt-1.5">编辑模式下不可切换服务类型</p>
                      )}
                    </div>

                    <Field label="服务器名称" hint="可选">
                      <input
                        type="text"
                        value={serverForm.name}
                        onChange={(e) => setServerForm({ ...serverForm, name: e.target.value })}
                        placeholder={serverType === 'emby' ? '我的 Emby' : '我的 Jellyfin'}
                        className="ios-input"
                      />
                    </Field>

                    <Field label="服务器地址">
                      <div className="relative">
                        <LinkIcon size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                        <input
                          type="text"
                          value={serverForm.url}
                          onChange={(e) => {
                            setServerForm({ ...serverForm, url: e.target.value })
                            // URL 变更后清除测试结果（账号密码可能不匹配新地址）
                            setServerTestResult(null)
                            setEmbyLoginResult(null)
                          }}
                          placeholder={serverType === 'emby' ? 'http://192.168.1.100:8096' : 'http://192.168.1.100:8096'}
                          className="ios-input !pl-10"
                        />
                      </div>
                    </Field>

                    {/* Jellyfin: API Token 字段 */}
                    {serverType === 'jellyfin' && (
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
                    )}

                    {/* Emby: 账号 + 密码字段 */}
                    {serverType === 'emby' && (
                      <>
                        <Field label="账号">
                          <div className="relative">
                            <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                            <input
                              type="text"
                              value={serverForm.username}
                              onChange={(e) => {
                                setServerForm({ ...serverForm, username: e.target.value })
                                setServerTestResult(null)
                                setEmbyLoginResult(null)
                              }}
                              placeholder="Emby 登录账号"
                              className="ios-input !pl-10"
                              autoComplete="off"
                            />
                          </div>
                        </Field>
                        <Field label="密码">
                          <div className="relative">
                            <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                            <input
                              type="password"
                              value={serverForm.password}
                              onChange={(e) => {
                                setServerForm({ ...serverForm, password: e.target.value })
                                setServerTestResult(null)
                                setEmbyLoginResult(null)
                              }}
                              placeholder="Emby 登录密码"
                              className="ios-input !pl-10"
                              autoComplete="off"
                            />
                          </div>
                        </Field>
                        <p className="text-[11px] text-[var(--text-quaternary)] -mt-2 leading-relaxed">
                          密码将使用系统密钥链 (safeStorage) 加密保存，登录后获取的 Token 用于后续 API 鉴权。
                        </p>
                      </>
                    )}

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
                        disabled={
                          serverTesting ||
                          !serverForm.url.trim() ||
                          (serverType === 'jellyfin' ? !serverForm.token.trim() : !serverForm.username.trim() || !serverForm.password)
                        }
                        className="ios-btn ios-btn-secondary flex-1"
                        whileTap={{ scale: 0.96 }}
                      >
                        {serverTesting ? <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> : <Radar size={15} strokeWidth={1.5} />}
                        {serverTesting ? '测试中...' : '测试连接'}
                      </motion.button>
                      <motion.button
                        onClick={handleSaveServer}
                        disabled={
                          !serverForm.url.trim() ||
                          (serverType === 'jellyfin'
                            ? !serverForm.token.trim()
                            : !serverForm.username.trim() || !serverForm.password || !embyLoginResult)
                        }
                        className="ios-btn ios-btn-primary flex-1"
                        whileTap={{ scale: 0.96 }}
                      >
                        <Save size={15} strokeWidth={1.5} />
                        {editingServer ? '保存修改' : '添加服务器'}
                      </motion.button>
                    </div>
                    {serverType === 'emby' && !embyLoginResult && (
                      <p className="text-[11px] text-[var(--text-quaternary)] text-center -mt-2">Emby 服务器需先「测试连接」获取令牌后才能保存</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 添加按钮 */}
            {!showAddForm && (
              <motion.button
                onClick={() => {
                  setShowAddForm(true)
                  setEditingServer(null)
                  setServerType('jellyfin')
                  setServerForm({ name: '', url: '', token: '', username: '', password: '' })
                  setServerTestResult(null)
                  setEmbyLoginResult(null)
                }}
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

                <div className="h-px bg-[var(--separator)]" />

                <div className="flex items-center gap-2 mb-1">
                  <Key size={14} className="text-[var(--text-tertiary)]" strokeWidth={1.5} />
                  <span className="text-[13px] font-medium text-[var(--text-secondary)]">DandanPlay 认证（可选）</span>
                </div>
                <p className="text-[11px] text-[var(--text-tertiary)] -mt-3 mb-1">
                  API 需要 AppId/AppSecret 认证。前往 <a href="https://dev.dandanplay.com/" target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">开发者中心</a> 申请
                </p>
                <Field label="AppId">
                  <input
                    type="text"
                    value={danmakuAppId}
                    onChange={(e) => setDanmakuAppId(e.target.value)}
                    placeholder="在开发者中心申请"
                    className="ios-input"
                  />
                </Field>
                <Field label="AppSecret">
                  <input
                    type="password"
                    value={danmakuAppSecret}
                    onChange={(e) => setDanmakuAppSecret(e.target.value)}
                    placeholder={danmakuInfo.includes('••••') ? '已保存（留空保持不变）' : '在开发者中心申请'}
                    className="ios-input"
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

            {/* ---- 最近入库设置 ---- */}
            <GlassCard title="最近入库" icon={Sparkles}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">启用最近入库栏</div>
                  <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">在首页顶部展示最近添加到媒体库的影片</div>
                </div>
                <button
                  onClick={() => {
                    const next = !recentlyAddedEnabled
                    setRecentlyAddedEnabled(next)
                    saveRecentlyAddedSettings({ enabled: next })
                  }}
                  className={`ios-toggle ${recentlyAddedEnabled ? 'active' : ''}`}
                  aria-label="切换最近入库栏"
                />
              </div>

              <div className="h-px bg-[var(--separator)]" />

              {/* 展示数量 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">展示数量</div>
                  <div className="text-[13px] text-[var(--accent)] font-medium">{recentlyAddedCount} 部</div>
                </div>
                <div className="flex gap-2">
                  {[6, 12, 18, 24].map((count) => (
                    <button
                      key={count}
                      onClick={() => {
                        setRecentlyAddedCount(count)
                        saveRecentlyAddedSettings({ displayCount: count })
                      }}
                      className={`flex-1 py-2 rounded-[var(--radius-md)] text-[13px] font-medium transition-all ${
                        recentlyAddedCount === count
                          ? 'bg-[var(--accent)] text-white shadow-[0_2px_8px_rgba(0,122,255,0.3)]'
                          : 'bg-[var(--bg-grouped)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-px bg-[var(--separator)]" />

              {/* 滚动速度 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">滚动速度</div>
                  <div className="text-[13px] text-[var(--accent)] font-medium">
                    {recentlyAddedSpeed === 0.5 ? '慢' : recentlyAddedSpeed === 1 ? '正常' : recentlyAddedSpeed === 1.5 ? '快' : '很快'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {[
                    { value: 0.5, label: '慢' },
                    { value: 1, label: '正常' },
                    { value: 1.5, label: '快' },
                    { value: 2, label: '很快' }
                  ].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => {
                        setRecentlyAddedSpeed(value)
                        saveRecentlyAddedSettings({ scrollSpeed: value })
                      }}
                      className={`flex-1 py-2 rounded-[var(--radius-md)] text-[13px] font-medium transition-all ${
                        recentlyAddedSpeed === value
                          ? 'bg-[var(--accent)] text-white shadow-[0_2px_8px_rgba(0,122,255,0.3)]'
                          : 'bg-[var(--bg-grouped)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 保存提示 */}
              {recentlyAddedSaveMsg && (
                <motion.div
                  className="flex items-center gap-2 text-[13px] text-[var(--success)]"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                >
                  <CheckCircle size={14} strokeWidth={1.5} /> {recentlyAddedSaveMsg}
                </motion.div>
              )}
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



