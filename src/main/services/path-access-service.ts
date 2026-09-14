import { basename, dirname, join, resolve as pathResolve, sep as pathSep } from 'path'
import { realpathSync } from 'fs'

/**
 * 路径访问控制服务（可单测的纯模块）。
 *
 * 纯字符串 `path.resolve + startsWith` 属于字符串级权限判断：授权目录内的
 * symlink / Windows junction 可以把真实路径跳到授权范围之外。因此授权根目录
 * 与目标文件都必须先 realpath canonicalize，再比较前缀。
 *
 * electron 的 src/main/index.ts 通过注入 store / persist / implicitRoots 使用本服务，
 * 测试通过注入 fake store 与 realpath 覆盖恢复 / 前缀 / 链接 / 大小写等场景。
 */

export interface PathAccessStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface PathAccessServiceOptions {
  /** 持久化存储（config.json 的读写包装） */
  store: PathAccessStore
  /** 授权清单在 store 中的键名 */
  storageKey: string
  /** 授权根目录变更后的落盘钩子（如 saveConfigFile） */
  persist?: () => void
  /** 额外始终放行的根目录（如 userData），每次校验时动态求值 */
  implicitRoots?: () => string[]
  /** realpath 实现（可注入以便测试） */
  realpath?: (p: string) => string
  /** 平台标识（默认 process.platform，win32 时比较不区分大小写） */
  platform?: NodeJS.Platform
}

/** realpath 错误是否属于「路径不存在」——只有这类错误允许走回退，其余一律视为不可信 */
function isNotFoundError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * canonicalize：用 realpath 解析 symlink / junction 后返回真实路径。
 * 目标不存在（新建文件场景）时，沿父目录上溯到最深「已存在」的祖先，取其 realpath
 * 再拼回剩余段——已存在部分中的链接仍被解析，不存在的部分不可能藏链接。
 * 其余错误（EACCES / ELOOP / EIO 等）直接抛出：无法确认真实路径时必须由调用方
 * 拒绝访问（fail-closed），绝不能退化为字符串级前缀比较（fail-open）。
 */
export function canonicalizePath(
  p: string,
  realpath: (p: string) => string = realpathSync,
  platform: NodeJS.Platform = process.platform
): string {
  const resolved = pathResolve(p)
  try {
    return realpath(resolved)
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }
  let dir = dirname(resolved)
  const tail: string[] = [basename(resolved)]
  for (;;) {
    try {
      return join(realpath(dir), ...[...tail].reverse())
    } catch (err) {
      if (!isNotFoundError(err)) throw err
      const parent = dirname(dir)
      // 上溯到根仍不存在：整条路径没有任何可解析的链接，字符串 resolve 即真实形态
      if (parent === dir) return resolved
      tail.push(basename(dir))
      dir = parent
    }
  }
}

export class PathAccessService {
  private readonly roots = new Set<string>()
  private readonly options: PathAccessServiceOptions

  constructor(options: PathAccessServiceOptions) {
    this.options = options
  }

  private norm(p: string): string {
    const resolved = pathResolve(p)
    return this.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  private normCanonical(p: string): string {
    return this.norm(canonicalizePath(p, this.realpath, this.platform))
  }

  private get realpath(): (p: string) => string {
    return this.options.realpath ?? realpathSync
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  /** 配置加载完成后把持久化的授权根目录灌回内存（重启恢复的关键步骤） */
  restore(): void {
    this.roots.clear()
    const stored = this.options.store.get(this.options.storageKey)
    if (!Array.isArray(stored)) return
    for (const value of stored) {
      if (typeof value === 'string' && value) {
        // 根目录本身若是链接（用户经 junction 授权），必须解析为真实目标再比较，
        // 否则目标文件 realpath 后与字符串形式的根目录前缀不匹配，造成误拒
        try {
          this.roots.add(this.normCanonical(value))
        } catch { /* 不可解析的条目直接丢弃（fail-closed），不阻断启动 */ }
      }
    }
  }

  authorizeRoot(p: string): void {
    // 空串经 pathResolve 会变成 cwd，绝不能作为授权根目录
    if (!p) return
    try {
      const norm = this.normCanonical(p)
      if (!norm) return
      if (this.roots.has(norm)) return
      this.roots.add(norm)
      // 持久化 canonical 后的路径；重启时 restore 会再次 canonicalize
      this.options.store.set(this.options.storageKey, Array.from(this.roots))
      this.options.persist?.()
    } catch { /* ignore invalid path */ }
  }

  revokeRoot(p: string): boolean {
    if (!p) return false
    let norm: string
    try {
      norm = this.normCanonical(p)
    } catch {
      // 无法确认真实路径时按字符串形态尝试移除——删除条目只会收紧权限，不会放权
      norm = this.norm(p)
    }
    if (!norm) return false
    if (!this.roots.delete(norm)) return false
    this.options.store.set(this.options.storageKey, Array.from(this.roots))
    this.options.persist?.()
    return true
  }

  isPathAllowed(p: string): boolean {
    // 空串经 pathResolve 会变成 cwd，不属于任何授权路径
    if (!p) return false
    let norm: string
    try {
      norm = this.normCanonical(p)
    } catch {
      // canonicalize 失败（EACCES / ELOOP 等）＝ 无法确认真实路径 → 拒绝
      return false
    }
    if (!norm) return false
    // 隐式根（userData 等应用自有目录）始终放行
    for (const implicit of this.options.implicitRoots?.() ?? []) {
      if (!implicit) continue
      let rn: string
      try {
        rn = this.normCanonical(implicit)
      } catch {
        continue // 单个隐式根不可解析时跳过，不影响其余根与授权根的判断
      }
      if (norm === rn || norm.startsWith(rn + pathSep)) return true
    }
    for (const root of this.roots) {
      if (norm === root || norm.startsWith(root + pathSep)) return true
    }
    return false
  }

  /** 仅供诊断 / 测试：当前内存中的授权根目录 */
  getRoots(): string[] {
    return Array.from(this.roots)
  }
}
