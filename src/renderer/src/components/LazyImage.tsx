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

const MAX_CONCURRENT = 6
let activeLoads = 0
const pendingQueue: Array<() => void> = []

function acquireLoadSlot(): Promise<void> {
  if (activeLoads < MAX_CONCURRENT) {
    activeLoads++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    pendingQueue.push(() => {
      activeLoads++
      resolve()
    })
  })
}

function releaseLoadSlot(): void {
  activeLoads--
  if (activeLoads < 0) activeLoads = 0
  if (pendingQueue.length > 0 && activeLoads < MAX_CONCURRENT) {
    const next = pendingQueue.shift()
    if (next) next()
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
  const imgRef = useRef<HTMLImageElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const slotAcquiredRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const unobserve = observeElement(el, (visible) => {
      if (visible) {
        setIsVisible(true)
      } else {
        setIsVisible(false)
        if (loadState === 'loading') {
          abortControllerRef.current?.abort()
          if (slotAcquiredRef.current) {
            releaseLoadSlot()
            slotAcquiredRef.current = false
          }
          setLoadState('idle')
        }
      }
    })

    return unobserve
  }, [])

  useEffect(() => {
    if (!isVisible || !src) return

    let cancelled = false
    slotAcquiredRef.current = false
    abortControllerRef.current = new AbortController()

    acquireLoadSlot().then(() => {
      if (cancelled) {
        releaseLoadSlot()
        return
      }
      slotAcquiredRef.current = true
      setLoadState('loading')
    })

    return () => {
      cancelled = true
      abortControllerRef.current?.abort()
      if (slotAcquiredRef.current && loadState !== 'loaded' && loadState !== 'error') {
        releaseLoadSlot()
        slotAcquiredRef.current = false
      }
    }
  }, [isVisible, src])

  const handleLoad = useCallback(() => {
    setLoadState('loaded')
    if (slotAcquiredRef.current) {
      releaseLoadSlot()
      slotAcquiredRef.current = false
    }
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    setLoadState('error')
    if (slotAcquiredRef.current) {
      releaseLoadSlot()
      slotAcquiredRef.current = false
    }
    onError?.()
  }, [onError])

  useEffect(() => {
    if (loadState === 'loaded' && !isVisible && imgRef.current) {
      imgRef.current.src = ''
      setLoadState('idle')
    }
  }, [isVisible, loadState])

  if (!src) {
    return (
      <div ref={containerRef} className={className} style={style}>
        {fallback || placeholder}
      </div>
    )
  }

  const showImg = loadState === 'loading' || loadState === 'loaded'
  const showPlaceholder = !isVisible || (isVisible && loadState === 'idle') || loadState === 'loading'
  const showFallback = loadState === 'error'

  return (
    <div ref={containerRef} className={className} style={style}>
      {showImg && (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          decoding="async"
          loading="lazy"
          className={`${imgClassName} transition-opacity duration-300 ${loadState === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
      {showPlaceholder && !showFallback && (
        <div className="absolute inset-0">{placeholder}</div>
      )}
      {showFallback && (
        <div className="absolute inset-0">{fallback || placeholder}</div>
      )}
    </div>
  )
})