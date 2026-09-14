/**
 * PlaybackEngine - mpv 播放引擎（从 index.ts 拆出）
 *
 * 与 HTML5 <video> 并存的第二条播放链路：主进程 spawn mpv.exe，
 * 通过命名管道 JSON IPC 控制；Windows 下用 koffi 创建子窗口（--wid）嵌入主窗口。
 * 渲染端传入的坐标均为 CSS 像素（视口左上角原点），主进程按显示器 DPI 换算物理像素。
 *
 * 引擎持有 MpvController 单例并注册全部 mpv:* IPC handler；
 * 对 index.ts 的依赖（主窗口、player 设置、路径授权、窗口全屏）通过 host 注入，
 * 使引擎可脱离 config / 窗口生命周期独立测试。
 */

import { ipcMain, dialog, nativeImage, type BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { MpvController } from './mpv-controller'
import { isLoopbackHttpUrl } from '../shared/playback-url'

/** 标准化 IPC 响应（与 index.ts 其他 handler 一致） */
export type ApiResult<T = unknown> = { success: true; data?: T } | { success: false; error?: string; filePath?: string }

/** 引擎对宿主（index.ts）的依赖注入点 */
export interface PlaybackEngineHost {
  /** 当前主窗口（可能未创建 / 已销毁） */
  getMainWindow(): BrowserWindow | null
  /** player 设置（configData['player']），引擎启动 mpv 时使用 */
  getPlayerSettings(): { hardwareDecode: boolean; hdrToneMapping: boolean; debugLog: boolean }
  /** PathAccessService 路径授权检查 */
  isPathAllowed(p: string): boolean
  /** 标准拒绝响应 */
  denyPath(): ApiResult<never>
  /** 切换主窗口窗口级全屏（打孔架构下 mpv 全屏统一走这里） */
  toggleWindowFullscreen(): boolean
}

/** 需要转发到渲染进程的 mpv 事件 */
const MPV_FORWARD_EVENTS = [
  'ready', 'quit', 'error',
  'time', 'duration', 'pause', 'volume', 'speed',
  'track-list', 'fullscreen',
  'file-loaded', 'start', 'stop', 'seek', 'idle'
]

export class PlaybackEngine {
  private controller: MpvController | null = null

  constructor(private readonly host: PlaybackEngineHost) {}

  /** 获取（惰性创建）mpv 控制器单例，并转发事件到渲染进程 */
  private getController(): MpvController {
    if (!this.controller) {
      const controller = new MpvController(this.host.getPlayerSettings())
      for (const ev of MPV_FORWARD_EVENTS) {
        controller.on(ev, (data: unknown) => {
          const win = this.host.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('mpv:event', { event: ev, data })
          }
        })
      }
      this.controller = controller
    }
    return this.controller
  }

  /** 统一执行 mpv 操作，未运行/异常时返回标准失败响应 */
  private async runMpv<T>(fn: (c: MpvController) => Promise<T> | T): Promise<ApiResult<T>> {
    try {
      if (!this.controller || !this.controller.isMpvRunning()) {
        return { success: false, error: 'mpv 未运行' }
      }
      const data = await fn(this.controller)
      return { success: true, data }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 注册全部 mpv:* IPC handler（模块加载期调用一次） */
  registerIpc(): void {
    // mpv 是否可用（二进制存在性检查）
    ipcMain.handle('mpv:is-available', async () => {
      try {
        return { success: true, data: this.getController().isAvailable() }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // 嵌入：创建 mpv 渲染窗口（主窗口身后打孔架构）并启动 mpv（--wid 只能在启动时传入）；
    // 已运行时仅更新渲染窗口位置。坐标为渲染端视口 DIP（主进程换算屏幕物理像素）
    ipcMain.handle('mpv:embed', async (_event, x: number, y: number, width: number, height: number) => {
      try {
        const win = this.host.getMainWindow()
        if (!win) return { success: false, error: '主窗口未创建' }
        const controller = this.getController()
        if (!controller.isAvailable()) return { success: false, error: '未找到 mpv 可执行文件' }

        if (!controller.isMpvRunning()) {
          // 复用已有渲染窗口：渲染端在挂载 effect 与起播流程会各调用一次 embed，
          // 若第二次重建窗口，mpv --wid 仍指向已销毁的旧句柄 → 音频正常但画面黑屏
          if (!controller.hasChildWindow()) {
            const ok = controller.createChildWindow(win, x, y, width, height)
            if (!ok) return { success: false, error: '创建 mpv 嵌入窗口失败' }
          } else {
            controller.updateChildWindowPosition(x, y, width, height)
          }
          await controller.start()
        } else {
          controller.updateChildWindowPosition(x, y, width, height)
        }
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // 更新嵌入窗口位置/大小（窗口缩放、全屏、布局变化；DIP 视口坐标）
    ipcMain.handle('mpv:update-embed', async (_event, x: number, y: number, width: number, height: number) => {
      if (this.controller && this.controller.isMpvRunning()) {
        this.controller.updateChildWindowPosition(x, y, width, height)
      }
      return { success: true }
    })

    // 加载并播放（URL 或本地路径；未嵌入时以独立窗口模式启动）
    ipcMain.handle('mpv:play', async (_event, url: string) => {
      try {
        // L1: scheme 白名单 —— 防止渲染端被控时借 mpv 进程访问任意协议/内网
        const s = String(url)
        const lower = s.toLowerCase()
        const isHttp = lower.startsWith('http://') || lower.startsWith('https://')
        const isFileUrl = lower.startsWith('file://')
        const isLocalPath = /^[a-z]:[\\/]/.test(lower) || lower.startsWith('\\\\')
        if (!isHttp && !isFileUrl && !isLocalPath) {
          return { success: false, error: 'mpv:play 仅支持 http/https/file 或本地磁盘路径' }
        }
        // L1.5: http(s) 仅允许回环 StreamProxy 地址 —— 渲染端合法拿到的 http 播放 URL
        // 只有回环代理签发的 session URL（见 jellyfin:get-playback-url），
        // 其余一律拒绝，防借 mpv 进程探测内网 / 访问任意站点
        if (isHttp && !isLoopbackHttpUrl(s)) {
          console.warn('[mpv:play] rejected non-loopback http url:', s)
          return { success: false, error: 'mpv:play http 地址仅允许回环代理（StreamProxy）' }
        }
        // L2: 本地文件必须经过 PathAccessService（realpath 后前缀校验），
        // 否则渲染端被控时可借 mpv 进程读取任意文件
        if (isFileUrl) {
          try {
            if (!this.host.isPathAllowed(fileURLToPath(s))) {
              console.warn('[mpv:play] rejected file url:', s)
              return this.host.denyPath()
            }
          } catch {
            return { success: false, error: 'file:// URL 无法解析为本地路径' }
          }
        } else if (isLocalPath && !this.host.isPathAllowed(s)) {
          console.warn('[mpv:play] rejected local path:', s)
          return this.host.denyPath()
        }
        const controller = this.getController()
        if (!controller.isAvailable()) return { success: false, error: '未找到 mpv 可执行文件' }
        if (!controller.isMpvRunning()) {
          await controller.start()
        }
        await controller.loadFile(url)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // 离开播放页：销毁子窗口与 mpv 进程（原生子窗口会覆盖其他页面，必须回收）
    ipcMain.handle('mpv:hide', async () => {
      if (this.controller) {
        const controller = this.controller
        this.controller = null
        try { await controller.destroy() } catch { /* ignore */ }
      }
      return { success: true }
    })

    ipcMain.handle('mpv:stop', () => this.runMpv((c) => c.stop()))
    ipcMain.handle('mpv:pause', () => this.runMpv((c) => c.pause_()))
    ipcMain.handle('mpv:resume', () => this.runMpv((c) => c.play()))
    ipcMain.handle('mpv:seek', (_event, position: number) => this.runMpv((c) => c.seek(position)))
    ipcMain.handle('mpv:set-volume', (_event, volume: number) => this.runMpv((c) => c.setVolume(volume)))
    ipcMain.handle('mpv:set-speed', (_event, speed: number) => this.runMpv((c) => c.setSpeed(speed)))

    // 嵌入模式下全屏由 Electron 页面控制（子窗口跟随几何更新）；
    // 独立窗口模式才切换 mpv 自身全屏
    ipcMain.handle('mpv:toggle-fullscreen', () => {
      // 打孔架构下不能 cycle mpv 自身 fullscreen（--wid 下 mpv 会调整渲染窗口尺寸导致错位），
      // 嵌入与否都统一切换 Electron 主窗口的窗口级全屏
      return { success: true, data: this.host.toggleWindowFullscreen() }
    })

    ipcMain.handle('mpv:get-state', () => this.runMpv((c) => c.getState()))
    ipcMain.handle('mpv:get-tracks', () => this.runMpv((c) => c.getTrackList()))
    ipcMain.handle('mpv:select-track', (_event, trackId: number) => this.runMpv((c) => c.selectTrack(trackId)))
    ipcMain.handle('mpv:select-subtitle', (_event, trackId: number) => this.runMpv((c) => c.selectSubtitle(trackId)))
    ipcMain.handle('mpv:disable-subtitle', () => this.runMpv((c) => c.disableSubtitle()))
    ipcMain.handle('mpv:load-subtitle', (_event, subtitlePath: string) => {
      // 字幕路径同样是文件读取原语，必须经 PathAccessService 校验
      if (!this.host.isPathAllowed(subtitlePath)) {
        console.warn('[mpv:load-subtitle] rejected path:', subtitlePath)
        return this.host.denyPath()
      }
      return this.runMpv((c) => c.loadExternalSubtitle(subtitlePath))
    })
    ipcMain.handle('mpv:get-property', (_event, name: string) => this.runMpv((c) => c.getProperty(name)))
    // mpv:set-property 白名单：仅允许设置「播放状态类」属性。
    // mpv 的 set_property 会把属性名当作命令参数执行，sub-file / audio-file /
    // external-file / script 等属性可被渲染端滥用为文件读取或脚本加载原语；
    // 因此显式只放行已知安全的播放控制属性，其余一律拒绝。
    const MPV_SET_PROPERTY_ALLOWLIST = new Set<string>([
      'pause', 'volume', 'speed', 'mute', 'fullscreen',
      'sid', 'aid', 'vid',
      'audio-delay', 'sub-delay', 'sub-visibility', 'sub-scale', 'sub-pos'
    ])
    ipcMain.handle('mpv:set-property', (_event, name: string, value: unknown) => {
      if (typeof name !== 'string' || !MPV_SET_PROPERTY_ALLOWLIST.has(name)) {
        console.warn('[mpv:set-property] rejected property:', name)
        return { success: false, error: '不允许设置该属性' }
      }
      return this.runMpv((c) => c.setProperty(name, value))
    })
    ipcMain.handle('mpv:screenshot', (_event, filePath: string) => {
      // 截图是任意路径写原语，只允许写入已授权目录 / userData
      if (!this.host.isPathAllowed(filePath)) {
        console.warn('[mpv:screenshot] rejected path:', filePath)
        return this.host.denyPath()
      }
      return this.runMpv((c) => c.screenshot(filePath))
    })

    // 截图保存 — 弹保存对话框；mpv 运行中由 mpv 原生截图，
    // 否则返回 use-canvas-fallback 让渲染端走 Canvas 截图
    ipcMain.handle('mpv:screenshot-save', async () => {
      const win = this.host.getMainWindow()
      if (!win) return { success: false, error: '主窗口未创建' }
      try {
        const result = await dialog.showSaveDialog(win, {
          title: '保存截图',
          defaultPath: `screenshot_${Date.now()}.png`,
          filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
        if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
        if (this.controller && this.controller.isMpvRunning()) {
          await this.controller.screenshot(result.filePath)
          return { success: true, data: result.filePath }
        }
        // mpv 未运行：渲染端用 Canvas 截图后写入该路径
        return { success: false, filePath: result.filePath, error: 'use-canvas-fallback' }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // 画布引擎（方案 C）截图保存：preload 取当前帧（已转 BGRA）→ nativeImage 存 PNG
    ipcMain.handle('mpv:save-frame-png', async (_event, payload: { width: number; height: number; pixels: Uint8Array }) => {
      const win = this.host.getMainWindow()
      if (!win) return { success: false, error: '主窗口未创建' }
      try {
        const { width, height, pixels } = payload
        if (!width || !height || !pixels || pixels.length < width * height * 4) {
          return { success: false, error: '帧数据无效' }
        }
        const result = await dialog.showSaveDialog(win, {
          title: '保存截图',
          defaultPath: `screenshot_${Date.now()}.png`,
          filters: [{ name: 'PNG 图片', extensions: ['png'] }]
        })
        if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
        const image = nativeImage.createFromBitmap(Buffer.from(pixels), { width, height })
        writeFileSync(result.filePath, image.toPNG())
        return { success: true, data: result.filePath }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  /**
   * 退出钩子用：同步强制结束 mpv 进程树（MpvController.destroy() 是异步的，
   * will-quit 不等异步）。引擎单例随 index.ts 存活，无需 dispose。
   */
  killSync(): void {
    try { this.controller?.killSync() } catch { /* ignore */ }
    this.controller = null
  }
}
