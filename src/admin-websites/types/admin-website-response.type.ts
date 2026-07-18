import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AssignmentStatus,
  DomainGroupStatus,
  DomainStatus,
  VideoStatus,
  WebsiteStatus,
} from "../../generated/prisma/client";
import { VideoResponse } from "../../videos/types/video-response.type";

export class AdminDomainGroupBasicResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty()
  name!: string;
}

export class AdminDomainGroupResponse extends AdminDomainGroupBasicResponse {
  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: DomainGroupStatus })
  status!: DomainGroupStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export enum AdminDomainUsageStatus {
  AVAILABLE = "AVAILABLE",
  IN_USE = "IN_USE",
  DISABLED = "DISABLED",
}

export class AdminDomainGroupListResponse {
  @ApiProperty({ type: [AdminDomainGroupResponse] })
  items!: AdminDomainGroupResponse[];

  @ApiProperty()
  meta!: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class DisableDomainGroupResponse {
  @ApiProperty()
  message!: string;
}

export class AdminWebsiteDomainResponse {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  websiteId!: string | null;

  @ApiProperty()
  domain!: string;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ enum: DomainStatus })
  status!: DomainStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AdminDomainResponse extends AdminWebsiteDomainResponse {
  @ApiPropertyOptional({ nullable: true })
  websiteName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  websiteSlug!: string | null;

  @ApiPropertyOptional({ type: AdminDomainGroupBasicResponse, nullable: true })
  domainGroup!: AdminDomainGroupBasicResponse | null;

  @ApiProperty({ enum: AdminDomainUsageStatus })
  usageStatus!: AdminDomainUsageStatus;
}

export class AdminDomainListResponse {
  @ApiProperty({ type: [AdminDomainResponse] })
  items!: AdminDomainResponse[];

  @ApiProperty()
  meta!: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class AdminWebsiteAssignedVideoResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  websiteId!: string;

  @ApiProperty()
  videoId!: string;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isFeatured!: boolean;

  @ApiProperty({ enum: AssignmentStatus })
  status!: AssignmentStatus;

  @ApiProperty()
  videoTitle!: string;

  @ApiProperty({ enum: VideoStatus })
  videoStatus!: VideoStatus;

  @ApiPropertyOptional({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  playbackUrl!: string | null;

  @ApiProperty({ type: VideoResponse })
  video!: VideoResponse;
}

export class AdminWebsiteResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true })
  defaultTitle!: string | null;

  @ApiPropertyOptional({ nullable: true })
  defaultDescription!: string | null;

  @ApiProperty({ enum: WebsiteStatus })
  status!: WebsiteStatus;

  @ApiPropertyOptional({ type: AdminDomainGroupBasicResponse, nullable: true })
  domainGroup!: AdminDomainGroupBasicResponse | null;

  @ApiProperty({ type: [AdminWebsiteDomainResponse] })
  domains!: AdminWebsiteDomainResponse[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AdminWebsiteListResponse {
  @ApiProperty({ type: [AdminWebsiteResponse] })
  items!: AdminWebsiteResponse[];

  @ApiProperty()
  meta!: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class AdminWebsiteDetailResponse extends AdminWebsiteResponse {
  @ApiProperty({ type: [AdminWebsiteAssignedVideoResponse] })
  assignedVideos!: AdminWebsiteAssignedVideoResponse[];

  @ApiProperty({ isArray: true })
  recentShareLinks!: unknown[];
}

export class DisableWebsiteResponse {
  @ApiProperty()
  message!: string;
}

export class AssignWebsiteVideosResponse {
  @ApiProperty({ type: [AdminWebsiteAssignedVideoResponse] })
  items!: AdminWebsiteAssignedVideoResponse[];

  @ApiPropertyOptional()
  meta?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    activeAssignmentTotal: number;
    eligibleAssignmentTotal: number;
  };
}
