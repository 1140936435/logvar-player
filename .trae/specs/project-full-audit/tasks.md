# 项目全局审核与修复 - 实现计划

## 实现顺序与依赖关系

本次审核修复按"底层工具 → 渲染引擎 → 页面集成 → 验证测试"的顺序推进，确保每层修改不破坏上层依赖。

---

## [x] Task 1: 修复 TrackAllocator 宽度碰撞检测

**Priority**: high
**Depends On**: None
**Description**: 参考 DPlayer 的 willCollide 算法，补全 TrackAllocator 的宽度碰撞检测逻辑。当前实现仅基于时间过期复用轨道，未考虑弹幕宽度差异导致的视觉碰撞。
**Acceptance Criteria Addressed**: AC-6, FR-3
**修复点**: 
- TS-5: allocate() 补全宽度碰撞检测
- BUG-4: 高并发弹幕重叠挤压

**实现细节**:
1. TrackItem 增加 `width`、`speed`、`startTime` 字段
2. allocate() 中对每个轨道做 willCollide 判定：
   - 计算前一条弹幕的尾部 x 坐标
   - 计算新弹幕的头部 x 坐标
   - 若新弹幕会追上前一条，则跳过该轨道
3. 保留时间过期复用作为快速路径
4. 验证: 不同宽度弹幕同轨道不碰撞

**Notes**: 参考 DPlayer 的 `willCollide(item, cmt, time)` 实现

---

## [x] Task 2: 统一 effectiveDuration 计算

**Priority**: high
**Depends On**: Task 1
**Description**: 修复 danmakuEngine.ts 与 trackAllocator.ts 的倍率双重处理问题。引擎层传入 `effectiveDuration = scrollDuration`（未除倍率），但分配器内部又做了 `scrollDuration / playbackRate`，导致倍速时轨道复用时间计算错误。
**Acceptance Criteria Addressed**: AC-4, AC-6, FR-4
**修复点**: ARCH-4

**实现细节**:
1. danmakuEngine.ts L326: `effectiveDuration = this.scrollDuration / pbr`
2. trackAllocator.ts: 移除 `scrollDuration / playbackRate`，直接使用传入的 scrollDuration
3. 确保引擎层和分配器层对倍率的处理一致

---

## [x] Task 3: 统一轨道分配系统并修复边界判定

**Priority**: high
**Depends On**: Task 1, Task 2
**Description**: 统一 danmakuEngine.ts 使用 TrackAllocator 管理全部四种模式（ltr/rtl/top/bottom），移除冗余的 CollisionRange 系统；修复屏幕外弹幕丢弃判定未考虑自定义边界的问题。
**Acceptance Criteria Addressed**: AC-5, AC-6, FR-8, FR-9
**修复点**: ARCH-1, ARCH-5

**实现细节**:
1. allocate() 方法中 top/bottom 模式也使用 trackAllocator.allocate()
2. 移除 allocate() 中的 CollisionRange 分支逻辑（保留函数定义避免其他引用报错）
3. 修改 update() 中屏幕外弹幕丢弃判定，使用 topBoundary/bottomBoundary
4. 确保 top/bottom 弹幕在边界内居中显示

---

## [x] Task 4: 修复 Player.tsx TS 问题与闭包 bug

**Priority**: high
**Depends On**: None
**Description**: 修复 Player.tsx 的未使用导入（TS-1/TS-2/TS-3）和 loadSettings 闭包 bug（TS-4）。
**Acceptance Criteria Addressed**: AC-1, AC-5, FR-1, FR-2
**修复点**: TS-1, TS-2, TS-3, TS-4

**实现细节**:
1. 移除未使用导入: `TvMinimalPlay`, `useMemo`
2. 确认 `cleanTitleForMatch` 调用关系，若无调用则移除（Task 5 会用到）
3. loadSettings 闭包 bug 修复:
   ```typescript
   // 修复前（闭包 bug）:
   const topBoundary = await window.api.store.get('danmakuTopBoundary')
   if (topBoundary !== null) { setDanmakuTopBoundary(v); engineRef.current?.setBoundary(v, danmakuBottomBoundary) }
   const bottomBoundary = await window.api.store.get('danmakuBottomBoundary')
   if (bottomBoundary !== null) { setDanmakuBottomBoundary(v); engineRef.current?.setBoundary(danmakuTopBoundary, v) }
   
   // 修复后（局部变量）:
   let loadedTop = danmakuTopBoundary
   let loadedBottom = danmakuBottomBoundary
   const topBoundary = await window.api.store.get('danmakuTopBoundary')
   if (topBoundary !== null) { loadedTop = Number(topBoundary); setDanmakuTopBoundary(loadedTop) }
   const bottomBoundary = await window.api.store.get('danmakuBottomBoundary')
   if (bottomBoundary !== null) { loadedBottom = Number(bottomBoundary); setDanmakuBottomBoundary(loadedBottom) }
   engineRef.current?.setBoundary(loadedTop, loadedBottom)
   ```
4. 补全 loadSettings catch 块错误日志（ARCH-2）

---

## [x] Task 5: 修复弹幕匹配 loading 状态与标题清洗

**Priority**: high
**Depends On**: Task 4
**Description**: 修复弹幕匹配无限转圈（BUG-1）和匹配标题未清洗问题（BUG-2）。
**Acceptance Criteria Addressed**: AC-3, FR-5, FR-6
**修复点**: BUG-1, BUG-2

**实现细节**:
1. 在 `loadDanmaku` 函数的所有退出路径添加 `setDanmakuLoading(false)`:
   - null 结果退出
   - 异常 catch 退出
   - 提前 return 退出
2. 在构建匹配标题后调用 `cleanTitleForMatch` 清洗:
   ```typescript
   const cleanedTitle = cleanTitleForMatch(matchTitle)
   if (!cleanedTitle || cleanedTitle === '未知视频') {
     setDanmakuLoading(false)
     return
   }
   ```
3. 验证 epoch 取消后 loading 状态正确重置

---

## [x] Task 6: 修复 seek 后 position 重定位与缓冲 update

**Priority**: medium
**Depends On**: Task 3
**Description**: 修复弹幕与视频进度不同步问题（BUG-3），包括 seek 后 position 重定位和缓冲期间 update 调用。
**Acceptance Criteria Addressed**: AC-4, FR-7
**修复点**: BUG-3

**实现细节**:
1. danmakuEngine.ts seek() 方法: 使用 binsearch 按 time 重定位 position
2. 验证 MediaTimeBus 在缓冲期间的 seeking 状态处理
3. 确认 update() 在 seeking 状态下的行为（暂停新增弹幕，仅渲染已有）

---

## [x] Task 7: TypeScript 编译验证与全场景自检

**Priority**: high
**Depends On**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Description**: 运行 typecheck 和 build 验证，输出全场景自检报告。
**Acceptance Criteria Addressed**: AC-1, AC-2, AC-7, NFR-1, NFR-2
**修复点**: 全部验证

**实现细节**:
1. 运行 `npm run typecheck` 确认零错误
2. 运行 `npm run build` 确认构建成功
3. 输出全场景自检报告覆盖:
   - 软件启动
   - 视频加载
   - 拖拽进度
   - 倍速播放
   - 切换影片
   - 调节弹幕分区
   - 高并发弹幕加载

---

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1], [Task 2]
- [Task 4] 无依赖（可与 Task 1-3 并行）
- [Task 5] depends on [Task 4]
- [Task 6] depends on [Task 3]
- [Task 7] depends on [Task 1], [Task 2], [Task 3], [Task 4], [Task 5], [Task 6]
