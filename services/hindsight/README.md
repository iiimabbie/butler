# Hindsight Evaluation Service

Local Hindsight service for Butler shared memory and isolated evaluation. Butler uses the configured formal bank `butler-discord`; the separate `butler-hindsight-synthetic-eval` bank is reserved for synthetic evaluation data. Butler remains a native Node service.

## Requirements

- Docker Engine with Compose
- A private `.env` populated from the specifically authorized local CPA and Umiro embedding settings

The pinned image is `ghcr.io/vectorize-io/hindsight:0.10.2`. The API binds only to `127.0.0.1:18888`; embedded PostgreSQL is published only on host loopback at `127.0.0.1:15432`. The named volume `butler-hindsight-evaluation-data` persists embedded PostgreSQL state. The CPU reranker uses Hindsight's local `cross-encoder/ms-marco-MiniLM-L-6-v2` model. The official image includes local ML support and model preload.

## Local PostgreSQL connection

Connect from the host to `127.0.0.1:15432` using the existing database name, username, and password recorded in the container's `/home/hindsight/.pg0/instances/hindsight/instance.json`; do not copy the password into project files. The Compose `HINDSIGHT_API_DATABASE_URL` is a non-secret pg0 configuration URL that enables TCP listening and selects the dedicated `/home/hindsight/.pg0/host-access.conf` authentication file. That file must exist in the persistent `.pg0` volume and retain the local loopback/socket password rules plus a password-authenticated `host` rule restricted to the Docker host gateway address (`172.19.0.1/32` at present). If the Docker gateway changes, update the allowed address in `host-access.conf` accordingly. The PostgreSQL port is published only on host loopback, not on public interfaces.

## Configure

Create `.env` from `.env.example`, then fill its credential and endpoint fields from approved local settings. Keep `.env` mode `0600`; the directory `.gitignore` excludes only that file. Do not paste credentials into this README, the example file, or evaluation notes.

Hindsight calls the CPA through `host.docker.internal` (mapped to the host gateway for Linux). The embedding adapter uses LiteLLM SDK's `voyage/voyage-4` model with 1024 output dimensions and passes Voyage's document/query input types through the SDK.

## Run

From this directory:

```sh
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:18888/health/ready
python3 probe.py
```

The probe creates/uses `butler-hindsight-synthetic-eval`, retains synthetic records about a changing preference, a dated decision and rationale, and a cross-note relation, then runs recall and three reflect questions including one with no supporting evidence and one asking who owns the cross-note fix. It prints elapsed time, recall evidence, reflect answers, and any `based_on` references returned by the API. Re-running the probe replaces the same synthetic source documents.

## Current evaluation result

On 2026-10-05 the pinned image reached `/health/ready` (HTTP 200). Synthetic retain succeeded for four items in 5.76s; recall returned three evidence records in 0.36s, including both the current and prior preference. The three reflect calls took 4.66s, 3.80s, and 4.77s. Answers correctly stated the updated preference/date, the Atlas delay/date/reason and Rowan's responsibility across separate notes, and that no evidence existed for the ice-cream question. Initial calls returned `based_on: null` because the request omitted the opt-in `include.facts` flag. Pinned v0.10.2 OpenAPI confirms `ReflectResponse.based_on` is evidence used to generate the response and is populated only when `include.facts` is set; `include: {"facts": {}}` enables it. The probe now sends this flag and reads the documented `based_on.memories` citations. A single confirming reflect (no additional retain) took 3.74s and returned three evidence facts for the Atlas decision, accessibility finding, and Rowan ownership. Hindsight recorded 15 successful `openai-responses` calls using model `gemma4:31b`, including retain, reflect, and consolidation, confirming CPA Responses operation. The configured Voyage LiteLLM SDK embeddings and local CPU reranker participated in the successful retain/recall setup, but this version's request metadata did not expose individual embedding or reranker call traces; those providers were not independently verified per call.

To stop the service while keeping its data:

```sh
docker compose -f compose.yaml down
```

To remove the evaluation data as well, explicitly remove the named volume:

```sh
docker volume rm butler-hindsight-evaluation-data
```

## Server-owned retrieval defaults (2026-10-08)

Butler no longer sends `budget` or `max_tokens` on automatic recall, memory tools or people recall/reflect. Its old `memory.recallBudget`, `reflectBudget`, `maxTokens` keys are ignored; transport timeout remains client-owned.

This deployment uses `butler-hindsight:0.10.2-central-defaults`. Stock 0.10.2 HTTP request models hard-code defaults (Recall mid/4096; Reflect low/4096); `recall_max_tokens` in bank configuration is not the HTTP Recall request default. `patch-request-defaults.py` exposes **local extension variables**, not stock upstream settings:

