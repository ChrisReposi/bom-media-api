# Features

Status: CURRENT
Last verified: 2026-08-21

Two kinds of document live here:

1. **Deep dives** on implemented behaviour that is too detailed for
   `ARCHITECTURE.md` but too important to leave to code reading.
2. **Feature specs** for work not yet built, written from
   [FEATURE_TEMPLATE.md](./FEATURE_TEMPLATE.md).

Every document states its status in the header. Never describe a `PLANNED`
feature in the present tense.

## Index

| Document | Status | Subject |
|---|---|---|
| [video-pipeline.md](./video-pipeline.md) | CURRENT | Every implemented source type and provider, upload paths, Range streaming |
| [share-links.md](./share-links.md) | CURRENT | Share links end to end, from creation to playback |
| [admin-accounts.md](./admin-accounts.md) | CURRENT | OWNER-only account management and temporary passwords |
| [bunny-stream.md](./bunny-stream.md) | **PLANNED** | Bunny Stream provider — planning only, **not implemented** |

## Writing a feature spec

Copy `FEATURE_TEMPLATE.md`, name the file after the feature in kebab-case, and
fill in every section. Sections that do not apply get "None" — not deletion, so
a reviewer can see the question was asked.

A spec is not approval to build. It is the artefact a reviewer reads *before*
implementation starts.
