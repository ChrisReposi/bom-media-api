# apps/api/AGENTS.md — NestJS API Rules

## Scope

This app is the central backend API for the entire platform.

## Stack

- NestJS
- Prisma
- MySQL/MariaDB
- JWT
- class-validator DTOs
- Swagger
- Pino logger
- Helmet
- CORS
- ValidationPipe
- Global exception filter

## Required API Modules

Implement modules in this general direction:

```txt
auth
admins
videos
websites
website-domains
website-videos
share-links
public-watch
access-logs
admin-audit-logs
health
```

## API Prefix

Use:

```txt
/api/v1
```

Swagger path:

```txt
/docs
```

Swagger should be enabled only when allowed by env.

## Security Requirements

- Hash admin passwords.
- Never return passwordHash.
- Never log tokens.
- Never store raw share token.
- Store share token hash.
- Public token validation must be constant enough for MVP and not leak detailed reasons.
- Rate-limit login and public watch endpoints.
- Verify hostname/domain on public watch.

## Prisma Requirements

- Use MySQL provider.
- Add useful indexes.
- Prefer soft disable/status over hard delete for important records.
- Use migrations.
- Add seed script for initial admin.

## Response Style

Prefer consistent response shape:

```ts
{
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  meta?: unknown;
}
```

Keep public errors generic.

## Public Watch Flow

Input:

```txt
host
token
```

Output if valid:

```txt
website
videos
```

Output if invalid:

```txt
valid: false
videos: []
```

Do not reveal whether the token existed, expired, revoked, or belonged to another website.

## Video Provider

Use an abstraction:

```ts
interface VideoProviderService {
  resolvePlayback(input): Promise<ResolvedPlayback>;
  createSignedPlaybackUrl?(input): Promise<SignedPlayback>;
}
```

MVP can start with manual URL mode.

## Testing

At minimum, add tests around:

- token hashing and validation
- domain mismatch rejection
- expired link rejection
- max views rejection
- revoked link rejection
