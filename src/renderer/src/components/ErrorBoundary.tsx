import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** 自定义回退 UI，不传则使用默认样式 */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * React Error Boundary — 捕获渲染树中的未处理异常，
 * 防止整个应用白屏，提供友好的错误展示和重试入口。
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack)
    // 修复点 1.9: 调用实际存在的 log.send(level, source, ...args) 接口
    try {
      void window.api?.log?.send?.('error', 'renderer', `ErrorBoundary: ${error.message}\n${info.componentStack ?? ''}`)
    } catch { /* 日志不可用时静默 */ }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex flex-col items-center gap-4 max-w-md text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
              <AlertTriangle size={28} className="text-red-400" strokeWidth={1.5} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-1">
                页面出错了
              </h2>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                {this.state.error?.message || '发生了未知错误'}
              </p>
            </div>
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-medium
                         hover:brightness-110 active:scale-95 transition-all"
            >
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
