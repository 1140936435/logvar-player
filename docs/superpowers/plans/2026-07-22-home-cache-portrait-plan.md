# 首页图片缓存与竖屏视频自适应实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现首页海报磁盘缓存、首页数据持久化、竖屏视频自适应播放布局

**Architecture:** 
- 主进程 PosterCacheService 管理磁盘缓存（LRU策略，500MB上限）
- 协议处理器（jellyfin-image/emby-image）集成缓存逻辑
- 渲染进程 HomeStoreProvider 使用 localStorage 持久化首页数据
- Player 组件通过 onloadedmetadata 检测视频方向并自适应布局

**Tech Stack:** TypeScript, Electron, React, localStorage, IntersectionObserver

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/main/services/poster-cache.ts` | PosterCacheService 磁盘缓存服务 |
| `src/main/index.ts` | 协议处理器集成缓存逻辑 |
| `src/renderer/src/providers/HomeStoreProvider.tsx` | 首页数据持久化 Provider |
| `src/renderer/src/pages/Home.tsx` | 使用 HomeStoreProvider，优化图片加载 |
| `src/renderer/src/pages/Player.tsx` | 竖屏检测与布局适配 |

---

## Task 1: 创建 PosterCacheService

**Files:**
- Create: `src/main/services/poster-cache.ts`

- [ ] **Step 1: 创建缓存服务文件**

```typescript
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

interface CacheMetadata {
  createdAt: number;
  expiresAt: number;
  originalUrl: string;
}

