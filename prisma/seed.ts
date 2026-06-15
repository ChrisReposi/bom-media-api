import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hash } from "bcryptjs";
import {
  AccountStatus,
  AdminRole,
  PrismaClient,
} from "../src/generated/prisma/client";
import { loadApiEnv } from "../src/config/load-env";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const PASSWORD_HASH_ROUNDS = 12;

loadApiEnv();

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for database seeding`);
  }

  return value.trim();
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function requireBootstrapUsername(): string {
  const username = normalizeUsername(requireEnv("ADMIN_BOOTSTRAP_USERNAME"));

  if (
    username.length < 3 ||
    username.length > 32 ||
    !USERNAME_PATTERN.test(username)
  ) {
    throw new Error(
      "ADMIN_BOOTSTRAP_USERNAME must be 3-32 characters and contain only letters, numbers, and underscores",
    );
  }

  return username;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createMariaDbAdapter(databaseUrl: string): PrismaMariaDb {
  const url = new URL(databaseUrl);

  return new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: readPositiveIntegerEnv("DB_CONNECTION_LIMIT", 5),
    connectTimeout: readPositiveIntegerEnv("DB_CONNECT_TIMEOUT_MS", 10_000),
    acquireTimeout: readPositiveIntegerEnv("DB_ACQUIRE_TIMEOUT_MS", 10_000),
    idleTimeout: readPositiveIntegerEnv("DB_IDLE_TIMEOUT_SECONDS", 60),
    allowPublicKeyRetrieval: true,
  });
}

const prisma = new PrismaClient({
  adapter: createMariaDbAdapter(requireEnv("DATABASE_URL")),
});

async function main(): Promise<void> {
  const username = requireBootstrapUsername();
  const password = requireEnv("ADMIN_BOOTSTRAP_PASSWORD");
  const passwordHash = await hash(password, PASSWORD_HASH_ROUNDS);

  await prisma.adminUser.upsert({
    where: { username },
    update: {
      passwordHash,
      role: AdminRole.OWNER,
      status: AccountStatus.ACTIVE,
    },
    create: {
      username,
      passwordHash,
      role: AdminRole.OWNER,
      status: AccountStatus.ACTIVE,
    },
  });

  console.info(`Seeded bootstrap admin account for username: ${username}`);
}

main()
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown seed error";
    console.error(`Database seed failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
