import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentAdmin } from "../admin-auth/decorators/current-admin.decorator";
import {
  AdminReadRoles,
  AdminWriteRoles,
} from "../admin-auth/decorators/admin-roles.decorator";
import { AdminAccessTokenGuard } from "../admin-auth/guards/admin-access-token.guard";
import { AdminRolesGuard } from "../admin-auth/guards/admin-roles.guard";
import type { SafeAdminResponse } from "../admin-auth/types/admin-auth-response.type";
import {
  THROTTLE_PROFILES,
  ThrottleProfile,
} from "../security/throttle-profile.decorator";
import { AdminWebsitesService } from "./admin-websites.service";
import { ActivateWebsiteDomainDto } from "./dto/activate-website-domain.dto";
import { AssignDomainToWebsiteDto } from "./dto/assign-domain-to-website.dto";
import { AssignWebsiteVideosDto } from "./dto/assign-website-videos.dto";
import { AssignSingleWebsiteVideoDto } from "./dto/assign-single-website-video.dto";
import { ClaimCurrentWebsiteDomainDto } from "./dto/claim-current-website-domain.dto";
import { CreateDomainDto } from "./dto/create-domain.dto";
import { CreateDomainGroupDto } from "./dto/create-domain-group.dto";
import { CreateShareLinkDto } from "./dto/create-share-link.dto";
import { CreateWebsiteDomainDto } from "./dto/create-website-domain.dto";
import { CreateWebsiteDto } from "./dto/create-website.dto";
import { ListDomainsQueryDto } from "./dto/list-domains-query.dto";
import { ListDomainGroupsQueryDto } from "./dto/list-domain-groups-query.dto";
import { ListWebsitesQueryDto } from "./dto/list-websites-query.dto";
import { ListWebsiteVideosQueryDto } from "./dto/list-website-videos-query.dto";
import { UpdateDomainDto } from "./dto/update-domain.dto";
import { UpdateDomainGroupDto } from "./dto/update-domain-group.dto";
import { UpdateWebsiteDomainDto } from "./dto/update-website-domain.dto";
import { UpdateWebsiteDto } from "./dto/update-website.dto";
import {
  AdminDomainGroupListResponse,
  AdminDomainGroupResponse,
  AdminDomainListResponse,
  AdminDomainResponse,
  AdminWebsiteAssignedVideoResponse,
  AdminWebsiteDetailResponse,
  AdminWebsiteDomainResponse,
  AdminWebsiteListResponse,
  AdminWebsiteResponse,
  AssignWebsiteVideosResponse,
  DisableDomainGroupResponse,
  DisableWebsiteResponse,
} from "./types/admin-website-response.type";
import {
  AdminShareLinkListResponse,
  CreateShareLinkResponse,
  RevokeShareLinkResponse,
} from "./types/admin-share-link-response.type";

@ApiTags("admin-websites")
@ApiBearerAuth()
@UseGuards(AdminAccessTokenGuard, AdminRolesGuard)
@ThrottleProfile(THROTTLE_PROFILES.admin)
@Controller("admin")
export class AdminWebsitesController {
  constructor(private readonly websitesService: AdminWebsitesService) {}

  @Get("domain-groups")
  @AdminReadRoles()
  @ApiOperation({ summary: "List domain groups" })
  @ApiOkResponse({ type: AdminDomainGroupListResponse })
  @ApiUnauthorizedResponse()
  listDomainGroups(
    @Query() query: ListDomainGroupsQueryDto,
  ): Promise<AdminDomainGroupListResponse> {
    return this.websitesService.listDomainGroups(query);
  }

