-- Add username first so existing local development admins can be backfilled
-- before the old email login field is removed.
ALTER TABLE `AdminUser` ADD COLUMN `username` VARCHAR(32) NULL;

UPDATE `AdminUser`
SET `username` = LOWER(LEFT(SUBSTRING_INDEX(`email`, '@', 1), 32))
WHERE `username` IS NULL;

ALTER TABLE `AdminUser` DROP INDEX `AdminUser_email_key`;
ALTER TABLE `AdminUser` MODIFY `username` VARCHAR(32) NOT NULL;
CREATE UNIQUE INDEX `AdminUser_username_key` ON `AdminUser`(`username`);
ALTER TABLE `AdminUser` DROP COLUMN `email`;
