CREATE DATABASE IF NOT EXISTS video_share_cms_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE DATABASE IF NOT EXISTS video_share_cms_shadow
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON video_share_cms_dev.* TO 'video_share_user'@'%';
GRANT ALL PRIVILEGES ON video_share_cms_shadow.* TO 'video_share_user'@'%';

FLUSH PRIVILEGES;