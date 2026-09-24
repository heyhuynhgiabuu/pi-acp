# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Context window usage
  - Reports pi's real context occupancy (`get_session_stats` → `contextUsage`) to the client as ACP `usage_update` after each turn, on `session/new` and `session/load`, and after a model switch
  - Requires a pi version whose `get_session_stats` response includes `contextUsage`; otherwise no usage is reported
  - Right after compaction pi may not have a trustworthy token count yet, so the client keeps the previous value until the next model response
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22.19+ to run the current Pi v0.87.1 compatibility baseline
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable). Compatibility is verified against Pi v0.87.1; older versions fall back to the legacy thinking-level list when they do not expose that RPC command.
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

This fork is published as `@heyhuynhgiabuu/pi-acp`. The ACP registry entry below installs the
upstream `pi-acp` package instead, so use the `npx`, global, or from-source option to run this fork.

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@heyhuynhgiabuu/pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g @heyhuynhgiabuu/pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_PI_COMMAND` optionally selects the Pi executable used for RPC sessions, terminal login, version checks, and `/changelog`. By default, `pi` (or `pi.cmd` on Windows) is resolved from `PATH`.
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.
- `PI_ACP_MAX_RESIDENT_SESSIONS` caps how many `pi` session processes stay alive at once. Default `1`: the thread you are using keeps its process, and the previous one is closed, so switching threads can pay a fresh pi start (a few seconds). Raise it (for example `2` or `3`) to keep recently used threads warm at roughly one process each; invalid or non-positive values fall back to the default.
- `PI_ACP_MAX_CONCURRENT_SPAWNS` caps how many `pi` processes boot at the same time when a client restores several threads at once. Default `2`; invalid or non-positive values fall back to the default.
- Session storage follows pi: `PI_CODING_AGENT_SESSION_DIR` overrides the `sessionDir` setting in pi's `settings.json`, which overrides `<agent dir>/sessions`. `PI_CODING_AGENT_DIR` selects the agent directory itself.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

pi's own built-ins are terminal commands, not part of its RPC surface (`get_commands` returns only
extension commands, prompt templates, and skills), so the adapter implements the ones that map onto
ACP itself:

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/tree` – show where the session branches and what the active branch is (a digest, because the
  tree can hold thousands of entries: the newest branch points with each side's tip, then the tail of
  the active branch). Long sessions fall back to pi's flat entry list because `get_tree` overflows
  the stack there
- `/copy` – re-print the last assistant message so the client can select and copy it (ACP has no
  clipboard access)
- `/clone` – duplicate this thread at its current position into a new thread
- `/fork [number]` – create a new thread from an earlier user message; without an argument the client
  shows a picker (clients without elicitation get the numbered list and `/fork <number>`)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` – get/set pi's steering mode (pi's own queue; see below)
- `/follow-up` – get/set pi's follow-up mode (pi's own queue; see below)

The remaining pi built-ins are not available through ACP:

| pi command                                                      | Why it is not here                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/model`, `/thinking`, `/scoped-models`                         | Covered by the ACP model and thinking selectors in the client                                                                                                                                                                         |
| `/settings`, `/hotkeys`, `/quit`, `/reload`, `/trust`, `/llama` | Terminal UI or pi-process concerns; the client owns its own settings and lifecycle                                                                                                                                                    |
| `/login`, `/logout`                                             | Provider auth belongs to pi; use the client's Authenticate action (terminal login) or run `pi`                                                                                                                                        |
| `/new`, `/resume`, `/import`, `/fork`, `/clone`                 | They switch or create the session the client is attached to, and ACP gives the adapter no way to move the client to another thread. Use the client's thread picker; `session/fork` and `session/resume` cover clients that ask for it |
| `/share`, `/bug`                                                | Upload or report actions with external side effects                                                                                                                                                                                   |
| `/copy`                                                         | Available as `/copy` above, re-printed for the client to copy instead of touching the clipboard                                                                                                                                       |

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: commands registered by pi extensions are forwarded too (`get_commands` returns extension commands, prompt templates, and skills), so they appear in the client together with the built-ins above. Extension commands that drive pi's own terminal UI are the exception.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run format     # format with Oxfmt
npm run format:check
npm run lint       # Oxlint + anti-slop rules
npm run test
```

Oxlint 1.85 has no equivalent for ESLint's `no-octal` or `no-dupe-args`; `no-redeclare` and `no-undef` are enabled for `scripts/*.mjs` through an override. `unicorn/no-useless-fallback-in-spread` remains off to avoid one unrelated existing finding. The full anti-slop ruleset is intentionally enforced as errors, so `npm run lint` currently reports existing findings deferred to the planned refactor.

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Prompts sent while a turn is running are queued by pi-acp and delivered one per turn. `/steering` and `/follow-up` set pi's own queue modes, which apply when you run pi directly; they do not change that delivery.
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
