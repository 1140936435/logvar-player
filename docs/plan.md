# LogVar Media Player 实施计划

> **目标：** 构建一款基于 Electron + mpv 的桌面媒体播放器，接入 Jellyfin + 本地文件 + 自建弹幕 API

**架构：** Electron 主进程管理 mpv 子进程（通过 --wid 嵌入），React 前端负责 UI 和弹幕 Canvas 渲染，IPC 通信连接两者。

**技术栈：** Electron 28+ / React 19 / TypeScript / TailwindCSS / shadcn/ui / Vite / mpv / Zustand

**设计文档：** `/var/minis/shared/media-player/docs/spec.md`

---

## Task 1: 项目脚手架搭建

**目标：** 创建 Electron + React + TypeScript + Vite 项目基础结构

- [ ] **Step 1: 创建项目目录**

```bash
mkdir -p /var/minis/shared/media-player
cd /var/minis/shared/media-player
```

- [ ] **Step 2: 初始化 package.json**

创建 `package.json`，包含 Electron、React、Vite、TypeScript 等依赖。使用 electron-vite 方案。

- [ ] **Step 3: 创建 Vite 配置**

创建 `electron.vite.config.ts`，配置 main、preload、renderer 三个构建入口。

- [ ] **Step 4: 创建 TypeScript 配置**

创建 `tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`。

- [ ] **Step 5: 创建 Electron 主进程入口**

创建 `src/main/index.ts`，基础 Electron 窗口创建。

- [ ] **Step 6: 创建 Preload 脚本**

创建 `src/preload/index.ts`，通过 contextBridge 暴露安全 API。

- [ ] **Step 7: 创建 React 渲染进程入口**

创建 `src/renderer/src/main.tsx`、`App.tsx`、`index.html`。

- [ ] **Step 8: 验证项目能启动**

```bash
npm install
npm run dev
```
预期：Electron 窗口弹出，显示空白 React 页面。

- [ ] **Step 9: 提交**

```bash
git init && git add -A && git commit -m "feat: project scaffold with electron + react + vite"
```

---

## Task 2: UI 框架 + 主题

**目标：** 安装 shadcn/ui，配置深色主题，创建基础布局

**文件：**
- 修改: `src/renderer/src/App.tsx`
- 创建: `src/renderer/src/components/ui/` (shadcn 组件)
- 创建: `src/renderer/src/styles/globals.css`

- [ ] **Step 1: 安装 TailwindCSS + shadcn/ui**

```bash
npm install -D tailwindcss @tailwindcss/vite
npx shadcn@latest init
```

- [ ] **Step 2: 配置深色主题**

在 `globals.css` 中设置 CSS 变量，深色主题为默认。

- [ ] **Step 3: 创建应用布局**

创建 `App.tsx` 基础布局：顶部导航栏 + 内容区域。

- [ ] **Step 4: 创建页面路由**

安装 `react-router-dom`，配置 Home / Player / Settings 三个路由。

- [ ] **Step 5: 验证**

```bash
npm run dev
```
预期：深色主题的应用窗口，顶部导航可切换页面。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: UI framework with dark theme and routing"
```

---

## Task 3: mpv 播放器集成

**目标：** 在 Electron 中嵌入 mpv 播放窗口，实现基础播放控制

**文件：**
- 创建: `src/main/services/mpv.ts` — mpv 进程管理
- 创建: `src/main/ipc/mpv.ipc.ts` — IPC 处理
- 修改: `src/main/index.ts` — 注册 IPC
- 修改: `src/preload/index.ts` — 暴露 mpv API
- 创建: `src/renderer/src/components/Player/MpvPlayer.tsx` — 播放器组件
- 创建: `src/renderer/src/stores/playerStore.ts` — 播放状态

- [ ] **Step 1: 创建 MpvController 服务**

```typescript
// src/main/services/mpv.ts
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import path from 'path';

