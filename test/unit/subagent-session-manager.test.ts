import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function trackedProcess() {
  const proc = Object.assign(new FakePiRpcProcess(), {
    disposed: false,
    dispose() {
      this.disposed = true
    }
  })
  return proc
}

test('SessionManager prunes lineage for a deleted session only', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())

  manager.registerSubagentSession('parent', 'child')
  assert.equal(manager.isSubagentSession('child'), true)

  // Reloading a child closes its process; the lineage must survive so the parent stays live.
  manager.getOrCreate('child', {
    cwd: '/repo',
    mcpServers: [],
    proc: trackedProcess() as any,
    conn
  })
  manager.close('child')
  assert.equal(manager.isSubagentSession('child'), true)

  manager.forgetSubagentSession('child')
  assert.equal(manager.isSubagentSession('child'), false)
  assert.deepEqual([...manager.sessionLineageIds('parent')], ['parent'])
})

test('SessionManager: a live task link makes the child read-only until the task completes', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const parentProc = trackedProcess()
  const childProc = trackedProcess()

  manager.getOrCreate('parent', { cwd: '/repo', mcpServers: [], proc: parentProc as any, conn })
  manager.getOrCreate('child', { cwd: '/repo', mcpServers: [], proc: childProc as any, conn })

  parentProc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: 'call-1' }
    }
  })
  assert.throws(() => manager.assertSessionMutable('child'), /read-only/)

  parentProc.emit({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'task-complete', data: { task_id: 'task-1', session_id: 'child' } }
  })
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))

  manager.recycleStaleSubagentSession('child')
  assert.equal(childProc.disposed, true)
  assert.equal(manager.maybeGet('child'), undefined)
})

test('SessionManager: a foreground task result releases the child session', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const parentProc = trackedProcess()

  manager.getOrCreate('parent', { cwd: '/repo', mcpServers: [], proc: parentProc as any, conn })
  manager.getOrCreate('child', {
    cwd: '/repo',
    mcpServers: [],
    proc: trackedProcess() as any,
    conn
  })

  parentProc.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'task', args: {} })
  parentProc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: 'call-1' }
    }
  })
  assert.throws(() => manager.assertSessionMutable('child'), /read-only/)

  parentProc.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    isError: false,
    result: { details: { task_id: 'task-1', backend: 'sdk', session_id: 'child', background: false } }
  })
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))
})

test('SessionManager keeps linked parent and child processes when a subagent is loaded', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const parentProc = trackedProcess()
  const childProc = trackedProcess()
  const siblingProc = trackedProcess()
  const unrelatedProc = trackedProcess()

  manager.getOrCreate('parent', {
    cwd: '/repo',
    mcpServers: [],
    proc: parentProc as any,
    conn
  })
  const parent = manager.get('parent')
  parentProc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: { task_id: 'task-1', session_id: 'child' }
    }
  })
  parentProc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'task-session',
      display: false,
      content: '',
      details: { task_id: 'task-2', session_id: 'sibling' }
    }
  })

  manager.getOrCreate('child', {
    cwd: '/repo',
    mcpServers: [],
    proc: childProc as any,
    conn
  })
  manager.getOrCreate('sibling', {
    cwd: '/repo',
    mcpServers: [],
    proc: siblingProc as any,
    conn
  })
  manager.getOrCreate('unrelated', {
    cwd: '/repo',
    mcpServers: [],
    proc: unrelatedProc as any,
    conn
  })

  // loadSession closes and recreates the requested process, but retains its relationship.
  manager.close('child')
  const reloadedChildProc = trackedProcess()
  manager.getOrCreate('child', {
    cwd: '/repo',
    mcpServers: [],
    proc: reloadedChildProc as any,
    conn
  })
  manager.closeAllExcept(manager.sessionLineageIds('child'))

  assert.equal(parentProc.disposed, false)
  assert.equal(childProc.disposed, true)
  assert.equal(reloadedChildProc.disposed, false)
  assert.equal(siblingProc.disposed, true)
  assert.equal(unrelatedProc.disposed, true)

  const reloadedSiblingProc = trackedProcess()
  manager.getOrCreate('sibling', {
    cwd: '/repo',
    mcpServers: [],
    proc: reloadedSiblingProc as any,
    conn
  })
  manager.closeAllExcept(manager.sessionLineageIds('sibling'))

  assert.equal(parentProc.disposed, false)
  assert.equal(reloadedChildProc.disposed, true)
  assert.equal(reloadedSiblingProc.disposed, false)
  assert.equal(parent.sessionId, 'parent')
})

