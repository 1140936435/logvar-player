/**
 * MpvController - mpv 播放器控制器
 * 
 * 功能：
 * 1. 管理 mpv 子进程（通过 node-mpv IPC 通信）
 * 2. Win32 子窗口嵌入（通过 koffi 调用 Win32 API）
 * 3. 播放控制、属性查询、轨道管理
 * 4. 事件转发到渲染进程
 */

import { EventEmitter } from 'events'
import { join, dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { app, BrowserWindow, screen } from 'electron'

/** HWND（void* 返回值可能是 bigint 或 number）转十进制字符串，mpv --wid 接受十进制句柄 */
function hwndToString(hwnd: unknown): string {
  return typeof hwnd === 'bigint' ? hwnd.toString() : String(hwnd)
}

// ==================== IPC 路径工具 ====================
// mpv 在 Windows 上使用命名管道 (named pipe)，不是 Unix socket 文件
// Node.js net.createConnection 需要 \\.\\pipe\\ 前缀来连接 Windows 命名管道
const isWin32 = process.platform === 'win32'

/** 获取 mpv IPC 连接路径 */
function getIpcConnectPath(socketPath: string): string {
  if (!isWin32) return socketPath
  // ipcSocketPath 在 win32 下生成时已包含完整 \\.\pipe\ 前缀，不能重复拼接
  if (socketPath.startsWith('\\\\.\\pipe\\')) return socketPath
  return `\\\\.\\pipe\\${socketPath}`
}

// ==================== 类型定义 ====================

export interface MpvTrack {
  id: number
  type: 'audio' | 'video' | 'sub'
  selected: boolean
  title?: string
  lang?: string
  codec?: string
  'demux-w': number
  'demux-h': number
}

export interface MpvState {
  paused: boolean
  timePos: number
  duration: number
  volume: number
  speed: number
  fullscreen: boolean
  trackList: MpvTrack[]
  filename: string
}

export interface MpvControllerOptions {
  mpvBinary?: string
  hardwareDecode: boolean
  hdrToneMapping: boolean
  debugLog?: boolean
}

// ==================== Win32 API（通过 koffi） ====================

let win32: {
  CreateWindowExW: Function
  SetWindowPos: Function
  ShowWindow: Function
  DestroyWindow: Function
  GetModuleHandleW: Function
  RegisterClassExW: Function
  DefWindowProcW: Function
} | null = null

let koffiModule: typeof import('koffi') | null = null
let registeredClassName: string | null = null
let wndProcCallback: unknown = null

function initWin32(): boolean {
  if (win32) return true
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as typeof import('koffi')
    koffiModule = koffi

    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    // Win32 常量
    const WS_CHILD = 0x40000000
    const WS_VISIBLE = 0x10000000

    // WNDPROC 回调类型
    const WNDPROC = koffi.proto('MpvWndProc', 'int64', [
      'void *', 'uint32', 'uint64', 'int64'
    ])

    // 创建默认窗口过程回调
    const DefWindowProcW = user32.func('DefWindowProcW', 'int64', [
      'void *', 'uint32', 'uint64', 'int64'
    ])

    wndProcCallback = koffi.register((hwnd: unknown, msg: number, wParam: bigint, lParam: bigint) => {
      return DefWindowProcW(hwnd, msg, wParam, lParam)
    }, 'MpvWndProc *')

    // WNDCLASSEXW 结构体
    const WNDCLASSEXW = koffi.struct('MpvWNDCLASSEXW', {
      cbSize: 'uint32',
      style: 'uint32',
      lpfnWndProc: 'MpvWndProc *',
      cbClsExtra: 'int',
      cbWndExtra: 'int',
      hInstance: 'void *',
      hIcon: 'void *',
      hCursor: 'void *',
      hbrBackground: 'void *',
      lpszMenuName: 'str16',
      lpszClassName: 'str16',
      hIconSm: 'void *'
    })

    const GetModuleHandleW = kernel32.func('GetModuleHandleW', 'void *', ['str16'])
    const RegisterClassExW = user32.func('RegisterClassExW', 'uint16', ['MpvWNDCLASSEXW *'])
    const CreateWindowExW = user32.func('CreateWindowExW', 'void *', [
      'uint32', 'str16', 'str16', 'uint32',
      'int', 'int', 'int', 'int',
      'void *', 'void *', 'void *', 'void *'
    ])
    const SetWindowPos = user32.func('SetWindowPos', 'int', [
      'void *', 'void *', 'int', 'int', 'int', 'int', 'uint32'
    ])
    const ShowWindow = user32.func('ShowWindow', 'int', ['void *', 'int'])
    const DestroyWindow = user32.func('DestroyWindow', 'int', ['void *'])

    // 注册窗口类
    const className = `MpvChildWindow_${process.pid}`
    const hInstance = GetModuleHandleW(null)

    const wc = {
      cbSize: WNDCLASSEXW.size,
      style: 0,
      lpfnWndProc: wndProcCallback,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: hInstance,
      hIcon: null,
      hCursor: null,
      hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: className,
      hIconSm: null
    }

    const wcBuf = Buffer.alloc(WNDCLASSEXW.size)
    koffi.encode(wcBuf, 0, WNDCLASSEXW, wc)

    const atom = RegisterClassExW(wcBuf)
    if (atom === 0) {
      console.error('[MpvController] RegisterClassExW failed')
      return false
    }

    registeredClassName = className
    win32 = {
      CreateWindowExW,
      SetWindowPos,
      ShowWindow,
      DestroyWindow,
      GetModuleHandleW,
      RegisterClassExW,
      DefWindowProcW
    }

    console.log('[MpvController] Win32 API initialized successfully')
    return true
  } catch (err) {
    console.error('[MpvController] Failed to initialize Win32 API:', err)
    return false
  }
}