  @Post("domain-groups")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Create domain group" })
  @ApiCreatedResponse({ type: AdminDomainGroupResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  createDomainGroup(
    @Body() dto: CreateDomainGroupDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainGroupResponse> {
    return this.websitesService.createDomainGroup(dto, admin.id);
  }

  @Get("domain-groups/:id")
  @AdminReadRoles()
  @ApiOperation({ summary: "Get domain group" })
  @ApiOkResponse({ type: AdminDomainGroupResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  getDomainGroup(@Param("id") id: string): Promise<AdminDomainGroupResponse> {
    return this.websitesService.getDomainGroup(id);
  }

  @Patch("domain-groups/:id")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Update domain group" })
  @ApiOkResponse({ type: AdminDomainGroupResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  updateDomainGroup(
    @Param("id") id: string,
    @Body() dto: UpdateDomainGroupDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainGroupResponse> {
    return this.websitesService.updateDomainGroup(id, dto, admin.id);
  }

  @Delete("domain-groups/:id")
  @AdminWriteRoles()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable domain group" })
  @ApiOkResponse({ type: DisableDomainGroupResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  disableDomainGroup(
    @Param("id") id: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<DisableDomainGroupResponse> {
    return this.websitesService.disableDomainGroup(id, admin.id);
  }

  @Get("domains")
  @AdminReadRoles()
  @ApiOperation({ summary: "List domains in the global domain pool" })
  @ApiOkResponse({ type: AdminDomainListResponse })
  @ApiUnauthorizedResponse()
  listDomains(
    @Query() query: ListDomainsQueryDto,
  ): Promise<AdminDomainListResponse> {
    return this.websitesService.listDomains(query);
  }

  @Post("domains")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Create standalone domain in the domain pool" })
  @ApiCreatedResponse({ type: AdminDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  createStandaloneDomain(
    @Body() dto: CreateDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.createStandaloneDomain(dto, admin.id);
  }

  @Get("domains/:domainId")
  @AdminReadRoles()
  @ApiOperation({ summary: "Get domain from the domain pool" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  getDomain(@Param("domainId") domainId: string): Promise<AdminDomainResponse> {
    return this.websitesService.getDomain(domainId);
  }

  @Patch("domains/:domainId")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Update domain in the domain pool" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  updateStandaloneDomain(
    @Param("domainId") domainId: string,
    @Body() dto: UpdateDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.updateStandaloneDomain(domainId, dto, admin.id);
  }

  @Delete("domains/:domainId")
  @AdminWriteRoles()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable available domain" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  disableStandaloneDomain(
    @Param("domainId") domainId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.disableStandaloneDomain(domainId, admin.id);
  }

  @Post("domains/:domainId/activate")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Activate domain" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  activateStandaloneDomain(
    @Param("domainId") domainId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.activateStandaloneDomain(domainId, admin.id);
  }

  @Post("domains/:domainId/assign")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Assign available domain to a website" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  assignDomainToWebsite(
    @Param("domainId") domainId: string,
    @Body() dto: AssignDomainToWebsiteDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.assignDomainToWebsite(domainId, dto, admin.id);
  }

  @Post("domains/:domainId/unassign")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Unassign domain from its website" })
  @ApiOkResponse({ type: AdminDomainResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  unassignDomainFromWebsite(
    @Param("domainId") domainId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminDomainResponse> {
    return this.websitesService.unassignDomainFromWebsite(domainId, admin.id);
  }

  @Get("websites")
  @AdminReadRoles()
  @ApiOperation({ summary: "List admin websites" })
  @ApiOkResponse({ type: AdminWebsiteListResponse })
  @ApiUnauthorizedResponse()
  listWebsites(
    @Query() query: ListWebsitesQueryDto,
  ): Promise<AdminWebsiteListResponse> {
    return this.websitesService.listWebsites(query);
  }

  @Get("websites/:id")
  @AdminReadRoles()
  @ApiOperation({ summary: "Get website detail" })
  @ApiOkResponse({ type: AdminWebsiteDetailResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  getWebsite(@Param("id") id: string): Promise<AdminWebsiteDetailResponse> {
    return this.websitesService.getWebsite(id);
  }

  @Post("websites")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Create website" })
  @ApiCreatedResponse({ type: AdminWebsiteResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  createWebsite(
    @Body() dto: CreateWebsiteDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteResponse> {
    return this.websitesService.createWebsite(dto, admin.id);
  }

  @Patch("websites/:id")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Update website" })
  @ApiOkResponse({ type: AdminWebsiteResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  updateWebsite(
    @Param("id") id: string,
    @Body() dto: UpdateWebsiteDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteResponse> {
    return this.websitesService.updateWebsite(id, dto, admin.id);
  }

  @Delete("websites/:id")
  @AdminWriteRoles()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable website" })
  @ApiOkResponse({ type: DisableWebsiteResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  disableWebsite(
    @Param("id") id: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<DisableWebsiteResponse> {
    return this.websitesService.disableWebsite(id, admin.id);
  }

  @Post("websites/:websiteId/domains")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Create website domain" })
  @ApiCreatedResponse({ type: AdminWebsiteDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  createDomain(
    @Param("websiteId") websiteId: string,
    @Body() dto: CreateWebsiteDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.createDomain(websiteId, dto, admin.id);
  }

  @Patch("websites/:websiteId/domains/:domainId")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Update website domain" })
  @ApiOkResponse({ type: AdminWebsiteDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  updateDomain(
    @Param("websiteId") websiteId: string,
    @Param("domainId") domainId: string,
    @Body() dto: UpdateWebsiteDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.updateDomain(
      websiteId,
      domainId,
      dto,
      admin.id,
    );
  }

  @Delete("websites/:websiteId/domains/:domainId")
  @AdminWriteRoles()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable website domain" })
  @ApiOkResponse({ type: AdminWebsiteDomainResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  disableDomain(
    @Param("websiteId") websiteId: string,
    @Param("domainId") domainId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.disableDomain(websiteId, domainId, admin.id);
  }

  @Post("websites/:websiteId/domains/:domainId/activate")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Activate website domain" })
  @ApiOkResponse({ type: AdminWebsiteDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  activateDomain(
    @Param("websiteId") websiteId: string,
    @Param("domainId") domainId: string,
    @Body() dto: ActivateWebsiteDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.activateDomain(
      websiteId,
      domainId,
      dto,
      admin.id,
    );
  }

  @Post("websites/:websiteId/domains/:domainId/disable")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Disable website domain" })
  @ApiOkResponse({ type: AdminWebsiteDomainResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  disableDomainWithPost(
    @Param("websiteId") websiteId: string,
    @Param("domainId") domainId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.disableDomain(websiteId, domainId, admin.id);
  }

  @Post("websites/:websiteId/domains/claim-current")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Claim current public domain for a website" })
  @ApiCreatedResponse({ type: AdminWebsiteDomainResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  claimCurrentDomain(
    @Param("websiteId") websiteId: string,
    @Body() dto: ClaimCurrentWebsiteDomainDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteDomainResponse> {
    return this.websitesService.claimCurrentDomain(websiteId, dto, admin.id);
  }

  @Get("websites/:websiteId/videos")
  @AdminReadRoles()
  @ApiOperation({ summary: "List website video assignments" })
  @ApiOkResponse({ type: AssignWebsiteVideosResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  listAssignedVideos(
    @Param("websiteId") websiteId: string,
    @Query() query: ListWebsiteVideosQueryDto,
  ): Promise<AssignWebsiteVideosResponse> {
    return this.websitesService.listAssignedVideos(websiteId, query);
  }

  @Put("websites/:websiteId/videos")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Replace website video assignments" })
  @ApiOkResponse({ type: AssignWebsiteVideosResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  assignVideos(
    @Param("websiteId") websiteId: string,
    @Body() dto: AssignWebsiteVideosDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AssignWebsiteVideosResponse> {
    return this.websitesService.assignVideos(websiteId, dto, admin.id);
  }

  @Post("websites/:websiteId/videos/assign")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Assign or reactivate one video for a website" })
  @ApiCreatedResponse({ type: AdminWebsiteAssignedVideoResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  assignSingleVideo(
    @Param("websiteId") websiteId: string,
    @Body() dto: AssignSingleWebsiteVideoDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<AdminWebsiteAssignedVideoResponse> {
    return this.websitesService.assignSingleVideo(
      websiteId,
      dto.videoId,
      admin.id,
    );
  }

  @Get("websites/:websiteId/share-links")
  @AdminReadRoles()
  @ApiOperation({ summary: "List website share links" })
  @ApiOkResponse({ type: AdminShareLinkListResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  listShareLinks(
    @Param("websiteId") websiteId: string,
  ): Promise<AdminShareLinkListResponse> {
    return this.websitesService.listShareLinks(websiteId);
  }

  @Post("websites/:websiteId/share-links")
  @AdminWriteRoles()
  @ApiOperation({
    summary: "Create share link",
    description:
      "Returns rawToken and publicUrl only once. tokenHash is never returned.",
  })
  @ApiCreatedResponse({ type: CreateShareLinkResponse })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  createShareLink(
    @Param("websiteId") websiteId: string,
    @Body() dto: CreateShareLinkDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<CreateShareLinkResponse> {
    return this.websitesService.createShareLink(websiteId, dto, admin.id);
  }

  @Post("share-links/:shareLinkId/revoke")
  @AdminWriteRoles()
  @ApiOperation({ summary: "Revoke share link" })
  @ApiOkResponse({ type: RevokeShareLinkResponse })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  revokeShareLink(
    @Param("shareLinkId") shareLinkId: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<RevokeShareLinkResponse> {
    return this.websitesService.revokeShareLink(shareLinkId, admin.id);
  }
}
