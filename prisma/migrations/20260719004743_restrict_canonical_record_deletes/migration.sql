-- DropForeignKey
ALTER TABLE `CanonicalVideoShareLink` DROP FOREIGN KEY `CanonicalVideoShareLink_shareLinkId_fkey`;

-- DropForeignKey
ALTER TABLE `CanonicalVideoShareLink` DROP FOREIGN KEY `CanonicalVideoShareLink_websiteId_fkey`;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_websiteId_fkey` FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CanonicalVideoShareLink` ADD CONSTRAINT `CanonicalVideoShareLink_shareLinkId_fkey` FOREIGN KEY (`shareLinkId`) REFERENCES `ShareLink`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