// ==================== MpvController 类 ====================

export class MpvController extends EventEmitter {
  private mpvProcess: ReturnType<typeof import('child_process').spawn> | null = null
  private ipcSocketPath: string = ''
  private childHwnd: unknown = null
  private parentHwndBuffer: Buffer | null = null
  private parentWindow: BrowserWindow | null = null
  private options: MpvControllerOptions
  private state: MpvState = {
    paused: false,
    timePos: 0,
    duration: 0,
    volume: 100,
    speed: 1,
    fullscreen: false,
    trackList: [],
    filename: ''
  }
  private ipcConnection: import('net').Socket | null = null
  private ipcRequestId: number = 0
  private pendingRequests: Map<number, { resolve: Function; reject: Function }> = new Map()
  private propertyObservers: Set<string> = new Set()
  private timePollTimer: ReturnType<typeof setInterval> | null = null
  private mpvBinaryPath: string = ''
  private isRunning: boolean = false
  private loadedFilePath: string = ''
  // 互斥锁：防止 embed/play 并发调用 start() 时重复 spawn 进程
  private startingPromise: Promise<void> | null = null
  /** mpv 渲染窗口（打孔架构）：主窗口身后的 WS_POPUP 顶层窗口，非 WS_CHILD */
  private lastRectDip: { left: number; top: number; width: number; height: number } | null = null
  /** 渲染窗口是否已显示（file-loaded 后才揭示，避免透出桌面） */
  private mpvWindowRevealed = false
  /** 已挂过窗口同步监听的 BrowserWindow（防重复绑定） */
  private winListenersAttachedFor: BrowserWindow | null = null

  constructor(options: MpvControllerOptions) {
    super()
    this.options = options
    this.mpvBinaryPath = options.mpvBinary || this.findMpvBinary()
  }

  // ==================== mpv 二进制查找 ====================

  private findMpvBinary(): string {
    const candidates = [
      // 项目自带
      join(process.resourcesPath, 'mpv', 'mpv.exe'),
      join(app.getAppPath(), 'resources', 'mpv', 'mpv.exe'),
      // 常见安装位置
      join(process.env['USERPROFILE'] || '', 'scoop', 'shims', 'mpv.exe'),
      'C:\\mpv\\mpv.exe',
      join(process.env['ProgramFiles'] || '', 'mpv', 'mpv.exe'),
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        console.log(`[MpvController] Found mpv at: ${p}`)
        return p
      }
    }

    // 尝试 PATH 查找
    try {
      const result = execSync('where mpv', { encoding: 'utf-8', timeout: 3000 })
      const mpvPath = result.trim().split('\n')[0]
      if (mpvPath && existsSync(mpvPath)) {
        console.log(`[MpvController] Found mpv in PATH: ${mpvPath}`)
        return mpvPath
      }
    } catch { /* ignore */ }

