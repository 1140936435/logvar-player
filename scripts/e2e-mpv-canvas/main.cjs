/**
 * mpv 画布引擎端到端诊断（黑屏问题定位）
 *
 * 用真实 Electron + 真实 out/preload/preload.js（contextBridge 序列化路径与正式应用完全一致），
 * 在测试页里复刻 MpvCanvasView 的拉帧 + WebGL 上传逻辑，逐环节验证：
 *   [1] mpvRender.play(lavfi) 是否成功
 *   [2] getFrame 是否返回帧 / buffer 跨 contextBridge 后的真实类型与长度
 *   [3] 像素是否非全零（preload 侧 SW 渲染是否真出画）
 *   [4] WebGL 上传 + 绘制后 readPixels 是否非黑（上屏链路是否正常）
 *
 * 运行：node_modules/electron/dist/electron.exe scripts/e2e-mpv-canvas/main.cjs
 * 输出：scripts/e2e-mpv-canvas/e2e.log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const fs = require('fs')

// 测试环境（终端派生进程）GPU 崩溃，用 SwiftShader 跑 WebGL；
// 本测试验证的是数据链路（contextBridge 序列化 + 纹理上传像素），与 GPU 厂商无关
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

const LOG = join(__dirname, 'e2e.log')
fs.writeFileSync(LOG, '[main] start\n')
const wlog = (m) => {
  try { fs.appendFileSync(LOG, m + '\n') } catch { /* ignore */ }
}

app.whenReady().then(() => {
  wlog('[main] ready')

  const win = new BrowserWindow({
    width: 400,
    height: 320,
    show: true,
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.on('console-message', (_e, _level, message) => {
    wlog('[page] ' + message)
    if (message.includes('E2E_DONE')) {
      setTimeout(() => app.quit(), 500)
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    wlog(`[main] 页面加载失败: ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    wlog('[main] 渲染进程崩溃: ' + JSON.stringify(details))
  })

  win.loadFile(join(__dirname, 'test.html'), {
    query: { video: process.env.E2E_VIDEO || 'C:\\Users\\yn\\Videos\\小乖解压.mp4' }
  }).catch((err) => {
    wlog('[main] loadFile 失败: ' + err.message)
  })

  // 兜底退出（两轮各 12s 轮询 + 启动开销）
  setTimeout(() => {
    wlog('[main] 45s 超时强制退出（未收到 E2E_DONE）')
    app.quit()
  }, 45000)
})

process.on('uncaughtException', (err) => {
  wlog('[main] 未捕获异常: ' + (err && err.stack ? err.stack : String(err)))
  app.quit()
})
