# Butler

Butler is a single-operator personal agent. It contains a runnable CLI vertical slice plus a Discord text entry using discord.js, with persistent sessions and CPA model overrides. All 17 Discord tools and six slash commands, including `/botreply`, are implemented. All 16 Google tools and browser manual-paste OAuth are implemented for CLI and Discord owner use, and the Google code is deployed. The private client is configured, the user has completed OAuth, and live Google status is `connected`; real Google tool behavior remains pending user acceptance. Host management and Docker operations remain outside the current implementation.

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
- `BUTLER_UI_PORT` (optional; enables Session/RQ viewing and Google OAuth UI on `127.0.0.1:<port>`, for example `3211`)
- `BUTLER_UI_PUBLIC_ORIGIN` (explicit accepted OAuth POST origin; defaults to `https://workspace.example.com`, no proxy path or trailing slash; never inferred from Host)
- `BUTLER_UI_COOKIE_PATH` (defaults to `/proxy/<port>/`; use `/` only for an explicitly configured direct loopback UI)

Run `npm run discord:register` explicitly to register `/status`, `/model`, `/mode`, `/restart`, `/new`, and `/botreply` in the specified guild. Registration reads existing guild commands, preserves unrelated commands, and updates managed command definitions by their existing IDs. `/model` offers cached, filtered candidates from the configured CPA `/models` endpoint while still accepting manually entered IDs. Run `npm run discord` for a plain bot process, or `npm run discord:managed` when `/restart` should be available. The managed launcher restarts only when the process exits with code 75, waits up to `BUTLER_READY_TIMEOUT_SECONDS` (default 60) for Discord readiness on each launch, and does not restart ordinary failures. It forwards SIGINT/SIGTERM and does not treat them as restart requests. `BUTLER_NODE` may select the Node executable. This does not log in during build or tests. The bot needs Guilds, GuildMessages, and Message Content intents enabled. Owner messages work in allowlisted root channels and verified direct child threads. A persistent, instance-wide bot-reply flag defaults to false; only the owner can set it with `/botreply enabled:true|false` in an allowed channel, and `/status` reports its current value. `/model id`, `/mode value`, and `/botreply enabled` require their options and only set values; omitted options do not query or mutate settings. When enabled, other bots that explicitly mention Butler in an allowed root channel or direct child thread can use the approved Discord read/write tools, including deletion; they cannot toggle the flag or use history, attachments, buttons, or toggle controls. Each bot has an independent session per channel, isolated from the owner's history and other bots. Replies are plain text, chunked to 2,000 characters, with automatic mentions disabled; `/status` uses a Chinese embed card. Session, model, and queue/steer mode persist per owner channel; `/status` shows the mode as `queue` or `steer` while other status labels remain Chinese. Queue mode serializes messages; steer mode silently merges new text into an active ask at the safe boundary between model requests, while queued commands such as `/new` and `/model` remain ordering barriers. Direct Discord replies include one referenced message’s ID, author, original text (or an unavailable status), and attachment-presence-only notice as clearly marked untrusted user content; Butler fetches the referenced message only after the incoming message passes owner/channel/bot/webhook checks. Attachments remain unread. Queue messages reserve their channel position before reference resolution; steer reserves an ordered pending slot immediately and the model waits for it at the safe consumption point. Slow or out-of-order reference fetches therefore cannot reorder messages across `/new`, `/model`, or `/mode` barriers. Steer messages retain the same reply context and are persisted once when consumed. If a turn fails after consuming a steer message, Butler reports that the supplement was preserved in the same session. Queues and active work are not resumed after process crash.
The 17 Discord tools include the original eight message tools, six thread/forum tools, `discord_bot_mention_toggle`, `discord_attach_to_reply`, and persistent `discord_send_buttons`. Thread operations verify the Discord-returned channel type and parent against the configured root allowlist; a thread delete never targets its parent. Attachments accept a local `file` and optional `filename`, restricted to paths under `BUTLER_ATTACHMENT_DIR`, and are included in the final reply. The original tool result remains intact; a separate delivery status records `delivered`, `failed_or_unknown`, or `not_sent`. Buttons persist their target message, owner, expiry, action arguments, and per-button claim in SQLite; clicking acknowledges promptly, validates binding and expiry, and claims the action once before dispatch. Pending clicks are not replayed after restart, and uncertain external outcomes are never automatically retried. New tables are created by Store with `CREATE TABLE IF NOT EXISTS`; after backing up the database, startup does not require manual SQL migration.

