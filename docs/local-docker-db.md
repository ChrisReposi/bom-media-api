# Local Docker Database

This backend can run fully against a local Docker MySQL database for development
and testing. Local commands should use `.env.local`, not Hostinger database
credentials.

## First Setup

```bash
cp .env.local.example .env.local

docker compose -f docker-compose.local.yml up -d

docker compose -f docker-compose.local.yml ps
```

Verify the databases exist:

```bash
docker exec -it bom_media_api_mysql mysql \
  -u video_share_user \
  -pvideo_share_password \
  -e "SHOW DATABASES;"
```

Generate Prisma, run migrations, seed, and start the API:

```bash
yarn db:local:generate
yarn db:local:migrate
yarn db:local:seed
yarn dev:local
```

Verify the API:

```bash
curl http://localhost:3000/api/v1/health
```

## Local Connection Targets

Docker exposes MySQL like this:

```txt
container: 3306
host:      127.0.0.1:3307
```

Prisma and the NestJS API must use:

```txt
DATABASE_URL=mysql://video_share_user:video_share_password@127.0.0.1:3307/video_share_cms_dev
SHADOW_DATABASE_URL=mysql://video_share_user:video_share_password@127.0.0.1:3307/video_share_cms_shadow
```

The API logs a sanitized local development target like:

```txt
Database target: 127.0.0.1:3307/video_share_cms_dev
```

It never logs the database username or password.

## Common Local Commands

```bash
yarn docker:local:up
yarn docker:local:logs
yarn db:local:generate
yarn db:local:validate
yarn db:local:migrate
yarn db:local:seed
yarn dev:local
```

The shorter local-development commands also force `.env.local`:

```bash
yarn db:generate
yarn db:migrate:dev
yarn db:seed
```

Production deploy commands such as `yarn db:migrate:deploy` still use the
environment provided by the deployment runtime.

## Reset Local Database

To reset the Docker volume and rerun MySQL init scripts:

```bash
yarn docker:local:reset
yarn db:local:migrate
yarn db:local:seed
```

MySQL entrypoint init SQL in `docker/mysql/init` runs only when the Docker
volume is first created. If `video_share_cms_shadow` is missing, reset the
volume with `yarn docker:local:reset`.

## Verify Tables And Seeded Admin

```bash
docker exec -it bom_media_api_mysql mysql \
  -u video_share_user \
  -pvideo_share_password \
  video_share_cms_dev \
  -e "SHOW TABLES;"
```

Check the seeded admin without printing password hashes:

```bash
docker exec -it bom_media_api_mysql mysql \
  -u video_share_user \
  -pvideo_share_password \
  video_share_cms_dev \
  -e "SELECT username, role, status FROM AdminUser;"
```

If table names differ after Prisma migrations, inspect the table list first and
query only non-secret columns.

## If The API Still Uses Hostinger

Check for shell-exported database values:

```bash
echo $DATABASE_URL
```

Force local mode:

```bash
APP_ENV=local DOTENV_CONFIG_PATH=.env.local yarn dev:local
```

Do not copy Hostinger credentials into `.env.local`.
