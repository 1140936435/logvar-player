/**
 * MpvRenderBridge - libmpv 画布渲染引擎（方案 C：视频作为 DOM 层）
 *
 * 与主进程 MpvController（打孔架构）完全不同的链路：
 * - 在 preload（Node 环境）通过 koffi 直接加载 libmpv-2.dll，进程内创建 mpv 实例
 * - vo=libmpv + MPV_RENDER_API_TYPE_SW：帧由 libmpv 软件渲染进预分配环形缓冲
 * - 渲染端经 contextBridge 拉帧（getFrame），上传到 WebGL 纹理绘制成 <canvas>
 *   → 视频变成普通 DOM 层，控件/弹幕/字幕天然覆盖，无需窗口透明打孔
 *
 * 设计约束：
 * - 不使用 mpv_render_context_set_update_callback（回调来自 mpv 内部线程，
 *   koffi 跨线程回调风险高）；改为 8ms 轮询 mpv_render_context_update
 * - 事件/属性同样轮询（mpv_wait_event(0) + mpv_get_property），避免结构体深解析
 * - 命令全部走 mpv_command argv 数组（不用 command_string，规避路径转义问题）
 * - 单缓冲即可：JS 单线程，getFrame 的结构化克隆天然完成拷贝，无读写竞争
 *
 * 已知取舍（v1）：
 * - SW 渲染 = 每帧一次 YUV→RGB CPU 转换 + 一次结构化克隆 + 一次纹理上传。
 *   1080p24/30 轻松；4K60 会吃紧 → 保留打孔引擎作为高性能回退
 * - HDR 色调映射在 SW 路径下能力有限
 * - 后续可平滑升级为原生 N-API addon（GL render API + PBO），渲染端零改动
 */

import { join, dirname } from 'path'
import { existsSync } from 'fs'

// ==================== libmpv 常量（与 mpv/include/mpv/*.h 对齐） ====================

/** mpv_render_param_type */
const RP = {
  API_TYPE: 1,
  SW_SIZE: 17,
  SW_FORMAT: 18,
  SW_STRIDE: 19,
  SW_POINTER: 20
} as const

/** mpv_render_update_flag */
const MPV_RENDER_UPDATE_FRAME = 1n

/** mpv_event_id（仅使用事件号，不解析 payload，end-file 除外） */
const EV = {
  SHUTDOWN: 1,
  LOG_MESSAGE: 2,
  END_FILE: 7,
  FILE_LOADED: 8,
  IDLE: 11,
  SEEK: 20,
  PLAYBACK_RESTART: 21
} as const

/** mpv_format */
const FMT = { FLAG: 3, INT64: 4, DOUBLE: 5 } as const

/** SW 像素格式："rgb0" = 内存字节序 R,G,B,X（X 为未初始化字节），直接按 RGBA 上传 WebGL，着色器强制 alpha=1 */
const SW_FORMAT = 'rgb0'

/** 渲染目标尺寸上限（防止超大窗口导致 SW 渲染爆内存/CPU） */
const MAX_TARGET_W = 3840
const MAX_TARGET_H = 2160

/** 轮询间隔：渲染帧检测 8ms（~120Hz，覆盖 60fps 内容），属性/时钟 96ms（~10Hz） */
const RENDER_POLL_MS = 8
const PROP_POLL_TICKS = 12

// ==================== 类型 ====================

export interface MpvRenderOptions {
  hardwareDecode?: boolean
  hdrToneMapping?: boolean
}

export interface MpvRenderFrame {
  seq: number
  width: number
  height: number
  stride: number
  /** rgb0 像素数据（R,G,B,X），长度 = stride * height */
  buffer: Uint8Array
}

type EventCallback = (event: string, data: unknown) => void

interface ApiOk<T> { success: true; data: T }
interface ApiErr { success: false; error: string }
type ApiRes<T> = ApiOk<T> | ApiErr

// koffi 函数签名表（any 以绕开 koffi 复杂的泛型声明）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any

// ==================== 模块状态（每个 preload 实例单例） ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffi: any = null
let libLoaded = false
let mpv: Record<string, Fn> = {}
let kernel32: Record<string, Fn> = {}

let mpvHandle: unknown = null
let renderCtx: unknown = null
let renderLoop: ReturnType<typeof setInterval> | null = null
let destroyed = true

// 帧缓冲（尺寸变化时重建）
let pixelBuf: Buffer | null = null
let pixelView: Buffer | null = null
let sizeBuf: Buffer | null = null
let strideBuf: Buffer | null = null
let fmtBuf: Buffer | null = null
let createParamsBuf: Buffer | null = null
let renderParamsBuf: Buffer | null = null
let frameW = 0
let frameH = 0
let frameStride = 0
let targetW = 960
let targetH = 540

