import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(options: { supportsFormElicitation?: () => boolean } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsFormElicitation: options.supportsFormElicitation
  })

  return { session, proc, conn }
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const INPUT_REQUEST = {
  type: 'extension_ui_request',
  id: 'ui-1',
  method: 'input',
  title: 'Enter a value',
  placeholder: 'type something...'
}

test('PiAcpSession: maps an extension input request to an ACP elicitation form', async () => {
  const { proc, conn } = createSession({ supportsFormElicitation: () => true })

  proc.emit(INPUT_REQUEST as any)
  await flush()

  const request = conn.elicitationRequests[0] as any
  assert.equal(request?.mode, 'form')
  assert.equal(request?.sessionId, 's1')
  assert.equal(request?.message, 'Enter a value')
  assert.equal(request?.requestedSchema?.type, 'object')
  assert.equal(request?.requestedSchema?.properties?.value?.type, 'string')
  assert.equal(request?.requestedSchema?.properties?.value?.description, 'type something...')
  assert.deepEqual(request?.requestedSchema?.required, ['value'])

  assert.deepEqual(proc.extensionUiResponses.at(-1), { id: 'ui-1', value: 'typed by user' })
})

test('PiAcpSession: an editor request carries its prefill as the form default', async () => {
  const { proc, conn } = createSession({ supportsFormElicitation: () => true })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'editor',
    title: 'Edit some text',
    prefill: 'Line 1\nLine 2'
  } as any)
  await flush()

  const request = conn.elicitationRequests[0] as any
  assert.equal(request?.requestedSchema?.properties?.value?.default, 'Line 1\nLine 2')
  assert.equal(request?.requestedSchema?.properties?.value?.title, 'Edit some text')
})

test('PiAcpSession: a declined or cancelled elicitation cancels the pi request', async () => {
  const { proc, conn } = createSession({ supportsFormElicitation: () => true })

  conn.nextElicitationResponse = { action: 'decline' }
  proc.emit(INPUT_REQUEST as any)
  await flush()
  assert.deepEqual(proc.extensionUiResponses.at(-1), { id: 'ui-1', cancelled: true })

  conn.nextElicitationResponse = { action: 'cancel' }
  proc.emit({ ...INPUT_REQUEST, id: 'ui-3' } as any)
  await flush()
  assert.deepEqual(proc.extensionUiResponses.at(-1), { id: 'ui-3', cancelled: true })
})

test('PiAcpSession: an accepted elicitation without content cancels the pi request', async () => {
  const { proc, conn } = createSession({ supportsFormElicitation: () => true })

  conn.nextElicitationResponse = { action: 'accept', content: {} }
  proc.emit(INPUT_REQUEST as any)
  await flush()

  assert.deepEqual(proc.extensionUiResponses.at(-1), { id: 'ui-1', cancelled: true })
})

test('PiAcpSession: without elicitation support the request is cancelled with an accurate notice', async () => {
  const { proc, conn } = createSession({ supportsFormElicitation: () => false })

  proc.emit(INPUT_REQUEST as any)
  await flush()

  assert.deepEqual(conn.elicitationRequests, [], 'no elicitation is sent to a client that cannot handle it')
  assert.deepEqual(proc.extensionUiResponses.at(-1), { id: 'ui-1', cancelled: true })

  const notice = conn.updates
    .map(update => (update.update as any)?.content?.text)
    .filter((text): text is string => typeof text === 'string')
    .at(-1)
  assert.match(notice ?? '', /needs a client that supports ACP elicitation/)
})

// The capability arrives in initialize and has to reach the restored session, so pin the wiring
// end to end: without it a client that supports elicitation would still get its requests cancelled.
test('PiAcpAgent: passes the client elicitation capability to restored sessions', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawned: any = null
  ;(PiRpcProcess as any).spawn = async () => {
    spawned = new FakePiRpcProcess()
    return Object.assign(spawned, {
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    })
  }

  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-elicit-wiring-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => ({ sessionId: 's1', cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
      upsert() {}
    }

    await agent.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    spawned.emit({ type: 'extension_ui_request', id: 'ui-9', method: 'input', title: 'Value?' } as any)
    await flush()

    assert.equal(conn.elicitationRequests.length, 1, 'the restored session knows the client can handle elicitation')
    assert.deepEqual(spawned.extensionUiResponses.at(-1), { id: 'ui-9', value: 'typed by user' })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: a client without the capability keeps the cancel path', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawned: any = null
  ;(PiRpcProcess as any).spawn = async () => {
    spawned = new FakePiRpcProcess()
    return Object.assign(spawned, {
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => null,
      getState: async () => ({ thinkingLevel: 'medium' })
    })
  }

  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-elicit-absent-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => ({ sessionId: 's1', cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
      upsert() {}
    }

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    spawned.emit({ type: 'extension_ui_request', id: 'ui-10', method: 'input', title: 'Value?' } as any)
    await flush()

    assert.deepEqual(conn.elicitationRequests, [])
    assert.deepEqual(spawned.extensionUiResponses.at(-1), { id: 'ui-10', cancelled: true })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
