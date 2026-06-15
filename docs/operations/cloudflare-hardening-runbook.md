# Cloudflare Hardening Runbook

## Purpose

Use Cloudflare or an equivalent reverse proxy to reduce direct abuse before traffic reaches the API.

This runbook is guidance only. It does not mean Cloudflare dashboard settings, tunnels, WAF rules, Access policies, DNS changes, or rate limits have already been configured.

## Hosts And Paths To Protect

Protect these hostnames:

- admin web hostname
- API hostname
- public static website hostnames

Protect these paths/areas:

```txt
/api/v1/admin/auth/login
/api/v1/admin/auth/register
/api/v1/admin/auth/refresh
/api/v1/admin/auth/logout
/api/v1/admin/auth/change-password
/api/v1/public/watch*
/api/v1/public/watch/:token/videos/:videoId/binary
/_watch/*
/_media/*
/_api/public/*
```

## Admin Web Access

Manual dashboard steps:

1. Put the admin-web hostname behind Cloudflare Access before users reach React Admin Web.
2. Set default policy to deny.
3. Allow only approved admin identities or groups.
4. Prefer MFA/passkeys through the identity provider.
5. Keep backend admin auth enabled; Cloudflare Access is an extra gate, not a replacement.

Rollback note: if Access blocks legitimate admins during launch, temporarily relax only the admin-web Access policy. Do not disable backend auth.

## Origin Protection

Preferred:

- Use Cloudflare Tunnel so the raw API origin is not directly reachable.

Alternative:

- Configure origin firewall rules allowing only Cloudflare IP ranges.

Do not rely on Cloudflare WAF if the raw Hostinger/API origin remains reachable directly.

## Starter WAF / Rate-Limit Rules

These are conservative starting points. Tune with real traffic and app-side throttling metrics.

| Area | Starter threshold | Suggested action |
| --- | --- | --- |
| `/api/v1/admin/auth/login` | 10 requests/minute/IP, 30 requests/10 minutes/IP | Managed challenge or block |
| `/api/v1/admin/auth/register` | 5 requests/minute/IP | Managed challenge or block |
| `/api/v1/admin/auth/refresh` | 60 requests/minute/IP | Managed challenge, then block on sustained abuse |
| `/api/v1/admin/auth/logout` | 60 requests/minute/IP | Log/challenge; avoid breaking normal logout |
| `/api/v1/admin/auth/change-password` | 10 requests/minute/IP | Challenge/block |
| `/api/v1/public/watch*` | 120 requests/minute/IP per public hostname | Challenge or rate-limit response |
| `/api/v1/public/watch/:token/videos/:videoId/binary` | Higher threshold; video range requests are bursty | Monitor first, then rate-limit carefully |
| `/_watch/*`, `/_api/public/*` | 120 requests/minute/IP | Challenge/rate-limit |
| `/_media/*` | Depends on media delivery design | Monitor; avoid blocking legitimate playback |

Cloudflare does not replace NestJS throttling. Keep app-side throttles enabled because direct-origin mistakes, Cloudflare misconfiguration, and authenticated abuse can still happen.

## API Env

If all API traffic reaches the origin through a trusted proxy path:

```env
TRUST_PROXY_ENABLED=true
TRUST_PROXY_HOPS=1
TRUST_PROXY_CLOUDFLARE_ONLY=false
```

Only set `TRUST_PROXY_CLOUDFLARE_ONLY=true` if the deployment ensures spoofed `cf-connecting-ip` headers cannot be sent directly to the origin.

## Upload Caveat

Large Hostinger/private NVMe uploads use the API chunked `upload-local` flow so each request stays below the configured chunk size. Cloudflare proxied request body limits can still affect chunk size and timeout behavior, so keep `LOCAL_VIDEO_CHUNK_SIZE_MB` conservative and test the exact admin/API host path before raising limits toward 1GB total files. Do not route large production videos into MySQL `DB_BLOB`.

LOCAL_FILE playback and thumbnails are served through token-protected API media routes. If public sites proxy backend routes through `/_api/*`, Cloudflare/Worker/origin rules must preserve:

- `Range`
- `Accept-Ranges`
- `Content-Range`
- `Content-Length`
- `Content-Type`

If a future public site uses `/_media/*`, the Worker must explicitly proxy `/_media/*` too. Do not assume `/_media/*` is active until deployed and smoke-tested.

Do not apply the same strict public-watch token-exchange rate limits to media Range playback. Browser seeking can create many valid Range requests. Use app-side `PUBLIC_MEDIA_THROTTLE_*` and edge rules that tolerate normal seeking while still limiting abusive clients. Cloudflare should not cache private token media unless the system moves to an explicit signed-URL cache design.

## Verification

- Confirm application logs/audit rows show hashed real client IPs, not only proxy IPs.
- Confirm repeated login abuse receives 429 from API and/or Cloudflare.
- Confirm public watch valid links still work.
- Confirm invalid public watch links remain generic.
- Confirm direct raw-origin requests are blocked or controlled.
- Confirm admin-web hostname requires Cloudflare Access before React Admin Web loads.

## Rollback Notes

- Roll back individual WAF/rate-limit rules before disabling Cloudflare globally.
- If Access misconfiguration blocks all admins, use the provider break-glass process and record the change.
- If proxy trust env is wrong, disable `TRUST_PROXY_ENABLED` until the real proxy path is confirmed.
