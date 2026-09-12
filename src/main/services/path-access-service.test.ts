import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PathAccessService, canonicalizePath, type PathAccessStore } from './path-access-service'

/** 内存版 store，模拟 config.json 的读写 */
function makeStore(initial: Record<string, unknown> = {}): PathAccessStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => { data[key] = value }
  }
}

const KEY = 'local:allowed-roots'

describe('canonicalizePath', () => {
  it('目标存在时用 realpath 结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pas-'))
    try {
      const file = join(dir, 'a.txt')
      writeFileSync(file, 'x')
      expect(canonicalizePath(file, realpathSync)).toBe(realpathSync(file))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目标不存在时回退「父目录 realpath + 文件名」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pas-'))
    try {
      const missing = join(dir, 'not-exist.bin')
      expect(canonicalizePath(missing, realpathSync)).toBe(join(realpathSync(dir), 'not-exist.bin'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('父目录也不可用时退化为字符串 resolve', () => {
    const p = join(tmpdir(), 'no-such-parent-xyz', 'no-such-child.bin')
    expect(canonicalizePath(p, () => { throw new Error('boom') })).toBe(p)
  })
})

describe('PathAccessService', () => {
  let base: string
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pas-'))
    store = makeStore()
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function makeService(implicitRoots: string[] = []): PathAccessService {
    return new PathAccessService({
      store,
      storageKey: KEY,
      implicitRoots: () => implicitRoots,
      realpath: realpathSync
    })
  }

  it('授权根目录内的文件放行，根目录外的拒绝', () => {
    const media = join(base, 'media')
    mkdirSync(media)
    const svc = makeService()
    svc.authorizeRoot(media)
    expect(svc.isPathAllowed(join(media, 'a.mkv'))).toBe(true)
    expect(svc.isPathAllowed(join(base, 'outside.mkv'))).toBe(false)
  })

  it('同级目录前缀不误放（C:\\media 与 C:\\media2）', () => {
    const media = join(base, 'media')
    const media2 = join(base, 'media2')
    mkdirSync(media)
    mkdirSync(media2)
    const svc = makeService()
    svc.authorizeRoot(media)
    expect(svc.isPathAllowed(join(media2, 'secret.txt'))).toBe(false)
  })

  it('../ 穿越到授权目录外被拒绝', () => {
    const media = join(base, 'media')
    mkdirSync(media)
    const svc = makeService()
    svc.authorizeRoot(media)
    const traversal = join(media, '..', '..', 'etc', 'passwd')
    expect(svc.isPathAllowed(traversal)).toBe(false)
  })

  it('授权目录内的 symlink / junction 指向外部时被拒绝', () => {
    const media = join(base, 'media')
    const outside = join(base, 'outside')
    mkdirSync(media)
    mkdirSync(outside)
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'top secret')
    const link = join(media, 'link')
    // Windows junction 不需要管理员权限；其他平台用 dir symlink
    symlinkSync(outside, link, 'junction')
    if (!existsSync(link)) return // 平台不支持时跳过

    const svc = makeService()
    svc.authorizeRoot(media)
    // 字符串前缀判断会误放行 link\secret.txt；canonicalize 后真实路径在外部
    expect(svc.isPathAllowed(join(link, 'secret.txt'))).toBe(false)
    expect(svc.isPathAllowed(secret)).toBe(false)
    // 链接外的正常文件仍然放行
    const ok = join(media, 'video.mkv')
    writeFileSync(ok, 'x')
    expect(svc.isPathAllowed(ok)).toBe(true)
  })

  it('授权根目录本身是 junction 时，经 junction 访问的目标放行（canonicalize 根目录）', () => {
    const realDir = join(base, 'real-media')
    mkdirSync(realDir)
    const linkDir = join(base, 'media-link')
    symlinkSync(realDir, linkDir, 'junction')
    if (!existsSync(linkDir)) return

    const svc = makeService()
    // 用户通过 junction 路径授权
    svc.authorizeRoot(linkDir)
    // 目标经 junction 访问，realpath 落在 realDir —— 应放行而不是误拒
    const file = join(linkDir, 'movie.mkv')
    writeFileSync(file, 'x')
    expect(svc.isPathAllowed(file)).toBe(true)
  })

  it('Windows 下路径大小写不敏感（仅 win32）', () => {
    const media = join(base, 'Media')
    mkdirSync(media)
    const svc = makeService()
    svc.authorizeRoot(media)
    const upper = join(media.toUpperCase(), 'A.MKV')
    if (process.platform === 'win32') {
      expect(svc.isPathAllowed(upper)).toBe(true)
    } else {
      expect(svc.isPathAllowed(upper)).toBe(false)
    }
  })

  it('restore：重启后从持久化配置恢复授权根目录', () => {
    const media = join(base, 'media')
    mkdirSync(media)
    // 第一次运行：授权并持久化
    const first = makeService()
    first.authorizeRoot(media)
    expect(store.data[KEY]).toBeDefined()

    // 模拟重启：新实例从空内存恢复
    const second = makeService()
    expect(second.isPathAllowed(join(media, 'a.mkv'))).toBe(false)
    second.restore()
    expect(second.isPathAllowed(join(media, 'a.mkv'))).toBe(true)
  })

  it('restore：store 中无该键时不产生任何根', () => {
    const svc = makeService()
    svc.restore()
    expect(svc.getRoots()).toEqual([])
    expect(svc.isPathAllowed(join(base, 'anything'))).toBe(false)
  })

  it('implicitRoots（userData 等隐式根）始终放行', () => {
    const userData = join(base, 'userdata')
    mkdirSync(userData)
    const svc = makeService([userData])
    expect(svc.isPathAllowed(join(userData, 'danmaku.xml'))).toBe(true)
    expect(svc.isPathAllowed(userData)).toBe(true)
  })

  it('authorizeRoot 变更会写回 store 并触发 persist', () => {
    const media = join(base, 'media')
    mkdirSync(media)
    let persisted = 0
    const svc = new PathAccessService({
      store,
      storageKey: KEY,
      persist: () => { persisted++ },
      realpath: realpathSync
    })
    svc.authorizeRoot(media)
    svc.authorizeRoot(media) // 重复授权不重复写
    expect(persisted).toBe(1)
    expect(Array.isArray(store.data[KEY])).toBe(true)
  })

  it('非法输入（空串 / 非字符串数组）不抛异常', () => {
    store.data[KEY] = [123, null, '', 'ok']
    const svc = makeService()
    expect(() => svc.restore()).not.toThrow()
    expect(() => svc.authorizeRoot('')).not.toThrow()
    expect(svc.isPathAllowed('')).toBe(false)
  })
})
