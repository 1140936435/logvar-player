import { useState, useEffect, type FormEvent, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Server, Wifi, WifiOff, Save, Loader2, CheckCircle,
  MessageSquare, TestTube, Monitor, Cpu, Palette,
  ChevronDown, Key, Link as LinkIcon
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

interface JellyfinServerInfo {
  ServerName?: string
  Version?: string
  Id?: string
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
      {/* 卡片标题 */}
      <div className="flex items-center gap-3 px-7 pt-7 pb-4">
        <div className="w-9 h-9 rounded-[var(--radius-md)] bg-[var(--accent-bg)] flex items-center justify-center flex-shrink-0">
          <Icon size={18} className="text-[var(--accent)]" strokeWidth={1.5} />
        </div>
        <h2 className="text-[17px] font-semibold text-[var(--text-primary)] tracking-tight">{title}</h2>
      </div>

      {/* 分隔线 */}
      <div className="mx-7 h-px bg-[var(--separator)]" />

      {/* 内容 */}
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

function SliderRow({ label, value, unit, children }: { label: string; value: string | number; unit: string; children: React.ReactNode }): ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] text-[var(--text-secondary)] font-medium">{label}</span>
        <span className="text-[12px] text-[var(--text-primary)] font-mono tabular-nums bg-[var(--bg-input)] px-2 py-0.5 rounded-md min-w-[48px] text-center">
          {value}{unit}
        </span>
      </div>
      {children}
    </div>
  )
}

/* ==================== Settings 主组件 ==================== */

