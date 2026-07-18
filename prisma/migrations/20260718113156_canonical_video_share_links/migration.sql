-- CreateTable
CREATE TABLE `CanonicalVideoShareLink` (
    `id` VARCHAR(191) NOT NULL,
    `websiteId` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `shareLinkId` VARCHAR(191) NOT NULL,
    `canonicalDomainId` VARCHAR(191) NOT NULL,
    `canonicalHostSnapshot` VARCHAR(253) NOT NULL,
    `canonicalProtocol` VARCHAR(8) NOT NULL,
    `evidenceFingerprint` VARCHAR(128) NULL,
    `evidenceSnapshotJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CanonicalVideoShareLink_shareLinkId_key`(`shareLinkId`),
    INDEX `CanonicalVideoShareLink_canonicalDomainId_idx`(`canonicalDomainId`),
    INDEX `CanonicalVideoShareLink_videoId_idx`(`videoId`),
    UNIQUE INDEX `CanonicalVideoShareLink_websiteId_videoId_key`(`websiteId`, `videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_shareLinkId_fkey` FOREIGN KEY (`shareLinkId`) REFERENCES `ShareLink`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_canonicalDomainId_fkey` FOREIGN KEY (`canonicalDomainId`) REFERENCES `WebsiteDomain`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
