import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SESSION_ID = 's1'

type HarnessOptions = {
  forkable?: Array<{ entryId: string; text: string }>
  forkedId?: string
  supportsElicitation?: boolean
  elicitationChoice?: string
  forkCancelled?: boolean
  cloneCancelled?: boolean
}

function harness(options: HarnessOptions = {}) {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-fork-cmd-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  const upserts: Array<{ sessionId: string }> = []
  let forked = false
  let disposeCount = 0

  const proc = new FakePiRpcProcess() as any
  Object.assign(proc, {
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
    getAvailableThinkingLevels: async () => ['off', 'medium'],
    getState: async () =>
      forked
        ? { sessionId: options.forkedId ?? 'forked-thread', sessionFile: join(sessionFile, '..', 'forked.jsonl') }
        : { sessionId: SESSION_ID, sessionFile },
    getForkMessages: async () => ({ messages: options.forkable ?? [] }),
    clone: async () => {
      if (options.cloneCancelled) return { cancelled: true }
      forked = true
      return { cancelled: false }
    },
    fork: async () => {
      if (options.forkCancelled) return { cancelled: true }
      forked = true
      return { cancelled: false, text: 'the forked message' }
    },
    dispose: () => {
      disposeCount += 1
    }
  })

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  const conn = new FakeAgentSideConnection()
  conn.nextElicitationResponse = options.elicitationChoice
    ? { action: 'accept', content: { choice: options.elicitationChoice } }
    : { action: 'decline' }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId: SESSION_ID, cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
    upsert: (entry: { sessionId: string }) => {
      upserts.push(entry)
    }
  }

  return {
    agent,
    conn,
    proc,
    upserts,
    disposeCount: () => disposeCount,
    texts: () =>
      conn.updates
        .map(update => (update.update as any)?.content?.text)
        .filter((text): text is string => typeof text === 'string'),
    restore: () => {
      PiRpcProcess.spawn = originalSpawn
    }
  }
}

async function enableElicitation(agent: PiAcpAgent) {
  await agent.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } as any)
}

test('PiAcpAgent: /clone creates a new thread and releases the rebound process', async () => {
  const h = harness()
  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/clone' }] } as any)

    assert.match(h.texts().at(-1) ?? '', /Cloned into a new thread \(forked-thread\)/)
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SESSION_ID).map(entry => entry.sessionId),
      ['forked-thread'],
      'the new thread is resumable from the store'
    )
    assert.equal(h.disposeCount(), 1)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /fork asks the client to pick a message', async () => {
  const h = harness({
    forkable: [
      { entryId: 'entry-a', text: 'First prompt' },
      { entryId: 'entry-b', text: 'Second prompt' }
    ],
    elicitationChoice: '2. Second prompt'
  })

  try {
    await enableElicitation(h.agent)
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/fork' }] } as any)

    const request = h.conn.elicitationRequests[0] as any
    assert.equal(request?.mode, 'form')
    assert.equal(request?.message, 'Fork from which message?')
    assert.deepEqual(request?.requestedSchema?.properties?.choice?.enum, ['1. First prompt', '2. Second prompt'])

    assert.match(h.texts().at(-1) ?? '', /Forked into a new thread \(forked-thread\)/)
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SESSION_ID).map(entry => entry.sessionId),
      ['forked-thread']
    )
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /fork accepts an explicit fork point', async () => {
  const h = harness({
    forkable: [
      { entryId: 'entry-a', text: 'First prompt' },
      { entryId: 'entry-b', text: 'Second prompt' }
    ]
  })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/fork 1' }] } as any)

    assert.deepEqual(h.conn.elicitationRequests, [], 'no picker is needed when the point is given')
    assert.match(h.texts().at(-1) ?? '', /Forked into a new thread/)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /fork lists the points when the client has no picker', async () => {
  const h = harness({
    forkable: [
      { entryId: 'entry-a', text: 'First prompt' },
      { entryId: 'entry-b', text: 'Second prompt' }
    ]
  })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/fork' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, /pass the fork point: \/fork <number>/)
    assert.match(text, /1\. First prompt/)
    assert.match(text, /2\. Second prompt/)
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SESSION_ID),
      []
    )
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: a declined picker cancels the fork', async () => {
  const h = harness({
    forkable: [{ entryId: 'entry-a', text: 'First prompt' }],
    elicitationChoice: undefined
  })

  try {
    await enableElicitation(h.agent)
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/fork' }] } as any)

    assert.equal(h.texts().at(-1), 'Fork cancelled.')
    assert.deepEqual(
      h.upserts.filter(entry => entry.sessionId !== SESSION_ID),
      []
    )
    assert.equal(h.disposeCount(), 0)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /fork reports when there is nothing to fork from', async () => {
  const h = harness({ forkable: [] })
  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/fork' }] } as any)
    assert.equal(h.texts().at(-1), 'No user messages to fork from.')
  } finally {
    h.restore()
  }
})
