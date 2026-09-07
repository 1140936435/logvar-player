# logvar-player - 设计文档

**项目名称**：logvar-player  
**日期**：2026-06-10  
**用途**：个人自用  
**平台**：Windows 优先  

---

## 1. 项目概述

一款基于 Electron + mpv 的桌面媒体播放器，统一接入 Jellyfin 媒体库和本地文件，叠加自建 LogVar 弹幕 API（dandanplay 兼容），提供类 B 站的弹幕控制体验。

### 目标用户
- 个人用户自用

### 核心价值
1. **统一入口**：Jellyfin 流媒体 + 本地文件，一个播放器搞定
2. **弹幕加持**：自建弹幕 API，本地视频也能有弹幕
3. **高画质**：mpv 内核，HDR + 硬件解码

---

## 2. 功能模块

### 2.1 Jellyfin 媒体库

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 服务器连接 | P0 | 输入 Jellyfin 地址 + API Token，保存到本地 |
| 媒体库浏览 | P0 | 电影/剧集/综艺/动漫分类展示 |
| 搜索 | P0 | 按名称搜索媒体 |
| 详情页 | P0 | 海报、简介、演职人员、评分 |
| 收藏 | P1 | 收藏/取消收藏 |
| 播放进度同步 | P0 | 同步 Jellyfin 服务器的观看进度 |
| 断点续播 | P0 | 从上次停止位置继续播放 |
| 多库支持 | P1 | 同时连接多个 Jellyfin 库 |

**验收标准：**
- Given 用户输入正确的 Jellyfin 地址和 Token，When 点击连接，Then 成功加载媒体库列表
- Given 正在播放 Jellyfin 视频，When 暂停超过 3 秒，Then 自动同步进度到服务器
- Given 之前看过某部电影一半，When 再次点击播放，Then 弹出"从上次位置继续"提示

### 2.2 本地文件播放

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 打开文件 | P0 | 支持 .mp4 .mkv .avi .flv .rmvb .ts .m2ts |
| 打开文件夹 | P1 | 扫描整个文件夹，列出所有视频 |
| 最近播放 | P1 | 本地播放历史记录（保存到本地） |

**验收标准：**
- Given 用户拖拽 .mkv 文件到窗口，When 释放，Then 自动开始播放
- Given 用户点击"打开文件夹"，When 选择文件夹，Then 列出所有视频文件并可逐个播放

### 2.3 播放器

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 基础控制 | P0 | 播放/暂停/进度条/音量/倍速（0.5x~3x） |
| 硬件解码 | P0 | 自动检测 GPU，支持 DXVA2/D3D11VA |
| HDR 支持 | P0 | HDR 视频自动/手动切换色调映射 |
| 字幕支持 | P0 | 内嵌字幕 + 外挂 .srt/.ass/.ssa |
| 字幕轨道选择 | P1 | 多字幕轨道切换 |
| 全屏模式 | P0 | 独占全屏 + 无边框窗口 |
| 快捷键 | P0 | 空格=暂停, ←→=快进快退, ↑↓=音量, F=全屏 |
| 画中画 | P2 | 小窗口置顶播放 |

**验收标准：**
- Given 播放 4K HDR 视频，When 硬件解码可用，Then CPU 占用 < 10%
- Given 播放中按空格，Then 暂停/继续切换
- Given 播放中按 F，Then 进入/退出全屏

### 2.4 弹幕系统

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 弹幕自动匹配 | P0 | 根据文件名/标题调用 LogVar API 匹配弹幕 |
| 弹幕渲染 | P0 | Canvas 高性能渲染，支持滚动/顶部/底部三种类型 |
| 显示区域控制 | P0 | 可调 10%~100% 屏幕高度区域 |
| 文字大小控制 | P0 | 可调 12px~36px |
| 滚动速度控制 | P0 | 可调 慢/中/快 三档 |
| 透明度控制 | P1 | 可调 20%~100% |
| 弹幕开关 | P0 | 一键开启/关闭弹幕 |
| 弹幕颜色 | P1 | 跟随原始颜色 或 统一白色 |
| 弹幕密度控制 | P1 | 同屏最大弹幕数量限制 |
| 手动输入弹幕 URL | P0 | 支持手动输入第三方弹幕 API 地址 |

**LogVar API 端点：**
```
GET /api/v2/search/anime?keyword=xxx     # 搜索动漫
GET /api/v2/search/episodes?animeId=xxx  # 搜索剧集
GET /api/v2/match?title=xxx              # 匹配弹幕
GET /api/v2/bangumi/:animeId             # 番剧详情
GET /api/v2/comment/:commentId           # 获取弹幕
GET /api/v2/segmentcomment               # 分片弹幕
```