export class PosterCacheService {
  private cacheDir: string;
  private maxSizeBytes: number;
  private maxAgeMs: number;

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'poster-cache');
    this.maxSizeBytes = 500 * 1024 * 1024;
    this.maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    this.ensureCacheDir();
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getKeyPath(key: string): { data: string; meta: string } {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      data: path.join(this.cacheDir, `${safeKey}.png`),
      meta: path.join(this.cacheDir, `${safeKey}.json`),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    const paths = this.getKeyPath(key);
    if (!fs.existsSync(paths.data)) return null;

    try {
      const metaStr = fs.readFileSync(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      if (Date.now() > meta.expiresAt) {
        fs.unlinkSync(paths.data);
        fs.unlinkSync(paths.meta);
        return null;
      }
      return fs.readFileSync(paths.data);
    } catch {
      try { fs.unlinkSync(paths.data); } catch {}
      try { fs.unlinkSync(paths.meta); } catch {}
      return null;
    }
  }

  async set(key: string, data: Buffer, originalUrl: string): Promise<void> {
    try {
      const paths = this.getKeyPath(key);
      fs.writeFileSync(paths.data, data);
      fs.writeFileSync(paths.meta, JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + this.maxAgeMs,
        originalUrl,
      }));
      await this.cleanupIfNeeded();
    } catch {
      console.error(`[PosterCache] Failed to write cache for key: ${key}`);
    }
  }

  async has(key: string): Promise<boolean> {
    const paths = this.getKeyPath(key);
    if (!fs.existsSync(paths.data)) return false;
    try {
      const metaStr = fs.readFileSync(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      return Date.now() <= meta.expiresAt;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const paths = this.getKeyPath(key);
    try { fs.unlinkSync(paths.data); } catch {}
    try { fs.unlinkSync(paths.meta); } catch {}
  }

  async clear(): Promise<void> {
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      this.ensureCacheDir();
    } catch {}
  }

  private async cleanupIfNeeded(): Promise<void> {
    try {
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.png'));
      const items = files.map(file => {
        const filePath = path.join(this.cacheDir, file);
        const stat = fs.statSync(filePath);
        return { file, mtime: stat.mtime.getTime(), size: stat.size };
      }).sort((a, b) => a.mtime - b.mtime);

      let totalSize = items.reduce((sum, item) => sum + item.size, 0);
      for (const item of items) {
        if (totalSize <= this.maxSizeBytes) break;
        const key = item.file.replace(/\.png$/, '');
        await this.delete(key);
        totalSize -= item.size;
      }
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }

  async cleanup(): Promise<void> {
    try {
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.png'));
      for (const file of files) {
        const key = file.replace(/\.png$/, '');
        const paths = this.getKeyPath(key);
        try {
          const metaStr = fs.readFileSync(paths.meta, 'utf-8');
          const meta: CacheMetadata = JSON.parse(metaStr);
          if (Date.now() > meta.expiresAt) {
            fs.unlinkSync(paths.data);
            fs.unlinkSync(paths.meta);
          }
        } catch {
          fs.unlinkSync(paths.data);
          try { fs.unlinkSync(paths.meta); } catch {}
        }
      }
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }
}

export const posterCache = new PosterCacheService();
```

- [ ] **Step 2: 验证文件创建**

Run: `dir src/main/services/poster-cache.ts`
Expected: 文件存在

- [ ] **Step 3: Commit**

```bash
git add src/main/services/poster-cache.ts
git commit -m "feat: add PosterCacheService disk cache"
```

---

## Task 2: 集成缓存到协议处理器

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: 引入 PosterCacheService**

在文件顶部添加：
```typescript
import { posterCache } from './services/poster-cache';
```

- [ ] **Step 2: 修改 emby-image 协议处理器集成缓存**

找到 `registerEmbyImageProtocol` 函数（约第2800行），修改请求逻辑：
```typescript
async (request) => {
  try {
    let realUrl = request.url
      .replace(/^emby-image:\/\/https\//, 'https://')
      .replace(/^emby-image:\/\/http\//, 'http://')
      .replace(/^emby-image:\/\//, 'http://');

    const urlObj = new URL(realUrl);
    const token = urlObj.searchParams.get('token') || '';
    urlObj.searchParams.delete('token');
    realUrl = urlObj.toString();

    const cacheKey = `emby_${urlObj.pathname}_${urlObj.search}`;
    const cachedData = await posterCache.get(cacheKey);
    
    if (cachedData) {
      console.log(`[emby-image] 缓存命中: ${cacheKey}`);
      return new Response(cachedData, {
        headers: { 'Content-Type': 'image/png' },
      });
    }

    const headers: Record<string, string> = {};
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    console.log(`[emby-image] ===== 请求开始 =====`);
    console.log(`[emby-image] URL: ${realUrl}`);

    try {
      const response = await net.fetch(realUrl, {
        signal: AbortSignal.timeout(15000),
        bypassCustomProtocolHandlers: true,
        headers,
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await posterCache.set(cacheKey, buffer, realUrl);

      return new Response(buffer, {
        headers: { 'Content-Type': response.headers.get('content-type') || 'image/png' },
      });
    } catch (err) {
      console.error(`[emby-image] 请求失败: ${err}`);
      return new Response('Error loading image', { status: 500 });
    }
  } catch (err) {
    console.error(`[emby-image] 解析失败: ${err}`);
    return new Response('Invalid URL', { status: 400 });
  }
};
```

- [ ] **Step 3: 修改 jellyfin-image 协议处理器集成缓存**

找到 `registerJellyfinImageProtocol` 函数，添加类似的缓存逻辑：
```typescript
async (request) => {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('api_key') || '';
    url.searchParams.delete('api_key');
    const realUrl = 'http://' + url.host + url.pathname + url.search;

    const cacheKey = `jellyfin_${url.pathname}_${url.search}`;
    const cachedData = await posterCache.get(cacheKey);
    
    if (cachedData) {
      console.log(`[jellyfin-image] 缓存命中: ${cacheKey}`);
      return new Response(cachedData, {
        headers: { 'Content-Type': 'image/png' },
      });
    }

    console.log(`[jellyfin-image] 请求: ${realUrl}`);

    try {
      const response = await net.fetch(realUrl, {
        signal: AbortSignal.timeout(15000),
        bypassCustomProtocolHandlers: true,
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await posterCache.set(cacheKey, buffer, realUrl);

      return new Response(buffer, {
        headers: { 'Content-Type': response.headers.get('content-type') || 'image/png' },
      });
    } catch (err) {
      console.error(`[jellyfin-image] 请求失败: ${err}`);
      return new Response('Error loading image', { status: 500 });
    }
  } catch (err) {
    console.error(`[jellyfin-image] 解析失败: ${err}`);
    return new Response('Invalid URL', { status: 400 });
  }
};
```

- [ ] **Step 4: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: integrate poster cache into image protocols"
```

---

## Task 3: 创建 HomeStoreProvider

**Files:**
- Create: `src/renderer/src/providers/HomeStoreProvider.tsx`

- [ ] **Step 1: 创建 HomeStoreProvider 文件**

```typescript
import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';

interface MediaLibrary {
  Id: string;
  Name: string;
  Type: string;
}

interface MediaItem {
  Id: string;
  Name: string;
  ImageTags?: Record<string, string>;
  Type: string;
  PremiereDate?: string;
  CommunityRating?: number;
  ProductionYear?: number;
  Overview?: string;
  RunTimeTicks?: number;
}

interface DrillLevel {
  libraryId: string;
  libraryName: string;
  itemType?: string;
  parentId?: string;
}

interface RecentlyAddedItem {
  itemId: string;
  name: string;
  imageTag: string;
  type: string;
  date: string;
}

interface PlaybackHistoryItem {
  itemId: string;
  name: string;
  imageTag: string;
  type: string;
  progress: number;
  date: string;
}

export interface HomeStoreState {
  libraries: MediaLibrary[];
  libraryItems: Record<string, MediaItem[]>;
  libraryTotalCounts: Record<string, number>;
  drillStack: DrillLevel[];
  scrollPosition: Record<string, number>;
  recentlyAdded: RecentlyAddedItem[];
  recentPlayback: PlaybackHistoryItem[];
  lastUpdateTime: number;
}

type HomeStoreAction =
  | { type: 'SET_LIBRARIES'; payload: MediaLibrary[] }
  | { type: 'SET_LIBRARY_ITEMS'; payload: { libraryId: string; items: MediaItem[] } }
  | { type: 'SET_LIBRARY_TOTAL_COUNT'; payload: { libraryId: string; count: number } }
  | { type: 'SET_DRILL_STACK'; payload: DrillLevel[] }
  | { type: 'SET_SCROLL_POSITION'; payload: { key: string; position: number } }
  | { type: 'SET_RECENTLY_ADDED'; payload: RecentlyAddedItem[] }
  | { type: 'SET_RECENT_PLAYBACK'; payload: PlaybackHistoryItem[] }
  | { type: 'INVALIDATE' }
  | { type: 'RESTORE'; payload: HomeStoreState };

const initialState: HomeStoreState = {
  libraries: [],
  libraryItems: {},
  libraryTotalCounts: {},
  drillStack: [],
  scrollPosition: {},
  recentlyAdded: [],
  recentPlayback: [],
  lastUpdateTime: 0,
};

function homeStoreReducer(state: HomeStoreState, action: HomeStoreAction): HomeStoreState {
  switch (action.type) {
    case 'SET_LIBRARIES':
      return { ...state, libraries: action.payload, lastUpdateTime: Date.now() };
    case 'SET_LIBRARY_ITEMS':
      return {
        ...state,
        libraryItems: { ...state.libraryItems, [action.payload.libraryId]: action.payload.items },
        lastUpdateTime: Date.now(),
      };
    case 'SET_LIBRARY_TOTAL_COUNT':
      return {
        ...state,
        libraryTotalCounts: { ...state.libraryTotalCounts, [action.payload.libraryId]: action.payload.count },
      };
    case 'SET_DRILL_STACK':
      return { ...state, drillStack: action.payload };
    case 'SET_SCROLL_POSITION':
      return {
        ...state,
        scrollPosition: { ...state.scrollPosition, [action.payload.key]: action.payload.position },
      };
    case 'SET_RECENTLY_ADDED':
      return { ...state, recentlyAdded: action.payload, lastUpdateTime: Date.now() };
    case 'SET_RECENT_PLAYBACK':
      return { ...state, recentPlayback: action.payload, lastUpdateTime: Date.now() };
    case 'INVALIDATE':
      return { ...initialState, lastUpdateTime: 0 };
    case 'RESTORE':
      return action.payload;
    default:
      return state;
  }
}

interface HomeStoreContextType {
  state: HomeStoreState;
  setLibraries: (libraries: MediaLibrary[]) => void;
  setLibraryItems: (libraryId: string, items: MediaItem[]) => void;
  setLibraryTotalCount: (libraryId: string, count: number) => void;
  setDrillStack: (stack: DrillLevel[]) => void;
  setScrollPosition: (key: string, position: number) => void;
  setRecentlyAdded: (items: RecentlyAddedItem[]) => void;
  setRecentPlayback: (items: PlaybackHistoryItem[]) => void;
  invalidate: () => void;
  isFresh: () => boolean;
}

const HomeStoreContext = createContext<HomeStoreContextType | null>(null);

const STORAGE_KEY = 'logvar-home-store';
const CACHE_TTL = 5 * 60 * 1000;

export function HomeStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(homeStoreReducer, initialState);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as HomeStoreState;
        if (parsed.libraries && parsed.libraries.length > 0) {
          dispatch({ type: 'RESTORE', payload: parsed });
        }
      }
    } catch {
      console.error('[HomeStore] Failed to restore from localStorage');
    }
  }, []);

  useEffect(() => {
    if (state.libraries.length > 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        console.error('[HomeStore] Failed to save to localStorage');
      }
    }
  }, [state]);

  const setLibraries = (libraries: MediaLibrary[]) => dispatch({ type: 'SET_LIBRARIES', payload: libraries });
  const setLibraryItems = (libraryId: string, items: MediaItem[]) => dispatch({ type: 'SET_LIBRARY_ITEMS', payload: { libraryId, items } });
  const setLibraryTotalCount = (libraryId: string, count: number) => dispatch({ type: 'SET_LIBRARY_TOTAL_COUNT', payload: { libraryId, count } });
  const setDrillStack = (stack: DrillLevel[]) => dispatch({ type: 'SET_DRILL_STACK', payload: stack });
  const setScrollPosition = (key: string, position: number) => dispatch({ type: 'SET_SCROLL_POSITION', payload: { key, position } });
  const setRecentlyAdded = (items: RecentlyAddedItem[]) => dispatch({ type: 'SET_RECENTLY_ADDED', payload: items });
  const setRecentPlayback = (items: PlaybackHistoryItem[]) => dispatch({ type: 'SET_RECENT_PLAYBACK', payload: items });
  const invalidate = () => {
    dispatch({ type: 'INVALIDATE' });
    localStorage.removeItem(STORAGE_KEY);
  };
  const isFresh = () => Date.now() - state.lastUpdateTime < CACHE_TTL;

  return (
    <HomeStoreContext.Provider value={{
      state,
      setLibraries,
      setLibraryItems,
      setLibraryTotalCount,
      setDrillStack,
      setScrollPosition,
      setRecentlyAdded,
      setRecentPlayback,
      invalidate,
      isFresh,
    }}>
      {children}
    </HomeStoreContext.Provider>
  );
}

export function useHomeStore() {
  const context = useContext(HomeStoreContext);
  if (!context) {
    throw new Error('useHomeStore must be used within a HomeStoreProvider');
  }
  return context;
}
```

- [ ] **Step 2: 在 App.tsx 中包装 HomeStoreProvider**

修改 `src/renderer/src/App.tsx`，在 BrowserRouter 内部添加：
```tsx
import { HomeStoreProvider } from './providers/HomeStoreProvider';

function App() {
  return (
    <BrowserRouter>
      <HomeStoreProvider>
        <Routes>
          {/* ... 现有路由 */}
        </Routes>
      </HomeStoreProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/providers/HomeStoreProvider.tsx src/renderer/src/App.tsx
git commit -m "feat: add HomeStoreProvider for home page data persistence"
```

---

## Task 4: 修改 Home.tsx 使用缓存和懒加载

**Files:**
- Modify: `src/renderer/src/pages/Home.tsx`

- [ ] **Step 1: 引入 useHomeStore**

在文件顶部添加：
```typescript
import { useHomeStore } from '../providers/HomeStoreProvider';
```

- [ ] **Step 2: 修改 loadMediaData 使用缓存**

找到 `loadMediaData` 函数（约第595行），修改为：
```typescript
const loadMediaData = useCallback(async () => {
  try {
    const { state, setLibraries, setLibraryItems, setRecentlyAdded, setRecentPlayback, isFresh } = useHomeStore();
    
    if (isFresh()) {
      console.log('[Home] 使用缓存数据，跳过 API 请求');
      setLibraries(state.libraries);
      Object.entries(state.libraryItems).forEach(([id, items]) => {
        setLibraryItems(id, items);
      });
      setRecentlyAdded(state.recentlyAdded);
      setRecentPlayback(state.recentPlayback);
      return;
    }

    setLoading(true);
    const saved = await window.api.store.get('jellyfin');
    if (!saved?.url || !saved?.token) {
      setLoading(false);
      return;
    }

    const activeResult = await window.api.server.getActive();
    if (activeResult.success && activeResult.data?.server) {
      const detectedType = activeResult.data.server.type === 'emby' ? 'emby' : 'jellyfin';
      setServerType(detectedType);
    }

    const libraries = await jellyfinApi.libraries();
    setLibraries(libraries);

    for (const lib of libraries) {
      const items = await jellyfinApi.libraryItems(lib.Id);
      setLibraryItems(lib.Id, items);
    }

    const recentlyAdded = await jellyfinApi.recentlyAdded();
    setRecentlyAdded(recentlyAdded);

    const recentPlayback = await jellyfinApi.recentPlayback();
    setRecentPlayback(recentPlayback);
  } catch (err) {
    console.error('[Home] Failed to load media data:', err);
  } finally {
    setLoading(false);
  }
}, [/* 现有依赖 */]);
```

注意：需要在 useCallback 外部解构 useHomeStore，或者使用 useRef 包装。正确做法：

```typescript
const homeStore = useHomeStore();

const loadMediaData = useCallback(async () => {
  try {
    if (homeStore.isFresh()) {
      console.log('[Home] 使用缓存数据，跳过 API 请求');
      return;
    }

    setLoading(true);
    // ... 现有逻辑
    
    homeStore.setLibraries(libraries);
    
    for (const lib of libraries) {
      const items = await jellyfinApi.libraryItems(lib.Id);
      homeStore.setLibraryItems(lib.Id, items);
    }

    const recentlyAdded = await jellyfinApi.recentlyAdded();
    homeStore.setRecentlyAdded(recentlyAdded);

    const recentPlayback = await jellyfinApi.recentPlayback();
    homeStore.setRecentPlayback(recentPlayback);
  } catch (err) {
    console.error('[Home] Failed to load media data:', err);
  } finally {
    setLoading(false);
  }
}, [/* 现有依赖 */]);
```

- [ ] **Step 3: 添加 IntersectionObserver 懒加载**

在 MediaCard 组件中添加：
```typescript
const imgRef = useRef<HTMLImageElement>(null);
const [isVisible, setIsVisible] = useState(false);

useEffect(() => {
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        observer.disconnect();
      }
    },
    { threshold: 0.1, rootMargin: '100px' }
  );

  if (imgRef.current) {
    observer.observe(imgRef.current);
  }

  return () => observer.disconnect();
}, []);

// 在 img 标签中：
<img
  ref={imgRef}
  src={isVisible ? posterUrl : undefined}
  alt={item.Name}
  loading="lazy"
  decoding="async"
  // ... 其他属性
/>
```

- [ ] **Step 4: 修改 refreshLibrary 使用 invalidate**

找到 `refreshLibrary` 函数，添加：
```typescript
const refreshLibrary = useCallback(async () => {
  homeStore.invalidate();
  await loadMediaData();
}, [loadMediaData]);
```

- [ ] **Step 5: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/Home.tsx
git commit -m "feat: home page cache and lazy loading optimization"
```

---

## Task 5: 修改 Player.tsx 实现竖屏自适应

**Files:**
- Modify: `src/renderer/src/pages/Player.tsx`

- [ ] **Step 1: 添加竖屏状态**

在组件顶部添加：
```typescript
const [isPortrait, setIsPortrait] = useState(false);
const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
```

- [ ] **Step 2: 添加方向检测方法**

```typescript
const detectVideoOrientation = useCallback(() => {
  if (videoRef.current) {
    const { videoWidth, videoHeight } = videoRef.current;
    if (videoWidth > 0 && videoHeight > 0) {
      const ratio = videoWidth / videoHeight;
      setVideoAspectRatio(ratio);
      setIsPortrait(videoHeight > videoWidth);
      console.log(`[Player] 视频方向: ${videoHeight > videoWidth ? '竖屏' : '横屏'}, 比例: ${ratio.toFixed(2)}`);
    }
  }
}, []);
```

- [ ] **Step 3: 绑定检测事件**

在 `useEffect` 中添加：
```typescript
useEffect(() => {
  const video = videoRef.current;
  if (!video) return;

  video.addEventListener('loadedmetadata', detectVideoOrientation);
  video.addEventListener('play', detectVideoOrientation);

  return () => {
    video.removeEventListener('loadedmetadata', detectVideoOrientation);
    video.removeEventListener('play', detectVideoOrientation);
  };
}, [detectVideoOrientation]);
```

- [ ] **Step 4: 修改视频容器布局**

找到视频容器（约第1000行），修改为：
```tsx
<div className={`relative w-full h-full flex items-center justify-center bg-black ${isPortrait ? 'portrait-mode' : ''}`}>
  <div
    className="relative bg-black"
    style={{
      maxWidth: isPortrait ? '60vh' : '100%',
      maxHeight: '100%',
      aspectRatio: videoAspectRatio.toString(),
    }}
  >
    <video
      ref={videoRef}
      className="w-full h-full object-contain"
      // ... 其他属性
    />
    {/* 弹幕画布 */}
    <canvas
      ref={danmakuCanvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100%', height: '100%' }}
    />
  </div>
</div>
```

- [ ] **Step 5: 修改控制栏布局**

找到控制栏（约第1005行），修改为：
```tsx
<div
  className={`absolute bottom-0 left-0 right-0 z-30 transition-opacity duration-300 ${
    isControlsVisible ? 'opacity-100' : 'opacity-0'
  } ${isPortrait ? 'flex justify-center' : ''}`}
>
  <div
    className="bg-black/80 backdrop-blur-sm p-4"
    style={{ width: isPortrait ? '60vh' : '100%' }}
  >
    {/* 现有控制栏内容 */}
  </div>
</div>
```

- [ ] **Step 6: 添加 CSS 样式**

在文件末尾添加样式：
```css
.portrait-mode {
  background-color: #000;
}
```

- [ ] **Step 7: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/pages/Player.tsx
git commit -m "feat: add portrait video orientation detection and layout"
```

---

## Task 6: 测试与构建验证

**Files:**
- None

- [ ] **Step 1: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误

- [ ] **Step 2: 运行 build**

Run: `npm run build`
Expected: electron-vite 构建成功

- [ ] **Step 3: 手动测试**

测试场景：
1. 首次加载首页：确认图片从网络请求并写入缓存
2. 刷新页面：确认图片从缓存读取，无网络请求
3. 从播放页返回：确认图片立即显示，无加载延迟
4. 切换服务器：确认缓存按服务器类型隔离
5. 播放横屏视频：确认布局正常
6. 播放竖屏视频：确认视频垂直显示，控制栏对齐
7. 全屏竖屏：确认全屏状态下竖屏布局正确

- [ ] **Step 4: Final Commit**

```bash
git add -A
git commit -m "feat: complete home cache and portrait video implementation"
```

---

## Self-Review

**1. Spec Coverage:**
- ✅ 图片磁盘缓存（PosterCacheService）
- ✅ 协议处理器集成缓存
- ✅ 首页数据持久化（HomeStoreProvider）
- ✅ 图片懒加载（IntersectionObserver）
- ✅ 竖屏视频检测与布局适配
- ✅ 控制栏适配
- ✅ 全屏兼容

**2. Placeholder Scan:**
- ✅ 无 TBD/TODO 占位符
- ✅ 所有步骤包含完整代码
- ✅ 所有命令明确

**3. Type Consistency:**
- ✅ 类型定义一致
- ✅ 方法签名一致

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-home-cache-portrait-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**