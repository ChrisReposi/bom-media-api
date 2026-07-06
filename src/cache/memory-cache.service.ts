import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApiEnvironmentConfig } from "../config/env.config";
import type {
  CacheSetOptions,
  GetOrSetOptions,
  MemoryCacheRuntimeConfig,
  MemoryCacheStats,
} from "./memory-cache.types";

type MemoryCacheEntry = {
  value: unknown;
  expiresAt: number;
};

type InflightEntry = {
  promise: Promise<unknown>;
  expiresAt: number;
};

const DEFAULT_MEMORY_CACHE_CONFIG: MemoryCacheRuntimeConfig = {
  enabled: true,
  maxEntries: 1000,
  defaultTtlSeconds: 60,
  inflightTtlMs: 5000,
  adminVideosListTtlSeconds: 30,
  adminWebsitesListTtlSeconds: 60,
  publicWatchMetadataTtlSeconds: 10,
  mediaMetadataTtlSeconds: 300,
};

@Injectable()
export class MemoryCacheService {
  private readonly entries = new Map<string, MemoryCacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly config: MemoryCacheRuntimeConfig;
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;

  constructor(private readonly configService: ConfigService) {
    this.config = this.resolveRuntimeConfig();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getRuntimeConfig(): MemoryCacheRuntimeConfig {
    return { ...this.config };
  }

  get<T>(key: string): T | null {
    if (!this.config.enabled) {
      return null;
    }

    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses += 1;
      this.deletes += 1;
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;

    return entry.value as T;
  }

  set<T>(key: string, value: T, options?: CacheSetOptions): void {
    if (!this.config.enabled) {
      return;
    }

    const ttlMs = this.resolveTtlMs(options?.ttlSeconds);
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    this.sets += 1;
    this.evictOverflow();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) {
      this.deletes += 1;
    }
    if (this.inflight.delete(key)) {
      this.deletes += 1;
    }
  }

  deleteByPrefix(prefix: string): number {
    let deletedCount = 0;

    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        deletedCount += 1;
      }
    }

    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) {
        this.inflight.delete(key);
        deletedCount += 1;
      }
    }

    this.deletes += deletedCount;

    return deletedCount;
  }

  clear(): void {
    const deletedCount = this.entries.size + this.inflight.size;
    this.entries.clear();
    this.inflight.clear();
    this.deletes += deletedCount;
  }

  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options?: GetOrSetOptions,
  ): Promise<T> {
    if (!this.config.enabled) {
      return loader();
    }

    const cachedValue = this.get<T>(key);
    if (cachedValue !== null) {
      return cachedValue;
    }

    const dedupeKey = options?.dedupeKey ?? key;
    const existingInflight = this.readInflight<T>(dedupeKey);
    if (existingInflight !== null) {
      return existingInflight;
    }

    const promise = loader().then((value) => {
      this.set(key, value, { ttlSeconds: options?.ttlSeconds });
      return value;
    });

    this.inflight.set(dedupeKey, {
      promise,
      expiresAt: Date.now() + this.resolveInflightTtlMs(options?.dedupeTtlMs),
    });

    try {
      return await promise;
    } finally {
      const currentInflight = this.inflight.get(dedupeKey);
      if (currentInflight?.promise === promise) {
        this.inflight.delete(dedupeKey);
      }
    }
  }

  getStats(): MemoryCacheStats {
    this.pruneExpiredInflight();

    return {
      enabled: this.config.enabled,
      size: this.entries.size,
      maxEntries: this.config.maxEntries,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      evictions: this.evictions,
      inflight: this.inflight.size,
    };
  }

  private readInflight<T>(key: string): Promise<T> | null {
    const entry = this.inflight.get(key);

    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.inflight.delete(key);
      this.deletes += 1;
      return null;
    }

    return entry.promise as Promise<T>;
  }

  private pruneExpiredInflight(): void {
    const now = Date.now();

    for (const [key, entry] of this.inflight.entries()) {
      if (entry.expiresAt <= now) {
        this.inflight.delete(key);
        this.deletes += 1;
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.config.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }

      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  private resolveTtlMs(ttlSeconds: number | undefined): number {
    const ttl = this.clampInteger(
      ttlSeconds ?? this.config.defaultTtlSeconds,
      1,
      3600,
      this.config.defaultTtlSeconds,
    );

    return ttl * 1000;
  }

  private resolveInflightTtlMs(dedupeTtlMs: number | undefined): number {
    return this.clampInteger(
      dedupeTtlMs ?? this.config.inflightTtlMs,
      500,
      30_000,
      this.config.inflightTtlMs,
    );
  }

  private resolveRuntimeConfig(): MemoryCacheRuntimeConfig {
    const apiConfig =
      this.configService.get<ApiEnvironmentConfig>("api") ?? undefined;
    const memoryCache = apiConfig?.memoryCache;

    return {
      enabled: memoryCache?.enabled ?? DEFAULT_MEMORY_CACHE_CONFIG.enabled,
      maxEntries: this.clampInteger(
        memoryCache?.maxEntries,
        100,
        10_000,
        DEFAULT_MEMORY_CACHE_CONFIG.maxEntries,
      ),
      defaultTtlSeconds: this.clampInteger(
        memoryCache?.defaultTtlSeconds,
        1,
        600,
        DEFAULT_MEMORY_CACHE_CONFIG.defaultTtlSeconds,
      ),
      inflightTtlMs: this.clampInteger(
        memoryCache?.inflightTtlMs,
        500,
        30_000,
        DEFAULT_MEMORY_CACHE_CONFIG.inflightTtlMs,
      ),
      adminVideosListTtlSeconds: this.clampInteger(
        memoryCache?.adminVideosListTtlSeconds,
        1,
        600,
        DEFAULT_MEMORY_CACHE_CONFIG.adminVideosListTtlSeconds,
      ),
      adminWebsitesListTtlSeconds: this.clampInteger(
        memoryCache?.adminWebsitesListTtlSeconds,
        1,
        600,
        DEFAULT_MEMORY_CACHE_CONFIG.adminWebsitesListTtlSeconds,
      ),
      publicWatchMetadataTtlSeconds: this.clampInteger(
        memoryCache?.publicWatchMetadataTtlSeconds,
        1,
        60,
        DEFAULT_MEMORY_CACHE_CONFIG.publicWatchMetadataTtlSeconds,
      ),
      mediaMetadataTtlSeconds: this.clampInteger(
        memoryCache?.mediaMetadataTtlSeconds,
        1,
        3600,
        DEFAULT_MEMORY_CACHE_CONFIG.mediaMetadataTtlSeconds,
      ),
    };
  }

  private clampInteger(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const numericValue =
      typeof value === "number" && Number.isInteger(value) ? value : fallback;

    return Math.min(Math.max(numericValue, min), max);
  }
}
