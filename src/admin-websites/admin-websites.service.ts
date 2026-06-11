import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  AssignmentStatus,
  AuditStatus,
  DomainGroupStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
  type DomainGroup,
  type ShareLink,
  type ShareLinkVideo,
  type VideoAsset,
  type Website,
  type WebsiteDomain,
  type WebsiteVideo,
} from "../generated/prisma/client";
import { hashShareToken } from "../public/utils/share-token.util";
import type { ActivateWebsiteDomainDto } from "./dto/activate-website-domain.dto";
import type { AssignWebsiteVideosDto } from "./dto/assign-website-videos.dto";
import type { ClaimCurrentWebsiteDomainDto } from "./dto/claim-current-website-domain.dto";
import type { AssignDomainToWebsiteDto } from "./dto/assign-domain-to-website.dto";
import type { CreateDomainDto } from "./dto/create-domain.dto";
import type { CreateDomainGroupDto } from "./dto/create-domain-group.dto";
import type { CreateShareLinkDto } from "./dto/create-share-link.dto";
import type { CreateWebsiteDomainDto } from "./dto/create-website-domain.dto";
import type { CreateWebsiteDto } from "./dto/create-website.dto";
import type { ListDomainsQueryDto } from "./dto/list-domains-query.dto";
import type { ListDomainGroupsQueryDto } from "./dto/list-domain-groups-query.dto";
import type { ListWebsitesQueryDto } from "./dto/list-websites-query.dto";
import type { UpdateDomainDto } from "./dto/update-domain.dto";
import type { UpdateDomainGroupDto } from "./dto/update-domain-group.dto";
import type { UpdateWebsiteDomainDto } from "./dto/update-website-domain.dto";
import type { UpdateWebsiteDto } from "./dto/update-website.dto";
import {
  AdminDomainUsageStatus,
  type AdminDomainListResponse,
  type AdminDomainResponse,
  AdminDomainGroupListResponse,
  AdminDomainGroupResponse,
  AdminWebsiteAssignedVideoResponse,
  AdminWebsiteDetailResponse,
  AdminWebsiteDomainResponse,
  AdminWebsiteListResponse,
  AdminWebsiteResponse,
  AssignWebsiteVideosResponse,
  DisableDomainGroupResponse,
  DisableWebsiteResponse,
} from "./types/admin-website-response.type";
import type {
  AdminShareLinkListResponse,
  AdminShareLinkResponse,
  CreateShareLinkResponse,
  RevokeShareLinkResponse,
} from "./types/admin-share-link-response.type";
import {
  normalizeDomain,
  normalizeWebsiteSlug,
} from "./utils/normalize-domain.util";
import { CorsOriginService } from "../security/cors-origin.service";
import {
  buildPublicShareUrl,
  generateShareToken,
} from "./utils/share-url.util";

type WebsiteWithRelations = Website & {
  domains: WebsiteDomain[];
  domainGroup: DomainGroup | null;
};

type DomainWithRelations = WebsiteDomain & {
  website: Pick<Website, "id" | "name" | "slug" | "status"> | null;
  domainGroup: DomainGroup | null;
};

type WebsiteVideoWithVideo = WebsiteVideo & {
  video: VideoAsset;
};

type ShareLinkWithVideos = ShareLink & {
  shareLinkVideos: Array<ShareLinkVideo & { video: VideoAsset }>;
};

type AuditAction =
  | "DOMAIN_CREATE"
  | "DOMAIN_UPDATE"
  | "DOMAIN_DISABLE"
  | "DOMAIN_ACTIVATE"
  | "DOMAIN_ASSIGN"
  | "DOMAIN_UNASSIGN"
  | "DOMAIN_TRANSFER_ATTEMPT_REJECTED"
  | "DOMAIN_GROUP_CREATE"
  | "DOMAIN_GROUP_UPDATE"
  | "DOMAIN_GROUP_DISABLE"
  | "WEBSITE_CREATE"
  | "WEBSITE_UPDATE"
  | "WEBSITE_DISABLE"
  | "WEBSITE_DOMAIN_CREATE"
  | "WEBSITE_DOMAIN_UPDATE"
  | "WEBSITE_DOMAIN_DISABLE"
  | "WEBSITE_DOMAIN_ACTIVATE"
  | "WEBSITE_DOMAIN_CLAIM_CURRENT"
  | "WEBSITE_VIDEOS_ASSIGN"
  | "SHARE_LINK_CREATE"
  | "SHARE_LINK_REVOKE";

@Injectable()
export class AdminWebsitesService {
  private readonly logger = new Logger(AdminWebsitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly corsOriginService: CorsOriginService,
  ) {}

  async listDomainGroups(
    query: ListDomainGroupsQueryDto,
  ): Promise<AdminDomainGroupListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 100;
    const skip = (page - 1) * limit;
    const where: Prisma.DomainGroupWhereInput = {};

    if (query.status !== undefined) {
      where.status = query.status;
    }

