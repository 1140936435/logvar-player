import { dialog, type BrowserWindow } from 'electron'
import { writeFileSync, readFileSync } from 'fs'
import {
  ENCRYPTED_KEYS,
  CREDENTIAL_NAMESPACES,
  isCredentialKey,
  sanitizeEncryptedBlobs,
  stripSensitiveFields,
  deepMerge,
  isPlainObject
} from '../lib/security'
import { secureHandleRaw } from './secure-handle'
import { V } from './secure-schema'

export interface SettingsIpcHost {
  getMainWindow(): BrowserWindow | null
  getConfig(): Record<string, unknown>
  setConfigValue(key: string, value: unknown): void
  deleteConfigKey(key: string): void
  saveConfigFile(): void
  rebuildServerRuntime(): Promise<void>
}

/**
 * 服务器运行态配置键：只能经 server:* 专用 IPC 修改。
 * 通用 store / data:import 触碰这些键时，必须重建运行时连接（clearConnection + connectToServer），
 * 否则会出现 activeServerId 与 auth 脱节的带病状态。
 */
const SERVER_RUNTIME_KEYS = new Set(['jellyfin:servers', 'jellyfin:activeServerId'])

export function registerSettingsIpc(host: SettingsIpcHost): void {
  const cfg = (): Record<string, unknown> => host.getConfig()

// ==================== 凭据边界：敏感 key / 字段识别 ====================
// 原则：configData 内存中持有的是解密后的明文。任何离开主进程的路径
// （导出文件、store:get 返回给 Renderer）都必须经过这里的显式过滤，
// 不能依赖"值看起来还是密文"这种隐式假设。

/** 整体视为凭据的配置命名空间：默认禁止导出，Renderer 读取时剥离敏感字段 */
// 凭据边界（isCredentialKey / stripSensitiveFields / CREDENTIAL_NAMESPACES）实现见 ./lib/security.ts

secureHandleRaw('store:get', [V.string()], async (_event, key: string) => {
  const raw = cfg()[key] ?? null
  // 安全边界：Renderer 不持有凭据。先清理解密失败的 enc: 密文，
  // 再递归抹除 token/password/appSecret/apiKey 等字段（url/username 等非敏感字段保留）
  return stripSensitiveFields(sanitizeEncryptedBlobs(raw))
})

secureHandleRaw('store:set', [V.string(), V.unknown()], async (_event, key: string, value: unknown) => {
  // 防止原型污染与非法键写入（__proto__/constructor/prototype）
  if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
    console.warn('[store:set] rejected invalid key:', key)
    return false
  }
  // M2: 敏感键（jellyfin.token/url 等）由专用登录 handler 管理，拒绝渲染端直接
  // 覆写 —— 对象/嵌套值可绕过 encryptConfig 的字符串加密路径落盘明文
  if (ENCRYPTED_KEYS.has(key)) {
    console.warn('[store:set] rejected sensitive key:', key)
    return false
  }
  // 凭据命名空间整体走 server:* / emby:* 专用 IPC，拒绝通用 store 通道写入
  if (CREDENTIAL_NAMESPACES.has(key)) {
    console.warn('[store:set] rejected credential namespace key:', key)
    return false
  }
  // 服务器运行态键（servers / activeServerId）只能经 server:* 专用 IPC 修改，
  // 禁止通用 store 直接写入造成 activeServerId 与 auth 脱节（无重建修改）
  if (SERVER_RUNTIME_KEYS.has(key)) {
    console.warn('[store:set] rejected server runtime key:', key)
    return false
  }
  host.setConfigValue(key, value)
  host.saveConfigFile()
  return true
})

secureHandleRaw('store:delete', [V.string()], async (_event, key: string) => {
  // 与 store:set 同理，敏感键的清除也走专用 handler（登出流程）
  if (typeof key === 'string' && (ENCRYPTED_KEYS.has(key) || CREDENTIAL_NAMESPACES.has(key) || SERVER_RUNTIME_KEYS.has(key))) {
    console.warn('[store:delete] rejected sensitive key:', key)
    return false
  }
  host.deleteConfigKey(key)
  host.saveConfigFile()
  return true
})

// ==================== 数据导入导出 ====================