let seq = 0
let propTick = 0
const lastProps: Record<string, number | boolean | null> = {
  'time-pos': null,
  duration: null,
  pause: null,
  volume: null,
  speed: null
}

const eventCallbacks = new Set<EventCallback>()

function emit(event: string, data?: unknown): void {
  for (const cb of eventCallbacks) {
    try { cb(event, data) } catch { /* 回调异常不影响渲染循环 */ }
  }
}

// ==================== libmpv 定位与加载 ====================

function findLibmpv(): string | null {
  const candidates = [
    // 生产环境：electron-builder extraResources → resources/mpv/libmpv-2.dll
    join(process.resourcesPath || '', 'mpv', 'libmpv-2.dll'),
    // 开发环境：out/preload → 项目根 mpv/
    join(__dirname, '..', '..', 'mpv', 'libmpv-2.dll'),
    join(__dirname, '..', '..', '..', 'mpv', 'libmpv-2.dll')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return null
}

export function isAvailable(): boolean {
  return findLibmpv() !== null
}

function ensureLibLoaded(): boolean {
  if (libLoaded) return true
  const dllPath = findLibmpv()
  if (!dllPath) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi')
    // 先把 libmpv 所在目录加入 DLL 搜索路径，确保其依赖（若有）可解析
    kernel32 = {}
    const k32 = koffi.load('kernel32.dll')
    kernel32.SetDllDirectoryW = k32.func('SetDllDirectoryW', 'bool', ['str16'])
    kernel32.SetDllDirectoryW(dirname(dllPath))

    const lib = koffi.load(dllPath)
    mpv = {
      create: lib.func('mpv_create', 'void *', []),
      initialize: lib.func('mpv_initialize', 'int', ['void *']),
      terminateDestroy: lib.func('mpv_terminate_destroy', 'void', ['void *']),
      setOptionString: lib.func('mpv_set_option_string', 'int', ['void *', 'str', 'str']),
      command: lib.func('mpv_command', 'int', ['void *', 'void *']),
      setPropertyString: lib.func('mpv_set_property_string', 'int', ['void *', 'str', 'str']),
      getProperty: lib.func('mpv_get_property', 'int', ['void *', 'str', 'int', 'void *']),
      waitEvent: lib.func('mpv_wait_event', 'void *', ['void *', 'double']),
      errorString: lib.func('mpv_error_string', 'str', ['int']),
      requestLogMessages: lib.func('mpv_request_log_messages', 'int', ['void *', 'str']),
      renderContextCreate: lib.func('mpv_render_context_create', 'int', ['void *', 'void *', 'void *']),
      renderContextFree: lib.func('mpv_render_context_free', 'void', ['void *']),
      renderContextUpdate: lib.func('mpv_render_context_update', 'uint64', ['void *']),
      renderContextRender: lib.func('mpv_render_context_render', 'int', ['void *', 'void *']),
      renderContextReportSwap: lib.func('mpv_render_context_report_swap', 'void', ['void *'])
    }
    // 事件结构体只需事件号：mpv_event { int event_id; ... }
    koffi.struct('LogvarMpvEvent', { event_id: 'int', error: 'int' })
    // 完整 mpv_event 头：{ int event_id; int error; uint64 reply_userdata; void *data }
    koffi.struct('LogvarMpvEventFull', { event_id: 'int', error: 'int', reply_userdata: 'uint64', data: 'void *' })
    // mpv_event_end_file { int reason; int error; ... }
    koffi.struct('LogvarMpvEndFile', { reason: 'int', error: 'int' })
    // mpv_event_log_message { const char *prefix; const char *level; const char *text; int log_level }
    koffi.struct('LogvarMpvLogMessage', { prefix: 'str', level: 'str', text: 'str', log_level: 'int' })
    libLoaded = true
    return true
  } catch (err) {
    console.error('[mpv-render] 加载 libmpv 失败:', err)
    libLoaded = false
    return false
  }
}

// ==================== 参数缓冲区构造 ====================

/** 向 mpv_render_param 数组缓冲区写入一项：{ int32 type @0; void* data @8 } */
function writeParam(buf: Buffer, index: number, type: number, dataAddr: bigint): void {
  buf.writeInt32LE(type, index * 16)
  buf.writeBigUInt64LE(dataAddr, index * 16 + 8)
}

