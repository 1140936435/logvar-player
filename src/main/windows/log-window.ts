import { BrowserWindow } from 'electron'
import { join } from 'path'
import { secureHandleRaw } from '../ipc/secure-handle'
import { V } from '../ipc/secure-schema'

/**
 * 日志条目结构（原 index.ts 日志系统共用类型，移出到本模块以便窗口模块复用）。
 */
export interface LogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  message: string
}

/**
 * 日志窗口宿主回调：解耦 index.ts 的日志数据源与窗口模块。
 */
export interface LogWindowHost {
  /** 返回历史日志快照（ready-to-show 时推送给日志窗口）。 */
  getHistory(): LogEntry[]
}

/**
 * 日志窗口控制器（从 index.ts 试点拆分）：
 * 负责日志窗口创建、log preload 关联与生命周期（创建/关闭/销毁）。
 *
 * 日志窗口只暴露 onLogEntry / onLogHistory 两个能力，使用极小的专用
 * preload（log-preload.js），避免把播放器/文件/服务器等高权限 IPC 面
 * 暴露给它（sandbox: true）。
 */
export class LogWindowController {
  private window: BrowserWindow | null = null

  constructor(private readonly host: LogWindowHost) {}

  /** 返回当前日志窗口实例（未创建或已销毁时为 null）。 */
  getLogWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  /** 向日志窗口广播一条新日志（窗口不存在 / 已销毁时静默忽略）。 */
  pushLogEntry(entry: LogEntry): void {
    const win = this.getLogWindow()
    if (win) {
      win.webContents.send('log:entry', entry)
    }
  }

  /** 获取已有日志窗口；不存在则创建并返回（保持原 getLogWindow 语义）。 */
  open(): BrowserWindow {
    const existing = this.getLogWindow()
    if (existing) return existing

    const win = new BrowserWindow({
      width: 900,
      height: 600,
      minWidth: 500,
      minHeight: 300,
      title: '环影 - 日志',
      backgroundColor: '#0d0d0d',
      show: false,
      webPreferences: {
        // 日志窗口只需要 onLogEntry/onLogHistory，用极小的专用 preload，
        // 避免把播放器/文件/服务器等高权限 IPC 面暴露给它
        preload: join(__dirname, '../../preload/log-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    this.window = win

    win.loadFile(join(__dirname, '../log-window.html'))

    win.on('ready-to-show', () => {
      win.show()
      win.webContents.send('log:history', this.host.getHistory())
    })

    win.on('closed', () => {
      this.window = null
    })

    return win
  }

  /** 显示/隐藏切换（托盘、全局快捷键、log:toggle IPC 共用入口）。 */
  toggle(): void {
    const existing = this.getLogWindow()
    if (existing) {
      if (existing.isVisible()) {
        existing.hide()
      } else {
        existing.show()
        existing.focus()
      }
    } else {
      this.open()
    }
  }
}

/**
 * log:send / log:toggle 通道注册宿主（P1 拆分）：
 * 日志通道随日志窗口模块内聚，index 只需注入 addLog 回调与 toggle 入口。
 */
export interface RegisterLogIpcHost {
  addLog(level: LogEntry['level'], source: string, ...args: unknown[]): void
  toggle(): void
}

/** 注册 log:send / log:toggle 通道（通道名/参数/返回与 index 原实现完全一致）。 */
export function registerLogIpc(host: RegisterLogIpcHost): void {
  secureHandleRaw('log:send', [V.string(), V.string()], (_event, level: string, source: string, ...args: unknown[]) => {
    const validLevels = ['info', 'warn', 'error', 'debug']
    const lvl = validLevels.includes(level) ? (level as LogEntry['level']) : 'info'
    host.addLog(lvl, source, ...args)
  })

  secureHandleRaw('log:toggle', [], () => {
    host.toggle()
  })
}
