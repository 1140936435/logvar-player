# 弹幕分区显示与防重叠轨道算法 - 实现计划

## 核心架构说明

### 参考方案原理（DPlayer/danmaku.js）

**弹幕分区实现原理：**
1. 定义弹幕显示区域的上下边界（百分比或像素）
2. 计算有效弹幕区域的高度 = bottomBoundary - topBoundary
3. 轨道分配时，起始 y 坐标从 topBoundary 开始
4. 超出边界的弹幕自动丢弃

**防重叠轨道算法原理：**
1. 维护每个方向（ltr/rtl）的轨道占用列表
2. 每条轨道记录：起始位置、结束位置、占用时间
3. 新弹幕分配时，遍历轨道列表查找完全空闲的轨道
4. 空闲轨道判定：当前时间 >= 轨道占用结束时间 + 安全间距
5. 无空闲轨道时创建新轨道（不超出区域边界）
6. 定期清理已过期的轨道占用记录

### 文件结构

| 文件 | 职责 |
|------|------|
| `src/shared/types.ts` | 新增弹幕区域配置类型 |
| `src/renderer/src/utils/danmakuEngine.ts` | 核心渲染引擎，添加边界和轨道分配 |
| `src/renderer/src/pages/Player.tsx` | 设置面板 UI，状态管理，持久化 |
| `src/renderer/src/utils/trackAllocator.ts` | 独立轨道分配工具函数（新增） |

---

## [ ] Task 1: 新增轨道分配工具函数

**Priority**: high
**Depends On**: None
**Description**: 创建独立的轨道分配工具模块，实现防重叠轨道调度算法，参考 DPlayer 的轨道管理逻辑。
**Acceptance Criteria Addressed**: AC-3, AC-4
**Test Requirements**:
- `programmatic` TR-1.1: 轨道分配器能正确分配不重叠轨道
- `programmatic` TR-1.2: 轨道分配器能复用闲置轨道
- `programmatic` TR-1.3: 超出边界的轨道返回 null

**Notes**: 轨道分配器需要考虑弹幕宽度、滚动速度、播放倍率等因素

## [ ] Task 2: 扩展 DanmakuEngine 支持区域边界

**Priority**: high
**Depends On**: Task 1
**Description**: 修改 DanmakuEngine，添加 topBoundary/bottomBoundary 属性和 setBoundary 方法，轨道分配时限定在边界内。
**Acceptance Criteria Addressed**: AC-1, AC-4, AC-7
**Test Requirements**:
- `programmatic` TR-2.1: 设置边界后弹幕仅在指定区域内显示
- `programmatic` TR-2.2: 超出边界的弹幕被自动丢弃
- `programmatic` TR-2.3: 边界配置能正确转换百分比和像素

**Notes**: 需要修改 allocate 方法和 update 方法

## [ ] Task 3: Player 页面添加边界状态和配置 UI

**Priority**: high
**Depends On**: Task 2
**Description**: 在 Player.tsx 中添加弹幕区域边界状态，在设置面板新增调节滑块，实现持久化存储。
**Acceptance Criteria Addressed**: AC-1, AC-2
**Test Requirements**:
- `human-judgment` TR-3.1: 设置面板显示上下边界调节滑块
- `programmatic` TR-3.2: 边界配置正确保存到 localStorage
- `programmatic` TR-3.3: 重启后边界配置正确恢复

**Notes**: 需要修改 loadSettings 函数和 settings 面板 UI

## [ ] Task 4: 集成轨道分配器到引擎

**Priority**: high
**Depends On**: Task 1, Task 2
**Description**: 将独立轨道分配器集成到 DanmakuEngine，替换现有的 allocate 方法，实现完全无重叠的轨道分配。
**Acceptance Criteria Addressed**: AC-3, AC-5, AC-6
**Test Requirements**:
- `human-judgment` TR-4.1: 多条弹幕同时出现时无重叠
- `human-judgment` TR-4.2: 倍速切换后弹幕无重叠
- `human-judgment` TR-4.3: 拖拽跳转后弹幕无重叠

**Notes**: 需要修改 seek 方法以支持重新分配轨道

## [ ] Task 5: 兼容性修复和全场景测试

**Priority**: medium
**Depends On**: Task 3, Task 4
**Description**: 修复历史 bug（弹幕匹配转圈、进度错位），运行全场景测试验证。
**Acceptance Criteria Addressed**: 全部
**Test Requirements**:
- `programmatic` TR-5.1: 原有弹幕功能正常（播放、API匹配、进度同步）
- `programmatic` TR-5.2: 编辑器无 TS 报错
- `human-judgment` TR-5.3: 调节分区、正常播放、高并发弹幕、倍速、拖拽、重启软件全部验证

**Notes**: 需要检查原有功能是否被破坏