/** 构造 mpv_command 的 argv 指针数组（NULL 结尾），返回 [数组缓冲, 字符串缓冲列表(保活)] */
function buildArgv(args: string[]): Buffer {
  const strBufs = args.map((s) => Buffer.from(s + '\0', 'utf-8'))
  const arr = Buffer.alloc((args.length + 1) * 8)
  strBufs.forEach((b, i) => arr.writeBigUInt64LE(koffi.address(b), i * 8))
  arr.writeBigUInt64LE(0n, args.length * 8)
  // 字符串缓冲挂到数组缓冲上，防止 GC 提前回收
  ;(arr as unknown as { __keepAlive?: Buffer[] }).__keepAlive = strBufs
  return arr
}

// ==================== 帧缓冲管理 ====================

function ensureFrameBuffers(w: number, h: number): void {
  if (pixelBuf && w === frameW && h === frameH) return
  frameW = w
  frameH = h
  frameStride = w * 4 // 4 字节对齐（满足像素对齐下限）；64 字节对齐的收益留给后续优化
  const total = frameStride * h
  pixelBuf = Buffer.alloc(total + 64)
  // 手动对齐到 64 字节边界（libmpv 推荐，利于 SIMD）
  const base = koffi.address(pixelBuf)
  const aligned = (base + 63n) & ~63n
  const offset = Number(aligned - base)
  pixelView = pixelBuf.subarray(offset, offset + total)

  sizeBuf = Buffer.alloc(8)
  sizeBuf.writeInt32LE(w, 0)
  sizeBuf.writeInt32LE(h, 4)
  strideBuf = Buffer.alloc(8)
  strideBuf.writeBigUInt64LE(BigInt(frameStride), 0)
  if (!fmtBuf) fmtBuf = Buffer.from(SW_FORMAT + '\0', 'ascii')

  renderParamsBuf = Buffer.alloc(5 * 16)
  writeParam(renderParamsBuf, 0, RP.SW_SIZE, koffi.address(sizeBuf))
  writeParam(renderParamsBuf, 1, RP.SW_FORMAT, koffi.address(fmtBuf))
  writeParam(renderParamsBuf, 2, RP.SW_STRIDE, koffi.address(strideBuf))
  writeParam(renderParamsBuf, 3, RP.SW_POINTER, aligned) // SW_POINTER：data 即像素首地址
  writeParam(renderParamsBuf, 4, 0, 0n)
}

// ==================== 事件与属性轮询 ====================

function drainEvents(): void {
  // 单次循环上限，防止异常情况下事件风暴阻塞渲染线程
  for (let i = 0; i < 32; i++) {
    const evPtr = mpv.waitEvent(mpvHandle, 0)
    if (!evPtr) return
    const ev = koffi.decode(evPtr, 'LogvarMpvEvent') as { event_id: number; error: number }
    if (ev.event_id === 0) return
    switch (ev.event_id) {
      case EV.FILE_LOADED:
        emit('file-loaded')
        break
      case EV.PLAYBACK_RESTART:
        emit('start')
        break
      case EV.END_FILE: {
        // 解析 end-file payload：error < 0 表示播放失败（如文件不可读/解码失败）
        let errorMsg = ''
        try {
          const full = koffi.decode(evPtr, 'LogvarMpvEventFull') as { data: unknown }
          if (full.data) {
            const endFile = koffi.decode(full.data, 'LogvarMpvEndFile') as { reason: number; error: number }
            if (endFile.error < 0) errorMsg = mpv.errorString(endFile.error) as string
          }
        } catch { /* ignore */ }
        if (errorMsg) {
          console.error(`[mpv-render] 播放失败: ${errorMsg}`)
          emit('error', errorMsg)
        } else emit('stop')
        break
      }
      case EV.SEEK:
        emit('seek')
        break
      case EV.IDLE:
        emit('idle')
        break
      case EV.SHUTDOWN:
        emit('quit')
        break
      case EV.LOG_MESSAGE: {
        try {
          const full = koffi.decode(evPtr, 'LogvarMpvEventFull') as { data: unknown }
          if (full.data) {
            const msg = koffi.decode(full.data, 'LogvarMpvLogMessage') as { prefix: string; level: string; text: string }
            if (msg.level === 'error' || msg.level === 'fatal') {
              console.error(`[mpv/${msg.prefix}] ${String(msg.text).trim()}`)
            }
          }
        } catch { /* ignore */ }
        break
      }
      default:
        break
    }
  }
}

function getPropDouble(name: string): number | null {
  const buf = Buffer.alloc(8)
  const ret = mpv.getProperty(mpvHandle, name, FMT.DOUBLE, buf)
  if (ret < 0) return null
  const v = buf.readDoubleLE(0)
  return Number.isFinite(v) ? v : null
}

