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

  get(sessionId: string) {
    return { sessionId, cwd: '/tmp/project', sessionFile: this.sessionFile, updatedAt: new Date().toISOString() }
  }

  upsert() {}
}

function writeSessionFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-durable-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8' })
  return file
}

const SESSION_HEADER = JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp/project' })

test('PiAcpAgent: loadSession replays durable task-session entries from the parent session file', async () => {
  const sessionFile = writeSessionFile([
    SESSION_HEADER,
    'not json at all',
    JSON.stringify({
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-session', pi_tool_call_id: 'task-call' }
    }),
    JSON.stringify({ type: 'custom', customType: 'other', data: { task_id: 'ignored', session_id: 'nope' } })
  ])

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      // The durable link is a session entry, so it is deliberately absent from get_messages.
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolName: 'task',
            toolCallId: 'task-call',
            content: [{ type: 'text', text: 'running' }],
            details: { task_id: 'task-1', backend: 'sdk', background: true },
            isError: false
          }
        ]
      }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const linked = conn.updates
      .map(update => (update as any).update)
      .filter(update => update?._meta?.subagent_session_info)

    assert.equal(linked.length, 1)
    assert.equal(linked[0].toolCallId, 'task-call')
    assert.deepEqual(linked[0]._meta, {
      subagent_session_info: { session_id: 'child-session', message_start_index: 0 }
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession keeps resumed task links attached to their own tool calls', async () => {
  const sessionFile = writeSessionFile([
    SESSION_HEADER,
    JSON.stringify({
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-1', pi_tool_call_id: 'call-1' }
    }),
    JSON.stringify({
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-2', pi_tool_call_id: 'call-2' }
    })
  ])

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolName: 'task',
            toolCallId: 'call-1',
            details: { task_id: 'task-1', backend: 'sdk', background: true },
            isError: false
          },
          {
            role: 'toolResult',
            toolName: 'task',
            toolCallId: 'call-2',
            details: { task_id: 'task-1', backend: 'sdk', background: true },
            isError: false
          }
        ]
      }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const links = conn.updates
      .map(update => (update as any).update)
      .filter(update => update?._meta?.subagent_session_info)
      .map(update => [update.toolCallId, update._meta.subagent_session_info.session_id])

    assert.deepEqual(links, [
      ['call-1', 'child-1'],
      ['call-2', 'child-2']
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays visible custom messages but not hidden ones', async () => {
  const sessionFile = writeSessionFile([SESSION_HEADER])

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          { role: 'custom', customType: 'notice', display: true, content: 'visible notice' },
          {
            role: 'custom',
            customType: 'task-session',
            display: false,
            content: '',
            details: { task_id: 'task-1', session_id: 'child-session' }
          },
          {
            role: 'custom',
            customType: 'task-complete',
            display: true,
            content: 'Task finished',
            details: { task_id: 'task-1', session_id: 'child-session', pi_tool_call_id: 'call-1' }
          },
          { role: 'custom', customType: 'notice', display: true, content: '' }
        ]
      }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const chunks = conn.updates
      .map(update => (update as any).update)
      .filter(update => update?.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text)

    assert.deepEqual(chunks, ['visible notice', 'Task finished'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession links a task that was still running when the session reloaded', async () => {
  const sessionFile = writeSessionFile([
    SESSION_HEADER,
    JSON.stringify({
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-session', pi_tool_call_id: 'task-call' }
    })
  ])

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      // No tool result yet: the task was still running when the session was reloaded.
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Starting the task.' },
              { type: 'toolCall', id: 'task-call', name: 'task', arguments: { agent_type: 'reviewer' } }
            ]
          }
        ]
      }),
      getSessionStats: async () => ({}),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const link = conn.updates
      .map(update => (update as any).update)
      .find(update => update?.toolCallId === 'task-call' && update?._meta?.subagent_session_info)

    assert.ok(link, 'the in-flight task tool call anchors the child link')
    assert.equal(link.sessionUpdate, 'tool_call')
    assert.equal(link.status, 'in_progress')
    assert.equal(link._meta.subagent_session_info.session_id, 'child-session')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
