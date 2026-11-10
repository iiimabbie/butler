# Repository Instructions

Before implementing, investigating or reviewing code here, read and follow `/home/iiimabbie/workspace/butler/workspace/guides/coding-standards.md` in full. This file only adds what is specific to Butler.

## Project Hygiene

- The project tree holds only source, `.data/` runtime state, `workspace/`, and `backups/`. One-off scripts, scratch output, exports and smoke-check files go to `/tmp` and are deleted when the task ends.
- Every backup goes under `backups/<source>/` (for example `backups/hindsight/`, `backups/memory-curation/`).
- Anything that writes files automatically must bound them (retention count or age) in the same change that introduces it.
- Check with `node scripts/tidy-check.mjs` after work that generates files; procedures are in `docs/project-tidy.md`.

## Commands

- `npm run typecheck` for TypeScript changes; `npm run build` before deployment; `node --check ui/app.js` when it changes.
- Deployment uses `npm run deploy`, then `node scripts/deploy-check.mjs` (service state, deploy result, errors since start, running subagents).
- Run `npm run discord:register` only when slash command definitions change; it replaces every registered command.