function getPropFlag(name: string): boolean | null {
  const buf = Buffer.alloc(8)
  const ret = mpv.getProperty(mpvHandle, name, FMT.FLAG, buf)
  if (ret < 0) return null
  return buf.readInt32LE(0) !== 0
}

function pollProps(): void {
  const t = getPropDouble('time-pos')
  if (t !== null && t !== lastProps['time-pos']) {
    lastProps['time-pos'] = t
    emit('time', t)
  }
  const d = getPropDouble('duration')
  if (d !== null && d !== lastProps.duration) {
    lastProps.duration = d
    emit('duration', d)
  }
  const p = getPropFlag('pause')
  if (p !== null && p !== lastProps.pause) {
    lastProps.pause = p
    emit('pause', p)
  }
  const v = getPropDouble('volume')
  if (v !== null && v !== lastProps.volume) {
    lastProps.volume = v
    emit('volume', v)
  }
  const s = getPropDouble('speed')
  if (s !== null && s !== lastProps.speed) {
    lastProps.speed = s
    emit('speed', s)
  }
}

// ==================== 渲染循环 ====================

/** 诊断标记：首帧渲染 / 渲染失败只打一次日志，避免刷屏 */
let loggedFirstFrame = false
let renderErrorLogged = false

function renderTick(): void {
  if (!renderCtx || destroyed) return
  try {
    const flagsRaw = mpv.renderContextUpdate(renderCtx)
    const flags = typeof flagsRaw === 'bigint' ? flagsRaw : BigInt(flagsRaw)
    if ((flags & MPV_RENDER_UPDATE_FRAME) !== 0n) {
      ensureFrameBuffers(targetW, targetH)
      const ret = mpv.renderContextRender(renderCtx, renderParamsBuf)
      if (ret >= 0) {
        seq++
        if (!loggedFirstFrame) {
          loggedFirstFrame = true
          console.log(`[mpv-render] 首帧渲染成功 ${frameW}x${frameH}`)
        }
      } else if (!renderErrorLogged) {
        renderErrorLogged = true
        console.error(`[mpv-render] render_context_render 失败: ${mpv.errorString(ret)}（后续失败不再重复记录）`)
      }
      mpv.renderContextReportSwap(renderCtx)
    }
    drainEvents()
    if (++propTick >= PROP_POLL_TICKS) {
      propTick = 0
      pollProps()
    }
  } catch (err) {
    console.error('[mpv-render] 渲染循环异常:', err)
  }
}

// ==================== 生命周期 ====================

function ensureStarted(options: MpvRenderOptions): void {
  if (!destroyed && mpvHandle && renderCtx) return
  if (!ensureLibLoaded()) throw new Error('libmpv-2.dll 未找到或加载失败')

  // 双保险：清除代理 env，防止 ffmpeg 把内网媒体流请求发给系统代理
  // （主进程启动时已删过一次；此处防御 renderer env 未被清理的边界情况）
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete process.env[key]
  }

  mpvHandle = mpv.create()
  if (!mpvHandle) throw new Error('mpv_create 失败')

  const setOpt = (name: string, value: string): void => {
    mpv.setOptionString(mpvHandle, name, value)
  }

  // vo=libmpv 是 render API 的硬性前提；SW 路径硬解必须用 copy-back 变体
  setOpt('vo', 'libmpv')
  setOpt('hwdec', options.hardwareDecode === false ? 'no' : 'd3d11va-copy,nvdec-copy,dxva2-copy,qsv-copy,no')
  setOpt('keep-open', 'yes')
  setOpt('hr-seek', 'absolute')
  setOpt('hr-seek-framedrop', 'no')
  setOpt('idle', 'yes')
  if (options.hdrToneMapping) {
    setOpt('tone-mapping', 'bt.2390')
    setOpt('tone-mapping-max-boost', '2')
  }

  let ret = mpv.initialize(mpvHandle)
  if (ret < 0) {
    const msg = mpv.errorString(ret)
    mpv.terminateDestroy(mpvHandle)
    mpvHandle = null
    throw new Error(`mpv_initialize 失败: ${msg}`)
  }
  mpv.requestLogMessages(mpvHandle, 'warn')

  // render context：params = [ {API_TYPE, "sw"}, {0} ]
  const apiTypeBuf = Buffer.from('sw\0', 'ascii')
  createParamsBuf = Buffer.alloc(2 * 16)
  writeParam(createParamsBuf, 0, RP.API_TYPE, koffi.address(apiTypeBuf))
  writeParam(createParamsBuf, 1, 0, 0n)
  ;(createParamsBuf as unknown as { __keepAlive?: Buffer[] }).__keepAlive = [apiTypeBuf]

  const outBuf = Buffer.alloc(8)
  ret = mpv.renderContextCreate(outBuf, mpvHandle, createParamsBuf)
  if (ret < 0) {
    const msg = mpv.errorString(ret)
    mpv.terminateDestroy(mpvHandle)
    mpvHandle = null
    throw new Error(`创建 SW 渲染上下文失败: ${msg}`)
  }
  renderCtx = koffi.decode(outBuf, 'void *')

  destroyed = false
  seq = 0
  propTick = 0
  loggedFirstFrame = false
  renderErrorLogged = false
  for (const k of Object.keys(lastProps)) lastProps[k] = null
  renderLoop = setInterval(renderTick, RENDER_POLL_MS)
}