`/restart` works only under `discord:managed`, and only when there is no active or queued work in any channel. Butler posts a non-ephemeral “重啟中” message, persists its channel and message IDs, then closes Discord and SQLite cleanly and exits 75. After `clientReady`, the new process edits that same message to “重啟完成”; it clears the stored notice only after a successful edit. A failed edit remains recorded and is reported in safe logs. The launcher and bot use the configured environment and do not hardcode credentials or channel IDs. New Store tables are created with `CREATE TABLE IF NOT EXISTS`; back up the database before starting the updated application, with no manual SQL migration required.

## Shared workspace Markdown

Butler reads `workspace/SOUL.md`, `AGENT.md`, `OWNER.md`, and `MEMORY.md` for each new `ask`. The files are shared by CLI, owner, and bot sessions; they are loaded from the project location resolved from the module URL, not the process working directory. Changes apply on the next ask without a restart. Missing or blank files are skipped; other read errors stop the ask. `SOUL.md` and `AGENT.md` are supplemental developer instructions; `OWNER.md` and `MEMORY.md` are explicitly labeled user-role background, not instructions or authorization. Only `AGENT.md` has usable rules; the other three are initial placeholders for formal launch configuration. Edit these files directly; there is no setup command, templates directory, or automatic memory writing. The workspace is ignored by Git because these files may contain private content.

## Session / request / Google UI

Set `BUTLER_UI_PORT=3211` to enable the HTTP interface bound only to `127.0.0.1:3211` in the Discord process. Session/RQ APIs remain read-only; the Google OAuth POST routes save private credentials, so the server as a whole is not read-only. The page has Session and Latest Request tabs, manually refreshed and paginated; messages and tool results are read in full, while session-list text is a preview. The latest-request view shows the exact serialized CPA `/responses` body from the most recent send attempt, persisted across restarts, with copy/download of the original string. Requests that fail after the attempt remain visible; a snapshot does not imply CPA received it. All UI/API responses are `no-store`, and UI access is not a separate login layer. Use only behind the existing Cloudflare Access-protected code-server proxy, for example `https://workspace.example.com/proxy/3211/`; the listener itself is loopback-only. Startup fails if an explicitly enabled UI cannot bind. The deployed UI has been verified at `127.0.0.1:3211` and through the local code-server proxy; anonymous requests to the public homepage and `/api/sessions` redirect to `example.cloudflareaccess.com`. No additional UI token is configured.

## Google integration (deployed, OAuth connected)

Provide an authorized **Desktop OAuth client** in `~/.config/butler/google-client.json` with only `client_id` and `client_secret` string fields. Keep its directory mode 700 and file mode 600. Credentials are not repo/workspace configuration. The main agent configured the specified private client with the user's explicit authorization, using directory mode 700 and file mode 600. No Umiro token was copied; the user completed Butler's own OAuth flow. Missing configuration is normal and does not stop Discord or UI startup. Butler saves its own `~/.local/share/butler/google-token.json` atomically with file mode 600 and parent mode 700. Do not paste credentials or OAuth URLs into CLI/Discord conversations.

The client is configured and the user has completed manual authorization. The main agent confirmed live `/api/google/status` returns `connected` (已連線). Real Google tool behavior has not yet been accepted; a connected status does not verify all 16 tools. The following workflow also applies when reauthorization is needed.

1. Open the existing Access-protected UI at `https://workspace.example.com/proxy/3211/` and start Google authorization.
2. Open the consent link. After Google redirects to `http://127.0.0.1`, the browser may show a connection error; copy that complete URL and paste it into the original Google section within five minutes.
3. Complete authorization. This validates state, PKCE S256, browser cookie and CSRF before exchanging the code; the transaction is consumed before exchange and cannot be replayed. Restart, expiry or unknown exchange outcome requires a new start. No loopback URL is fetched and no callback listener/OOB flow is added. Manual pasting is a project workflow, not claimed to be Google-endorsed.
4. The next CLI `ask` or Discord owner message discovers the 16 tools dynamically. Bots never receive Google tools and execution rejects them even if requested. Refresh tokens are re-read from disk and renewed single-flight within each process. A new authorization-code login must supply its own non-empty refresh token; otherwise no new credentials are saved. Only renewal of an existing token preserves its original refresh token when the refresh response omits a replacement. `invalid_grant` or API 401 requires reauthorization; write operations are never automatically resent.

