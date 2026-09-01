# Backup & Restore

Blossom's SQLite DB (`data/blossom.db`) lives on the Fly volume `blossom_data`
(app `blossom-nowvdq`, region `ams`). It holds every account, session,
bookmark, and history entry. This doc covers protecting and restoring it.

## Current protections

- The volume has **scheduled snapshots enabled** (created at volume creation).
  Snapshots run automatically and are retained per Fly's retention policy
  (default 5, configurable).
- Every deploy/restart keeps the same volume, so normal releases never wipe data.

## Manual backup

To force a snapshot before a risky change or as an extra copy:

```bash
flyctl volumes snapshot create vol_vgn656g589e2djj4 -a blossom-nowvdq
```

Or take one on a schedule via `flyctl` / a cron job:

```bash
flyctl volumes snapshot list -a blossom-nowvdq
```

## Restore

To restore a volume from a snapshot (replaces the volume contents):

```bash
# 1. Stop the app's machine
flyctl machine stop d8d96440c477e8 -a blossom-nowvdq

# 2. Create a new volume from the snapshot
flyctl volumes restore <snapshot-id> -a blossom-nowvdq

# 3. Attach the restored volume to the machine (update fly.toml mount to the
#    new volume name if it changed), then start the machine
flyctl machine start d8d96440c477e8 -a blossom-nowvdq
```

## Checklist for a restore drill

1. Verify `/health` comes back up.
2. Log in as the dev account (`DEV_EMAIL`) — confirms the users table restored.
3. Confirm a known bookmark still exists via `/api/bookmarks`.
4. If anything looks stale, re-run `flyctl volumes snapshot list` to confirm
   which snapshot was used.

> Tip: test a restore at least once before you actually need it. The volume is
> 1GB; snapshots are cheap. A full restore should take under five minutes.