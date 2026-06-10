-- CreateTable
CREATE TABLE `AdminUser` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'STAFF') NOT NULL DEFAULT 'STAFF',
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminUser_email_key`(`email`),
    INDEX `AdminUser_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminRefreshToken` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminRefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `AdminRefreshToken_adminId_idx`(`adminId`),
    INDEX `AdminRefreshToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VideoAsset` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `provider` ENUM('MANUAL', 'BUNNY', 'MUX', 'CLOUDINARY') NOT NULL DEFAULT 'MANUAL',
    `providerAssetId` VARCHAR(255) NULL,
    `playbackId` VARCHAR(255) NULL,
    `playbackUrl` VARCHAR(2048) NULL,
    `embedUrl` VARCHAR(2048) NULL,
    `thumbnailUrl` VARCHAR(2048) NULL,
    `durationSeconds` INTEGER NULL,
    `status` ENUM('DRAFT', 'PROCESSING', 'READY', 'FAILED', 'DISABLED') NOT NULL DEFAULT 'DRAFT',
    `metadataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `VideoAsset_status_idx`(`status`),
    INDEX `VideoAsset_provider_providerAssetId_idx`(`provider`, `providerAssetId`),
    INDEX `VideoAsset_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Website` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(120) NOT NULL,
    `defaultTitle` VARCHAR(255) NULL,
    `defaultDescription` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Website_slug_key`(`slug`),
    INDEX `Website_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebsiteDomain` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WebsiteDomain_domain_key`(`domain`),
    INDEX `WebsiteDomain_websiteId_idx`(`websiteId`),
    INDEX `WebsiteDomain_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ThemeConfig` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NOT NULL,
    `themeKey` VARCHAR(80) NOT NULL,
    `layoutKey` VARCHAR(80) NOT NULL,
    `colorsJson` JSON NULL,
    `fontsJson` JSON NULL,
    `contentJson` JSON NULL,
    `customCss` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ThemeConfig_websiteId_key`(`websiteId`),
    INDEX `ThemeConfig_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebsiteVideo` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebsiteVideo_websiteId_idx`(`websiteId`),
    INDEX `WebsiteVideo_videoId_idx`(`videoId`),
    INDEX `WebsiteVideo_websiteId_sortOrder_idx`(`websiteId`, `sortOrder`),
    INDEX `WebsiteVideo_status_idx`(`status`),
    UNIQUE INDEX `WebsiteVideo_websiteId_videoId_key`(`websiteId`, `videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShareLink` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `label` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NULL,
    `maxViews` INTEGER NULL,
    `currentViews` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'REVOKED', 'EXPIRED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastViewedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ShareLink_tokenHash_key`(`tokenHash`),
    INDEX `ShareLink_websiteId_idx`(`websiteId`),
    INDEX `ShareLink_status_idx`(`status`),
    INDEX `ShareLink_websiteId_status_idx`(`websiteId`, `status`),
    INDEX `ShareLink_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShareLinkVideo` (
    `id` VARCHAR(191) NOT NULL,
    `shareLinkId` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShareLinkVideo_shareLinkId_idx`(`shareLinkId`),
    INDEX `ShareLinkVideo_videoId_idx`(`videoId`),
    INDEX `ShareLinkVideo_shareLinkId_sortOrder_idx`(`shareLinkId`, `sortOrder`),
    UNIQUE INDEX `ShareLinkVideo_shareLinkId_videoId_key`(`shareLinkId`, `videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccessLog` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NULL,
    `shareLinkId` VARCHAR(191) NULL,
    `domain` VARCHAR(253) NULL,
    `ipHash` VARCHAR(128) NULL,
    `userAgent` VARCHAR(1024) NULL,
    `referer` VARCHAR(2048) NULL,
    `status` ENUM('ALLOWED', 'DENIED') NOT NULL,
    `reasonCode` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AccessLog_createdAt_idx`(`createdAt`),
    INDEX `AccessLog_websiteId_idx`(`websiteId`),
    INDEX `AccessLog_shareLinkId_idx`(`shareLinkId`),
    INDEX `AccessLog_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminAuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NULL,
    `action` VARCHAR(120) NOT NULL,
    `module` VARCHAR(120) NOT NULL,
    `entityType` VARCHAR(120) NULL,
    `entityId` VARCHAR(191) NULL,
    `status` ENUM('SUCCESS', 'FAIL') NOT NULL,
    `ipHash` VARCHAR(128) NULL,
    `userAgent` VARCHAR(1024) NULL,
    `metadataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AdminAuditLog_createdAt_idx`(`createdAt`),
    INDEX `AdminAuditLog_adminId_idx`(`adminId`),
    INDEX `AdminAuditLog_module_idx`(`module`),
    INDEX `AdminAuditLog_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdminRefreshToken` ADD CONSTRAINT `AdminRefreshToken_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebsiteDomain` ADD CONSTRAINT `WebsiteDomain_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ThemeConfig` ADD CONSTRAINT `ThemeConfig_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebsiteVideo` ADD CONSTRAINT `WebsiteVideo_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebsiteVideo` ADD CONSTRAINT `WebsiteVideo_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShareLink` ADD CONSTRAINT `ShareLink_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShareLinkVideo` ADD CONSTRAINT `ShareLinkVideo_shareLinkId_fkey` FOREIGN KEY (`shareLinkId`) REFERENCES `ShareLink`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShareLinkVideo` ADD CONSTRAINT `ShareLinkVideo_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccessLog` ADD CONSTRAINT `AccessLog_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccessLog` ADD CONSTRAINT `AccessLog_shareLinkId_fkey` FOREIGN KEY (`shareLinkId`) REFERENCES `ShareLink`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminAuditLog` ADD CONSTRAINT `AdminAuditLog_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
