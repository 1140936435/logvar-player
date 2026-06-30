# 代码审查报告

**审查范围:** 两个提交 (2ea6840, 8c539ee)
**审查时间:** 2026-06-21
**审查人:** GitHub Copilot (code-review skill)

## 变更概述

本次更改包含以下主要内容：
1. **DandanPlay API 认证** - 添加 AppId/AppSecret 签名认证
2. **截图/画中画功能** - 恢复快捷键 S/P/D 功能
3. **safeStorage 修复** - 跨会话解密失败检测和明文存储
4. **类型完善** - 补全 preload-types.ts 类型定义

---

## 关键问题 (Critical Issues)

### 1. 安全性: appSecret 暴露风险
**文件:** `src/main/index.ts:1420`
**问题:** `getDanmakuApiConfig()` 返回完整的 appSecret，虽然在 `danmaku:get-config` 中做了脱敏处理，但其他调用点可能直接使用此函数获取完整密钥。
**修复建议:** 
- 确保所有面向渲染进程的 API 都使用脱敏版本
- 考虑在配置存储时就进行加密

### 2. 安全性: 缺少输入验证
**文件:** `src/main/index.ts:1445`
**问题:** `generateDandanHeaders()` 没有验证 appId 和 appSecret 参数，可能导致签名计算错误。
**修复建议:** 
```typescript
function generateDandanHeaders(path: string, appId: string, appSecret: string): Record<string, string> {
  if (!appId || !appSecret) {
    console.warn('[Danmaku] Missing appId or appSecret for signing')
    return {}
  }
  // ... 其余代码
}
```

### 3. 错误处理: 缺少 try-catch
**文件:** `src/main/index.ts:1078-1095`
**问题:** 截图保存功能中的 `mpv:screenshot-save` 处理器，当 `getMpvController()` 失败时没有适当的错误处理。
**修复建议:** 添加更详细的错误信息和用户反馈。

---

## 重要问题 (Important Issues)

### 1. 代码重复
**文件:** `src/main/index.ts:932-964`
**问题:** `encryptConfig()` 和 `decryptConfig()` 中对 `jellyfin:servers` 数组的处理逻辑高度重复。
**修复建议:** 提取公共函数：
```typescript
function mapServerCredentials(servers: Record<string, unknown>[], transform: (val: string) => string): Record<string, unknown>[] {
  return servers.map(s => {
    const sv = { ...s }
    if (typeof sv.url === 'string') sv.url = transform(sv.url)
    if (typeof sv.token === 'string') sv.token = transform(sv.token)
    return sv
  })
}
```

### 2. 日志敏感信息泄露
**文件:** `src/main/index.ts:988`
**问题:** `console.log('[Config] jellyfin:servers:', configData['jellyfin:servers'])` 会打印完整的服务器凭据。
**修复建议:** 使用日志脱敏函数：
```typescript
console.log('[Config] jellyfin:servers count:', Array.isArray(configData['jellyfin:servers']) ? (configData['jellyfin:servers'] as unknown[]).length : 0)
```

### 3. 类型定义不一致
**文件:** `src/shared/preload-types.ts:62-66`
**问题:** `DanmakuConfigResponse` 接口移除了 `success` 字段，但其他类似接口如 `DanmakuMatchResponse` 仍保留该字段。
**修复建议:** 统一响应格式，要么全部保留 `success` 字段，要么全部移除。

### 4. 缺少单元测试
**问题:** 新增的 `generateDandanHeaders()`、`isUnresolvedEncrypted()` 等函数没有对应的单元测试。
**修复建议:** 为这些工具函数添加测试用例。

---

## 建议 (Suggestions)

### 1. 改进命名
**文件:** `src/main/index.ts:201`
**问题:** `isUnresolvedEncrypted()` 函数名不够直观。
**建议:** 改为 `hasEncryptedPrefix()` 或 `isEncryptedValue()`。

### 2. 添加 JSDoc 注释
**文件:** `src/main/index.ts:893`
**问题:** `encryptValue()` 和 `decryptValue()` 函数缺少文档注释。
**建议:** 添加函数说明、参数描述和返回值说明。

### 3. 优化配置加载
**文件:** `src/main/index.ts:988`
**问题:** 日志中打印整个配置对象可能影响性能。
**建议:** 只打印配置键名或摘要信息。

### 4. UI/UX 改进建议
**文件:** `src/renderer/src/pages/Settings.tsx:593-625`
**问题:** DandanPlay 认证部分的 UI 布局可以更紧凑。
**建议:** 考虑将 AppId 和 AppSecret 放在同一行，使用更小的间距。

---

## 做得好的地方 (What Was Done Well)

### 1. 安全性改进
- ✅ 添加了 safeStorage 跨会话可用性检测
- ✅ 实现了 `isUnresolvedEncrypted()` 检查函数
- ✅ 在多个消费点添加了防御性解密
- ✅ 对渲染进程隐藏完整的 appSecret

### 2. 代码质量
- ✅ 移除了重复的 mpv 相关代码（Player.tsx 从 1900+ 行减少到 1100+ 行）
- ✅ 添加了详细的类型定义（DoubanApi, VideoApi, LogApi）
- ✅ 使用 useCallback 和 useMemo 优化性能

### 3. 错误处理
- ✅ 在关键路径添加了错误检查（如 `connectToServer`、`jellyfinRequest`）
- ✅ 提供了清晰的用户错误信息（如 "Jellyfin 服务器地址无法解密"）
- ✅ 保留了加密值防止数据丢失（`decryptValue` 失败时返回原文）

### 4. 功能完整性
- ✅ DandanPlay API 签名认证实现完整
- ✅ 截图和画中画功能恢复
- ✅ 设置页面 UI 更新及时

---

## 审查结论

**总体评价:** 良好 (Good)

本次更改在安全性和功能完整性方面有显著改进，代码质量整体较高。主要需要关注的问题是：
1. 确保 appSecret 不会泄露到渲染进程
2. 改进日志中的敏感信息处理
3. 为新函数添加单元测试

**建议优先级:**
1. 修复 Critical 问题 (必须)
2. 处理 Important 问题 (应该)
3. 实施 Suggestions (可以)

**下一步行动:**
1. 修复 appSecret 暴露问题
2. 添加 `generateDandanHeaders` 的单元测试
3. 优化日志输出
4. 考虑添加集成测试覆盖 DandanPlay 认证流程

---

*报告生成时间: 2026-06-21*
*审查工具: GitHub Copilot (code-review skill)*