function Settings(): ReactElement {
  // Jellyfin
  const [serverUrl, setServerUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectStatus, setConnectStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [serverInfo, setServerInfo] = useState<JellyfinServerInfo | null>(null)
  const [customServerName, setCustomServerName] = useState('')
  const [displayServerName, setDisplayServerName] = useState('')

  // 弹幕 API
  const [danmakuPrimary, setDanmakuPrimary] = useState('')
  const [danmakuMirrors, setDanmakuMirrors] = useState('')
  const [danmakuTestResult, setDanmakuTestResult] = useState<DanmakuTestResult | null>(null)
  const [danmakuTesting, setDanmakuTesting] = useState(false)
  const [danmakuSaveMsg, setDanmakuSaveMsg] = useState('')
  const [danmakuInfo, setDanmakuInfo] = useState('')

  // 弹幕显示
  const [fontSize, setFontSize] = useState(24)
  const [displayArea, setDisplayArea] = useState(70)
  const [scrollSpeed, setScrollSpeed] = useState('medium')
  const [opacity, setOpacity] = useState(100)

  // 播放器
  const [hardwareDecode, setHardwareDecode] = useState(true)
  const [hdrToneMapping, setHdrToneMapping] = useState(true)

  const handleConnect = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!serverUrl.trim()) { setConnectStatus('error'); setStatusMessage('请输入服务器地址'); return }
    if (!apiToken.trim()) { setConnectStatus('error'); setStatusMessage('请输入 API Token'); return }

    setConnecting(true)
    setConnectStatus('idle')
    setStatusMessage('正在连接...')

    try {
      const result = await window.api.jellyfin.connect(serverUrl.trim(), apiToken.trim())
      if (result.success) {
        setConnectStatus('success')
        const info = result.data as JellyfinServerInfo
        setServerInfo(info)
        const autoName = info.ServerName || 'Jellyfin'
        setDisplayServerName(autoName)
        setStatusMessage(`连接成功 - ${autoName} v${info.Version || '?'}`)
        await window.api.store.set('jellyfin', { url: serverUrl.trim(), token: apiToken.trim() })
        const savedCustom = await window.api.store.get('serverDisplayName')
        if (savedCustom) {
          setCustomServerName(savedCustom as string)
          setDisplayServerName(savedCustom as string)
        } else {
          await window.api.store.set('serverDisplayName', autoName)
        }
      } else {
        setConnectStatus('error')
        setStatusMessage(result.error || '连接失败')
      }
    } catch (err) {
      setConnectStatus('error')
      setStatusMessage(err instanceof Error ? err.message : '发生未知错误')
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    window.api.store.get('jellyfin').then((saved: { url?: string; token?: string } | null) => {
      if (saved?.url) setServerUrl(saved.url)
      if (saved?.token) setApiToken(saved.token)
    }).catch(() => {})

    window.api.store.get('serverDisplayName').then((name) => {
      if (name) { setCustomServerName(name as string); setDisplayServerName(name as string) }
    }).catch(() => {})

    window.api.danmaku.getConfig().then((cfg) => {
      setDanmakuPrimary(cfg.primary)
      setDanmakuMirrors(cfg.mirrors.join('\n'))
    }).catch(() => {})

    // 加载弹幕显示设置
    Promise.all([
      window.api.store.get('danmakuFontSize'),
      window.api.store.get('danmakuDisplayArea'),
      window.api.store.get('danmakuScrollSpeed'),
      window.api.store.get('danmakuOpacity')
    ]).then(([fs, area, speed, op]) => {
      if (fs !== null) setFontSize(Number(fs))
      if (area !== null) setDisplayArea(Number(area))
      if (speed !== null) setScrollSpeed(String(speed))
      if (op !== null) setOpacity(Number(op))
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
          <GlassCard title="Jellyfin 服务器" icon={Server}>
            {/* 连接状态 */}
            {connectStatus !== 'idle' && (
              <motion.div
                className={`px-4 py-3 rounded-[var(--radius-md)] text-[13px] flex items-center gap-2.5 ${
                  connectStatus === 'success' ? 'status-success' :
                  connectStatus === 'error' ? 'status-error' :
                  'status-info'
                }`}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {connectStatus === 'success' ? <CheckCircle size={16} /> :
                 connectStatus === 'error' ? <WifiOff size={16} /> :
                 <Loader2 size={16} className="animate-spin" />}
                {statusMessage}
              </motion.div>
            )}

            <form onSubmit={handleConnect} className="space-y-5">
              <Field label="服务器地址">
                <div className="relative">
                  <LinkIcon size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" strokeWidth={1.5} />
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
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
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="输入你的 API Token"
                    className="ios-input !pl-10"
                  />
                </div>
              </Field>

              {connectStatus === 'success' && (
                <Field label="自定义显示名称">
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={customServerName}
                      onChange={(e) => setCustomServerName(e.target.value)}
                      placeholder={serverInfo?.ServerName || 'Jellyfin'}
                      className="ios-input flex-1"
                    />
                    <motion.button
                      type="button"
                      onClick={async () => {
                        const name = customServerName.trim() || serverInfo?.ServerName || 'Jellyfin'
                        setCustomServerName(name); setDisplayServerName(name)
                        await window.api.store.set('serverDisplayName', name)
                      }}
                      className="ios-btn ios-btn-secondary !px-4"
                      whileTap={{ scale: 0.96 }}
                    >
                      <Save size={15} strokeWidth={1.5} />
                      保存
                    </motion.button>
                  </div>
                </Field>
              )}

              <motion.button
                type="submit"
                disabled={connecting}
                className={connecting ? 'ios-btn ios-btn-primary opacity-40 cursor-not-allowed w-full' : 'ios-btn ios-btn-primary w-full'}
                whileTap={connecting ? {} : { scale: 0.97 }}
              >
                {connecting ? <Loader2 size={16} className="animate-spin" strokeWidth={1.5} /> : <Wifi size={16} strokeWidth={1.5} />}
                {connecting ? '连接中...' : '连接服务器'}
              </motion.button>
            </form>

            {/* 连接成功状态 */}
            {connectStatus === 'success' && (
              <div className="flex items-center gap-3 pt-5 mt-5 border-t border-[var(--separator)]">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--success)]" />
                <span className="text-[13px] text-[var(--text-secondary)]">{displayServerName}</span>
                {serverInfo?.Version && <span className="text-[12px] text-[var(--text-tertiary)]">v{serverInfo.Version}</span>}
              </div>
            )}
          </GlassCard>

          {/* ======== 右栏：弹幕 + 播放器 ======== */}
          <div className="space-y-8">

            {/* ---- 弹幕设置 ---- */}
            <GlassCard title="弹幕" icon={MessageSquare}>
              {/* 弹幕源 */}
              <CollapseSection
                title="弹幕源"
                subtitle={danmakuPrimary || 'DandanPlay API'}
                icon={MessageSquare}
                defaultOpen={false}
              >
                <Field label="主 API 地址">
                  <input
                    type="text"
                    value={danmakuPrimary}
                    onChange={(e) => setDanmakuPrimary(e.target.value)}
                    placeholder="https://api.dandanplay.net"
                    className="ios-input"
                  />
                </Field>

                <div className="flex items-center gap-3">
                  <motion.button
                    onClick={handleDanmakuTest}
                    disabled={danmakuTesting || !danmakuPrimary.trim()}
                    className={danmakuTesting || !danmakuPrimary.trim() ? 'ios-btn ios-btn-secondary opacity-40 cursor-not-allowed' : 'ios-btn ios-btn-secondary'}
                    whileTap={(danmakuTesting || !danmakuPrimary.trim()) ? {} : { scale: 0.96 }}
                  >
                    {danmakuTesting ? <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> : <TestTube size={15} strokeWidth={1.5} />}
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

                <div className="flex items-center gap-3">
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
              </CollapseSection>

              {/* 弹幕显示 */}
              <CollapseSection
                title="弹幕显示"
                subtitle="文字大小、透明度、滚动速度"
                icon={Palette}
                defaultOpen={true}
              >
                <SliderRow label="文字大小" value={fontSize} unit="px">
                  <input type="range" min="12" max="36" value={fontSize} onChange={(e) => { const v = Number(e.target.value); setFontSize(v); window.api.store.set('danmakuFontSize', v) }} className="w-full" />
                </SliderRow>

                <SliderRow label="显示区域" value={displayArea} unit="%">
                  <input type="range" min="10" max="100" value={displayArea} onChange={(e) => { const v = Number(e.target.value); setDisplayArea(v); window.api.store.set('danmakuDisplayArea', v) }} className="w-full" />
                </SliderRow>

                <div>
                  <span className="text-[13px] text-[var(--text-secondary)] font-medium mb-3 block">滚动速度</span>
                  <div className="flex gap-2">
                    {(['slow', 'medium', 'fast'] as const).map((speed) => (
                      <motion.button
                        key={speed}
                        onClick={() => { setScrollSpeed(speed); window.api.store.set('danmakuScrollSpeed', speed) }}
                        className={`flex-1 h-11 rounded-[var(--radius-md)] text-[13px] font-medium transition-colors ${
                          scrollSpeed === speed
                            ? 'bg-[var(--accent)] text-white'
                            : 'bg-[var(--bg-input)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                        }`}
                        whileTap={{ scale: 0.96 }}
                      >
                        {speed === 'slow' ? '慢速' : speed === 'medium' ? '中速' : '快速'}
                      </motion.button>
                    ))}
                  </div>
                </div>

                <SliderRow label="透明度" value={opacity} unit="%">
                  <input type="range" min="20" max="100" value={opacity} onChange={(e) => { const v = Number(e.target.value); setOpacity(v); window.api.store.set('danmakuOpacity', v) }} className="w-full" />
                </SliderRow>
              </CollapseSection>
            </GlassCard>

            {/* ---- 播放器设置 ---- */}
            <GlassCard title="播放器" icon={Monitor}>
              {/* 硬件解码 */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">启用硬件解码</div>
                  <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">使用 GPU 加速视频解码，降低 CPU 占用</div>
                </div>
                <button
                  onClick={() => setHardwareDecode(!hardwareDecode)}
                  className={`ios-toggle ${hardwareDecode ? 'active' : ''}`}
                  aria-label="切换硬件解码"
                />
              </div>

              {/* 分隔线 */}
              <div className="h-px bg-[var(--separator)]" />

              {/* HDR 色调映射 */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[15px] font-medium text-[var(--text-primary)]">自动 HDR 色调映射</div>
                  <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 leading-relaxed">播放 HDR 内容时自动进行色彩映射</div>
                </div>
                <button
                  onClick={() => setHdrToneMapping(!hdrToneMapping)}
                  className={`ios-toggle ${hdrToneMapping ? 'active' : ''}`}
                  aria-label="切换HDR色调映射"
                />
              </div>

              {/* 分隔线 */}
              <div className="h-px bg-[var(--separator)]" />

              {/* 渲染器信息 */}
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--bg-input)] flex items-center justify-center flex-shrink-0">
                  <Cpu size={15} className="text-[var(--text-tertiary)]" strokeWidth={1.5} />
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

        {/* 底部留白 */}
        <div className="h-16" />
      </motion.div>
    </div>
  )
}

export default Settings
