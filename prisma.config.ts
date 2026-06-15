import { defineConfig, env } from "prisma/config";
import { loadApiEnv } from "./src/config/load-env";

loadApiEnv();

const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
