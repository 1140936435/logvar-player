import { describe, it, expect } from 'vitest'
import {
  ENCRYPTED_KEYS,
  isEncrypted,
  isCredentialKey,
  sanitizeEncryptedBlobs,
  stripSensitiveFields,
  deepMerge,
  isAllowedDoubanImageUrl,
  parseRangeHeader,
  maskSecret,
  resolveAppSecretInput,
  normalizeServerUrl,
  serverUrlPrefix,
  matchServerByUrlPrefix
} from './security'

// ==================== 验收点：打开弹幕设置不修改 App-Secret 再保存 → Secret 必须保持 =====
describe('resolveAppSecretInput（DandanPlay App-Secret 留空保持）', () => {
  it('留空 / undefined → 返回 undefined（表示保持不变）', () => {
    expect(resolveAppSecretInput('')).toBeUndefined()
    expect(resolveAppSecretInput('   ')).toBeUndefined()
    expect(resolveAppSecretInput(undefined)).toBeUndefined()
    expect(resolveAppSecretInput(null)).toBeUndefined()
  })

  it('提供新值 → 返回 trim 后的明文（表示更新）', () => {
    expect(resolveAppSecretInput('  abc123  ')).toBe('abc123')
    expect(resolveAppSecretInput('newsecret')).toBe('newsecret')
  })
})

// ==================== 验收点：普通数据导出任意层级不得出现 token/password/appSecret =====
describe('stripSensitiveFields / isCredentialKey（凭据边界）', () => {
  it('凭据命名空间与加密键被判为敏感', () => {
    expect(isCredentialKey('jellyfin')).toBe(true)
    expect(isCredentialKey('emby')).toBe(true)
    expect(isCredentialKey('danmaku:app-secret')).toBe(true)
    expect(isCredentialKey('danmaku:app-id')).toBe(true)
    expect(isCredentialKey('theme')).toBe(false)
    expect(isCredentialKey('jellyfin:activeServerId')).toBe(false)
  })

  it('递归抹除对象中任意层级的 token/password/appSecret/apiKey', () => {
    const input = {
      jellyfin: {
        token: 'SECRET_TOKEN',
        nested: { password: 'p@ss', list: [{ appSecret: 'x' }, { apiKey: 'y' }] }
      },
      danmaku: { 'app-secret': 'appsec', appId: 'id-1' },
      user: { name: 'normal', accessToken: 'AT' }
    }
    const out = stripSensitiveFields(input) as any
    expect(out.jellyfin.token).toBe('')
    expect(out.jellyfin.nested.password).toBe('')
    expect(out.jellyfin.nested.list[0].appSecret).toBe('')
    expect(out.jellyfin.nested.list[1].apiKey).toBe('')
    expect(out.danmaku['app-secret']).toBe('')
    expect(out.user.accessToken).toBe('')
    // 非敏感字段保留
    expect(out.user.name).toBe('normal')
    expect(out.danmaku.appId).toBe('id-1')
  })

  it('sanitizeEncryptedBlobs 抹掉 enc:/xor: 密文，防止解密失败泄露 blob', () => {
    const input = { a: 'enc:AAAA', b: 'xor:BBBB', c: 'plain', d: ['enc:CC'] }
    const out = sanitizeEncryptedBlobs(input) as any
    expect(out.a).toBe('')
    expect(out.b).toBe('')
    expect(out.c).toBe('plain')
    expect(out.d[0]).toBe('')
  })

  it('isEncrypted 识别前缀', () => {
    expect(isEncrypted('enc:x')).toBe(true)
    expect(isEncrypted('xor:x')).toBe(true)
    expect(isEncrypted('plain')).toBe(false)
  })

  it('ENCRYPTED_KEYS 包含 app-secret/token 等', () => {
    expect(ENCRYPTED_KEYS.has('jellyfin.token')).toBe(true)
    expect(ENCRYPTED_KEYS.has('danmaku:app-secret')).toBe(true)
  })
})

// ==================== 验收点：import merge 语义 =====
describe('deepMerge（数据导入深合并）', () => {
  it('保留未覆盖的嵌套字段（不再整体覆盖）', () => {
    const base = { danmaku: { appId: 'keep', primary: 'https://a' }, theme: 'dark' }
    const patch = { danmaku: { primary: 'https://b' } }
    const out = deepMerge(base as any, patch as any) as any
    expect(out.danmaku.appId).toBe('keep') // 未被覆盖字段保留
    expect(out.danmaku.primary).toBe('https://b')
    expect(out.theme).toBe('dark')
  })

  it('数组与原始值整体覆盖', () => {
    const out = deepMerge({ mirrors: [1, 2, 3] } as any, { mirrors: [9] } as any) as any
    expect(out.mirrors).toEqual([9])
  })

  it('忽略原型污染键 __proto__/constructor/prototype', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
    const out = deepMerge({} as any, patch) as any
    expect(out.safe).toBe(1)
    expect(({} as any).polluted).toBeUndefined()
  })
})