    if (query.search !== undefined && query.search.trim() !== "") {
      const search = query.search.trim();
      where.OR = [
        { key: { contains: search.toLowerCase() } },
        { name: { contains: search } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.domainGroup.findMany({
        where,
        orderBy: [{ status: "asc" }, { key: "asc" }],
        skip,
        take: limit,
      }),
      this.prisma.domainGroup.count({ where }),
    ]);

    return {
      items: items.map((group) => this.toDomainGroupResponse(group)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getDomainGroup(id: string): Promise<AdminDomainGroupResponse> {
    const group = await this.prisma.domainGroup.findUnique({ where: { id } });

    if (group === null) {
      throw new NotFoundException("Domain group not found.");
    }

    return this.toDomainGroupResponse(group);
  }

  async createDomainGroup(
    dto: CreateDomainGroupDto,
    adminId: string,
  ): Promise<AdminDomainGroupResponse> {
    const key = this.normalizeDomainGroupKey(dto.key);
    await this.ensureDomainGroupKeyAvailable(key);

    const group = await this.prisma.domainGroup.create({
      data: {
        key,
        name: dto.name.trim(),
        description: this.trimNullable(dto.description),
        status: dto.status ?? DomainGroupStatus.ACTIVE,
      },
    });

    await this.writeAudit(
      adminId,
      "DOMAIN_GROUP_CREATE",
      "DomainGroup",
      group.id,
      { key: group.key },
    );

    return this.toDomainGroupResponse(group);
  }

  async updateDomainGroup(
    id: string,
    dto: UpdateDomainGroupDto,
    adminId: string,
  ): Promise<AdminDomainGroupResponse> {
    const existingGroup = await this.prisma.domainGroup.findUnique({
      where: { id },
      select: { id: true, key: true },
    });

    if (existingGroup === null) {
      throw new NotFoundException("Domain group not found.");
    }

    const data: Prisma.DomainGroupUpdateInput = {};

    if (dto.key !== undefined) {
      const key = this.normalizeDomainGroupKey(dto.key);
      await this.ensureDomainGroupKeyAvailable(key, existingGroup.id);
      data.key = key;
    }

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.description !== undefined) {
      data.description = this.trimNullable(dto.description);
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    const group = await this.prisma.domainGroup.update({
      where: { id },
      data,
    });

    await this.writeAudit(
      adminId,
      "DOMAIN_GROUP_UPDATE",
      "DomainGroup",
      group.id,
      { key: group.key, status: group.status },
    );

    return this.toDomainGroupResponse(group);
  }

  async disableDomainGroup(
    id: string,
    adminId: string,
  ): Promise<DisableDomainGroupResponse> {
    const existingGroup = await this.prisma.domainGroup.findUnique({
      where: { id },
      select: { id: true, key: true, status: true },
    });

    if (existingGroup === null) {
      throw new NotFoundException("Domain group not found.");
    }

    if (existingGroup.status !== DomainGroupStatus.DISABLED) {
      await this.prisma.domainGroup.update({
        where: { id },
        data: { status: DomainGroupStatus.DISABLED },
      });

      await this.writeAudit(
        adminId,
        "DOMAIN_GROUP_DISABLE",
        "DomainGroup",
        id,
        { key: existingGroup.key, previousStatus: existingGroup.status },
      );
    }

    return { message: "Domain group disabled successfully." };
  }

  async listDomains(query: ListDomainsQueryDto): Promise<AdminDomainListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;
    const where = this.buildDomainWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.websiteDomain.findMany({
        where,
        include: {
          website: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
            },
          },
          domainGroup: true,
        },
        orderBy: [{ status: "asc" }, { domain: "asc" }],
        skip,
        take: limit,
      }),
      this.prisma.websiteDomain.count({ where }),
    ]);

    return {
      items: items.map((domain) => this.toAdminDomainResponse(domain)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getDomain(domainId: string): Promise<AdminDomainResponse> {
    return this.toAdminDomainResponse(await this.getDomainWithRelations(domainId));
  }

  async createStandaloneDomain(
    dto: CreateDomainDto,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const domain = this.parseDomain(dto.domain);
    this.ensureLocalhostDomainAllowed(domain);
    await this.ensureDomainAvailable(domain);
    const domainGroupId = await this.resolveActiveDomainGroupId({
      domainGroupKey: dto.domainGroupKey,
      domainGroupId: dto.domainGroupId,
    });

    const domainRecord = await this.prisma.websiteDomain.create({
      data: {
        domain,
        status: dto.status ?? DomainStatus.ACTIVE,
        ...(domainGroupId ? { domainGroupId } : {}),
      },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    await this.writeAudit(adminId, "DOMAIN_CREATE", "WebsiteDomain", domainRecord.id, {
      domain: domainRecord.domain,
      domainGroupId: domainRecord.domainGroupId,
      status: domainRecord.status,
    });
    this.clearCorsDomainCache();

    return this.toAdminDomainResponse(domainRecord);
  }

  async updateStandaloneDomain(
    domainId: string,
    dto: UpdateDomainDto,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const existingDomain = await this.getDomainWithRelations(domainId);
    const data: Prisma.WebsiteDomainUpdateInput = {};

    if (dto.domain !== undefined) {
      const domain = this.parseDomain(dto.domain);
      this.ensureLocalhostDomainAllowed(domain);
      await this.ensureDomainAvailable(domain, existingDomain.id);
      data.domain = domain;
    }

    if (dto.status === DomainStatus.DISABLED && existingDomain.websiteId !== null) {
      throw new BadRequestException(
        "Cannot disable a domain that is assigned to a website. Unassign it first.",
      );
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === DomainStatus.DISABLED) {
        data.isPrimary = false;
      }
    }

    if (dto.domainGroupKey !== undefined || dto.domainGroupId !== undefined) {
      const domainGroupId = await this.resolveActiveDomainGroupId({
        domainGroupKey: dto.domainGroupKey,
        domainGroupId: dto.domainGroupId,
      });
      data.domainGroup =
        domainGroupId === null
          ? { disconnect: true }
          : { connect: { id: domainGroupId } };
    }

    const domainRecord = await this.prisma.websiteDomain.update({
      where: { id: domainId },
      data,
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    await this.writeAudit(adminId, "DOMAIN_UPDATE", "WebsiteDomain", domainRecord.id, {
      domain: domainRecord.domain,
      domainGroupId: domainRecord.domainGroupId,
      status: domainRecord.status,
    });
    this.clearCorsDomainCache();

    return this.toAdminDomainResponse(domainRecord);
  }

  async disableStandaloneDomain(
    domainId: string,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const existingDomain = await this.getDomainWithRelations(domainId);

    if (existingDomain.websiteId !== null) {
      throw new BadRequestException(
        "Cannot disable a domain that is assigned to a website. Unassign it first.",
      );
    }

    const domainRecord = await this.prisma.websiteDomain.update({
      where: { id: domainId },
      data: {
        status: DomainStatus.DISABLED,
        isPrimary: false,
      },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    await this.writeAudit(
      adminId,
      "DOMAIN_DISABLE",
      "WebsiteDomain",
      domainRecord.id,
      { domain: domainRecord.domain },
    );
    this.clearCorsDomainCache();

    return this.toAdminDomainResponse(domainRecord);
  }

  async activateStandaloneDomain(
    domainId: string,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const domainRecord = await this.prisma.websiteDomain.update({
      where: { id: domainId },
      data: { status: DomainStatus.ACTIVE },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    await this.writeAudit(
      adminId,
      "DOMAIN_ACTIVATE",
      "WebsiteDomain",
      domainRecord.id,
      { domain: domainRecord.domain },
    );
    this.clearCorsDomainCache();

    return this.toAdminDomainResponse(domainRecord);
  }

  async assignDomainToWebsite(
    domainId: string,
    dto: AssignDomainToWebsiteDto,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const domainRecord = await this.assignDomainToWebsiteRecord({
      domainId,
      websiteId: dto.websiteId,
      replaceExisting: dto.replaceExisting === true,
      adminId,
    });

    return this.toAdminDomainResponse(domainRecord);
  }

  async unassignDomainFromWebsite(
    domainId: string,
    adminId: string,
  ): Promise<AdminDomainResponse> {
    const existingDomain = await this.getDomainWithRelations(domainId);

    if (existingDomain.websiteId === null) {
      return this.toAdminDomainResponse(existingDomain);
    }

    const previousWebsiteId = existingDomain.websiteId;
    const domainRecord = await this.prisma.websiteDomain.update({
      where: { id: domainId },
      data: {
        website: { disconnect: true },
        isPrimary: false,
      },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    await this.writeAudit(
      adminId,
      "DOMAIN_UNASSIGN",
      "WebsiteDomain",
      domainRecord.id,
      { domain: domainRecord.domain, previousWebsiteId },
    );
    this.clearCorsDomainCache();

    return this.toAdminDomainResponse(domainRecord);
  }

  async listWebsites(
    query: ListWebsitesQueryDto,
  ): Promise<AdminWebsiteListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = this.buildWebsiteWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.website.findMany({
        where,
        include: {
          domains: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
          domainGroup: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.website.count({ where }),
    ]);

    return {
      items: items.map((website) => this.toWebsiteResponse(website)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getWebsite(id: string): Promise<AdminWebsiteDetailResponse> {
    const website = await this.prisma.website.findUnique({
      where: { id },
      include: {
        domains: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        domainGroup: true,
      },
    });

    if (website === null) {
      throw new NotFoundException("Website not found.");
    }

    const [assignedVideos, recentShareLinks] = await Promise.all([
      this.prisma.websiteVideo.findMany({
        where: { websiteId: id },
        include: { video: true },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.shareLink.findMany({
        where: { websiteId: id },
        include: {
          shareLinkVideos: {
            include: { video: true },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    return {
      ...this.toWebsiteResponse(website),
      assignedVideos: assignedVideos.map((assignment) =>
        this.toAssignedVideoResponse(assignment),
      ),
      recentShareLinks: recentShareLinks.map((shareLink) =>
        this.toShareLinkResponse(shareLink, null),
      ),
    };
  }

  async createWebsite(
    dto: CreateWebsiteDto,
    adminId: string,
  ): Promise<AdminWebsiteResponse> {
    const slug = normalizeWebsiteSlug(dto.slug);
    if (!slug) {
      throw new BadRequestException("Website slug is invalid.");
    }

    await this.ensureWebsiteSlugAvailable(slug);

    const domainGroupId = await this.resolveActiveDomainGroupId({
      domainGroupKey: dto.domainGroupKey,
      domainGroupId: dto.domainGroupId,
    });

    const website = await this.prisma.website.create({
      data: {
        name: dto.name.trim(),
        slug,
        defaultTitle: this.trimNullable(dto.defaultTitle),
        defaultDescription: this.trimNullable(
          dto.defaultDescription ?? dto.description,
        ),
        ...(domainGroupId ? { domainGroupId } : {}),
        status: dto.status ?? WebsiteStatus.ACTIVE,
      },
      include: { domains: true, domainGroup: true },
    });

    await this.writeAudit(adminId, "WEBSITE_CREATE", "Website", website.id, {
      slug: website.slug,
    });

    return this.toWebsiteResponse(website);
  }

  async updateWebsite(
    id: string,
    dto: UpdateWebsiteDto,
    adminId: string,
  ): Promise<AdminWebsiteResponse> {
    const existingWebsite = await this.prisma.website.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });

    if (existingWebsite === null) {
      throw new NotFoundException("Website not found.");
    }

    const data: Prisma.WebsiteUpdateInput = {};

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.slug !== undefined) {
      const slug = normalizeWebsiteSlug(dto.slug);
      if (!slug) {
        throw new BadRequestException("Website slug is invalid.");
      }
      await this.ensureWebsiteSlugAvailable(slug, existingWebsite.id);
      data.slug = slug;
    }

    if (dto.defaultTitle !== undefined) {
      data.defaultTitle = this.trimNullable(dto.defaultTitle);
    }

    if (dto.defaultDescription !== undefined || dto.description !== undefined) {
      data.defaultDescription = this.trimNullable(
        dto.defaultDescription ?? dto.description,
      );
    }

    if (dto.domainGroupKey !== undefined || dto.domainGroupId !== undefined) {
      const domainGroupId = await this.resolveActiveDomainGroupId({
        domainGroupKey: dto.domainGroupKey,
        domainGroupId: dto.domainGroupId,
      });
      data.domainGroup =
        domainGroupId === null
          ? { disconnect: true }
          : { connect: { id: domainGroupId } };
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    const website = await this.prisma.website.update({
      where: { id },
      data,
      include: { domains: true, domainGroup: true },
    });

    await this.writeAudit(adminId, "WEBSITE_UPDATE", "Website", website.id, {
      status: website.status,
    });
    if (dto.status !== undefined) {
      this.clearCorsDomainCache();
    }

    return this.toWebsiteResponse(website);
  }

  async disableWebsite(
    id: string,
    adminId: string,
  ): Promise<DisableWebsiteResponse> {
    const existingWebsite = await this.prisma.website.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (existingWebsite === null) {
      throw new NotFoundException("Website not found.");
    }

    if (existingWebsite.status !== WebsiteStatus.DISABLED) {
      await this.prisma.website.update({
        where: { id },
        data: { status: WebsiteStatus.DISABLED },
      });

      await this.writeAudit(adminId, "WEBSITE_DISABLE", "Website", id, {
        previousStatus: existingWebsite.status,
      });
      this.clearCorsDomainCache();
    }

    return { message: "Website disabled successfully." };
  }

  async createDomain(
    websiteId: string,
    dto: CreateWebsiteDomainDto,
    adminId: string,
  ): Promise<AdminWebsiteDomainResponse> {
    const website = await this.getActiveWebsiteForDomainAssignment(websiteId);
    const existingDomainCount = await this.prisma.websiteDomain.count({
      where: { websiteId },
    });

    if (existingDomainCount > 0) {
      throw new BadRequestException(
        "This website already has a domain. Assign an available domain with replaceExisting to replace it.",
      );
    }

    const domain = this.parseDomain(dto.domain);
    this.ensureLocalhostDomainAllowed(domain);
    await this.ensureDomainAvailable(domain);
    const status = dto.status ?? DomainStatus.ACTIVE;

    if (status !== DomainStatus.ACTIVE) {
      throw new BadRequestException("Assigned domains must be ACTIVE.");
    }

    const domainRecord = await this.prisma.websiteDomain.create({
      data: {
        websiteId,
        ...(website.domainGroupId ? { domainGroupId: website.domainGroupId } : {}),
        domain,
        isPrimary: true,
        status,
      },
    });

    await this.writeAudit(
      adminId,
      "WEBSITE_DOMAIN_CREATE",
      "WebsiteDomain",
      domainRecord.id,
      { domain: domainRecord.domain, websiteId },
    );
    this.clearCorsDomainCache();

    return this.toDomainResponse(domainRecord);
  }

  async updateDomain(
    websiteId: string,
    domainId: string,
    dto: UpdateWebsiteDomainDto,
    adminId: string,
  ): Promise<AdminWebsiteDomainResponse> {
    const existingDomain = await this.getDomainForWebsite(websiteId, domainId);
    const data: Prisma.WebsiteDomainUpdateInput = {};

    if (dto.domain !== undefined) {
      const domain = this.parseDomain(dto.domain);
      this.ensureLocalhostDomainAllowed(domain);
      await this.ensureDomainAvailable(domain, existingDomain.id);
      data.domain = domain;
    }

    if (dto.status !== undefined) {
      if (dto.status === DomainStatus.DISABLED) {
        throw new BadRequestException(
          "Cannot disable a domain that is assigned to a website. Unassign it first.",
        );
      }
      data.status = dto.status;
    }

    if (dto.isPrimary !== undefined) {
      data.isPrimary = dto.isPrimary;
    }

    const finalStatus = dto.status ?? existingDomain.status;
    const requestedIsPrimary = dto.isPrimary ?? existingDomain.isPrimary;
    const finalIsPrimary =
      finalStatus === DomainStatus.DISABLED ? false : requestedIsPrimary;
    if (dto.isPrimary === true && finalStatus !== DomainStatus.ACTIVE) {
      throw new BadRequestException("Only ACTIVE domains can be primary.");
    }

    const domainRecord = await this.prisma.$transaction(async (tx) => {
      if (finalIsPrimary && finalStatus === DomainStatus.ACTIVE) {
        await tx.websiteDomain.updateMany({
          where: { websiteId, id: { not: domainId } },
          data: { isPrimary: false },
        });
      }

      return tx.websiteDomain.update({
        where: { id: domainId },
        data,
      });
    });

    await this.writeAudit(
      adminId,
      "WEBSITE_DOMAIN_UPDATE",
      "WebsiteDomain",
      domainRecord.id,
      { domain: domainRecord.domain, websiteId },
    );
    this.clearCorsDomainCache();

    return this.toDomainResponse(domainRecord);
  }

  async disableDomain(
    websiteId: string,
    domainId: string,
    adminId: string,
  ): Promise<AdminWebsiteDomainResponse> {
    await this.getDomainForWebsite(websiteId, domainId);

    await this.writeAudit(
      adminId,
      "DOMAIN_TRANSFER_ATTEMPT_REJECTED",
      "WebsiteDomain",
      domainId,
      { reason: "DISABLE_ASSIGNED_DOMAIN_REJECTED", websiteId },
    );

    throw new BadRequestException(
      "Cannot disable a domain that is assigned to a website. Unassign it first.",
    );
  }

  async activateDomain(
    websiteId: string,
    domainId: string,
    dto: ActivateWebsiteDomainDto,
    adminId: string,
  ): Promise<AdminWebsiteDomainResponse> {
    await this.getDomainForWebsite(websiteId, domainId);
    const otherActiveDomainCount = await this.prisma.websiteDomain.count({
      where: {
        websiteId,
        id: { not: domainId },
        status: DomainStatus.ACTIVE,
      },
    });

    if (otherActiveDomainCount > 0) {
      throw new BadRequestException(
        "This website already has an active domain. Unassign or replace it first.",
      );
    }

    const shouldBePrimary = dto.isPrimary === true;

    const domainRecord = await this.prisma.$transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx.websiteDomain.updateMany({
          where: { websiteId, id: { not: domainId } },
          data: { isPrimary: false },
        });
      }

      return tx.websiteDomain.update({
        where: { id: domainId },
        data: {
          status: DomainStatus.ACTIVE,
          ...(shouldBePrimary ? { isPrimary: true } : {}),
        },
      });
    });

    await this.writeAudit(
      adminId,
      "WEBSITE_DOMAIN_ACTIVATE",
      "WebsiteDomain",
      domainRecord.id,
      {
        domain: domainRecord.domain,
        websiteId,
        isPrimary: domainRecord.isPrimary,
      },
    );
    this.clearCorsDomainCache();

    return this.toDomainResponse(domainRecord);
  }

  async claimCurrentDomain(
    websiteId: string,
    dto: ClaimCurrentWebsiteDomainDto,
    adminId: string,
  ): Promise<AdminWebsiteDomainResponse> {
    const website = await this.getActiveWebsiteForDomainAssignment(websiteId);

    const domain = this.parseClaimHost(dto.host);
    this.ensureLocalhostDomainAllowed(domain);

    const existingDomain = await this.prisma.websiteDomain.findUnique({
      where: { domain },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    if (existingDomain?.websiteId === websiteId) {
      return this.toDomainResponse(existingDomain);
    }

    if (
      existingDomain?.websiteId !== null &&
      existingDomain?.websiteId !== undefined
    ) {
      throw new BadRequestException(
        `Domain is already in use by website "${existingDomain.website?.name ?? existingDomain.websiteId}".`,
      );
    }

    if (existingDomain?.status === DomainStatus.DISABLED) {
      throw new BadRequestException(
        "Domain is DISABLED. Activate it before assignment.",
      );
    }

    const existingWebsiteDomainCount = await this.prisma.websiteDomain.count({
      where: { websiteId },
    });

    if (existingWebsiteDomainCount > 0) {
      throw new BadRequestException(
        "This website already has a domain. Enable replaceExisting to replace it.",
      );
    }

    const domainRecord =
      existingDomain ??
      (await this.prisma.websiteDomain.create({
        data: {
          domain,
          status: DomainStatus.ACTIVE,
          ...(website.domainGroupId
            ? { domainGroupId: website.domainGroupId }
            : {}),
        },
        include: {
          website: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
            },
          },
          domainGroup: true,
        },
      }));

    const assignedDomain = await this.assignDomainToWebsiteRecord({
      domainId: domainRecord.id,
      websiteId,
      replaceExisting: false,
      adminId,
    });

    await this.writeAudit(
      adminId,
      "WEBSITE_DOMAIN_CLAIM_CURRENT",
      "WebsiteDomain",
      assignedDomain.id,
      {
        domain: assignedDomain.domain,
        websiteId,
        isPrimary: assignedDomain.isPrimary,
      },
    );
    this.clearCorsDomainCache();

    return this.toDomainResponse(assignedDomain);
  }

  async listAssignedVideos(
    websiteId: string,
  ): Promise<AssignWebsiteVideosResponse> {
    await this.ensureWebsiteExists(websiteId);

    const assignments = await this.prisma.websiteVideo.findMany({
      where: { websiteId },
      include: { video: true },
      orderBy: { sortOrder: "asc" },
    });

    return {
      items: assignments.map((assignment) =>
        this.toAssignedVideoResponse(assignment),
      ),
    };
  }

  async assignVideos(
    websiteId: string,
    dto: AssignWebsiteVideosDto,
    adminId: string,
  ): Promise<AssignWebsiteVideosResponse> {
    if (
      dto.featuredVideoId !== undefined &&
      !dto.videoIds.includes(dto.featuredVideoId)
    ) {
      throw new BadRequestException(
        "featuredVideoId must be included in videoIds.",
      );
    }

    await this.ensureActiveWebsiteExists(websiteId);
    const videos = await this.getReadyVideosByIds(dto.videoIds);
    this.ensureAllRequestedVideosFound(dto.videoIds, videos);

    await this.prisma.$transaction(async (tx) => {
      await tx.websiteVideo.deleteMany({ where: { websiteId } });

      if (videos.length > 0) {
        await tx.websiteVideo.createMany({
          data: dto.videoIds.map((videoId, index) => ({
            websiteId,
            videoId,
            sortOrder: index,
            isFeatured: dto.featuredVideoId === videoId,
            status: AssignmentStatus.ACTIVE,
          })),
        });
      }
    });

    const assignments = await this.prisma.websiteVideo.findMany({
      where: { websiteId },
      include: { video: true },
      orderBy: { sortOrder: "asc" },
    });

    await this.writeAudit(
      adminId,
      "WEBSITE_VIDEOS_ASSIGN",
      "Website",
      websiteId,
      { count: assignments.length },
    );

    return {
      items: assignments.map((assignment) =>
        this.toAssignedVideoResponse(assignment),
      ),
    };
  }

  async listShareLinks(websiteId: string): Promise<AdminShareLinkListResponse> {
    await this.ensureWebsiteExists(websiteId);

    const shareLinks = await this.prisma.shareLink.findMany({
      where: { websiteId },
      include: {
        shareLinkVideos: {
          include: { video: true },
          orderBy: { sortOrder: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      items: shareLinks.map((shareLink) =>
        this.toShareLinkResponse(shareLink, null),
      ),
    };
  }

  async createShareLink(
    websiteId: string,
    dto: CreateShareLinkDto,
    adminId: string,
  ): Promise<CreateShareLinkResponse> {
    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      throw new BadRequestException("SHARE_TOKEN_PEPPER is required.");
    }

    await this.ensureActiveWebsiteExists(websiteId);
    const selectedVideoIds = await this.resolveShareLinkVideoIds(
      websiteId,
      dto,
    );
    if (selectedVideoIds.length === 0) {
      throw new BadRequestException("No playable videos selected.");
    }

    const videos = await this.getReadyPlayableVideosByIds(selectedVideoIds);
    this.ensureAllRequestedVideosFound(selectedVideoIds, videos, (videoId) => {
      return `Video ${videoId} is not READY, not playable, or does not exist. READY direct/upload, embed, and DB_BLOB videos with binary data can be attached to a share link.`;
    });

    const domain = await this.getPreferredActiveDomain(websiteId);
    const rawToken = generateShareToken();
    const tokenHash = hashShareToken({ token: rawToken, pepper: tokenPepper });
    const publicUrl = buildPublicShareUrl({
      domain,
      token: rawToken,
      protocol: this.getConfiguredPublicSiteProtocol(domain),
    });

    const shareLink = await this.prisma.$transaction(async (tx) => {
      const createdShareLink = await tx.shareLink.create({
        data: {
          websiteId,
          tokenHash,
          label: this.trimNullable(dto.label),
          expiresAt: this.parseNullableDate(dto.expiresAt),
          maxViews: dto.maxViews ?? null,
          status: ShareLinkStatus.ACTIVE,
        },
      });

      await tx.shareLinkVideo.createMany({
        data: selectedVideoIds.map((videoId, index) => ({
          shareLinkId: createdShareLink.id,
          videoId,
          sortOrder: index,
        })),
      });

      return tx.shareLink.findUniqueOrThrow({
        where: { id: createdShareLink.id },
        include: {
          shareLinkVideos: {
            include: { video: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
    });

    await this.writeAudit(
      adminId,
      "SHARE_LINK_CREATE",
      "ShareLink",
      shareLink.id,
      { websiteId, videoCount: shareLink.shareLinkVideos.length },
    );

    return {
      message: "Share link created successfully.",
      shareLink: this.toShareLinkResponse(shareLink, publicUrl),
      rawToken,
      publicUrl,
    };
  }

  async revokeShareLink(
    shareLinkId: string,
    adminId: string,
  ): Promise<RevokeShareLinkResponse> {
    const existingShareLink = await this.prisma.shareLink.findUnique({
      where: { id: shareLinkId },
      select: { id: true, status: true },
    });

    if (existingShareLink === null) {
      throw new NotFoundException("Share link not found.");
    }

    if (existingShareLink.status !== ShareLinkStatus.REVOKED) {
      await this.prisma.shareLink.update({
        where: { id: shareLinkId },
        data: { status: ShareLinkStatus.REVOKED },
      });
    }

    const shareLink = await this.prisma.shareLink.findUniqueOrThrow({
      where: { id: shareLinkId },
      include: {
        shareLinkVideos: {
          include: { video: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    await this.writeAudit(
      adminId,
      "SHARE_LINK_REVOKE",
      "ShareLink",
      shareLink.id,
      { previousStatus: existingShareLink.status },
    );

    return {
      message: "Share link revoked successfully.",
      shareLink: this.toShareLinkResponse(shareLink, null),
    };
  }

  private buildWebsiteWhere(
    query: ListWebsitesQueryDto,
  ): Prisma.WebsiteWhereInput {
    const where: Prisma.WebsiteWhereInput = {};

    if (query.status !== undefined) {
      where.status = query.status;
    }

    if (query.domain !== undefined && query.domain.trim() !== "") {
      const domain = this.parseDomain(query.domain);
      where.domains = {
        some: {
          domain: { contains: domain },
        },
      };
    }

    if (
      query.domainGroupKey !== undefined &&
      query.domainGroupKey.trim() !== ""
    ) {
      where.domainGroup = {
        is: {
          key: this.normalizeDomainGroupKey(query.domainGroupKey),
        },
      };
    }

    if (query.search !== undefined && query.search.trim() !== "") {
      const search = query.search.trim();
      const normalizedSearchHost = normalizeDomain(search);
      where.OR = [
        { name: { contains: search } },
        { slug: { contains: search } },
        {
          domains: {
            some: {
              domain: {
                contains: normalizedSearchHost ?? search.toLowerCase(),
              },
            },
          },
        },
        {
          domainGroup: {
            is: {
              OR: [
                { key: { contains: search.toLowerCase() } },
                { name: { contains: search } },
              ],
            },
          },
        },
      ];
    }

    return where;
  }

  private buildDomainWhere(
    query: ListDomainsQueryDto,
  ): Prisma.WebsiteDomainWhereInput {
    const where: Prisma.WebsiteDomainWhereInput = {};

    if (query.status !== undefined) {
      where.status = query.status;
    }

    if (query.usageStatus === AdminDomainUsageStatus.AVAILABLE) {
      where.status = DomainStatus.ACTIVE;
      where.websiteId = null;
    }

    if (query.usageStatus === AdminDomainUsageStatus.IN_USE) {
      where.status = DomainStatus.ACTIVE;
      where.websiteId = { not: null };
    }

    if (query.usageStatus === AdminDomainUsageStatus.DISABLED) {
      where.status = DomainStatus.DISABLED;
    }

    if (query.websiteId !== undefined && query.websiteId.trim() !== "") {
      where.websiteId = query.websiteId.trim();
    }

    if (
      query.domainGroupKey !== undefined &&
      query.domainGroupKey.trim() !== ""
    ) {
      where.domainGroup = {
        is: {
          key: this.normalizeDomainGroupKey(query.domainGroupKey),
        },
      };
    }

    if (query.search !== undefined && query.search.trim() !== "") {
      const search = query.search.trim();
      const normalizedSearchHost = normalizeDomain(search);
      where.OR = [
        { domain: { contains: normalizedSearchHost ?? search.toLowerCase() } },
        {
          website: {
            is: {
              OR: [
                { name: { contains: search } },
                { slug: { contains: search.toLowerCase() } },
              ],
            },
          },
        },
        {
          domainGroup: {
            is: {
              OR: [
                { key: { contains: search.toLowerCase() } },
                { name: { contains: search } },
              ],
            },
          },
        },
      ];
    }

    return where;
  }

  private async getDomainWithRelations(
    domainId: string,
  ): Promise<DomainWithRelations> {
    const domain = await this.prisma.websiteDomain.findUnique({
      where: { id: domainId },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
          },
        },
        domainGroup: true,
      },
    });

    if (domain === null) {
      throw new NotFoundException("Domain not found.");
    }

    return domain;
  }

  private async getActiveWebsiteForDomainAssignment(
    websiteId: string,
  ): Promise<Pick<Website, "id" | "name" | "slug" | "status" | "domainGroupId">> {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        domainGroupId: true,
      },
    });

    if (website === null) {
      throw new NotFoundException("Website not found.");
    }

    if (website.status !== WebsiteStatus.ACTIVE) {
      throw new BadRequestException("Website must be ACTIVE.");
    }

    return website;
  }

  private async assignDomainToWebsiteRecord(params: {
    domainId: string;
    websiteId: string;
    replaceExisting: boolean;
    adminId: string;
  }): Promise<DomainWithRelations> {
    const domain = await this.getDomainWithRelations(params.domainId);
    const website = await this.getActiveWebsiteForDomainAssignment(
      params.websiteId,
    );

    if (domain.status !== DomainStatus.ACTIVE) {
      throw new BadRequestException("Domain must be ACTIVE before assignment.");
    }

    if (domain.websiteId === params.websiteId) {
      const assignedDomain = await this.prisma.$transaction(async (tx) => {
        await tx.websiteDomain.updateMany({
          where: { websiteId: params.websiteId, id: { not: params.domainId } },
          data: {
            websiteId: null,
            isPrimary: false,
          },
        });

        return tx.websiteDomain.update({
          where: { id: params.domainId },
          data: { isPrimary: true },
          include: {
            website: {
              select: {
                id: true,
                name: true,
                slug: true,
                status: true,
              },
            },
            domainGroup: true,
          },
        });
      });

      this.clearCorsDomainCache();

      return assignedDomain;
    }

    if (domain.websiteId !== null) {
      await this.writeAudit(
        params.adminId,
        "DOMAIN_TRANSFER_ATTEMPT_REJECTED",
        "WebsiteDomain",
        domain.id,
        {
          domain: domain.domain,
          currentWebsiteId: domain.websiteId,
          requestedWebsiteId: params.websiteId,
        },
      );

      throw new BadRequestException(
        `Domain is already in use by website "${domain.website?.name ?? domain.websiteId}".`,
      );
    }

    const existingAssignedDomain = await this.prisma.websiteDomain.findFirst({
      where: { websiteId: params.websiteId },
      select: { id: true, domain: true },
      orderBy: { createdAt: "asc" },
    });

    if (existingAssignedDomain !== null && !params.replaceExisting) {
      throw new BadRequestException(
        "This website already has a domain. Enable replaceExisting to replace it.",
      );
    }

    const assignedDomain = await this.prisma.$transaction(async (tx) => {
      if (existingAssignedDomain !== null) {
        await tx.websiteDomain.updateMany({
          where: { websiteId: params.websiteId },
          data: {
            websiteId: null,
            isPrimary: false,
          },
        });
      }

      return tx.websiteDomain.update({
        where: { id: params.domainId },
        data: {
          websiteId: params.websiteId,
          isPrimary: true,
          ...(domain.domainGroupId === null && website.domainGroupId
            ? { domainGroupId: website.domainGroupId }
            : {}),
        },
        include: {
          website: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
            },
          },
          domainGroup: true,
        },
      });
    });

    await this.writeAudit(
      params.adminId,
      "DOMAIN_ASSIGN",
      "WebsiteDomain",
      assignedDomain.id,
      {
        domain: assignedDomain.domain,
        websiteId: params.websiteId,
        replacedDomainId: existingAssignedDomain?.id ?? null,
      },
    );
    this.clearCorsDomainCache();

    return assignedDomain;
  }

  private async ensureWebsiteExists(websiteId: string): Promise<void> {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
      select: { id: true },
    });

    if (website === null) {
      throw new NotFoundException("Website not found.");
    }
  }

  private async ensureActiveWebsiteExists(websiteId: string): Promise<void> {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
      select: { id: true, status: true },
    });

    if (website === null) {
      throw new NotFoundException("Website not found.");
    }

    if (website.status !== WebsiteStatus.ACTIVE) {
      throw new BadRequestException("Website must be ACTIVE.");
    }
  }

  private async ensureWebsiteSlugAvailable(
    slug: string,
    currentWebsiteId?: string,
  ): Promise<void> {
    const existingWebsite = await this.prisma.website.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (existingWebsite !== null && existingWebsite.id !== currentWebsiteId) {
      throw new ConflictException("Website slug is already in use.");
    }
  }

  private normalizeDomainGroupKey(key: string): string {
    const normalized = key.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(normalized) || normalized.length > 80) {
      throw new BadRequestException("Domain group key is invalid.");
    }

    return normalized;
  }

  private async ensureDomainGroupKeyAvailable(
    key: string,
    currentDomainGroupId?: string,
  ): Promise<void> {
    const existingGroup = await this.prisma.domainGroup.findUnique({
      where: { key },
      select: { id: true },
    });

    if (existingGroup !== null && existingGroup.id !== currentDomainGroupId) {
      throw new ConflictException("Domain group key is already in use.");
    }
  }

  private async resolveActiveDomainGroupId(params: {
    domainGroupKey?: string | null | undefined;
    domainGroupId?: string | null | undefined;
  }): Promise<string | null> {
    const domainGroupKey = params.domainGroupKey?.trim();
    const domainGroupId = params.domainGroupId?.trim();

    if (!domainGroupKey && !domainGroupId) {
      return null;
    }

    if (domainGroupKey) {
      const key = this.normalizeDomainGroupKey(domainGroupKey);
      const group = await this.prisma.domainGroup.findUnique({
        where: { key },
        select: { id: true, status: true },
      });

      if (group === null) {
        throw new BadRequestException(
          `Domain group "${key}" does not exist. Create it first or leave domainGroupKey empty.`,
        );
      }

      if (group.status !== DomainGroupStatus.ACTIVE) {
        throw new BadRequestException(`Domain group "${key}" is not ACTIVE.`);
      }

      return group.id;
    }

    if (!domainGroupId) {
      return null;
    }

    const group = await this.prisma.domainGroup.findUnique({
      where: { id: domainGroupId },
      select: { id: true, status: true },
    });

    if (group === null) {
      throw new BadRequestException(
        `Domain group id "${domainGroupId}" does not exist.`,
      );
    }

    if (group.status !== DomainGroupStatus.ACTIVE) {
      throw new BadRequestException(
        `Domain group id "${domainGroupId}" is not ACTIVE.`,
      );
    }

    return group.id;
  }

  private async ensureDomainAvailable(
    domain: string,
    currentDomainId?: string,
  ): Promise<void> {
    const existingDomain = await this.prisma.websiteDomain.findUnique({
      where: { domain },
      select: { id: true },
    });

    if (existingDomain !== null && existingDomain.id !== currentDomainId) {
      throw new ConflictException("Domain is already in use.");
    }
  }

  private async getDomainForWebsite(
    websiteId: string,
    domainId: string,
  ): Promise<WebsiteDomain> {
    const domain = await this.prisma.websiteDomain.findFirst({
      where: { id: domainId, websiteId },
    });

    if (domain === null) {
      throw new NotFoundException("Website domain not found.");
    }

    return domain;
  }

  private parseClaimHost(value: string): string {
    const trimmed = value.trim();

    if (
      trimmed.includes("://") ||
      trimmed.startsWith("//") ||
      /[/?#]/.test(trimmed)
    ) {
      throw new BadRequestException(
        "Host must not include protocol, path, query, or hash.",
      );
    }

    return this.parseDomain(trimmed);
  }

  private ensureLocalhostDomainAllowed(domain: string): void {
    if (!this.isLocalhostDomain(domain)) {
      return;
    }

    const allowLocalhostClaim =
      this.configService.get<string>("ALLOW_LOCALHOST_DOMAIN_CLAIM") === "true";
    const nodeEnv = this.configService.get<string>("NODE_ENV") ?? "development";

    if (!allowLocalhostClaim || nodeEnv === "production") {
      throw new BadRequestException(
        "Localhost domains are disabled for this environment.",
      );
    }
  }

  private isLocalhostDomain(domain: string): boolean {
    return (
      domain === "localhost" ||
      domain.startsWith("localhost:") ||
      domain === "127.0.0.1" ||
      domain.startsWith("127.0.0.1:") ||
      domain === "0.0.0.0" ||
      domain.startsWith("0.0.0.0:") ||
      domain === "[::1]" ||
      domain.startsWith("[::1]:")
    );
  }

  private clearCorsDomainCache(): void {
    this.corsOriginService.clearDomainOriginCache();
  }

  private parseDomain(value: string): string {
    const domain = normalizeDomain(value);
    if (domain === null) {
      throw new BadRequestException("Domain is invalid.");
    }

    return domain;
  }

  private async getReadyVideosByIds(videoIds: string[]): Promise<VideoAsset[]> {
    if (videoIds.length === 0) {
      return [];
    }

    return this.prisma.videoAsset.findMany({
      where: {
        id: { in: videoIds },
        status: VideoStatus.READY,
      },
    });
  }

  private async getReadyPlayableVideosByIds(
    videoIds: string[],
  ): Promise<VideoAsset[]> {
    if (videoIds.length === 0) {
      return [];
    }

    return this.prisma.videoAsset.findMany({
      where: {
        id: { in: videoIds },
        status: VideoStatus.READY,
        OR: [
          {
            sourceType: {
              in: [VideoSourceType.UPLOAD, VideoSourceType.DIRECT_URL],
            },
            playbackUrl: { not: null },
          },
          {
            sourceType: VideoSourceType.EMBED,
            embedUrl: { not: null },
          },
          {
            sourceType: VideoSourceType.DB_BLOB,
            binaryAsset: {
              is: {
                mimeType: { startsWith: "video/" },
                sizeBytes: { gt: BigInt(0) },
              },
            },
          },
        ],
      },
    });
  }

  private ensureAllRequestedVideosFound(
    requestedVideoIds: string[],
    videos: VideoAsset[],
    buildMessage?: (videoId: string) => string,
  ): void {
    const foundVideoIds = new Set(videos.map((video) => video.id));
    const missingVideoId = requestedVideoIds.find(
      (videoId) => !foundVideoIds.has(videoId),
    );

    if (missingVideoId !== undefined) {
      throw new BadRequestException(
        buildMessage?.(missingVideoId) ??
          `Video ${missingVideoId} is not READY or does not exist.`,
      );
    }
  }

  private async resolveShareLinkVideoIds(
    websiteId: string,
    dto: CreateShareLinkDto,
  ): Promise<string[]> {
    const providedVideoIds =
      dto.videoIds?.filter((videoId) => videoId.trim() !== "") ?? [];

    if (providedVideoIds.length > 0) {
      return providedVideoIds;
    }

    const assignments = await this.prisma.websiteVideo.findMany({
      where: {
        websiteId,
        status: AssignmentStatus.ACTIVE,
      },
      orderBy: { sortOrder: "asc" },
      select: { videoId: true },
    });

    return assignments.map((assignment) => assignment.videoId);
  }

  private async getPreferredActiveDomain(
    websiteId: string,
  ): Promise<string | null> {
    const primaryDomain = await this.prisma.websiteDomain.findFirst({
      where: {
        websiteId,
        status: DomainStatus.ACTIVE,
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { domain: true },
    });

    return primaryDomain?.domain ?? null;
  }

  private getConfiguredPublicSiteProtocol(
    domain: string | null,
  ): string | undefined {
    if (domain !== null && this.isLocalhostDomain(domain)) {
      return (
        this.configService.get<string>("PUBLIC_SHARE_LOCAL_PROTOCOL")?.trim() ||
        this.configService.get<string>("PUBLIC_SITE_PROTOCOL")?.trim()
      );
    }

    return this.configService.get<string>("PUBLIC_SITE_PROTOCOL")?.trim();
  }

  private trimOptional(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private trimNullable(value: string | undefined): string | null {
    return this.trimOptional(value) ?? null;
  }

  private parseNullableDate(value: string | undefined): Date | null {
    if (value === undefined || value.trim() === "") {
      return null;
    }

    return new Date(value);
  }

  private toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private toDomainGroupResponse(group: DomainGroup): AdminDomainGroupResponse {
    return {
      id: group.id,
      key: group.key,
      name: group.name,
      description: group.description,
      status: group.status,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  private toWebsiteResponse(
    website: WebsiteWithRelations,
  ): AdminWebsiteResponse {
    return {
      id: website.id,
      name: website.name,
      slug: website.slug,
      defaultTitle: website.defaultTitle,
      defaultDescription: website.defaultDescription,
      status: website.status,
      domainGroup:
        website.domainGroup === null
          ? null
          : {
              id: website.domainGroup.id,
              key: website.domainGroup.key,
              name: website.domainGroup.name,
            },
      domains: website.domains.map((domain) => this.toDomainResponse(domain)),
      createdAt: website.createdAt,
      updatedAt: website.updatedAt,
    };
  }

  private toDomainResponse(domain: WebsiteDomain): AdminWebsiteDomainResponse {
    return {
      id: domain.id,
      websiteId: domain.websiteId,
      domain: domain.domain,
      isPrimary: domain.isPrimary,
      status: domain.status,
      createdAt: domain.createdAt,
      updatedAt: domain.updatedAt,
    };
  }

  private toAdminDomainResponse(domain: DomainWithRelations): AdminDomainResponse {
    return {
      ...this.toDomainResponse(domain),
      websiteName: domain.website?.name ?? null,
      websiteSlug: domain.website?.slug ?? null,
      domainGroup:
        domain.domainGroup === null
          ? null
          : {
              id: domain.domainGroup.id,
              key: domain.domainGroup.key,
              name: domain.domainGroup.name,
            },
      usageStatus: this.getDomainUsageStatus(domain),
    };
  }

  private getDomainUsageStatus(
    domain: Pick<WebsiteDomain, "status" | "websiteId">,
  ): AdminDomainUsageStatus {
    if (domain.status === DomainStatus.DISABLED) {
      return AdminDomainUsageStatus.DISABLED;
    }

    if (domain.websiteId !== null) {
      return AdminDomainUsageStatus.IN_USE;
    }

    return AdminDomainUsageStatus.AVAILABLE;
  }

  private toAssignedVideoResponse(
    assignment: WebsiteVideoWithVideo,
  ): AdminWebsiteAssignedVideoResponse {
    return {
      id: assignment.id,
      websiteId: assignment.websiteId,
      videoId: assignment.videoId,
      sortOrder: assignment.sortOrder,
      isFeatured: assignment.isFeatured,
      status: assignment.status,
      videoTitle: assignment.video.title,
      videoStatus: assignment.video.status,
      thumbnailUrl: assignment.video.thumbnailUrl,
      playbackUrl: assignment.video.playbackUrl,
    };
  }

  private toShareLinkResponse(
    shareLink: ShareLinkWithVideos,
    publicUrl: string | null,
  ): AdminShareLinkResponse {
    return {
      id: shareLink.id,
      websiteId: shareLink.websiteId,
      label: shareLink.label,
      status: shareLink.status,
      expiresAt: shareLink.expiresAt,
      maxViews: shareLink.maxViews,
      currentViews: shareLink.currentViews,
      createdAt: shareLink.createdAt,
      updatedAt: shareLink.updatedAt,
      lastViewedAt: shareLink.lastViewedAt,
      publicUrl,
      videos: shareLink.shareLinkVideos.map((shareLinkVideo) => ({
        id: shareLinkVideo.id,
        videoId: shareLinkVideo.videoId,
        title: shareLinkVideo.video.title,
        sortOrder: shareLinkVideo.sortOrder,
      })),
    };
  }

  private async writeAudit(
    adminId: string,
    action: AuditAction,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          module: "admin-websites",
          entityType,
          entityId,
          status: AuditStatus.SUCCESS,
          metadataJson: this.toJsonInput(metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          action,
          entityType,
          entityId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Admin website audit log write failed.",
      );
    }
  }
}
