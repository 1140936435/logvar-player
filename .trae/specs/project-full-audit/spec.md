# 项目全局审核与修复 - 产品需求文档

## Overview
- **Summary**: 对播放器项目进行全维度审核，一次性修复所有 TS 类型问题、架构缺陷、历史 bug，并完善弹幕分区与防重叠轨道两个新功能。
- **Purpose**: 消除编辑器爆红、修复架构隐患、解决历史 bug、完成新功能落地，保证整改后无 TS 报错、不崩溃、视频正常播放、弹幕匹配稳定、进度同步、分区可用、弹幕无重叠。
- **Target Users**: 播放器全部用户

## Goals
- 消除所有 TS 语法/类型/编辑器爆红问题
- 修复全局架构中的模块耦合、异步时序、生命周期、容错机制缺陷
- 一次性修复全部历史 bug（弹幕API匹配转圈、进度不同步、高并发重叠）
- 完成弹幕自定义显示区域功能（含闭包 bug 修复）
- 完成弹幕轨道防重叠算法（含宽度碰撞检测补全）
- 输出全场景自检报告

## Non-Goals (Out of Scope)
- 不重构整个项目架构（仅修复关键缺陷）
- 不引入新的第三方库
- 不修改视频播放核心逻辑（除非修复 bug 必需）
- 不新增与本次审核无关的功能

## Background & Context

### 现有代码审核结论

#### ① TS 语法/编辑器爆红问题清单

| 编号 | 位置 | 报错原因 | 修复方案 |
|------|------|---------|---------|
| TS-1 | `Player.tsx` L6 | `TvMinimalPlay` 导入未使用 | 从导入列表移除 |
| TS-2 | `Player.tsx` L1 | `useMemo` 导入未使用 | 从导入列表移除 |
| TS-3 | `Player.tsx` L70-78 | `cleanTitleForMatch` 函数定义但未在文件内使用 | 确认调用关系，若无调用则移除 |
| TS-4 | `Player.tsx` L354-357 | `loadSettings` 闭包 bug：异步加载边界值时引用了 React state 的过期闭包值（`danmakuBottomBoundary`/`danmakuTopBoundary`），导致 `setBoundary` 第二个参数始终为初始值 | 使用局部变量暂存加载值，两个值都加载完成后调用一次 `setBoundary` |
| TS-5 | `trackAllocator.ts` | `allocate()` 仅基于时间过期判断轨道复用，未考虑弹幕宽度差异导致的视觉碰撞（DPlayer 算法包含宽度+速度碰撞判定） | 补全宽度碰撞检测逻辑，参考 DPlayer 的 `willCollide` 判定 |

#### ② 项目架构不合理、模块冲突、底层设计缺陷清单

| 编号 | 位置 | 缺陷描述 | 整改方案 |
|------|------|---------|---------|
| ARCH-1 | `danmakuEngine.ts` | 双重轨道分配系统并存：top/bottom 仍用旧的 `CollisionRange` 碰撞区间系统，ltr/rtl 用新的 `TrackAllocator`，增加维护复杂度且行为不一致 | 统一使用 `TrackAllocator` 管理全部四种模式，移除旧 `CollisionRange` 系统（保留兼容接口过渡） |
| ARCH-2 | `Player.tsx` L365 | `loadSettings` 的 catch 块为空 `/* ignore */`，吞掉所有配置加载错误，无法排查持久化失败问题 | 补全错误日志输出 |
| ARCH-3 | `Player.tsx` L126-201 | 剧集列表 fetch 在 token 加载前后可能触发双重请求（effect 依赖 `seriesId/seasonId/itemId/localFile`，但内部异步加载 token 后再次调用 fetchEpisodes） | 用 `episodeFetchedRef` 保证只请求一次（已部分实现，需验证 token 竞态） |
| ARCH-4 | `danmakuEngine.ts` L326 | `effectiveDuration = this.scrollDuration` 未考虑 `playbackRate`，但 `TrackAllocator.allocate` 内部做了 `scrollDuration / playbackRate`，导致倍速时轨道复用时间计算与实际滚动时长不一致 | 在引擎层统一传入 `effectiveDuration`，轨道分配器不再二次除以倍率 |
| ARCH-5 | `danmakuEngine.ts` L420 | 屏幕外弹幕丢弃判定 `active.y >= this.cssHeight` 未考虑自定义边界，超出下边界的弹幕仍可能进入渲染 | 修改判定条件为 `active.y + active.height > bottomBoundary \|\| active.y < topBoundary` |

