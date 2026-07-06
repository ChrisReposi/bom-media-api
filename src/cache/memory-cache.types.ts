export type CacheSetOptions = {
  ttlSeconds?: number;
};

export type GetOrSetOptions = CacheSetOptions & {
  dedupeKey?: string;
  dedupeTtlMs?: number;
};

export type MemoryCacheStats = {
  enabled: boolean;
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  inflight: number;
};

export type MemoryCacheRuntimeConfig = {
  enabled: boolean;
  maxEntries: number;
  defaultTtlSeconds: number;
  inflightTtlMs: number;
  adminVideosListTtlSeconds: number;
  adminWebsitesListTtlSeconds: number;
  publicWatchMetadataTtlSeconds: number;
  mediaMetadataTtlSeconds: number;
};
