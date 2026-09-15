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

import { dialog, nativeImage, type BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { MpvController } from './mpv-controller'
import { checkPlaybackSource } from './lib/playback-source-guard'
import { registerIpc } from './ipc/secure-handle'

/** 标准化 IPC 响应（与 index.ts 其他 handler 一致） */
export type ApiResult<T = unknown> = { success: true; data?: T } | { success: false; error?: string; filePath?: string }

/** 引擎对宿主（index.ts）的依赖注入点 */
export interface PlaybackEngineHost {
  /** 获取主窗口 */
  getMainWindow(): BrowserWindow | null
  /** 获取播放配置（硬件解码、HDR、调试日志） */
  getPlayerSettings(): { hardwareDecode: boolean; hdrToneMapping: boolean; debugLog: boolean }
  /** 检查路径是否允许播放（L2 本地文件授权） */
  isPathAllowed(p: string): boolean
  /** 标准拒绝响应 */
  denyPath(): ApiResult<never>
  /** URL 是否为当前 StreamProxy 签发且未过期的有效 session URL */
  isValidStreamSessionUrl(url: string): boolean
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

  /** 统一播放源守卫：两条 mpv 链路（打孔 mpv:play / 画布 mpvRender.play）共用 */
  private validatePlaybackSource(url: string): { ok: true } | { ok: false; response: ApiResult<never> } {
    const verdict = checkPlaybackSource(url, {
      isPathAllowed: (p) => this.host.isPathAllowed(p),
      isValidStreamSessionUrl: (u) => this.host.isValidStreamSessionUrl(u)
    })
    if (verdict.ok) return { ok: true }
    console.warn('[mpv:play] rejected playback source:', verdict.kind, url)
    return {
      ok: false,
      response: verdict.kind === 'path-denied' ? this.host.denyPath() : { success: false, error: verdict.error }
    }
  }

  /** 注册全部 mpv:* IPC handler（模块加载期调用一次） */
  registerIpc(): void {
    // mpv 是否可用（二进制存在性检查）
    registerIpc('mpv:is-available', async () => {
      try {
        return { success: true, data: this.getController().isAvailable() }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // 嵌入：创建 mpv 渲染窗口（主窗口身后打孔架构）并启动 mpv（--wid 只能在启动时传入）；
    // 已运行时仅更新渲染窗口位置。坐标为渲染端视口 DIP（主进程换算屏幕物理像素）
    registerIpc('mpv:embed', async (_event, x: number, y: number, width: number, height: number) => {
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
    registerIpc('mpv:update-embed', async (_event, x: number, y: number, width: number, height: number) => {
      if (this.controller && this.controller.isMpvRunning()) {
        this.controller.updateChildWindowPosition(x, y, width, height)
      }
      return { success: true }
    })

    // 加载并播放（URL 或本地路径；未嵌入时以独立窗口模式启动）
    registerIpc('mpv:play', async (_event, url: string) => {
      try {
        // L1 scheme 白名单 + L1.5 有效 StreamProxy session + L2 路径授权
        // 统一走 PlaybackSourceGuard（见 ./lib/playback-source-guard）
        const guard = this.validatePlaybackSource(url)
        if (!guard.ok) return guard.response
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
    registerIpc('mpv:hide', async () => {
      if (this.controller) {
        const controller = this.controller
        this.controller = null
        try { await controller.destroy() } catch { /* ignore */ }
      }
      return { success: true }
    })

    registerIpc('mpv:stop', () => this.runMpv((c) => c.stop()))
    registerIpc('mpv:pause', () => this.runMpv((c) => c.pause_()))
    registerIpc('mpv:resume', () => this.runMpv((c) => c.play()))
    registerIpc('mpv:seek', (_event, position: number) => this.runMpv((c) => c.seek(position)))
    registerIpc('mpv:set-volume', (_event, volume: number) => this.runMpv((c) => c.setVolume(volume)))
    registerIpc('mpv:set-speed', (_event, speed: number) => this.runMpv((c) => c.setSpeed(speed)))

    // 嵌入模式下全屏由 Electron 页面控制（子窗口跟随几何更新）；
    // 独立窗口模式才切换 mpv 自身全屏
    registerIpc('mpv:toggle-fullscreen', () => {
      // 打孔架构下不能 cycle mpv 自身 fullscreen（--wid 下 mpv 会调整渲染窗口尺寸导致错位），
      // 嵌入与否都统一切换 Electron 主窗口的窗口级全屏
      return { success: true, data: this.host.toggleWindowFullscreen() }
    })

    registerIpc('mpv:get-state', () => this.runMpv((c) => c.getState()))
    registerIpc('mpv:get-tracks', () => this.runMpv((c) => c.getTrackList()))
    registerIpc('mpv:select-track', (_event, trackId: number) => this.runMpv((c) => c.selectTrack(trackId)))
    registerIpc('mpv:select-subtitle', (_event, trackId: number) => this.runMpv((c) => c.selectSubtitle(trackId)))
    registerIpc('mpv:disable-subtitle', () => this.runMpv((c) => c.disableSubtitle()))
    registerIpc('mpv:load-subtitle', (_event, subtitlePath: string) => {
      // 字幕路径同样是文件读取原语，必须经 PathAccessService 校验
      if (!this.host.isPathAllowed(subtitlePath)) {
        console.warn('[mpv:load-subtitle] rejected path:', subtitlePath)
        return this.host.denyPath()
      }
      return this.runMpv((c) => c.loadExternalSubtitle(subtitlePath))
    })
    registerIpc('mpv:get-property', (_event, name: string) => this.runMpv((c) => c.getProperty(name)))
    // 画布引擎（preload mpvRender.play）的播放源预检：与 mpv:play 走同一条
    // PlaybackSourceGuard，校验通过后 preload 才会把源交给 libmpv 加载。
    // 这样画布链路同样被 L1.5（有效 session URL）与 L2（本地路径授权）覆盖
    registerIpc('mpv:validate-playback-source', (_event, url: string) => {
      const guard = this.validatePlaybackSource(url)
      if (guard.ok) return { success: true }
      return guard.response
    })

    // mpv:set-property 白名单：仅允许设置「播放状态类」属性并校验取值类型/范围。
    // mpv 的 set_property 会把属性名当作命令参数执行，sub-file / audio-file /
    // external-file / script 等属性可被渲染端滥用为文件读取或脚本加载原语；
    // 因此显式只放行已知安全的播放控制属性，其余一律拒绝。
    // fullscreen 不放行：打孔/画布架构下全屏统一由主窗口控制（mpv:toggle-fullscreen），
    // 渲染端直接改 mpv 的 fullscreen 属性会让嵌入窗口几何与页面错位。
    const numberInRange = (min: number, max: number) => (v: unknown): boolean =>
      typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
    const isTrackId = (v: unknown): boolean =>
      (typeof v === 'number' && Number.isInteger(v) && v >= 0) || v === 'no' || v === 'auto'
    const MPV_SET_PROPERTY_SCHEMA: Record<string, (value: unknown) => boolean> = {
      pause: (v) => typeof v === 'boolean',
      mute: (v) => typeof v === 'boolean',
      'sub-visibility': (v) => typeof v === 'boolean',
      volume: numberInRange(0, 150),
      speed: numberInRange(0.25, 16),
      'audio-delay': numberInRange(-60, 60),
      'sub-delay': numberInRange(-60, 60),
      'sub-scale': numberInRange(0.1, 10),
      'sub-pos': numberInRange(0, 100),
      sid: isTrackId,
      aid: isTrackId,
      vid: isTrackId
    }
    registerIpc('mpv:set-property', (_event, name: string, value: unknown) => {
      const validate = typeof name === 'string' ? MPV_SET_PROPERTY_SCHEMA[name] : undefined
      if (!validate || !validate(value)) {
        console.warn('[mpv:set-property] rejected property or value:', name, typeof value)
        return { success: false, error: '不允许设置该属性或取值非法' }
      }
      return this.runMpv((c) => c.setProperty(name, value))
    })
    registerIpc('mpv:screenshot', (_event, filePath: string) => {
      // 截图是任意路径写原语，只允许写入已授权目录 / userData
      if (!this.host.isPathAllowed(filePath)) {
        console.warn('[mpv:screenshot] rejected path:', filePath)
        return this.host.denyPath()
      }
      return this.runMpv((c) => c.screenshot(filePath))
    })

    // 截图保存 — 弹保存对话框；mpv 运行中由 mpv 原生截图，
    // 否则返回 use-canvas-fallback 让渲染端走 Canvas 截图
    registerIpc('mpv:screenshot-save', async () => {
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
    registerIpc('mpv:save-frame-png', async (_event, payload: { width: number; height: number; pixels: Uint8Array }) => {
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
