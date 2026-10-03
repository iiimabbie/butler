# Butler

Butler is a single-operator personal agent. It contains a runnable CLI vertical slice plus an isolated Discord text entry using discord.js, with persistent per-channel sessions and CPA model overrides. Discord tools, Google, host management, and Docker operations are not implemented.

## Requirements and setup

- Node.js 24.21.0 (built-in `node:sqlite` and discord.js 14.27.0).
- `npm install` then `npm run build`.
- discord.js v14.27.0 is installed locally in this project; this is a native Node application, not a Docker workload.
- Set `CPA_MODEL` to a model ID accepted by your local CPA. `npm run start -- models` lists IDs exposed at the configured CPA endpoint.

Environment:

- `CPA_BASE_URL` (default `http://127.0.0.1:8317/v1`)
- `CPA_API_KEY` (optional; sent as a bearer token when provided)
- `CPA_MODEL` (required for `ask`)
- `BUTLER_DB` (optional database path; default repository `.data/butler.sqlite`)

## Commands

```sh
npm run start -- models
npm run start -- ask "What time is it?"
npm run start -- ask "Continue this conversation" --session SESSION_ID
npm run start -- new
npm run start -- sessions
npm run start -- history SESSION_ID [offset] [limit]
npm run start -- search QUERY [offset] [limit]
npm run start -- get TOOL_HISTORY_ID [result-offset] [character-limit]
npm run discord:register
npm run discord
npm run discord:managed
```

A new session is created for `ask` unless `--session` names an existing one. Tool calls are recorded as pending before execution, then their raw arguments and result/error are persisted under a stable ID. A process interruption can leave pending evidence; Butler does not resume or replay it. History and search list newest records first, at most 100 per page, with bounded result previews and a next offset. `get` returns a raw result segment (default 4,000 characters) and reports total length and the next offset when more remains. The `.data` parent directory is created automatically when the database is opened; `models` does not open a database.

## Discord entry

Configure these variables before using the Discord entry. Token, owner, allowlisted channel IDs, and CPA model are required; guild registration additionally requires the application and guild IDs. Channel IDs are comma-separated. Do not reuse Umiro credentials.

- `BUTLER_DISCORD_TOKEN`
- `BUTLER_DISCORD_OWNER_ID`
- `BUTLER_DISCORD_CHANNEL_IDS`
- `BUTLER_DISCORD_APPLICATION_ID` (registration only)
- `BUTLER_DISCORD_GUILD_ID` (registration only)
- `CPA_MODEL` (required)
- `CPA_BASE_URL`, `CPA_API_KEY`, and `BUTLER_DB` (optional; see above)

Run `npm run discord:register` explicitly to register `/status`, `/model`, `/mode`, `/restart`, and `/new` in the specified guild. Registration reads existing guild commands, preserves unrelated commands, and updates managed command definitions by their existing IDs. `/model` offers cached, filtered candidates from the configured CPA `/models` endpoint while still accepting manually entered IDs. Run `npm run discord` for a plain bot process, or `npm run discord:managed` when `/restart` should be available. The managed launcher restarts only when the process exits with code 75, waits up to `BUTLER_READY_TIMEOUT_SECONDS` (default 60) for Discord readiness on each launch, and does not restart ordinary failures. It forwards SIGINT/SIGTERM and does not treat them as restart requests. `BUTLER_NODE` may select the Node executable. This does not log in during build or tests. The bot needs Guilds, GuildMessages, and Message Content intents enabled. Only ordinary messages by the configured owner in allowlisted channels are handled. Replies are plain text, chunked to 2,000 characters, with automatic mentions disabled; `/status` uses a Chinese embed card. Attachments are not read; an explicit notice is sent. Session, model, and queue/steer mode persist per channel; `/status` shows the mode as `queue` or `steer` while other status labels remain Chinese. Queue mode serializes messages; steer mode silently merges new text into an active ask at the safe boundary between model requests, while queued commands such as `/new` and `/model` remain ordering barriers. Steer messages are persisted once when consumed. If a turn fails after consuming a steer message, Butler reports that the supplement was preserved in the same session. Queues and active work are not resumed after process crash.

`/restart` works only under `discord:managed`, and only when there is no active or queued work in any channel. Butler posts a non-ephemeral “重啟中” message, persists its channel and message IDs, then closes Discord and SQLite cleanly and exits 75. After `clientReady`, the new process edits that same message to “重啟完成”; it clears the stored notice only after a successful edit. A failed edit remains recorded and is reported in safe logs. The launcher and bot use the configured environment and do not hardcode credentials or channel IDs. New `channel_modes` and `restart_notice` tables are part of the current Store schema; an existing deployment database needs a manual backup and migration before use.

## Scope status

Completed: CPA `/models` listing and `/responses` loop, time and history tools, SQLite persistence and history queries, plus the isolated Discord text entry, eight Discord message tools (`discord_send_message`, `discord_fetch_message`, `discord_fetch_channel_messages`, `discord_edit_message`, `discord_delete_message`, `discord_react`, `discord_pin`, `discord_unpin`), and all five slash command handlers (`/status`, `/model`, `/mode`, `/restart`, `/new`), including the managed restart launcher. Focused offline tests cover core, Discord tools, and launcher lifecycle behavior. Not implemented: the other nine Discord tools, Google integration, host-management tools, interactive CLI loop, management UI, memory, retention, or automatic recovery. This code change does not perform Discord login, slash registration, or live exchange; those require separate explicit validation. CPA text and forced function-call round trip were manually probed against the local endpoint previously.

## Project documents

- [Requirements and acceptance](docs/requirements.md)
- [Architecture direction](docs/architecture.md)
- [Phased plan](docs/plan.md)
