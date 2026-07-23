import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

interface CacheMetadata {
  createdAt: number;
  expiresAt: number;
  originalUrl: string;
}

interface MemoryCacheEntry {
  data: Buffer;
  size: number;
  lastAccessed: number;
}

export class PosterCacheService {
  private cacheDir: string;
  private maxSizeBytes: number;
  private maxAgeMs: number;
  private memoryCache: Map<string, MemoryCacheEntry>;
  private maxMemoryBytes: number;
  private currentMemoryBytes: number;

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'poster-cache');
    this.maxSizeBytes = 500 * 1024 * 1024;
    this.maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    this.memoryCache = new Map();
    this.maxMemoryBytes = 100 * 1024 * 1024;
    this.currentMemoryBytes = 0;
    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.access(this.cacheDir);
    } catch {
      await fs.mkdir(this.cacheDir, { recursive: true });
    }
  }

  private getKeyPath(key: string): { data: string; meta: string } {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      data: path.join(this.cacheDir, `${safeKey}.png`),
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

  async get(key: string): Promise<Buffer | null> {
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      memEntry.lastAccessed = Date.now();
      return memEntry.data;
    }

    const paths = this.getKeyPath(key);
    try {
      await fs.access(paths.data);
    } catch {
      return null;
    }

    try {
      const metaStr = await fs.readFile(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      if (Date.now() > meta.expiresAt) {
        await fs.unlink(paths.data);
        await fs.unlink(paths.meta);
        return null;
      }
      const data = await fs.readFile(paths.data);

      const size = data.byteLength;
      this.memoryCache.set(key, { data, size, lastAccessed: Date.now() });
      this.currentMemoryBytes += size;
      this.cleanupMemoryIfNeeded();

      return data;
    } catch {
      try { await fs.unlink(paths.data); } catch {}
      try { await fs.unlink(paths.meta); } catch {}
      return null;
    }
  }

  async set(key: string, data: Buffer, originalUrl: string): Promise<void> {
    try {
      const size = data.byteLength;
      const existing = this.memoryCache.get(key);
      if (existing) {
        this.currentMemoryBytes -= existing.size;
      }
      this.memoryCache.set(key, { data, size, lastAccessed: Date.now() });
      this.currentMemoryBytes += size;
      this.cleanupMemoryIfNeeded();

      const paths = this.getKeyPath(key);
      await fs.writeFile(paths.data, data);
      await fs.writeFile(paths.meta, JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + this.maxAgeMs,
        originalUrl,
      }));
      await this.cleanupIfNeeded();
    } catch {
      console.error(`[PosterCache] Failed to write cache for key: ${key}`);
    }
  }

  async has(key: string): Promise<boolean> {
    const paths = this.getKeyPath(key);
    try {
      await fs.access(paths.data);
      const metaStr = await fs.readFile(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      return Date.now() <= meta.expiresAt;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const paths = this.getKeyPath(key);
    try { await fs.unlink(paths.data); } catch {}
    try { await fs.unlink(paths.meta); } catch {}
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      await this.ensureCacheDir();
    } catch {}
  }

  private async cleanupIfNeeded(): Promise<void> {
    try {
      const files = (await fs.readdir(this.cacheDir)).filter(f => f.endsWith('.png'));
      const items = await Promise.all(files.map(async file => {
        const filePath = path.join(this.cacheDir, file);
        const stat = await fs.stat(filePath);
        return { file, mtime: stat.mtime.getTime(), size: stat.size };
      }));
      items.sort((a, b) => a.mtime - b.mtime);

      let totalSize = items.reduce((sum, item) => sum + item.size, 0);
      for (const item of items) {
        if (totalSize <= this.maxSizeBytes) break;
        const key = item.file.replace(/\.png$/, '');
        await this.delete(key);
        totalSize -= item.size;
      }
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }

  async cleanup(): Promise<void> {
    try {
      const files = (await fs.readdir(this.cacheDir)).filter(f => f.endsWith('.png'));
      for (const file of files) {
        const key = file.replace(/\.png$/, '');
        const paths = this.getKeyPath(key);
        try {
          const metaStr = await fs.readFile(paths.meta, 'utf-8');
          const meta: CacheMetadata = JSON.parse(metaStr);
          if (Date.now() > meta.expiresAt) {
            await fs.unlink(paths.data);
            await fs.unlink(paths.meta);
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