import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

type RecordValue = Record<string, unknown>

export type PiTaskSessionEvent = {
  taskId: string
  sessionId?: string
  /** The parent Pi tool-call id, when pi-task could resolve it. */
  piToolCallId?: string
  kind: 'task-session' | 'task-complete'
}

export type PiTaskToolResult = {
  taskId: string
  sessionId?: string
  background: boolean
}

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

type PiTaskEventKind = PiTaskSessionEvent['kind']

function buildTaskEvent(kind: PiTaskEventKind, details: RecordValue | null): PiTaskSessionEvent | null {
  const taskId = nonEmptyString(details?.task_id)
  if (!taskId) return null

  const sessionId = nonEmptyString(details?.session_id)
  // A link without a child session has nothing to link.
  if (kind === 'task-session' && !sessionId) return null

  const piToolCallId = nonEmptyString(details?.pi_tool_call_id)

  return {
    taskId,
    ...(sessionId ? { sessionId } : {}),
    ...(piToolCallId ? { piToolCallId } : {}),
    kind
  }
}

function isTaskEventKind(value: unknown): value is PiTaskEventKind {
  return value === 'task-session' || value === 'task-complete'
}

/**
 * Read a pi-task session link from either channel:
 * - a session entry (`entry_appended`), which pi emits immediately, so the link lands
 *   while the task is still running; and
 * - a hidden custom message, which is what history replay sees after a reload.
 */
export function readPiTaskSessionEvent(value: unknown): PiTaskSessionEvent | null {
  const record = asRecord(value)
  if (!record) return null

  if (record.type === 'custom') {
    if (!isTaskEventKind(record.customType)) return null
    return buildTaskEvent(record.customType, asRecord(record.data))
  }

  if (record.role !== 'custom') return null
  if (!isTaskEventKind(record.customType)) return null

  const details = asRecord(record.details)
  // The durable link must stay hidden.
  if (record.customType === 'task-session' && record.display !== false) return null

  return buildTaskEvent(record.customType, details)
}

export function readPiTaskToolResult(value: unknown): PiTaskToolResult | null {
  const result = asRecord(value)
  const details = asRecord(result?.details)
  const taskId = nonEmptyString(details?.task_id)
  if (!taskId || details?.backend !== 'sdk') return null

  const sessionId = nonEmptyString(details?.session_id)
  return {
    taskId,
    ...(sessionId ? { sessionId } : {}),
    background: details?.background === true
  }
}

/** pi's session JSONL is line-oriented; a chunk boundary can split a line in half. */
const SESSION_SCAN_CHUNK_BYTES = 256 * 1024

function collectTaskSessionEvent(line: string, out: PiTaskSessionEvent[]): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // A partially written or malformed line must never break replay.
    return
  }

  const event = readPiTaskSessionEvent(parsed)
  if (event) out.push(event)
}

/**
 * Recover durable pi-task links from a parent session JSONL file.
 *
 * pi-task records links as `{type:"custom", customType:"task-session"}` session entries,
 * which are deliberately kept outside the model context and therefore absent from
 * `get_messages`. Reading the session file directly is the only way to replay them.
 *
 * Reads are asynchronous: this runs inside `session/load`, and a large transcript must not
 * block the ACP event loop.
 */
export async function readPiTaskSessionEventsFromSessionFile(sessionFile: string): Promise<PiTaskSessionEvent[]> {
  const events: PiTaskSessionEvent[] = []
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(sessionFile, 'r')
    const decoder = new StringDecoder('utf8')
    const chunk = Buffer.alloc(SESSION_SCAN_CHUNK_BYTES)
    let pending = ''

    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead <= 0) break

      const lines = (pending + decoder.write(chunk.subarray(0, bytesRead))).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) collectTaskSessionEvent(line, events)
    }

    pending += decoder.end()
    if (pending) collectTaskSessionEvent(pending, events)
  } catch {
    // A missing or unreadable session file simply has no durable links to recover.
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore
      }
    }
  }

  return events
}

export function subagentSessionInfoMeta(sessionId: string) {
  return {
    subagent_session_info: {
      session_id: sessionId,
      message_start_index: 0
    }
  } as const
}
