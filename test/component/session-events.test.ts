import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: surfaces visible custom messages and ignores hidden ones', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_end',
    message: { role: 'custom', customType: 'task-complete', display: false, content: 'hidden' }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', customType: 'task-complete', display: true, content: 'task finished' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'task finished' }
  })
})

test('PiAcpSession: links a hidden pi-task session to its tool call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const subagentSessions: string[] = []

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    onSubagentSession: sessionId => subagentSessions.push(sessionId)
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'task-call',
    toolName: 'task',
    args: { agent_type: 'worker' }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: { task_id: 'task-1', session_id: 'child-session' }
    }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'task-call',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'running' }],
      details: { task_id: 'task-1', backend: 'sdk', background: true }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const linkUpdate = conn.updates.find(update => (update as any).update?._meta?.subagent_session_info) as any
  assert.deepEqual(linkUpdate?.update?._meta, {
    subagent_session_info: { session_id: 'child-session', message_start_index: 0 }
  })
  assert.deepEqual(subagentSessions, ['child-session'])
  assert.equal(
    conn.updates.some(update => (update as any).update?.sessionUpdate === 'agent_message_chunk'),
    false
  )
})

test('PiAcpSession: attaches a late background session to its completed task call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'task-call',
    toolName: 'task',
    args: { agent_type: 'worker' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'task-call',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'running' }],
      details: { task_id: 'task-2', backend: 'sdk', background: true }
    }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: { task_id: 'task-2', session_id: 'child-session-2' }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const linkUpdates = conn.updates.filter(update => (update as any).update?._meta?.subagent_session_info) as any[]
  assert.equal(linkUpdates.length, 1)
  assert.equal(linkUpdates[0]!.update.toolCallId, 'task-call')
  assert.equal(linkUpdates[0]!.update.status, 'completed')
  assert.deepEqual(linkUpdates[0]!.update._meta, {
    subagent_session_info: { session_id: 'child-session-2', message_start_index: 0 }
  })
})

test('PiAcpSession: links a foreground task session while the task is still running', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const subagentSessions: string[] = []

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    onSubagentSession: sessionId => subagentSessions.push(sessionId)
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'task-call',
    toolName: 'task',
    args: { agent_type: 'worker' }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: {
        task_id: 'task-1',
        session_id: 'child-session',
        pi_tool_call_id: 'task-call'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const linkUpdates = conn.updates.filter(update => (update as any).update?._meta?.subagent_session_info) as any[]
  assert.equal(linkUpdates.length, 1)
  assert.equal(linkUpdates[0]!.update.toolCallId, 'task-call')
  assert.equal(linkUpdates[0]!.update.status, 'in_progress')
  assert.deepEqual(linkUpdates[0]!.update._meta, {
    subagent_session_info: { session_id: 'child-session', message_start_index: 0 }
  })
  assert.deepEqual(subagentSessions, ['child-session'])
})

test('PiAcpSession: links a foreground task from the live entry before the tool result', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const subagentSessions: string[] = []

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    onSubagentSession: sessionId => subagentSessions.push(sessionId)
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'task-call',
    toolName: 'task',
    args: { agent_type: 'worker' }
  })
  // pi-task's live channel: an entry, which pi emits immediately (unlike a custom
  // message, which pi defers until the turn ends while the parent is streaming).
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-session', pi_tool_call_id: 'task-call' }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const linkUpdates = conn.updates.filter(update => (update as any).update?._meta?.subagent_session_info) as any[]
  assert.equal(linkUpdates.length, 1)
  assert.equal(linkUpdates[0]!.update.toolCallId, 'task-call')
  assert.equal(linkUpdates[0]!.update.status, 'in_progress')
  assert.deepEqual(linkUpdates[0]!.update._meta, {
    subagent_session_info: { session_id: 'child-session', message_start_index: 0 }
  })
  assert.deepEqual(subagentSessions, ['child-session'])
})

test('PiAcpSession: defers an early link for an unknown tool-call id until the task result', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'task-call',
    toolName: 'task',
    args: { agent_type: 'worker' }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: {
        task_id: 'task-1',
        session_id: 'child-session',
        pi_tool_call_id: 'stale-call'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(
    conn.updates.some(update => (update as any).update?._meta?.subagent_session_info),
    false,
    'an unknown tool-call id must not be linked to an unrelated call'
  )

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'task-call',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'done' }],
      details: { task_id: 'task-1', backend: 'sdk', session_id: 'child-session' }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const linkUpdates = conn.updates.filter(update => (update as any).update?._meta?.subagent_session_info) as any[]
  assert.equal(linkUpdates.length, 1)
  assert.equal(linkUpdates[0]!.update.toolCallId, 'task-call')
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: process.cwd() }
  })
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[1]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[1]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'running' }
  })
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.equal((conn.updates[2]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[2]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'done' },
    terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null }
  })
  assert.equal((conn.updates[2]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: handles extension select via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'pi-ui-ui-1',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: handles extension confirm via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'no' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: sends cancelled response when ACP confirm is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-5', method: 'confirm', title: 'Continue?' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', cancelled: true }])
})

