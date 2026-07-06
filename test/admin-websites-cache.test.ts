import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";
import {
  AuditStatus,
  WebsiteStatus,
  type DomainGroup,
  type Website,
  type WebsiteDomain,
} from "../src/generated/prisma/client";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";

type FakeWebsiteRecord = Website & {
  domains: WebsiteDomain[];
  domainGroup: DomainGroup | null;
};

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

class FakeMemoryCacheConfigService {
  get<T = unknown>(key: string): T | undefined {
    if (key === "api") {
      return { memoryCache: defaultMemoryCacheConfig } as T;
    }

    return undefined;
  }
}

class FakeConfigService {
  get<T = string>(): T | undefined {
    return undefined;
  }
}

class FakeCorsOriginService {
  clearCalls = 0;

  clearDomainOriginCache(): void {
    this.clearCalls += 1;
  }
}

class FakePrismaService {
  readonly websites: FakeWebsiteRecord[] = [createWebsite("website-1")];
  findManyCalls = 0;
  countCalls = 0;
  createCalls = 0;

  website = {
    findMany: async (args: {
      skip?: number;
      take?: number;
    }): Promise<FakeWebsiteRecord[]> => {
      this.findManyCalls += 1;
      return this.websites.slice(
        args.skip ?? 0,
        (args.skip ?? 0) + (args.take ?? 20),
      );
    },
    count: async (): Promise<number> => {
      this.countCalls += 1;
      return this.websites.length;
    },
    findUnique: async (args: {
      where: { id?: string; slug?: string };
    }): Promise<Pick<Website, "id"> | FakeWebsiteRecord | null> => {
      if (args.where.slug !== undefined) {
        return (
          this.websites.find((website) => website.slug === args.where.slug) ??
          null
        );
      }

      if (args.where.id !== undefined) {
        return (
          this.websites.find((website) => website.id === args.where.id) ?? null
        );
      }

      return null;
    },
    create: async (args: {
      data: {
        name: string;
        slug: string;
        defaultTitle?: string | null;
        defaultDescription?: string | null;
        status: WebsiteStatus;
      };
    }): Promise<FakeWebsiteRecord> => {
      this.createCalls += 1;
      const website = createWebsite(`website-${this.websites.length + 1}`, {
        name: args.data.name,
        slug: args.data.slug,
        defaultTitle: args.data.defaultTitle ?? null,
        defaultDescription: args.data.defaultDescription ?? null,
        status: args.data.status,
      });
      this.websites.push(website);
      return website;
    },
  };

  adminAuditLog = {
    create: async (args: {
      data: {
        action: string;
        status: AuditStatus;
      };
    }): Promise<void> => {
      assert.equal(args.data.status, AuditStatus.SUCCESS);
    },
  };

  async $transaction<T extends readonly unknown[]>(
    promises: T,
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
    return Promise.all(promises) as Promise<{ [K in keyof T]: Awaited<T[K]> }>;
  }
}

function createWebsite(
  id: string,
  overrides: Partial<FakeWebsiteRecord> = {},
): FakeWebsiteRecord {
  return {
    id,
    name: `Website ${id}`,
    slug: id,
    defaultTitle: null,
    defaultDescription: null,
    status: WebsiteStatus.ACTIVE,
    domainGroupId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    domains: [],
    domainGroup: null,
    ...overrides,
  };
}

function createMemoryCache(): MemoryCacheService {
  return new MemoryCacheService(new FakeMemoryCacheConfigService() as never);
}

function createService(): {
  prisma: FakePrismaService;
  service: AdminWebsitesService;
} {
  const prisma = new FakePrismaService();
  const service = new AdminWebsitesService(
    prisma as never,
    new FakeConfigService() as never,
    new FakeCorsOriginService() as never,
    createMemoryCache(),
  );

  return { prisma, service };
}

describe("AdminWebsitesService list cache", () => {
  it("caches identical website list queries", async () => {
    const { prisma, service } = createService();
    const query = { page: 1, limit: 20, status: WebsiteStatus.ACTIVE };

    await service.listWebsites(query);
    await service.listWebsites(query);
    await service.listWebsites({ ...query, page: 2 });

    assert.equal(prisma.findManyCalls, 2);
    assert.equal(prisma.countCalls, 2);
  });

  it("invalidates website list cache after successful website mutation", async () => {
    const { prisma, service } = createService();
    const query = { page: 1, limit: 20, status: WebsiteStatus.ACTIVE };

    await service.listWebsites(query);
    await service.listWebsites(query);
    assert.equal(prisma.findManyCalls, 1);

    await service.createWebsite(
      {
        name: "New Website",
        slug: "new-website",
        status: WebsiteStatus.ACTIVE,
      },
      "admin-1",
    );
    await service.listWebsites(query);

    assert.equal(prisma.createCalls, 1);
    assert.equal(prisma.findManyCalls, 2);
  });
});
