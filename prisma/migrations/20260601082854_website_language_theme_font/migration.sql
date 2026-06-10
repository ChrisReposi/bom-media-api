-- AlterTable
ALTER TABLE `ThemeConfig` ADD COLUMN `fontKey` VARCHAR(80) NOT NULL DEFAULT 'be-vietnam-pro';

-- AlterTable
ALTER TABLE `Website` ADD COLUMN `language` ENUM('VI', 'EN') NOT NULL DEFAULT 'VI';
