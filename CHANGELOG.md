# Changelog

All notable changes to this project will be documented in this file.

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