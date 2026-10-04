# Butler

Butler is a single-operator personal agent. It contains a runnable CLI vertical slice plus a Discord text entry using discord.js, with persistent sessions and CPA model overrides. All 17 Discord tools and six slash commands, including `/botreply`, are implemented. Google, host management, and Docker operations are outside the current implementation.

## Requirements and setup

- Node.js 24.21.0 (built-in `node:sqlite` and discord.js 14.27.0).
- `npm install` then `npm run build`.
- discord.js v14.27.0 is installed locally in this project; this is a native Node application, not a Docker workload.
- Set `CPA_MODEL` to a model ID accepted by your local CPA. `npm run start -- models` lists IDs exposed at the configured CPA endpoint.

Environment:

- `CPA_BASE_URL` (default `http://127.0.0.1:8317/v1`)
- `CPA_API_KEY` (optional; sent as a bearer token when provided)
- `CPA_MODEL` (required for `ask`)
- `BUTLER_DB` (optional database path; default `~/.local/share/butler/butler.sqlite`)

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
- `BUTLER_ATTACHMENT_DIR` (optional local Discord attachment root; defaults to `.data/attachments`)
- `BUTLER_UI_PORT` (optional; enables the read-only UI on `127.0.0.1:<port>`, for example `3211`)

Run `npm run discord:register` explicitly to register `/status`, `/model`, `/mode`, `/restart`, `/new`, and `/botreply` in the specified guild. Registration reads existing guild commands, preserves unrelated commands, and updates managed command definitions by their existing IDs. `/model` offers cached, filtered candidates from the configured CPA `/models` endpoint while still accepting manually entered IDs. Run `npm run discord` for a plain bot process, or `npm run discord:managed` when `/restart` should be available. The managed launcher restarts only when the process exits with code 75, waits up to `BUTLER_READY_TIMEOUT_SECONDS` (default 60) for Discord readiness on each launch, and does not restart ordinary failures. It forwards SIGINT/SIGTERM and does not treat them as restart requests. `BUTLER_NODE` may select the Node executable. This does not log in during build or tests. The bot needs Guilds, GuildMessages, and Message Content intents enabled. Owner messages work in allowlisted root channels and verified direct child threads. A persistent, instance-wide bot-reply flag defaults to false; only the owner can set it with `/botreply enabled:true|false` in an allowed channel, and `/status` reports its current value. `/model id`, `/mode value`, and `/botreply enabled` require their options and only set values; omitted options do not query or mutate settings. When enabled, other bots that explicitly mention Butler in an allowed root channel or direct child thread can use the approved Discord read/write tools, including deletion; they cannot toggle the flag or use history, attachments, buttons, or toggle controls. Each bot has an independent session per channel, isolated from the owner's history and other bots. Replies are plain text, chunked to 2,000 characters, with automatic mentions disabled; `/status` uses a Chinese embed card. Session, model, and queue/steer mode persist per owner channel; `/status` shows the mode as `queue` or `steer` while other status labels remain Chinese. Queue mode serializes messages; steer mode silently merges new text into an active ask at the safe boundary between model requests, while queued commands such as `/new` and `/model` remain ordering barriers. Direct Discord replies include one referenced message’s ID, author, original text (or an unavailable status), and attachment-presence-only notice as clearly marked untrusted user content; Butler fetches the referenced message only after the incoming message passes owner/channel/bot/webhook checks. Attachments remain unread. Queue messages reserve their channel position before reference resolution; steer reserves an ordered pending slot immediately and the model waits for it at the safe consumption point. Slow or out-of-order reference fetches therefore cannot reorder messages across `/new`, `/model`, or `/mode` barriers. Steer messages retain the same reply context and are persisted once when consumed. If a turn fails after consuming a steer message, Butler reports that the supplement was preserved in the same session. Queues and active work are not resumed after process crash.
The 17 Discord tools include the original eight message tools, six thread/forum tools, `discord_bot_mention_toggle`, `discord_attach_to_reply`, and persistent `discord_send_buttons`. Thread operations verify the Discord-returned channel type and parent against the configured root allowlist; a thread delete never targets its parent. Attachments accept a local `file` and optional `filename`, restricted to paths under `BUTLER_ATTACHMENT_DIR`, and are included in the final reply. The original tool result remains intact; a separate delivery status records `delivered`, `failed_or_unknown`, or `not_sent`. Buttons persist their target message, owner, expiry, action arguments, and per-button claim in SQLite; clicking acknowledges promptly, validates binding and expiry, and claims the action once before dispatch. Pending clicks are not replayed after restart, and uncertain external outcomes are never automatically retried. New tables are created by Store with `CREATE TABLE IF NOT EXISTS`; after backing up the database, startup does not require manual SQL migration.

`/restart` works only under `discord:managed`, and only when there is no active or queued work in any channel. Butler posts a non-ephemeral “重啟中” message, persists its channel and message IDs, then closes Discord and SQLite cleanly and exits 75. After `clientReady`, the new process edits that same message to “重啟完成”; it clears the stored notice only after a successful edit. A failed edit remains recorded and is reported in safe logs. The launcher and bot use the configured environment and do not hardcode credentials or channel IDs. New Store tables are created with `CREATE TABLE IF NOT EXISTS`; back up the database before starting the updated application, with no manual SQL migration required.

## Read-only session UI

Set `BUTLER_UI_PORT=3211` to enable a read-only HTTP interface bound only to `127.0.0.1:3211` in the Discord process. The page has Session and Latest Request tabs, manually refreshed and paginated; messages and tool results are read in full, while session-list text is a preview. The latest-request view shows the exact serialized CPA `/responses` body from the most recent send attempt, persisted across restarts, with copy/download of the original string. Requests that fail after the attempt remain visible; a snapshot does not imply CPA received it. All UI/API responses are `no-store`, and UI access is not a separate login layer. Use only behind the existing Cloudflare Access-protected code-server proxy, for example `https://workspace.example.com/proxy/3211/`; the listener itself is loopback-only. Startup fails if an explicitly enabled UI cannot bind. The deployed UI has been verified at `127.0.0.1:3211` and through the local code-server proxy; anonymous requests to the public homepage and `/api/sessions` redirect to `example.cloudflareaccess.com`. No additional UI token is configured.

## Scope status

The 17-tool Discord build and read-only UI are deployed to the isolated test bot. Discord readiness is confirmed for bot `1493781458702303293`. Existing session, message, and tool-call contents remain intact; bot replies remain disabled by default. New tool side effects have not all been exercised live, and user visual/functional acceptance of the UI is still pending.

Completed: CPA `/models` listing and `/responses` loop, time and history tools, SQLite persistence and history queries, plus the isolated Discord text entry, all 17 Discord tools, and all six slash command handlers (`/status`, `/model id`, `/mode value`, `/restart`, `/new`, `/botreply enabled`), including the managed restart launcher. Other-bot replies are disabled by default and require the owner to enable them; when enabled, explicitly mentioning bots can use the approved Discord tools within allowed channels and verified direct child threads. Not implemented: Google integration, host-management tools, interactive CLI loop, memory, retention, or automatic recovery. The read-only Session/Latest Request UI is deployed and its loopback, code-server proxy, and anonymous Access redirects have been verified; user visual/functional acceptance remains pending. Builds do not log in or register slash commands; those are explicit deployment steps. Live tool behavior depends on the configured allowlist and Discord permissions. CPA text and forced function-call round trip were manually probed against the local endpoint previously.

## Project documents

- [Requirements and acceptance](docs/requirements.md)
- [Architecture direction](docs/architecture.md)
- [Phased plan](docs/plan.md)
