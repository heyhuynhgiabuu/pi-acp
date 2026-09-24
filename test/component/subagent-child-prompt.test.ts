import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function trackedProcess() {
  return Object.assign(new FakePiRpcProcess(), {
    disposed: false,
    dispose() {
      this.disposed = true
    }
  })
}

class FakeStore {
  constructor(private readonly sessionFile: string) {}

  get(sessionId: string) {
    return { sessionId, cwd: '/tmp/project', sessionFile: this.sessionFile, updatedAt: new Date().toISOString() }
  }

  upsert() {}
}

function writeChildSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-child-'))
  const file = join(dir, 'child.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'child', cwd: '/tmp/project' }) + '\n', {
    encoding: 'utf8'
  })
  return file
}

function taskEntry(customType: 'task-session' | 'task-complete') {
  return {
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType,
      data: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: 'call-1' }
    }
  }
}

test('PiAcpAgent: rejects a prompt for a child session while its parent task runs', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = (agent as any).sessions as SessionManager
  const file = writeChildSessionFile()
  ;(agent as any).store = new FakeStore(file)

  const parentProc = trackedProcess()
  sessions.getOrCreate('parent', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: parentProc as any,
    conn: asAgentConn(conn)
  })
  sessions.getOrCreate('child', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: trackedProcess() as any,
    conn: asAgentConn(conn)
  })

  parentProc.emit(taskEntry('task-session'))

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return new FakePiRpcProcess() as any
  }

  try {
    await assert.rejects(
      agent.prompt({ sessionId: 'child', prompt: [{ type: 'text', text: 'early' }] } as any),
      /read-only/
    )
    assert.deepEqual(spawnCalls, [], 'a running parent task must not be raced by a restored child process')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: a child prompt after the task completes starts a fresh process', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = (agent as any).sessions as SessionManager
  const file = writeChildSessionFile()
  ;(agent as any).store = new FakeStore(file)

  const parentProc = trackedProcess()
  const staleChildProc = trackedProcess()
  sessions.getOrCreate('parent', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: parentProc as any,
    conn: asAgentConn(conn)
  })
  sessions.getOrCreate('child', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: staleChildProc as any,
    conn: asAgentConn(conn)
  })

  parentProc.emit(taskEntry('task-session'))
  parentProc.emit(taskEntry('task-complete'))

  const freshProc = new FakePiRpcProcess()
  const recordPrompt = freshProc.prompt.bind(freshProc)
  freshProc.prompt = async (message, attachments) => {
    await recordPrompt(message, attachments)
    freshProc.emit({ type: 'agent_settled' })
  }

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return freshProc as any
  }

  try {
    const res = await agent.prompt({ sessionId: 'child', prompt: [{ type: 'text', text: 'continue' }] } as any)

    assert.equal(res.stopReason, 'end_turn')
    assert.equal(staleChildProc.disposed, true, 'the process opened during the task is stale')
    assert.deepEqual(
      spawnCalls.map(call => call.sessionPath),
      [file],
      'the child must be re-opened from its completed session file'
    )
    assert.equal(sessions.maybeGet('child')?.proc, freshProc)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: every child-session mutator is rejected while its parent task runs', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = (agent as any).sessions as SessionManager
  const file = writeChildSessionFile()
  ;(agent as any).store = new FakeStore(file)

  const parentProc = trackedProcess()
  sessions.getOrCreate('parent', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: parentProc as any,
    conn: asAgentConn(conn)
  })
  sessions.getOrCreate('child', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: trackedProcess() as any,
    conn: asAgentConn(conn)
  })

  parentProc.emit(taskEntry('task-session'))

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return new FakePiRpcProcess() as any
  }

  try {
    // A model/thinking/config change is persisted by pi into the same child transcript,
    // so it must be blocked exactly like a prompt while the task owns the file.
    await assert.rejects(agent.unstable_setSessionModel({ sessionId: 'child', modelId: 'gpt-5' }), /read-only/)
    await assert.rejects(agent.setSessionMode({ sessionId: 'child', modeId: 'high' } as any), /read-only/)
    await assert.rejects(
      agent.setSessionConfigOption({ sessionId: 'child', configId: 'model', value: 'gpt-5' } as any),
      /read-only/
    )
    await assert.rejects(agent.deleteSession({ sessionId: 'child' } as any), /read-only/)

    assert.deepEqual(spawnCalls, [], 'no mutator may restore a second writer for the child')
    assert.equal(existsSync(file), true, 'a rejected delete must not unlink the transcript')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: child mutators work again once the task completes', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = (agent as any).sessions as SessionManager
  const file = writeChildSessionFile()
  ;(agent as any).store = new FakeStore(file)

  const parentProc = trackedProcess()
  sessions.getOrCreate('parent', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: parentProc as any,
    conn: asAgentConn(conn)
  })
  sessions.getOrCreate('child', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: trackedProcess() as any,
    conn: asAgentConn(conn)
  })

  parentProc.emit(taskEntry('task-session'))
  parentProc.emit(taskEntry('task-complete'))

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return Object.assign(new FakePiRpcProcess(), { setThinkingLevel: async () => {} }) as any
  }

  try {
    await assert.doesNotReject(agent.setSessionMode({ sessionId: 'child', modeId: 'medium' } as any))
    assert.deepEqual(
      spawnCalls.map(call => call.sessionPath),
      [file],
      'the completed child is re-opened from its own session file'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: a restore in flight when the task completes is recycled, not adopted', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = (agent as any).sessions as SessionManager
  const file = writeChildSessionFile()
  ;(agent as any).store = new FakeStore(file)

  const parentProc = trackedProcess()
  sessions.getOrCreate('parent', {
    cwd: '/tmp/project',
    mcpServers: [],
    proc: parentProc as any,
    conn: asAgentConn(conn)
  })

  const staleProc = Object.assign(new FakePiRpcProcess(), {
    disposed: false,
    dispose() {
      this.disposed = true
    },
    setThinkingLevel: async () => {}
  })
  const freshProc = Object.assign(new FakePiRpcProcess(), {
    disposed: false,
    dispose() {
      this.disposed = true
    },
    setThinkingLevel: async () => {}
  })
  const spawnCalls: any[] = []
  let releaseFirstSpawn: (() => void) | undefined
  let markFirstSpawnStarted: (() => void) | undefined
  const firstSpawnGate = new Promise<void>(resolve => {
    releaseFirstSpawn = resolve
  })
  const firstSpawnStarted = new Promise<void>(resolve => {
    markFirstSpawnStarted = resolve
  })

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    if (spawnCalls.length === 1) {
      // Hold the first restore open so the task can complete while it is in flight.
      markFirstSpawnStarted?.()
      await firstSpawnGate
      return staleProc as any
    }
    return freshProc as any
  }

  try {
    const mutating = agent.setSessionMode({ sessionId: 'child', modeId: 'medium' } as any)
    await firstSpawnStarted

    // The task starts and finishes while the child restore is still starting.
    parentProc.emit(taskEntry('task-session'))
    parentProc.emit(taskEntry('task-complete'))
    releaseFirstSpawn?.()
    await mutating

    assert.equal(spawnCalls.length, 2, 'the in-flight restore is not adopted as the writer')
    assert.equal(staleProc.disposed, true, 'the process restored before completion is stale')
    assert.equal(sessions.maybeGet('child')?.proc, freshProc)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
