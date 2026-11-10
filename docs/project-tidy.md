# Project tidy guide

How the Butler tree is laid out, where generated files and backups go, and how to check and clean it. The rules themselves are in `AGENTS.md` (Project Hygiene); this file is the procedure.

## Layout

| Path | Holds | Notes |
|---|---|---|
| `src/`, `scripts/`, `services/`, `ui/`, `docs/` | tracked source and docs | `docs/` tracks only whitelisted files; local plans live there only while a task runs, then are deleted |
| `.data/` | runtime state | `config.yaml`, `config/`, `butler.sqlite`, `attachments/`, `hledger/` (ledger), `google/`, `private/`, `alloy/`, `steam-freebies/`, `subagent/`, `service/butler.log`, `deploy/deploy.log`, `channel-names.json` |
| `workspace/` | Renee's workspace, its own git repo (`butler-workspace`) | one-off files are not kept here |
| `backups/` | every backup, one subdirectory per source | see below |
| `node_modules/`, `dist/`, `.codegraph/` | rebuildable output | |

`backups/` subdirectories and who writes them:

| Directory | Written by | Retention |
|---|---|---|
| `hindsight/` | manual bank config changes, `scripts/clear-hindsight-memory.mjs` | manual |
| `memory-and-chats/` | `scripts/clear-memory-and-chats.mjs` | manual |
| `skills-trash/` | `skills_manage` update/remove (`src/tools/skills.ts`) | 30 days, pruned on each move |
| `memory-curation/` | hindsight-curation `bin/apply.py` snapshots, tags exports | 30 days, pruned by `apply.py` |
| `daily-journal/` | daily-journal skill when it replaces a journal | manual |
| `hledger/` | old per-write ledger copies (the mechanism was removed) | static archive |
| `shortcuts/` | final signed iOS shortcuts | manual |
| `renee-reference-assets/` | superseded Renee reference photo sets (`old-v1`–`old-v3`) | manual |

Other bounded outputs: `workspace/memory-curation/work/` files are deleted by `fetch.py` after 45 days (`*.recalled.json` are state: `recalled.py` reads the 30 days before the day being curated); `model_requests` keeps 500 rows / 24 hours; `tool_calls` keeps full rows 30 days, after which recall/reflect rows are compacted to memory IDs (read by hindsight-curation's monthly check) and kept to 100 days; `.data/attachments/` files older than 90 days are deleted (the message keeps channel and msg IDs, and `discord_read` `message` re-downloads the original) — both run in `src/retention.ts` at startup and daily; `butler.log` and `deploy.log` rotate daily for 30 days via `/etc/logrotate.d/butler` (source `scripts/butler.logrotate`); the deploy script deletes `.data/deploy/previous-dist` after a successful start.

## Routine check

```sh
node scripts/tidy-check.mjs          # report only
node scripts/tidy-check.mjs --apply  # also delete __pycache__ / *.pyc
```

It prints sizes and one line per finding, or `clean`. What to do per section:

- `untracked` / `ignored-leftover`: a one-off file in the project. Delete it unless the owner wants it; a finished plan in `docs/` is deleted.
- `workspace-untracked`: a file Renee left. Generated scratch → delete; real content → leave for the workspace backup commit.
- `data`: an unexpected `.data/` entry. Find what writes it (`rg` the name in `src/` and `scripts/`) before deleting. A leftover `.data/deploy/build` or `previous-dist` means a deploy was interrupted.
- `backup-outside`: move it under `backups/<source>/` and change whatever writes it to write there (the code, script or skill — not just the file).
- `retention`: an automatic prune is not running; fix the prune, then delete the old entries.
- `log`: reinstall with `sudo install -m 644 scripts/butler.logrotate /etc/logrotate.d/butler`, then `sudo logrotate -d /etc/logrotate.d/butler` to dry-run.
- `database`: run the VACUUM below.

## Reclaim database space

```sh
node scripts/db-vacuum.mjs
```

It refuses while a subagent is running, stops Butler, checkpoints the WAL, VACUUMs, and starts Butler again. It deletes no rows; `model_requests` is debug data and stays.

## Changes that need more than a script

- Moving where something writes: change the writer, move the existing files with `mv`, update `README.md` / `docs/yuu_operations.md` / skill docs that name the old path, then `rg` the old path across `src scripts services workspace README.md docs` to confirm nothing still points at it.
- Renaming a `.data/` directory used by a container (as `finance` → `hledger`): change `src/paths.ts`, the container path mapping in the tool, `compose.yaml` volume, Dockerfile `WORKDIR`; stop Butler, `docker compose down`, `mv`, `docker compose up -d --build`, check with the tool's own command, then deploy.
- Skills from `iiimabbie/renee-skills` (hindsight-curation, daily-journal): edit the installed copy, verify, then push the same files to that repo (confirm upstream equals the pre-change copy first), and run `skills_manage update` with `force: true` for each skill so `.lock.json` records the new revision and the skill is no longer reported as locally modified.
- Deleting something that is not in git (and not a cache): confirm with the owner first; it cannot be recovered.
