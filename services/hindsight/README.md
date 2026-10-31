# Hindsight Service

Local Hindsight service for Butler shared memory. Butler uses the configured formal bank `butler-discord`; the separate `butler-hindsight-synthetic-eval` bank is reserved for synthetic evaluation data. Butler remains a native Node service.

## Requirements

- Docker Engine with Compose
- A private `.env` populated from the specifically authorized local CPA and Umiro embedding settings

## Managed PostgreSQL

The Hindsight AP uses the dedicated `hindsight` database on the home-infra managed PostgreSQL endpoint supplied by the infrastructure owners. Ani and 烤雞堡 own PostgreSQL versions, extensions, access, backup/restore, capacity and monitoring. Renee owns the Hindsight application, connection configuration, schema compatibility and application-level verification; coordinate schema-changing upgrades with the DB owners.

`HINDSIGHT_API_DATABASE_URL` is held only in the ignored mode-0600 `.env`, with `sslmode=require`. The AP mounts no local database directory, runs no local PostgreSQL process and publishes no PostgreSQL port.

## Multilingual full-text search

`compose.yaml` sets `HINDSIGHT_API_TEXT_SEARCH_EXTENSION=pgroonga`. Both `memory_units` and `mental_models` use PGroonga expression indexes with `TokenBigram` and `NormalizerNFKC150`. `search_vector` is a dummy TEXT column; PGroonga searches the original text fields directly.

## Configure

Create `.env` from `.env.example`, then fill its credential and endpoint fields from approved local settings. Keep `.env` mode `0600`; the directory `.gitignore` excludes only that file. Do not paste credentials into this README or the example file.

Hindsight calls the CPA through `host.docker.internal` (mapped to the host gateway for Linux). The embedding adapter uses LiteLLM SDK's `voyage/voyage-4` model with 1024 output dimensions and passes Voyage's document/query input types through the SDK.

## Run

From this directory:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:18888/health/ready
```

To stop the service:

```sh
docker compose down
```

## Image

`compose.yaml` builds `butler-hindsight:1.0.0-central-defaults` from `Dockerfile.v1.0.0` on the pinned upstream `hindsight:1.0.0` image. The build adds ffmpeg and PyMuPDF and applies three repository-owned patches:

- `patch-butler-parser-v1.py` installs `butler-file-parser.py` as the file parser.
- `patch-request-defaults-v1.py` lowers the reranker question context limit to 20,000 tokens, clamps the resolved rerank candidate cap to 50 even if a per-level override is higher, and exposes the HTTP request default variables below.
- `patch-task-recovery-v1.py` installs `task-recovery.py`, the typed transient long-retry extension.

Each patch asserts exact upstream anchors and fails the build on version drift. Recheck them before upgrading the pinned image, and validate each patch in the image after build; a successful Docker build alone is not proof of behavioral compatibility.

## Server-owned retrieval defaults

Butler does not send `budget` or `max_tokens` on automatic recall, memory tools or people recall/reflect; transport timeout remains client-owned. The patched request models read these local extension variables from `compose.yaml`:

- `HINDSIGHT_API_REQUEST_RECALL_BUDGET=mid`
- `HINDSIGHT_API_REQUEST_RECALL_MAX_TOKENS=1200`
- `HINDSIGHT_API_REQUEST_REFLECT_BUDGET=mid`
- `HINDSIGHT_API_REQUEST_REFLECT_MAX_TOKENS=1600`

Change these in compose and recreate the service. These are default values; explicit HTTP API callers can override them. Butler never does.

Bank `butler-discord` uses fixed retrieval budgets low=30, mid=60, high=100, with `recall_max_tokens=1200` also aligned for non-HTTP/internal callers. These are search budgets, **not merged-candidate counts**. Reranking caps are low=30, mid=50, high=50. The 20,000-token context guard is still required because the count limit alone cannot prevent long-text overflow.

## Task recovery

After the native worker retry schedule is exhausted, only `batch_retain` and `refresh_mental_model` tasks with confirmed transient remote-provider errors are rescheduled as the same persistent operation: 300 seconds, then 900 seconds, then at least 1800 seconds for every later retry. The poller persists the pending status, retry count, and next retry time; it releases the worker slot and resumes the existing payload and operation after the delay. A blocked retain therefore continues to preserve same-document ordering; new chat remains collected by Butler and is not resent as an alternate recovery path.

Classification delegates to the image's existing typed `remote_retry` classifier and follows exception causes/unsuppressed contexts. Permanent HTTP 4xx and content-policy errors take precedence. Chunk extraction aggregates retain original exception objects so long cooldown recovery is allowed only when every failed chunk is confirmed transient; mixed, unknown, malformed-output, and other application errors retain the native finite retry behavior. Deterministic exclusions, quota deferral, file conversion, consolidation retries, automatic-refresh pause, checkpoints, and cancellation behavior remain native and unchanged. This does not recover every failed operation. Remove the patch if upstream gains equivalent behavior.

## Output language and missions

`compose.yaml` sets `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE=Traditional Chinese (Taiwan)` as the single output-language policy for retain, observations, reflect, and their generated summaries. Missions and Butler's person-summary prompt describe content and attribution, not output language. Changing this system-level environment setting requires recreating the Hindsight container; it does not rewrite existing memories. Butler does not supply missions or language overrides when creating banks.

The formal `butler-discord` bank stores `retain_mission`, `observations_mission`, and `reflect_mission` as bank configuration overrides (persisted by Hindsight, not injected by Butler or compose). Retain and observations use explicit third-person subjects, including Renee's own experiences. Reflect uses third person for reusable knowledge, Mental Models and person pages; Renee dialogue may use first person without changing event participants. Original quotations and diaries retain their authors' pronouns. Legacy ambiguous pronouns must not be assumed to refer to Renee.
