"use strict";

/**
 * Force the disposable Docker database for the opt-in MariaDB proof while
 * keeping its connection target out of package-manager command output.
 */
process.env.APP_ENV = "test";
process.env.DATABASE_URL =
  "mysql://bom_media_test:bom_media_test@127.0.0.1:3308/video_share_cms_mariadb_test";
