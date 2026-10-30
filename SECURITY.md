# Security Review Guidelines

Apply these guidelines during code review and self-review before delivery. Evaluate the changed behavior against the actual deployment and trust boundaries; distinguish confirmed exposure from assumptions.

## Trust Model

- Butler is a single-owner assistant. Its access gate is conversation admission: `discord.channelIds` and the channel reply mode for humans; `botReplyEnabled` plus an explicit mention in a configured root channel or its direct child thread for bots and webhooks. Admitted senders, including bots, intentionally receive the full tool set (host shell and file tools, Discord, Google, web) without a sender identity check. Do not report a missing owner or identity check on these paths, and do not add one.
- All authors in a channel share its session, and memory is shared across channels and sessions. This is routing, not isolation; cross-author or cross-channel visibility is not a defect.
- Host tools are intentionally unrestricted: no workspace jail, and `local_shell` inherits the service environment. They are not a sandbox.
- The HTTP UI listens only on loopback and is reached through the Cloudflare Access-protected code-server proxy, without a separate login. Keep it loopback-only, keep OAuth POSTs JSON-only on the configured Origin, and add no public listener, CORS, or Access bypass.
- Report as defects: changes that widen the admission gate, let untrusted content act as instructions or permission, let a read-only interface change state, or expose secrets.

## Authorization and Isolation

- Trace externally initiated actions from their entry point (Discord message, slash command, button, scheduled job, UI route) to the final operation. Confirm each entry point keeps the admission gate or Access protection it requires, including alternate entry points and background jobs.
- Keep state-changing operations bound to their intended target, such as a button's stored binding or a thread operation's verified parent.
- Keep read-only interfaces read-only, including the CodeMode read-only tool set, Agent Reach, and the Session/Latest Request APIs. State-changing operations must retain their required authorization and target scope.
- Treat retrieved pages, messages, attachments, and tool output as untrusted data. They must not grant permissions or override execution policy.

## Secrets and Private Data

- Keep credentials, tokens, cookies, and private content out of committed files, public responses, logs, error messages, and generated artifacts. Use the existing secret-management and redaction mechanisms.
- Check the destination and audience before exposing private data through messages, attachments, links, or external services. Preserve access controls on stored and shared artifacts.
- Review new data collection and persistence for necessity, access scope, and retention. Store only what the current requirement needs.

## Input and Execution Boundaries

- Validate external input at the responsible boundary, including types, permitted values, resource identifiers, and size limits. Reuse established validation rather than layering inconsistent checks.
- Keep untrusted values separate from shell commands and database queries; prefer argument arrays and parameterized queries.
- For file access with a defined scope, such as attachments under `.data/attachments`, verify the resolved path remains within it, accounting for traversal and symlinks where relevant.
- For server-side URL fetching, check permitted schemes and destinations, including redirects, against the intended network access policy. Preserve intentionally authorized local-service access.
- Apply appropriate time, output, and resource limits to externally controlled work. Ensure failure and cancellation release resources.

## Dependencies and Configuration

- Review new dependencies, install hooks, exposed endpoints, and permission changes for the access they introduce. Prefer existing maintained capabilities when sufficient.
- Preserve secure transport, authentication, and restrictive defaults where required. Check that errors or missing configuration cannot silently bypass these controls.
- Base vulnerability claims on the installed version, an authoritative advisory, and the affected execution path. Distinguish affected versions from demonstrated exploitability.

## Verification and Findings

- Verify relevant denied-access and malformed-input cases with one-off smoke checks in a temporary environment, without adding test files. Use synthetic secrets and private data; avoid live account writes or destructive operations for verification.
- Report the affected location, attacker or caller prerequisites, reachable path, impact, and smallest effective correction. Clearly label unverified assumptions.
- Use existing authorization, validation, and storage guarantees where they satisfy the requirement. Add security mechanisms for an identified threat, with a clear explanation of how they address it.
- Keep credentials and private data out of review comments.