// ==================== 验收点：豆瓣 URL allowlist =====
describe('isAllowedDoubanImageUrl（豆瓣图片白名单）', () => {
  it('允许 douban 官方图片域名（含子域）', () => {
    expect(isAllowedDoubanImageUrl('https://img1.doubanio.com/view/photo/x.jpg')).toBe(true)
    expect(isAllowedDoubanImageUrl('https://img9.doubanio.com/a.png')).toBe(true)
    expect(isAllowedDoubanImageUrl('https://movie.douban.com/x.jpg')).toBe(true)
    expect(isAllowedDoubanImageUrl('http://img3.douban.com/x.jpg')).toBe(true)
  })

  it('拒绝非豆瓣域名 / 相似域名 / 危险协议', () => {
    expect(isAllowedDoubanImageUrl('https://evil.com/x.jpg')).toBe(false)
    expect(isAllowedDoubanImageUrl('https://doubanio.com.evil.com/x.jpg')).toBe(false)
    expect(isAllowedDoubanImageUrl('https://notdouban.com/x.jpg')).toBe(false)
    expect(isAllowedDoubanImageUrl('http://127.0.0.1:8080/secret')).toBe(false)
    expect(isAllowedDoubanImageUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedDoubanImageUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedDoubanImageUrl('not a url')).toBe(false)
  })
})

// ==================== 验收点：服务器 URL 匹配（host 冲突 / HTTPS downgrade / base-path）=====
describe('matchServerByUrlPrefix（服务器 URL 前缀匹配）', () => {
  const servers = [
    { id: 'a', url: 'https://host/jellyfin', token: 'TA' },
    { id: 'b', url: 'https://host/emby', token: 'TB' }
  ]

  it('同 host 不同 basePath 各自匹配（不串 token）', () => {
    expect(matchServerByUrlPrefix('https://host/jellyfin/Items/1/Images/Primary', servers)?.server.id).toBe('a')
    expect(matchServerByUrlPrefix('https://host/emby/Items/1/Images/Primary', servers)?.server.id).toBe('b')
  })

  it('最长前缀优先：根路径服务器不会抢占子路径服务器', () => {
    const mixed = [
      { id: 'root', url: 'https://host' },
      { id: 'sub', url: 'https://host/jellyfin' }
    ]
    expect(matchServerByUrlPrefix('https://host/jellyfin/x', mixed)?.server.id).toBe('sub')
    expect(matchServerByUrlPrefix('https://host/other/x', mixed)?.server.id).toBe('root')
  })

  it('HTTPS 配置的服务器不被 http 请求命中（防降级）', () => {
    const httpsOnly = [{ id: 'a', url: 'https://host' }]
    expect(matchServerByUrlPrefix('http://host/x', httpsOnly)).toBeNull()
  })

  it('不匹配的 host 返回 null', () => {
    expect(matchServerByUrlPrefix('https://other/x', servers)).toBeNull()
  })

  it('normalizeServerUrl / serverUrlPrefix 行为', () => {
    expect(normalizeServerUrl('https://host/jellyfin/')).toBe('https://host/jellyfin')
    expect(serverUrlPrefix('https://host/jellyfin/')).toBe('https://host/jellyfin')
    expect(serverUrlPrefix('https://host/')).toBe('https://host')
    expect(serverUrlPrefix('::::not a url')).toBeNull()
  })
})

// ==================== 验收点：Range 语义 =====
describe('parseRangeHeader（HTTP Range 解析）', () => {
  it('解析 start-end', () => {
    expect(parseRangeHeader('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 })
  })
  it('解析 start-（到文件末尾）', () => {
    expect(parseRangeHeader('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })
  it('解析后缀 -N（最后 N 字节）', () => {
    expect(parseRangeHeader('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })
  it('越界 clamp 到末尾', () => {
    expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })
  it('无范围头返回 null（走 200 全量）', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull()
    expect(parseRangeHeader('', 1000)).toBeNull()
  })
  it('非法 / 多段 / 越界起点返回 null（调用方按 416 处理）', () => {
    expect(parseRangeHeader('bytes=0-10,20-30', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=1000-', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=abc-def', 1000)).toBeNull()
    expect(parseRangeHeader('items=0-10', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=0-10', 0)).toBeNull()
  })
})

// ==================== maskSecret =====
describe('maskSecret', () => {
  it('长 secret 保留首尾各 2 位', () => {
    expect(maskSecret('abcdefgh')).toBe('ab****gh')
  })
  it('短 secret 整体掩码', () => {
    expect(maskSecret('abc')).toBe('****')
    expect(maskSecret('abcdef')).toBe('****')
  })
})
