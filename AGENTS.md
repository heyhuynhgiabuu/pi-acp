# Development Rules

pi-acp is an ACP adapter for pi: a Node CLI that an ACP client (Zed today) launches over stdio and
that drives the installed `pi` binary in RPC mode. pi itself is never modified.

- ACP side: JSON-RPC 2.0 over stdio via `@agentclientprotocol/sdk` (`ndjsonStream` +
  `AgentSideConnection`, wired in `src/index.ts`).
- pi side: one child per session, spawned as `pi --mode rpc --no-themes [--session <file>]`
  (`src/pi-rpc/process.ts`), speaking newline-delimited JSON.

## Conversational Style

- Answer the question first, before edits or commands.
- When given feedback or an analysis, say whether you agree or disagree before saying what changed.
- Short, direct, technical prose. No fluff, no cheerful filler, no emojis.
- Reply in the user's language; keep code, comments, docs, and commit messages in English.
- Explain a non-trivial design as problem, then a concrete trace or example, then the solution, and
  separate what is necessary from optional complexity.
- Say what you verified and how, and name what you could not verify.

## Architecture

- `src/acp/*` owns ACP protocol handling and session orchestration: `agent.ts` (every ACP method),
  `session.ts` (`SessionManager`, `PiAcpSession`, turn queue), `subagent-session.ts` (pi-task child
  sessions), `translate/*` (pure pi to ACP mapping), `pi-commands.ts`/`pi-sessions.ts`/
  `pi-settings.ts`/`session-store.ts`/`paths.ts` (on-disk state), `slash-commands.ts`.
- `src/pi-rpc/*` owns the subprocess: spawn, NDJSON request/response, timeouts, executable lookup.
- `scripts/smoke-*.mjs` are manual stdio smoke checks, one per feature.
- Keep translation functions pure and unit-testable, and keep protocol handling out of `pi-rpc`.

## Process Model

A session's pi process is not permanent: it is created on demand and released when idle.

- `SpawnLimiter` (`PI_ACP_MAX_CONCURRENT_SPAWNS`, default 2) bounds concurrent boots, so a client
  restoring ten threads does not start ten pi processes at once.
- The resident cap (`PI_ACP_MAX_RESIDENT_SESSIONS`, default 1) keeps the most recently used session
  plus its parent lineage and releases idle sessions beyond it, oldest first.
- `SessionManager.beginRequest`/`isInFlight` lease a session for the duration of a client request;
  the cap and `closeAllExcept` never touch a leased session. Explicit releases (a finished task
  handing back a child, a load releasing a finished viewer) deliberately ignore leases.
- A running turn, an active subagent task run, and an in-flight request all block release.

Preserve these invariants; breaking them fails at runtime, not in tests:

- Never kill a process a request still needs. `PiRpcProcess` rejects every pending request when the
  child exits, so a mid-request eviction surfaces as `pi process exited`. New ACP handlers that touch
  a session run under `withSessionLease` (`agent.ts`), and anything that releases sessions respects
  in-flight requests.
- Never let the resident count grow with the number of open threads. The original leak: model and
  thinking config calls for each thread each spawned a process that nothing closed.
- Do not cache `session.proc` across awaits without holding a lease; a session can be restored
  mid-request.

## External Contracts

- ACP: the pinned `@agentclientprotocol/sdk` is the contract. Read its types in
  `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts`; there is no vendored ACP spec here.
- pi RPC: read the installed version's docs under
  `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` (`rpc-commands.md`, `rpc.md`,
  `session-format.md`, `environment-variables.md`). The RPC surface moves between releases; this
  adapter keeps fallbacks for current and legacy event shapes, so preserve them when editing
  translation.
- Zed is the reference client. Some of what it needs is `_meta`-based and undocumented (subagent
  session info, terminal-auth capability): treat those as unverified until a live Zed run confirms
  them, and say so.

## Scope

- No ACP filesystem or terminal delegation: pi reads, writes, and executes locally.
- `mcpServers` is accepted and stored, not forwarded to pi.
- Assistant output streams as `agent_message_chunk` (no separate thought stream).
- README documents install, Zed setup, environment variables, and limitations; link to it instead of
  repeating it.

## Commands

- After code changes: `npm run typecheck`, `npm test`, and `npm run format` (or the narrowest safe
  formatter command for the files you touched, and say so if you skip it).
- Never expect `npm run lint` to exit clean: it currently reports ~1.5k deferred `anti-slop`
  findings (see README). Do not mass-fix them, do not reformat unrelated files, and do not read a
  failing lint run as your own regression.
- Run `npm run build` when the artifact matters: `dist/` is what a client runs, so rebuild before
  asking anyone to retest in Zed.
- Run a single test file with `node --import tsx --test test/unit/<name>.test.ts`. If you create or
  modify a test, run it and iterate until it passes.
- Write ad-hoc scripts to a temp file (`/tmp`) and run them; do not embed multi-line scripts in bash
  commands.
- `npm run smoke` and the other `scripts/smoke-*.mjs` drive the adapter over stdio for manual checks.

## Testing

- Unit tests cover pure translation; component tests drive `PiAcpAgent` with the real
  `SessionManager` and fake pi processes from `test/helpers/fakes.ts`.
- Those fakes are dispose-tolerant, so they cannot see a process dying at the wrong moment. If your
  change can kill a process, give the fake real kill semantics (reject pending calls on dispose, as
  `src/pi-rpc/process.ts` does) and assert every call succeeds. A process count alone does not prove
  correctness.
- `test/helpers/fakes.ts` points `PI_ACP_HOME` at a temp dir on import, so an inline harness that
  imports it loses the real session map and falls back to scanning every session file. Set
  `PI_ACP_HOME` explicitly when you need real state.
- Adapter state lives in `~/.pi/pi-acp/` (`session-map.json`); pi's sessions live in
  `~/.pi/agent/sessions/`. Never write into pi's directories from the adapter.

## Code Quality

- Read a file in full before editing it, and before wide-ranging changes.
- No `any` unless necessary. It is acceptable at boundaries (untyped external data) and in test
  doubles.
- Do not hide behavior-critical calls behind optional-call casts such as
  `(this.sessions as any).touch?.()`: a rename would silently disable the call in production. Keep
  test doubles complete instead.
- Comments explain non-obvious decisions only; no narration.
- Smallest reviewable diff. Preserve public ACP behavior and on-disk formats unless the task is to
  change them.
- Ask before removing functionality that looks intentional.

## Dependencies

- Treat dependency and lockfile changes as reviewed code. The lint and format toolchain is pinned to
  exact versions; runtime dependencies use caret ranges.
- Do not hand-edit `package-lock.json`; regenerate it with npm.

## Git

- Never commit unless the user asks.
- Stage explicit paths; never `git add -A` or `git add .`. Run `git status` first and confirm you are
  staging only your own files.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or
  `git commit --no-verify`.
- Resolve conflicts only in files you modified; if a conflict is in a file you did not touch, abort
  and ask.

## Tracking

- Multi-stage work is tracked in `.pi/artifacts/` (`PLAN.md`, `TODO.md`); keep the relevant file
  current until the work is done.
- `.pi/artifacts/task-registry.json` and `.pi/artifacts/tasks/` are written by the pi-task
  extension. Do not edit them by hand.

## User Override

- If the user's instructions conflict with a rule in this document, ask for explicit confirmation
  before overriding it.
