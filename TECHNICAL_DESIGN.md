# 海报加载架构重构技术设计文档

## 一、背景与问题分析

### 1.1 问题描述
当前软件首页在批量加载影片海报过程中存在持续性严重卡顿问题，主要表现为：
- 首次打开首页加载数百条影片时，页面滑动明显掉帧
- 从播放页返回首页时，海报需要重新加载，产生明显卡顿
- 快速滚动影片列表过程中，海报加载停滞感严重

### 1.2 根因分析

经过深入分析，确定以下核心问题：

| 问题类别 | 具体问题 | 影响 |
|---------|---------|------|
| DOM 渲染 | 全量渲染所有媒体卡片，数百个 DOM 节点同时存在 | 内存占用高、渲染开销大 |
| 动画库 | 使用 framer-motion 的 spring 物理动画 | 每个卡片都有独立动画实例，CPU 消耗大 |
| 缓存机制 | 同步 fs 操作阻塞主进程事件循环 | 图片请求响应延迟 |
| 图片格式 | 请求原始 PNG 格式图片 | 网络传输量大、解码耗时 |
| 请求日志 | 每张图片请求都打印 console.log | I/O 开销，影响性能 |
| 代码重复 | getPosterUrl 逻辑在多个组件中重复 | 难以维护，不一致性风险 |

### 1.3 竞品调研结论

通过对网易爆米花 Filmly、Jellyfin 官方客户端、Emby 官方客户端的技术架构分析，提取以下核心技术要点：

| 竞品 | 核心技术 | 实现方式 |
|------|---------|---------|
| Jellyfin 官方客户端 | 虚拟化列表 + 多级缓存 | RecyclerView/ListView + LRU 缓存 |
| Emby 官方客户端 | 按需加载 + WebP 格式 | 智能预加载 + 动态分辨率 |
| 网易爆米花 | 虚拟滚动 + 图片解码优化 | 长列表虚拟化 + 异步解码 |

---

## 二、技术架构设计

### 2.1 架构目标

1. **流畅体验**：首次加载数百条影片时滑动顺滑无卡顿
2. **快速返回**：从播放页返回首页时毫秒级显示
3. **滚动流畅**：快速滚动过程中海报加载无停滞感
4. **兼容性**：同时兼容 Jellyfin 和 Emby 服务器

### 2.2 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        渲染层 (Renderer)                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ VirtualGrid │───▶│  MediaCard  │───▶│    LazyImage        │  │
│  │ (虚拟滚动)   │    │ (CSS过渡)   │    │ (可视区域懒加载)    │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│           │                                         │            │
│           ▼                                         ▼            │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              getPosterUrl (统一海报URL构建)                  │  │
│  │  - WebP 格式支持                                          │  │
│  │  - 动态分辨率适配                                          │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (自定义协议: jellyfin-image/emby-image)
┌─────────────────────────────────────────────────────────────────┐
│                        主进程 (Main)                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              PosterCacheService (三级缓存体系)              │  │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │  │
│  │  │ 内存缓存     │───▶│ 磁盘缓存     │───▶│ 服务端请求   │   │  │
│  │  │ (LRU 100MB) │    │ (LRU 500MB) │    │ (并发限流)   │   │  │
│  │  └─────────────┘    └─────────────┘    └─────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 核心技术决策

#### 2.3.1 虚拟滚动技术（优先级最高）

**决策依据**：
- Jellyfin 官方客户端使用 RecyclerView（Android）/ ListView（iOS）实现虚拟化列表
- Emby 客户端使用类似的虚拟化技术
- 虚拟化列表将 DOM 节点数量控制在可见范围内（通常 10-20 个）

**实现方案**：
- 使用 `@tanstack/react-virtual` 库实现网格虚拟滚动
- 仅渲染可视区域内的媒体卡片
- 设置 2 行预加载缓冲区（overscan: 2）

