-- Add capped, deduped public display-view growth tracking.
CREATE TABLE `VideoViewGrowthBucket` (
    `id` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `bucketStart` DATETIME(3) NOT NULL,
    `incrementTotal` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoViewGrowthBucket_videoId_bucketStart_key`(`videoId`, `bucketStart`),
    INDEX `VideoViewGrowthBucket_bucketStart_idx`(`bucketStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VideoViewGrowthEvent` (
    `id` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `shareLinkId` VARCHAR(191) NULL,
    `websiteId` VARCHAR(191) NULL,
    `viewerHash` VARCHAR(128) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `increment` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VideoViewGrowthEvent_videoId_viewerHash_windowStart_key`(`videoId`, `viewerHash`, `windowStart`),
    INDEX `VideoViewGrowthEvent_videoId_createdAt_idx`(`videoId`, `createdAt`),
    INDEX `VideoViewGrowthEvent_shareLinkId_idx`(`shareLinkId`),
    INDEX `VideoViewGrowthEvent_websiteId_idx`(`websiteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VideoViewGrowthBucket` ADD CONSTRAINT `VideoViewGrowthBucket_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `VideoViewGrowthEvent` ADD CONSTRAINT `VideoViewGrowthEvent_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
