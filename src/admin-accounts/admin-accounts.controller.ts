import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AdminRole } from "../generated/prisma/client";
import { AdminAccessTokenGuard } from "../admin-auth/guards/admin-access-token.guard";
import { AdminRolesGuard } from "../admin-auth/guards/admin-roles.guard";
import { AdminRoles } from "../admin-auth/decorators/admin-roles.decorator";
import { CurrentAdmin } from "../admin-auth/decorators/current-admin.decorator";
import type { SafeAdminResponse } from "../admin-auth/types/admin-auth-response.type";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { getRequestSecurityMeta } from "../common/utils/request-security.util";
import {
  THROTTLE_PROFILES,
  ThrottleProfile,
} from "../security/throttle-profile.decorator";
import {
  ChangeAdminAccountRoleDto,
  ChangeAdminAccountStatusDto,
  CreateAdminAccountDto,
  DeleteAdminAccountDto,
  ListAdminAccountsQueryDto,
  ResetAdminAccountPasswordDto,
  RevokeAdminAccountSessionsDto,
} from "./dto/admin-account.dto";
import { AdminAccountsService } from "./admin-accounts.service";
import {
  AdminAccountMutationResponse,
  ManagedAdminAccountListResponse,
  TemporaryAdminPasswordResponse,
} from "./types/admin-account-response.type";

@ApiTags("admin-accounts")
@ApiBearerAuth()
@Controller("admin/accounts")
@UseGuards(AdminAccessTokenGuard, AdminRolesGuard)
export class AdminAccountsController {
  constructor(
    private readonly accounts: AdminAccountsService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.admin)
  @ApiOkResponse({ type: ManagedAdminAccountListResponse })
  list(
    @Query() query: ListAdminAccountsQueryDto,
  ): Promise<ManagedAdminAccountListResponse> {
    return this.accounts.list(query);
  }

  @Post()
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @Header("Cache-Control", "no-store")
  @ApiCreatedResponse({ type: TemporaryAdminPasswordResponse })
  create(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Body() dto: CreateAdminAccountDto,
    @Req() request: Request,
  ): Promise<TemporaryAdminPasswordResponse> {
    return this.accounts.create(actor.id, dto, this.getRequestMeta(request));
  }

  @Patch(":id/role")
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOkResponse({ type: AdminAccountMutationResponse })
  changeRole(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Param("id") targetId: string,
    @Body() dto: ChangeAdminAccountRoleDto,
    @Req() request: Request,
  ): Promise<AdminAccountMutationResponse> {
    return this.accounts.changeRole(
      actor.id,
      targetId,
      dto,
      this.getRequestMeta(request),
    );
  }

  @Patch(":id/status")
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOkResponse({ type: AdminAccountMutationResponse })
  changeStatus(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Param("id") targetId: string,
    @Body() dto: ChangeAdminAccountStatusDto,
    @Req() request: Request,
  ): Promise<AdminAccountMutationResponse> {
    return this.accounts.changeStatus(
      actor.id,
      targetId,
      dto,
      this.getRequestMeta(request),
    );
  }

  @Post(":id/revoke-sessions")
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOkResponse({ type: AdminAccountMutationResponse })
  revokeSessions(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Param("id") targetId: string,
    @Body() dto: RevokeAdminAccountSessionsDto,
    @Req() request: Request,
  ): Promise<AdminAccountMutationResponse> {
    return this.accounts.revokeSessions(
      actor.id,
      targetId,
      dto,
      this.getRequestMeta(request),
    );
  }

  @Post(":id/reset-password")
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: TemporaryAdminPasswordResponse })
  resetPassword(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Param("id") targetId: string,
    @Body() dto: ResetAdminAccountPasswordDto,
    @Req() request: Request,
  ): Promise<TemporaryAdminPasswordResponse> {
    return this.accounts.resetPassword(
      actor.id,
      targetId,
      dto,
      this.getRequestMeta(request),
    );
  }

  @Delete(":id")
  @AdminRoles(AdminRole.OWNER)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOkResponse({ type: AdminAccountMutationResponse })
  delete(
    @CurrentAdmin() actor: SafeAdminResponse,
    @Param("id") targetId: string,
    @Body() dto: DeleteAdminAccountDto,
    @Req() request: Request,
  ): Promise<AdminAccountMutationResponse> {
    return this.accounts.delete(
      actor.id,
      targetId,
      dto,
      this.getRequestMeta(request),
    );
  }

  private getRequestMeta(request: Request) {
    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");
    return getRequestSecurityMeta(request, {
      trustProxyEnabled: apiEnvironment.trustProxyEnabled,
      trustProxyCloudflareOnly: apiEnvironment.trustProxyCloudflareOnly,
      trustedProxyCidrs: apiEnvironment.trustedProxyCidrs,
    });
  }
}
