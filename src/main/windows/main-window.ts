import { BrowserWindow, shell, session, type NativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { secureHandleRaw } from '../ipc/secure-handle'
import { V } from '../ipc/secure-schema'

/**
 * 主窗口宿主回调：用于解耦 index.ts 与窗口模块，避免循环依赖。
 * 由 index.ts 注入主进程侧的图标/日志基础设施。
 */
export interface MainWindowHost {
  /** 获取窗口图标（透明派生的 256px PNG，完整保留 Alpha）。 */
  getWindowIcon(): NativeImage
  /** 渲染进程 console 消息回调（原 addLog(level, 'renderer', message)）。 */
  log(level: string, message: string): void
}

/**
 * 主窗口控制器（从 index.ts 试点拆分）：
 * 负责 BrowserWindow 创建、navigation policy（导航拦截/限制）、
 * window open handler，以及 maximize/minimize/fullscreen/close/
 * always-on-top 等窗口控制 IPC 入口的注册与维护。
 *
 * 窗口内部状态（isAlwaysOnTop / 全屏）由本控制器持有，
 * index.ts 通过 getMainWindow() / toggleWindowFullscreen() 只读驱动，
 * window:* 通道对 renderer 调用面保持完全兼容。
 */
export class MainWindowController {
  private window: BrowserWindow | null = null
  private alwaysOnTop = false
  /**
   * 播放页窗口级全屏（透明窗口模拟全屏）：
   * Electron 33 Windows：透明窗口被强制去掉 WS_THICKFRAME，setFullScreen 走
   * SetBounds 模拟路径（进入时保存 bounds 并铺满显示器、退出时恢复），且
   * widget 的原生全屏状态从未被置位 —— isFullScreen() 恒为 false。
   * 因此不能用 isFullScreen() 判断当前状态：否则 toggle 永远算出 target=true，
   * 第二次点击仍执行 setFullScreen(true)，还会把 restore_bounds 覆盖成全屏尺寸，
   * 表现为"无法退出全屏"。状态由本模块布尔量维护，enter/leave 事件兜底同步。
   */
  private fullscreen = false

  constructor(private readonly host: MainWindowHost) {}

  /** 返回当前主窗口实例（未创建或已销毁时为 null）。 */
  getMainWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  /** 当前应用自身的置顶设置（供全屏退出时还原）。 */
  isAlwaysOnTop(): boolean {
    return this.alwaysOnTop
  }

  /**
   * 创建主窗口并挂接完整生命周期与安全策略：
   * storage：加载 URL / 本地 HTML、导航拦截、window.open 管控、权限拒绝。
   * 返回新创建的窗口实例。
   */
  create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      icon: this.host.getWindowIcon(), // 统一图标入口：窗口图标读取 build/icon-256.png（透明派生资源）
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      // 透明底（alpha=0）：必须为 '#00000000'。严禁改成不透明 '#000000'，
      // 否则会盖住 mpv native 打孔层，mpv 模式整屏黑屏。
      // 与 html/body 的 background: transparent 配合，圆角由 CSS 决定。
      backgroundColor: '#00000000',
      // 关闭 Windows DWM 原生圆角（Win11 默认裁剪），窗口圆角完全交给 CSS：
      // 普通窗口 #root 12px，全屏 body.app-fullscreen 归零
      roundedCorners: false,
      webPreferences: {
        // out/main/main.js 与 out/preload/preload.js 同级目录结构：上一级即 out/
        preload: join(__dirname, '../preload/preload.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.window = win

    win.on('ready-to-show', () => {
      win.show()
    })

    // 窗口关闭后清除引用，避免后续代码使用已销毁的窗口对象
    win.on('closed', () => {
      this.window = null
    })

    // 原生全屏状态 → 渲染端（UI 隐藏顶栏、ESC 退出等以此为准）；
    // 透明窗口的 setFullScreen 是 SetBounds 模拟路径，不会隐藏任务栏，
    // 全屏期间用 screen-saver 级置顶盖住任务栏，退出后还原应用自身置顶设置。
    win.on('enter-full-screen', () => {
      this.fullscreen = true
      win.setAlwaysOnTop(true, 'screen-saver')
      win.webContents.send('window:fullscreen-changed', true)
    })
    win.on('leave-full-screen', () => {
      this.fullscreen = false
      win.setAlwaysOnTop(this.alwaysOnTop, 'screen-saver') // 还原应用自身的置顶设置
      win.webContents.send('window:fullscreen-changed', false)
    })

    win.webContents.setWindowOpenHandler((details) => {
      try {
        const u = new URL(details.url)
        // 仅允许 http/https 交由系统处理，杜绝 file:/自定义协议等逃逸路径
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          shell.openExternal(details.url)
        }
      } catch {
        // 忽略无法解析的 URL
      }
      return { action: 'deny' }
    })

    // 导航限制：HashRouter 的 hash 变化不经过 will-navigate；这里拦截的是
    // 渲染端发起的跨页导航（XSS 下 window.location = 'https://evil' 之类）。
    // 同页 / 重载放行，其余一律拒绝
    win.webContents.on('will-navigate', (event, url) => {
      const current = win.webContents.getURL() || ''
      if (url === current || url.split('#')[0] === current.split('#')[0]) return
      event.preventDefault()
      console.warn('[security] blocked navigation attempt:', url)
    })

    // L3: 显式拒绝所有权限请求（通知/剪贴板/媒体设备/地理位置等），纵深防御
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      console.warn('[permission] denied:', permission)
      callback(false)
    })

    const levelMap: Record<number, string> = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' }
    win.webContents.on('console-message', (_event, level, message) => {
      this.host.log(levelMap[level] || 'info', message)
    })

    // 捕获渲染进程崩溃
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('Render process gone:', details.reason, details.exitCode)
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Failed to load:', errorCode, errorDescription)
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return win
  }

  /** 窗口级全屏切换，返回切换后的状态。 */
  toggleWindowFullscreen(): boolean {
    const win = this.getMainWindow()
    if (!win) return false
    this.fullscreen = !this.fullscreen
    win.setFullScreen(this.fullscreen)
    return this.fullscreen
  }

  /**
   * 注册 window:* 窗口控制 IPC 通道。
   * 与迁移前的实现保持语义一致（通道名、返回结构、错误行为），
   * renderer 端 window.api.* 调用无需任何改动。
   */
  registerIpc(): void {
    const win = () => this.getMainWindow()

    secureHandleRaw('window:minimize', [], () => {
      win()?.minimize()
    })

    secureHandleRaw('window:maximize', [], () => {
      if (win()?.isMaximized()) {
        win()?.unmaximize()
      } else {
        win()?.maximize()
      }
    })

    secureHandleRaw('window:close', [], () => {
      win()?.close()
    })

    secureHandleRaw('window:always-on-top', [V.optional(V.boolean())], async (_event, enabled?: boolean) => {
      const w = win()
      if (!w) return { success: false, error: '主窗口未创建' }
      this.alwaysOnTop = enabled ?? !this.alwaysOnTop
      w.setAlwaysOnTop(this.alwaysOnTop, 'screen-saver')
      return { success: true, data: this.alwaysOnTop }
    })

    secureHandleRaw('window:toggle-fullscreen', [], () => ({ success: true, data: this.toggleWindowFullscreen() }))
  }
}
