import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession() {
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

  return { session, proc, conn }
}

function settleTurn(proc: FakePiRpcProcess) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

// The adapter queues prompts itself instead of handing them to pi's steering/follow-up queue, so
// the delivery shape is its own: one message per turn, which is pi's `one-at-a-time` default.
// `/steering` and `/follow-up` set pi's queue modes and do not change this.
test('PiAcpSession: prompts sent during a turn are delivered one per turn', async () => {
  const { session, proc } = createSession()

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  assert.equal(proc.prompts.length, 1, 'only the running turn was sent to pi')
  assert.equal(proc.prompts[0]?.message, 'one')

  settleTurn(proc)
  assert.equal(await first, 'end_turn')

  assert.equal(proc.prompts.length, 2, 'the next queued message starts its own turn')
  assert.equal(proc.prompts[1]?.message, 'two')

  settleTurn(proc)
  assert.equal(await second, 'end_turn')

  assert.equal(proc.prompts.length, 3)
  assert.equal(proc.prompts[2]?.message, 'three')

  settleTurn(proc)
  assert.equal(await third, 'end_turn')
})

test('PiAcpSession: each queued prompt resolves on its own turn', async () => {
  const { session, proc } = createSession()

  const first = session.prompt('one')
  const second = session.prompt('two')

  settleTurn(proc)
  assert.equal(await first, 'end_turn')

  let secondResolved = false
  void second.then(() => {
    secondResolved = true
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(secondResolved, false, 'the queued prompt waits for its own turn')

  settleTurn(proc)
  assert.equal(await second, 'end_turn')
})
