import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

/**
 * 海报缓存 v2
 * - 数据文件统一 `.img` 后缀，真实 MIME 存于 meta JSON（修复 v1 一律 .png + 强制 image/png）
 * - 内存缓存命中同样校验 TTL（修复 v1 内存命中永不过期）
 * - delete/clear 同时清理内存与磁盘（修复 v1 清缓存后旧图仍从内存返回）
 * - cleanup 降频：每 N 次写入或估算超限时才全目录扫描（修复 v1 每次写入 O(N log N) 磁盘扫描）
 * - 缓存 key 由调用方携带服务器 host 维度，避免跨服务器同 path 撞图
 */

interface CacheMetadata {
  v: 2;
  mimeType: string;
  createdAt: number;
  expiresAt: number;
  originalUrl: string;
}

interface MemoryCacheEntry {
  data: Buffer;
  size: number;
  mimeType: string;
  expiresAt: number;
  lastAccessed: number;
}

export interface PosterCacheEntry {
  data: Buffer;
  mimeType: string;
}

const CACHE_VERSION_MARKER = 'cache-v2.marker';
/** 每写入 N 次才做一次全目录清理扫描（估算超限会立即触发） */
const CLEANUP_EVERY_N_WRITES = 25;

export class PosterCacheService {
  private cacheDir: string;
  private maxSizeBytes: number;
  private maxAgeMs: number;
  private memoryCache: Map<string, MemoryCacheEntry>;
  private maxMemoryBytes: number;
  private currentMemoryBytes: number;
  /** 磁盘占用估算值：写入累加、删除扣减，cleanup 全量扫描后校准 */
  private approxDiskBytes: number;
  private writesSinceCleanup: number;

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'poster-cache');
    this.maxSizeBytes = 500 * 1024 * 1024;
    this.maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    this.memoryCache = new Map();
    this.maxMemoryBytes = 100 * 1024 * 1024;
    this.currentMemoryBytes = 0;
    this.approxDiskBytes = 0;
    this.writesSinceCleanup = 0;
    void this.ensureCacheDir().then(() => this.migrateIfNeeded());
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.access(this.cacheDir);
    } catch {
      await fs.mkdir(this.cacheDir, { recursive: true });
    }
  }

  /** v1 → v2 迁移：旧格式（.png 数据文件、meta 无 MIME、key 无服务器维度）整体作废 */
  private async migrateIfNeeded(): Promise<void> {
    try {
      await fs.access(path.join(this.cacheDir, CACHE_VERSION_MARKER));
    } catch {
      try {
        const files = await fs.readdir(this.cacheDir);
        await Promise.all(files.map(f => fs.unlink(path.join(this.cacheDir, f)).catch(() => {})));
        await fs.writeFile(path.join(this.cacheDir, CACHE_VERSION_MARKER), String(Date.now()));
        console.log('[PosterCache] 已清理旧版本缓存（v1 → v2）');
      } catch { /* 忽略迁移失败，缓存可重建 */ }
    }
  }

  private getKeyPath(key: string): { data: string; meta: string } {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      data: path.join(this.cacheDir, `${safeKey}.img`),
      meta: path.join(this.cacheDir, `${safeKey}.json`),
    };
  }

  private cleanupMemoryIfNeeded(): void {
    if (this.currentMemoryBytes <= this.maxMemoryBytes) return;

    const entries = Array.from(this.memoryCache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    for (const [k, entry] of entries) {
      if (this.currentMemoryBytes <= this.maxMemoryBytes) break;
      this.memoryCache.delete(k);
      this.currentMemoryBytes -= entry.size;
    }
  }

  async get(key: string): Promise<PosterCacheEntry | null> {
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      // 内存命中同样校验 TTL：过期则内存磁盘一并清除
      if (Date.now() <= memEntry.expiresAt) {
        memEntry.lastAccessed = Date.now();
        return { data: memEntry.data, mimeType: memEntry.mimeType };
      }
      this.currentMemoryBytes -= memEntry.size;
      this.memoryCache.delete(key);
      await this.delete(key);
      return null;
    }

    const paths = this.getKeyPath(key);
    try {
      const metaStr = await fs.readFile(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      // meta 缺 MIME 视为非法条目（v1 残留或损坏），连同数据文件清除
      if (!meta.mimeType || Date.now() > meta.expiresAt) {
        try { await fs.unlink(paths.data); } catch {}
        try { await fs.unlink(paths.meta); } catch {}
        return null;
      }
      const data = await fs.readFile(paths.data);

      const size = data.byteLength;
      this.memoryCache.set(key, {
        data, size, mimeType: meta.mimeType,
        expiresAt: meta.expiresAt, lastAccessed: Date.now()
      });
      this.currentMemoryBytes += size;
      this.cleanupMemoryIfNeeded();

      return { data, mimeType: meta.mimeType };
    } catch {
      return null;
    }
  }

  async set(key: string, data: Buffer, originalUrl: string, mimeType = 'image/png'): Promise<void> {
    try {
      const size = data.byteLength;
      const expiresAt = Date.now() + this.maxAgeMs;

      const existing = this.memoryCache.get(key);
      if (existing) {
        this.currentMemoryBytes -= existing.size;
      }
      this.memoryCache.set(key, { data, size, mimeType, expiresAt, lastAccessed: Date.now() });
      this.currentMemoryBytes += size;
      this.cleanupMemoryIfNeeded();

      const paths = this.getKeyPath(key);
      await fs.writeFile(paths.data, data);
      const meta: CacheMetadata = {
        v: 2,
        mimeType,
        createdAt: Date.now(),
        expiresAt,
        originalUrl,
      };
      await fs.writeFile(paths.meta, JSON.stringify(meta));

      this.approxDiskBytes += size;
      this.writesSinceCleanup += 1;
      // 降频清理：仅在每 N 次写入或估算占用超限时才做全目录扫描
      if (this.writesSinceCleanup >= CLEANUP_EVERY_N_WRITES || this.approxDiskBytes > this.maxSizeBytes) {
        this.writesSinceCleanup = 0;
        await this.cleanupIfNeeded();
      }
    } catch {
      console.error(`[PosterCache] Failed to write cache for key: ${key}`);
    }
  }

  async has(key: string): Promise<boolean> {
    const paths = this.getKeyPath(key);
    try {
      const metaStr = await fs.readFile(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      if (!meta.mimeType || Date.now() > meta.expiresAt) return false;
      await fs.access(paths.data);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    // 内存与磁盘同步删除，避免"清了缓存旧图还在"
    const mem = this.memoryCache.get(key);
    if (mem) {
      this.currentMemoryBytes -= mem.size;
      this.memoryCache.delete(key);
    }
    const paths = this.getKeyPath(key);
    try {
      const stat = await fs.stat(paths.data);
      this.approxDiskBytes = Math.max(0, this.approxDiskBytes - stat.size);
    } catch {}
    try { await fs.unlink(paths.data); } catch {}
    try { await fs.unlink(paths.meta); } catch {}
  }

  async clear(): Promise<void> {
    // 内存与磁盘同步清空
    this.memoryCache.clear();
    this.currentMemoryBytes = 0;
    this.approxDiskBytes = 0;
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      await this.ensureCacheDir();
      await fs.writeFile(path.join(this.cacheDir, CACHE_VERSION_MARKER), String(Date.now()));
    } catch {}
  }

  private async cleanupIfNeeded(): Promise<void> {
    try {
      const files = (await fs.readdir(this.cacheDir)).filter(f => f.endsWith('.img'));
      const items = await Promise.all(files.map(async file => {
        const filePath = path.join(this.cacheDir, file);
        const stat = await fs.stat(filePath);
        return { file, mtime: stat.mtime.getTime(), size: stat.size };
      }));
      items.sort((a, b) => a.mtime - b.mtime);

      let totalSize = items.reduce((sum, item) => sum + item.size, 0);
      // 全量扫描后校准估算值
      this.approxDiskBytes = totalSize;
      for (const item of items) {
        if (totalSize <= this.maxSizeBytes) break;
        const key = item.file.replace(/\.img$/, '');
        await this.delete(key);
        totalSize -= item.size;
      }
      this.approxDiskBytes = totalSize;
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }

  /** 过期条目清理（保留给外部周期任务调用） */
  async cleanup(): Promise<void> {
    try {
      const files = (await fs.readdir(this.cacheDir)).filter(f => f.endsWith('.img'));
      for (const file of files) {
        const key = file.replace(/\.img$/, '');
        const paths = this.getKeyPath(key);
        try {
          const metaStr = await fs.readFile(paths.meta, 'utf-8');
          const meta: CacheMetadata = JSON.parse(metaStr);
          if (!meta.mimeType || Date.now() > meta.expiresAt) {
            await this.delete(key);
          }
        } catch {
          try { await fs.unlink(paths.data); } catch {}
          try { await fs.unlink(paths.meta); } catch {}
        }
      }
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }
}

export const posterCache = new PosterCacheService();
