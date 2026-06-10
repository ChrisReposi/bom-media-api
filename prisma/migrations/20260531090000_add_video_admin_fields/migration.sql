-- AlterTable
ALTER TABLE `VideoAsset`
    ADD COLUMN `slug` VARCHAR(160) NULL,
    ADD COLUMN `viewCount` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `publishedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `VideoAsset_slug_key` ON `VideoAsset`(`slug`);

-- CreateIndex
CREATE INDEX `VideoAsset_publishedAt_idx` ON `VideoAsset`(`publishedAt`);

-- CreateIndex
CREATE INDEX `VideoAsset_slug_idx` ON `VideoAsset`(`slug`);
