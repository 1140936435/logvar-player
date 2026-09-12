import { useRef, useState, useEffect, useCallback, memo, type ReactElement, type CSSProperties } from 'react'

let observerInstance: IntersectionObserver | null = null
const observerCallbacks = new Map<Element, (visible: boolean) => void>()

function getSharedObserver(): IntersectionObserver {
  if (observerInstance) return observerInstance

  observerInstance = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cb = observerCallbacks.get(entry.target)
        if (cb) cb(entry.isIntersecting)
      }
    },
    { rootMargin: '200px', threshold: 0.01 }
  )

  return observerInstance
}

function observeElement(el: Element, onVisible: (visible: boolean) => void): () => void {
  const observer = getSharedObserver()
  observerCallbacks.set(el, onVisible)
  observer.observe(el)
  return () => {
    observer.unobserve(el)
    observerCallbacks.delete(el)
  }
}

interface LazyImageProps {
  src: string | null
  alt: string
  className?: string
  imgClassName?: string
  fallback?: ReactElement
  placeholder?: ReactElement
  onLoad?: () => void
  onError?: () => void
  style?: CSSProperties
}

const DEFAULT_PLACEHOLDER = (
  <div className="w-full h-full bg-[var(--bg-elevated)] animate-pulse" />
)

/**
 * 懒加载图片：共享 IntersectionObserver 控制挂载时机 + 原生 loading="lazy" 控制下载。
 * 注意：不要试图用 AbortController 取消 <img> 的下载 —— img 请求不走 fetch、
 * 无法被 signal 取消，那套 semaphore + abort 是伪取消（下载照常进行，白增复杂度）。
 * 可见性门控 + 原生懒加载已足够限制滚动时的无效请求/解码。
 */
export const LazyImage = memo(function LazyImage({
  src,
  alt,
  className,
  imgClassName = 'w-full h-full object-cover',
  fallback,
  placeholder = DEFAULT_PLACEHOLDER,
  onLoad,
  onError,
  style,
}: LazyImageProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    return observeElement(el, (visible) => setIsVisible(visible))
  }, [])

  // src 变化时重置加载状态（避免上一个 src 的 loaded 状态盖住新图的加载过程）
  useEffect(() => {
    setLoadState('loading')
  }, [src])

  const handleLoad = useCallback(() => {
    setLoadState('loaded')
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    setLoadState('error')
    onError?.()
  }, [onError])

  if (!src) {
    return (
      <div ref={containerRef} className={className} style={style}>
        {fallback || placeholder}
      </div>
    )
  }

  return (
    <div ref={containerRef} className={className} style={style}>
      {isVisible && (
        <img
          src={src}
          alt={alt}
          decoding="async"
          loading="lazy"
          className={`${imgClassName} transition-opacity duration-300 ${loadState === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
      {loadState === 'error' && (
        <div className="absolute inset-0">{fallback || placeholder}</div>
      )}
      {loadState !== 'error' && (!isVisible || loadState === 'loading') && (
        <div className="absolute inset-0">{placeholder}</div>
      )}
    </div>
  )
})
