import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hash } from "argon2";
import { config } from "dotenv";
import {
  AccountStatus,
  AdminRole,
  PrismaClient,
} from "../src/generated/prisma/client";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

config({ path: ".env" });
config({ path: "../../.env" });

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

function createMariaDbAdapter(databaseUrl: string): PrismaMariaDb {
  const url = new URL(databaseUrl);

  return new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: 5,
    allowPublicKeyRetrieval: true,
  });
}

const prisma = new PrismaClient({
  adapter: createMariaDbAdapter(requireEnv("DATABASE_URL")),
});

async function main(): Promise<void> {
  const username = requireBootstrapUsername();
  const password = requireEnv("ADMIN_BOOTSTRAP_PASSWORD");
  const passwordHash = await hash(password);

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