#### ③ 功能缺失、历史 bug、未完善逻辑清单

| 编号 | 问题描述 | 根因分析 | 整改方案 |
|------|---------|---------|---------|
| BUG-1 | 弹幕API匹配无限转圈 | `danmakuRequestManager` 有 epoch 取消和超时重试，但 `Player.tsx` 的 `danmakuLoading` 状态在 epoch 失效返回 null 时未被重置为 false | 在 `loadDanmaku` 的所有退出路径（包括 null 结果）都调用 `setDanmakuLoading(false)` |
| BUG-2 | 经常匹配不到弹幕 | 匹配标题构建逻辑（L391-398）在 `seriesName` 为空且 `itemName` 含特殊字符时可能生成无效标题；`cleanTitleForMatch` 函数已定义但未被调用 | 在构建匹配标题后调用 `cleanTitleForMatch` 清洗，并验证非空 |
| BUG-3 | 弹幕与视频进度不同步（拖拽/倍速/缓冲偏移） | `MediaTimeBus` 已统一时钟源，但 `seek()` 后 `position` 重定位可能跳过大量弹幕，且缓冲期间 `update()` 仍被调用导致 elapsed 计算偏差 | seek 后按二分重定位 position；缓冲期间暂停 update |
| BUG-4 | 高并发弹幕重叠挤压 | `TrackAllocator` 仅时间过期复用，未做宽度碰撞检测（TS-5/ARCH-4 联动） | 补全 DPlayer 风格的 willCollide 判定 |
| FEAT-1 | 自定义弹幕显示区域 | 已实现 UI 滑块和引擎 setBoundary，但闭包 bug（TS-4）导致持久化值加载不正确 | 修复 TS-4 |
| FEAT-2 | 弹幕轨道防重叠 | 已实现基础轨道分配，但宽度碰撞检测缺失（BUG-4） | 修复 BUG-4 |

## Functional Requirements

### 修复类需求
- **FR-1**: 消除全部 TS 编辑器爆红，`npm run typecheck` 零错误
- **FR-2**: 修复 `loadSettings` 闭包 bug，边界值正确持久化加载
- **FR-3**: 修复 `TrackAllocator` 宽度碰撞检测缺失问题
- **FR-4**: 统一 `effectiveDuration` 计算，消除引擎与分配器的倍率双重处理
- **FR-5**: 修复弹幕匹配 loading 状态未重置问题（无限转圈）
- **FR-6**: 修复匹配标题构建未调用 `cleanTitleForMatch` 清洗问题
- **FR-7**: 修复 seek 后弹幕 position 重定位和缓冲期间 update 调用问题
- **FR-8**: 修复屏幕外弹幕丢弃判定未考虑自定义边界问题

### 架构优化需求
- **FR-9**: 统一轨道分配系统，移除冗余的 CollisionRange（保留接口兼容）
- **FR-10**: 补全 `loadSettings` 错误日志
- **FR-11**: 验证剧集列表 fetch 的 token 竞态保护

## Non-Functional Requirements
- **NFR-1**: 整改后 `npm run typecheck` 和 `npm run build` 全部通过
- **NFR-2**: 程序运行不崩溃，视频正常播放为第一优先级
- **NFR-3**: 弹幕渲染保持 60fps（在 maxActiveComments 限制内）
- **NFR-4**: 所有修改添加注释说明修复/优化目的
- **NFR-5**: 不破坏现有功能：视频播放、弹幕API匹配、进度同步、原有配置

