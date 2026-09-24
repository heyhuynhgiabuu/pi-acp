import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readPiTaskSessionEvent,
  readPiTaskSessionEventsFromSessionFile,
  readPiTaskToolResult
} from '../../src/acp/subagent-session.js'

test('readPiTaskSessionEvent carries the parent tool-call id when pi-task supplies it', () => {
  const event = readPiTaskSessionEvent({
    role: 'custom',
    customType: 'task-session',
    display: false,
    content: '',
    details: { task_id: 't1', session_id: 'child', pi_tool_call_id: 'call-9' }
  })

  assert.deepEqual(event, {
    taskId: 't1',
    sessionId: 'child',
    piToolCallId: 'call-9',
    kind: 'task-session'
  })

  const withoutId = readPiTaskSessionEvent({
    role: 'custom',
    customType: 'task-session',
    display: false,
    content: '',
    details: { task_id: 't1', session_id: 'child' }
  })

  assert.deepEqual(withoutId, { taskId: 't1', sessionId: 'child', kind: 'task-session' })
})

test('readPiTaskSessionEvent reads the live link from a session entry', () => {
  assert.deepEqual(
    readPiTaskSessionEvent({
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 't1', session_id: 'child', pi_tool_call_id: 'call-9' }
    }),
    { taskId: 't1', sessionId: 'child', piToolCallId: 'call-9', kind: 'task-session' }
  )

  assert.deepEqual(
    readPiTaskSessionEvent({
      type: 'custom',
      customType: 'task-complete',
      data: { task_id: 't1', session_id: 'child' }
    }),
    { taskId: 't1', sessionId: 'child', kind: 'task-complete' }
  )
})

test('readPiTaskSessionEvent rejects entries and messages that are not links', () => {
  const cases: unknown[] = [
    // A link without a child session cannot be used.
    { type: 'custom', customType: 'task-session', data: { task_id: 't1' } },
    { type: 'custom', customType: 'other', data: { task_id: 't1', session_id: 'child' } },
    { type: 'custom', customType: 'task-session', data: { session_id: 'child' } },
    { type: 'message', customType: 'task-session', data: { task_id: 't1', session_id: 'child' } },
    // A visible custom message is not the hidden durable link.
    {
      role: 'custom',
      customType: 'task-session',
      display: true,
      content: 'shown',
      details: { task_id: 't1', session_id: 'child' }
    },
    { role: 'custom', customType: 'task-session', display: false, details: { task_id: 't1' } },
    null
  ]

  for (const value of cases) {
    assert.equal(readPiTaskSessionEvent(value), null, JSON.stringify(value))
  }
})

test('readPiTaskToolResult only trusts sdk task results', () => {
  assert.deepEqual(
    readPiTaskToolResult({
      details: { task_id: 't1', backend: 'sdk', session_id: 'child', background: true }
    }),
    { taskId: 't1', sessionId: 'child', background: true }
  )

  assert.equal(readPiTaskToolResult({ details: { task_id: 't1', backend: 'tmux', session_id: 'child' } }), null)
  assert.equal(readPiTaskToolResult({ details: { backend: 'sdk' } }), null)
})

test('readPiTaskSessionEventsFromSessionFile recovers durable links and skips malformed lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-task-links-'))
  const file = join(dir, 'session.jsonl')

  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: '/repo' }),
      '{ "type": "custom", "customType": "task-sess',
      JSON.stringify({
        type: 'custom',
        customType: 'task-session',
        data: { task_id: 't1', session_id: 'child-1', pi_tool_call_id: 'call-1' }
      }),
      '',
      JSON.stringify({
        type: 'custom',
        customType: 'task-session',
        data: { task_id: 't2', session_id: 'child-2' }
      }),
      JSON.stringify({ type: 'custom', customType: 'task-complete', data: { task_id: 't1', session_id: 'child-1' } })
    ].join('\n') +
      '\n' +
      '{"type":"custom","customType":"task-sess',
    { encoding: 'utf8' }
  )

  assert.deepEqual(await readPiTaskSessionEventsFromSessionFile(file), [
    { taskId: 't1', sessionId: 'child-1', piToolCallId: 'call-1', kind: 'task-session' },
    { taskId: 't2', sessionId: 'child-2', kind: 'task-session' },
    { taskId: 't1', sessionId: 'child-1', kind: 'task-complete' }
  ])
})

test('readPiTaskSessionEventsFromSessionFile returns nothing when the file is unreadable', async () => {
  assert.deepEqual(await readPiTaskSessionEventsFromSessionFile('/definitely/missing/session.jsonl'), [])
})
