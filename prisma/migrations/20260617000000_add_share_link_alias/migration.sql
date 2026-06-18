ALTER TABLE `ShareLink` ADD COLUMN `alias` VARCHAR(16) NULL;

CREATE UNIQUE INDEX `ShareLink_alias_key` ON `ShareLink`(`alias`);
