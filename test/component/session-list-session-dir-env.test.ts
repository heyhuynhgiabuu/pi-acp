import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { getPiSessionsDir, listPiSessions } from '../../src/acp/pi-sessions.js'

function sessionFile(dir: string, sessionId: string) {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'hi' }
    })
  ].join('\n')
}

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('getPiSessionsDir: PI_CODING_AGENT_SESSION_DIR overrides the settings value', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-sessiondir-'))
  const fromSettings = join(root, 'from-settings')
  const fromEnv = join(root, 'from-env')
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: fromSettings }), 'utf8')

  withEnv({ PI_CODING_AGENT_DIR: root }, () => {
    withEnv({ PI_CODING_AGENT_SESSION_DIR: undefined }, () => {
      assert.equal(getPiSessionsDir(), fromSettings)
    })

    // pi precedence: --session-dir > env > settings.json.
    withEnv({ PI_CODING_AGENT_SESSION_DIR: fromEnv }, () => {
      assert.equal(getPiSessionsDir(), fromEnv)
    })
  })
})

test('getPiSessionsDir: expands a leading tilde like pi does', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-sessiondir-tilde-'))
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: '~/pi-acp-tilde-sessions' }), 'utf8')

  withEnv({ PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: undefined }, () => {
    assert.equal(getPiSessionsDir(), join(homedir(), 'pi-acp-tilde-sessions'))
  })

  withEnv({ PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: '~' }, () => {
    assert.equal(getPiSessionsDir(), homedir())
  })
})

test('listPiSessions: reads transcripts from the directory pi was pointed at', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-sessiondir-list-'))
  const customDir = join(root, 'custom-sessions')
  mkdirSync(customDir, { recursive: true })
  writeFileSync(join(customDir, 's.jsonl'), sessionFile(customDir, 'sess-env') + '\n', 'utf8')

  withEnv({ PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: customDir }, () => {
    const found = listPiSessions().find(session => session.sessionId === 'sess-env')
    assert.equal(found?.sessionFile, join(customDir, 's.jsonl'))
  })
})
