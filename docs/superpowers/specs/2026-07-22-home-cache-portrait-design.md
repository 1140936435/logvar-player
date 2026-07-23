# 首页图片缓存与竖屏视频自适应设计文档

## 1. 需求概述

### 1.1 首页图片刷新性能优化
当前问题：从播放页面退回首页时，页面明显卡顿，原因是全部封面资源被重新发起请求、重复渲染，没有做好图片缓存复用。

优化目标：
- 实现封面图片磁盘缓存，已加载过的海报不重复请求
- 返回首页时禁止强制全量刷新全部影片列表与图片
- 实现图片懒加载，可视区域外的海报暂缓加载
- 优化图片渲染逻辑，避免大量DOM同时重绘
- 切换服务器、刷新资料库时缓存可正常更新

### 1.2 竖屏视频自适应播放布局
当前问题：软件仅适配横屏影片，竖屏视频被拉伸或裁剪。

优化目标：
- 自动识别视频画面比例
- 竖屏视频自动切换为竖屏展示，保持原始比例
- 底部控制栏布局适配竖屏模式
- 全屏状态兼容竖屏布局
- 横屏影片维持原有布局逻辑

### 1.3 约束条件
- 禁止破坏现有功能：Jellyfin、Emby双服务器连接、封面加载、弹幕、最近入库、最近播放等
- 图片缓存使用磁盘缓存方案

---

## 2. 架构设计

### 2.1 首页图片缓存架构

#### 2.1.1 整体架构
```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer Process                        │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │   Home.tsx   │    │  MediaCard   │    │HomeStoreProvider│  │
│  │              │    │   Component  │    │  (数据持久化) │   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘   │
│         │                   │                    │           │
│         ▼                   ▼                    ▼           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  getPosterUrl│    │   img标签    │    │  localStorage│   │
│  │  (生成URL)   │    │ (loading=lazy)│    │  (缓存列表)  │   │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘   │
│         │                   │                                │
│         └──────────┬────────┘                                │
│                    ▼                                         │
│         ┌──────────────────┐                                 │
│         │ emby-image://    │                                 │
│         │ jellyfin-image://│                                 │
│         └────────┬─────────┘                                 │
└──────────────────┼──────────────────────────────────────────┘
                   │ IPC
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                      Main Process                           │
│                                                             │
│         ┌───────────────────────────────────────────┐       │
│         │         Protocol Handler                   │       │
│         │  ┌─────────────┐  ┌─────────────────────┐ │       │
│         │  │jellyfin-image│  │   emby-image       │ │       │
│         │  └──────┬──────┘  └──────────┬──────────┘ │       │
│         │         │                    │            │       │
│         │         ▼                    ▼            │       │
│         │  ┌─────────────────────────────────────┐  │       │
│         │  │        PosterCacheService            │  │       │
│         │  │  ┌──────────────┐  ┌─────────────┐   │  │       │
│         │  │  │ DiskCache    │  │ LRU清理     │   │  │       │
│         │  │  │ (文件系统)   │  │ (定时清理)   │   │  │       │
│         │  │  └──────────────┘  └─────────────┘   │  │       │
│         │  └─────────────────────────────────────┘  │       │
│         └───────────────────────────────────────────┘       │
│                                                             │
│         ┌─────────────────────────────────────────────┐     │
│         │              userData/poster-cache/          │     │
│         │  jellyfin_{itemId}_{tag}.png                │     │
│         │  emby_{itemId}_{tag}.png                    │     │
│         └─────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

#### 2.1.2 缓存策略
- **缓存键**：`{serverType}_{itemId}_{imageTag}`，imageTag 变化时自动视为新资源
- **缓存目录**：`userData/poster-cache/`（Electron 的 app.getPath('userData')）
- **缓存上限**：500MB，超过后按 LRU 策略清理
- **缓存有效期**：7天，过期自动重新请求
- **失效场景**：
  - imageTag 变化（服务器端图片更新）
  - 手动刷新资料库
  - 切换服务器

#### 2.1.3 HomeStoreProvider 设计
```typescript
interface HomeStoreState {
  libraries: MediaLibrary[];
  libraryItems: Record<string, MediaItem[]>;
  libraryTotalCounts: Record<string, number>;
  drillStack: DrillLevel[];
  scrollPosition: Record<string, number>;
  recentlyAdded: RecentlyAddedItem[];
  recentPlayback: PlaybackHistoryItem[];
  lastUpdateTime: number;
}
```

- 使用 localStorage 持久化数据
- 从播放页返回时优先从缓存恢复数据
- 数据过期时间：5分钟
- 切换服务器或手动刷新时清空并重新加载

### 2.2 竖屏视频自适应架构

#### 2.2.1 整体架构
```
┌─────────────────────────────────────────────────────────────┐
│                        Player.tsx                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                      isPortrait                        │   │
│  │              (videoHeight > videoWidth)               │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                   │
│         ┌───────────────┼───────────────┐                   │
│         ▼               ▼               ▼                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ VideoContainer│ │   Controls   │ │  DanmakuCanvas│       │
│  │  (自适应宽高) │ │ (宽度对齐)   │ │ (跟随视频)   │        │
│  └──────────────┘ └──────────────┘ └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

