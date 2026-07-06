import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";

const defaultMemoryCacheConfig: MemoryCacheRuntimeConfig = {
  enabled: true,
  maxEntries: 1000,
  defaultTtlSeconds: 60,
  inflightTtlMs: 5000,
  adminVideosListTtlSeconds: 30,
  adminWebsitesListTtlSeconds: 60,
  publicWatchMetadataTtlSeconds: 10,
  mediaMetadataTtlSeconds: 300,
};

class FakeConfigService {
  constructor(private readonly memoryCache: MemoryCacheRuntimeConfig) {}

  get<T = unknown>(key: string): T | undefined {
    if (key === "api") {
      return { memoryCache: this.memoryCache } as T;
    }

    return undefined;
  }
}

function createMemoryCache(
  overrides: Partial<MemoryCacheRuntimeConfig> = {},
): MemoryCacheService {
  return new MemoryCacheService(
    new FakeConfigService({
      ...defaultMemoryCacheConfig,
      ...overrides,
    }) as never,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("MemoryCacheService", () => {
  it("calls loaders directly when disabled", async () => {
    const cache = createMemoryCache({ enabled: false });
    let loads = 0;

    cache.set("key", "cached");
    assert.equal(cache.get("key"), null);
    const first = await cache.getOrSet("key", async () => {
      loads += 1;
      return "first";
    });
    const second = await cache.getOrSet("key", async () => {
      loads += 1;
      return "second";
    });

    assert.equal(first, "first");
    assert.equal(second, "second");
    assert.equal(loads, 2);
    assert.equal(cache.getStats().enabled, false);
  });

  it("gets and sets cached values with TTL expiry", async () => {
    const cache = createMemoryCache();

    cache.set("key", "value", { ttlSeconds: 1 });
    assert.equal(cache.get("key"), "value");
    cache.set("short", "gone", { ttlSeconds: 1 });
    await sleep(1100);

    assert.equal(cache.get("short"), null);
  });

  it("evicts least-recently-used entries over maxEntries", () => {
    const cache = createMemoryCache({ maxEntries: 100 });

    for (let index = 0; index < 100; index += 1) {
      cache.set(`key-${index}`, index);
    }
    assert.equal(cache.get("key-0"), 0);
    cache.set("key-100", 100);

    assert.equal(cache.get("key-1"), null);
    assert.equal(cache.get("key-0"), 0);
    assert.equal(cache.get("key-100"), 100);
    assert.equal(cache.getStats().evictions, 1);
  });

  it("deletes by prefix and clears entries", () => {
    const cache = createMemoryCache();

    cache.set("admin:videos:1", 1);
    cache.set("admin:videos:2", 2);
    cache.set("admin:websites:1", 3);

    assert.equal(cache.deleteByPrefix("admin:videos:"), 2);
    assert.equal(cache.get("admin:videos:1"), null);
    assert.equal(cache.get("admin:websites:1"), 3);

    cache.clear();
    assert.equal(cache.getStats().size, 0);
  });

  it("dedupes concurrent getOrSet loaders and removes inflight entries", async () => {
    const cache = createMemoryCache();
    let loads = 0;

    const [first, second] = await Promise.all([
      cache.getOrSet("key", async () => {
        loads += 1;
        await sleep(20);
        return "value";
      }),
      cache.getOrSet("key", async () => {
        loads += 1;
        return "other";
      }),
    ]);

    assert.equal(first, "value");
    assert.equal(second, "value");
    assert.equal(loads, 1);
    assert.equal(cache.getStats().inflight, 0);
  });

  it("does not cache failed loaders", async () => {
    const cache = createMemoryCache();
    let loads = 0;

    await assert.rejects(
      cache.getOrSet("key", async () => {
        loads += 1;
        throw new Error("boom");
      }),
    );

    const value = await cache.getOrSet("key", async () => {
      loads += 1;
      return "recovered";
    });

    assert.equal(value, "recovered");
    assert.equal(loads, 2);
  });
});