    console.warn('[MpvController] mpv binary not found')
    return 'mpv' // fallback to PATH
  }

  // ==================== 窗口管理 ====================

  /** 创建嵌入式子窗口 */
  createChildWindow(parentWindow: BrowserWindow, x: number, y: number, width: number, height: number): boolean {
    // 先销毁旧的子窗口（如果存在）
    this.destroyChildWindow()

    if (!initWin32() || !win32 || !koffiModule) {
      console.error('[MpvController] Win32 not available')
      return false
    }

    // 获取父窗口句柄
    const handleBuf = parentWindow.getNativeWindowHandle()
    this.parentHwndBuffer = handleBuf
    this.parentWindow = parentWindow

    // 读取 HWND（64位 Windows 为 8 字节）
    let parentHwnd: bigint
    if (handleBuf.length === 8) {
      parentHwnd = handleBuf.readBigUInt64LE(0)
    } else {
      parentHwnd = BigInt(handleBuf.readUInt32LE(0))
    }

    console.log(`[MpvController] Creating mpv render window (below main): pos=(${x},${y}), size=${width}x${height}`)

    const WS_POPUP = 0x80000000
    // WS_EX_TOOLWINDOW: 不进任务栏/Alt+Tab；WS_EX_NOACTIVATE: 永不抢焦点。
    // 视频窗口位于主窗口身后，鼠标与键盘输入全部由主窗口（Chromium）接收。
    const WS_EX_TOOLWINDOW = 0x00000080
    const WS_EX_NOACTIVATE = 0x08000000

    // 注意：创建时不可见（无 WS_VISIBLE）。file-loaded 后 revealMpvWindow() 才显示，
    // 避免空窗口在打孔区域透出桌面/白底。
    const hwnd = win32.CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, // dwExStyle
      registeredClassName!,       // lpClassName
      '',                         // lpWindowName
      WS_POPUP,                   // dwStyle（隐藏的顶层弹窗）
      0, 0, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
      null,                       // hWndParent：顶层窗口，非 WS_CHILD
      null,                       // hMenu
      win32.GetModuleHandleW(null), // hInstance
      null                        // lpParam
    )

    if (!hwnd) {
      console.error('[MpvController] CreateWindowExW failed')
      return false
    }

    this.childHwnd = hwnd
    this.lastRectDip = { left: x, top: y, width, height }
    this.mpvWindowRevealed = false

    this.attachWindowListeners(parentWindow)
    this.syncMpvWindowPosition()

    console.log('[MpvController] mpv render window created (hidden, behind main window)')
    return true
  }

  /** 计算视频槽位的屏幕物理像素矩形（contentBounds(DIP) + 视口相对矩形(DIP)，×显示器 scaleFactor） */
  private computeScreenPhysicalRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.parentWindow || this.parentWindow.isDestroyed() || !this.lastRectDip) return null
    try {
      const cb = this.parentWindow.getContentBounds()
      const sf = screen.getDisplayMatching(cb).scaleFactor || 1
      const r = this.lastRectDip
      return {
        x: Math.round((cb.x + r.left) * sf),
        y: Math.round((cb.y + r.top) * sf),
        w: Math.max(1, Math.round(r.width * sf)),
        h: Math.max(1, Math.round(r.height * sf))
      }
    } catch {
      return null
    }
  }

  /** 同步 mpv 渲染窗口位置，并将其插到主窗口正后方（z 序紧邻其下，打孔可见） */
  private syncMpvWindowPosition(): void {
    if (!this.childHwnd || !win32) return
    const rect = this.computeScreenPhysicalRect()
    if (!rect) return
    // hWndInsertAfter = 主窗口 HWND → mpv 窗口被放到主窗口正后方
    let insertAfter: bigint = BigInt(1) // HWND_BOTTOM 兜底
    if (this.parentHwndBuffer && this.parentHwndBuffer.length === 8) {
      insertAfter = this.parentHwndBuffer.readBigUInt64LE(0)
    }
    const SWP_NOACTIVATE = 0x0010
    try {
      win32.SetWindowPos(this.childHwnd, insertAfter, rect.x, rect.y, rect.w, rect.h, SWP_NOACTIVATE)
    } catch (err) {
      console.warn('[MpvController] SetWindowPos failed:', err)
    }
  }

  /** file-loaded 后显示渲染窗口（打孔透出画面）。延迟由调用方控制。 */
  private revealMpvWindow(): void {
    if (!this.childHwnd || !win32 || this.mpvWindowRevealed) return
    this.mpvWindowRevealed = true
    const SW_SHOWNA = 8
    try {
      win32.ShowWindow(this.childHwnd, SW_SHOWNA)
    } catch { /* ignore */ }
    this.syncMpvWindowPosition()
    console.log('[MpvController] mpv render window revealed')
  }

  /** 主窗口移动/缩放/全屏/最小化时同步渲染窗口（一次性绑定） */
  private attachWindowListeners(win: BrowserWindow): void {
    if (this.winListenersAttachedFor === win) return
    this.winListenersAttachedFor = win
    const sync = (): void => { if (this.childHwnd) this.syncMpvWindowPosition() }
    win.on('move', sync)
    win.on('resize', sync)
    win.on('maximize', sync)
    win.on('enter-full-screen', sync)
    win.on('leave-full-screen', sync)
    win.on('restore', () => {
      if (!this.childHwnd) return
      if (this.mpvWindowRevealed) {
        try { win32?.ShowWindow(this.childHwnd, 8) } catch { /* ignore */ }
      }
      sync()
    })
    win.on('minimize', () => {
      if (this.childHwnd) {
        try { win32?.ShowWindow(this.childHwnd, 0) } catch { /* ignore */ } // SW_HIDE
      }
    })
    win.on('closed', () => { this.winListenersAttachedFor = null })
  }

  /** 更新渲染窗口位置和大小（DIP 视口坐标，随主窗口移动自动跟随） */
  updateChildWindowPosition(x: number, y: number, width: number, height: number): void {
    this.lastRectDip = { left: x, top: y, width, height }
    if (!this.childHwnd) return
    this.syncMpvWindowPosition()
  }

  /** 销毁渲染窗口 */
  destroyChildWindow(): void {
    if (this.childHwnd && win32) {
      try {
        win32.DestroyWindow(this.childHwnd)
      } catch (err) {
        console.warn('[MpvController] Failed to destroy child window:', err)
      }
      this.childHwnd = null
    }
    this.mpvWindowRevealed = false
  }

  // ==================== mpv 进程管理 ====================

  /** 启动 mpv 进程 */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[MpvController] Already running')
      return
    }

    // 互斥锁：若已有 start() 在进行中，复用同一个 Promise 防止重复 spawn
    if (this.startingPromise) {
      return this.startingPromise
    }

    // mpv 不可用时直接抛出错误
    if (!this.isAvailable()) {
      throw new Error('mpv 未安装或未找到可执行文件')
    }

    // 立即记录 in-flight Promise，防止 embed/play 并发调用导致重复 spawn
    const p = this.performStart()
    this.startingPromise = p
    try {
      await p
    } finally {
      // 清除互斥锁，允许后续 start() 调用
      if (this.startingPromise === p) {
        this.startingPromise = null
      }
    }
  }

  /** start() 的实际执行体（已通过互斥锁保护） */
  private async performStart(): Promise<void> {
    // 生成 IPC 路径
    // Windows: mpv 要求命名管道完整路径 \\.\pipe\<name>，且必须原样传给 --input-ipc-server；
    // 传入普通文件路径时 mpv 无法创建服务端。Unix/macOS 使用 socket 文件。
    if (isWin32) {
      this.ipcSocketPath = `\\\\.\\pipe\\huanying-mpv-${process.pid}-${Date.now()}`
    } else {
      const socketDir = join(app.getPath('userData'), 'mpv_ipc')
      if (!existsSync(socketDir)) mkdirSync(socketDir, { recursive: true })
      this.ipcSocketPath = join(socketDir, `mpv_socket_${Date.now()}.sock`)
    }

    // 构建 mpv 参数
    const mpvArgs: string[] = [
      '--no-terminal',
      // 注意：--no-terminal 会丢弃全部终端输出（含日志），verbose 日志须落文件（见 debugLog 分支）
      this.options.debugLog ? '--msg-level=all=v' : '--msg-level=all=warn',
      `--input-ipc-server=${this.ipcSocketPath}`,
      '--hr-seek=absolute',
      '--hr-seek-framedrop=no',
      '--keep-open=yes',
      '--idle=yes',
      // 未嵌入子窗口（独立窗口模式）时也强制创建播放窗口
      '--force-window=yes',
      // 显式指定视频输出与 GPU API，消除默认配置不确定性
      '--vo=gpu',
      '--gpu-api=d3d11',
    ]

    // 调试日志：--no-terminal 下 stderr 不可用，用 --log-file 采集 mpv verbose 日志
    // （每次启动覆盖写入，路径：userData/logs/mpv-debug.log）
    if (this.options.debugLog) {
      const logDir = join(app.getPath('userData'), 'logs')
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
      mpvArgs.push(`--log-file=${join(logDir, 'mpv-debug.log')}`)
      console.log(`[MpvController] mpv debug log: ${join(logDir, 'mpv-debug.log')}`)
    }

    // 硬件解码：多方式列表（mpv 原生逐个尝试，每个文件加载时重新探测）。
    // 单独 --hwdec=d3d11va 在 Optimus 双显卡笔记本上会失败——mpv 的 D3D11 渲染设备
    // 选了 NVIDIA，而 ffmpeg d3d11va 解码设备可能落在 Intel 核显上，枚举不到 HEVC
    // profile（No decoder device for codec found）。列表让 mpv 在 d3d11va 失败后
    // 自动尝试 nvdec-copy（NVIDIA 直连，-copy 不依赖 VO interop）等其余方式。
    if (this.options.hardwareDecode) {
      mpvArgs.push('--hwdec=d3d11va,nvdec-copy,dxva2-copy,qsv-copy')
    } else {
      mpvArgs.push('--hwdec=no')
    }

    // HDR 色调映射（使用 bt.2390 算法，比 auto 更稳定）
    if (this.options.hdrToneMapping) {
      mpvArgs.push('--tone-mapping=bt.2390')
      mpvArgs.push('--tone-mapping-max-boost=2')
    }

    // 嵌入窗口：把 createChildWindow 创建的子窗口句柄交给 mpv，
    // mpv 会把视频渲染到该子窗口（而非自己新建顶层窗口）
    if (this.childHwnd) {
      mpvArgs.push(`--wid=${hwndToString(this.childHwnd)}`)
      // 嵌入模式禁用 mpv 自身键鼠绑定，输入事件由 Electron 窗口统一处理
      mpvArgs.push('--no-input-default-bindings')
      // 关键：默认 flip-model 交换链对子窗口（--wid）呈现异常——初始化成功但画面不上屏（黑屏）。
      // 关闭 flip 改用 bitblt 模式：D3D11 将帧拷贝到后缓冲再 Present，兼容子窗口场景。
      // 注意选项名是 --d3d11-flip（Flag），非新版 mpv 的 --gpu-d3d11-swapchain-mode；
      // 传错选项名会导致 mpv 启动即退出、IPC 管道从未创建（connect ENOENT）。
      mpvArgs.push('--d3d11-flip=no')
    }

    console.log(`[MpvController] Starting mpv: ${this.mpvBinaryPath}`)
    console.log(`[MpvController] Args: ${mpvArgs.join(' ')}`)

    // mpv 需要从其自身目录启动以找到配置文件 (fonts.conf 等)
    const mpvCwd = dirname(this.mpvBinaryPath)

    try {
      const { spawn } = require('child_process') as typeof import('child_process')
      this.mpvProcess = spawn(this.mpvBinaryPath, mpvArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: mpvCwd,
        detached: false,
        env: { ...process.env }
      })

      // 捕获 mpv stderr 输出用于调试
      if (this.mpvProcess.stderr) {
        const chunks: string[] = []
        this.mpvProcess.stderr.on('data', (data: Buffer) => {
          // 一次 data 可能包含多行，逐行处理保证日志准确
          for (const rawLine of data.toString().split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line) continue
            chunks.push(line)
            if (chunks.length > 100) chunks.splice(0, 50)
            if (chunks.length <= 10) {
              console.log(`[MpvController] mpv stderr: ${line}`)
            }
            if (chunks.length === 11) {
              console.log(`[MpvController] ... (more stderr lines hidden)`)
            }
          }
        })
      }
      if (this.mpvProcess.stdout) {
        const chunks: string[] = []
        this.mpvProcess.stdout.on('data', (data: Buffer) => {
          const line = data.toString().trim()
          chunks.push(line)
          if (chunks.length > 100) chunks.splice(0, 50)
          if (chunks.length <= 10) {
            console.log(`[MpvController] mpv stdout: ${line}`)
          }
        })
      }

      this.mpvProcess.on('error', (err) => {
        console.error('[MpvController] Process error:', err)
        this.isRunning = false
        this.emit('error', err)
      })

      this.mpvProcess.on('exit', (code) => {
        console.log(`[MpvController] Process exited with code ${code}`)
        this.isRunning = false
        this.emit('quit')
        this.cleanup()
        this.destroyChildWindow()
      })

      // 等待 IPC socket 就绪
      await this.waitForSocket()

      // 连接 IPC
      await this.connectIpc()

      this.isRunning = true
      this.emit('ready')
      console.log('[MpvController] Started successfully')
    } catch (err) {
      console.error('[MpvController] Failed to start:', err)
      // spawn 失败时清理可能残留的 mpv 僵尸进程
      if (this.mpvProcess && this.mpvProcess.pid) {
        try {
          if (isWin32) {
            require('child_process').execSync(
              `taskkill /pid ${this.mpvProcess.pid} /f /t`,
              { stdio: 'ignore', timeout: 3000 }
            )
          } else {
            this.mpvProcess.kill('SIGKILL')
          }
        } catch { /* 进程可能已退出 */ }
        this.cleanup()
        this.mpvProcess = null
      }
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  /** 等待 IPC socket 就绪 */
  private waitForSocket(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (isWin32) {
        // Windows: mpv 创建命名管道而非文件，existsSync 永远检测不到；
        // 就绪状态由 connectIpc() 的连接重试保证
        resolve()
      } else {
        // Unix/macOS: 继续使用文件检测
        const start = Date.now()
        const check = (): void => {
          if (existsSync(this.ipcSocketPath)) {
            setTimeout(resolve, 100)
            return
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error('IPC socket timeout'))
            return
          }
          setTimeout(check, 50)
        }
        check()
      }
    })
  }

  /** 连接 mpv IPC socket（Windows 命名管道创建有延迟，需要重试） */
  private connectIpc(attempt = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const net = require('net') as typeof import('net')
      const connectPath = getIpcConnectPath(this.ipcSocketPath)
      const maxAttempts = isWin32 ? 40 : 1 // Windows: 每 250ms 重试，最长 10s
      if (attempt === 0) {
        console.log(`[MpvController] Connecting to IPC: ${connectPath}`)
      }

      let buffer = ''
      let settled = false

      const socket = net.createConnection(connectPath)

      socket.on('connect', () => {
        settled = true
        console.log(`[MpvController] IPC connected${attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''}`)
        // 订阅 mpv 属性变化事件
        socket.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 2, 'duration'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 3, 'pause'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 4, 'volume'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 5, 'speed'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 6, 'track-list'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 7, 'fullscreen'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 8, 'filename'] }) + '\n')
        this.ipcConnection = socket as unknown as import('net').Socket
        resolve()
      })

      socket.on('data', (data: Buffer) => {
        buffer += data.toString('utf-8')
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            this.handleIpcMessage(msg)
          } catch { /* ignore parse errors */ }
        }
      })

      socket.on('error', (err: Error) => {
        if (settled) {
          console.error('[MpvController] IPC error:', err)
          return
        }
        // 连接建立前的错误（管道尚不存在）
        socket.destroy()
        // 快速失败：mpv 进程已退出（多为非法启动参数导致秒退），不必重试到超时
        if (this.mpvProcess && this.mpvProcess.exitCode !== null) {
          reject(new Error(`mpv 进程启动后立即退出（exitCode=${this.mpvProcess.exitCode}），通常是启动参数无效或二进制异常`))
          return
        }
        if (attempt + 1 < maxAttempts) {
          setTimeout(() => {
            this.connectIpc(attempt + 1).then(resolve).catch(reject)
          }, 250)
        } else {
          reject(err)
        }
      })

      socket.on('close', () => {
        console.log('[MpvController] IPC closed')
        if (this.ipcConnection === (socket as unknown as import('net').Socket)) {
          this.ipcConnection = null
        }
        // 拒绝所有挂起的 IPC 请求，避免调用方永远 pending
        this.pendingRequests.forEach(p => p.reject(new Error('IPC connection closed')))
        this.pendingRequests.clear()
      })
    })
  }

  /** 处理 mpv IPC 消息 */
  private handleIpcMessage(msg: Record<string, unknown>): void {
    // 属性变化事件
    if (msg.event === 'property-change') {
      const name = msg.name as string
      const data = msg.data as unknown

      switch (name) {
        case 'time-pos':
          this.state.timePos = typeof data === 'number' ? data : 0
          this.emit('time', this.state.timePos)
          break
        case 'duration':
          this.state.duration = typeof data === 'number' ? data : 0
          this.emit('duration', this.state.duration)
          break
        case 'pause':
          this.state.paused = data === true
          this.emit('pause', this.state.paused)
          break
        case 'volume':
          this.state.volume = typeof data === 'number' ? data : 100
          this.emit('volume', this.state.volume)
          break
        case 'speed':
          this.state.speed = typeof data === 'number' ? data : 1
          this.emit('speed', this.state.speed)
          break
        case 'track-list':
          if (Array.isArray(data)) {
            this.state.trackList = data.map((t: Record<string, unknown>) => ({
              id: t.id as number,
              type: t.type as 'audio' | 'video' | 'sub',
              selected: t.selected as boolean,
              title: t.title as string | undefined,
              lang: t.lang as string | undefined,
              codec: t.codec as string | undefined,
              'demux-w': (t['demux-w'] as number) || 0,
              'demux-h': (t['demux-h'] as number) || 0
            }))
            this.emit('track-list', this.state.trackList)
          }
          break
        case 'fullscreen':
          this.state.fullscreen = data === true
          this.emit('fullscreen', this.state.fullscreen)
          break
        case 'filename':
          this.state.filename = typeof data === 'string' ? data : ''
          break
      }
      return
    }

    // 命令回复
    if ('request_id' in msg) {
      const id = msg.request_id as number
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        if (msg.error && msg.error !== 'success') {
          pending.reject(new Error(String(msg.error)))
        } else {
          pending.resolve(msg.data)
        }
      }
      return
    }

    // 文件加载事件
    if (msg.event === 'file-loaded') {
      this.emit('file-loaded')
      // 打孔揭示：延迟 150ms 等渲染端收到同一事件并把视频区域切透明后重绘，
      // 避免渲染端仍是黑底时揭示（黑底盖住 → 只是黑一瞬），或提前揭示透出桌面。
      setTimeout(() => this.revealMpvWindow(), 150)
    }

    // 播放开始
    if (msg.event === 'start') {
      this.emit('start')
    }

    // 播放停止
    if (msg.event === 'end-file') {
      this.emit('stop')
    }

    // seek 事件
    if (msg.event === 'seek') {
      this.emit('seek')
    }

    // idle 事件
    if (msg.event === 'idle') {
      this.emit('idle')
    }
  }

  /** 发送 IPC 命令 */
  private sendCommand(command: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ipcConnection) {
        reject(new Error('IPC not connected'))
        return
      }
      const id = ++this.ipcRequestId
      let timer: ReturnType<typeof setTimeout> | null = null
      this.pendingRequests.set(id, {
        resolve: (v: unknown) => { if (timer) clearTimeout(timer); resolve(v) },
        reject: (e: unknown) => { if (timer) clearTimeout(timer); reject(e) }
      })
      const msg = JSON.stringify({ command, request_id: id }) + '\n'
      this.ipcConnection.write(msg)

      // 超时处理
      timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`Command timeout: ${JSON.stringify(command)}`))
        }
      }, 10000)
    })
  }

  // ==================== 播放控制 ====================

  /** 加载文件 */
  async loadFile(filePath: string): Promise<void> {
    this.loadedFilePath = filePath
    await this.sendCommand(['loadfile', filePath, 'replace'])
    // 时间更新通过 connectIpc() 中的 observe_property(time-pos) 推送，无需主动轮询
  }

  /** 获取已加载的完整文件路径/URL */
  getLoadedFilePath(): string {
    return this.loadedFilePath
  }

  /** 播放 */
  async play(): Promise<void> {
    await this.sendCommand(['set_property', 'pause', false])
  }

  /** 暂停 */
  async pause_(): Promise<void> {
    await this.sendCommand(['set_property', 'pause', true])
  }

  /** 停止 */
  async stop(): Promise<void> {
    this.stopTimePolling()
    await this.sendCommand(['stop'])
  }

  /** 跳转到指定位置（秒） */
  async seek(position: number): Promise<void> {
    await this.sendCommand(['seek', position, 'absolute'])
  }

  /** 设置音量 (0-100) */
  async setVolume(volume: number): Promise<void> {
    await this.sendCommand(['set_property', 'volume', Math.max(0, Math.min(150, volume))])
  }

  /** 设置播放速度 */
  async setSpeed(speed: number): Promise<void> {
    await this.sendCommand(['set_property', 'speed', Math.max(0.25, Math.min(16, speed))])
  }

  /** 切换全屏 */
  async toggleFullscreen(): Promise<void> {
    await this.sendCommand(['cycle', 'fullscreen'])
  }

  /** 设置全屏 */
  async setFullscreen(fullscreen: boolean): Promise<void> {
    await this.sendCommand(['set_property', 'fullscreen', fullscreen])
  }

  // ==================== 轨道管理 ====================

  /** 获取轨道列表 */
  async getTrackList(): Promise<MpvTrack[]> {
    const result = await this.sendCommand(['get_property', 'track-list'])
    if (Array.isArray(result)) {
      return result.map((t: Record<string, unknown>) => ({
        id: t.id as number,
        type: t.type as 'audio' | 'video' | 'sub',
        selected: t.selected as boolean,
        title: t.title as string | undefined,
        lang: t.lang as string | undefined,
        codec: t.codec as string | undefined,
        'demux-w': (t['demux-w'] as number) || 0,
        'demux-h': (t['demux-h'] as number) || 0
      }))
    }
    return this.state.trackList
  }

  /** 选择轨道 */
  async selectTrack(trackId: number): Promise<void> {
    await this.sendCommand(['set_property', `aid`, trackId])
  }

  /** 选择字幕轨道 */
  async selectSubtitle(trackId: number): Promise<void> {
    await this.sendCommand(['set_property', 'sid', trackId])
  }

  /** 关闭字幕 */
  async disableSubtitle(): Promise<void> {
    await this.sendCommand(['set_property', 'sid', 'no'])
  }

  /** 加载外部字幕文件 */
  async loadExternalSubtitle(subtitlePath: string): Promise<void> {
    await this.sendCommand(['sub-add', subtitlePath])
  }

  // ==================== 属性查询 ====================

  /** 获取属性 */
  async getProperty(name: string): Promise<unknown> {
    return await this.sendCommand(['get_property', name])
  }

  /** 设置属性 */
  async setProperty(name: string, value: unknown): Promise<void> {
    await this.sendCommand(['set_property', name, value])
  }

  /** 获取当前状态 */
  getState(): MpvState {
    return { ...this.state }
  }

  /** 截图 */
  async screenshot(filePath: string): Promise<void> {
    await this.sendCommand(['screenshot-to-file', filePath])
  }

  // ==================== 时间轮询 ====================

  private startTimePolling(): void {
    // 已在 connectIpc() 中通过 observe_property(time-pos) 订阅时间变化，
    // 主动轮询会导致双重通道并浪费 IPC 带宽，这里保留为 no-op 以兼容旧调用点
    this.stopTimePolling()
  }

  private stopTimePolling(): void {
    if (this.timePollTimer) {
      clearInterval(this.timePollTimer)
      this.timePollTimer = null
    }
  }

  // ==================== 清理 ====================

  private cleanup(): void {
    this.stopTimePolling()

    if (this.ipcConnection) {
      try { this.ipcConnection.destroy() } catch { /* ignore */ }
      this.ipcConnection = null
    }

    // 拒绝所有挂起的 IPC 请求，避免调用方永远 pending
    this.pendingRequests.forEach(p => p.reject(new Error('IPC connection closed')))
    this.pendingRequests.clear()
    this.propertyObservers.clear()

    // 清理 IPC socket 文件（仅 Unix/macOS，Windows 使用命名管道无需清理）
    if (!isWin32) {
      try {
        const fs = require('fs')
        if (existsSync(this.ipcSocketPath)) {
          fs.unlinkSync(this.ipcSocketPath)
        }
      } catch { /* ignore */ }
    }
  }

  /** 销毁控制器 */
  async destroy(): Promise<void> {
    this.stopTimePolling()
    this.destroyChildWindow()

    if (this.mpvProcess) {
      const proc = this.mpvProcess
      const exitPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (process.platform === 'win32') {
            // Windows 不支持 SIGKILL，需要用 taskkill
            try {
              require('child_process').execSync(`taskkill /pid ${proc.pid} /f /t`, { timeout: 3000 })
            } catch { /* taskkill 可能因进程已退出而报错 */ }
          } else {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 2000)
        proc.once('exit', () => { clearTimeout(timeout); resolve() })
      })
      try {
        // 优先通过 IPC 优雅退出
        if (this.ipcConnection) {
          await this.sendCommand(['quit']).catch(() => {})
        }
      } catch { /* ignore */ }
      await exitPromise
      this.mpvProcess = null
    }

    if (this.ipcConnection) {
      try { (this.ipcConnection as any).destroy() } catch { /* ignore */ }
      this.ipcConnection = null
    }
    // 拒绝所有挂起的 IPC 请求，避免调用方永远 pending
    this.pendingRequests.forEach(p => p.reject(new Error('IPC connection closed')))
    this.pendingRequests.clear()
    this.propertyObservers.clear()
    this.isRunning = false
    console.log('[MpvController] Destroyed')
  }

  /** 退出钩子用：同步强制结束 mpv 进程树（destroy() 是异步的，will-quit 不等异步） */
  killSync(): void {
    if (this.mpvProcess && this.mpvProcess.pid && !this.mpvProcess.killed) {
      const pid = this.mpvProcess.pid
      try {
        if (isWin32) {
          require('child_process').execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore', timeout: 3000 })
        } else {
          this.mpvProcess.kill('SIGKILL')
        }
      } catch { /* 进程可能已退出 */ }
    }
    this.isRunning = false
    this.stopTimePolling()
  }

  /** 检查 mpv 是否可用 */
  isAvailable(): boolean {
    // 只有实际找到二进制文件才算可用，不要仅凭字符串 'mpv' fallback
    if (!this.mpvBinaryPath || this.mpvBinaryPath === 'mpv') return false
    return existsSync(this.mpvBinaryPath)
  }

  /** 检查 mpv 是否正在运行 */
  isMpvRunning(): boolean {
    return this.isRunning
  }

  /** 检查是否有嵌入式子窗口 */
  hasChildWindow(): boolean {
    return this.childHwnd !== null
  }
}

