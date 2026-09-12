# 废弃文件清单及原因说明

## 清理日期：2026-07-23
## 版本：1.2 发布前清理

---

### 一、临时文件

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| tools/.make-transparent-icons.mjs.83196.1784191754872.120c56bf.tmp | Node.js 脚本执行临时文件，脚本已完成执行，无保留价值 | 删除 |

### 二、未被引用的测试脚本

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| test-thumbnail.js | 缩略图生成功能测试脚本，未被 package.json 或任何源码引用，仅用于开发调试 | 删除 |

### 三、旧版图标生成脚本（已废弃，当前使用 scripts/make-transparent-icons.mjs）

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| tools/generate-bmp-ico.js | 旧版 BMP 格式 ICO 生成脚本，当前使用 PNG-in-ICO 格式 | 删除 |
| tools/generate-ico.js | 旧版 ICO 生成脚本，功能已被 scripts/make-transparent-icons.mjs 替代 | 删除 |
| tools/generate-icon.js | 旧版图标生成脚本，功能已被 scripts/make-transparent-icons.mjs 替代 | 删除 |
| tools/generate-icons.js | 旧版图标生成脚本，功能已被 scripts/make-transparent-icons.mjs 替代 | 删除 |
| tools/generate-simple-ico.js | 旧版简易 ICO 生成脚本，功能已被 scripts/make-transparent-icons.mjs 替代 | 删除 |
| tools/glass-icon-gen.js | 旧版毛玻璃效果图标生成脚本，当前透明化处理逻辑在 scripts/make-transparent-icons.mjs 中 | 删除 |

### 四、调试辅助脚本

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| tools/check_danmaku.ps1 | 弹幕功能调试脚本，开发阶段使用，非生产必需 | 删除 |
| tools/fix_danmaku.ps1 | 弹幕修复脚本，开发阶段使用，非生产必需 | 删除 |
| tools/dwm-helper.cs | DWM 辅助工具 C# 源代码，已编译为 dwm-helper.exe，源码非运行必需 | 删除 |

### 五、旧版图标资源目录（当前使用 assets/icon/ 和 build/）

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| tools/icons/ | 旧版图标资源目录，当前图标资源来自 assets/icon/，并通过 scripts/make-transparent-icons.mjs 生成到 build/ | 删除 |
| tools/build/ | 旧版构建输出目录，当前构建输出到项目根目录 build/ | 删除 |

### 六、IDE 配置目录（非项目必需）

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| .trae/ | Trae IDE 本地配置目录，包含 specs 和规划文档，非源码必需，不应提交到版本控制 | 删除 |

### 七、旧版规划文档

| 文件路径 | 废弃原因 | 处理方式 |
|---------|---------|---------|
| docs/superpowers/plans/ | 旧版功能规划文档，已过时 | 删除 |
| docs/superpowers/specs/ | 旧版技术规格文档，已过时 | 删除 |
| docs/architecture-convergence.md | 旧版架构收敛文档，已过时 | 删除 |
| docs/plan.md | 旧版项目计划文档，已过时 | 删除 |
| docs/spec.md | 旧版技术规格文档，已过时 | 删除 |
| docs/需求分析报告.md | 旧版需求分析报告，已过时 | 删除 |
| docs/需求分析报告_更新.md | 旧版需求分析报告更新版，已过时 | 删除 |

---

### 保留文件说明

以下文件已确认被项目引用，严禁删除：

**核心业务代码：**
- src/main/index.ts - 主进程入口
- src/main/mpv-controller.ts - MPV 播放器控制
- src/main/services/poster-cache.ts - 海报缓存服务
- src/renderer/src/components/LazyImage.tsx - 懒加载图片组件
- src/renderer/src/components/MediaCard.tsx - 媒体卡片组件
- src/renderer/src/components/VirtualMediaGrid.tsx - 虚拟媒体网格
- src/renderer/src/pages/Home.tsx - 首页
- src/renderer/src/pages/Player.tsx - 播放器页面
- src/renderer/src/utils/posterUrl.ts - 海报 URL 生成
- src/shared/types.ts - 共享类型定义

**构建必需脚本：**
- scripts/make-transparent-icons.mjs - 图标透明化处理（prebuild 钩子）
- scripts/build-win.mjs - Windows 构建脚本
- scripts/clean-build.mjs - 清理构建脚本
- scripts/generate-icons.mjs - 图标生成脚本
- scripts/audit-icon-transparency.mjs - 图标透明度审计
- scripts/prepare-transparent-icons.ps1 - PowerShell 图标预处理

**资源文件：**
- assets/icon/ - 原始图标资源
- build/ - 构建输出图标（由 scripts/make-transparent-icons.mjs 生成）
- resources/mpv.zip - MPV 播放器资源

**依赖配置：**
- package.json - 项目依赖配置
- electron-builder.yml - Electron Builder 配置
- electron.vite.config.cts - Electron Vite 配置
- tsconfig*.json - TypeScript 配置

**必要工具：**
- tools/dwm-helper.exe - DWM 辅助工具，构建时复制到 out/tools/
