import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

process.env.PI_ACP_MAX_RESIDENT_SESSIONS = '1'

function trackedProc() {
  const proc = new FakePiRpcProcess() as any
  proc.disposed = false
  proc.getMessages = async () => ({ messages: [] })
  proc.getAvailableModels = async () => ({ models: [] })
  proc.getAvailableThinkingLevels = async () => null
  proc.getState = async () => ({ thinkingMode: 'medium' })
  proc.setThinkingLevel = async () => {}
  proc.dispose = () => {
    proc.disposed = true
  }
  return proc
}

test('PiAcpAgent: a concurrent request cannot evict the session a prompt is using', async () => {
  // Regression pin for the resident cap: the eviction must skip a session that is mid-turn.
  // Breaking `PiAcpSession.isIdle` (so a running turn counts as idle) makes this test fail with
  // the prompt's session already gone.
  const projectDir = mkdtempSync(join(tmpdir(), 'pi-acp-race-project-'))
  const files = new Map([
    ['s1', join(projectDir, 's1.jsonl')],
    ['s2', join(projectDir, 's2.jsonl')]
  ])
  for (const file of files.values()) writeFileSync(file, '', 'utf8')

  const procs = new Map<string, ReturnType<typeof trackedProc>>()
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    const proc = trackedProc()
    procs.set(`spawn-${spawnCount}`, proc)
    return proc
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    for (const [sessionId, sessionFile] of files) {
      ;(agent as any).store.upsert({ sessionId, cwd: projectDir, sessionFile })
    }

    // Let the prompt register its session first, so the concurrent request's eviction has to
    // decide about a session that is mid-request.
    const promptPromise = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
    await new Promise(resolve => setTimeout(resolve, 20))
    const configPromise = agent.setSessionMode({ sessionId: 's2', modeId: 'medium' } as any)

    await new Promise(resolve => setTimeout(resolve, 100))

    const s1 = (agent as any).sessions.maybeGet('s1')
    assert.ok(s1, 'the prompt restored its session')
    assert.equal(s1.proc.disposed, false, 'the cap did not evict the session this prompt is using')

    s1.proc.emit({ type: 'agent_settled' })
    const [promptResult] = await Promise.all([promptPromise, configPromise])
    assert.equal(promptResult.stopReason, 'end_turn', 'the prompt finished on its own process')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
