-- Add Hostinger/private-NVMe local file video source support.
ALTER TABLE `VideoAsset` MODIFY `sourceType` ENUM('UPLOAD', 'DIRECT_URL', 'EMBED', 'DB_BLOB', 'LOCAL_FILE') NOT NULL DEFAULT 'DIRECT_URL';

CREATE TABLE `VideoLocalFileAsset` (
    `id` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `originalFilename` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `checksumSha256` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoLocalFileAsset_videoId_key`(`videoId`),
    UNIQUE INDEX `VideoLocalFileAsset_storageKey_key`(`storageKey`),
    INDEX `VideoLocalFileAsset_videoId_idx`(`videoId`),
    INDEX `VideoLocalFileAsset_storageKey_idx`(`storageKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VideoLocalThumbnailAsset` (
    `id` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `originalFilename` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `checksumSha256` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoLocalThumbnailAsset_videoId_key`(`videoId`),
    UNIQUE INDEX `VideoLocalThumbnailAsset_storageKey_key`(`storageKey`),
    INDEX `VideoLocalThumbnailAsset_videoId_idx`(`videoId`),
    INDEX `VideoLocalThumbnailAsset_storageKey_idx`(`storageKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VideoUploadSession` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `videoId` VARCHAR(191) NULL,
    `title` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(160) NULL,
    `description` TEXT NULL,
    `originalFilename` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `totalBytes` BIGINT NOT NULL,
    `totalChunks` INTEGER NOT NULL,
    `chunkSizeBytes` INTEGER NOT NULL,
    `receivedChunks` INTEGER NOT NULL DEFAULT 0,
    `tempStorageKey` VARCHAR(512) NOT NULL,
    `finalStorageKey` VARCHAR(512) NULL,
    `checksumSha256` VARCHAR(64) NULL,
    `status` ENUM('ACTIVE', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'ACTIVE',
    `expiresAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `abortedAt` DATETIME(3) NULL,
    `metadataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoUploadSession_tempStorageKey_key`(`tempStorageKey`),
    INDEX `VideoUploadSession_adminId_idx`(`adminId`),
    INDEX `VideoUploadSession_videoId_idx`(`videoId`),
    INDEX `VideoUploadSession_status_idx`(`status`),
    INDEX `VideoUploadSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VideoUploadSessionChunk` (
    `id` VARCHAR(191) NOT NULL,
    `uploadSessionId` VARCHAR(191) NOT NULL,
    `chunkIndex` INTEGER NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `checksumSha256` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VideoUploadSessionChunk_storageKey_key`(`storageKey`),
    UNIQUE INDEX `VideoUploadSessionChunk_uploadSessionId_chunkIndex_key`(`uploadSessionId`, `chunkIndex`),
    INDEX `VideoUploadSessionChunk_uploadSessionId_idx`(`uploadSessionId`),
    INDEX `VideoUploadSessionChunk_chunkIndex_idx`(`chunkIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VideoLocalFileAsset` ADD CONSTRAINT `VideoLocalFileAsset_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `VideoLocalThumbnailAsset` ADD CONSTRAINT `VideoLocalThumbnailAsset_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `VideoUploadSession` ADD CONSTRAINT `VideoUploadSession_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `VideoUploadSession` ADD CONSTRAINT `VideoUploadSession_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `VideoAsset`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `VideoUploadSessionChunk` ADD CONSTRAINT `VideoUploadSessionChunk_uploadSessionId_fkey` FOREIGN KEY (`uploadSessionId`) REFERENCES `VideoUploadSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
