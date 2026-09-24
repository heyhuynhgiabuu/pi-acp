import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024
// Lines are parsed one by one only for candidate entries found by substring search. The budgets
// keep a pathological file (no matching entry at all) from turning into a full-file scan.
const MAX_CANDIDATE_PARSES = 64

/**
 * Results are cached per file and reused while size and mtime stay the same. Listing a few hundred
 * sessions otherwise re-reads and re-parses every transcript on every call.
 */
type SessionFileInfo = { sessionId: string; cwd: string; title: string | null; updatedAt: string | null }
const fileInfoCache = new Map<string, { size: number; mtimeMs: number; info: SessionFileInfo | null }>()

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readHead(path: string, bytes = DEFAULT_HEAD_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return ''
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function firstLineOf(head: string): string | null {
  if (!head) return null
  const idx = head.indexOf('\n')
  return (idx === -1 ? head : head.slice(0, idx)).trim() || null
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

/**
 * Parse the JSONL line containing `index` and return its object, or null when the line does not
 * parse (a truncated read or a partial line at a chunk boundary).
 */
function parseLineAt(text: string, index: number): any | null {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  const line = text.slice(start, end === -1 ? undefined : end).trim()
  if (!line) return null

  try {
    return JSON.parse(line) as any
  } catch {
    return null
  }
}

/**
 * Find the last entry of `type` in a transcript window. The window is searched backwards by
 * substring, and only the candidate lines are parsed: splitting and parsing every line of a 256KB
 * tail costs milliseconds per session, which adds up to seconds across a large session directory.
 */
function findLastEntry(text: string, type: string): any | null {
  const needle = `"${type}"`
  let index = text.length

  for (let attempt = 0; attempt < MAX_CANDIDATE_PARSES; attempt += 1) {
    index = text.lastIndexOf(needle, index - 1)
    if (index === -1) return null

    const obj = parseLineAt(text, index)
    if (obj?.type === type) return obj
  }

  return null
}

function pickTitleFromTail(tail: string): string | null {
  const entry = findLastEntry(tail, 'session_info')
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  return name || null
}

/**
 * Name set before the session grew past the tail window. pi writes the name as a `session_info`
 * entry, so only the head window needs checking; scanning whole multi-megabyte transcripts to find
 * nothing is what made listing sessions take a minute on a large session directory.
 */
function pickTitleFromHead(head: string): string | null {
  return pickTitleFromTail(head)
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  const message = findLastEntry(tail, 'message')
  const messageAt = toIsoTimestamp(message?.timestamp)
  if (messageAt) return messageAt

  // Fallback: the most recent entry that carries any timestamp.
  const needle = '"timestamp"'
  let index = tail.length

  for (let attempt = 0; attempt < MAX_CANDIDATE_PARSES; attempt += 1) {
    index = tail.lastIndexOf(needle, index - 1)
    if (index === -1) return null

    const at = toIsoTimestamp(parseLineAt(tail, index)?.timestamp)
    if (at) return at
  }

  return null
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function pickFallbackTitleFromHead(head: string): string | null {
  // Fallback to first user message. The head window is bounded, so this cannot read a whole file.
  let lines = 0

  for (const line0 of head.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line) continue

    lines += 1
    if (lines > 2000) break

    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'message' && obj?.message?.role === 'user') {
        const content = obj?.message?.content
        if (typeof content === 'string') return content.slice(0, 80)
        if (Array.isArray(content)) {
          const t = content.find((c: any) => c?.type === 'text' && typeof c?.text === 'string')
          if (t?.text) return String(t.text).slice(0, 80)
        }
      }
    } catch {
      // ignore
    }
  }

  return null
}

/** Read and cache one transcript's header, title and updatedAt. Returns null for non-session files. */
function readSessionFileInfo(file: string): SessionFileInfo | null {
  let size = 0
  let mtimeMs = 0
  try {
    const stat = statSync(file)
    size = stat.size
    mtimeMs = stat.mtimeMs
  } catch {
    return null
  }

  const cached = fileInfoCache.get(file)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.info

  let info: SessionFileInfo | null = null
  const head = readHead(file)
  const header = parseSessionHeader(firstLineOf(head) ?? '')

  if (header) {
    let title: string | null = null
    let updatedAt: string | null = null

    try {
      const tail = readTail(file)
      title = pickTitleFromTail(tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    // A name set before the session grew past the tail window still lives in the head.
    if (!title) title = pickTitleFromHead(head)

    // Fallback for updatedAt when we could not parse timestamps from the tail.
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    if (!title) title = pickFallbackTitleFromHead(head)

    info = { sessionId: header.sessionId, cwd: header.cwd, title, updatedAt }
  }

  fileInfoCache.set(file, { size, mtimeMs, info })
  return info
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  // Drop cached entries for transcripts that are gone, so a long-lived adapter cannot grow the
  // cache without bound.
  if (fileInfoCache.size > files.length) {
    const present = new Set(files)
    for (const cachedPath of fileInfoCache.keys()) {
      if (!present.has(cachedPath)) fileInfoCache.delete(cachedPath)
    }
  }

  const items: PiSessionListItem[] = []

  for (const file of files) {
    const info = readSessionFileInfo(file)
    if (!info) continue

    items.push({
      sessionId: info.sessionId,
      cwd: info.cwd,
      title: info.title,
      updatedAt: info.updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  if (!sessionId) return null

  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  // pi names transcript files after the session id, so the matching file is usually found by name
  // without reading any other transcript. Resolving one session used to list every session first.
  const byName = files.filter(file => file.includes(sessionId))

  for (const file of [...byName, ...files]) {
    const info = readSessionFileInfo(file)
    if (info?.sessionId !== sessionId) continue

    return {
      sessionId: info.sessionId,
      cwd: info.cwd,
      title: info.title,
      updatedAt: info.updatedAt,
      sessionFile: file
    }
  }

  return null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}