test('SessionManager ignores a delayed completion from an earlier resumed task run', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const parentProc = trackedProcess()

  manager.getOrCreate('parent', { cwd: '/repo', mcpServers: [], proc: parentProc as any, conn })
  manager.getOrCreate('child', { cwd: '/repo', mcpServers: [], proc: trackedProcess() as any, conn })

  const link = (toolCallId: string) =>
    parentProc.emit({
      type: 'entry_appended',
      entry: {
        type: 'custom',
        customType: 'task-session',
        data: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: toolCallId }
      }
    })
  const complete = (toolCallId: string) =>
    parentProc.emit({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'task-complete',
        display: true,
        content: 'done',
        details: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: toolCallId }
      }
    })

  parentProc.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'task', args: {} })
  link('call-1')
  complete('call-1')
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))

  parentProc.emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'task', args: {} })
  link('call-2')
  complete('call-1')
  assert.throws(() => manager.assertSessionMutable('child'), /read-only/)

  complete('call-2')
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))
})

test('SessionManager releases a child run when the parent pi process exits', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const parentProc = trackedProcess()
  const childProc = trackedProcess()

  manager.getOrCreate('parent', { cwd: '/repo', mcpServers: [], proc: parentProc as any, conn })
  manager.getOrCreate('child', { cwd: '/repo', mcpServers: [], proc: childProc as any, conn })
  manager.registerSubagentSession('parent', 'child')

  parentProc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'task-session',
      data: { task_id: 'task-1', session_id: 'child', pi_tool_call_id: 'call-1' }
    }
  })
  assert.throws(() => manager.assertSessionMutable('child'), /read-only/)

  // A dead pi can never emit the completion that would release the child, so the exit
  // hook has to do it or the child stays read-only until the agent restarts.
  parentProc.exit()
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))

  // Nothing is using the child, so its viewer process is freed instead of merely marked.
  assert.equal(childProc.disposed, true)
  assert.equal(manager.maybeGet('child'), undefined)
})

test('SessionManager marks a busy child stale instead of releasing it mid-turn', async () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const childProc = trackedProcess()

  const child = manager.getOrCreate('child', { cwd: '/repo', mcpServers: [], proc: childProc as any, conn })
  manager.markSubagentSessionActive('child', 'task-1')

  // A turn is in flight, so the process must not be pulled out from under it.
  const turn = child.prompt('continue')
  manager.markSubagentSessionCompleted('child', 'task-1')

  assert.equal(childProc.disposed, false, 'a mid-turn child keeps its process')
  assert.equal(manager.recycleStaleSubagentSession('child'), true)
  assert.equal(childProc.disposed, true)

  // A second call has nothing left to release.
  assert.equal(manager.recycleStaleSubagentSession('child'), false)

  childProc.emit({ type: 'agent_settled' })
  await turn
})

test('SessionManager releases an idle child viewer as soon as its task completes', () => {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const childProc = trackedProcess()

  manager.getOrCreate('child', { cwd: '/repo', mcpServers: [], proc: childProc as any, conn })
  manager.markSubagentSessionActive('child', 'task-1')
  manager.markSubagentSessionCompleted('child', 'task-1')

  // The task no longer owns the transcript, so the viewer process is freed instead of
  // staying resident next to the parent's process.
  assert.equal(childProc.disposed, true)
  assert.equal(manager.maybeGet('child'), undefined)
  assert.doesNotThrow(() => manager.assertSessionMutable('child'))
})
