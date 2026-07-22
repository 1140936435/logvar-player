import fs from 'fs';
import path from 'path';
import { app } from 'electron';

interface CacheMetadata {
  createdAt: number;
  expiresAt: number;
  originalUrl: string;
}

export class PosterCacheService {
  private cacheDir: string;
  private maxSizeBytes: number;
  private maxAgeMs: number;

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'poster-cache');
    this.maxSizeBytes = 500 * 1024 * 1024;
    this.maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    this.ensureCacheDir();
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getKeyPath(key: string): { data: string; meta: string } {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      data: path.join(this.cacheDir, `${safeKey}.png`),
      meta: path.join(this.cacheDir, `${safeKey}.json`),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    const paths = this.getKeyPath(key);
    if (!fs.existsSync(paths.data)) return null;

    try {
      const metaStr = fs.readFileSync(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      if (Date.now() > meta.expiresAt) {
        fs.unlinkSync(paths.data);
        fs.unlinkSync(paths.meta);
        return null;
      }
      return fs.readFileSync(paths.data);
    } catch {
      try { fs.unlinkSync(paths.data); } catch {}
      try { fs.unlinkSync(paths.meta); } catch {}
      return null;
    }
  }

  async set(key: string, data: Buffer, originalUrl: string): Promise<void> {
    try {
      const paths = this.getKeyPath(key);
      fs.writeFileSync(paths.data, data);
      fs.writeFileSync(paths.meta, JSON.stringify({
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
    if (!fs.existsSync(paths.data)) return false;
    try {
      const metaStr = fs.readFileSync(paths.meta, 'utf-8');
      const meta: CacheMetadata = JSON.parse(metaStr);
      return Date.now() <= meta.expiresAt;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const paths = this.getKeyPath(key);
    try { fs.unlinkSync(paths.data); } catch {}
    try { fs.unlinkSync(paths.meta); } catch {}
  }

  async clear(): Promise<void> {
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      this.ensureCacheDir();
    } catch {}
  }

  private async cleanupIfNeeded(): Promise<void> {
    try {
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.png'));
      const items = files.map(file => {
        const filePath = path.join(this.cacheDir, file);
        const stat = fs.statSync(filePath);
        return { file, mtime: stat.mtime.getTime(), size: stat.size };
      }).sort((a, b) => a.mtime - b.mtime);

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
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.png'));
      for (const file of files) {
        const key = file.replace(/\.png$/, '');
        const paths = this.getKeyPath(key);
        try {
          const metaStr = fs.readFileSync(paths.meta, 'utf-8');
          const meta: CacheMetadata = JSON.parse(metaStr);
          if (Date.now() > meta.expiresAt) {
            fs.unlinkSync(paths.data);
            fs.unlinkSync(paths.meta);
          }
        } catch {
          fs.unlinkSync(paths.data);
          try { fs.unlinkSync(paths.meta); } catch {}
        }
      }
    } catch {
      console.error('[PosterCache] Cleanup failed');
    }
  }
}

export const posterCache = new PosterCacheService();
