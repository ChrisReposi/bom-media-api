-- Email-safe reviewer URL: a SEPARATE 128-bit transport identifier for the
-- fragment-independent `/watch?r=<transportAlias>` form. Additive and nullable:
-- every existing row keeps working through `alias` / `tokenHash`, and the
-- previous build ignores the column. Never backfilled by this migration;
-- values are minted by the application only for links that are usable.

-- AlterTable
ALTER TABLE `ShareLink` ADD COLUMN `transportAlias` VARCHAR(32) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `ShareLink_transportAlias_key` ON `ShareLink`(`transportAlias`);
