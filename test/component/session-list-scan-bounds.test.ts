import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findPiSession, listPiSessions } from '../../src/acp/pi-sessions.js'

const HEADER = JSON.stringify({
  type: 'session',
  version: 3,
  id: 'sess-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd: '/tmp/project'
})

function messageLine(id: string, role: 'user' | 'assistant', text: string) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role, content: text }
  })
}

function sessionInfoLine(name: string) {
  return JSON.stringify({
    type: 'session_info',
    id: 'i1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    name
  })
}

/** Filler big enough that a line placed after it is outside both the head and the tail window. */
function filler(count: number) {
  return Array.from({ length: count }, (_, index) => messageLine(`f${index}`, 'assistant', 'x'.repeat(2000))).join('\n')
}

function withSessionsDir(run: (sessionsDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-scan-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    run(sessionsDir)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

test('listPiSessions: a name in the middle of a huge transcript does not force a full-file scan', () => {
  withSessionsDir(sessionsDir => {
    const sessionFile = join(sessionsDir, 's.jsonl')
    const body = [
      HEADER,
      messageLine('m1', 'user', 'First user question'),
      filler(400),
      // Outside the 64KB head window and more than 256KB from the end: only an unbounded scan
      // would find this name, and that scan is what made listing sessions take a minute.
      sessionInfoLine('Named In The Middle'),
      filler(400)
    ].join('\n')

    writeFileSync(sessionFile, body + '\n', { encoding: 'utf8' })

    const session = listPiSessions().find(item => item.sessionId === 'sess-1')
    assert.ok(session)
    assert.notEqual(session?.title, 'Named In The Middle')
    assert.equal(session?.title, 'First user question')
  })
})

test('listPiSessions: falls back to the first user message in a long session', () => {
  withSessionsDir(sessionsDir => {
    const sessionFile = join(sessionsDir, 's.jsonl')
    const lines = [
      HEADER,
      messageLine('m1', 'user', 'What does this repo do?'),
      // More than 2000 lines total: the fallback must stop after parsing its own budget, not skip
      // the file because the file as a whole is long.
      ...Array.from({ length: 3000 }, (_, index) => messageLine(`f${index}`, 'assistant', 'y'.repeat(40)))
    ]

    writeFileSync(sessionFile, lines.join('\n') + '\n', { encoding: 'utf8' })

    const session = listPiSessions().find(item => item.sessionId === 'sess-1')
    assert.equal(session?.title, 'What does this repo do?')
  })
})

test('listPiSessions: picks up a name added after the file was already listed', () => {
  withSessionsDir(sessionsDir => {
    const sessionFile = join(sessionsDir, 's.jsonl')
    writeFileSync(sessionFile, [HEADER, messageLine('m1', 'user', 'hello')].join('\n') + '\n', { encoding: 'utf8' })

    assert.equal(listPiSessions().find(item => item.sessionId === 'sess-1')?.title, 'hello')

    appendFileSync(sessionFile, sessionInfoLine('Renamed later') + '\n', { encoding: 'utf8' })

    assert.equal(listPiSessions().find(item => item.sessionId === 'sess-1')?.title, 'Renamed later')
  })
})

test('findPiSession: resolves one session without listing every transcript', () => {
  withSessionsDir(sessionsDir => {
    const named = join(sessionsDir, '2026-01-01T00-00-00-000Z_sess-1.jsonl')
    const unnamed = join(sessionsDir, 'weird-name.jsonl')
    writeFileSync(named, [HEADER, sessionInfoLine('Named')].join('\n') + '\n', { encoding: 'utf8' })
    writeFileSync(unnamed, JSON.stringify({ ...JSON.parse(HEADER), id: 'sess-2', cwd: '/tmp/other' }) + '\n', {
      encoding: 'utf8'
    })

    const byName = findPiSession('sess-1')
    assert.equal(byName?.sessionFile, named)
    assert.equal(byName?.cwd, '/tmp/project')
    assert.equal(byName?.title, 'Named')

    // pi names transcripts after the session id, but the header stays authoritative.
    const byHeader = findPiSession('sess-2')
    assert.equal(byHeader?.sessionFile, unnamed)
    assert.equal(byHeader?.cwd, '/tmp/other')

    assert.equal(findPiSession('does-not-exist'), null)
    assert.equal(findPiSession(''), null)
  })
})