- `HINDSIGHT_API_REQUEST_RECALL_BUDGET=mid`
- `HINDSIGHT_API_REQUEST_RECALL_MAX_TOKENS=1200`
- `HINDSIGHT_API_REQUEST_REFLECT_BUDGET=mid`
- `HINDSIGHT_API_REQUEST_REFLECT_MAX_TOKENS=1600`

Change these in compose and recreate the service. These are default values; explicit HTTP API callers can override them. Butler never does.

Bank `butler-discord` uses fixed retrieval budgets low=30, mid=60, high=100, with `recall_max_tokens=1200` also aligned for non-HTTP/internal callers. These are search budgets, **not merged-candidate counts**. Reranking caps are low=30, mid=50, high=50. The engine patch clamps the resolved rerank cap to 50 even if a per-level override is accidentally higher. The existing Typesafe/JEV 20,000-token context safety/truncation patch is retained; the count limit alone cannot prevent long-text overflow.

Verified: live parameter-free Recall used budget=60, merged 246 candidates, reranked 50, returned 10 facts/1188 tokens under the 1200-token limit in 682 ms. A second call through the newly built Butler wrapper succeeded. Targeted client tests passed. Full legacy suite was attempted but failed multiple tests and timed out; do not report it as passing.

Both image patches assert exact upstream matches and fail build on version drift. Recheck them before upgrading. Source and bank backups for this change are in `.data/hindsight-central-20261008-085612/`; the previous image is `butler-hindsight:0.10.2-jev20k`.

## Task recovery (2026-10-08)

The pinned 0.10.2 image retains its native short worker retry schedule (three retries, 60 seconds by default). After that schedule is exhausted, only `batch_retain` and `refresh_mental_model` tasks with confirmed transient remote-provider errors are rescheduled as the same persistent operation: 300 seconds, then 900 seconds, then at least 1800 seconds for every later retry. The poller persists the pending status, retry count, and next retry time; it releases the worker slot and resumes the existing payload and operation after the delay. A blocked retain therefore continues to preserve same-document ordering; new chat remains collected by Butler and is not resent as an alternate recovery path.

Classification delegates to the image's existing typed `remote_retry` classifier and follows exception causes/unsuppressed contexts. Permanent HTTP 4xx and content-policy errors take precedence. Chunk extraction aggregates retain original exception objects so long cooldown recovery is allowed only when every failed chunk is confirmed transient; mixed, unknown, malformed-output, and other application errors retain the native finite retry behavior. Deterministic exclusions, quota deferral, file conversion, consolidation retries, automatic-refresh pause, checkpoints, and cancellation behavior remain native and unchanged. This does not recover every failed operation.

`task-recovery.py` and `patch-task-recovery.py` are repository-owned patches applied during image build. Both replacement anchors must match exactly once; drift stops the build. Before upgrading the pinned upstream version, recheck both anchors and the worker retry, pause, and checkpoint contracts; remove the patch if upstream gains equivalent behavior.

### Central output language

`compose.yaml` sets `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE=Traditional Chinese (Taiwan)` as the single output-language policy for retain, observations, reflect, and their generated summaries. Missions and Butler's person-summary prompt describe content and attribution, not output language. Changing this system-level environment setting requires recreating the Hindsight container; it does not rewrite existing memories. Butler does not supply missions or language overrides when creating banks.

### Knowledge perspective (2026-10-10)

The formal `butler-discord` bank stores `retain_mission`, `observations_mission`, and `reflect_mission` as bank configuration overrides (persisted by Hindsight, not injected by Butler or compose). Retain and observations use explicit third-person subjects, including Renee's own experiences. Reflect uses third person for reusable knowledge, Mental Models and person pages; Renee dialogue may use first person without changing event participants. Original quotations and diaries retain their authors' pronouns. Legacy ambiguous pronouns must not be assumed to refer to Renee.

The person-page fixed prompt in `src/people-tools.ts` follows the same rule on future upserts. Existing memories and page source queries were not bulk rewritten. Restricted before/after configuration backups are under `backups/hindsight-third-person/20261010T064334Z/`; do not publish them. All three mission overrides were read back exactly, with unrelated bank overrides unchanged. A live Reflect check of yuu's instruction to Ani returned third-person attribution without transferring the instruction to Renee; this is one behavioral check, not exhaustive retain/consolidation validation. Typecheck and build passed. Butler deployment is needed for the local fixed-prompt change; bank mission changes apply independently without restarting Hindsight.
