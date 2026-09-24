import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SOURCE_ID = 'source-session'

function harness(options: { cloneResult?: unknown; forkedId?: string; forkedFile?: string } = {}) {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-fork-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  const upserts: Array<{ sessionId: string; cwd: string; sessionFile: string }> = []
  const proc = new FakePiRpcProcess() as any
  let cloned = false
  // FakePiRpcProcess has no dispose, so track the release the way the real process behaves.
  let disposed = false
  proc.dispose = () => {
    disposed = true
  }

  proc.clone = async () => {
    cloned = true
    return options.cloneResult ?? { cancelled: false }
  }
  proc.getMessages = async () => {
    throw new Error('fork/resume must not replay messages')
  }
  proc.getAvailableModels = async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] })
  proc.getAvailableThinkingLevels = async () => ['off', 'medium']
  proc.getState = async () =>
    cloned
      ? {
          sessionId: options.forkedId ?? 'forked-session',
          sessionFile: options.forkedFile ?? join(sessionFile, '..', 'forked.jsonl'),
          thinkingLevel: 'medium'
        }
      : { sessionId: SOURCE_ID, sessionFile, thinkingLevel: 'medium' }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId: SOURCE_ID, cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
    upsert: (entry: { sessionId: string; cwd: string; sessionFile: string }) => {
      upserts.push(entry)
    }
  }

  return {
    agent,
    conn,
    proc,
    upserts,
    sessionFile,
    wasDisposed: () => disposed,
    restore: () => {
      PiRpcProcess.spawn = originalSpawn
    }
  }
}

test('PiAcpAgent: resumeSession restores the session without replaying it', async () => {
  const h = harness()
  try {
    const response = await h.agent.resumeSession({ sessionId: SOURCE_ID, cwd: '/tmp/project', mcpServers: [] } as any)

    assert.ok(response.configOptions?.length, 'the client still gets its selectors')
    assert.ok(response.modes)
    assert.equal(
      h.conn.updates.filter(update => (update.update as any)?.sessionUpdate === 'user_message_chunk').length,
      0,
      'resume must not replay the transcript'
    )
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: loadSession still replays after the shared-path refactor', async () => {
  const h = harness()
  const originalGetMessages = h.proc.getMessages
  h.proc.getMessages = async () => ({ messages: [{ role: 'user', content: 'hello again' }] })

  try {
    await h.agent.loadSession({ sessionId: SOURCE_ID, cwd: '/tmp/project', mcpServers: [] } as any)

    const replayed = h.conn.updates
      .map(update => (update.update as any)?.content?.text)
      .filter((text): text is string => typeof text === 'string')
    assert.ok(replayed.includes('hello again'), 'load replays the transcript')
  } finally {
    h.proc.getMessages = originalGetMessages
    h.restore()
  }
})

test('PiAcpAgent: forkSession registers the clone and hands the process back', async () => {
  const h = harness()
  try {
    const response = await h.agent.forkSession({ sessionId: SOURCE_ID, cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal(response.sessionId, 'forked-session')
    assert.ok(response.configOptions?.length)
    const forked = h.upserts.filter(entry => entry.sessionId === 'forked-session')
    assert.equal(forked.length, 1, 'the fork is resumable through the session store')
    assert.equal(forked[0]?.cwd, '/tmp/project')
    assert.equal(h.wasDisposed(), true, 'the rebound process is released; both threads restore on demand')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: forkSession reports a cancelled fork instead of a bogus session', async () => {
  const h = harness({ cloneResult: { cancelled: true } })
  try {
    await assert.rejects(
      () => h.agent.forkSession({ sessionId: SOURCE_ID, cwd: '/tmp/project', mcpServers: [] } as any),
      /cancelled by a pi extension/
    )
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SOURCE_ID),
      []
    )
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: forkSession rejects a clone that did not switch sessions', async () => {
  const h = harness({ forkedId: SOURCE_ID })
  try {
    await assert.rejects(
      () => h.agent.forkSession({ sessionId: SOURCE_ID, cwd: '/tmp/project', mcpServers: [] } as any),
      /did not report a forked session/
    )
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SOURCE_ID),
      []
    )
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: initialize advertises resume and fork', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
  const capabilities = response.agentCapabilities?.sessionCapabilities as any

  assert.ok(capabilities?.resume, 'session/resume is advertised')
  assert.ok(capabilities?.fork, 'session/fork is advertised')
})