**关键代码**：[VirtualMediaGrid.tsx](file:///g:/dev/logvar-player/src/renderer/src/components/VirtualMediaGrid.tsx)

#### 2.3.2 三级缓存体系

**决策依据**：
- 成熟客户端普遍采用三级缓存架构
- 一级内存缓存确保零延迟读取
- 二级磁盘缓存确保重启后无需重新下载
- 缓存 key 包含 imageTag 参数，天然支持缓存失效

**实现方案**：

| 层级 | 存储位置 | 大小限制 | 失效策略 |
|------|---------|---------|---------|
| 一级 | Memory Map | 100MB | LRU 淘汰 |
| 二级 | 文件系统 | 500MB | LRU + TTL(7天) |
| 三级 | 服务端 | 无 | imageTag 变更自动失效 |

**关键代码**：[poster-cache.ts](file:///g:/dev/logvar-player/src/main/services/poster-cache.ts)

#### 2.3.3 WebP 图片格式

**决策依据**：
- WebP 格式比 PNG 小 30-50%
- Jellyfin/Emby 服务器均支持 `format=webp` 参数
- 减少网络传输和内存占用

**实现方案**：
- 在所有海报 URL 中添加 `format=webp` 参数
- 统一封装到 `getPosterUrl` 工具函数

**关键代码**：[posterUrl.ts](file:///g:/dev/logvar-player/src/renderer/src/utils/posterUrl.ts)

#### 2.3.4 CSS 过渡替代 framer-motion

**决策依据**：
- framer-motion 的 spring 物理动画在数百个卡片上运行时 CPU 消耗巨大
- CSS transition 由浏览器合成线程处理，不阻塞主线程

**实现方案**：
- MediaCard 组件使用纯 CSS hover 效果
- 移除 framer-motion 的 `whileHover`、`whileTap`、`spring` 动画
- 保留必要的页面级 framer-motion 动画（模态框、下拉菜单）

**关键代码**：[MediaCard.tsx](file:///g:/dev/logvar-player/src/renderer/src/components/MediaCard.tsx)

#### 2.3.5 异步文件操作

**决策依据**：
- 同步 fs 操作（`readFileSync`、`writeFileSync`）会阻塞 Electron 主进程事件循环
- 图片缓存读写是高频操作，同步调用会导致 UI 响应延迟

**实现方案**：
- 将所有 fs 操作转换为异步 `fs.promises` API
- 使用 `await` 处理文件读写操作
- 确保不阻塞主进程事件循环

**关键代码**：[poster-cache.ts](file:///g:/dev/logvar-player/src/main/services/poster-cache.ts)

---

## 三、详细实现说明

### 3.1 虚拟滚动网格组件

**文件**：`src/renderer/src/components/VirtualMediaGrid.tsx`

**核心逻辑**：
1. 使用 `useVirtual` hook 计算可见行范围
2. 根据容器宽度动态计算列数
3. 仅渲染可见行的媒体卡片
4. 使用绝对定位实现虚拟滚动效果

**关键特性**：
- 响应式列数计算
- 自动预加载缓冲区
- 平滑滚动体验

### 3.2 统一海报 URL 工具

**文件**：`src/renderer/src/utils/posterUrl.ts`

**核心功能**：
1. 统一处理 Jellyfin/Emby 两种服务器类型
2. 添加 `format=webp` 参数
3. 动态计算最优海报高度
4. 支持本地刮削封面优先

**设计优势**：
- 消除代码重复（原 Home.tsx 和 RecentlyAddedRow.tsx 各有一份）
- 确保所有海报请求格式一致
- 便于后续扩展其他服务器类型

### 3.3 缓存服务重构

**文件**：`src/main/services/poster-cache.ts`

**主要变更**：
- 将 `fs.readFileSync` → `fs.promises.readFile`
- 将 `fs.writeFileSync` → `fs.promises.writeFile`
- 将 `fs.existsSync` → `fs.promises.access`
- 将 `fs.unlinkSync` → `fs.promises.unlink`
- 将 `fs.rmSync` → `fs.promises.rm`
- 将 `fs.readdirSync` → `fs.promises.readdir`
- 将 `fs.statSync` → `fs.promises.stat`

**性能提升**：
- 异步操作不阻塞事件循环
- 图片缓存读写与 UI 渲染并行执行
- 减少主线程卡顿

### 3.4 LazyImage 组件优化

**文件**：`src/renderer/src/components/LazyImage.tsx`

**增强功能**：
1. **可视区域外资源释放**：图片离开视口时清空 src 属性
2. **请求中断**：使用 AbortController 中断未完成的请求
3. **并发控制**：限制同时加载 6 张图片
4. **渐进式加载**：decoding="async" + loading="lazy"

### 3.5 MediaCard 组件优化

**文件**：`src/renderer/src/components/MediaCard.tsx`

**优化内容**：
- 移除 framer-motion 的 motion.div 包装
- 使用纯 CSS hover 效果（`group-hover:`）
- 保持原有视觉设计和交互逻辑
- 独立为单独组件，便于复用和测试

---

## 四、架构改动点汇总

| 文件 | 改动类型 | 核心改动 |
|------|---------|---------|
| `src/renderer/src/components/VirtualMediaGrid.tsx` | 新增 | 虚拟滚动网格组件 |
| `src/renderer/src/components/MediaCard.tsx` | 新增 | 独立媒体卡片组件（CSS 过渡） |
| `src/renderer/src/utils/posterUrl.ts` | 新增 | 统一海报 URL 构建工具 |
| `src/renderer/src/pages/Home.tsx` | 修改 | 使用新组件和工具函数 |
| `src/renderer/src/components/RecentlyAddedRow.tsx` | 修改 | 使用统一海报 URL 工具 |
| `src/renderer/src/components/LazyImage.tsx` | 修改 | 增强资源释放和请求中断 |
| `src/main/services/poster-cache.ts` | 修改 | 同步 → 异步 fs 操作 |
| `src/main/index.ts` | 修改 | 移除 verbose console.log |

---

## 五、关键场景验证

### 5.1 场景一：首次打开首页

**预期效果**：加载数百条影片时，页面滑动全程保持顺滑，无掉帧或卡顿现象

**实现机制**：
- 虚拟滚动仅渲染可见区域 DOM 节点
- 并发请求限流控制在 6 个以内
- 缓存命中时直接返回，无需网络请求

### 5.2 场景二：从播放页返回首页

**预期效果**：海报实现毫秒级显示，无重新加载导致的卡顿

**实现机制**：
- 内存缓存保留已加载的海报
- HomeStore 缓存媒体库数据，避免重新请求 API
- 返回时直接从缓存读取，零延迟显示

### 5.3 场景三：快速滚动影片列表

**预期效果**：海报加载流畅无任何停滞感

**实现机制**：
- IntersectionObserver 精准检测可视区域
- 离开视口的图片请求被中断
- 预加载缓冲区确保即将进入视口的海报提前加载
- WebP 格式减少解码时间

---

## 六、兼容性保障

### 6.1 Jellyfin / Emby 兼容性

- 统一的 `getPosterUrl` 函数支持两种服务器类型
- 自定义协议处理器分别处理 `jellyfin-image://` 和 `emby-image://`
- Token 传递方式：Jellyfin 使用 `api_key` 参数，Emby 使用 `X-Emby-Token` 请求头

### 6.2 原有功能保障

以下功能不受本次重构影响：
- ✅ 播放功能（Player.tsx 未修改）
- ✅ 弹幕系统（danmakuEngine.ts 未修改）
- ✅ 竖屏播放器（未修改）
- ✅ 服务器登录流程（未修改）
- ✅ 最近入库影片展示（逻辑不变，仅优化 URL 构建）
- ✅ 豆瓣刮削功能（未修改）

---

## 七、性能预期

| 指标 | 重构前 | 重构后 | 改善幅度 |
|------|-------|-------|---------|
| DOM 节点数（500 条影片） | ~500 | ~20 | 96% |
| 动画实例数 | ~500（framer-motion） | 0（CSS） | 100% |
| 主进程阻塞 | 有（同步 fs） | 无（异步 fs） | 100% |
| 图片大小 | PNG（较大） | WebP（30-50% 小） | 30-50% |
| 日志 I/O | 每条请求打印 | 仅错误时打印 | 显著减少 |

---

## 八、结论

本次重构采用了与 Jellyfin/Emby 官方客户端及网易爆米花等成熟产品一致的核心技术方案：

1. **虚拟滚动**：解决 DOM 数量爆炸问题（最高优先级）
2. **多级缓存**：确保快速访问和离线可用性
3. **WebP 格式**：减少网络传输和内存占用
4. **CSS 动画**：释放主线程 CPU 资源
5. **异步操作**：避免阻塞主进程

通过架构级别的彻底改造，预计可实现：
- 首次加载流畅度提升 5-10 倍
- 内存占用降低 80% 以上
- 从播放页返回首页毫秒级显示