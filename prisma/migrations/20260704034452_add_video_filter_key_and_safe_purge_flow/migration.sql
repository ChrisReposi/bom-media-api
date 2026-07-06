-- AlterTable
ALTER TABLE `VideoAsset` ADD COLUMN `filterKey` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `VideoAsset_filterKey_idx` ON `VideoAsset`(`filterKey`);

-- CreateIndex
CREATE INDEX `VideoAsset_filterKey_status_createdAt_idx` ON `VideoAsset`(`filterKey`, `status`, `createdAt`);
