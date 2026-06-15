# Secret Rotation Runbook

This runbook is for BOM Media API production operations. It is a manual operator guide; it does not mean any secret has already been rotated.

Never paste real secret values into git, tickets, chat, logs, screenshots, or this document.

## Scope

Secrets covered here:

- `CLOUDINARY_API_SECRET`
- `JWT_ACCESS_SECRET`
- `REFRESH_TOKEN_PEPPER`
- `SHARE_TOKEN_PEPPER`
- `ACCESS_LOG_IP_PEPPER`
- `ADMIN_REGISTER_SECRET`
- `ADMIN_CHANGE_PASSWORD_SECRET`

The live backend currently uses session-bound admin access tokens, opaque refresh tokens, hashed share tokens, and hashed IP metadata. There is no pepper-version compatibility layer.

## Impact Matrix

| Secret | Rotation impact | Forced admin re-login | Share-link impact | Rollback note |
| --- | --- | --- | --- | --- |
| `CLOUDINARY_API_SECRET` | Affects Cloudinary upload/delete API calls after restart. Existing URLs remain valid. | No | No | If the old key was not revoked, restore old env and restart. |
| `JWT_ACCESS_SECRET` | Existing access JWTs fail signature validation. | Access tokens fail immediately; refresh may recover if refresh session is valid. Plan for re-login. | No | Restore old secret only if it was not compromised. |
| `REFRESH_TOKEN_PEPPER` | Existing refresh tokens no longer hash to stored values. | Yes, once access tokens expire or sessions are explicitly revoked. Recommended: rotate with session revocation. | No | Restore old pepper only if it was not compromised. |
| `SHARE_TOKEN_PEPPER` | Existing raw share tokens no longer match stored hashes. | No | Yes, old share links stop working unless pepper versioning exists. | Restore old pepper only if acceptable and uncompromised. |
| `ACCESS_LOG_IP_PEPPER` | Future IP hashes differ from historical hashes. | No | No | Restoring old pepper restores hash comparability only for future events. |
| `ADMIN_REGISTER_SECRET` | Affects admin registration authorization. | No | No | Restore previous value if not compromised. |
| `ADMIN_CHANGE_PASSWORD_SECRET` | Affects password-change authorization if the endpoint requires the operator secret. | No by itself | No | Restore previous value if not compromised. |

## Routine Rotation Order

1. **Manual operator action:** confirm a recent database backup exists and has a recent restore test.
2. **Code/config action:** prepare new placeholder-free production env values outside git.
3. **Manual operator action:** rotate Cloudinary first in the Cloudinary dashboard.
4. **Code/config action:** update Hostinger/process env for `CLOUDINARY_API_SECRET`, then restart API.
5. **Verification action:** upload a small test video/thumbnail and verify remote deletion still works only for system-owned assets.
6. **Code/config action:** rotate `ADMIN_REGISTER_SECRET` and `ADMIN_CHANGE_PASSWORD_SECRET`.
7. **Code/config action:** rotate `JWT_ACCESS_SECRET`; expect existing access tokens to fail.
8. **Code/config action:** rotate `REFRESH_TOKEN_PEPPER` during a maintenance window. Because there is no pepper-version compatibility, plan to revoke active admin sessions or require admins to log in again.
9. **Manual operator action:** rotate `SHARE_TOKEN_PEPPER` only after deciding that existing share links may be invalidated.
10. **Manual operator action:** rotate `ACCESS_LOG_IP_PEPPER` only after recording that future IP hashes will not compare directly with old hashes.

## Emergency Compromise Procedure

Use this when a secret may have been exposed.

1. **Manual operator action:** disable or restrict admin access at Cloudflare Access/WAF if admin compromise is suspected.
2. **Manual operator action:** rotate the suspected external secret at the provider first, for example Cloudinary dashboard.
3. **Code/config action:** update production env with new secret values and restart the API.
4. **Code/config action:** if auth secrets were exposed, rotate `JWT_ACCESS_SECRET` and `REFRESH_TOKEN_PEPPER`.
5. **Manual operator action:** revoke active admin sessions through an audited admin operation or a reviewed database maintenance action.
6. **Manual operator action:** if share tokens were exposed, rotate `SHARE_TOKEN_PEPPER` and communicate that old public links are invalid.
7. **Verification action:** confirm old access tokens fail, old refresh tokens fail, and new login succeeds.
8. **Verification action:** inspect `AdminAuditLog` for suspicious login, refresh replay, password change, and share-link actions.
9. **Rollback note:** do not roll back to a compromised secret. Roll back only to a previous uncompromised value during a false alarm.

## Cloudinary Secret Rotation

1. **Manual operator action:** in Cloudinary, create or rotate the API secret.
2. **Code/config action:** update production env:

   ```env
   CLOUDINARY_CLOUD_NAME=<cloud-name>
   CLOUDINARY_API_KEY=<api-key>
   CLOUDINARY_API_SECRET=<new-secret>
   CLOUDINARY_UPLOAD_FOLDER=video-cms/videos
   CLOUDINARY_SECURE=true
   ```

3. **Code/config action:** restart the API process.
4. **Verification action:** upload a test thumbnail and video through Admin Web.
5. **Verification action:** verify no Cloudinary secret appears in Admin Web env, browser network responses, logs, or docs.

## JWT Access Secret Rotation

1. **Code/config action:** update `JWT_ACCESS_SECRET`.
2. **Code/config action:** restart API.
3. **Verification action:** confirm an old access token fails protected admin endpoints.
4. **Verification action:** confirm new login receives a new access token and admin endpoints work.

Rollback: restore the old secret only if it was not compromised. Otherwise force re-login.

## Refresh Pepper Rotation

1. **Manual operator action:** schedule a maintenance window.
2. **Code/config action:** update `REFRESH_TOKEN_PEPPER`.
3. **Code/config action:** restart API.
4. **Manual operator action:** revoke active admin sessions if immediate invalidation is required.
5. **Verification action:** confirm old refresh token replay is rejected and audited.
6. **Verification action:** confirm new login and refresh rotation work.

Rollback: restoring the old pepper re-enables old refresh-token hashes if sessions/tokens were not revoked. Do not restore it after confirmed compromise.

## Share Token Pepper Rotation

Rotating `SHARE_TOKEN_PEPPER` invalidates existing share links because stored hashes cannot be recomputed without the old pepper.

1. **Manual operator action:** decide whether all existing share links may be invalidated.
2. **Manual operator action:** notify affected admins/customers.
3. **Code/config action:** update `SHARE_TOKEN_PEPPER` and restart API.
4. **Verification action:** confirm old share links fail generically.
5. **Verification action:** create a new share link and confirm public watch works.

Rollback: restore old pepper only if it was not compromised and old share links must temporarily work again.

## Access Log IP Pepper Rotation

Rotating `ACCESS_LOG_IP_PEPPER` does not affect authentication, but it breaks direct comparison between old and new IP hashes.

1. **Manual operator action:** record the rotation date in the security log.
2. **Code/config action:** update `ACCESS_LOG_IP_PEPPER` and restart API.
3. **Verification action:** confirm access/auth audit rows still store hashes, not raw IP addresses.

## Admin Operator Secrets

Set production values outside git:

```env
ADMIN_REGISTER_ENABLED=false
ADMIN_REGISTER_SECRET=<rotate-before-production>
ADMIN_CHANGE_PASSWORD_SECRET=<rotate-before-production>
```

`ADMIN_REGISTER_ENABLED` should remain false in production unless there is a controlled onboarding window.

