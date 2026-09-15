/**
 * secure-handle.ts — 统一 IPC 注册基建（P1）
 *
 * 替代 index.ts 中覆盖 ipcMain.handle 的 monkey-patch：
 * 所有 IPC 注册统一走 secureHandle / secureHandleRaw / registerIpc，
 * 由框架统一完成三层职责：
 *   1. sender 校验（仅开发环境放行；生产环境只接受本应用 file:// 页面）
 *   2. 参数运行时校验（可选 schema，见 ./secure-schema.ts）
 *   3. 异常捕获 + 统一返回 ApiResult<T>
 *
 * 兼容性说明：
 *   - secureHandle       默认 wrap=true：handler 返回值包装为 { success: true, data }
 *     （后台式通道，renderer 已按 ApiResult 消费）
 *   - secureHandleRaw    wrap=false：返回值原样透传，仅做 sender/参数校验与异常捕获，
 *     用于迁移后尚未切换 ApiResult 约定的存量通道（保持 renderer 行为逐字节不变）
 *   - registerIpc        无参数 schema、wrap=false 的最简通道（仅 sender 校验 + 异常捕获），
 *     供未完成参数校验设计的通道过渡使用
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { validateArguments, type Validator } from './secure-schema'

/** 主进程向 renderer 返回的统一响应格式 */
export type ApiResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string }

/** IPC handler 签名：与 ipcMain.handle 一致（event + 位置参数，参数类型保持宽松以兼容任意具体签名） */
export type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

/**
 * 校验 invoke 来源是否为可信 renderer。
 * 生产环境只接受本应用 file:// 页面；开发环境放行（vite dev server / HMR 来源 URL 不固定）。
 * （原 index.ts isTrustedIpcSender，下沉至此统一应用）
 */
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  try {
    if (is.dev) return true
    const frame = event.senderFrame
    return !!frame && typeof frame.url === 'string' && frame.url.startsWith('file://')
  } catch {
    return false
  }
}

interface SecureHandleOptions {
  /** true：handler 返回值包装为 ApiResult；false：原样透传（兼容模式） */
  wrap?: boolean
}

/** 统一注册入口（完整能力） */
export function secureHandle(
  channel: string,
  schema: readonly Validator[],
  handler: IpcHandler,
  options: SecureHandleOptions = {}
): void {
  const { wrap = true } = options

  ipcMain.handle(channel, async (event, ...args) => {
    // 1) sender 校验：非法来源直接抛错（安全事件，不当作业务失败吞掉）
    if (!isTrustedIpcSender(event)) {
      throw new Error(`[security] untrusted IPC sender rejected on channel: ${channel}`)
    }

    // 2) 参数运行时校验
    const validationError = validateArguments(schema, args)
    if (validationError) {
      const message = `[ipc:${channel}] 参数校验失败: ${validationError}`
      console.warn(message)
      // raw 透传模式保持与旧 monkey-patch 一致的抛错语义（renderer 收到 rejection）；
      // 包装模式则统一以 { success: false, error } 返回
      if (!wrap) throw new Error(message)
      return { success: false, error: message }
    }

    // 3) 执行 handler 并统一捕获异常
    try {
      const data = await handler(event, ...args)
      return wrap ? { success: true, data } : data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc:${channel}] handler 异常:`, err)
      // raw 透传模式：原样抛给 renderer（保持既有 reject 语义，不吞异常）；
      // 包装模式：统一转换为 { success: false, error }
      if (!wrap) throw err
      return { success: false, error: `[ipc:${channel}] ${message}` }
    }
  })
}

/** 兼容模式：返回值原样透传，仅做 sender 校验 + 参数校验 + 异常捕获 */
export function secureHandleRaw(
  channel: string,
  schema: readonly Validator[],
  handler: IpcHandler
): void {
  secureHandle(channel, schema, handler, { wrap: false })
}

/** 无参数 schema 的最简通道注册（保留 sender 校验与异常捕获） */
export function registerIpc(channel: string, handler: IpcHandler): void {
  secureHandleRaw(channel, [], handler)
}
