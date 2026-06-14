import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// ==================== 日志转发到主进程 ====================
// 只在生产模式下启用，开发模式使用原始 console 便于调试

const isProd = import.meta.env.PROD

if (isProd) {
  // 保存原始 console 方法
  const _origLog = console.log
  const _origWarn = console.warn
  const _origError = console.error
  const _origDebug = console.debug

  function forwardLog(
    level: 'info' | 'warn' | 'error' | 'debug',
    args: unknown[]
  ): void {
    // 使用原始函数
    const orig = level === 'debug' ? _origLog : level === 'error' ? _origError : level === 'warn' ? _origWarn : _origLog
    orig.apply(console, args)

    // 异步发送到主进程日志窗口
    const message = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        }
        return String(a)
      })
      .join(' ')

    if (window.api?.log?.send) {
      window.api.log.send(level, 'renderer', message).catch(() => {})
    }
  }

  console.log = (...args: unknown[]) => forwardLog('info', args)
  console.warn = (...args: unknown[]) => forwardLog('warn', args)
  console.error = (...args: unknown[]) => forwardLog('error', args)
  console.debug = (...args: unknown[]) => forwardLog('debug', args)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
