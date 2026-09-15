import { dialog, type BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { readdir as fsReaddir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { PathAccessService } from '../services/path-access-service'
import { secureHandleRaw } from './secure-handle'
import { V } from './secure-schema'

export interface FileIpcHost {
  getMainWindow(): BrowserWindow | null
  userDataPath(): string
  getConfig(): Record<string, unknown>
  setConfigValue(key: string, value: unknown): void
  saveConfigFile(): void
}

// ==================== IPC: 文件 ====================
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.rmvb'
])

async function scanVideoFolder(folderPath: string): Promise<{ success: boolean; data?: { files: string[]; folderPath: string }; error?: string }> {
  try {
    const files: string[] = []
    // fs.promises.readdir：NAS / UNC / 慢盘上同步 readdir 会卡住主进程事件循环
    const entries = await fsReaddir(folderPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (VIDEO_EXTENSIONS.has(ext)) {
          files.push(join(folderPath, entry.name))
        }
      }
    }
    console.log(`file:scan-folder found ${files.length} video files in ${folderPath}`)
    return { success: true, data: { files, folderPath } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`file:scan-folder error:`, msg)
    return { success: false, error: msg }
  }
}

// ==================== 本地视频文件信息（ffprobe） ====================

const execFileAsync = promisify(execFile)

/** 获取本地视频文件的技术参数 */
async function getLocalVideoInfo(filePath: string): Promise<{
  success: boolean
  data?: {
    format: string
    duration: number
    size: number
    bitRate: number
    video: {
      codec: string
      width: number
      height: number
      frameRate: string
      bitRate: number
      profile: string
      level: string
    }
    audio: {
      codec: string
      sampleRate: number
      channels: number
      channelLayout: string
      bitRate: number
    }
  }
  error?: string
}> {
  try {
    // 尝试使用 ffprobe
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { timeout: 10000 })

    const probe = JSON.parse(stdout)
    const format = probe.format || {}
    const videoStream = (probe.streams || []).find((s: any) => s.codec_type === 'video')
    const audioStream = (probe.streams || []).find((s: any) => s.codec_type === 'audio')

    return {
      success: true,
      data: {
        format: format.format_name || 'unknown',
        duration: parseFloat(format.duration) || 0,
        size: parseInt(format.size) || 0,
        bitRate: parseInt(format.bit_rate) || 0,
        video: videoStream ? {
          codec: videoStream.codec_name || 'unknown',
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          frameRate: videoStream.r_frame_rate || '0/1',
          bitRate: parseInt(videoStream.bit_rate) || 0,
          profile: videoStream.profile || '',
          level: videoStream.level ? String(videoStream.level) : ''
        } : {
          codec: 'unknown', width: 0, height: 0, frameRate: '0/1', bitRate: 0, profile: '', level: ''
        },
        audio: audioStream ? {
          codec: audioStream.codec_name || 'unknown',
          sampleRate: parseInt(audioStream.sample_rate) || 0,
          channels: audioStream.channels || 0,
          channelLayout: audioStream.channel_layout || '',
          bitRate: parseInt(audioStream.bit_rate) || 0
        } : {
          codec: 'unknown', sampleRate: 0, channels: 0, channelLayout: '', bitRate: 0
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('ffprobe error:', msg)
    return { success: false, error: `ffprobe 不可用: ${msg}` }
  }
}

// ==================== 本地路径访问控制（M1 纵深防御） ====================
// 渲染进程若被 XSS 攻陷，路径类 IPC（file:get-url / video:get-info /
// danmaku:parse-local-xml 等）可被当作任意文件读取原语。这里维护一个持久化的
// "允许目录根"清单：仅用户通过系统对话框明确打开过的目录（及 userData）
// 放行，路径类 IPC 一律校验归属前缀。
// 实现抽取在 ./services/path-access-service.ts（含 realpath canonicalize，

const LOCAL_ALLOWED_ROOTS_KEY = 'local:allowed-roots'

let _pathAccess: PathAccessService | null = null

/** 路径访问统一入口（M1 纵深防御）。
 * 委托 PathAccessService：该服务对「目标路径」与「授权根目录」都先做
 * realpath canonicalize，再比较前缀，因此 symlink / Windows junction 无法把
 * 校验结果跳到授权范围之外。所有路径类 IPC 必须经此函数放行。
 */
export function isPathAllowed(p: string): boolean {
  return _pathAccess ? _pathAccess.isPathAllowed(p) : false
}

export function denyPath(reason = '路径不在允许目录内（请通过"打开文件/文件夹"重新授权访问）'): { success: false; error: string } {
  return { success: false, error: reason }
}

/** app ready 后由 initConfig 调用：从持久化配置恢复允许目录根清单 */
export function restorePathAccess(): void {
  if (_pathAccess) _pathAccess.restore()
}

/** 注册 file:* / video:get-info 本地文件/目录 IPC 通道（含路径访问控制服务初始化） */
export function registerFileIpc(host: FileIpcHost): void {
  // 模块加载时 configData 尚未从磁盘读取，根清单先置空；
  // app ready 后 initConfig() → restorePathAccess() 再从持久化配置恢复
  _pathAccess = new PathAccessService({
    store: {
      get: (key) => host.getConfig()[key],
      set: (key, value) => { host.setConfigValue(key, value) }
    },
    storageKey: LOCAL_ALLOWED_ROOTS_KEY,
    persist: () => host.saveConfigFile(),
    implicitRoots: () => [host.userDataPath()]
  })

secureHandleRaw('video:get-info', [V.string()], async (_event, filePath: string) => {
  if (!isPathAllowed(filePath)) {
    console.warn('[video:get-info] rejected path:', filePath)
    return denyPath()
  }
  return await getLocalVideoInfo(filePath)
})

secureHandleRaw('file:open-file', [], async () => {
  const win = host.getMainWindow()
  if (!win) return { success: false, error: '主窗口未创建' }
  const result = await dialog.showOpenDialog(win, {
    title: '打开视频文件',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '未选择文件' }
  }
  const filePath = result.filePaths[0]
  console.log('file:open-file selected:', filePath)
  _pathAccess?.authorizeRoot(dirname(filePath))
  return { success: true, data: { filePath } }
})

secureHandleRaw('file:open-folder', [], async () => {
  const win = host.getMainWindow()
  if (!win) return { success: false, error: '主窗口未创建' }
  const result = await dialog.showOpenDialog(win, {
    title: '打开文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '未选择文件夹' }
  }
  const folderPath = result.filePaths[0]
  console.log('file:open-folder selected:', folderPath)
  _pathAccess?.authorizeRoot(folderPath)
  const scanResult = await scanVideoFolder(folderPath)
  return scanResult
})

secureHandleRaw('file:scan-folder', [V.string()], async (_event, folderPath: string) => {
  console.log('file:scan-folder', folderPath)
  if (!isPathAllowed(folderPath)) {
    console.warn('[file:scan-folder] rejected path:', folderPath)
    return denyPath()
  }
  return await scanVideoFolder(folderPath)
})

secureHandleRaw('file:get-url', [V.string()], async (_event, filePath: string) => {
  try {
    if (!isPathAllowed(filePath)) {
      console.warn('[file:get-url] rejected path:', filePath)
      return denyPath()
    }
    const url = pathToFileURL(filePath).toString()
    return { success: true, data: { url } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})
}
