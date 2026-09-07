/**
 * libmpv SW 渲染链路冒烟测试（方案 C 前置验证）
 *
 * 用纯 Node + koffi 驱动 libmpv-2.dll：
 *   mpv_create → vo=libmpv 初始化 → 创建 SW render context
 *   → loadfile lavfi 测试源 → 等 FILE_LOADED → 等 UPDATE_FRAME
 *   → 渲染一帧 → 校验像素非全零 → 清理退出
 *
 * 运行：node scripts/smoke-mpv-sw.cjs
 * 通过标准：打印 SMOKE PASS；任何一步失败打印 SMOKE FAIL 并以非零码退出。
 */
const { join, dirname } = require('path')
const { existsSync } = require('fs')

const DLL = join(__dirname, '..', 'mpv', 'libmpv-2.dll')
if (!existsSync(DLL)) {
  console.error('SMOKE FAIL: libmpv-2.dll 不存在:', DLL)
  process.exit(1)
}

const koffi = require('koffi')

const k32 = koffi.load('kernel32.dll')
const SetDllDirectoryW = k32.func('SetDllDirectoryW', 'bool', ['str16'])
SetDllDirectoryW(dirname(DLL))

const lib = koffi.load(DLL)
const mpv = {
  create: lib.func('mpv_create', 'void *', []),
  initialize: lib.func('mpv_initialize', 'int', ['void *']),
  terminateDestroy: lib.func('mpv_terminate_destroy', 'void', ['void *']),
  setOptionString: lib.func('mpv_set_option_string', 'int', ['void *', 'str', 'str']),
  command: lib.func('mpv_command', 'int', ['void *', 'void *']),
  waitEvent: lib.func('mpv_wait_event', 'void *', ['void *', 'double']),
  errorString: lib.func('mpv_error_string', 'str', ['int']),
  renderContextCreate: lib.func('mpv_render_context_create', 'int', ['void *', 'void *', 'void *']),
  renderContextFree: lib.func('mpv_render_context_free', 'void', ['void *']),
  renderContextUpdate: lib.func('mpv_render_context_update', 'uint64', ['void *']),
  renderContextRender: lib.func('mpv_render_context_render', 'int', ['void *', 'void *']),
  renderContextReportSwap: lib.func('mpv_render_context_report_swap', 'void', ['void *'])
}
koffi.struct('SmokeEvent', { event_id: 'int', error: 'int' })

const fail = (msg) => {
  console.error('SMOKE FAIL:', msg)
  try { if (ctx) mpv.renderContextFree(ctx) } catch {}
  try { if (handle) mpv.terminateDestroy(handle) } catch {}
  process.exit(1)
}

let handle = null
let ctx = null

console.log('[1/6] mpv_create')
handle = mpv.create()
if (!handle) fail('mpv_create 返回空')

console.log('[2/6] set options + initialize')
mpv.setOptionString(handle, 'vo', 'libmpv')
mpv.setOptionString(handle, 'hwdec', 'no')
mpv.setOptionString(handle, 'idle', 'yes')
let ret = mpv.initialize(handle)
if (ret < 0) fail('mpv_initialize: ' + mpv.errorString(ret))

console.log('[3/6] 创建 SW render context')
const RP = { API_TYPE: 1, SW_SIZE: 17, SW_FORMAT: 18, SW_STRIDE: 19, SW_POINTER: 20 }
const writeParam = (buf, i, type, addr) => {
  buf.writeInt32LE(type, i * 16)
  buf.writeBigUInt64LE(addr, i * 16 + 8)
}
const apiTypeBuf = Buffer.from('sw\0', 'ascii')
const createParams = Buffer.alloc(2 * 16)
writeParam(createParams, 0, RP.API_TYPE, koffi.address(apiTypeBuf))
const outBuf = Buffer.alloc(8)
ret = mpv.renderContextCreate(outBuf, handle, createParams)
if (ret < 0) fail('render_context_create: ' + mpv.errorString(ret))
ctx = koffi.decode(outBuf, 'void *')

console.log('[4/6] loadfile lavfi 测试源')
const buildArgv = (args) => {
  const strs = args.map((s) => Buffer.from(s + '\0', 'utf-8'))
  const arr = Buffer.alloc((args.length + 1) * 8)
  strs.forEach((b, i) => arr.writeBigUInt64LE(koffi.address(b), i * 8))
  arr.__keepAlive = strs
  return arr
}
ret = mpv.command(handle, buildArgv(['loadfile', 'av://lavfi:testsrc2=size=320x240:rate=10', 'replace']))
if (ret < 0) fail('loadfile: ' + mpv.errorString(ret))

console.log('[5/6] 等待 FILE_LOADED')
let loaded = false
const deadline = Date.now() + 8000
while (Date.now() < deadline && !loaded) {
  const evPtr = mpv.waitEvent(handle, 0.2)
  if (!evPtr) continue
  const ev = koffi.decode(evPtr, 'SmokeEvent')
  if (ev.event_id === 8) loaded = true
  else if (ev.event_id === 7) fail('END_FILE 先于 FILE_LOADED（lavfi 源不可用？）')
}
if (!loaded) fail('等待 FILE_LOADED 超时')

console.log('[6/6] 渲染一帧并校验像素')
const W = 320, H = 240, STRIDE = W * 4
const pixRaw = Buffer.alloc(STRIDE * H + 64)
const base = koffi.address(pixRaw)
const aligned = (base + 63n) & ~63n
const pixView = pixRaw.subarray(Number(aligned - base), Number(aligned - base) + STRIDE * H)
const sizeBuf = Buffer.alloc(8)
sizeBuf.writeInt32LE(W, 0); sizeBuf.writeInt32LE(H, 4)
const strideBuf = Buffer.alloc(8)
strideBuf.writeBigUInt64LE(BigInt(STRIDE), 0)
const fmtBuf = Buffer.from('rgb0\0', 'ascii')
const renderParams = Buffer.alloc(5 * 16)
writeParam(renderParams, 0, RP.SW_SIZE, koffi.address(sizeBuf))
writeParam(renderParams, 1, RP.SW_FORMAT, koffi.address(fmtBuf))
writeParam(renderParams, 2, RP.SW_STRIDE, koffi.address(strideBuf))
writeParam(renderParams, 3, RP.SW_POINTER, aligned)

let rendered = false
const deadline2 = Date.now() + 5000
while (Date.now() < deadline2 && !rendered) {
  const flags = mpv.renderContextUpdate(ctx)
  const f = typeof flags === 'bigint' ? flags : BigInt(flags)
  if ((f & 1n) !== 0n) {
    const r = mpv.renderContextRender(ctx, renderParams)
    if (r < 0) fail('render: ' + mpv.errorString(r))
    mpv.renderContextReportSwap(ctx)
    rendered = true
  }
  mpv.waitEvent(handle, 0.01) // 顺带驱动事件泵
}
if (!rendered) fail('等待 UPDATE_FRAME 超时')

let nonZero = 0
for (let i = 0; i < pixView.length; i += 997) if (pixView[i] !== 0) nonZero++
if (nonZero === 0) fail('渲染结果全黑（像素全零）')
console.log(`  帧 ${W}x${H} 抽样非零字节: ${nonZero}`)

mpv.renderContextFree(ctx)
mpv.terminateDestroy(handle)
ctx = null
handle = null
console.log('SMOKE PASS')
process.exit(0)