// 导出配置数据
secureHandleRaw('data:export', [V.optional(V.shape({ format: V.optional(V.enum(['json', 'csv'])), includeKeys: V.optional(V.array(V.string())) }))], async (_event, options?: { format?: 'json' | 'csv'; includeKeys?: string[] }) => {
  const win = host.getMainWindow()
  if (!win) return { success: false, error: '主窗口未创建' }
  
  try {
    const result = await dialog.showSaveDialog(win, {
      title: '导出数据',
      defaultPath: `huanying_config_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    
    if (result.canceled || !result.filePath) {
      return { success: false, error: '用户取消导出' }
    }
    
    const exportData: { version: string; exportedAt: string; data: Record<string, unknown> } = {
      version: '13.0.0',
      exportedAt: new Date().toISOString(),
      data: {}
    }
    
    const keysToExport = options?.includeKeys || Object.keys(cfg())
    const excludedSensitive: string[] = []

    for (const key of keysToExport) {
      if (cfg()[key] === undefined) continue
      // 凭据边界：导出文件永不含凭据命名空间（服务器 token/密码、弹幕 AppSecret 等），
      // 不接受 includeSensitive 之类旁路开关，杜绝凭据以明文落到导出文件
      if (isCredentialKey(key)) {
        excludedSensitive.push(key)
        continue
      }
      // 非凭据 key 也可能嵌套敏感字段（如对象里的 token 字段），递归抹除兜底
      exportData.data[key] = stripSensitiveFields(sanitizeEncryptedBlobs(cfg()[key]))
    }
    
    let content: string
    const ext = result.filePath.split('.').pop()?.toLowerCase()
    
    if (ext === 'csv' && options?.format === 'csv') {
      const rows: string[][] = [['Key', 'Value']]
      for (const [key, value] of Object.entries(exportData.data)) {
        const valueStr = typeof value === 'object' ? JSON.stringify(value).replace(/"/g, '""') : String(value ?? '')
        rows.push([key, valueStr])
      }
      content = rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
    } else {
      content = JSON.stringify(exportData, null, 2)
    }
    
    writeFileSync(result.filePath, content, 'utf-8')
    
    return {
      success: true,
      data: {
        filePath: result.filePath,
        keyCount: Object.keys(exportData.data).length,
        size: Buffer.byteLength(content, 'utf-8'),
        excludedSensitive
      }
    }
  } catch (err) {
    return { success: false, error: `导出失败: ${String(err)}` }
  }
})

// 导入配置数据
secureHandleRaw('data:import', [V.optional(V.shape({ merge: V.optional(V.boolean()), selectedKeys: V.optional(V.array(V.string())) }))], async (_event, options?: { merge?: boolean; selectedKeys?: string[] }) => {
  const win = host.getMainWindow()
  if (!win) return { success: false, error: '主窗口未创建' }
  
  try {
    const result = await dialog.showOpenDialog(win, {
      title: '导入数据',
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: '用户取消导入' }
    }
    
    const filePath = result.filePaths[0]
    const content = readFileSync(filePath, 'utf-8')
    
    let importedData: Record<string, unknown>
    let warnings: string[] = []
    
    const ext = filePath.split('.').pop()?.toLowerCase()
    
    if (ext === 'csv') {
      const rows = content.split('\n').filter(row => row.trim())
      const headers = rows[0].split(',').map(h => h.replace(/^"|"$/g, ''))
      if (headers.length < 2 || headers[0] !== 'Key' || headers[1] !== 'Value') {
        return { success: false, error: 'CSV 格式错误：需要 "Key,Value" 表头' }
      }
      importedData = {}
      for (let i = 1; i < rows.length; i++) {
        const match = rows[i].match(/^"([^"]*)",(.*)$/)
        if (match) {
          const key = match[1]
          let value: unknown = match[2].replace(/^"|"$/g, '').replace(/""/g, '"')
          try {
            value = JSON.parse(value as string)
          } catch {
            // 保持为字符串
          }
          importedData[key] = value
        }
      }
    } else {
      try {
        const parsed = JSON.parse(content)
        if (parsed.version && parsed.data) {
          importedData = parsed.data
        } else {
          importedData = parsed
        }
      } catch {
        return { success: false, error: 'JSON 格式错误' }
      }
    }
    
    const selectedKeys = options?.selectedKeys || Object.keys(importedData)
    const merge = options?.merge ?? true
    const skippedKeys: string[] = []
    const importedKeys: string[] = []
    // 记录本次导入是否触碰服务器运行态键：命中则导入后必须重建运行时（不允许无重建修改）
    let touchedServerRuntime = false
    
    for (const key of selectedKeys) {
      if (importedData[key] === undefined) {
        skippedKeys.push(key)
        continue
      }
      
      // 安全检查：防止注入危险的配置
      if (key.startsWith('__') || key.startsWith('system:')) {
        warnings.push(`跳过系统保护的键: ${key}`)
        skippedKeys.push(key)
        continue
      }
      
      if (merge && isPlainObject(cfg()[key]) && isPlainObject(importedData[key])) {
        // 深合并：保留现有配置中导入文件未覆盖的字段（嵌套对象递归合并）
        host.setConfigValue(key, deepMerge(
          cfg()[key] as Record<string, unknown>,
          importedData[key] as Record<string, unknown>
        ))
      } else {
        host.setConfigValue(key, importedData[key])
      }
      importedKeys.push(key)
      if (SERVER_RUNTIME_KEYS.has(key)) touchedServerRuntime = true
    }

    // 服务器运行态键被导入：强制按新持久化配置重建运行时连接，杜绝 auth/activeServerId 脱节
    if (touchedServerRuntime) {
      await host.rebuildServerRuntime()
    }
    
    host.saveConfigFile()
    
    return { 
      success: true, 
      data: { 
        importedCount: importedKeys.length,
        skippedCount: skippedKeys.length,
        warnings,
        importedKeys,
        skippedKeys
      }
    }
  } catch (err) {
    return { success: false, error: `导入失败: ${String(err)}` }
  }
})

// 获取可导出的配置键列表
secureHandleRaw('data:list-keys', [], async () => {
  const keys = Object.keys(cfg()).filter(k => !k.startsWith('__') && !k.startsWith('system:'))
  const keyInfo = keys.map(k => ({
    key: k,
    // 精确匹配凭据命名空间，避免误伤 'jellyfin:activeServerId' 这类普通配置项
    hasSensitive: isCredentialKey(k)
  }))
  return { success: true, data: keyInfo }
})
}
