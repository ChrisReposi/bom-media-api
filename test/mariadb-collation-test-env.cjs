"use strict";

/**
 * Force the disposable stock-collation Docker database for the opt-in MariaDB
 * collation/search proof while keeping its connection target out of
 * package-manager command output.
 */
process.env.APP_ENV = "test";
process.env.DATABASE_URL =
  "mysql://bom_media_collation:bom_media_collation@127.0.0.1:3312/video_share_cms_collation_test";
process.env.ALLOW_DESTRUCTIVE_DB_TESTS = "I_UNDERSTAND_THIS_DELETES_FIXTURES";
