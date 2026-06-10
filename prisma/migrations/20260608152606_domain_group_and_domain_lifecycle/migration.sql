-- AlterTable
ALTER TABLE `Website` ADD COLUMN `domainGroupId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `DomainGroup` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(80) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DomainGroup_key_key`(`key`),
    INDEX `DomainGroup_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Website_domainGroupId_idx` ON `Website`(`domainGroupId`);

-- AddForeignKey
ALTER TABLE `Website` ADD CONSTRAINT `Website_domainGroupId_fkey` FOREIGN KEY (`domainGroupId`) REFERENCES `DomainGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
