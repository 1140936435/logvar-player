# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-09-07

### Bug Fixes

#### 全屏无法退出修复（透明窗口 + setFullScreen）
- **根因**：Electron Windows 上透明窗口被强制去掉 WS_THICKFRAME，
  `setFullScreen` 走 SetBounds 模拟路径（进入保存 bounds 并铺满显示器、退出恢复），
  但 widget 的原生全屏状态从未置位 —— `isFullScreen()` 恒返回 false。
  toggle 里 `!isFullScreen()` 永远算出 true，第二次点击仍执行 `setFullScreen(true)`，
  且 Electron 内部 restore_bounds 被覆盖成全屏尺寸，表现为"无法退出全屏"
- 修复：主进程自持 `windowFullscreenState` 布尔量作为状态真源，
  enter/leave-full-screen 事件兜底同步；不再信任 `isFullScreen()`
- 补齐：透明窗口的 SetBounds 模拟路径不会隐藏任务栏，进入全屏时以
  screen-saver 级置顶盖住任务栏，退出时还原应用自身置顶设置

#### mpv 画布引擎黑屏（网络流）根因修复
- **根因**：mpv / libmpv（ffmpeg）读取 `http_proxy` 等环境变量，系统代理开启时
  内网 / Tailscale 地址（如 Jellyfin 100.x.x.x）的媒体流请求被代理劫持 →
  `loading failed` → 播放黑屏（本地文件不走网络，故一切正常，难以察觉）
- 修复：主进程启动时清除代理环境变量（在任何子进程 spawn 前）；preload 侧
  mpv 实例创建前双保险再清一次；媒体服务器均在局域网/Tailscale，直连为正确行为，
  Chromium 自身走 Windows 系统代理设置不受影响
- 同时修复旧 mpv.exe 打孔引擎在代理环境下的相同隐患（子进程继承主进程 env）
- 诊断能力：mpv-render 增加首帧渲染 / render 失败 / 播放失败（end-file error）日志，
  MpvCanvasView 拉帧异常不再静默吞掉，Player 引擎初始化打印引擎决策日志
- 新增 scripts/e2e-mpv-canvas/ 端到端诊断套件（真实 Electron + 真实 preload，
  覆盖 contextBridge 序列化 / 硬解 / HTTP 流 / 透明窗口 WebGL 合成各环节）

## [Unreleased] - 2026-09-06

### Major Changes

#### 播放架构方案 C：libmpv 画布渲染引擎（mpv-canvas）
- 新增第三条播放链路：preload 经 koffi 直驱 libmpv-2.dll（vo=libmpv + SW render API），
  帧渲染进预分配缓冲，渲染端 WebGL canvas 上屏 —— 视频成为普通 DOM 层
- 根治「播放时整页透明」：画布引擎不需要窗口透明打孔，控件/弹幕/字幕天然悬浮覆盖
- 根治「假全屏」：全屏切换改为原生 setFullScreen（真全屏），废弃 setBounds + screen-saver
  置顶 hack；全屏状态以 enter/leave-full-screen 事件为唯一真源并转发渲染端
- 引擎降级链：mpv-canvas → mpv（打孔，保留为高性能回退）→ 内置 HTML5；
  设置页新增「mpv 画布」选项
- 截图：画布引擎取当前帧（rgb0→BGRA）经主进程 nativeImage 存 PNG
- 新增 scripts/smoke-mpv-sw.cjs 冒烟测试（纯 Node 验证 koffi→libmpv→SW 渲染全链路）

### Technical Improvements
- 播放器控制面抽象：api.mpv（打孔）与 api.mpvRender（画布）方法名对齐，
  Player 页经 mpvCtl() 按引擎无差别分发
- SW 路径硬解使用 copy-back 变体（d3d11va-copy/nvdec-copy 等）
- electron-builder extraResources 增加 libmpv-2.dll 打包

### 已知取舍（v1）
- SW 渲染为 CPU 路径：1080p24/30 轻松，4K60 建议用「mpv 兼容」打孔引擎
- HDR 色调映射在 SW 路径下能力有限
- 后续可平滑升级为原生 N-API addon（GL render API），渲染端零改动

## [1.2.0] - 2026-07-23

### Major Changes

#### 海报加载架构重构
- 实现虚拟滚动网格组件，将 DOM 节点数量从数百个降至约 20 个
- 引入 @tanstack/react-virtual 实现长列表虚拟化
- 创建统一的海报 URL 构建工具，全面支持 WebP 图片格式（减少 30-50% 图片大小）
- 重构海报缓存服务，将所有同步 fs 操作转换为异步 fs.promises 操作，消除主进程阻塞
- 优化 LazyImage 组件，增强可视区域外资源释放和请求中断机制
- 移除协议处理器中的 verbose console.log，减少性能开销

#### 竖屏播放体验优化
- 实现视频宽高比智能识别系统，自动检测竖屏视频（9:16）
- 双模式显示系统：
  - 默认模式【完整全画面显示】：使用 object-fit: contain，确保画面完整无裁切
  - 可选模式【等比填充全屏】：使用 object-fit: cover，通过裁切消除黑边
- 竖屏黑边模糊背景填充：使用 Canvas 实时捕获视频帧作为模糊背景，弱化视觉割裂感
- 竖屏专属控制栏重构：增大按钮尺寸（播放按钮从 22px 增至 40px）、优化布局间距、添加显示模式切换按钮
- 智能自动隐藏/悬浮呼出功能，背景采用半透明磨砂效果

### Minor Changes

#### Bug Fixes
- 修复 Jellyfin API 400 错误：实现 /Users/Me 请求失败时回退到 /Users 接口获取用户 ID
- 修复 LazyImage 组件未定义错误：在 Home.tsx 中添加缺失的导入

#### UI Improvements
- MediaCard 组件使用 CSS 过渡代替 framer-motion spring 动画，释放主线程 CPU 资源
- 移除协议处理器中的 verbose console.log，减少性能开销

### Technical Improvements
- 统一海报 URL 构建逻辑，消除代码重复
- 缓存 key 包含 imageTag 参数，天然支持缓存失效
- 并发请求限流控制在 6 个以内
- 项目清理：移除废弃文件、旧版图标生成脚本、过时文档

## [1.1.0] - 2026-07-23

- 弹幕引擎重构 + 性能优化 + 全屏黑条修复
- 最近入库海报栏 + 统一图标 + 顶部导航栏按钮迁移 + 首页板块顺序调整
- 集成海报缓存到图片协议
- 添加 HomeStoreProvider 用于首页数据持久化
- 安全加固 + 字幕持久化 + ErrorBoundary + 清理无用依赖

## [1.0.0] - 2026-07-21

### Initial Release

- 基础播放器功能
- Jellyfin/Emby 服务器连接
- 弹幕系统
- 字幕支持
- 本地文件播放
- 最近播放记录