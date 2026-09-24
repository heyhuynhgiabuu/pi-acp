import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

type Harness = {
  agent: PiAcpAgent
  conn: FakeAgentSideConnection
  procs: Map<string, any>
  load: (sessionId: string) => Promise<unknown>
  restore: () => void
}

function harness(ids: string[]): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-close-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  // Keyed by basename: the discovered path may be a resolved/symlinked form of the
  // path written here (macOS /var vs /private/var).
  const files = new Map<string, string>()
  for (const [index, id] of ids.entries()) {
    const name = `0000_${String(index).padStart(32, '0')}.jsonl`
    writeFileSync(
      join(sessionsDir, name),
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }) + '\n',
      { encoding: 'utf8' }
    )
    files.set(name, id)
  }

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn

  const procs = new Map<string, any>()
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    const name = String(params.sessionPath).split('/').pop() ?? ''
    const id = files.get(name) ?? 'unknown'
    const proc: any = {
      disposed: false,
      aborted: false,
      onEvent: () => () => {},
      dispose: () => {
        proc.disposed = true
      },
      abort: async () => {
        proc.aborted = true
      },
      getMessages: async () => ({ messages: [] }),
      getSessionStats: async () => ({ contextUsage: { tokens: 1, contextWindow: 2 } }),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }
    procs.set(id, proc)
    return proc
  }

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  return {
    agent,
    conn,
    procs,
    load: sessionId => agent.loadSession({ sessionId, cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
    restore: () => {
      PiRpcProcess.spawn = originalSpawn
      if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = oldEnv
    }
  }
}

test('PiAcpAgent: initialize advertises session/close so clients can release threads', async () => {
  const h = harness([])
  try {
    const res = await h.agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.close, {})
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession cancels work and releases the pi subprocess', async () => {
  const h = harness(['s1'])
  try {
    await h.load('s1')
    const proc = h.procs.get('s1')
    assert.equal(proc.disposed, false, 'a loaded session is live')

    await h.agent.closeSession({ sessionId: 's1', _meta: null } as any)

    assert.equal(proc.aborted, true, 'closing cancels work in flight')
    assert.equal(proc.disposed, true, 'closing releases the pi subprocess')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession keeps the session resumable', async () => {
  const h = harness(['s1'])
  try {
    await h.load('s1')
    await h.agent.closeSession({ sessionId: 's1', _meta: null } as any)

    await h.load('s1')
    const proc = h.procs.get('s1')
    assert.equal(proc.disposed, false, 'a closed session can be loaded again')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession closes the whole subagent subtree with its parent', async () => {
  const h = harness(['parent', 'child'])
  try {
    const sessions = (h.agent as any).sessions
    sessions.registerSubagentSession('parent', 'child')

    await h.load('parent')
    // A task owns the child, which is what keeps its viewer resident across the load.
    sessions.markSubagentSessionActive('child', 'task-1')
    await h.load('child')

    assert.equal(h.procs.get('parent').disposed, false)
    assert.equal(h.procs.get('child').disposed, false)

    await h.agent.closeSession({ sessionId: 'parent', _meta: null } as any)

    assert.equal(h.procs.get('parent').disposed, true)
    assert.equal(h.procs.get('child').disposed, true)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: loading a finished subagent thread does not keep its viewer resident', async () => {
  const h = harness(['parent', 'child'])
  try {
    const sessions = (h.agent as any).sessions
    sessions.registerSubagentSession('parent', 'child')

    await h.load('parent')
    await h.load('child')

    // A second resident `pi` process is the bug this guards: the client already has the
    // replayed transcript, and the next prompt or config change restores a fresh process.
    assert.equal(h.procs.get('child').disposed, true, 'the idle child viewer is released')
    assert.equal(sessions.maybeGet('child'), undefined)
    assert.equal(h.procs.get('parent').disposed, false, 'the parent thread stays live')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closing a subagent does not close its parent', async () => {
  const h = harness(['parent', 'child'])
  try {
    ;(h.agent as any).sessions.registerSubagentSession('parent', 'child')

    await h.load('parent')
    await h.load('child')

    await h.agent.closeSession({ sessionId: 'child', _meta: null } as any)

    assert.equal(h.procs.get('child').disposed, true)
    assert.equal(h.procs.get('parent').disposed, false)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession is idempotent for an unknown or already closed session', async () => {
  const h = harness(['s1'])
  try {
    await h.agent.closeSession({ sessionId: 'missing', _meta: null } as any)

    await h.load('s1')
    await h.agent.closeSession({ sessionId: 's1', _meta: null } as any)
    await h.agent.closeSession({ sessionId: 's1', _meta: null } as any)

    assert.equal(h.procs.get('s1').disposed, true)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession waits for an in-flight restore instead of orphaning its process', async () => {
  const h = harness(['s1'])
  try {
    const loading = h.load('s1')
    await h.agent.closeSession({ sessionId: 's1', _meta: null } as any)
    await loading

    assert.equal(h.procs.get('s1').disposed, true, 'a process that finished restoring after close is released')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: closeSession cancels a descendant turn before releasing it', async () => {
  const h = harness(['parent', 'child'])
  try {
    const sessions = (h.agent as any).sessions
    sessions.registerSubagentSession('parent', 'child')

    await h.load('parent')
    sessions.markSubagentSessionActive('child', 'task-1')
    await h.load('child')

    await h.agent.closeSession({ sessionId: 'parent', _meta: null } as any)

    // Disposing without cancelling leaves a mid-turn child whose session/prompt never
    // settles, so the client would wait on a response that can never arrive.
    assert.equal(h.procs.get('child').aborted, true, 'the descendant turn is cancelled')
    assert.equal(h.procs.get('child').disposed, true)
    assert.equal(h.procs.get('parent').aborted, true)
  } finally {
    h.restore()
  }
})