#### 2.2.2 检测逻辑
- 在 `video.onloadedmetadata` 事件中获取 `video.videoWidth` 和 `video.videoHeight`
- 判断条件：`video.videoHeight > video.videoWidth` 视为竖屏
- 设置 `isPortrait` 状态，贯穿整个 Player 组件
- 视频切换时重新检测

#### 2.2.3 布局策略
| 模式 | 视频容器 | 控制栏 | 弹幕画布 |
|------|---------|--------|---------|
| 横屏 | 铺满容器，`object-contain` | 宽度100% | 铺满视频区域 |
| 竖屏 | 高度自适应，宽度不超过窗口高度×比例 | 宽度与视频对齐 | 缩小到视频区域内 |

---

## 3. 模块设计

### 3.1 PosterCacheService（主进程）

**文件位置**：`src/main/services/poster-cache.ts`

**核心方法**：
```typescript
class PosterCacheService {
  constructor();
  get(key: string): Promise<Buffer | null>;
  set(key: string, data: Buffer): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  cleanup(): Promise<void>;
}
```

**缓存文件格式**：
- 文件名：`{serverType}_{itemId}_{imageTag}_{maxHeight}.png`
- 路径：`${userData}/poster-cache/${filename}`
- 附加元数据文件：`${filename}.json` 包含过期时间、原始URL

### 3.2 协议处理器修改

**文件位置**：`src/main/index.ts`

**修改内容**：
- 在 `jellyfin-image://` 和 `emby-image://` 协议处理器中集成 PosterCacheService
- 请求流程：检查缓存 → 命中则返回本地文件 → 未命中则请求网络 → 缓存结果 → 返回

### 3.3 HomeStoreProvider（渲染进程）

**文件位置**：`src/renderer/src/providers/HomeStoreProvider.tsx`

**核心方法**：
```typescript
interface HomeStoreContextType {
  state: HomeStoreState;
  setLibraries: (libraries: MediaLibrary[]) => void;
  setLibraryItems: (libraryId: string, items: MediaItem[]) => void;
  setDrillStack: (stack: DrillLevel[]) => void;
  setScrollPosition: (key: string, position: number) => void;
  invalidate: () => void;
}
```

### 3.4 Player 竖屏适配（渲染进程）

**文件位置**：`src/renderer/src/pages/Player.tsx`

**新增状态**：
```typescript
const [isPortrait, setIsPortrait] = useState(false);
const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
```

**新增方法**：
```typescript
const detectVideoOrientation = useCallback(() => {
  if (videoRef.current) {
    const { videoWidth, videoHeight } = videoRef.current;
    const ratio = videoWidth / videoHeight;
    setVideoAspectRatio(ratio);
    setIsPortrait(videoHeight > videoWidth);
  }
}, []);
```

**布局修改**：
- 视频容器根据 `isPortrait` 和 `videoAspectRatio` 动态调整宽高
- 控制栏宽度跟随视频宽度
- 弹幕画布尺寸适配视频实际显示区域

---

## 4. 数据流程

### 4.1 图片缓存数据流程
```
用户打开首页
    │
    ▼
getPosterUrl(item)
    │
    ▼
生成协议URL (emby-image:// 或 jellyfin-image://)
    │
    ▼
浏览器请求自定义协议
    │
    ▼
协议处理器接收请求
    │
    ├─ 检查缓存键是否存在
    │   ├─ 存在且未过期 → 返回本地文件
    │   └─ 不存在或过期 → 请求网络
    │         │
    │         ├─ 成功 → 写入缓存 → 返回数据
    │         └─ 失败 → 返回错误
```

### 4.2 首页数据恢复流程
```
从播放页返回首页
    │
    ▼
Home组件挂载
    │
    ▼
HomeStoreProvider 获取缓存数据
    │
    ├─ 数据存在且未过期 → 直接渲染（无需API请求）
    │
    └─ 数据不存在或过期 → 加载服务器配置 → 请求API → 更新缓存 → 渲染
```

