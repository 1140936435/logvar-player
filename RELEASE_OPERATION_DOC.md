# mplay 1.2 版本发布操作文档

## 一、打包命令详情

### 1.1 环境准备
```powershell
# 确保项目依赖已安装
npm install
```

### 1.2 类型检查
```powershell
npm run typecheck
# 输出: tsc --noEmit (无错误通过)
```

### 1.3 项目构建
```powershell
npm run build
# 输出: 图标透明化处理完成 + electron-vite 构建成功
```

### 1.4 安装包生成（Windows）
由于Windows文件锁定问题，需在临时目录构建：
```powershell
# 创建临时目录
New-Item -ItemType Directory -Path "C:\Temp\logvar-build" -Force

# 复制项目文件（排除node_modules、.git等）
robocopy "G:\dev\logvar-player" "C:\Temp\logvar-build" /MIR /XD node_modules .git dist out .generated* .venv

# 更新版本号
# 编辑 C:\Temp\logvar-build\package.json: "version": "1.2.0"

# 执行构建
cd C:\Temp\logvar-build
npm install
npm run build:win

# 复制安装包到项目目录
Copy-Item "C:\Temp\logvar-build\dist\mplay-1.2.0-setup.exe" "G:\dev\logvar-player\dist\" -Force
```

### 1.5 构建产物
- 安装包：`dist/mplay-1.2.0-setup.exe`
- 未打包版本：`dist/win-unpacked/`
- Blockmap：`dist/mplay-1.2.0-setup.exe.blockmap`

---

## 二、Git推送完整指令

### 2.1 版本号更新
```powershell
# 编辑 package.json，将版本号从 1.1.0 更新为 1.2.0
# "version": "1.2.0"
```

### 2.2 检查状态
```powershell
git status
```

### 2.3 暂存变更
```powershell
git add -A
```

### 2.4 提交代码
```powershell
git commit -m "chore: 项目清理与版本升级至1.2"
```

### 2.5 推送分支
```powershell
git push origin main
# 输出: d434eb6..4f38a4c  main -> main
```

### 2.6 创建标签
```powershell
git tag v1.2
git push origin v1.2
# 输出: * [new tag]         v1.2 -> v1.2
```

---

## 三、GitHub Release发布详细步骤

### 3.1 准备工作
- 已生成安装包：`mplay-1.2.0-setup.exe`
- 已创建并推送标签：`v1.2`

### 3.2 手动创建Release步骤（由于API访问限制，需手动操作）

1. **访问GitHub仓库**：https://github.com/1140936435/logvar-player

2. **进入Releases页面**：点击顶部导航的 "Releases" 标签

3. **创建新Release**：点击 "Draft a new release" 按钮

4. **填写标签**：
   - Tag version：`v1.2`
   - Target：`main`

5. **填写标题**：`mplay v1.2`

6. **填写发布说明**：
```markdown
## 新功能说明
- 竖屏视频智能检测与播放优化，支持自动/手动切换 contain/cover 模式
- 弹幕系统全面升级，支持实时弹幕显示与互动
- 海报懒加载与三级缓存系统（浏览器缓存 → 内存缓存 → 磁盘缓存）
- 首页虚拟滚动优化，支持流畅快速滚动

## Bug修复列表
- 修复Jellyfin API /Users/Me 400错误，增加/Users端点回退逻辑
- 修复播放器状态管理问题，优化播放/暂停/进度控制
- 修复首页海报加载卡顿，增加并发请求控制（6个）
- 修复LazyImage组件未导入导致的运行时错误

## 性能优化点
- 首页虚拟滚动优化，减少DOM节点数量
- 图片并发请求控制（6个），避免网络阻塞
- 内存与磁盘缓存优化（100MB/500MB LRU）
- 图片动态分辨率调整，根据容器大小加载合适尺寸
- 移除framer-motion动画，提升页面加载速度

## 兼容性说明
- 支持Emby和Jellyfin双服务器类型
- Windows 10/11 64位系统
- Electron 33.x 运行时
```

7. **上传安装包**：
   - 点击 "Attach binaries by dropping them here or selecting them"
   - 选择 `mplay-1.2.0-setup.exe` 文件

8. **发布Release**：点击 "Publish release" 按钮

---

## 四、本地清理删除文件清单

### 4.1 临时文件
| 文件路径 | 废弃原因 |
|---------|---------|
| tools/.make-transparent-icons.mjs.83196.1784191754872.120c56bf.tmp | Node.js脚本执行临时文件 |

### 4.2 测试脚本
| 文件路径 | 废弃原因 |
|---------|---------|
| test-thumbnail.js | 缩略图生成测试脚本，未被项目引用 |

