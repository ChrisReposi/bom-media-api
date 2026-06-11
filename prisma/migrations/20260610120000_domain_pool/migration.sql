-- Domain pool support: allow domains to exist before website assignment.
ALTER TABLE `WebsiteDomain` DROP FOREIGN KEY `WebsiteDomain_websiteId_fkey`;

ALTER TABLE `WebsiteDomain`
  ADD COLUMN `domainGroupId` VARCHAR(191) NULL,
  MODIFY `websiteId` VARCHAR(191) NULL;

-- Preserve useful grouping for already-assigned domains.
UPDATE `WebsiteDomain` wd
INNER JOIN `Website` w ON w.`id` = wd.`websiteId`
SET wd.`domainGroupId` = w.`domainGroupId`
WHERE wd.`domainGroupId` IS NULL
  AND w.`domainGroupId` IS NOT NULL;

CREATE INDEX `WebsiteDomain_domainGroupId_idx` ON `WebsiteDomain`(`domainGroupId`);

ALTER TABLE `WebsiteDomain`
  ADD CONSTRAINT `WebsiteDomain_websiteId_fkey`
    FOREIGN KEY (`websiteId`) REFERENCES `Website`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WebsiteDomain`
  ADD CONSTRAINT `WebsiteDomain_domainGroupId_fkey`
    FOREIGN KEY (`domainGroupId`) REFERENCES `DomainGroup`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
