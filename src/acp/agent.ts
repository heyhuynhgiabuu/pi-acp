import {
  ForkSessionRequest,
  ForkSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager, readVisibleCustomMessageText, type PiAcpSession } from './session.js'
import {
  readPiTaskSessionEvent,
  readPiTaskSessionEventsFromSessionFile,
  readPiTaskToolResult,
  subagentSessionInfoMeta
} from './subagent-session.js'
import { SessionStore } from './session-store.js'
import { SpawnLimiter, maxConcurrentSpawns } from './spawn-limiter.js'
import { PiRpcProcess } from '../pi-rpc/process.js'
import { findPiChangelogPath, getPiCommandVersion } from '../pi-rpc/command.js'
import { listPiSessions, findPiSession } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

// pi-acp queues prompts itself (see PiAcpSession.turnQueue) and never fills pi's steering or
// follow-up queue, so `/steering` and `/follow-up` only affect a pi run started outside the adapter.
const QUEUE_MODE_NOTE = " (pi's own queue; pi-acp queues prompts itself and delivers one per turn)"

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()
  private clientSupportsFormElicitation = false
  // Threads restored in parallel must not each start a pi process before any can be closed.
  private readonly spawnLimiter = new SpawnLimiter(maxConcurrentSpawns())

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  /**
   * Run a client request while holding a lease on its session. The manager refuses to evict or
   * close a leased session, so a concurrent request for another thread cannot take this
   * request's pi process away mid-RPC.
   */
  private async withSessionLease<T>(sessionId: string, request: () => Promise<T>): Promise<T> {
    const release = (this.sessions as any).beginRequest?.(sessionId)
    try {
      return await request()
    } finally {
      release?.()
      // The request is done with its session, so the cap can now be enforced for real: during
      // the request the session was skipped, and nothing else may have trimmed since.
      ;(this.sessions as any).trimResidentSessions?.()
    }
  }

  /**
   * Guard every write to a child session: reject while a running task owns the transcript,
   * and drop a process opened before the task finished so the write cannot fork the session
   * tree onto a stale branch. Tolerates a stubbed manager (tests replace `this.sessions`).
   */
  private prepareChildSession(sessionId: string): void {
    const sessions = this.sessions as any
    sessions.assertSessionMutable?.(sessionId)
    sessions.recycleStaleSubagentSession?.(sessionId)
  }

  /**
   * Restore a session for writing. A restore already in flight when the task completed
   * would otherwise be adopted as-is, so the stale check is repeated once it lands.
   */
  private async openSessionForWrite(sessionId: string): Promise<PiAcpSession> {
    this.prepareChildSession(sessionId)

    let session = await this.restoreSession(sessionId)
    if ((this.sessions as any).recycleStaleSubagentSession?.(sessionId)) {
      session = await this.restoreSession(sessionId)
    }

    // The client is working with this session, so it outranks older idle ones under the cap.
    ;(this.sessions as any).touch?.(sessionId)
    return session
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private findStoredSession(sessionId: string): { cwd: string; sessionFile: string } | null {
    const stored = this.store.get(sessionId)
    // The store is authoritative on a hit: the discovery fallback below walks every pi
    // session file, which is far too slow to run for a stale mapping. Stale entries are
    // pruned from the map itself instead.
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile }
    }

    const piSession = findPiSession(sessionId)
    if (!piSession) return null

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    })

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    }
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    const existing = this.sessions.maybeGet(sessionId)
    if (existing) return existing

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) return inFlight

    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId)
      if (!stored) {
        throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
      }

      const cwd = opts?.cwd ?? stored.cwd

      let proc: PiRpcProcess
      try {
        proc = await this.spawnLimiter.run(() =>
          PiRpcProcess.spawn({
            cwd,
            sessionPath: stored.sessionFile,
            piCommand: process.env.PI_ACP_PI_COMMAND
          })
        )
      } catch (e: any) {
        if (e?.name === 'PiRpcSpawnError') {
          throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
        }
        throw e
      }

      // The process is not yet owned by the manager, so a failure before registration
      // would leave an orphaned pi subprocess behind.
      let session: PiAcpSession
      try {
        const fileCommands = loadSlashCommands(cwd)
        session = this.sessions.getOrCreate(sessionId, {
          cwd,
          mcpServers: opts?.mcpServers ?? [],
          conn: this.conn,
          proc,
          fileCommands,
          onThinkingLevelChanged: (sessionId, proc) => this.refreshThinkingLevel(sessionId, proc),
          supportsFormElicitation: () => this.clientSupportsFormElicitation
        })
      } catch (error) {
        try {
          proc.dispose?.()
        } catch {
          // ignore: the original failure is the primary result
        }
        throw error
      }

      this.lastSessionCwd = cwd
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile })

      return session
    })()

    this.restoringSessions.set(sessionId, restorePromise)

    try {
      return await restorePromise
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  /**
   * pi can change the thinking level on its own (for example when a model switch forces a level
   * that model supports). Refresh the client's config options so they do not show a stale value;
   * the session already sent the mode update.
   */
  private refreshThinkingLevel(sessionId: string, proc: PiRpcProcess): void {
    void emitConfigOptionsUpdate(this.conn, sessionId, proc).catch(() => {
      // best-effort: the mode update the session sent is enough on its own
    })
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    // Elicitation is UNSTABLE in the pinned SDK, so only offer it when the client advertised it.
    this.clientSupportsFormElicitation = Boolean((params as any)?.clientCapabilities?.elicitation?.form)

    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        // `name` is the logical identity (clients use it for telemetry and identification);
        // `title` is what ACP defines for user-facing display.
        name: pkg.name ?? 'pi-acp',
        title: 'Pi Coding Agent',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {},
          // Without this, a client that closes a thread never tells us, so its pi
          // subprocess lingers until the next session/new or session/load.
          close: {},
          // Restore a thread the client already has the transcript for, without replaying it.
          resume: {},
          // **UNSTABLE** Fork a thread; mapped to pi's `clone` (see forkSession).
          fork: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.spawnLimiter.run(() =>
      this.sessions.create({
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        conn: this.conn,
        fileCommands,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        onThinkingLevelChanged: (sessionId, proc) => this.refreshThinkingLevel(sessionId, proc),
        supportsFormElicitation: () => this.clientSupportsFormElicitation
      })
    )
    ;(this.sessions as any).touch?.(session.sessionId)

    // Hold the fresh session for the rest of the request: the state, model and config RPCs
    // below would fail if a concurrent request for another thread evicted this process.
    return this.withSessionLease(session.sessionId, () =>
      this.finishNewSession(session, params.cwd, fileCommands, enableSkillCommands)
    )
  }

  private async finishNewSession(
    session: PiAcpSession,
    cwd: string,
    fileCommands: ReturnType<typeof loadSlashCommands>,
    enableSkillCommands: boolean
  ) {
    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    let sessionConfiguration: Awaited<ReturnType<typeof getSessionConfiguration>>
    try {
      sessionConfiguration = await getSessionConfiguration(session.proc, {
        state,
        availableModels
      })
    } catch (error: unknown) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw error
    }
    const { configOptions, models, modes } = sessionConfiguration

    const piVersion = getPiCommandVersion()
    const quietStartup = getQuietStartup(cwd)
    const updateNotice = buildUpdateNotice(piVersion)

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd,
          fileCommands,
          piVersion,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
    // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
    // It does NOT affect other client windows because they run in separate agent processes.
    //
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        // Publish real context usage now that the client knows the sessionId (clients ignore
        // notifications for unknown sessions), so the window size is correct before the first prompt.
        await session.publishContextUsage()

        try {
          const pi = (await session.proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // Hold the session for the whole request, including the slash-command branches that run
    // RPCs before any turn starts.
    return this.withSessionLease(params.sessionId, () => this.promptInternal(params))
  }

  private async promptInternal(params: PromptRequest): Promise<PromptResponse> {
    // Tests may replace the session manager with a minimal stub.
    const session = await this.openSessionForWrite(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = await session.proc.getSessionStats()

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}` + QUEUE_MODE_NOTE
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` + QUEUE_MODE_NOTE }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}` + QUEUE_MODE_NOTE
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` + QUEUE_MODE_NOTE }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const changelogPath = findPiChangelogPath()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images)

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    return this.withSessionLease(params.sessionId, async () => {
      const session = this.sessions.maybeGet(params.sessionId)
      if (!session) return
      await session.cancel()
    })
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.withSessionLease(params.sessionId, () => this.loadSessionInternal(params, { replay: true }))
  }

  /**
   * ACP `session/resume`: restore a session for a client that already holds its transcript, so the
   * conversation continues without replaying every message again.
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const loaded = await this.withSessionLease(params.sessionId, () =>
      this.loadSessionInternal(params, { replay: false })
    )

    return { configOptions: loaded.configOptions, modes: loaded.modes, _meta: loaded._meta }
  }

  /**
   * ACP `session/fork`: start a new session from an existing one. pi's `clone` duplicates the
   * active branch at the current position, which is the closest match to what ACP describes. The
   * clone rebinds the source session's process to the fork, so the process is handed back here and
   * both threads restore their own on demand.
   */
  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.withSessionLease(params.sessionId, async () => {
      if (!isAbsolute(params.cwd)) {
        throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }

      const source = await this.restoreSession(params.sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers
      })
      const proc = source.proc

      const result = await proc.clone()
      if (result?.cancelled) {
        throw RequestError.internalError({}, 'The fork was cancelled by a pi extension.')
      }

      const state = (await proc.getState()) as any
      const forkedSessionId = typeof state?.sessionId === 'string' ? state.sessionId : null
      const forkedSessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

      if (!forkedSessionId || !forkedSessionFile || forkedSessionId === params.sessionId) {
        throw RequestError.internalError({}, 'pi did not report a forked session.')
      }

      this.store.upsert({ sessionId: forkedSessionId, cwd: params.cwd, sessionFile: forkedSessionFile })

      const { configOptions, modes } = await getSessionConfiguration(proc, { state })

      // The process serves the fork now; either thread restores its own process when used again.
      this.sessions.close(params.sessionId)

      return { sessionId: forkedSessionId, configOptions, modes }
    })
  }

  /**
   * Replay a session's transcript to the client. Shared by `session/load`, which replays, and
   * `session/resume`, which deliberately does not.
   */
  private async replaySessionMessages(
    session: PiAcpSession,
    proc: PiRpcProcess,
    cwd: string,
    sessionFile: string
  ): Promise<void> {
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const taskToolCalls = new Map<string, { toolCallId: string; status: 'completed' | 'failed' }>()
    const taskSessionIds = new Map<string, string>()
    const completedTaskRuns = new Set<string>()
    const linkedTaskCalls = new Set<string>()
    const taskLinkKey = (taskId: string, piToolCallId?: string): string =>
      piToolCallId ? `${taskId}\u0000${piToolCallId}` : taskId
    const taskCallIdsByTask = new Map<string, Set<string>>()
    const toolResultIds = new Set<string>()
    let replayedBashCount = 0

    for (const message of messages) {
      const toolCallId = typeof (message as any)?.toolCallId === 'string' ? (message as any).toolCallId : undefined
      if (toolCallId) toolResultIds.add(toolCallId)

      const taskResult = readPiTaskToolResult(message)
      if (!taskResult || !toolCallId) continue
      const callIds = taskCallIdsByTask.get(taskResult.taskId) ?? new Set<string>()
      callIds.add(toolCallId)
      taskCallIdsByTask.set(taskResult.taskId, callIds)
    }

    // Anchors a durable link may attach to: persisted tool results plus assistant tool calls
    // that have not produced a result yet (a task still running when the session reloaded).
    const assistantToolCallIds = new Set<string>()
    for (const message of messages) {
      if (String((message as any)?.role ?? '') !== 'assistant') continue
      const content = (message as any)?.content
      if (!Array.isArray(content)) continue

      for (const part of content) {
        const call = part as { type?: unknown; id?: unknown }
        if (call?.type !== 'toolCall' || typeof call.id !== 'string' || !call.id) continue
        assistantToolCallIds.add(call.id)
      }
    }

    const projectedToolCallIds = new Set([...toolResultIds, ...assistantToolCallIds])
    const childSessionIdByToolCallId = new Map<string, string>()

    const resolveTaskRunKey = (taskId: string, piToolCallId?: string): string => {
      if (piToolCallId) return taskLinkKey(taskId, piToolCallId)
      const prefix = `${taskId}\u0000`
      const candidates = new Set<string>()
      for (const key of [...taskToolCalls.keys(), ...taskSessionIds.keys(), ...completedTaskRuns, ...linkedTaskCalls]) {
        if (key.startsWith(prefix)) candidates.add(key)
      }
      return candidates.size === 1 ? [...candidates][0]! : taskId
    }

    const linkTaskSession = async (taskId: string, sessionId: string, piToolCallId?: string) => {
      session.rememberSubagentSession(sessionId)
      const key = resolveTaskRunKey(taskId, piToolCallId)
      if (piToolCallId) childSessionIdByToolCallId.set(piToolCallId, sessionId)
      if (linkedTaskCalls.has(key)) return
      const toolCall = taskToolCalls.get(key)
      if (!toolCall) {
        taskSessionIds.set(key, sessionId)
        return
      }
      taskToolCalls.delete(key)
      taskSessionIds.delete(key)
      linkedTaskCalls.add(key)
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: toolCall.status,
          _meta: subagentSessionInfoMeta(sessionId)
        }
      })
    }

    const replayTaskEvent = async (taskEvent: NonNullable<ReturnType<typeof readPiTaskSessionEvent>>) => {
      const callIds = taskCallIdsByTask.get(taskEvent.taskId)
      const piToolCallId = taskEvent.piToolCallId ?? (callIds?.size === 1 ? [...callIds][0] : undefined)
      if (taskEvent.sessionId) await linkTaskSession(taskEvent.taskId, taskEvent.sessionId, piToolCallId)
      if (taskEvent.kind !== 'task-complete') return
      const key = resolveTaskRunKey(taskEvent.taskId, piToolCallId)
      completedTaskRuns.add(key)
      if (!linkedTaskCalls.has(key) && !taskSessionIds.has(key)) taskToolCalls.delete(key)
    }

    for (const taskEvent of await readPiTaskSessionEventsFromSessionFile(sessionFile)) {
      if (taskEvent.kind !== 'task-session' || !taskEvent.sessionId) continue
      const callIds = taskCallIdsByTask.get(taskEvent.taskId)
      const piToolCallId = taskEvent.piToolCallId ?? (callIds?.size === 1 ? [...callIds][0] : undefined)
      if (!piToolCallId || !projectedToolCallIds.has(piToolCallId)) continue
      await linkTaskSession(taskEvent.taskId, taskEvent.sessionId, piToolCallId)
    }

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'custom') {
        const taskEvent = readPiTaskSessionEvent(m)
        if (taskEvent) await replayTaskEvent(taskEvent)
        const visibleText = readVisibleCustomMessageText(m)
        if (visibleText) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: visibleText }
            }
          })
        }
        continue
      }

      if (role === 'user') {
        const text = normalizePiMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizePiAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            }
          })
        }

        // A task still running when the session reloaded has no persisted tool result, so
        // its assistant tool call is the only anchor for the child link. Replay it as a
        // tool call and attach the child session, or the child card would never appear.
        const content = (m as any)?.content
        if (!Array.isArray(content)) continue

        for (const part of content) {
          const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
          if (call?.type !== 'toolCall' || typeof call.id !== 'string' || !call.id) continue
          if (toolResultIds.has(call.id)) continue

          const childSessionId = childSessionIdByToolCallId.get(call.id)
          if (!childSessionId) continue
          childSessionIdByToolCallId.delete(call.id)

          const toolName = typeof call.name === 'string' ? call.name : 'tool'
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: call.id,
              title: toolName,
              kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
              status: 'in_progress',
              rawInput: call.arguments ?? null,
              _meta: subagentSessionInfoMeta(childSessionId)
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)
        const isBash = isBashTool(toolName)
        const taskResult = readPiTaskToolResult(m)
        const taskRunKey = taskResult ? resolveTaskRunKey(taskResult.taskId, toolCallId) : undefined
        const pendingTaskSession = taskResult
          ? (taskSessionIds.get(taskRunKey!) ?? taskSessionIds.get(taskResult.taskId))
          : undefined
        const subagentSessionId = taskResult ? (taskResult.sessionId ?? pendingTaskSession) : undefined

        if (taskResult && taskRunKey && subagentSessionId) {
          session.rememberSubagentSession(subagentSessionId)
          taskToolCalls.delete(taskRunKey)
          taskSessionIds.delete(taskRunKey)
          linkedTaskCalls.add(taskRunKey)
          if (!taskResult.background) completedTaskRuns.add(taskRunKey)
        } else if (taskResult && taskRunKey) {
          taskToolCalls.set(taskRunKey, { toolCallId, status: isError ? 'failed' : 'completed' })
          if (!taskResult.background) completedTaskRuns.add(taskRunKey)
        }

        if (isBash) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'completed',
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, cwd)
            }
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          })
          continue
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
            status: 'completed',
            rawInput: null,
            rawOutput: m
          }
        })

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m,
            ...(subagentSessionId ? { _meta: subagentSessionInfoMeta(subagentSessionId) } : {})
          }
        })
        continue
      }

      if (role === 'bashExecution') {
        // A shell command the user ran directly (or over RPC bash). It is not a tool result, so it
        // has no toolCallId; replay it as a finished execute tool call to keep the transcript whole.
        const command = String(m?.command ?? '')
        const toolCallId = `bash-${replayedBashCount++}`
        const output = typeof m?.output === 'string' ? m.output : ''
        const failed = typeof m?.exitCode === 'number' && m.exitCode !== 0

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: command || 'bash',
            kind: 'execute',
            status: 'completed',
            rawInput: { command }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: failed ? 'failed' : 'completed',
            content: output ? [{ type: 'content', content: { type: 'text', text: output } }] : null,
            rawOutput: {
              output,
              exitCode: m?.exitCode ?? null,
              cancelled: Boolean(m?.cancelled),
              truncated: Boolean(m?.truncated)
            }
          }
        })
        continue
      }

      if (role === 'branchSummary' || role === 'compactionSummary') {
        // Context Pi inserted while summarizing a branch or compacting the transcript. The client
        // shows the replayed conversation, so without this the summary would silently disappear.
        const summary = typeof m?.summary === 'string' ? m.summary : ''
        if (!summary) continue

        const tokensBefore = Number(m?.tokensBefore)
        const detail = Number.isFinite(tokensBefore) ? ` (tokens before: ${tokensBefore})` : ''
        const label = role === 'branchSummary' ? 'Branch summary' : 'Compaction summary'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `${label}${detail}:\n\n${summary}` }
          }
        })
      }
    }
  }

  private async loadSessionInternal(
    params: LoadSessionRequest | ResumeSessionRequest,
    opts: { replay: boolean }
  ): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    this.lastSessionCwd = params.cwd

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Close the previous threads' processes before starting another one. The policy below
    // only runs at the end of a load, so staggered restores (a client restoring several
    // threads over a few seconds) would otherwise keep every finished load resident until
    // the next one completes.
    this.sessions.closeAllExcept(this.sessions.sessionLineageIds(params.sessionId))

    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? []
    })
    ;(this.sessions as any).touch?.(session.sessionId)
    const proc = session.proc
    const fileCommands = loadSlashCommands(params.cwd)

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile
    })

    if (opts.replay) {
      await this.replaySessionMessages(session, proc, params.cwd, stored.sessionFile)
    }

    // A finished subagent thread does not need a resident pi process: the client already has
    // the replayed transcript, and the next prompt or config change restores one. Keeping it
    // alive is what leaves a second `pi` process next to the parent's.
    this.sessions.releaseIdleSubagentSessions(session.sessionId)

    const keepSessionIds = this.sessions.sessionLineageIds(session.sessionId)
    this.sessions.closeAllExcept(keepSessionIds)

    const { configOptions, models, modes } = await getSessionConfiguration(proc)

    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        await session.publishContextUsage()

        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  /**
   * ACP `session/close`: cancel work in flight and release the session's pi subprocess.
   * Idempotent, and the session stays resumable (unlike `deleteSession`).
   */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | void> {
    // A restore may still be starting the process. Closing must not race past it and
    // leave an unowned subprocess behind.
    const restoring = this.restoringSessions.get(params.sessionId)
    if (restoring) {
      try {
        await restoring
      } catch {
        // The restore failed, so there is nothing to close.
      }
    }

    const session = this.sessions.maybeGet(params.sessionId)
    if (session) {
      try {
        await session.cancel()
      } catch {
        // Releasing the process matters more than a failed cancellation.
      }
    }

    for (const childId of this.sessions.subagentChildIds(params.sessionId)) {
      // A mid-turn child never settles its own `session/prompt`, so cancel before releasing.
      const child = this.sessions.maybeGet(childId)
      if (child) {
        try {
          await child.cancel()
        } catch {
          // Releasing the process matters more than a failed cancellation.
        }
      }
      this.sessions.close(childId)
    }
    this.sessions.close(params.sessionId)

    return {}
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // A running parent task owns the child transcript; deleting it would leave the task
    // appending to an unlinked file and strand the child session.
    this.prepareChildSession(params.sessionId)

    const stored = this.store.get(params.sessionId)
    const piSession = findPiSession(params.sessionId)

    // Per ACP session/delete semantics, deleting a session that does not
    // exist (or is already gone) should succeed idempotently.
    // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
    if (!stored && !piSession) {
      return {}
    }

    // Close any live pi subprocess first: deleting the transcript out from under a
    // running pi would leave it appending to an unlinked file.
    this.sessions.close(params.sessionId)

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // best-effort cleanup
      }
    }

    this.store.delete(params.sessionId)
    this.sessions.forgetSubagentSession(params.sessionId)

    return {}
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    return this.withSessionLease(params.sessionId, async () => {
      const session = await this.openSessionForWrite(params.sessionId)
      await setSessionModel(session.proc, params.modelId)
      await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
      await session.publishContextUsage()
    })
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return this.withSessionLease(params.sessionId, async () => {
      const session = await this.openSessionForWrite(params.sessionId)

      const mode = String(params.modeId)
      const availableLevels = await getAvailableThinkingLevels(session.proc)
      if (!availableLevels.includes(mode)) {
        throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
      }

      await session.proc.setThinkingLevel(mode)

      // Let the client know the current mode changed (keeps the dropdown in sync).
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: mode
        }
      })

      await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)

      return {}
    })
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.openSessionForWrite(params.sessionId)
    const configId = String(params.configId)
    let modelChanged = false

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`)
    }

    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value)
      modelChanged = true
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      const availableLevels = await getAvailableThinkingLevels(session.proc)
      if (!availableLevels.includes(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`)
      }

      await session.proc.setThinkingLevel(params.value)

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: params.value
        }
      })
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`)
    }

    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    // A different model can mean a different context window; refresh it immediately.
    if (modelChanged) await session.publishContextUsage()
    return { configOptions }
  }
}

const LEGACY_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

async function getAvailableThinkingLevels(proc: PiRpcProcess): Promise<string[]> {
  const levels = await proc.getAvailableThinkingLevels()
  if (levels === null) return LEGACY_THINKING_LEVELS
  return levels.length ? [...new Set(levels)] : ['off']
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  const levels = await getAvailableThinkingLevels(proc)
  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const requestedLevel = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  const currentModeId =
    requestedLevel && levels.includes(requestedLevel)
      ? requestedLevel
      : levels.includes('medium')
        ? 'medium'
        : (levels[0] ?? 'off')

  return {
    currentModeId,
    availableModes: levels.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  configOptions: SessionConfigOption[]
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}> {
  const [models, modes] = await Promise.all([getModelState(proc, pre), getThinkingState(proc, { state: pre?.state })])

  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

async function emitConfigOptionsUpdate(
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc)

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [candidateProvider, ...rest] = requestedModelId.split('/')
    provider = candidateProvider
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(installed: string | null): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  piVersion: string | null
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  if (opts.piVersion) {
    md.push(`pi v${opts.piVersion}`)
    md.push('---')
    md.push('')
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(process.env.HOME ?? '', '.pi', 'agent', 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(opts.cwd, '.pi', 'settings.json')]
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
      const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
      for (const pkg of pkgs) {
        const s = String(pkg)
        if (s.startsWith('npm:')) {
          extItems.push(`${s}\n  - index.ts`)
        } else {
          extItems.push(s)
        }
      }
    } catch {
      // ignore
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