test('PiAcpSession: cancels input and editor extension UI requests when the client cannot elicit', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Enter name' })
  proc.emit({ type: 'extension_ui_request', id: 'ui-4', method: 'editor', title: 'Edit text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-3', cancelled: true },
    { id: 'ui-4', cancelled: true }
  ])
  assert.equal(conn.updates.length, 2)
  assert.match(
    (conn.updates[0]!.update as any).content.text,
    /input request needs a client that supports ACP elicitation/
  )
  assert.match(
    (conn.updates[1]!.update as any).content.text,
    /editor request needs a client that supports ACP elicitation/
  )
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: reads legacy tool calls from partial assistant-message content', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: {
        content: [{ id: 't-legacy', name: 'write', arguments: { path: '/tmp/legacy.txt', content: 'hello' } }]
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't-legacy')
  assert.deepEqual((conn.updates[0]!.update as any).rawInput, { path: '/tmp/legacy.txt', content: 'hello' })
})

test('PiAcpSession: streams current delta-only Pi tool-call events through execution start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 't1', toolName: 'write' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"/tmp/' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'target.txt","content":"ok"}' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't1', name: 'write', arguments: { path: '/tmp/target.txt', content: 'ok' } }
    }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: '/tmp/target.txt', content: 'ok' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(({ update }) => update.sessionUpdate),
    ['tool_call', 'tool_call_update', 'tool_call_update', 'tool_call_update', 'tool_call_update']
  )
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'write')
  assert.deepEqual((conn.updates[2]!.update as any).rawInput, { path: '/tmp/target.txt', content: 'ok' })
  assert.deepEqual((conn.updates[3]!.update as any).rawInput, { path: '/tmp/target.txt', content: 'ok' })
  assert.equal((conn.updates[4]!.update as any).status, 'in_progress')
})

