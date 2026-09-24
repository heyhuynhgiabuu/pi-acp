import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// The resident cap only fixes the process count if it leaves in-flight requests alone: killing a
// pi process rejects every pending RPC with "pi process exited", so the client's call fails.
const previousCap = process.env.PI_ACP_MAX_RESIDENT_SESSIONS
process.env.PI_ACP_MAX_RESIDENT_SESSIONS = '1'
after(() => {
  if (previousCap === undefined) delete process.env.PI_ACP_MAX_RESIDENT_SESSIONS
  else process.env.PI_ACP_MAX_RESIDENT_SESSIONS = previousCap
})

/**
 * A pi process stub that behaves like the real one on kill: `PiRpcProcess.dispose()` kills the
 * child, whose exit handler rejects every pending request (src/pi-rpc/process.ts:144-148).
 */
function realisticProc(rpcMs: number) {
  let disposed = false
  const pending = new Set<(error: Error) => void>()

  const call = async <T>(value: T): Promise<T> => {
    if (disposed) throw new Error('pi process exited (code=null, signal=SIGTERM)')

    let rejectPending: (error: Error) => void = () => {}
    const killed = new Promise<never>((_resolve, reject) => {
      rejectPending = reject
    })
    pending.add(rejectPending)

    try {
      await Promise.race([new Promise(resolve => setTimeout(resolve, rpcMs)), killed])
      return value
    } finally {
      pending.delete(rejectPending)
    }
  }

  return {
    onEvent: () => () => {},
    getMessages: () => call({ messages: [] }),
    getSessionStats: () => call({}),
    getAvailableModels: () => call({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
    getAvailableThinkingLevels: () => call(['off', 'medium', 'max']),
    getState: () => call({ thinkingMode: 'medium', model: { provider: 'test', id: 'alpha' } }),
    setThinkingLevel: () => call(undefined),
    dispose: () => {
      disposed = true
      for (const reject of [...pending]) reject(new Error('pi process exited (code=null, signal=SIGTERM)'))
      pending.clear()
    }
  }
}

interface Harness {
  agent: PiAcpAgent
  restore: () => void
}

function harness(sessionIds: string[], rpcMs: number): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), 'pi-acp-inflight-'))
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => realisticProc(rpcMs) as any

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  for (const sessionId of sessionIds) {
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    writeFileSync(sessionFile, '', 'utf8')
    ;(agent as any).store.upsert({ sessionId, cwd: projectDir, sessionFile })
  }

  return {
    agent,
    restore: () => {
      PiRpcProcess.spawn = originalSpawn
    }
  }
}

test('PiAcpAgent: a burst of config syncs all succeed under the resident cap', async () => {
  const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']
  const { agent, restore } = harness(ids, 20)

  try {
    const results = await Promise.all(
      ids.map(id =>
        agent
          .setSessionMode({ sessionId: id, modeId: 'medium' } as any)
          .then(() => 'ok')
          .catch((error: Error) => `failed: ${error.message}`)
      )
    )

    assert.deepEqual(
      results.filter(result => result !== 'ok'),
      [],
      'every config sync must survive the cap'
    )
  } finally {
    restore()
  }
})

test('PiAcpAgent: session/new does not kill a concurrent session/load replay', async () => {
  const { agent, restore } = harness(['loading'], 20)

  try {
    const load = agent
      .loadSession({ sessionId: 'loading', cwd: '/tmp', mcpServers: [], _meta: null } as any)
      .then(() => 'ok')
      .catch((error: Error) => `failed: ${error.message}`)

    const created = agent
      .newSession({ cwd: '/tmp', mcpServers: [] } as any)
      .then(() => 'ok')
      .catch((error: Error) => `failed: ${error.message}`)

    assert.deepEqual(await Promise.all([load, created]), ['ok', 'ok'])
  } finally {
    restore()
  }
})
