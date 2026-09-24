import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// The cap is read when the manager is constructed, so pin it for this file.
const previousCap = process.env.PI_ACP_MAX_RESIDENT_SESSIONS
process.env.PI_ACP_MAX_RESIDENT_SESSIONS = '2'
after(() => {
  if (previousCap === undefined) delete process.env.PI_ACP_MAX_RESIDENT_SESSIONS
  else process.env.PI_ACP_MAX_RESIDENT_SESSIONS = previousCap
})

function trackedProcess() {
  return Object.assign(new FakePiRpcProcess(), {
    disposed: false,
    dispose() {
      this.disposed = true
    }
  })
}

function managerWithSessions(ids: string[]) {
  const manager = new SessionManager()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const procs = new Map<string, ReturnType<typeof trackedProcess>>()

  const add = (id: string) => {
    const proc = trackedProcess()
    procs.set(id, proc)
    manager.getOrCreate(id, { cwd: '/repo', mcpServers: [], proc: proc as any, conn })
    return proc
  }

  for (const id of ids) add(id)

  return { manager, procs, add }
}

test('SessionManager keeps only the most recently used sessions under the resident cap', () => {
  const { manager, procs } = managerWithSessions(['a', 'b', 'c', 'd'])

  manager.touch('c')
  manager.touch('d')

  assert.equal(procs.get('a')!.disposed, true, 'the oldest idle session is released first')
  assert.equal(procs.get('b')!.disposed, true, 'then the next oldest')
  assert.equal(procs.get('c')!.disposed, false)
  assert.equal(procs.get('d')!.disposed, false)
  assert.equal(manager.maybeGet('a'), undefined)
})

test('SessionManager keeps the lineage of the session the client is using', () => {
  const { manager, procs } = managerWithSessions(['parent', 'child', 'other'])
  manager.registerSubagentSession('parent', 'child')

  // Touching the child protects its parent chain, so the unrelated session goes instead.
  manager.touch('child')

  assert.equal(procs.get('other')!.disposed, true)
  assert.equal(procs.get('parent')!.disposed, false)
  assert.equal(procs.get('child')!.disposed, false)
})

test('SessionManager never evicts a session a task owns or a turn is running in', async () => {
  const { manager, procs } = managerWithSessions(['busy-task', 'busy-turn', 'spare', 'newest'])

  manager.markSubagentSessionActive('busy-task', 'task-1')
  const turn = manager.get('busy-turn').prompt('continue')

  manager.touch('newest')

  assert.equal(procs.get('busy-task')!.disposed, false, 'a task still owns its child session')
  assert.equal(procs.get('busy-turn')!.disposed, false, 'a running turn keeps its process')
  assert.equal(procs.get('spare')!.disposed, true, 'the idle spare is released instead')

  procs.get('busy-turn')!.emit({ type: 'agent_settled' } as any)
  await turn
})

test('SessionManager never evicts a session with an in-flight request', () => {
  const { manager, procs, add } = managerWithSessions(['a', 'b', 'c'])

  // `a` is the oldest, but a client request is using it, so the next oldest idle session goes
  // instead. Evicting `a` would reject that request's own RPC with "pi process exited".
  const release = manager.beginRequest('a')
  manager.touch('c')

  assert.equal(procs.get('a')!.disposed, false, 'the leased session survives')
  assert.equal(procs.get('b')!.disposed, true, 'the eviction falls through to the next idle session')
  assert.equal(procs.get('c')!.disposed, false)

  release()
  add('d')
  manager.touch('d')
  assert.equal(procs.get('a')!.disposed, true, 'once the lease is released the session is evictable again')
})

test('SessionManager holds overlapping requests for the same session until all release', () => {
  const { manager, procs, add } = managerWithSessions(['a', 'b', 'c'])

  const releaseFirst = manager.beginRequest('a')
  const releaseSecond = manager.beginRequest('a')
  releaseFirst()

  manager.touch('c')
  assert.equal(procs.get('a')!.disposed, false, 'the second request still holds the session')

  releaseSecond()
  releaseSecond()
  add('d')
  manager.touch('d')
  assert.equal(procs.get('a')!.disposed, true, 'releasing twice is harmless and the session is free')
})

test('SessionManager cap and close-others both respect a lease', () => {
  const { manager, procs } = managerWithSessions(['a', 'b'])

  const release = manager.beginRequest('a')
  assert.deepEqual(manager.trimResidentSessions(), [], 'the cap skips a session in use')

  manager.closeAllExcept('b')
  assert.equal(procs.get('a')!.disposed, false, 'close-others must not close a leased session')

  release()
  manager.closeAllExcept('b')
  assert.equal(procs.get('a')!.disposed, true)
})

test('SessionManager lets an explicit release end a lease', () => {
  const { manager, procs } = managerWithSessions(['child', 'parent'])

  // The load path deliberately hands a finished subagent viewer back while its own request is
  // still running, so an explicit release is not gated by the lease.
  const release = manager.beginRequest('child')
  assert.equal(manager.releaseIdleSession('child'), true)
  assert.equal(procs.get('child')!.disposed, true)
  release()
})

test('SessionManager forgets a closed session so it stops holding a cap slot', () => {
  const { manager, procs } = managerWithSessions(['a', 'b', 'c'])

  manager.touch('a')
  manager.touch('b')
  manager.close('b')

  // With `b` still remembered, the keep set would be `{b, c}` and the live, recently used `a`
  // would be evicted. Forgetting the closed id keeps `a` inside the cap window.
  manager.touch('c')

  assert.equal(procs.get('a')!.disposed, false, 'the recently used session keeps its process')
  assert.equal(procs.get('c')!.disposed, false)
})
