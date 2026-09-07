// 启动外壳：先于一切注册异常捕获，再加载真正的 main bundle。
// 目的：双击 start.bat 闪退时，把真实报错写进 startup-crash.log（无论崩在哪一行）。
//
// 关键修复：本脚本必须运行在 Electron 主进程内（process.type === 'browser'），
// 因为 out/main/main.js 在加载阶段就会读取 electron.app.isPackaged。
// 如果被普通 node 直接执行（如 `node launcher.cjs`），require('electron') 只会
// 返回 electron.exe 的路径字符串，导致 electron.app 为 undefined，main bundle 立即崩溃。
// 因此这里增加自动转交逻辑：检测到非 Electron 环境时，定位 electron.exe 并重新启动自身。
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const LOG = path.join(__dirname, 'startup-crash.log')

// 转交 electron 后再次执行本脚本时，通过该环境变量保留完整启动轨迹（不覆盖日志）
const RESPAWN_ENV = '__HUANYING_LAUNCHER_RESPAWNED'
const isRespawn = process.env[RESPAWN_ENV] === '1'

function log(msg) {
  try { fs.appendFileSync(LOG, msg + '\n') } catch (_) {}
}
function fmt(e) {
  if (!e) return 'undefined'
  if (typeof e === 'string') return e
  if (e.stack) return e.stack
  if (e.message) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

// 镜像 console 到日志，避免信息丢失
const origErr = console.error.bind(console)
const origLog = console.log.bind(console)
console.error = (...a) => { log('[console.error] ' + a.map(fmt).join(' ')); origErr(...a) }
console.log = (...a) => { log('[console.log] ' + a.map(fmt).join(' ')); origLog(...a) }

process.on('uncaughtException', (e) => { log('[uncaughtException] ' + fmt(e)) })
process.on('unhandledRejection', (e) => { log('[unhandledRejection] ' + fmt(e)) })

// 首次启动时清空旧日志；转交重跑时追加，保留完整轨迹
if (!isRespawn) {
  try { fs.writeFileSync(LOG, '') } catch (_) {}
}
log('[launcher] started ' + new Date().toISOString())
log('[launcher] __dirname=' + __dirname)
log('[launcher] cwd=' + process.cwd())
log('[launcher] process.type=' + (typeof process.type === 'string' ? process.type : 'undefined'))
log('[launcher] electron version=' + (process.versions && process.versions.electron ? process.versions.electron : 'unknown'))
log('[launcher] argv=' + JSON.stringify(process.argv))

// Electron 主进程的 process.type === 'browser'；普通 node 为 undefined；渲染进程为 'renderer'
const isElectronMain = typeof process.type === 'string' && process.type === 'browser'

// ==================== 非 Electron 环境自动转交 ====================
if (!isElectronMain) {
  log('[launcher] 检测到非 Electron 主进程环境 (process.type=' + process.type + ')，准备转交给 electron.exe...')

  // 定位 electron.exe：优先用 require('electron') 返回的路径（普通 node 下为字符串），其次回退到 node_modules/electron/dist/electron.exe
  const electronPath = (() => {
    try {
      const p = require('electron')
      if (typeof p === 'string' && p && fs.existsSync(p)) return p
    } catch (_) {}
    const fallback = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (fs.existsSync(fallback)) return fallback
    return null
  })()

  if (!electronPath) {
    const msg = '[launcher][FATAL] 未找到 electron.exe。请先在本目录执行 `npm install` 安装依赖（含 electron），再使用 `start.bat`、`npm start` 或 `npx electron .` 启动。'
    log(msg)
    origErr(msg)
    process.exit(1)
  }

  // 检查 main bundle 是否存在，避免转交后立即崩溃却看不出原因
  const mainBundle = path.join(__dirname, 'out', 'main', 'main.js')
  if (!fs.existsSync(mainBundle)) {
    const msg = '[launcher][FATAL] 未找到构建产物 out/main/main.js。请先执行 `npm run build`（开发可用 `npm run dev`）。'
    log(msg)
    origErr(msg)
    process.exit(1)
  }

  log('[launcher] 转交目标: ' + electronPath)
  log('[launcher] 转交参数: ' + JSON.stringify([__filename, ...process.argv.slice(2)]))

  // electron.exe <launcher.cjs> [extra args...] —— electron 会以 launcher.cjs 作为主入口，
  // 再次执行本脚本，此时 process.type==='browser'，进入下方正常分支加载 main bundle。
  const child = spawn(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [RESPAWN_ENV]: '1' },
    windowsHide: false
  })

  child.on('error', (err) => {
    log('[launcher] 启动 electron.exe 失败: ' + fmt(err))
    origErr('[launcher] 启动 electron.exe 失败:', err.message)
    process.exit(1)
  })
  child.on('close', (code, signal) => {
    if (code === null) {
      log('[launcher] electron.exe 收到信号退出: ' + signal)
      process.exit(1)
    }
    process.exit(code)
  })
  return
}

// ==================== Electron 主进程内的正常启动逻辑 ====================
try {
  const electron = require('electron')
  log('[launcher] require("electron") OK, app available=' + (!!electron.app))
  if (!electron.app) {
    // 理论上 process.type==='browser' 时 app 一定可用；这里防御性处理
    const msg = '[launcher][FATAL] electron.app 不可用 (process.type=' + process.type + ')，Electron 运行时异常。'
    log(msg)
    origErr(msg)
    process.exit(1)
  }

  // 以文件方式启动 (electron launcher.cjs) 时，app.name 默认为 "Electron"，
  // 导致 userData 落到 AppData\Roaming\Electron 而非 huanying，造成配置/缓存分裂。
  // 这里主动读取 package.json 的 name 字段统一设置，与 `electron .` 行为对齐。
  // 必须在 require main bundle 之前设置（main.js 加载阶段就会调用 app.getPath('userData')）。
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
    if (pkg.name && typeof electron.app.setName === 'function') {
      electron.app.setName(pkg.name)
      log('[launcher] app.setName=' + pkg.name + ' (统一 userData 路径)')
    }
  } catch (e) {
    log('[launcher] 读取/设置 app.name 失败(非致命): ' + fmt(e))
  }
} catch (e) {
  log('[launcher] require("electron") 抛错: ' + fmt(e))
  throw e
}

try {
  log('[launcher] requiring main bundle...')
  require('./out/main/main.js')
  log('[launcher] main bundle 加载完成（控制已交还，app 运行中）')
} catch (e) {
  log('[launcher][require-throw] ' + fmt(e))
}
