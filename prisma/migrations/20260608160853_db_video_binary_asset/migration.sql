-- AlterTable
ALTER TABLE `VideoAsset` MODIFY `sourceType` ENUM('UPLOAD', 'DIRECT_URL', 'EMBED', 'DB_BLOB') NOT NULL DEFAULT 'DIRECT_URL';

-- CreateTable
CREATE TABLE `VideoBinaryAsset` (
    `id` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `data` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoBinaryAsset_videoId_key`(`videoId`),
    INDEX `VideoBinaryAsset_videoId_idx`(`videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VideoBinaryAsset` ADD CONSTRAINT `VideoBinaryAsset_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