test('PiAcpSession: keeps interleaved tool argument deltas keyed by content index', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 't1', toolName: 'write' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 't2', toolName: 'write' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"/tmp/first.txt"}' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"/tmp/second.txt"}' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(({ update }) => [update.sessionUpdate, (update as any).toolCallId]),
    [
      ['tool_call', 't1'],
      ['tool_call', 't2'],
      ['tool_call_update', 't1'],
      ['tool_call_update', 't2']
    ]
  )
  assert.deepEqual((conn.updates[2]!.update as any).rawInput, { path: '/tmp/first.txt' })
  assert.deepEqual((conn.updates[3]!.update as any).rawInput, { path: '/tmp/second.txt' })
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from edits array when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'needle', newText: 'replacement' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from stringified edits array', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-string-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: JSON.stringify([{ oldText: 'needle', newText: 'replacement' }]) }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt stays open through retry runs until agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000 })
  proc.emit({ type: 'agent_end', willRetry: true })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_settled' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: does not re-emit startup info on first prompt after it was already sent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'

  session.setStartupInfo(notice)
  session.sendStartupInfoIfPending()
  await new Promise(r => setTimeout(r, 0))

  const p = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  const startupUpdates = conn.updates.filter(
    entry =>
      entry.update.sessionUpdate === 'agent_message_chunk' &&
      (entry.update as any).content?.type === 'text' &&
      (entry.update as any).content?.text === notice
  )
  assert.equal(startupUpdates.length, 1)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: renders extension notifications as separated italic blocks without a response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'MCP: connection failed\nretrying',
    notifyType: 'error'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: '\n\n> _MCP: connection failed_\n> _retrying_\n\n'
    },
    _meta: { piAcp: { notify: { level: 'error' } } }
  })
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('PiAcpSession: defaults extension notification severity to info and renders it separately', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n2',
    method: 'notify',
    message: 'heads up'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).content.text, '\n\n> _heads up_\n\n')
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    piAcp: { notify: { level: 'info' } }
  })
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('PiAcpSession: maps extension setTitle to ACP session title without a response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'title-1', method: 'setTitle', title: 'Pi workspace' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(update => update.update),
    [{ sessionUpdate: 'session_info_update', title: 'Pi workspace' }]
  )
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('PiAcpSession: ignores unsupported fire-and-forget extension UI methods without responding', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'status-1',
    method: 'setStatus',
    statusKey: 'usage',
    statusText: 'TPS 38.8 tok/s'
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'widget-1',
    method: 'setWidget',
    widgetKey: 'summary',
    widgetLines: ['Line 1']
  })
  proc.emit({ type: 'extension_ui_request', id: 'editor-1', method: 'set_editor_text', text: 'Draft text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(conn.updates, [])
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('PiAcpSession: emits usage_update from contextUsage before resolving prompt on agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { total: 999_999 },
    contextUsage: { tokens: 12_345, contextWindow: 200_000 }
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Block delivery of usage_update to prove the prompt only resolves once it landed.
  let usageDeliveryStarted: () => void
  const deliveryStarted = new Promise<void>(resolve => {
    usageDeliveryStarted = resolve
  })
  let releaseDelivery: () => void
  const deliveryBlocked = new Promise<void>(resolve => {
    releaseDelivery = resolve
  })

  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async msg => {
    if (msg.update.sessionUpdate === 'usage_update') {
      usageDeliveryStarted()
      await deliveryBlocked
    }
    await originalSessionUpdate(msg)
  }

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  await deliveryStarted
  assert.equal(resolved, false)
  releaseDelivery!()

  assert.equal(await p, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.deepEqual(
    conn.updates.filter(u => u.update.sessionUpdate === 'usage_update').map(u => u.update),
    [{ sessionUpdate: 'usage_update', used: 12_345, size: 200_000 }]
  )
})

test('PiAcpSession: skips usage_update when contextUsage tokens are null', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { total: 4_000 },
    contextUsage: { tokens: null, contextWindow: 200_000 }
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('PiAcpSession: skips usage_update for invalid contextUsage values', async () => {
  const invalid = [
    { name: 'missing contextUsage', contextUsage: undefined },
    { name: 'negative tokens', contextUsage: { tokens: -1, contextWindow: 100 } },
    { name: 'fractional tokens', contextUsage: { tokens: 1.5, contextWindow: 100 } },
    { name: 'NaN tokens', contextUsage: { tokens: Number.NaN, contextWindow: 100 } },
    { name: 'zero contextWindow', contextUsage: { tokens: 10, contextWindow: 0 } },
    { name: 'negative contextWindow', contextUsage: { tokens: 10, contextWindow: -1 } },
    { name: 'fractional contextWindow', contextUsage: { tokens: 10, contextWindow: 100.5 } },
    { name: 'null contextWindow', contextUsage: { tokens: 10, contextWindow: null } },
    { name: 'infinite contextWindow', contextUsage: { tokens: 10, contextWindow: Number.POSITIVE_INFINITY } }
  ]

  for (const { name, contextUsage } of invalid) {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    proc.sessionStats = { contextUsage } as any

    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    const p = session.prompt('hello')
    proc.emit({ type: 'agent_settled' })

    assert.equal(await p, 'end_turn', name)
    assert.equal(
      conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
      false,
      name
    )
  }
})

test('PiAcpSession: get_session_stats rejection does not break the prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStatsError = new Error('pi get_session_stats failed: unsupported')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('PiAcpSession: get_session_stats timeout does not block the prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // The timeout lives in PiRpcProcess.request (see test/unit/pi-rpc-request-timeout.test.ts);
  // from the session's point of view it surfaces as a rejection.
  proc.sessionStatsError = new Error('pi get_session_stats timed out after 1000ms')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('PiAcpSession: cancelled turn still reports cancelled after usage publish', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 42, contextWindow: 100 } }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'cancelled')
  assert.deepEqual(
    conn.updates.filter(u => u.update.sessionUpdate === 'usage_update').map(u => u.update),
    [{ sessionUpdate: 'usage_update', used: 42, size: 100 }]
  )
})

test('PiAcpSession: re-links a resumed task with the same task id but a new tool call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 'parent-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const taskEntry = (piToolCallId: string) => ({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child-session', pi_tool_call_id: piToolCallId }
    }
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'task', args: {} })
  proc.emit(taskEntry('call-1'))
  // A duplicate of the same live event must not emit a second link.
  proc.emit(taskEntry('call-1'))

  // The task was resumed with the same task id and a new parent tool call.
  proc.emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'task', args: {} })
  proc.emit(taskEntry('call-2'))

  await new Promise(r => setTimeout(r, 0))

  const linkedToolCallIds = conn.updates
    .map(update => (update as any).update)
    .filter(update => update?._meta?.subagent_session_info)
    .map(update => update.toolCallId)

  assert.deepEqual(linkedToolCallIds, ['call-1', 'call-2'])
})
