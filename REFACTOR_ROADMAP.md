---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 23b6efe78b83a4f007b47d40416e6c74_45cc494ab01511f1ac01525400e6dd8f
    ReservedCode1: hij523h2d56xf2CTRwVMFtCCnTRxb1Cp5hLwhAM7e9Uo0VeCxaNiXmg3entxFximalV7Gl5gQ1wckd5xL9/9MpRVNItnFlLHKICc4r5a96jP3X39amNUKQ0VTUUskvgt5u7yQeTIXL8ByduBRld6/5KJCjW43NEGc7FYlM3lKuXiqK7w04OnKKPTsqA=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 23b6efe78b83a4f007b47d40416e6c74_45cc494ab01511f1ac01525400e6dd8f
    ReservedCode2: hij523h2d56xf2CTRwVMFtCCnTRxb1Cp5hLwhAM7e9Uo0VeCxaNiXmg3entxFximalV7Gl5gQ1wckd5xL9/9MpRVNItnFlLHKICc4r5a96jP3X39amNUKQ0VTUUskvgt5u7yQeTIXL8ByduBRld6/5KJCjW43NEGc7FYlM3lKuXiqK7w04OnKKPTsqA=
---

# logvar-player 后续修改清单（Refactor Roadmap）

> 生成日期：2026-09-14
> 状态说明：清单由开发者提供，已与当前代码核对（见文末「现状核对」）。未勾选项 `[ ]` 即为待办。

---

## P0：发布前建议完成

* [x] **收紧 `StreamProxyService.ownsSessionUrl()`**
  * 只允许 `http:`
  * 只允许 `127.0.0.1`
  * 端口必须等于当前 StreamProxy 实际端口
  * pathname 必须精确匹配 `/s/<sessionId>`
  * 拒绝额外 query/hash
  * 必须验证 session 未过期
  * 建议把 `takeSession()` 改名为 `getValidSession()`，语义更准确
* [ ] **完善 StreamProxy 异常流**
  * `proxyReq.on('error')` 时：
    * headers 未发送 → 返回 502
    * headers 已发送 → `res.destroy(err)`
  * `upstream.on('error')` → destroy response
  * `upstream.on('aborted')` → destroy response
  * 最好改成 `stream.pipeline()` 统一错误传播
* [x] **补 StreamProxy 安全测试**
  * HTTPS session URL → false
  * 错误端口 → false
  * 非 `127.0.0.1` → false
  * `/s/id/extra` → false
  * query/hash → false
  * 已过期 session → false
  * 随机不存在 session ID → false
* [ ] **整理 StreamProxy 测试服务器**
  * 不再固定 `9876 / 9877`
  * 使用 `listen(0)`
  * `afterAll()` 真正调用 `server.close()`
  * 避免 CI `EADDRINUSE`
  * 避免 Vitest open handle

---

## P1：下一阶段最重要——拆 `main/index.ts`

现在最明显的维护债仍然是：

```text
src/main/index.ts
≈ 4232 行
```

建议目标先压到 **1500 行以内**，最终 300～800 行。优先拆这些：

* [x] `windows/main-window.ts`
  * `BrowserWindow`
  * navigation policy
  * window open handler
  * maximize/minimize/fullscreen
* [x] `windows/log-window.ts`
  * 日志窗口创建
  * log preload
  * 生命周期
* [x] `ipc/file-ipc.ts`
  * 打开文件
  * 打开目录
  * 本地媒体扫描
  * 文件权限
* [x] `ipc/settings-ipc.ts`
  * config
  * player settings
  * theme/preferences
* [x] `ipc/history-ipc.ts`
  * 播放历史
  * progress
  * last-played
* [x] `ipc/danmaku-ipc.ts`
  * 弹幕加载
  * 搜索
  * provider
* [x] `ipc/media-ipc.ts`
  * metadata
  * poster
  * local media
* [x] Jellyfin / Emby IPC 单独模块化

最终 `index.ts` 尽量只保留：

```ts
app.whenReady()
registerProtocol()
createServices()
registerIpc()
createMainWindow()
setupAppLifecycle()
```

---

## P1：统一 IPC 注册方式

你现在已经有 sender 校验，但长期不建议通过 monkey-patch：

```ts
ipcMain.handle = ...
```

建议改成：

```ts
secureHandle(
  'channel:name',
  schema,
  handler
)
```

清单：

* [x] 创建 `ipc/secure-handle.ts`
* [x] 自动校验 sender
* [x] 自动捕获异常
* [x] 统一返回：

```ts
type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }
```

* [x] IPC 参数加 runtime validation

这里可以考虑：

```text
Zod
```

例如：

```ts
const SeekSchema = z.object({
  seconds: z.number()
    .finite()
    .min(0)
})
```

原因是 TypeScript 只能保证编译期，**renderer 传入 IPC 的数据在运行时仍是不可信输入**。

---

## P1：继续完善 `PlaybackEngine`

你现在已经迈出了很好的一步，但目前主要是 **Main 层 MPV IPC abstraction**。
下一阶段建议 Renderer 也建立统一接口：

```ts
interface PlaybackEngine {
  load(source: MediaSource): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>
  setVolume(volume: number): Promise<void>
  setSpeed(speed: number): Promise<void>
  selectAudioTrack(id: string): Promise<void>
  selectSubtitleTrack(id: string): Promise<void>
  onEvent(
    callback: PlaybackEventHandler
  ): () => void
  dispose(): Promise<void>
}
```