Requested scopes: `gmail.readonly`, `gmail.compose`, `calendar.events`, `tasks`, `drive.readonly`, and `drive.file`. Gmail supports search/read/send/create-draft, Calendar list/create/update/delete, Tasks list/create/update/complete/delete, and Drive search/read/upload. Tool inputs are described in [Google integration](docs/google-integration.md). Writes require the current owner/CLI request; fetched emails/documents are untrusted data, not permission.

Limits: Gmail is one-recipient plain text without attachments; only attachment metadata is read. Reading decodes each selected MIME part using its Content-Type charset (MIME default US-ASCII if absent); unsupported charsets or invalid bytes fail explicitly rather than silently corrupting text. Calendar timed values require RFC3339 timezone offsets; all-day end dates are exclusive. Switching all-day/timed mode requires both start/end and explicitly clears the opposite dateTime/date field in the PATCH. Tasks due is a date, not a reminder. Drive is filename search plus text files and Docs/Slides plain-text exports; Sheets CSV contains **only the first sheet**. Folders, shortcuts and other binary formats are unsupported. Reads and uploads have a **10 MiB** limit (10 × 1024 × 1024 bytes); exceeding it errors, never silently truncates. Uploads only create new files, using inline text or a regular local file under `BUTLER_ATTACHMENT_DIR` with realpath/symlink-escape checks.

OAuth POSTs accept JSON only and require the configured public Origin, not arbitrary Host. The cookie is short-lived, HttpOnly, SameSite=Lax and Secure for HTTPS with the proxy Path above; CSRF/consent/callback data remain transient, never browser storage or CPA/history/log output. Session/RQ data remain private under the existing Access protection; no separate login, CORS or Access bypass is added. Reusing the same Google client/account does not imply Google-side grant isolation. Basic checks passed with Node 24.21.0: build, frontend JS syntax and diff formatting. One isolated temporary-workspace/token/SQLite fake OAuth→Gmail-draft smoke confirmed PKCE, dynamic availability, pending-first/result persistence, token600/parent700 and no OAuth secrets in messages/history/RQ. No test files/dependencies or full test suite were added/run. Main-agent review and deployment are complete: Discord ready was confirmed for bot `1493781458702303293`, with UI listening on `127.0.0.1:3211`. Loopback and code-server proxy homepage/Google status return HTTP 200 with `no-store`; live Google status is `connected` after the user completed OAuth with the configured client. The anonymous public Google status endpoint returns HTTP 302 to `example.cloudflareaccess.com`. Real Google tool behavior remains pending user acceptance; OAuth completion does not verify all 16 tools.

## Scope status

The 17-tool Discord build, Google code and Session/RQ/OAuth UI are deployed to the isolated test bot. The private client is configured and the user has completed OAuth; live Google status is `connected`, with real Google tool behavior still pending user acceptance. Discord readiness is confirmed for bot `1493781458702303293`. Existing session, message, and tool-call contents remain intact; bot replies remain disabled by default. New tool side effects have not all been exercised live, and user visual/functional acceptance of the UI is still pending.

Completed: CPA `/models` listing and `/responses` loop, time and history tools, SQLite persistence and history queries, plus the isolated Discord text entry, all 17 Discord tools, and all six slash command handlers (`/status`, `/model id`, `/mode value`, `/restart`, `/new`, `/botreply enabled`), including the managed restart launcher. Other-bot replies are disabled by default and require the owner to enable them; when enabled, explicitly mentioning bots can use the approved Discord tools within allowed channels and verified direct child threads. Google 16 tools and manual-paste UI OAuth have passed main-agent review and are deployed; the private client is configured, the user has completed OAuth, and live status is `connected`. Real Google tool behavior remains pending user acceptance. Not implemented: host-management tools, interactive CLI loop, memory, retention, or automatic recovery. The read-only Session/Latest Request UI is deployed and its loopback, code-server proxy, and anonymous Access redirects have been verified; user visual/functional acceptance remains pending. Builds do not log in or register slash commands; those are explicit deployment steps. Live tool behavior depends on the configured allowlist and Discord permissions. CPA text and forced function-call round trip were manually probed against the local endpoint previously.

## Project documents

- [Requirements and acceptance](docs/requirements.md)
- [Architecture direction](docs/architecture.md)
- [Phased plan](docs/plan.md)
