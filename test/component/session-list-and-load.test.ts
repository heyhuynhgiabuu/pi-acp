import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('PiAcpAgent: listSessions lists pi sessions and loadSession replays history', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
    const originalSpawn = PiRpcProcess.spawn

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
            {
              role: 'toolResult',
              toolName: 'task',
              toolCallId: 'task-call',
              content: [{ type: 'text', text: 'Task started' }],
              details: { task_id: 'task-1', backend: 'sdk', background: true },
              isError: false
            },
            {
              role: 'custom',
              customType: 'task-session',
              display: false,
              content: '',
              details: { task_id: 'task-1', session_id: 'child-session' }
            }
          ]
        }),
        getSessionStats: async () => ({ contextUsage: { tokens: 12_345, contextWindow: 200_000 } }),
        getAvailableModels: async () => ({ models: [] }),
        getAvailableThinkingLevels: async () => null,
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
      assert.ok(
        conn.updates.some(
          update => (update as any).update?._meta?.subagent_session_info?.session_id === 'child-session'
        )
      )

      // loadSession schedules the usage publish after returning (client must know the sessionId first).
      assert.equal(
        conn.updates.some(u => (u as any).update?.sessionUpdate === 'usage_update'),
        false
      )
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))

      assert.deepEqual(
        conn.updates.filter(u => (u as any).update?.sessionUpdate === 'usage_update'),
        [{ sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 } }]
      )
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession closes the live pi subprocess before removing the transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_cccccccccccccccccccccccccccccccc.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'live-1',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn

  let disposed = false
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    ;(PiRpcProcess as any).spawn = async () =>
      ({
        onEvent: () => () => {},
        dispose: () => {
          disposed = true
        },
        getMessages: async () => ({ messages: [] }),
        getSessionStats: async () => ({ contextUsage: { tokens: 1, contextWindow: 2 } }),
        getAvailableModels: async () => ({ models: [] }),
        getAvailableThinkingLevels: async () => null,
        getState: async () => ({ thinkingLevel: 'medium' })
      }) as any

    await agent.loadSession({
      sessionId: 'live-1',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)
    assert.equal(disposed, false, 'the loaded session stays live')

    await agent.deleteSession({ sessionId: 'live-1', _meta: null } as any)

    assert.equal(disposed, true, 'deleting a session must stop its pi subprocess')
    assert.equal(existsSync(sessionFile), false, 'the transcript is removed')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: a failed session restore disposes the pi subprocess it already spawned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-orphan-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_dddddddddddddddddddddddddddddddd.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'orphan-1',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn

  let disposed = false
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    ;(PiRpcProcess as any).spawn = async () =>
      ({
        // Registration fails after the process exists.
        onEvent: () => {
          throw new Error('boom')
        },
        dispose: () => {
          disposed = true
        }
      }) as any

    await assert.rejects(
      agent.loadSession({ sessionId: 'orphan-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
      /boom/
    )
    assert.equal(disposed, true, 'a spawn that is never registered must not be orphaned')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: concurrent session loads bound how many pi processes start at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-spawn-limit-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  const ids = ['s1', 's2', 's3', 's4']
  ids.forEach((id, index) => {
    const name = `0000_${String(index).padStart(32, '0')}.jsonl`
    writeFileSync(
      join(sessionsDir, name),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-02-11T00:00:00.000Z', cwd: '/tmp/project' }) +
        '\n',
      { encoding: 'utf8' }
    )
  })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldLimit = process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = '2'
  const originalSpawn = PiRpcProcess.spawn

  let inFlight = 0
  let peak = 0
  const spawnGate = new Promise(resolve => setTimeout(resolve, 30))

  ;(PiRpcProcess as any).spawn = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await spawnGate
    inFlight -= 1
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    await Promise.all(
      ids.map(id => agent.loadSession({ sessionId: id, cwd: '/tmp/project', mcpServers: [], _meta: null } as any))
    )

    // A client restoring every open thread at once must not start one pi per thread: each
    // process is ~250 MB, and none can be closed until it finishes registering.
    assert.ok(peak <= 2, `at most two pi processes start at once (peak ${peak})`)
    assert.equal(inFlight, 0, 'every spawn slot is released')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldLimit === undefined) delete process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
    else process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = oldLimit
  }
})