实现：

```text
Html5PlaybackEngine
MpvNativePlaybackEngine
MpvCanvasPlaybackEngine
```

然后 `Player.tsx` 不再直接写：

```ts
if (engineMode === 'mpv')
if (engineMode === 'canvas')
if (videoRef.current)
```

目标是：

```ts
const engine = usePlaybackEngine()
```

---

## P1：拆 `Player.tsx`

目前 Player 仍然太大。建议拆成：

```text
features/player/
├─ PlayerPage.tsx
├─ PlayerSurface.tsx
├─ PlayerControls.tsx
├─ PlayerTimeline.tsx
├─ PlayerVolume.tsx
├─ PlayerTracks.tsx
├─ PlayerSubtitle.tsx
├─ PlayerDanmaku.tsx
├─ PlayerEpisodeNavigation.tsx
├─ PlayerScreenshot.tsx
├─ PlayerFullscreen.ts
├─ usePlaybackEngine.ts
├─ usePlayerHotkeys.ts
├─ usePlaybackProgress.ts
└─ engines/
```

建议控制：

```text
PlayerPage.tsx < 400 行
```

最好最终：

```text
200~300 行
```

---

## P1：Canvas/libmpv 架构继续隔离

这个还是你的长期最大性能/安全技术债。目前：

```text
preload
 ↓
Koffi
 ↓
libmpv
 ↓
RGBA Uint8Array
 ↓
contextBridge
 ↓
Renderer/WebGL
```

长期建议：

```text
Renderer
    ↓ IPC/control
UtilityProcess / Native sidecar
    ↓
libmpv
```

清单：

* [ ] libmpv 生命周期从 preload 移走
* [ ] Koffi 不直接暴露在 Renderer security boundary
* [ ] native crash 不带死主窗口
* [ ] preload 最终尽可能 `sandbox:true`
* [ ] Canvas 只保留非常窄的控制 API

这项不需要马上做，但值得单独建 milestone。

---

## P2：性能优化

### 海报 / 图片

你前面已经把明显问题修掉了，后面可以继续：

* [ ] Poster cache 使用真实 manifest/index
* [ ] 记录真实 access time
* [ ] 精确统计磁盘 cache 大小
* [ ] 避免启动时全目录扫描
* [ ] cache eviction 做真正 LRU
* [ ] 图片 decode 并发限制
* [ ] 大图生成缩略图版本

### 媒体列表

* [ ] 长列表考虑 `@tanstack/react-virtual`
* [ ] 保证 ResizeObserver 不产生高频 setState
* [ ] 搜索/筛选使用 debounce
* [ ] 大量 metadata update 做 batch

比如：

```ts
startTransition(() => {
  setFilter(...)
})
```

React 19 下这类交互可以进一步优化。

### Zustand

检查所有 `useStore()`。如果直接：

```ts
const store = useStore()
```

会导致 store 任意变化触发组件 render。尽量：

```ts
const volume = useStore(
  state => state.volume
)
```

多个字段：

```ts
useShallow(...)
```

建议全项目扫一次 Zustand selector。

### React render

重点排查：

* [ ] Player controls
* [ ] Media cards
* [ ] Danmaku
* [ ] Timeline
* [ ] 当前时间更新

特别是 `timeupdate` 不要导致整个 Player 页面每 100ms～250ms 重绘。时间相关状态尽量局部化。

---

## P2：MPV 性能

建议做一次专门 profiling。

测试矩阵：

| 视频       | Engine   | 检查               |
| ---------- | -------- | ---------------- |
| 1080p H264 | native mpv | CPU/GPU        |
| 4K HEVC    | native mpv | hwdec          |
| 4K60       | native mpv | dropped frames |
| 1080p      | canvas   | CPU            |
| 4K         | canvas   | memory bandwidth |
| HDR HEVC   | native   | tone mapping   |
| AV1        | native   |                 |

---

## 现状核对（2026-09-14 与当前代码比对）

| 清单引用 | 实际情况 |
| --- | --- |
| `src/main/index.ts` ≈ 4600+ 行 | P1 拆分后实际 **1137 行**（目标 1500 行内） |
| `StreamProxyService` | ✅ 存在于 `src/main/services/stream-proxy-service.ts`（含 test） |
| `ownsSessionUrl()` / `takeSession()` | ✅ 已实现于上述文件，待按 P0 收紧 |
| 固定端口 `9876 / 9877` | ✅ 出现在 `stream-proxy-service.test.ts`，待改 `listen(0)` |
| `PlaybackEngine` | ✅ 存在于 `src/main/playback-engine.ts`（Main 层 abstraction） |
| `features/player/` | ❌ 尚未拆分（当前无 `src/features/player`） |
| `src/main/ipc/` | ✅ 已拆分（file/settings/history/danmaku/media/server/jellyfin/log 各模块） |
| `src/main/windows/` | ✅ 已拆分（main-window / log-window） |

> 说明：P1 的目录拆分目标（`windows/`、`ipc/`、`features/player/`）目前都还不存在，是未来待建结构。
*（内容由AI生成，仅供参考）*