**弹幕 API 配置：**
- 默认地址：`http://aning.asia:9321`
- 支持手动修改（可替换为其他 dandanplay 兼容 API）

**验收标准：**
- Given 播放一个本地视频，When 文件名包含番剧名称，Then 自动匹配弹幕并在 2 秒内显示
- Given 弹幕显示区域设为 50%，Then 弹幕只出现在屏幕上半部分
- Given 用户关闭弹幕，Then 所有弹幕立即消失，不消耗渲染资源

### 2.5 设置

| 功能 | 优先级 | 说明 |
|------|--------|------|
| Jellyfin 配置 | P0 | 地址、Token、默认库 |
| 弹幕 API 配置 | P0 | API 地址（预填默认值） |
| 播放器配置 | P1 | 默认硬件解码开关、HDR 模式 |
| 弹幕默认设置 | P0 | 默认大小/速度/区域/透明度 |
| 主题 | P1 | 深色/浅色/跟随系统 |
| 快捷键自定义 | P2 | 可修改快捷键绑定 |

---

## 3. 架构设计

### 3.1 技术栈

| 组件 | 选择 | 版本要求 |
|------|------|---------|
| 框架 | Electron | ≥ 28 |
| 前端 | React + TypeScript | React 18+ |
| UI 库 | TailwindCSS + shadcn/ui | - |
| 状态管理 | Zustand | - |
| 播放器 | mpv via node-mpv 或手动 spawn | mpv ≥ 0.37 |
| 弹幕渲染 | Canvas 2D | - |
| 构建工具 | Vite + electron-builder | - |

### 3.2 进程架构

```
┌─────────────────────────────────────────────┐
│              Electron 主窗口                  │
│  ┌───────────────────────────────────────┐  │
│  │         Renderer 进程                  │  │
│  │  React UI + 弹幕 Canvas               │  │
│  └───────────────┬───────────────────────┘  │
│                  │ IPC (contextBridge)        │
│  ┌───────────────┴───────────────────────┐  │
│  │         Main 进程                      │  │
│  │  ├─ JellyfinService (API 调用)        │  │
│  │  ├─ DanmakuService (弹幕 API 调用)    │  │
│  │  ├─ MpvController (mpv 进程管理)      │  │
│  │  ├─ FileService (本地文件扫描)        │  │
│  │  └─ Store (配置持久化)                │  │
│  └───────────────┬───────────────────────┘  │
│                  │ spawn + --wid              │
│  ┌───────────────┴───────────────────────┐  │
│  │         mpv 子进程                     │  │
│  │  vo=gpu-next / hwdec=auto-safe        │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 3.3 目录结构

```
logvar-player/
├── src/
│   ├── renderer/              # React 前端
│   │   ├── components/
│   │   │   ├── ui/            # shadcn/ui 组件
│   │   │   ├── Player/        # 播放器组件
│   │   │   ├── MediaLib/      # 媒体库组件
│   │   │   ├── Danmaku/       # 弹幕渲染组件
│   │   │   └── Settings/      # 设置页面
│   │   ├── pages/
│   │   │   ├── Home.tsx       # 首页（媒体库）
│   │   │   ├── Player.tsx     # 播放页面
│   │   │   └── Settings.tsx   # 设置页面
│   │   ├── stores/
│   │   │   ├── playerStore.ts
│   │   │   ├── mediaStore.ts
│   │   │   └── settingsStore.ts
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── App.tsx
│   ├── main/                  # Electron 主进程
│   │   ├── services/
│   │   │   ├── jellyfin.ts    # Jellyfin API 封装
│   │   │   ├── danmaku.ts     # 弹幕 API 封装
│   │   │   └── mpv.ts         # mpv 控制器
│   │   ├── ipc/
│   │   │   ├── jellyfin.ipc.ts
│   │   │   ├── danmaku.ipc.ts
│   │   │   └── mpv.ipc.ts
│   │   ├── store.ts           # electron-store 配置
│   │   └── index.ts           # 主进程入口
│   ├── preload/
│   │   └── index.ts           # contextBridge 暴露 API
│   └── shared/
│       └── types.ts           # 共享类型定义
├── electron.vite.config.cts
├── electron-builder.yml
├── package.json
└── tsconfig.json
```

### 3.4 数据流

**Jellyfin 播放流程：**
```
用户点击媒体 → Main 进程调用 Jellyfin API 获取播放信息
→ 获取流媒体 URL → spawn mpv 播放 URL
→ 同时调用弹幕 API 匹配弹幕 → 弹幕数据发送到 Renderer
→ Renderer 在 Canvas 上渲染弹幕 → 同步 mpv 播放进度
```

**本地文件播放流程：**
```
用户打开文件 → Main 进程获取文件路径
→ spawn mpv 播放本地文件 → 用文件名调用弹幕 API 匹配
→ 弹幕数据发送到 Renderer → 渲染弹幕
```

---

## 4. UI 设计规范

### 4.1 整体风格
- **深色主题为主**，浅色可选
- **毛玻璃效果**：播放控制栏、侧边栏使用 backdrop-blur
- **圆角卡片**：媒体卡片使用 rounded-xl
- **渐变背景**：播放页面使用媒体封面的模糊渐变

### 4.2 页面布局

**首页（媒体库）：**
```
┌──────────────────────────────────────────┐
│  🎬 logvar-player    🔍搜索    ⚙设置    │
├──────────────────────────────────────────┤
│  继续观看                                │
│  [卡片] [卡片] [卡片] [卡片]             │
│                                          │
│  电影                                    │
│  [卡片] [卡片] [卡片] [卡片]             │
│                                          │
│  剧集                                    │
│  [卡片] [卡片] [卡片] [卡片]             │
└──────────────────────────────────────────┘
```

**播放页面：**
```
┌──────────────────────────────────────────┐
│  ← 返回        标题          全屏 ⛶     │
│                                          │
│          ╔══════════════════╗            │
│          ║                  ║            │
│          ║     mpv 播放     ║  ← 弹幕层  │
│          ║                  ║   (Canvas) │
│          ╚══════════════════╝            │
│                                          │
│  ▶ ──●─────────────────── 1:23:45       │
│  🔊━━━━━━●━━━━  💬弹幕  ⚙设置  📺字幕  │
└──────────────────────────────────────────┘
```

---

## 5. 外部依赖

### 5.1 mpv 播放器
- 用户需要单独安装 mpv 或应用内置
- 下载地址：https://sourceforge.net/projects/mpv-player-windows/
- 或通过 scoop/winget 安装

### 5.2 LogVar 弹幕 API
- 默认地址：`http://aning.asia:9321`
- 兼容弹弹play 接口规范
- 支持爱优腾芒哔咪人韩巴狐乐西弹幕源