## Constraints
- **Technical**: Electron + React + TypeScript + Canvas 2D
- **Dependencies**: 不引入新第三方库，参考 DPlayer/danmaku.js 算法实现
- **Backward Compatibility**: 保留所有现有 IPC 接口、配置 key、UI 交互

## Acceptance Criteria

### AC-1: 无 TS 爆红
- **Given**: 整改完成后
- **When**: 运行 `npm run typecheck`
- **Then**: 零错误零警告
- **Verification**: `programmatic`

### AC-2: 程序不崩溃且视频正常播放
- **Given**: 整改完成后
- **When**: 启动软件、加载视频、播放
- **Then**: 无运行时崩溃，视频正常播放
- **Verification**: `human-judgment`

### AC-3: 弹幕匹配稳定（无无限转圈）
- **Given**: 加载一部有弹幕的视频
- **When**: 等待匹配完成
- **Then**: 匹配成功或失败都会停止 loading 状态，不无限转圈
- **Verification**: `human-judgment`

### AC-4: 弹幕进度同步
- **Given**: 播放弹幕视频
- **When**: 拖拽进度、切换倍速、缓冲恢复
- **Then**: 弹幕与视频进度保持同步
- **Verification**: `human-judgment`

### AC-5: 弹幕分区功能可用
- **Given**: 打开弹幕设置面板
- **When**: 调节上下边界滑块
- **Then**: 弹幕仅在设定区域内显示，重启后配置保留
- **Verification**: `human-judgment`

### AC-6: 弹幕无重叠
- **Given**: 高并发弹幕场景
- **When**: 多条弹幕同时到达
- **Then**: 弹幕分配到不同轨道，无视觉重叠
- **Verification**: `human-judgment`

### AC-7: 全场景自检通过
- **Given**: 整改完成后
- **When**: 执行全场景自检（启动、视频加载、拖拽、倍速、切集、调节分区、高并发弹幕）
- **Then**: 全部场景通过
- **Verification**: `human-judgment`

## Impact
- Affected specs: `danmaku-area-track`（前置 spec，本次完成其剩余 Checkpoint 15）
- Affected code:
  - `src/renderer/src/pages/Player.tsx` - 修复闭包 bug、未使用导入、loading 状态、标题清洗
  - `src/renderer/src/utils/trackAllocator.ts` - 补全宽度碰撞检测
  - `src/renderer/src/utils/danmakuEngine.ts` - 统一 effectiveDuration、修复边界判定、统一轨道系统
  - `src/renderer/src/utils/danmakuRequestManager.ts` - 验证 epoch 取消逻辑完整性

## ADDED Requirements

### Requirement: 宽度碰撞检测
The system SHALL 在轨道分配时考虑弹幕宽度和滚动速度，参考 DPlayer 的 willCollide 算法，确保同轨道前后弹幕不会视觉碰撞。

#### Scenario: 不同宽度弹幕同轨道
- **WHEN** 一条窄弹幕和一条宽弹幕先后进入同一轨道
- **THEN** 窄弹幕尚未完全离开屏幕时，宽弹幕不会被分配到该轨道

### Requirement: Loading 状态兜底
The system SHALL 在弹幕匹配的所有退出路径（成功、失败、取消、超时）都重置 loading 状态。

#### Scenario: 匹配被取消
- **WHEN** 用户切集导致上一次匹配被 epoch 取消
- **THEN** loading 状态被重置为 false，不无限转圈

## MODIFIED Requirements

### Requirement: 弹幕区域边界持久化
修改 loadSettings 逻辑，使用局部变量暂存加载的边界值，避免闭包引用过期 state。

#### Scenario: 重启后边界恢复
- **WHEN** 用户设置边界后重启软件
- **THEN** 上下边界都正确恢复，引擎 setBoundary 接收正确的两个值
