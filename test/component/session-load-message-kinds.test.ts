import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeStore {
  constructor(private readonly sessionFile: string) {}
  get(_sessionId: string) {
    return {
      sessionId: 's1',
      cwd: '/tmp/project',
      sessionFile: this.sessionFile,
      updatedAt: new Date().toISOString()
    }
  }
  upsert() {}
}

async function loadWithMessages(messages: unknown[]) {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      getMessages: async () => ({ messages }),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any

  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-load-messages-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    return conn.updates.map(update => (update as any).update)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

// `get_messages` returns the AgentMessage union, which includes message kinds the adapter has to
// render itself: a reopened thread would otherwise lose them from its transcript.
test('PiAcpAgent: loadSession replays a direct bash execution', async () => {
  const updates = await loadWithMessages([
    {
      role: 'bashExecution',
      command: 'git status --short',
      output: ' M src/acp/agent.ts',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1
    }
  ])

  const toolCall = updates.find(update => update?.sessionUpdate === 'tool_call')
  assert.equal(toolCall?.title, 'git status --short')
  assert.equal(toolCall?.kind, 'execute')
  assert.deepEqual(toolCall?.rawInput, { command: 'git status --short' })

  const update = updates.find(item => item?.sessionUpdate === 'tool_call_update')
  assert.equal(update?.status, 'completed')
  assert.deepEqual(update?.content, [{ type: 'content', content: { type: 'text', text: ' M src/acp/agent.ts' } }])
})

test('PiAcpAgent: a failed or cancelled bash execution is replayed as failed', async () => {
  const updates = await loadWithMessages([
    {
      role: 'bashExecution',
      command: 'false',
      output: '',
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: 1
    },
    {
      role: 'bashExecution',
      command: 'sleep 100',
      output: 'partial',
      exitCode: undefined,
      cancelled: true,
      truncated: true,
      timestamp: 2
    }
  ])

  const toolCalls = updates.filter(update => update?.sessionUpdate === 'tool_call')
  assert.equal(toolCalls.length, 2, 'each command gets its own tool call')
  assert.notEqual(toolCalls[0]?.toolCallId, toolCalls[1]?.toolCallId)

  const results = updates.filter(update => update?.sessionUpdate === 'tool_call_update')
  assert.equal(results[0]?.status, 'failed', 'a non-zero exit code is a failure')
  assert.equal(results[1]?.status, 'completed')
  assert.equal((results[1]?.rawOutput as any)?.cancelled, true)
  assert.equal((results[1]?.rawOutput as any)?.truncated, true)
})

test('PiAcpAgent: loadSession replays branch and compaction summaries', async () => {
  const updates = await loadWithMessages([
    { role: 'branchSummary', summary: 'Switched to the other approach', fromId: 'entry-1', timestamp: 1 },
    { role: 'compactionSummary', summary: 'Earlier work summarized', tokensBefore: 120000, timestamp: 2 },
    { role: 'branchSummary', summary: '', fromId: null, timestamp: 3 }
  ])

  const texts = updates
    .filter(update => update?.sessionUpdate === 'agent_message_chunk')
    .map(update => (update as any).content?.text)

  assert.equal(texts.length, 2, 'an empty summary is skipped')
  assert.match(texts[0] ?? '', /Branch summary/)
  assert.match(texts[0] ?? '', /Switched to the other approach/)
  assert.match(texts[1] ?? '', /Compaction summary/)
  assert.match(texts[1] ?? '', /tokens before: 120000/)
  assert.match(texts[1] ?? '', /Earlier work summarized/)
})
