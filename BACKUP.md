# Backup & Restore

Blossom's SQLite DB lives on the Northflank volume `blossom-data` (project
`asdsa`, mounted at `/app/data`, `DB_PATH=/app/data/blossom.db`). It holds
every account, session, bookmark, and history entry.

## Current protections

- The volume persists across deploys and restarts.
- Northflank can snapshot attached volumes from the project Volumes page.

## Manual backup

From the Northflank UI: project `asdsa` → Volumes → `blossom-data` → snapshot.

Or via the API/CLI after `northflank login`:

```bash
northflank get volume --projectId asdsa --volumeId blossom-data
```

## Restore

Restore from a volume snapshot in the Northflank UI (Volumes → snapshot →
restore), or attach a restored volume to the `blossom` service at `/app/data`.

## Checklist for a restore drill

1. Verify `/health` comes back up on the public Northflank URL.
2. Log in as the dev account (`DEV_EMAIL`) — confirms the users table restored.
3. Confirm a known bookmark still exists via `/api/bookmarks`.
