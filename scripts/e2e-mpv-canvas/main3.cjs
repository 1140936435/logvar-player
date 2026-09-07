/**
 * mpv 画布引擎端到端诊断 v3：透明无边框窗口下的 WebGL 合成验证
 *
 * 复刻真实主窗口的关键属性：transparent:true + frame:false + show:true，
 * 页面内用 rAF 循环（与 MpvCanvasView 完全一致）拉帧上屏，
 * 主进程用 capturePage() 截取【真实合成结果】并分析像素——
 * readPixels 只能证明 drawing buffer 有内容，capturePage 才能证明用户真的看得到。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const fs = require('fs')

// 本测试验证透明窗口合成路径，保留 GPU（禁用 GPU 会改变合成行为，反而测不出差异）
app.commandLine.appendSwitch('no-sandbox')

const LOG = join(__dirname, 'e2e.log')
fs.writeFileSync(LOG, '[main] start\n')
const wlog = (m) => {
  try { fs.appendFileSync(LOG, m + '\n') } catch { /* ignore */ }
}

app.whenReady().then(async () => {
  wlog('[main] ready')

  const win = new BrowserWindow({
    width: 420,
    height: 340,
    show: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  let captured = false
  win.webContents.on('console-message', async (_e, _level, message) => {
    wlog('[page] ' + message)
    if (message.includes('CAPTURE_NOW') && !captured) {
      captured = true
      try {
        // 等一帧合成完成
        await new Promise((r) => setTimeout(r, 300))
        const img = await win.webContents.capturePage()
        const size = img.getSize()
        const bmp = img.getBitmap() // BGRA
        let nonBlack = 0
        let samples = 0
        for (let i = 0; i + 3 < bmp.length; i += 40) {
          samples++
          if (bmp[i] !== 0 || bmp[i + 1] !== 0 || bmp[i + 2] !== 0) nonBlack++
        }
        wlog(`[capture] size=${size.width}x${size.height} 采样=${samples} 非黑=${nonBlack}` +
          (nonBlack === 0 ? '  ← 透明窗口合成结果全黑/全透明！WebGL 内容没上屏' : '（透明窗口下 WebGL 合成正常）'))
        fs.writeFileSync(join(__dirname, 'capture.png'), img.toPNG())
        wlog('[capture] 已保存 capture.png')
      } catch (err) {
        wlog('[capture] 失败: ' + err.message)
      }
      setTimeout(() => app.quit(), 500)
    }
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

  win.loadFile(join(__dirname, 'test3.html'), {
    query: { video: process.env.E2E_VIDEO || 'C:\\Users\\yn\\Videos\\小乖解压.mp4' }
  }).catch((err) => {
    wlog('[main] loadFile 失败: ' + err.message)
  })

  setTimeout(() => {
    wlog('[main] 30s 超时强制退出')
    app.quit()
  }, 30000)
})

process.on('uncaughtException', (err) => {
  wlog('[main] 未捕获异常: ' + (err && err.stack ? err.stack : String(err)))
  app.quit()
})
