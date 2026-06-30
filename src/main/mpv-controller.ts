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
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { app, BrowserWindow, screen } from 'electron'

// ==================== IPC 路径工具 ====================
// mpv 在 Windows 上使用命名管道 (named pipe)，不是 Unix socket 文件
// Node.js net.createConnection 需要 \\.\\pipe\\ 前缀来连接 Windows 命名管道
const isWin32 = process.platform === 'win32'

/** 获取 mpv IPC 连接路径 */
function getIpcConnectPath(socketPath: string): string {
  return isWin32 ? `\\\\.\\pipe\\${socketPath}` : socketPath
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
}

// ==================== Win32 API（通过 koffi） ====================

let win32: {
  CreateWindowExW: Function
  SetWindowPos: Function
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

    console.log(`[MpvController] Creating child window: parent=0x${parentHwnd.toString(16)}, pos=(${x},${y}), size=${width}x${height}`)

    const WS_CHILD = 0x40000000
    const WS_VISIBLE = 0x10000000

    const hwnd = win32.CreateWindowExW(
      0,                          // dwExStyle
      registeredClassName!,       // lpClassName
      '',                         // lpWindowName
      WS_CHILD | WS_VISIBLE,      // dwStyle
      x, y, width, height,       // position & size
      parentHwnd,                 // hWndParent (bigint directly)
      null,                       // hMenu
      win32.GetModuleHandleW(null), // hInstance
      null                        // lpParam
    )

    if (!hwnd) {
      console.error('[MpvController] CreateWindowExW failed')
      return false
    }

    this.childHwnd = hwnd
    console.log('[MpvController] Child window created successfully')
    return true
  }

  /** 更新子窗口位置和大小 */
  updateChildWindowPosition(x: number, y: number, width: number, height: number): void {
    if (!this.childHwnd || !win32 || !koffiModule) return

    const SWP_NOZORDER = 0x0004

    win32.SetWindowPos(this.childHwnd, BigInt(0), x, y, width, height, SWP_NOZORDER)
  }

  /** 销毁子窗口 */
  destroyChildWindow(): void {
    if (this.childHwnd && win32) {
      try {
        win32.DestroyWindow(this.childHwnd)
      } catch (err) {
        console.warn('[MpvController] Failed to destroy child window:', err)
      }
      this.childHwnd = null
    }
  }

  // ==================== mpv 进程管理 ====================

  /** 启动 mpv 进程 */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[MpvController] Already running')
      return
    }

    // mpv 不可用时直接抛出错误
    if (!this.isAvailable()) {
      throw new Error('mpv 未安装或未找到可执行文件')
    }

    // 生成 IPC socket 路径
    const socketDir = join(app.getPath('userData'), 'mpv_ipc')
    this.ipcSocketPath = join(socketDir, `mpv_socket_${Date.now()}.sock`)

    // 构建 mpv 参数
    const mpvArgs: string[] = [
      '--no-terminal',
      '--msg-level=all=debug',
      `--input-ipc-server=${this.ipcSocketPath}`,
      '--hr-seek=absolute',
      '--hr-seek-framedrop=no',
      '--keep-open=yes',
      '--idle=yes',
    ]

    // 硬件解码
    if (this.options.hardwareDecode) {
      mpvArgs.push('--hwdec=auto-safe')
    } else {
      mpvArgs.push('--hwdec=no')
    }

    // HDR 色调映射
    if (this.options.hdrToneMapping) {
      mpvArgs.push('--tone-mapping=auto')
      mpvArgs.push('--tone-mapping-max-boost=2')
    }

    // 嵌入窗口
    if (this.childHwnd && koffiModule) {
      let hwndValue: bigint
      if (this.parentHwndBuffer && this.parentHwndBuffer.length === 8) {
        // 子窗口的 HWND 需要单独获取
        // 从 childHwnd 编码值中提取
        const childBuf = Buffer.alloc(8)
        koffiModule.encode(childBuf, 0, 'void *', this.childHwnd)
        hwndValue = childBuf.readBigUInt64LE(0)
      } else {
        hwndValue = BigInt(0)
      }
      mpvArgs.push(`--wid=${hwndValue}`)
      mpvArgs.push('--no-input-default-bindings')
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
          const line = data.toString().trim()
          chunks.push(line)
          if (chunks.length > 100) chunks.splice(0, 50)
          if (chunks.length <= 10) {
            console.log(`[MpvController] mpv stderr: ${line}`)
          }
          if (chunks.length === 11) {
            console.log(`[MpvController] ... (more stderr lines hidden)`)
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
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  /** 等待 IPC socket 就绪 */
  private waitForSocket(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (isWin32) {
        // Windows: mpv 创建命名管道而非文件，通过 existsSync 永远检测不到
        // 直接等待足够时间让 mpv 创建管道
        console.log('[MpvController] Windows: waiting for named pipe...')
        setTimeout(() => {
          console.log('[MpvController] Named pipe ready (timeout-based)')
          resolve()
        }, 800)
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

  /** 连接 mpv IPC socket */
  private connectIpc(): Promise<void> {
    return new Promise((resolve, reject) => {
      const net = require('net') as typeof import('net')
      const connectPath = getIpcConnectPath(this.ipcSocketPath)
      console.log(`[MpvController] Connecting to IPC: ${connectPath}`)
      const socket = net.createConnection(connectPath)

      let buffer = ''
      let handshakeDone = false

      socket.on('connect', () => {
        console.log('[MpvController] IPC connected')
        // mpv IPC 需要先发送 handshake
        socket.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 2, 'duration'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 3, 'pause'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 4, 'volume'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 5, 'speed'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 6, 'track-list'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 7, 'fullscreen'] }) + '\n')
        socket.write(JSON.stringify({ command: ['observe_property', 8, 'filename'] }) + '\n')
        handshakeDone = true
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
        console.error('[MpvController] IPC error:', err)
        if (!handshakeDone) reject(err)
      })

      socket.on('close', () => {
        console.log('[MpvController] IPC closed')
        this.ipcConnection = null
      })

      this.ipcConnection = socket as unknown as import('net').Socket
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
    // 启动时间轮询（确保时间更新频率足够高）
    this.startTimePolling()
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
    this.stopTimePolling()
    // 每 100ms 轮询时间，确保进度条平滑
    this.timePollTimer = setInterval(async () => {
      if (!this.isRunning || !this.ipcConnection) return
      try {
        const time = await this.getProperty('time-pos')
        if (typeof time === 'number') {
          this.state.timePos = time
          this.emit('time', time)
        }
      } catch { /* ignore */ }
    }, 100)
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
        const timeout = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 2000)
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
    this.pendingRequests.clear()
    this.propertyObservers.clear()
    this.isRunning = false
    console.log('[MpvController] Destroyed')
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

