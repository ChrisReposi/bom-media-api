# Share-link Assignment Remediation Worksheet

Date: 2026-07-16  
Environment audited: local development database  
Mode: read-only audit plus one explicitly approved local service remediation; identifiers and aliases are masked

The two legacy share-link cases below were audited read-only and remain pending owner review. Separately, the exact local incident pair `website cmrhv25e / video 89c3f4a1` was explicitly remediated through `AdminWebsitesService.assignSingleVideo`; it now has an ACTIVE same-site assignment and a transactionally written audit event. No Production data has been accessed or changed.

## Audit summary

| Check                                                             | Local result |
| ----------------------------------------------------------------- | -----------: |
| Share links inspected                                             |            3 |
| Share-link video rows inspected                                   |            3 |
| Rows without a same-website assignment                            |            2 |
| Rows with a same-website assignment that is not ACTIVE            |            0 |
| Rows assigned only to another website                             |            0 |
| Active links without any READY, playable, ACTIVE-assigned video   |            2 |
| Active links with both valid and invalid videos                   |            0 |
| Rows affected by disabled/expired website, domain or link context |            1 |
| Rows whose video is not playable under the current source policy  |            0 |

The two affected legacy link contexts use an ACTIVE website with one ACTIVE domain. Both legacy links are ACTIVE and unexpired, and both referenced videos are READY, playable LOCAL_FILE records. Their demonstrated policy failure is the absence of a `WebsiteVideo` row for the link's website. The third inspected link is the revoked temporary smoke link for the remediated incident pair.

## Owner decision worksheet

| Case                                            | Website    | Share-link status                                  | Video status                | Same-site assignment | Other-site assignment | Current impact                                                                     | Recommended owner decision                 | Confidence |
| ----------------------------------------------- | ---------- | -------------------------------------------------- | --------------------------- | -------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| link `cmrhv2bb` (`SHt***Ks`) / video `53e37062` | `cmrhv25e` | ACTIVE; unexpired; website ACTIVE; 1 ACTIVE domain | READY; LOCAL_FILE; playable | MISSING              | none                  | The hardened API excludes the only video, so the active link is currently invalid. | REVIEW — likely create/activate assignment | Medium     |
| link `cmrk4g77` (`KdC***24`) / video `439a9fe6` | `cmrhv25e` | ACTIVE; unexpired; website ACTIVE; 1 ACTIVE domain | READY; LOCAL_FILE; playable | MISSING              | none                  | The hardened API excludes the only video, so the active link is currently invalid. | REVIEW — likely create/activate assignment | Medium     |

## Incident remediation record

| Case           | Website    | Video      | Existing links | Evidence                                                                                     | Recommended action       | Owner decision                                  |
| -------------- | ---------- | ---------- | -------------- | -------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| Local incident | `cmrhv25e` | `89c3f4a1` | 0 before fix   | Website ACTIVE; one ACTIVE domain; video READY/playable LOCAL_FILE; no other-site assignment | CREATE_ACTIVE_ASSIGNMENT | Applied locally under this incident instruction |
| Legacy case 1  | `cmrhv25e` | `53e37062` | 1 ACTIVE       | READY/playable; same-site assignment MISSING; no other-site assignment                       | INSUFFICIENT_EVIDENCE    | Pending owner review                            |
| Legacy case 2  | `cmrhv25e` | `439a9fe6` | 1 ACTIVE       | READY/playable; same-site assignment MISSING; no other-site assignment                       | INSUFFICIENT_EVIDENCE    | Pending owner review                            |

The local incident smoke created one temporary share link, verified public watch before/after assignment removal and restoration, then revoked that temporary link. Its raw credential was never printed.

The recommendation is not an authorization to mutate data. The database alone cannot prove whether the missing assignment is accidental, a legacy fixture or an intentional separation. If the website must not own a video, the owner should review revoking the corresponding link instead.

## Potential remediation commands — DO NOT EXECUTE

Use owner-approved application/service operations rather than ad-hoc SQL wherever possible. Replace placeholders only in a controlled maintenance session; do not place raw share tokens or token hashes in commands or logs.

### Option A — create or activate the intended assignment

1. Take a database backup and record the restore point.
2. Confirm with the owner that `<MASKED_WEBSITE_ID>` is intended to publish `<MASKED_VIDEO_ID>`.
3. In one transaction, create the missing unique `(websiteId, videoId)` `WebsiteVideo` row as ACTIVE, or change the existing same-site row to ACTIVE.
4. Write an allowlisted admin audit event containing safe admin/website/video identifiers and the approval reference.
5. Re-run the counts-only audit and verify public watch using the intended host.
6. Compensation: disable or remove only the newly approved assignment if the validation fails; do not reset the database.

### Option B — revoke an obsolete link

1. Take a backup and obtain owner approval for the masked link case.
2. Call the authenticated revoke endpoint through the Admin API/service; do not use or log the raw share credential.
3. Verify the link is REVOKED, public watch is generically invalid and unrelated links are unchanged.
4. Record the audit event and approval reference.
5. Compensation requires creating a new approved share link; a raw token cannot be recovered from the old row.

### Option C — remove a stale video from a multi-video link

The current API does not expose a general share-link video edit flow. Implement and review a bounded service operation before using this option. It must lock or transactionally validate the link, remove only the approved join row, preserve at least one playable assigned video when the link remains ACTIVE, write an audit event and provide a compensating re-attach operation.

## Safe audit commands

Local counts only:

```bash
APP_ENV=local DOTENV_CONFIG_PATH=.env.local yarn audit:share-link-assignments --counts-only
```

Read-only exact-pair audit (identifiers are masked in output):

```bash
APP_ENV=local DOTENV_CONFIG_PATH=.env.local yarn audit:share-link-assignments --website-id=<WEBSITE_ID> --video-id=<VIDEO_ID>
```

Masked local worksheet output:

```bash
APP_ENV=local DOTENV_CONFIG_PATH=.env.local yarn audit:share-link-assignments
```

The command exits with code `2` when affected active links are found, `0` when none are found and `1` for configuration/query failure. It performs only Prisma read operations and never selects token hashes. Do not run it against Production until the Production operator has explicitly selected the correct read-only connection context.
