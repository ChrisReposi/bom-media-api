import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { getRequestSecurityMeta } from "../common/utils/request-security.util";
import {
  THROTTLE_PROFILES,
  ThrottleProfile,
} from "../security/throttle-profile.decorator";
import { AdminAuthService } from "./admin-auth.service";
import { CurrentAdmin } from "./decorators/current-admin.decorator";
import { ChangeAdminPasswordDto } from "./dto/change-admin-password.dto";
import { LoginAdminDto } from "./dto/login-admin.dto";
import { LogoutAdminDto } from "./dto/logout-admin.dto";
import { RefreshAdminTokenDto } from "./dto/refresh-admin-token.dto";
import { RegisterAdminDto } from "./dto/register-admin.dto";
import { AdminAccessTokenGuard } from "./guards/admin-access-token.guard";
import type { SafeAdminResponse } from "./types/admin-auth-response.type";
import {
  ChangeAdminPasswordResponse,
  LoginAdminResponse,
  LogoutAdminResponse,
  MeAdminResponse,
  RefreshAdminTokenResponse,
  RegisterAdminResponse,
} from "./types/admin-auth-response.type";

@ApiTags("admin-auth")
@Controller("admin/auth")
export class AdminAuthController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post("register")
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOperation({
    summary: "Register the initial owner admin",
    description:
      "Creates the one allowed owner admin account when the registration secret is valid.",
  })
  @ApiCreatedResponse({
    description: "Admin registered successfully.",
    type: RegisterAdminResponse,
  })
  @ApiBadRequestResponse({
    description: "Request body failed validation.",
  })
  @ApiForbiddenResponse({
    description: "Registration is disabled or the secret is invalid.",
  })
  @ApiConflictResponse({
    description: "An admin account already exists.",
  })
  register(
    @Body() registerAdminDto: RegisterAdminDto,
  ): Promise<RegisterAdminResponse> {
    return this.adminAuthService.register(registerAdminDto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.login)
  @ApiOperation({
    summary: "Verify admin login credentials",
    description:
      "Validates username and password, then returns safe admin data plus access and refresh tokens.",
  })
  @ApiOkResponse({
    description: "Admin logged in successfully.",
    type: LoginAdminResponse,
  })
  @ApiBadRequestResponse({
    description: "Request body failed validation.",
  })
  @ApiUnauthorizedResponse({
    description: "Invalid username or password.",
  })
  login(
    @Body() loginAdminDto: LoginAdminDto,
    @Req() request: Request,
  ): Promise<LoginAdminResponse> {
    return this.adminAuthService.login(
      loginAdminDto,
      this.getRequestMeta(request),
    );
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.refresh)
  @ApiOperation({
    summary: "Rotate admin refresh token",
    description:
      "Validates an opaque refresh token, revokes it, and returns a new access token and refresh token.",
  })
  @ApiOkResponse({
    description: "Admin session refreshed successfully.",
    type: RefreshAdminTokenResponse,
  })
  @ApiBadRequestResponse({
    description: "Request body failed validation.",
  })
  @ApiUnauthorizedResponse({
    description: "Invalid or expired refresh token.",
  })
  refresh(
    @Body() refreshAdminTokenDto: RefreshAdminTokenDto,
    @Req() request: Request,
  ): Promise<RefreshAdminTokenResponse> {
    return this.adminAuthService.refresh(
      refreshAdminTokenDto,
      this.getRequestMeta(request),
    );
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.logout)
  @ApiOperation({
    summary: "Log out an admin session",
    description:
      "Revokes the supplied refresh token when it exists. The response is idempotent and does not reveal token state.",
  })
  @ApiOkResponse({
    description: "Admin logged out successfully.",
    type: LogoutAdminResponse,
  })
  @ApiBadRequestResponse({
    description: "Request body failed validation.",
  })
  logout(
    @Body() logoutAdminDto: LogoutAdminDto,
    @Req() request: Request,
  ): Promise<LogoutAdminResponse> {
    return this.adminAuthService.logout(
      logoutAdminDto,
      this.getRequestMeta(request),
    );
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.admin)
  @UseGuards(AdminAccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Change current admin password",
    description:
      "Requires a valid admin Bearer access token, current password, and server-configured change-password secret. Revokes existing refresh tokens after success.",
  })
  @ApiOkResponse({
    description: "Password changed successfully.",
    type: ChangeAdminPasswordResponse,
  })
  @ApiBadRequestResponse({
    description: "Request body failed validation.",
  })
  @ApiUnauthorizedResponse({
    description:
      "Missing/invalid access token or password change verification failed.",
  })
  changePassword(
    @CurrentAdmin() admin: SafeAdminResponse,
    @Body() dto: ChangeAdminPasswordDto,
    @Req() request: Request,
  ): Promise<ChangeAdminPasswordResponse> {
    return this.adminAuthService.changePassword(
      admin.id,
      dto,
      this.getRequestMeta(request),
    );
  }

  @Get("me")
  @ThrottleProfile(THROTTLE_PROFILES.admin)
  @UseGuards(AdminAccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get current admin",
    description:
      "Returns safe admin data for a valid admin Bearer access token.",
  })
  @ApiOkResponse({
    description: "Current admin resolved successfully.",
    type: MeAdminResponse,
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  getMe(@CurrentAdmin() admin: SafeAdminResponse): Promise<MeAdminResponse> {
    return this.adminAuthService.getMe(admin.id);
  }

  private getRequestMeta(request: Request) {
    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");

    return getRequestSecurityMeta(request, {
      trustProxyEnabled: apiEnvironment.trustProxyEnabled,
      trustProxyCloudflareOnly: apiEnvironment.trustProxyCloudflareOnly,
    });
  }
}
