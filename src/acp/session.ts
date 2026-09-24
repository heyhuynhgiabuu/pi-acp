import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { readPiTaskSessionEvent, readPiTaskToolResult, subagentSessionInfoMeta } from './subagent-session.js'
import { maxResidentSessions } from './spawn-limiter.js'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  onThinkingLevelChanged?: (sessionId: string, proc: PiRpcProcess) => void
  supportsFormElicitation?: () => boolean
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type LinkedTaskResult = {
  childSessionId: string
  taskRunKey: string
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

const visibleCustomTextPartSchema = z.object({ type: z.literal('text'), text: z.string() })

const visibleCustomMessageSchema = z.object({
  role: z.literal('custom'),
  customType: z.string().optional(),
  display: z.literal(true),
  details: z.unknown().optional(),
  content: z.union([
    z.string(),
    z.array(z.unknown()).transform(parts =>
      parts
        .map(part => {
          const textPart = visibleCustomTextPartSchema.safeParse(part)
          return textPart.success ? textPart.data.text : ''
        })
        .join('')
    )
  ])
})

export function readVisibleCustomMessageText(value: unknown): string | null {
  const message = visibleCustomMessageSchema.safeParse(value)
  return message.success ? message.data.content : null
}

/**
 * Map pi's `stats.contextUsage` to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseToolCallInput(argumentsValue: unknown, partialArgs: unknown): unknown {
  if (typeof argumentsValue === 'object' && argumentsValue !== null) return argumentsValue
  if (typeof partialArgs !== 'string' || !partialArgs) return undefined

  try {
    return JSON.parse(partialArgs) as unknown
  } catch {
    return { partialArgs }
  }
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

/** A resumed task uses a new parent tool call and must complete independently. */
function taskLinkKey(taskId: string, piToolCallId?: string): string {
  return piToolCallId ? `${taskId}\u0000${piToolCallId}` : taskId
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()
  private readonly subagentParents = new Map<string, string>()
  private readonly activeSubagentRuns = new Map<string, Set<string>>()
  private readonly staleSubagentSessions = new Set<string>()
  // Sessions the client worked with, oldest first, so the cap can tell which to keep warm.
  private readonly recentlyUsed: string[] = []
  // Client requests currently working with a session, counted because requests can overlap.
  private readonly inFlightRequests = new Map<string, number>()
  private readonly maxResident = maxResidentSessions()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
    this.subagentParents.clear()
    this.activeSubagentRuns.clear()
    this.staleSubagentSessions.clear()
    this.inFlightRequests.clear()
    this.recentlyUsed.length = 0
  }

  /**
   * Mark a session as used by a client request. While a lease is held the session keeps its
   * pi process: evicting it would reject the request's own RPC with "pi process exited".
   * The returned release function is idempotent and must run when the request settles.
   */
  beginRequest(sessionId: string): () => void {
    this.inFlightRequests.set(sessionId, (this.inFlightRequests.get(sessionId) ?? 0) + 1)

    let released = false
    return () => {
      if (released) return
      released = true

      const remaining = (this.inFlightRequests.get(sessionId) ?? 1) - 1
      if (remaining > 0) this.inFlightRequests.set(sessionId, remaining)
      else this.inFlightRequests.delete(sessionId)
    }
  }

  private isInFlight(sessionId: string): boolean {
    return (this.inFlightRequests.get(sessionId) ?? 0) > 0
  }

  registerSubagentSession(parentSessionId: string, childSessionId: string): void {
    if (!parentSessionId || !childSessionId || parentSessionId === childSessionId) return
    this.subagentParents.set(childSessionId, parentSessionId)
  }

  isSubagentSession(sessionId: string): boolean {
    return this.subagentParents.has(sessionId)
  }

  markSubagentSessionActive(childSessionId: string, taskRunKey: string): void {
    if (!childSessionId || !taskRunKey) return
    const activeRuns = this.activeSubagentRuns.get(childSessionId) ?? new Set<string>()
    activeRuns.add(taskRunKey)
    this.activeSubagentRuns.set(childSessionId, activeRuns)
    this.staleSubagentSessions.delete(childSessionId)
  }

  markSubagentSessionCompleted(childSessionId: string, taskRunKey: string): void {
    const activeRuns = this.activeSubagentRuns.get(childSessionId)
    if (!activeRuns?.delete(taskRunKey) || activeRuns.size > 0) return
    this.activeSubagentRuns.delete(childSessionId)
    this.releaseOrMarkStale(childSessionId)
  }

  /**
   * Give a child session back to the client: free its viewer process when nothing is using
   * it, otherwise mark it stale so the next write recycles it before writing.
   */
  private releaseOrMarkStale(childSessionId: string): void {
    if (this.isInFlight(childSessionId) || !this.releaseIdleSession(childSessionId)) {
      this.staleSubagentSessions.add(childSessionId)
    }
  }

  /**
   * Mark `sessionId` as the one the client is working with and evict idle sessions beyond
   * the resident cap.
   */
  touch(sessionId: string): void {
    this.rememberRecentlyUsed(sessionId)
    this.trimResidentSessions()
  }

  /**
   * Keep at most `maxResident` processes: the most recently used sessions and their lineage
   * stay, everything else idle goes oldest-first. This is what stops a client that asks for
   * many sessions in one burst from holding one `pi` process per session. Sessions with an
   * in-flight request are never released.
   */
  trimResidentSessions(): string[] {
    if (this.sessions.size <= this.maxResident) return []

    const keep = new Set<string>()
    for (const id of this.recentlyUsed.slice(-this.maxResident)) {
      for (const lineageId of this.sessionLineageIds(id)) keep.add(lineageId)
    }

    const released: string[] = []
    for (const [id, session] of [...this.sessions]) {
      if (this.sessions.size <= this.maxResident) break
      if (keep.has(id)) continue
      if (this.isInFlight(id)) continue
      if (this.activeSubagentRuns.get(id)?.size) continue
      if (!session.isIdle()) continue
      if (this.releaseIdleSession(id)) released.push(id)
    }

    return released
  }

  /**
   * Free a session's pi process once nothing is using it. A viewer opened for a finished
   * task otherwise stays resident for as long as the client keeps that thread open, which is
   * what leaves a second `pi` process alongside the parent's.
   *
   * Explicit releases ignore leases: the caller (a finished task handing back a child thread,
   * or a load releasing a finished viewer) has decided the process is no longer needed. Only
   * the cap refuses to touch a session with an in-flight request.
   */
  releaseIdleSession(sessionId: string): boolean {
    if (this.activeSubagentRuns.get(sessionId)?.size) return false
    const session = this.sessions.get(sessionId)
    if (!session || !session.isIdle()) return false

    try {
      session.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
    this.forgetRecentlyUsed(sessionId)
    return true
  }

  private rememberRecentlyUsed(sessionId: string): void {
    this.forgetRecentlyUsed(sessionId)
    this.recentlyUsed.push(sessionId)
  }

  private forgetRecentlyUsed(sessionId: string): void {
    const index = this.recentlyUsed.indexOf(sessionId)
    if (index >= 0) this.recentlyUsed.splice(index, 1)
  }

  /**
   * Release the idle viewer processes reachable from `sessionId`: the session itself when it
   * is a finished subagent thread, plus every idle descendant. The session stays resumable,
   * so a later prompt or config change restores a fresh process.
   */
  releaseIdleSubagentSessions(sessionId: string): string[] {
    const released: string[] = []
    if (this.isSubagentSession(sessionId) && this.releaseIdleSession(sessionId)) {
      released.push(sessionId)
    }
    for (const childId of this.subagentChildIds(sessionId)) {
      if (this.releaseIdleSession(childId)) released.push(childId)
    }
    return released
  }

  /**
   * Reject any write to a child session that a running parent task still owns: two pi
   * processes appending to the same session file would fork the transcript. Covers every
   * mutator (prompt, model, thinking level, config option, delete), not just prompts.
   */
  assertSessionMutable(sessionId: string): void {
    if (!this.activeSubagentRuns.get(sessionId)?.size) return
    throw RequestError.invalidParams(
      { sessionId },
      `Session ${sessionId} is read-only while its parent task is running. Wait for the task to finish.`
    )
  }

  /**
   * A dead pi process can never emit the task completion that would release its child
   * sessions, so clear their active runs here. Without this a child stays read-only until
   * the parent thread is closed or the agent restarts.
   */
  private releaseDescendantsOf(sessionId: string): void {
    for (const childId of this.subagentChildIds(sessionId)) {
      if (this.activeSubagentRuns.delete(childId)) this.releaseOrMarkStale(childId)
    }
  }

  /**
   * Drop a child process opened during a finished task so the next write starts fresh from
   * the completed session file. Returns whether a live process was actually released.
   *
   * The stale mark survives when nothing is registered yet: a restore that straddles the
   * task completion registers a process opened before those writes, and the caller's
   * post-restore check must still be able to recycle it.
   */
  recycleStaleSubagentSession(sessionId: string): boolean {
    if (!this.staleSubagentSessions.delete(sessionId)) return false
    const session = this.sessions.get(sessionId)
    if (!session) return false

    try {
      session.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
    return true
  }

  subagentChildIds(parentSessionId: string): string[] {
    const children: string[] = []
    const seen = new Set([parentSessionId])
    const queue = [parentSessionId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const [childId, parentId] of this.subagentParents) {
        if (parentId !== current || seen.has(childId)) continue
        seen.add(childId)
        children.push(childId)
        queue.push(childId)
      }
    }
    return children
  }

  forgetSubagentSession(sessionId: string): void {
    for (const [childId, parentId] of this.subagentParents) {
      if (childId === sessionId || parentId === sessionId) this.subagentParents.delete(childId)
    }
    this.activeSubagentRuns.delete(sessionId)
    this.staleSubagentSessions.delete(sessionId)
  }

  sessionLineageIds(sessionId: string): Set<string> {
    const lineage = new Set<string>()
    let current: string | undefined = sessionId
    while (current && !lineage.has(current)) {
      lineage.add(current)
      current = this.subagentParents.get(current)
    }
    return lineage
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    this.releaseDescendantsOf(sessionId)

    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
    this.forgetRecentlyUsed(sessionId)
  }

  /** Close all sessions except the requested ids (or their linked parent chains). */
  closeAllExcept(keepSessionIds: string | Iterable<string>): void {
    const keep = typeof keepSessionIds === 'string' ? new Set([keepSessionIds]) : new Set(keepSessionIds)
    for (const [id] of this.sessions) {
      if (keep.has(id) || this.isInFlight(id)) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      onSubagentSession: childSessionId => this.registerSubagentSession(sessionId, childSessionId),
      onSubagentTaskActive: (childSessionId, taskRunKey) => this.markSubagentSessionActive(childSessionId, taskRunKey),
      onSubagentTaskCompleted: (childSessionId, taskRunKey) =>
        this.markSubagentSessionCompleted(childSessionId, taskRunKey),
      onThinkingLevelChanged: params.onThinkingLevelChanged,
      supportsFormElicitation: params.supportsFormElicitation
    })

    this.sessions.set(sessionId, session)
    proc.onExit?.(() => this.releaseDescendantsOf(sessionId))
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      onSubagentSession: childSessionId => this.registerSubagentSession(sessionId, childSessionId),
      onSubagentTaskActive: (childSessionId, taskRunKey) => this.markSubagentSessionActive(childSessionId, taskRunKey),
      onSubagentTaskCompleted: (childSessionId, taskRunKey) =>
        this.markSubagentSessionCompleted(childSessionId, taskRunKey),
      onThinkingLevelChanged: params.onThinkingLevelChanged,
      supportsFormElicitation: params.supportsFormElicitation
    })

    this.sessions.set(sessionId, session)
    params.proc.onExit?.(() => this.releaseDescendantsOf(sessionId))
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private streamedToolCalls = new Map<number, { id: string; name: string; partialArgs: string }>()
  private readonly onSubagentSession?: (sessionId: string) => void
  private readonly onSubagentTaskActive?: (childSessionId: string, taskRunKey: string) => void
  private readonly onSubagentTaskCompleted?: (childSessionId: string, taskRunKey: string) => void
  private readonly onThinkingLevelChanged?: (sessionId: string, proc: PiRpcProcess) => void
  private readonly supportsFormElicitation?: () => boolean
  private readonly taskToolCalls = new Map<string, { toolCallId: string; status: 'completed' | 'failed' }>()
  private readonly taskSessionIds = new Map<string, string>()
  private readonly taskChildSessionIds = new Map<string, string>()
  private readonly completedTaskIds = new Set<string>()
  private readonly linkedTaskCalls = new Set<string>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    onSubagentSession?: (sessionId: string) => void
    onSubagentTaskActive?: (childSessionId: string, taskRunKey: string) => void
    onSubagentTaskCompleted?: (childSessionId: string, taskRunKey: string) => void
    onThinkingLevelChanged?: (sessionId: string, proc: PiRpcProcess) => void
    supportsFormElicitation?: () => boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.onSubagentSession = opts.onSubagentSession
    this.onSubagentTaskActive = opts.onSubagentTaskActive
    this.onSubagentTaskCompleted = opts.onSubagentTaskCompleted
    this.onThinkingLevelChanged = opts.onThinkingLevelChanged
    this.supportsFormElicitation = opts.supportsFormElicitation

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /** True when no turn is running or queued, so the process can be released and restored. */
  isIdle(): boolean {
    return this.pendingTurn === null
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage(): Promise<void> {
    try {
      // Older/stubbed pi processes may not expose the stats RPC at all.
      if (typeof this.proc.getSessionStats === 'function') {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS))
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; never fail or delay the turn because of it.
    }

    await this.flushEmits()
  }

  private async settleTurn(): Promise<void> {
    // Ensure all updates derived from pi events (plus the final usage update) are
    // delivered before we resolve the ACP `session/prompt` request.
    await this.publishContextUsage()

    const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
    this.pendingTurn?.resolve(reason)
    this.pendingTurn = null
    this.inAgentLoop = false

    // Start next queued prompt, if any.
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  rememberSubagentSession(sessionId: string): void {
    if (sessionId.trim()) this.onSubagentSession?.(sessionId)
  }

  private findTaskRunKey(taskId: string, piToolCallId?: string): string {
    if (piToolCallId) return taskLinkKey(taskId, piToolCallId)

    const prefix = `${taskId}\u0000`
    const candidates = new Set<string>()
    for (const key of [
      ...this.taskToolCalls.keys(),
      ...this.taskSessionIds.keys(),
      ...this.taskChildSessionIds.keys(),
      ...this.completedTaskIds,
      ...this.linkedTaskCalls
    ]) {
      if (key.startsWith(prefix)) candidates.add(key)
    }
    return candidates.size === 1 ? [...candidates][0]! : taskId
  }

  private linkTaskSession(taskId: string, sessionId: string, piToolCallId?: string, liveLink = false): string {
    const key = this.findTaskRunKey(taskId, piToolCallId)
    this.rememberSubagentSession(sessionId)
    this.taskChildSessionIds.set(key, sessionId)
    if (liveLink && !this.completedTaskIds.has(key)) this.onSubagentTaskActive?.(sessionId, key)
    if (this.linkedTaskCalls.has(key)) return key

    if (piToolCallId && this.currentToolCalls.has(piToolCallId)) {
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: piToolCallId,
        status: this.currentToolCalls.get(piToolCallId),
        _meta: subagentSessionInfoMeta(sessionId)
      })
      this.taskToolCalls.delete(key)
      this.taskSessionIds.delete(key)
      this.linkedTaskCalls.add(key)
      return key
    }

    const toolCall = this.taskToolCalls.get(key)
    if (!toolCall) {
      this.taskSessionIds.set(key, sessionId)
      return key
    }

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      status: toolCall.status,
      _meta: subagentSessionInfoMeta(sessionId)
    })
    this.taskToolCalls.delete(key)
    this.taskSessionIds.delete(key)
    this.linkedTaskCalls.add(key)
    return key
  }

  private handleTaskToolResult(
    taskId: string,
    toolCallId: string,
    status: 'completed' | 'failed',
    sessionId: string | undefined,
    background: boolean
  ): LinkedTaskResult | undefined {
    const exactKey = taskLinkKey(taskId, toolCallId)
    const legacyKey = this.taskSessionIds.has(taskId) || this.taskChildSessionIds.has(taskId) ? taskId : exactKey
    const taskRunKey =
      this.taskSessionIds.has(exactKey) || this.taskChildSessionIds.has(exactKey) ? exactKey : legacyKey
    const knownSessionId = this.taskSessionIds.get(taskRunKey) ?? this.taskChildSessionIds.get(taskRunKey)
    const childSessionId = sessionId ?? knownSessionId

    if (childSessionId) {
      if (knownSessionId !== childSessionId) this.rememberSubagentSession(childSessionId)
      this.taskChildSessionIds.set(taskRunKey, childSessionId)
      this.taskToolCalls.delete(taskRunKey)
      this.taskSessionIds.delete(taskRunKey)
      this.linkedTaskCalls.add(taskRunKey)
      if (!background) this.completedTaskIds.add(taskRunKey)
      return { childSessionId, taskRunKey }
    }

    if (!background) this.completedTaskIds.add(taskRunKey)
    this.taskToolCalls.set(taskRunKey, { toolCallId, status })
    return undefined
  }

  private handlePiTaskSessionEvent(
    event: NonNullable<ReturnType<typeof readPiTaskSessionEvent>>,
    liveLink = false
  ): void {
    if (event.kind === 'task-session' && event.sessionId) {
      this.linkTaskSession(event.taskId, event.sessionId, event.piToolCallId, liveLink)
      return
    }

    const taskRunKey = this.findTaskRunKey(event.taskId, event.piToolCallId)
    if (event.sessionId && !this.taskChildSessionIds.has(taskRunKey)) {
      this.linkTaskSession(event.taskId, event.sessionId, event.piToolCallId)
    }
    if (event.kind !== 'task-complete') return

    this.completedTaskIds.add(taskRunKey)
    const childSessionId = event.sessionId ?? this.taskChildSessionIds.get(taskRunKey)
    if (childSessionId) this.onSubagentTaskCompleted?.(childSessionId, taskRunKey)
    this.taskToolCalls.delete(taskRunKey)
    this.taskSessionIds.delete(taskRunKey)
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'entry_appended': {
        const taskEntry = readPiTaskSessionEvent(ev.entry)
        if (taskEntry) this.handlePiTaskSessionEvent(taskEntry, taskEntry.kind === 'task-session')
        break
      }

      case 'message_end': {
        const taskEvent = readPiTaskSessionEvent(ev.message)
        if (taskEvent) this.handlePiTaskSessionEvent(taskEvent)

        const visibleText = readVisibleCustomMessageText(ev.message)
        if (!visibleText) break

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: visibleText } satisfies ContentBlock
        })
        break
      }

      case 'message_update': {
        const event = asRecord(ev.assistantMessageEvent)
        if (!event) break

        // Stream assistant text.
        if (event.type === 'text_delta' && typeof event.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: event.delta } satisfies ContentBlock
          })
          break
        }

        if (event.type === 'thinking_delta' && typeof event.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.delta } satisfies ContentBlock
          })
          break
        }

        if (event.type !== 'toolcall_start' && event.type !== 'toolcall_delta' && event.type !== 'toolcall_end') {
          break
        }

        const contentIndex =
          typeof event.contentIndex === 'number' && Number.isSafeInteger(event.contentIndex)
            ? event.contentIndex
            : undefined
        const partialMessage = asRecord(event.partial)
        const partialContent = Array.isArray(partialMessage?.content) ? partialMessage.content : []
        let toolCall = asRecord(event.toolCall) ?? asRecord(partialContent[contentIndex ?? 0])
        let streamed = contentIndex === undefined ? undefined : this.streamedToolCalls.get(contentIndex)

        if (event.type === 'toolcall_start') {
          const id = typeof event.id === 'string' ? event.id : toolCall?.id
          const name = typeof event.toolName === 'string' ? event.toolName : toolCall?.name
          if (typeof id === 'string' && typeof name === 'string') {
            streamed = { id, name, partialArgs: '' }
            if (contentIndex !== undefined) this.streamedToolCalls.set(contentIndex, streamed)
            toolCall ??= { id, name }
          }
        } else if (event.type === 'toolcall_delta' && streamed && typeof event.delta === 'string') {
          streamed.partialArgs += event.delta
          toolCall = { id: streamed.id, name: streamed.name, partialArgs: streamed.partialArgs }
        } else if (event.type === 'toolcall_end') {
          if (!toolCall && streamed) {
            toolCall = { id: streamed.id, name: streamed.name, partialArgs: streamed.partialArgs }
          }
          if (contentIndex !== undefined) this.streamedToolCalls.delete(contentIndex)
        }

        const toolCallId = typeof toolCall?.id === 'string' ? toolCall.id : (streamed?.id ?? '')
        const toolName = typeof toolCall?.name === 'string' ? toolCall.name : (streamed?.name ?? 'tool')

        if (toolCallId) {
          const rawInput = parseToolCallInput(toolCall?.arguments, toolCall?.partialArgs)
          const locations = toToolCallLocations(rawInput, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
          const status = existingStatus ?? 'pending'

          if (isBashTool(toolName)) {
            if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
            this.emitBashToolCall({
              sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
              toolCallId,
              toolName,
              args: rawInput,
              status,
              locations,
              includeTerminal: !existingStatus
            })
          } else if (!existingStatus) {
            this.currentToolCalls.set(toolCallId, 'pending')
            this.emit({
              sessionUpdate: 'tool_call',
              toolCallId,
              title: toolName,
              kind: toToolKind(toolName),
              status,
              locations,
              rawInput
            })
          } else {
            // Best-effort: keep rawInput updated while args are streaming.
            // Keep the existing status (pending or in_progress).
            this.emit({
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status,
              locations,
              rawInput
            })
          }
        }

        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const taskResult = readPiTaskToolResult(result)
        const taskLink = taskResult
          ? this.handleTaskToolResult(
              taskResult.taskId,
              toolCallId,
              isError ? 'failed' : 'completed',
              taskResult.sessionId,
              taskResult.background
            )
          : undefined
        const subagentSessionId = taskLink?.childSessionId
        if (taskLink && taskResult && !taskResult.background) {
          this.onSubagentTaskCompleted?.(taskLink.childSessionId, taskLink.taskRunKey)
        }
        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result }),
          ...(subagentSessionId ? { _meta: subagentSessionInfoMeta(subagentSessionId) } : {})
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'summarization_retry_scheduled': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatSummarizationRetry(ev) } satisfies ContentBlock
        })
        break
      }

      case 'summarization_retry_finished': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Summarization retry finished.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start':
      case 'compaction_start': {
        // pi renamed these from `auto_compaction_*`; keep both shapes. A manual compaction is
        // already reported by the /compact command response, so only automatic ones get a notice.
        if (stringProp(ev, 'reason') === 'manual') break

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text:
              stringProp(ev, 'reason') === 'overflow'
                ? 'Context exceeded the model window, compacting before retrying...'
                : 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end':
      case 'compaction_end': {
        if (stringProp(ev, 'reason') === 'manual') break

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatCompactionEnd(ev) } satisfies ContentBlock
        })
        break
      }

      case 'session_info_changed': {
        // The name can change outside /name (pi's own UI or an extension), so keep the client's
        // thread title in sync instead of only updating it when the command runs.
        this.emit({ sessionUpdate: 'session_info_update', title: stringProp(ev, 'name') })
        break
      }

      case 'thinking_level_changed': {
        const level = stringProp(ev, 'level')
        if (!level) break

        this.emit({ sessionUpdate: 'current_mode_update', currentModeId: level })
        this.onThinkingLevelChanged?.(this.sessionId, this.proc)
        break
      }

      case 'extension_error': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatExtensionError(ev) } satisfies ContentBlock,
          _meta: { piAcp: { notify: { level: 'warning' } } }
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        void this.settleTurn()
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      await this.handleExtensionTextInput(ev, id, method)
      return
    }

    if (method === 'notify') {
      const level = ev.notifyType === 'warning' || ev.notifyType === 'error' ? ev.notifyType : 'info'
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: formatExtensionNotification(stringProp(ev, 'message') ?? 'Pi notification')
        } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level } } }
      })
      return
    }

    if (method === 'setTitle') {
      const title = stringProp(ev, 'title')
      if (title !== null) this.emit({ sessionUpdate: 'session_info_update', title })
      return
    }

    // Pi status, widget, and draft-editor methods are fire-and-forget. ACP has no
    // equivalent Zed surface for them, so ignore them without replying to Pi.
    if (method === 'setStatus' || method === 'setWidget' || method === 'set_editor_text') return

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  /**
   * Pi asks for free-form text. ACP expresses that as an elicitation form, but the capability is
   * marked UNSTABLE in the pinned SDK, so it is only used when the client advertised form support.
   */
  private async handleExtensionTextInput(ev: PiRpcEvent, id: string, method: string): Promise<void> {
    if (!this.supportsFormElicitation?.()) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} request needs a client that supports ACP elicitation; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const title = stringProp(ev, 'title') ?? (method === 'editor' ? 'Edit text' : 'Enter a value')
    const placeholder = stringProp(ev, 'placeholder')
    const prefill = stringProp(ev, 'prefill')

    const response = (await this.conn.unstable_createElicitation({
      sessionId: this.sessionId,
      mode: 'form',
      message: title,
      requestedSchema: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            title,
            ...(placeholder ? { description: placeholder } : {}),
            ...(prefill ? { default: prefill } : {})
          }
        },
        required: ['value']
      }
    } as any)) as any

    const content = response?.action === 'accept' ? response.content : null
    const value = typeof content?.value === 'string' ? content.value : null
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function formatExtensionNotification(message: string): string {
  const quotedMessage = message
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> _${line}_`)
    .join('\n')
  return `\n\n${quotedMessage}\n\n`
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatCompactionEnd(ev: PiRpcEvent): string {
  if (ev.aborted === true) return 'Compaction was aborted.'

  const errorMessage = stringProp(ev, 'errorMessage')
  if (errorMessage) return `Compaction failed: ${errorMessage}`

  const result = asRecord(ev.result)
  const summary = stringProp(result ?? {}, 'summary')
  const tokensBefore = Number(result?.tokensBefore)
  const estimatedAfter = Number(result?.estimatedTokensAfter)

  const detail = [
    Number.isFinite(tokensBefore) ? `tokens before: ${tokensBefore}` : null,
    Number.isFinite(estimatedAfter) ? `after: ~${estimatedAfter}` : null
  ]
    .filter(Boolean)
    .join(', ')

  const base = summary
    ? `Compaction finished: ${summary}`
    : 'Automatic compaction finished; context was summarized to continue the session.'
  return detail ? `${base} (${detail})` : base
}

function formatExtensionError(ev: PiRpcEvent): string {
  const path = stringProp(ev, 'extensionPath')
  const name = path ? (path.split('/').at(-1) ?? path) : 'extension'
  const handler = stringProp(ev, 'event')
  const error = stringProp(ev, 'error') ?? 'unknown error'

  return `Extension error in ${name}${handler ? ` (${handler})` : ''}: ${error}`
}

function formatSummarizationRetry(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)
  const source = stringProp(ev, 'source') === 'branchSummary' ? 'branch summary' : 'context summarization'

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return `Retrying ${source}...`
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying ${source} (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
