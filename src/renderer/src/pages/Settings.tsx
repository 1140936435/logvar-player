import { useState, useEffect, useCallback, useMemo, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
// server:* IPC 返回的是公开 DTO（PublicServerConfig）：凭据不出主进程。
// ServerInfo / ServerTestResult 是 Settings 里内聚的本地类型，自行定义。
import type { PublicServerConfig as ApiServerConfig, EmbyTestResponse } from '../../../shared/preload-types'
import type { JellyfinServerInfo, ServerType } from '../../../shared/types'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Database, Plug, WifiOff, Save, Loader2, CheckCircle, AlertCircle,
  MessageCircleMore, Radar, MonitorPlay, Info,
  ChevronDown, Key, Link as LinkIcon, CirclePlus, Trash2, Settings as SettingsIcon,
  CircleDot, Sparkles, User, Lock, Server, Download, Upload, FileJson, FileSpreadsheet,
  X
} from 'lucide-react'
import { useModuleLayout } from '../hooks/useModuleLayout'
import { SortableGlassCard } from '../components/SortableGlassCard'
import { LayoutToolbar } from '../components/LayoutToolbar'

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
  
  // 模块布局管理
  const {
    moduleOrder,
    isEditMode,
    isSaving: isLayoutSaving,
    hasChanges,
    handleDragEnd: handleLayoutDragEnd,
    resetLayout,
    toggleEditMode,
    exitEditMode
  } = useModuleLayout()

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
  const [danmakuSaving, setDanmakuSaving] = useState(false)
  const [danmakuSaveMsg, setDanmakuSaveMsg] = useState('')
  const [danmakuInfo, setDanmakuInfo] = useState('')

  // 网络代理

  // 播放器
  const [hardwareDecode, setHardwareDecode] = useState(true)
  const [hdrToneMapping, setHdrToneMapping] = useState(false)
  const [playerEngine, setPlayerEngine] = useState<'html5' | 'mpv' | 'mpv-canvas'>('html5')
  const [mpvAvailable, setMpvAvailable] = useState(false)
  const [mpvDebugLog, setMpvDebugLog] = useState(false)
  const [playerSaveMsg, setPlayerSaveMsg] = useState('')

  // 最近入库
  const [recentlyAddedEnabled, setRecentlyAddedEnabled] = useState(true)
  const [recentlyAddedCount, setRecentlyAddedCount] = useState(12)
  const [recentlyAddedSpeed, setRecentlyAddedSpeed] = useState(1)
  const [recentlyAddedSaveMsg, setRecentlyAddedSaveMsg] = useState('')

  // 数据导入导出
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dataKeys, setDataKeys] = useState<Array<{ key: string; hasSensitive: boolean }>>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json')
  const [importMerge, setImportMerge] = useState(true)
  // 是否在导出中包含服务器/弹幕凭据（明文，默认关闭，主进程默认也会强制排除）
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null)
  const [importResult, setImportResult] = useState<{ success: boolean; message: string; details?: string } | null>(null)

  // 加载可导出的键列表
  const loadDataKeys = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.data.listKeys()
      if (result.success && result.data) {
        setDataKeys(result.data)
        // 默认选中非敏感的键
        const defaultSelected = result.data
          .filter(k => !k.hasSensitive)
          .map(k => k.key)
        setSelectedKeys(new Set(defaultSelected))
      }
    } catch { /* ignore */ }
  }, [])

  // 组件挂载时加载
  useEffect(() => {
    loadDataKeys()
  }, [loadDataKeys])

  // 切换键选择
  const toggleKey = useCallback((key: string): void => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // 全选/取消全选
  const toggleAllKeys = useCallback((selectAll: boolean): void => {
    if (selectAll) {
      setSelectedKeys(new Set(dataKeys.map(k => k.key)))
    } else {
      setSelectedKeys(new Set())
    }
  }, [dataKeys])

  // 导出数据
  const handleExport = useCallback(async (): Promise<void> => {
    if (selectedKeys.size === 0) {
      setExportResult({ success: false, message: '请至少选择一项要导出的数据' })
      return
    }
    
    setExporting(true)
    setExportResult(null)
    
    try {
      const result = await window.api.data.export({
        format: exportFormat,
        includeKeys: Array.from(selectedKeys),
        includeSensitive
      })

      if (result.success && result.data) {
        const sizeKB = (result.data.size / 1024).toFixed(1)
        const excluded = result.data.excludedSensitive?.length
          ? `（已排除 ${result.data.excludedSensitive.length} 项凭据：${result.data.excludedSensitive.join('、')}）`
          : ''
        setExportResult({
          success: true,
          message: `导出成功！共 ${result.data.keyCount} 项数据，大小 ${sizeKB} KB${excluded}`
        })
      } else {
        setExportResult({
          success: false,
          message: result.error || '导出失败'
        })
      }
    } catch (err) {
      setExportResult({
        success: false,
        message: String(err)
      })
    }
    setExporting(false)
  }, [selectedKeys, exportFormat, includeSensitive])

  // 导入数据
  const handleImport = useCallback(async (): Promise<void> => {
    setImporting(true)
    setImportResult(null)
    
    try {
      const result = await window.api.data.import({
        merge: importMerge
      })
      
      if (result.success && result.data) {
        const msg = `导入成功！已导入 ${result.data.importedCount} 项，跳过 ${result.data.skippedCount} 项`
        const details = result.data.warnings.length > 0 
          ? `\n警告：${result.data.warnings.join(', ')}`
          : undefined
        setImportResult({
          success: true,
          message: msg,
          details
        })
      } else {
        setImportResult({
          success: false,
          message: result.error || '导入失败'
        })
      }
    } catch (err) {
      setImportResult({
        success: false,
        message: String(err)
      })
    }
    setImporting(false)
  }, [importMerge])

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
          // 编辑模式：一次性更新 Emby 全部字段（含新测试拿到的 token/userId），
          // 凭据经 server:update 专用通道写入，不走通用 store
          const result = await window.api.server.update({
            id: editingServer.id,
            name: serverForm.name.trim() || `Emby (${serverForm.username.trim()})`,
            url: serverForm.url.trim(),
            token: embyLoginResult.token,
            type: 'emby',
            username: serverForm.username.trim(),
            password: serverForm.password,
            userId: embyLoginResult.userId
          })
          if (!result.success) {
            setServerStatus({ type: 'error', message: result.error || '更新失败' })
            return
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
        // Jellyfin：新增必须填 token；编辑时留空表示保持原凭据不变
        if (!editingServer && !serverForm.token.trim()) return
        if (editingServer) {
          await window.api.server.update({
            id: editingServer.id,
            name: serverForm.name.trim() || 'Jellyfin',
            url: serverForm.url.trim(),
            ...(serverForm.token.trim() ? { token: serverForm.token.trim() } : {})
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
      // 凭据不出主进程：编辑时不再回显 token/密码，留空表示保持不变
      token: '',
      username: server.username || '',
      password: ''
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
      setDanmakuAppId(cfg.appId || '')
      setDanmakuAppSecret(cfg.appSecretHint || '')
    }).catch(() => {})

    // 加载播放器设置
    window.api.store.get('player').then((saved: unknown) => {
      const data = saved as { hardwareDecode?: boolean; hdrToneMapping?: boolean; engine?: string; debugLog?: boolean } | null
      if (data) {
        if (typeof data.hardwareDecode === 'boolean') setHardwareDecode(data.hardwareDecode)
        if (typeof data.hdrToneMapping === 'boolean') setHdrToneMapping(data.hdrToneMapping)
        if (data.engine === 'mpv' || data.engine === 'html5' || data.engine === 'mpv-canvas') setPlayerEngine(data.engine)
        if (typeof data.debugLog === 'boolean') setMpvDebugLog(data.debugLog)
      }
    }).catch(() => {})

    // 探测 mpv 引擎可用性（打孔二进制 / libmpv 画布库任一可用即可）
    window.api.mpv.isAvailable().then((res) => {
      if (res.success && res.data === true) { setMpvAvailable(true); return }
      window.api.mpvRender.isAvailable().then((r2) => {
        if (r2.success) setMpvAvailable(r2.data === true)
      }).catch(() => {})
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
      if (result.success && result.data) {
        setDanmakuTestResult(result.data)
      } else if (result.error) {
        setDanmakuTestResult({ success: false, error: result.error, elapsed: 0 })
      }
    } catch (err) {
      setDanmakuTestResult({ success: false, error: String(err), elapsed: 0 })
    }
    setDanmakuTesting(false)
  }

  const handleDanmakuSave = async (): Promise<void> => {
    setDanmakuSaving(true)
    try {
      const mirrors = danmakuMirrors.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
      const updates: { primary: string; mirrors: string[]; appId: string; appSecret: string } = {
        primary: danmakuPrimary.trim(),
        mirrors,
        appId: danmakuAppId.trim(),
        appSecret: danmakuAppSecret.trim()
      }
      await window.api.danmaku.setConfig(updates)
      setDanmakuSaveMsg('已保存')
      setTimeout(() => setDanmakuSaveMsg(''), 2000)
    } catch (err) {
      console.error('Failed to save danmaku config:', err)
    } finally {
      setDanmakuSaving(false)
    }
  }

  const savePlayerSettings = useCallback(async (hw?: boolean, hdr?: boolean, engine?: 'html5' | 'mpv' | 'mpv-canvas', dbg?: boolean): Promise<void> => {
    const currentHw = hw ?? hardwareDecode
    const currentHdr = hdr ?? hdrToneMapping
    const currentEngine = engine ?? playerEngine
    const currentDbg = dbg ?? mpvDebugLog
    try {
      await window.api.store.set('player', { hardwareDecode: currentHw, hdrToneMapping: currentHdr, engine: currentEngine, debugLog: currentDbg })
      setPlayerSaveMsg('已保存，重新进入播放页后生效')
      setTimeout(() => setPlayerSaveMsg(''), 2000)
    } catch { /* ignore */ }
  }, [hardwareDecode, hdrToneMapping, playerEngine, mpvDebugLog])

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

  // 当前拖拽的模块 ID
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // 处理拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }, [])

  // 处理拖拽经过
  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTargetId !== id) {
      setDropTargetId(id)
    }
  }, [dropTargetId])

  // 处理拖拽离开
  const handleDragLeave = useCallback((id: string) => {
    if (dropTargetId === id) {
      setDropTargetId(null)
    }
  }, [dropTargetId])

  // 处理放置
  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const sourceId = draggedId || e.dataTransfer.getData('text/plain')
    if (!sourceId || sourceId === targetId) {
      setDraggedId(null)
      setDropTargetId(null)
      return
    }

    const oldIndex = moduleOrder.indexOf(sourceId)
    const newIndex = moduleOrder.indexOf(targetId)
    if (oldIndex === -1 || newIndex === -1) {
      setDraggedId(null)
      setDropTargetId(null)
      return
    }

    // 使用原生 arrayMove 逻辑
    const newOrder = [...moduleOrder]
    const [removed] = newOrder.splice(oldIndex, 1)
    newOrder.splice(newIndex, 0, removed)
    
    handleLayoutDragEnd(newOrder)
    setDraggedId(null)
    setDropTargetId(null)
  }, [moduleOrder, draggedId, handleLayoutDragEnd])

  // 处理拖拽结束
  const handleDragEnd = useCallback(() => {
    setDraggedId(null)
    setDropTargetId(null)
  }, [])

  // 模块内容渲染函数
  const renderServerModule = () => (
    <>
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
        {renderServerList()}
      </div>

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

      {/* 添加/编辑服务器表单：showAddForm 为 true 时显示，与上方"添加按钮"互斥 */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            key="server-form"
            className="p-5 rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg-elevated)] space-y-4"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            {/* 表单头部：标题 + 取消 */}
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-semibold text-[var(--text-primary)]">
                {editingServer ? '编辑服务器' : '添加服务器'}
              </span>
              <motion.button
                onClick={() => {
                  setShowAddForm(false)
                  setEditingServer(null)
                  setServerForm({ name: '', url: '', token: '', username: '', password: '' })
                  setServerTestResult(null)
                  setEmbyLoginResult(null)
                }}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                whileTap={{ scale: 0.9 }}
                title="取消"
              >
                <X size={16} strokeWidth={1.5} />
              </motion.button>
            </div>

            {/* 服务器类型切换：Jellyfin / Emby */}
            <div className="flex gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-hover)]">
              {(['jellyfin', 'emby'] as ServerType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setServerType(t)
                    setServerTestResult(null)
                    setEmbyLoginResult(null)
                  }}
                  className={`flex-1 py-2 text-[13px] font-medium rounded-[var(--radius-sm)] transition-colors ${
                    serverType === t
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {t === 'jellyfin' ? 'Jellyfin' : 'Emby'}
                </button>
              ))}
            </div>

            {/* 名称（可选） */}
            <Field label="名称" hint="可选，留空则自动命名">
              <input
                type="text"
                value={serverForm.name}
                onChange={(e) => setServerForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder={serverType === 'emby' ? '我的 Emby' : '我的 Jellyfin'}
                className="ios-input"
              />
            </Field>

            {/* 服务器地址 */}
            <Field label="服务器地址">
              <input
                type="text"
                value={serverForm.url}
                onChange={(e) => setServerForm(prev => ({ ...prev, url: e.target.value }))}
                placeholder="http://192.168.1.100:8096"
                className="ios-input"
              />
            </Field>

            {/* Jellyfin：API Token */}
            {serverType === 'jellyfin' && (
              <Field label="API Token" hint={editingServer ? '凭据由主进程安全保存，编辑时不回显；留空表示保持原 Token 不变' : '在 Jellyfin 控制台 → 高级 → API 密钥获取'}>
                <input
                  type="password"
                  value={serverForm.token}
                  onChange={(e) => setServerForm(prev => ({ ...prev, token: e.target.value }))}
                  placeholder={editingServer ? '留空则保持原 Token 不变' : '粘贴 API Token'}
                  className="ios-input"
                />
              </Field>
            )}

            {/* Emby：账号 + 密码 */}
            {serverType === 'emby' && (
              <>
                <Field label="账号">
                  <input
                    type="text"
                    value={serverForm.username}
                    onChange={(e) => setServerForm(prev => ({ ...prev, username: e.target.value }))}
                    placeholder="用户名"
                    className="ios-input"
                  />
                </Field>
                <Field label="密码">
                  <input
                    type="password"
                    value={serverForm.password}
                    onChange={(e) => setServerForm(prev => ({ ...prev, password: e.target.value }))}
                    placeholder="密码"
                    className="ios-input"
                  />
                </Field>
              </>
            )}

            {/* 测试连接结果 */}
            {serverTestResult && (
              <div className={`px-4 py-3 rounded-[var(--radius-md)] text-[13px] flex items-center gap-2.5 ${
                serverTestResult.success ? 'status-success' : 'status-error'
              }`}>
                {serverTestResult.success ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span className="flex-1 break-all">
                  {serverTestResult.success
                    ? `连接成功${serverTestResult.elapsed ? ` (${serverTestResult.elapsed}ms)` : ''}${serverTestResult.data?.ServerName ? ' · ' + serverTestResult.data.ServerName : ''}`
                    : (serverTestResult.error || '连接失败')}
                </span>
              </div>
            )}

            {/* Emby 提示：需先测试拿到 token 才能保存 */}
            {serverType === 'emby' && !embyLoginResult && (
              <p className="text-[12px] text-[var(--text-quaternary)] flex items-center gap-1.5">
                <Info size={13} strokeWidth={1.5} />
                Emby 需先点击「测试连接」验证账号密码后才能保存
              </p>
            )}

            {/* 操作按钮：测试连接 + 保存 */}
            <div className="flex items-center gap-3 pt-1">
              <motion.button
                onClick={handleTestServer}
                disabled={
                  serverTesting ||
                  !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? !serverForm.token.trim() : !serverForm.username.trim() || !serverForm.password)
                }
                className={
                  serverTesting || !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? !serverForm.token.trim() : !serverForm.username.trim() || !serverForm.password)
                    ? 'ios-btn ios-btn-secondary opacity-40 cursor-not-allowed'
                    : 'ios-btn ios-btn-secondary'
                }
                whileTap={
                  serverTesting || !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? !serverForm.token.trim() : !serverForm.username.trim() || !serverForm.password)
                    ? {}
                    : { scale: 0.96 }
                }
              >
                {serverTesting ? <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> : <Radar size={15} strokeWidth={1.5} />}
                {serverTesting ? '测试中...' : '测试连接'}
              </motion.button>
              <motion.button
                onClick={handleSaveServer}
                disabled={
                  !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? (!editingServer && !serverForm.token.trim()) : !embyLoginResult || !serverForm.username.trim() || !serverForm.password)
                }
                className={
                  !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? (!editingServer && !serverForm.token.trim()) : !embyLoginResult || !serverForm.username.trim() || !serverForm.password)
                    ? 'ios-btn ios-btn-primary opacity-40 cursor-not-allowed'
                    : 'ios-btn ios-btn-primary'
                }
                whileTap={
                  !serverForm.url.trim() ||
                  (serverType === 'jellyfin' ? (!editingServer && !serverForm.token.trim()) : !embyLoginResult || !serverForm.username.trim() || !serverForm.password)
                    ? {}
                    : { scale: 0.96 }
                }
              >
                <Save size={15} strokeWidth={1.5} />
                {editingServer ? '保存修改' : '添加'}
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )

  const renderDanmakuModule = () => (
    <>
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

        <div className="px-4 py-3 rounded-[var(--radius-md)] bg-[var(--bg-elevated)]">
          <p className="text-[12px] text-[var(--text-tertiary)] mb-3">
            DandanPlay API 需要认证。前往 <span className="text-[var(--accent)]">api.dandanplay.net/registerApp</span> 免费注册获取 App-ID 和 App-Secret。
          </p>
          <Field label="App-ID">
            <input
              type="text"
              value={danmakuAppId}
              onChange={(e) => setDanmakuAppId(e.target.value)}
              placeholder="DandanPlay App-ID"
              className="ios-input"
            />
          </Field>
          <div className="h-3" />
          <Field label="App-Secret">
            <input
              type="password"
              value={danmakuAppSecret}
              onChange={(e) => setDanmakuAppSecret(e.target.value)}
              placeholder="DandanPlay App-Secret"
              className="ios-input"
            />
          </Field>
        </div>

        {danmakuTestResult && (
          <motion.div
            className={`rounded-[var(--radius-md)] p-4 ${danmakuTestResult.success ? 'bg-[var(--success-bg)]' : 'bg-[var(--error-bg)]'}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            <div className="flex items-center gap-2 mb-2">
              {danmakuTestResult.success ? (
                <CheckCircle size={16} className="text-[var(--success)]" />
              ) : (
                <AlertCircle size={16} className="text-[var(--error)]" />
              )}
              <span className={`text-[14px] font-semibold ${danmakuTestResult.success ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                {danmakuTestResult.success ? '连接测试成功' : '连接测试失败'}
              </span>
            </div>
            <div className="text-[12px] text-[var(--text-secondary)] space-y-1">
              {danmakuTestResult.success && (
                <>
                  <p>延迟: {danmakuTestResult.elapsed}ms</p>
                  {danmakuTestResult.animeCount !== undefined && <p>收录动漫数: {danmakuTestResult.animeCount}</p>}
                  {danmakuTestResult.epCount !== undefined && <p>收录剧集数: {danmakuTestResult.epCount}</p>}
                </>
              )}
            </div>
          </motion.div>
        )}

        <div className="h-px bg-[var(--separator)]" />

        <div className="flex items-center justify-between">
          <p className="text-[12px] text-[var(--text-quaternary)]">设置将在保存后立即生效</p>
          <motion.button
            onClick={handleDanmakuSave}
            disabled={!danmakuPrimary.trim() || danmakuSaving}
            className="ios-btn ios-btn-primary"
            whileTap={!danmakuPrimary.trim() || danmakuSaving ? {} : { scale: 0.96 }}
          >
            {danmakuSaving ? (
              <>
                <Loader2 size={15} className="animate-spin" strokeWidth={1.5} />
                保存中...
              </>
            ) : (
              <>
                <Save size={15} strokeWidth={1.5} />
                保存配置
              </>
            )}
          </motion.button>
        </div>
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
    </>
  )

  const renderRecentlyModule = () => (
    <>
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

      {/* 滑动速度 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[15px] font-medium text-[var(--text-primary)]">自动滑动速度</div>
          <div className="text-[13px] text-[var(--accent)] font-medium">{recentlyAddedSpeed}x</div>
        </div>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.5}
          value={recentlyAddedSpeed}
          onChange={(e) => {
            const val = parseFloat(e.target.value)
            setRecentlyAddedSpeed(val)
            saveRecentlyAddedSettings({ scrollSpeed: val })
          }}
          className="w-full accent-[var(--accent)]"
        />
        <div className="flex justify-between text-[11px] text-[var(--text-quaternary)] mt-1">
          <span>0.5x</span>
          <span>1x</span>
          <span>2x</span>
          <span>3x</span>
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
    </>
  )

  const renderPlayerModule = () => (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-[var(--text-primary)]">播放引擎</div>
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">
            mpv 引擎支持硬解、HDR 色调映射与 ASS 字幕渲染；画布渲染为新架构（界面不透明、真全屏）
            {!mpvAvailable && <span className="text-[var(--warning,#f5a623)]">（未检测到 mpv，将回退内置引擎）</span>}
          </div>
        </div>
        <div className="flex rounded-[var(--radius-sm)] bg-[var(--bg-input)] p-0.5 gap-0.5 flex-shrink-0">
          {([['html5', '内置'], ['mpv-canvas', 'mpv 画布'], ['mpv', 'mpv 兼容']] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => { setPlayerEngine(value); void savePlayerSettings(undefined, undefined, value) }}
              className={`px-3.5 py-1.5 rounded-[6px] text-[13px] font-medium transition-colors ${
                playerEngine === value
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-px bg-[var(--separator)]" />

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-[var(--text-primary)]">启用硬件解码</div>
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">使用 GPU 加速视频解码，降低 CPU 占用{playerEngine !== 'html5' ? '（mpv 引擎：copy-back 硬解）' : ''}</div>
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
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">播放 HDR 内容时自动进行色彩映射（bt.2390 算法）</div>
        </div>
        <button
          onClick={() => { const next = !hdrToneMapping; setHdrToneMapping(next); savePlayerSettings(undefined, next) }}
          className={`ios-toggle ${hdrToneMapping ? 'active' : ''}`}
          aria-label="切换HDR色调映射"
        />
      </div>

      <div className="h-px bg-[var(--separator)]" />

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-[var(--text-primary)]">mpv 调试日志</div>
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">启用后记录 mpv 详细事件与解码状态，便于排查播放问题</div>
        </div>
        <button
          onClick={() => { const next = !mpvDebugLog; setMpvDebugLog(next); savePlayerSettings(undefined, undefined, undefined, next) }}
          className={`ios-toggle ${mpvDebugLog ? 'active' : ''}`}
          aria-label="切换mpv调试日志"
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
    </>
  )

  const renderDataModule = () => (
    <>
      {/* 导出区域 */}
      <CollapseSection title="导出数据" subtitle="将配置、服务器等数据导出为文件" icon={Download}>
        <div className="space-y-4">
          <div>
            <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-2">导出格式</div>
            <div className="flex gap-2">
              <button
                onClick={() => setExportFormat('json')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[13px] transition-colors ${
                  exportFormat === 'json'
                    ? 'border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]'
                    : 'border-[var(--separator)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <FileJson size={14} /> JSON
              </button>
              <button
                onClick={() => setExportFormat('csv')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[13px] transition-colors ${
                  exportFormat === 'csv'
                    ? 'border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]'
                    : 'border-[var(--separator)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <FileSpreadsheet size={14} /> CSV
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[13px] font-medium text-[var(--text-secondary)]">选择要导出的数据</div>
              <div className="flex gap-2">
                <button onClick={() => toggleAllKeys(true)} className="text-[12px] text-[var(--accent)] hover:underline">全选</button>
                <button onClick={() => toggleAllKeys(false)} className="text-[12px] text-[var(--text-quaternary)] hover:underline">取消全选</button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1 p-2 bg-[var(--bg-input)] rounded-lg border border-[var(--separator)]">
              {dataKeys.map(k => (
                <label
                  key={k.key}
                  className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                    selectedKeys.has(k.key) ? 'bg-[var(--accent-bg)]' : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(k.key)}
                    onChange={() => toggleKey(k.key)}
                    className="w-4 h-4 rounded border-[var(--separator)] text-[var(--accent)] focus:ring-[var(--accent)]"
                  />
                  <span className="text-[13px] text-[var(--text-primary)] flex-1">{k.key}</span>
                  {k.hasSensitive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">敏感</span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer px-1">
            <input
              type="checkbox"
              checked={includeSensitive}
              onChange={(e) => setIncludeSensitive(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-[var(--separator)] text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
              在导出中包含服务器与弹幕凭据
              <span className="block text-[11px] text-amber-500 mt-0.5">
                凭据将以明文写入导出文件，仅建议在受信任的迁移场景下开启；默认开启时主进程也会强制排除
              </span>
            </span>
          </label>

          <button
            onClick={handleExport}
            disabled={exporting || selectedKeys.size === 0}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--accent)] text-white font-medium text-[14px] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {exporting ? (
              <>
                <Loader2 size={16} className="animate-spin" /> 导出中...
              </>
            ) : (
              <>
                <Download size={16} /> 导出 ({selectedKeys.size} 项)
              </>
            )}
          </button>

          <AnimatePresence>
            {exportResult && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className={`overflow-hidden ${exportResult.success ? 'text-green-500' : 'text-red-500'}`}
              >
                <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--bg-input)]">
                  {exportResult.success ? (
                    <CheckCircle size={16} />
                  ) : (
                    <AlertCircle size={16} />
                  )}
                  <span className="text-[13px]">{exportResult.message}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </CollapseSection>

      <div className="h-px bg-[var(--separator)]" />

      {/* 导入区域 */}
      <CollapseSection title="导入数据" subtitle="从文件恢复配置或迁移数据" icon={Upload}>
        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-[var(--bg-input)] border border-[var(--separator)]">
            <div className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
              <div className="font-medium text-[var(--text-primary)] mb-1">操作说明：</div>
              <ul className="list-disc list-inside space-y-1">
                <li>支持 JSON 和 CSV 格式的配置文件</li>
                <li>导入将覆盖或合并现有配置（可选）</li>
                <li>建议导入前先导出备份当前配置</li>
              </ul>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={importMerge}
              onChange={(e) => setImportMerge(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--separator)] text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span className="text-[13px] text-[var(--text-secondary)]">合并模式（保留现有配置，仅更新导入的项）</span>
          </label>

          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border-2 border-dashed border-[var(--separator)] text-[var(--text-secondary)] font-medium text-[14px] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all disabled:opacity-50"
          >
            {importing ? (
              <>
                <Loader2 size={16} className="animate-spin" /> 导入中...
              </>
            ) : (
              <>
                <Upload size={16} /> 选择文件导入
              </>
            )}
          </button>

          <AnimatePresence>
            {importResult && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className={`overflow-hidden ${importResult.success ? 'text-green-500' : 'text-red-500'}`}
              >
                <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--bg-input)]">
                  {importResult.success ? (
                    <CheckCircle size={16} className="mt-0.5" />
                  ) : (
                    <AlertCircle size={16} className="mt-0.5" />
                  )}
                  <div className="flex-1">
                    <div className="text-[13px]">{importResult.message}</div>
                    {importResult.details && (
                      <div className="text-[12px] text-[var(--text-quaternary)] mt-1 whitespace-pre-line">
                        {importResult.details}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </CollapseSection>
    </>
  )

  // 渲染服务器列表的子函数
  const renderServerList = () => {
    return servers.map((server) => {
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
                className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                whileTap={{ scale: 0.9 }}
                title="编辑"
              >
                <LinkIcon size={15} />
              </motion.button>
              <motion.button
                onClick={() => handleRemoveServer(server.id)}
                className="p-1.5 rounded-lg hover:bg-[var(--error-bg)] text-[var(--text-tertiary)] hover:text-[var(--error)]"
                whileTap={{ scale: 0.9 }}
                title="删除"
              >
                <Trash2 size={15} />
              </motion.button>
            </div>
          </div>
        </div>
      )
    })
  }

  // 模块图标映射
  const MODULE_ICONS: Record<string, React.ElementType> = {
    server: Server,
    danmaku: MessageCircleMore,
    recently: Sparkles,
    player: MonitorPlay,
    data: Database
  }

  // 模块标题映射
  const MODULE_TITLES: Record<string, string> = {
    server: '媒体服务器',
    danmaku: '弹幕',
    recently: '最近入库',
    player: '播放器',
    data: '数据管理'
  }

  // 模块内容渲染映射
  const MODULE_RENDERERS: Record<string, () => React.ReactNode> = {
    server: renderServerModule,
    danmaku: renderDanmakuModule,
    recently: renderRecentlyModule,
    player: renderPlayerModule,
    data: renderDataModule
  }

  return (
    <div className="w-full flex justify-center">
      <motion.div
        className="px-8 py-8 w-full max-w-[1100px]"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        {/* 工具栏 */}
        <LayoutToolbar
          isEditMode={isEditMode}
          isSaving={isLayoutSaving}
          hasChanges={hasChanges}
          onToggleEditMode={toggleEditMode}
          onReset={resetLayout}
          onExitEditMode={exitEditMode}
        />

        {/* 提示信息 */}
        <AnimatePresence>
          {isEditMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-6 p-3 rounded-lg bg-[var(--accent-bg)] border border-[var(--accent)]/30"
            >
              <div className="flex items-center gap-2 text-[13px] text-[var(--accent)]">
                <SettingsIcon size={16} />
                <span>编辑模式：拖动卡片头部的手柄图标调整模块顺序，完成后点击「完成」保存布局</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 可拖拽模块容器 */}
        <div className="space-y-8">
          {moduleOrder.map((moduleId) => {
            const title = MODULE_TITLES[moduleId]
            const Icon = MODULE_ICONS[moduleId]
            const renderContent = MODULE_RENDERERS[moduleId]

            if (!title || !Icon || !renderContent) return null

            return (
              <SortableGlassCard
                key={moduleId}
                id={moduleId}
                title={title}
                icon={Icon}
                isEditMode={isEditMode}
                isDragging={draggedId === moduleId}
                isDropTarget={dropTargetId === moduleId}
                onDragStart={(e) => handleDragStart(e, moduleId)}
                onDragOver={(e) => handleDragOver(e, moduleId)}
                onDragLeave={() => handleDragLeave(moduleId)}
                onDrop={(e) => handleDrop(e, moduleId)}
                onDragEnd={handleDragEnd}
              >
                {renderContent()}
              </SortableGlassCard>
            )
          })}
        </div>

        <div className="h-16" />
      </motion.div>
    </div>
  )
}

export default Settings



