import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// ==================== 日志转发到主进程 ====================

// 保存原始 console 方法，确保不丢失终端输出
const _origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

function forwardLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  args: unknown[]
): void {
  // 保留原始输出
  const orig = _origConsole[level === 'debug' ? 'log' : level]
  orig(...args)

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

// 全局未捕获错误
window.addEventListener('error', (event) => {
  _origConsole.error('Global error:', event.error || event.message)
  if (window.api?.log?.send) {
    window.api.log
      .send('error', 'renderer', `Global error: ${event.error?.stack || event.message}`)
      .catch(() => {})
  }
})

window.addEventListener('unhandledrejection', (event) => {
  _origConsole.error('Unhandled rejection:', event.reason)
  if (window.api?.log?.send) {
    window.api.log
      .send(
        'error',
        'renderer',
        `Unhandled rejection: ${event.reason?.stack || event.reason}`
      )
      .catch(() => {})
  }
})

// ==================== React 渲染 ====================

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
