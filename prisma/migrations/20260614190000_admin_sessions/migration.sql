-- Add server-side admin sessions for session-bound access tokens.
CREATE TABLE `AdminSession` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(80) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `ipHash` VARCHAR(128) NULL,
    `userAgentHash` VARCHAR(128) NULL,
    `userAgent` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AdminSession_adminId_idx`(`adminId`),
    INDEX `AdminSession_expiresAt_idx`(`expiresAt`),
    INDEX `AdminSession_revokedAt_idx`(`revokedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AdminRefreshToken` ADD COLUMN `sessionId` VARCHAR(191) NULL;
CREATE INDEX `AdminRefreshToken_sessionId_idx` ON `AdminRefreshToken`(`sessionId`);

ALTER TABLE `AdminSession` ADD CONSTRAINT `AdminSession_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AdminRefreshToken` ADD CONSTRAINT `AdminRefreshToken_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `AdminSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