export function destroy(): void {
  destroyed = true
  if (renderLoop) {
    clearInterval(renderLoop)
    renderLoop = null
  }
  try {
    if (renderCtx) mpv.renderContextFree(renderCtx)
  } catch { /* ignore */ }
  renderCtx = null
  try {
    if (mpvHandle) mpv.terminateDestroy(mpvHandle)
  } catch { /* ignore */ }
  mpvHandle = null
  pixelBuf = null
  pixelView = null
  renderParamsBuf = null
  createParamsBuf = null
  seq = 0
  frameW = 0
  frameH = 0
  for (const k of Object.keys(lastProps)) lastProps[k] = null
}

// ==================== 对外 API（与主进程 mpv 控制面保持一致的方法名） ====================

export async function play(filePath: string, options: MpvRenderOptions = {}): Promise<ApiRes<void>> {
  try {
    ensureStarted(options)
    const argv = buildArgv(['loadfile', filePath, 'replace'])
    const ret = mpv.command(mpvHandle, argv)
    if (ret < 0) return { success: false, error: mpv.errorString(ret) as string }
    return { success: true, data: undefined }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function simpleCommand(args: string[]): ApiRes<void> {
  try {
    if (!mpvHandle || destroyed) return { success: false, error: 'mpv 渲染引擎未运行' }
    const ret = mpv.command(mpvHandle, buildArgv(args))
    if (ret < 0) return { success: false, error: mpv.errorString(ret) as string }
    return { success: true, data: undefined }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function simpleSetProp(name: string, value: string): ApiRes<void> {
  try {
    if (!mpvHandle || destroyed) return { success: false, error: 'mpv 渲染引擎未运行' }
    const ret = mpv.setPropertyString(mpvHandle, name, value)
    if (ret < 0) return { success: false, error: mpv.errorString(ret) as string }
    return { success: true, data: undefined }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function stop(): Promise<ApiRes<void>> { return simpleCommand(['stop']) }
export async function pause(): Promise<ApiRes<void>> { return simpleSetProp('pause', 'yes') }
export async function resume(): Promise<ApiRes<void>> { return simpleSetProp('pause', 'no') }
export async function seek(position: number): Promise<ApiRes<void>> {
  return simpleCommand(['seek', String(Math.max(0, position)), 'absolute'])
}
export async function setVolume(volume: number): Promise<ApiRes<void>> {
  return simpleSetProp('volume', String(Math.max(0, Math.min(150, Math.round(volume)))))
}
export async function setSpeed(speed: number): Promise<ApiRes<void>> {
  return simpleSetProp('speed', String(Math.max(0.25, Math.min(16, speed))))
}
export async function disableSubtitle(): Promise<ApiRes<void>> { return simpleSetProp('sid', 'no') }

/** 拉取最新帧（无新帧返回 null）；buffer 经 contextBridge 结构化克隆，主世界收到 Uint8Array */
export function getFrame(lastSeq: number): MpvRenderFrame | null {
  if (destroyed || seq === 0 || seq === lastSeq || !pixelView) return null
  return {
    seq,
    width: frameW,
    height: frameH,
    stride: frameStride,
    buffer: pixelView
  }
}

/** 设置渲染目标尺寸（画布 backing store 像素），下一帧生效 */
export function setTargetSize(width: number, height: number): void {
  const w = Math.max(16, Math.min(MAX_TARGET_W, Math.round(width)))
  const h = Math.max(16, Math.min(MAX_TARGET_H, Math.round(height)))
  if (w === targetW && h === targetH) return
  targetW = w
  targetH = h
}

export function onEvent(callback: EventCallback): void {
  eventCallbacks.add(callback)
}

export function offEvent(): void {
  eventCallbacks.clear()
}
