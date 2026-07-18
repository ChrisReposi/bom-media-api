-- Additive admin account lifecycle fields and indexes. Existing accounts keep
-- their current role, status, password, and sessions.
ALTER TABLE `AdminUser`
  ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `passwordChangedAt` DATETIME(3) NULL,
  ADD COLUMN `temporaryPasswordExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `deletedAt` DATETIME(3) NULL;

CREATE INDEX `AdminUser_deletedAt_createdAt_idx`
  ON `AdminUser`(`deletedAt`, `createdAt`);
CREATE INDEX `AdminUser_deletedAt_status_role_createdAt_idx`
  ON `AdminUser`(`deletedAt`, `status`, `role`, `createdAt`);
CREATE INDEX `AdminSession_adminId_revokedAt_expiresAt_idx`
  ON `AdminSession`(`adminId`, `revokedAt`, `expiresAt`);
CREATE INDEX `AdminRefreshToken_adminId_revokedAt_expiresAt_idx`
  ON `AdminRefreshToken`(`adminId`, `revokedAt`, `expiresAt`);