export class MpvController {
  private process: ChildProcess | null = null;
  private window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  play(filePath: string) {
    this.stop();
    const mpvPath = this.getMpvPath();
    this.process = spawn(mpvPath, [
      '--wid=' + this.window.getNativeWindowHandle().readInt32LE(),
      '--no-terminal',
      '--hwdec=auto-safe',
      '--vo=gpu-next',
      '--input-ipc-server=/tmp/mpv-socket',
      filePath
    ]);
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private getMpvPath(): string {
    // Windows: bundled mpv or system PATH
    return process.platform === 'win32'
      ? path.join(process.resourcesPath, 'mpv', 'mpv.exe')
      : 'mpv';
  }
}
```

- [ ] **Step 2: 创建 IPC 通道**

注册 `mpv:play`、`mpv:stop`、`mpv:pause`、`mpv:seek`、`mpv:set-volume` 等 IPC 事件。

- [ ] **Step 3: 创建 React 播放器组件**

`MpvPlayer.tsx`：接收文件路径，通过 IPC 调用 mpv 播放，显示播放控制 UI。

- [ ] **Step 4: 实现播放控制 UI**

进度条、音量、暂停/播放按钮、全屏切换、倍速选择。

- [ ] **Step 5: 验证本地文件播放**

手动放一个 .mp4 文件到 workspace，通过播放器打开播放。
预期：视频正常播放，控制条可用。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: mpv player integration with basic controls"
```

---

## Task 4: 弹幕系统

**目标：** 对接 LogVar 弹幕 API，实现 Canvas 弹幕渲染和控制

**文件：**
- 创建: `src/main/services/danmaku.ts` — 弹幕 API 调用
- 创建: `src/main/ipc/danmaku.ipc.ts` — IPC
- 创建: `src/renderer/src/components/Danmaku/DanmakuOverlay.tsx` — Canvas 弹幕层
- 创建: `src/renderer/src/components/Danmaku/DanmakuSettings.tsx` — 弹幕控制面板
- 创建: `src/renderer/src/stores/danmakuStore.ts` — 弹幕状态

- [ ] **Step 1: 创建 DanmakuService**

封装 LogVar API 调用：searchAnime、searchEpisodes、match、getComment、getSegmentComment。

```typescript
const API_BASE = 'http://aning.asia:9321';

export async function matchDanmaku(title: string) {
  const res = await fetch(`${API_BASE}/api/v2/match?title=${encodeURIComponent(title)}`);
  return res.json();
}

export async function getComments(commentId: string) {
  const res = await fetch(`${API_BASE}/api/v2/comment/${commentId}`);
  return res.json();
}
```

- [ ] **Step 2: 创建弹幕 Canvas 渲染器**

实现弹幕渲染引擎：
- 弹幕数据解析（时间戳、内容、颜色、类型）
- 滚动弹幕：从右到左移动
- 顶部弹幕：固定在顶部
- 底部弹幕：固定在底部
- 碰撞检测：避免弹幕重叠

- [ ] **Step 3: 实现弹幕控制面板**

显示区域（10%~100%）、文字大小（12~36px）、滚动速度（慢/中/快）、透明度、开关。

- [ ] **Step 4: 实现文件名清洗**

```typescript
function cleanFileName(filename: string): string {
  return filename
    .replace(/\[.*?\]/g, '')      // 去掉 [xxx] 标签
    .replace(/1080p|720p|4k|2160p/gi, '')  // 去掉分辨率
    .replace(/x264|x265|hevc|aac|flac/gi, '')  // 去掉编码
    .replace(/\.(mp4|mkv|avi|flv|rmvb)$/i, '')  // 去掉扩展名
    .trim();
}
```

- [ ] **Step 5: 验证弹幕显示**

播放本地视频，确认弹幕自动匹配并显示。
预期：弹幕从右到左滚动，控制面板可调节参数。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: danmaku system with LogVar API integration"
```

---

## Task 5: Jellyfin 媒体库

**目标：** 接入 Jellyfin API，实现媒体库浏览、搜索、详情、播放

**文件：**
- 创建: `src/main/services/jellyfin.ts` — Jellyfin API 封装
- 创建: `src/main/ipc/jellyfin.ipc.ts` — IPC
- 创建: `src/renderer/src/pages/Home.tsx` — 媒体库首页
- 创建: `src/renderer/src/components/MediaLib/MediaCard.tsx` — 媒体卡片
- 创建: `src/renderer/src/components/MediaLib/MediaDetail.tsx` — 详情页
- 创建: `src/renderer/src/components/MediaLib/SearchBar.tsx` — 搜索栏
- 创建: `src/renderer/src/stores/mediaStore.ts` — 媒体状态

- [ ] **Step 1: 创建 JellyfinService**

封装 Jellyfin API：
- 认证（Token 方式）
- 获取媒体库列表
- 获取媒体项（电影/剧集）
- 搜索
- 获取播放流 URL
- 同步播放进度

- [ ] **Step 2: 创建媒体库首页**

显示"继续观看"、"电影"、"剧集"等分类，横向滚动卡片。

- [ ] **Step 3: 创建媒体详情页**

海报、标题、简介、演职人员、评分、播放按钮、收藏按钮。

- [ ] **Step 4: 实现搜索功能**

顶部搜索栏，输入关键词实时搜索。

- [ ] **Step 5: 实现播放进度同步**

播放时定期（每 10 秒）向 Jellyfin 上报进度，播放结束时上报完成。

- [ ] **Step 6: 验证**

连接 Jellyfin 服务器，浏览媒体库，播放一个视频。
预期：能正常浏览、搜索、播放，进度同步到服务器。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: Jellyfin media library integration"
```

---

## Task 6: 本地文件管理

**目标：** 实现本地文件打开、文件夹扫描、播放历史

**文件：**
- 创建: `src/main/services/file.ts` — 文件服务
- 创建: `src/main/ipc/file.ipc.ts` — IPC
- 创建: `src/renderer/src/stores/historyStore.ts` — 播放历史

- [ ] **Step 1: 创建 FileService**

- 打开文件对话框（支持视频格式过滤）
- 打开文件夹对话框（扫描视频文件）
- 读取文件元数据

- [ ] **Step 2: 实现播放历史**

用 electron-store 保存播放历史：文件路径、播放时间、最后播放时间。

- [ ] **Step 3: 首页添加本地文件入口**

"打开文件"和"打开文件夹"按钮。

- [ ] **Step 4: 验证**

打开本地文件播放，关闭后重新打开，确认历史记录存在。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: local file management and playback history"
```

---

## Task 7: 设置页面

**目标：** 实现设置页面，保存用户配置

**文件：**
- 创建: `src/renderer/src/pages/Settings.tsx`
- 创建: `src/main/store.ts` — electron-store 配置
- 创建: `src/renderer/src/stores/settingsStore.ts`

- [ ] **Step 1: 创建 SettingsStore**

用 electron-store 持久化配置：Jellyfin 地址/Token、弹幕 API 地址、弹幕默认设置、播放器设置。

- [ ] **Step 2: 创建设置页面 UI**

分组表单：Jellyfin 配置、弹幕配置、播放器配置、弹幕默认参数。

- [ ] **Step 3: 验证**

修改设置后重启应用，确认设置保留。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: settings page with persistent config"
```

---

## Task 8: UI 美化 + 打包

**目标：** 完善 UI 细节，配置 electron-builder 打包 Windows 安装包

- [ ] **Step 1: 完善 UI 细节**

- 播放页面毛玻璃效果
- 媒体卡片 hover 动画
- 加载状态 skeleton
- 错误提示 toast

- [ ] **Step 2: 配置 electron-builder**

创建 `electron-builder.yml`，配置 Windows NSIS 安装包，内置 mpv.exe。

- [ ] **Step 3: 测试打包**

```bash
npm run build
```
预期：生成 Windows 安装包，双击安装后正常运行。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: UI polish and Windows installer"
```

---

## 依赖关系

```
Task 1 (脚手架) → Task 2 (UI框架) → Task 3 (mpv集成) → Task 4 (弹幕)
                                                   ↘ Task 5 (Jellyfin)
                                                   ↘ Task 6 (本地文件)
                                              Task 7 (设置)
                                              Task 8 (美化+打包)
```

**关键路径：** Task 1 → 2 → 3 → 4 → 8

**可并行：** Task 5、6、7 在 Task 3 完成后可并行开发
