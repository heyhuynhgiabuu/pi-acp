import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SESSION_ID = 's1'

/**
 * A command that is advertised but not handled falls through to a normal prompt turn, which the
 * client shows as a stuck turn. The advertised list is read from the source so it cannot drift.
 */
function advertisedBuiltinCommands(): string[] {
  const source = readFileSync(fileURLToPath(new URL('../../src/acp/agent.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('function builtinAvailableCommands()')
  const end = source.indexOf('function mergeCommands(')
  const block = source.slice(start, end)

  return [...block.matchAll(/name: '([a-z-]+)'/g)].map(match => match[1]!).filter(Boolean)
}

function fakeProc(sessionFile: string) {
  const proc = new FakePiRpcProcess() as any
  Object.assign(proc, {
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
    getAvailableThinkingLevels: async () => ['off', 'medium'],
    getState: async () => ({
      sessionId: SESSION_ID,
      sessionFile,
      thinkingLevel: 'medium',
      steeringMode: 'all',
      followUpMode: 'all'
    }),
    getSessionStats: async () => ({}),
    getMessages: async () => ({ messages: [] }),
    getTree: async () => ({ tree: [], leafId: null }),
    getLastAssistantText: async () => 'last text',
    getForkMessages: async () => ({ messages: [] }),
    setThinkingLevel: async () => {},
    setSteeringMode: async () => {},
    setFollowUpMode: async () => {},
    compact: async () => ({}),
    setAutoCompaction: async () => {},
    setSessionName: async () => {},
    clone: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true })
  })
  return proc
}

test('PiAcpAgent: every advertised built-in command is handled adapter-side', async () => {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-builtins-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  const proc = fakeProc(sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId: SESSION_ID, cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
    upsert() {}
  }

  try {
    const commands = advertisedBuiltinCommands()
    assert.ok(commands.includes('tree'), 'the guard reads the real list')

    const unhandled: string[] = []
    for (const command of commands) {
      const promptsBefore = proc.prompts.length
      try {
        await agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: `/${command}` }] } as any)
      } catch {
        // Usage errors are acceptable; a prompt turn is not.
      }

      if (proc.prompts.length !== promptsBefore) unhandled.push(`/${command}`)
    }

    assert.deepEqual(unhandled, [], 'advertised commands must not fall through to pi as prompts')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