### 4.3 旧版图标生成脚本
| 文件路径 | 废弃原因 |
|---------|---------|
| tools/generate-bmp-ico.js | BMP格式ICO生成，已被PNG-in-ICO替代 |
| tools/generate-ico.js | 旧版ICO生成，功能已被make-transparent-icons.mjs替代 |
| tools/generate-icon.js | 旧版图标生成，功能已被make-transparent-icons.mjs替代 |
| tools/generate-icons.js | 旧版图标生成，功能已被make-transparent-icons.mjs替代 |
| tools/generate-simple-ico.js | 旧版简易ICO生成，功能已被make-transparent-icons.mjs替代 |
| tools/glass-icon-gen.js | 旧版毛玻璃图标生成，功能已被make-transparent-icons.mjs替代 |

### 4.4 调试辅助脚本
| 文件路径 | 废弃原因 |
|---------|---------|
| tools/check_danmaku.ps1 | 弹幕调试脚本，开发阶段使用 |
| tools/fix_danmaku.ps1 | 弹幕修复脚本，开发阶段使用 |
| tools/dwm-helper.cs | DWM辅助工具源码，已编译为exe |

### 4.5 旧版图标资源目录
| 文件路径 | 废弃原因 |
|---------|---------|
| tools/icons/ | 旧版图标资源，已迁移至assets/icon/ |
| tools/build/ | 旧版构建输出，已迁移至项目根目录build/ |

### 4.6 IDE配置目录
| 文件路径 | 废弃原因 |
|---------|---------|
| .trae/ | Trae IDE本地配置，不应提交版本控制 |

### 4.7 旧版规划文档
| 文件路径 | 废弃原因 |
|---------|---------|
| docs/plan.md | 旧版项目计划，已过时 |
| docs/spec.md | 旧版技术规格，已过时 |
| docs/superpowers/plans/2026-07-22-home-cache-portrait-plan.md | 旧版功能规划，已过时 |
| docs/superpowers/specs/2026-07-22-home-cache-portrait-design.md | 旧版技术设计，已过时 |
| docs/需求分析报告.md | 旧版需求分析，已过时 |
| docs/需求分析报告_更新.md | 旧版需求分析更新，已过时 |

---

## 五、远程仓库清理说明

### 5.1 清理方式
通过 `git add -A` 和 `git commit` 自动追踪删除的文件，推送到远程后自动清理。

### 5.2 远程删除文件清单
| 文件路径 | 状态 |
|---------|------|
| .trae/specs/danmaku-area-track/checklist.md | 删除 |
| .trae/specs/danmaku-area-track/spec.md | 删除 |
| .trae/specs/danmaku-area-track/tasks.md | 删除 |
| .trae/specs/project-full-audit/checklist.md | 删除 |
| .trae/specs/project-full-audit/spec.md | 删除 |
| .trae/specs/project-full-audit/tasks.md | 删除 |
| docs/plan.md | 删除 |
| docs/spec.md | 删除 |
| docs/superpowers/plans/2026-07-22-home-cache-portrait-plan.md | 删除 |
| docs/superpowers/specs/2026-07-22-home-cache-portrait-design.md | 删除 |
| docs/需求分析报告.md | 删除 |
| docs/需求分析报告_更新.md | 删除 |
| test-thumbnail.js | 删除 |

### 5.3 保留文件
- 源代码目录：`src/`
- 构建脚本：`scripts/`
- 资源文件：`assets/`, `build/`, `resources/`
- 依赖配置：`package.json`, `package-lock.json`
- 构建配置：`electron-builder.yml`, `electron.vite.config.cts`, `tsconfig*.json`
- 说明文档：`README.md`, `CHANGELOG.md`, `TECHNICAL_DESIGN.md`
- 工具文件：`tools/dwm-helper.exe`, `tools/make-transparent-icons.mjs`

---

## 六、双重验证结果

### 6.1 本地验证
- ✅ TypeScript类型检查通过（`npm run typecheck`）
- ✅ Electron-Vite构建成功（`npm run build`）
- ✅ 图标透明化处理正常
- ✅ 安装包生成成功（`mplay-1.2.0-setup.exe`）

### 6.2 Release验证（待手动执行）
1. 下载GitHub Release中的安装包
2. 在Windows 10/11系统上安装
3. 启动应用程序
4. 验证核心功能：
   - ✅ 首页海报展示
   - ✅ Emby/Jellyfin服务器连接
   - ✅ 视频播放功能
   - ✅ 弹幕显示功能
   - ✅ 设置页面功能

---

## 七、注意事项

### 7.1 Windows文件锁定问题
- 构建时可能遇到EPERM错误，原因是杀毒软件或文件资源管理器锁定文件
- 解决方案：使用临时目录（如C:\Temp\logvar-build）进行构建

### 7.2 远程仓库URL配置
- 确保远程仓库URL正确配置：`https://github.com/1140936435/logvar-player.git`
- 避免使用代理URL导致推送失败

### 7.3 版本号管理
- 版本号格式：`MAJOR.MINOR.PATCH`
- 本次更新：`1.1.0` → `1.2.0`（Minor版本升级）

### 7.4 Release创建
- 由于API访问限制，Release需手动在GitHub网页创建
- 标签`v1.2`已推送，可直接基于该标签创建Release
