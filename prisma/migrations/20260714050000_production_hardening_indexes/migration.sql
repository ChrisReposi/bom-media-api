-- Additive indexes for verified admin list and stale-upload query shapes.
CREATE INDEX `VideoUploadSession_status_expiresAt_idx` ON `VideoUploadSession`(`status`, `expiresAt`);
CREATE INDEX `VideoUploadSession_status_createdAt_idx` ON `VideoUploadSession`(`status`, `createdAt`);
CREATE INDEX `Website_createdAt_idx` ON `Website`(`createdAt`);
CREATE INDEX `Website_status_createdAt_idx` ON `Website`(`status`, `createdAt`);
CREATE INDEX `DomainGroup_status_key_idx` ON `DomainGroup`(`status`, `key`);
CREATE INDEX `WebsiteDomain_status_domain_idx` ON `WebsiteDomain`(`status`, `domain`);
CREATE INDEX `ShareLink_websiteId_createdAt_idx` ON `ShareLink`(`websiteId`, `createdAt`);