test('PiAcpAgent: a load finishing must not close a session that is still replaying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-concurrent-load-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  const ids = ['fast', 'slow']
  ids.forEach((id, index) => {
    writeFileSync(
      join(sessionsDir, `0000_${String(index).padStart(32, '0')}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-02-11T00:00:00.000Z', cwd: '/tmp/project' }) +
        '\n',
      { encoding: 'utf8' }
    )
  })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldLimit = process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = '2'
  const originalSpawn = PiRpcProcess.spawn

  const procs = new Map<string, any>()
  let releaseSlowReplay: (() => void) | undefined
  const slowReplayGate = new Promise<void>(resolve => {
    releaseSlowReplay = resolve
  })
  let spawnIndex = 0

  ;(PiRpcProcess as any).spawn = async (params: any) => {
    const id = ids[spawnIndex++] ?? 'extra'
    const proc: any = {
      disposed: false,
      onEvent: () => () => {},
      getMessages: async () => {
        // The second session is still reading its history when the first load finishes.
        if (id === 'slow') await slowReplayGate
        return { messages: [] }
      },
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' }),
      dispose: () => {
        proc.disposed = true
      },
      sessionPath: params.sessionPath
    }
    procs.set(id, proc)
    return proc
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    const loadFast = agent.loadSession({ sessionId: 'fast', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)
    const loadSlow = agent.loadSession({ sessionId: 'slow', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    await loadFast
    assert.equal(
      procs.get('slow').disposed,
      false,
      'the one-live-process policy must not kill a session whose history is still replaying'
    )

    releaseSlowReplay?.()
    await loadSlow
    assert.equal(procs.get('slow').disposed, false, 'the last load keeps its own session live')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldLimit === undefined) delete process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
    else process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = oldLimit
  }
})

test('PiAcpAgent: starting a load closes the previous finished thread\u0027s process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-prev-thread-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  const ids = ['first', 'second']
  ids.forEach((id, index) => {
    writeFileSync(
      join(sessionsDir, `0000_${String(index).padStart(32, '0')}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-02-11T00:00:00.000Z', cwd: '/tmp/project' }) +
        '\n',
      { encoding: 'utf8' }
    )
  })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldLimit = process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = '2'
  const originalSpawn = PiRpcProcess.spawn

  const procs = new Map<string, any>()
  let releaseSecondReplay: (() => void) | undefined
  const secondReplayGate = new Promise<void>(resolve => {
    releaseSecondReplay = resolve
  })
  let secondStarted: (() => void) | undefined
  const secondProcReady = new Promise<void>(resolve => {
    secondStarted = resolve
  })
  let spawnIndex = 0

  ;(PiRpcProcess as any).spawn = async () => {
    const id = ids[spawnIndex++] ?? 'extra'
    const proc: any = {
      disposed: false,
      onEvent: () => () => {},
      getMessages: async () => {
        if (id === 'second') {
          secondStarted?.()
          await secondReplayGate
        }
        return { messages: [] }
      },
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' }),
      dispose: () => {
        proc.disposed = true
      }
    }
    procs.set(id, proc)
    return proc
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    await agent.loadSession({ sessionId: 'first', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)
    assert.equal(procs.get('first').disposed, false, 'the first thread stays live after its own load')

    const secondLoad = agent.loadSession({
      sessionId: 'second',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)
    await secondProcReady

    // The one-live-process policy otherwise runs only at the end of a load, so a client
    // restoring several threads over a few seconds would accumulate resident processes.
    assert.equal(procs.get('first').disposed, true, 'the previous finished thread is released up front')

    releaseSecondReplay?.()
    await secondLoad
    assert.equal(procs.get('second').disposed, false, 'the thread being loaded keeps its process')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldLimit === undefined) delete process.env.PI_ACP_MAX_CONCURRENT_SPAWNS
    else process.env.PI_ACP_MAX_CONCURRENT_SPAWNS = oldLimit
  }
})

test('PiAcpAgent: metadata calls for many sessions do not leave a process each', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resident-cap-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  ids.forEach((id, index) => {
    writeFileSync(
      join(sessionsDir, `0000_${String(index).padStart(32, '0')}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-02-11T00:00:00.000Z', cwd: '/tmp/project' }) +
        '\n',
      { encoding: 'utf8' }
    )
  })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldCap = process.env.PI_ACP_MAX_RESIDENT_SESSIONS
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_MAX_RESIDENT_SESSIONS = '2'
  const originalSpawn = PiRpcProcess.spawn

  const resident = new Set<string>()
  let peak = 0

  ;(PiRpcProcess as any).spawn = async () => {
    // A real pi takes seconds to boot; the delay is what lets the cap evict between spawns.
    await new Promise(resolve => setTimeout(resolve, 10))
    const id = `proc-${Math.random().toString(36).slice(2)}`
    resident.add(id)
    peak = Math.max(peak, resident.size)
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' }),
      setThinkingLevel: async () => {},
      dispose: () => {
        resident.delete(id)
      }
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // A client syncing the model/thinking selector for every open thread must not hold one
    // pi process per thread: nothing closes those until the next session/load.
    await Promise.all(ids.map(id => agent.setSessionMode({ sessionId: id, modeId: 'medium' } as any)))

    assert.ok(peak <= 3, `resident processes stay bounded (peak ${peak})`)
    assert.ok(resident.size <= 2, `at most two sessions stay resident (got ${resident.size})`)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldCap === undefined) delete process.env.PI_ACP_MAX_RESIDENT_SESSIONS
    else process.env.PI_ACP_MAX_RESIDENT_SESSIONS = oldCap
  }
})
