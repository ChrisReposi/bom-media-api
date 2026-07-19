# Share-link Website Video Assignment Runbook

Date: 2026-07-16

## Security invariant

A share-link video is eligible only when the target website is ACTIVE, the same-site `WebsiteVideo` is ACTIVE, the video is READY, and its configured source is playable. Share-link creation and public watch both enforce this rule. The create operation never creates an assignment implicitly.

## Compatibility classification

| Conflict type               | Status             | Meaning                                                                |
| --------------------------- | ------------------ | ---------------------------------------------------------------------- |
| Schema migration conflict   | NO                 | The scoped list and stable error contract require no schema change.    |
| Behavioral policy conflict  | YES                | Global READY video selection is no longer valid for share-link create. |
| Legacy data conflict        | POSSIBLE           | Older link rows may lack a matching ACTIVE same-site assignment.       |
| Admin Web contract mismatch | RESOLVED IN SOURCE | Dashboard uses the website-scoped eligible endpoint.                   |

## Production read-only audit — do not run without operator approval

Use a read-only database principal and the Production secret injection mechanism. Do not put a database URL, token, hash or secret in the shell history.

```bash
APP_ENV=production yarn audit:share-link-assignments --counts-only
```

Exit codes:

- `0`: no affected ACTIVE share link was found.
- `2`: affected ACTIVE link data was found; owner decisions are required.
- `1`: configuration or query failure; results are not valid.

The audit reports counts for missing/inactive same-site assignments, other-site-only assignments, partial links, zero-playable links, READY videos without an ACTIVE assignment, websites with active links but no active assignments, disabled assignments and a bounded sample of multi-website video usage. Non-count output contains masked identifiers only.

## Owner-approved remediation worksheet

| Case     | Website    | Video      | Existing links   | Evidence           | Recommended action                                                                                                                      | Owner decision         |
| -------- | ---------- | ---------- | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `<case>` | `<masked>` | `<masked>` | `<count/status>` | `<verified facts>` | `CREATE_ACTIVE_ASSIGNMENT` / `REACTIVATE_ASSIGNMENT` / `REMOVE_VIDEO_FROM_LINK` / `REVOKE_LINK` / `NO_ACTION` / `INSUFFICIENT_EVIDENCE` | `<approval reference>` |

Never infer ownership merely because a video appears in an old `ShareLinkVideo` row. Universal backfill from share-link history is unsafe.

## Approved mutation procedure

1. Back up MySQL and record the restore point.
2. Obtain an owner decision for each masked case and resolve the exact identifiers in the controlled session.
3. Use the authenticated application endpoint/service, not ad-hoc SQL:
   - `POST /api/v1/admin/websites/:websiteId/videos/assign` to create/reactivate one intended assignment.
   - Existing revoke operation for an obsolete share link.
4. Require the application audit event and capture only masked before/after evidence.
5. Re-run the read-only audit, then smoke the intended host, website-scoped picker, share-link create and public watch.
6. Compensate by reverting only the approved assignment or revoking the newly created link. Do not reset the database.

## Bulk assignment management contract

The Dashboard assignment dialog uses two additive admin endpoints:

```txt
GET   /api/v1/admin/websites/:websiteId/video-assignment-options
PATCH /api/v1/admin/websites/:websiteId/video-assignments
```

The read endpoint returns every ACTIVE assignment in its authoritative
`activeAssignedVideoIds` metadata, including assigned videos that are no longer
READY/playable. Its paginated items contain active assignments plus eligible
unassigned candidates; binary data and credentials are never selected or
returned. OWNER, ADMIN and STAFF may read the state.

The PATCH endpoint is OWNER/ADMIN-only and accepts bounded, disjoint
`assignVideoIds` and `unassignVideoIds` arrays (100 total IDs maximum). It
validates the entire request, reactivates existing DISABLED rows, marks removed
rows DISABLED, writes one bounded audit event, and commits all assignment
changes in one Serializable transaction. Invalid input produces no assignment
write.

Unassignment does not delete or rotate a canonical mapping. The canonical and
public-watch paths continue to enforce `WebsiteVideo.ACTIVE`, so an existing
canonical URL becomes non-shareable until an operator explicitly reactivates
the assignment. This preserves the recorded canonical identity while keeping
the assignment boundary authoritative.

## Deployment and monitoring

Deploy the additive API list/error/assignment contract before the Admin Web. Audit and remediate approved legacy data before relying on existing links. Monitor `VIDEO_NOT_ACTIVE_FOR_WEBSITE` responses, public generic-invalid rates and assignment audit events. The additive endpoint can remain during a frontend rollback; never roll back by weakening the backend invariant.

No Production database or deployed artifact was accessed while implementing
the bulk assignment contract.
