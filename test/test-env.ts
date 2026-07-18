/**
 * Committed test-environment fixture, preloaded by `yarn test`.
 *
 * `src/app.module.ts` runs `loadApiEnv()` and
 * `ConfigModule.forRoot({ validate: validateEnv })` at import time, so any
 * test that imports it needs a validation-complete set of env values. A clean
 * checkout has no `.env`/`.env.local` (both are gitignored), which made the
 * suite fail asynchronously with "DATABASE_URL is required".
 *
 * Rules:
 * - only fills variables that are still unset — CI/operator-provided env
 *   always wins;
 * - test-only placeholder values, never production secrets;
 * - the database URL is clearly test-scoped and the unit suite never opens a
 *   connection to it.
 */
const testEnvDefaults: Record<string, string> = {
  APP_ENV: "test",
  NODE_ENV: "test",
  DATABASE_URL:
    "mysql://test_user:test_password@127.0.0.1:3307/video_share_cms_test",
  JWT_ACCESS_SECRET: "test-only-jwt-access-secret-0123456789abcdef",
  REFRESH_TOKEN_PEPPER: "test-only-refresh-token-pepper-0123456789abcdef",
  SHARE_TOKEN_PEPPER: "test-only-share-token-pepper-0123456789abcdef",
  ACCESS_LOG_IP_PEPPER: "test-only-access-log-ip-pepper-0123456789abcdef",
};

for (const [key, value] of Object.entries(testEnvDefaults)) {
  process.env[key] ??= value;
}