### 4.3 竖屏检测流程
```
视频加载完成
    │
    ▼
onloadedmetadata 事件
    │
    ▼
detectVideoOrientation()
    │
    ▼
获取 videoWidth/videoHeight
    │
    ▼
判断 videoHeight > videoWidth ?
    │
    ├─ true → 设置 isPortrait = true
    │         设置 videoAspectRatio = width/height
    │         触发重渲染（竖屏布局）
    │
    └─ false → 设置 isPortrait = false
               设置 videoAspectRatio = width/height
               触发重渲染（横屏布局）
```

---

## 5. 容错设计

### 5.1 图片缓存容错
- 缓存文件损坏：检测文件大小和格式，损坏时自动删除并重试
- 磁盘空间不足：捕获写入错误，降级为仅内存缓存
- 缓存目录创建失败：降级为不使用缓存

### 5.2 首页数据容错
- 缓存数据格式错误：解析失败时清空缓存并重新加载
- localStorage 不可用：降级为每次都重新请求

### 5.3 竖屏检测容错
- videoWidth/videoHeight 为0：等待一段时间后重试
- 检测时机：视频切换、播放开始、元数据加载完成

---

## 6. 性能优化

### 6.1 图片加载优化
- IntersectionObserver 精确控制可视区域外图片不加载
- 图片请求防抖：同一时间最多并发10个请求
- 使用 CDN 或本地缓存减少网络延迟

### 6.2 DOM渲染优化
- MediaCard 使用 React.memo 避免不必要重渲染
- 列表渲染使用 key 属性优化 Diff 算法
- 虚拟列表（可选）：对于超大量媒体库（>1000项）可考虑引入

### 6.3 缓存管理优化
- LRU 清理定时执行（每次启动时、空闲时）
- 缓存写入异步执行，不阻塞主线程
- 缓存键使用 MD5 缩短文件名

---

## 7. 测试计划

### 7.1 图片缓存测试
1. 首次加载首页：确认图片从网络请求并写入缓存
2. 刷新页面：确认图片从缓存读取，无网络请求
3. 从播放页返回：确认图片立即显示，无加载延迟
4. imageTag 变化：确认缓存失效，重新请求新图片
5. 手动刷新资料库：确认缓存清空并重新加载
6. 切换服务器：确认缓存按服务器类型隔离

### 7.2 竖屏视频测试
1. 播放横屏视频：确认布局正常，控制栏完整
2. 播放竖屏视频：确认视频垂直显示，不拉伸，控制栏对齐
3. 全屏竖屏：确认全屏状态下竖屏布局正确
4. 切换视频：确认自动检测并切换布局
5. 调整窗口大小：确认布局自适应

### 7.3 回归测试
1. Jellyfin 服务器：确认封面加载、播放正常
2. Emby 服务器：确认封面加载、播放正常
3. 弹幕功能：确认横屏和竖屏模式下弹幕正常显示
4. 最近入库/播放：确认功能正常

---

## 8. 风险评估

| 风险 | 影响 | 概率 | 应对策略 |
|------|------|------|---------|
| 缓存文件损坏导致图片无法显示 | 低 | 低 | 检测文件有效性，损坏自动删除 |
| localStorage 数据过大影响性能 | 低 | 中 | 限制缓存数据大小，定期清理 |
| 竖屏布局影响横屏体验 | 中 | 低 | 严格条件判断，横屏保持原有逻辑 |
| 协议处理器修改引入兼容性问题 | 高 | 低 | 保留原有协议处理逻辑，仅添加缓存层 |
| 缓存过期策略不合理 | 低 | 中 | 设置合理过期时间，支持手动刷新 |

---

## 9. 实施顺序

1. **PosterCacheService**（主进程缓存服务）
2. **协议处理器修改**（集成缓存服务）
3. **HomeStoreProvider**（首页数据持久化）
4. **Home.tsx 修改**（使用 HomeStoreProvider）
5. **Player.tsx 修改**（竖屏检测与布局适配）
6. **测试与调试**

---

## 10. 验证标准

- ✅ 从播放页返回首页无明显卡顿（<300ms）
- ✅ 已加载过的海报不再发起网络请求（磁盘缓存命中）
- ✅ 切换服务器时缓存正确隔离
- ✅ 竖屏视频自动识别并垂直显示，保持原始比例
- ✅ 控制栏在竖屏模式下与视频宽度对齐
- ✅ 全屏状态下竖屏布局正确
- ✅ Jellyfin、Emby 双服务器功能正常
- ✅ 弹幕功能在横/竖屏模式下正常
- ✅ TypeScript 类型检查通过
- ✅ electron-vite 构建成功