### 5.3 Jellyfin 服务器
- 用户自建 Jellyfin 服务器
- 使用 Jellyfin API Token 认证

---

## 6. 开发计划（预估）

| 阶段 | 内容 | 预估时间 |
|------|------|---------|
| Phase 1 | 项目脚手架 + Electron 基础 + mpv 嵌入 | 1-2 天 |
| Phase 2 | 本地文件播放 + 基础播放控制 | 1 天 |
| Phase 3 | 弹幕系统（API 对接 + Canvas 渲染） | 2 天 |
| Phase 4 | Jellyfin 媒体库完整接入 | 2 天 |
| Phase 5 | UI 美化 + 设置页面 + 打包 | 1-2 天 |
| **总计** | | **7-9 天** |

---

## 7. 设计补丁（自审修正）

### 7.1 mpv 内置打包
- 应用打包时内置 mpv.exe（约 80MB），用户无需单独安装
- 通过 electron-builder extraResources 打包 mpv 二进制

### 7.2 配置加密
- electron-store 默认明文存储，个人自用可接受
- Token 加密可后续迭代（使用 safeStorage API）

### 7.3 文件名清洗策略
- 本地文件名清洗正则：去掉 `[xxx]` 标签、分辨率标记（1080p/4K）、编码标记（x264/x265/HEVC）
- 清洗后取主要标题作为关键词调用弹幕 API
- 例：`[Nekomoe kissaten][孤独摇滚][01][1080p].mkv` → `孤独摇滚 01`

### 7.4 弹幕 API 失败处理
- API 超时（3秒）或失败时：静默跳过，播放器底部显示"未匹配到弹幕"
- 支持手动重新搜索/输入弹幕 ID

### 7.5 mpv 进程监控
- 监听 mpv 进程退出事件
- 异常退出时弹出提示，支持重新播放
- 正常播放结束（EOF）时同步最终进度到 Jellyfin

---

## 8. 风险与待确认

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| mpv 嵌入 Electron 窗口句柄兼容性 | 高 | 使用 --wid 参数，Windows 上成熟方案 |
| 弹幕渲染性能 | 中 | Canvas 2D，限制同屏弹幕数量 |
| Jellyfin API 版本兼容 | 低 | 使用稳定 API 版本 |
| 硬件解码在不同 GPU 上的差异 | 中 | 提供软解回退选项 |
