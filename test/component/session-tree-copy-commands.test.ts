import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SESSION_ID = 's1'

function harness(procOverrides: Record<string, unknown> = {}) {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-tree-')), 'session.jsonl')
  writeFileSync(sessionFile, '', 'utf8')

  const proc = new FakePiRpcProcess() as any
  Object.assign(proc, {
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
    getAvailableThinkingLevels: async () => ['off', 'medium'],
    getState: async () => ({ sessionId: SESSION_ID, sessionFile, thinkingLevel: 'medium' }),
    getSessionStats: async () => ({}),
    ...procOverrides
  })

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId: SESSION_ID, cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }),
    upsert() {}
  }

  return {
    agent,
    conn,
    proc,
    texts: () =>
      conn.updates
        .map(update => (update.update as any)?.content?.text)
        .filter((text): text is string => typeof text === 'string'),
    restore: () => {
      PiRpcProcess.spawn = originalSpawn
    }
  }
}

test('PiAcpAgent: /tree lists the active branch of the session tree', async () => {
  const h = harness({
    getTree: async () => ({
      tree: [
        {
          entry: { type: 'message', id: 'aaa11111', message: { role: 'user', content: 'Fix the bug' } },
          children: [
            {
              entry: {
                type: 'message',
                id: 'bbb22222',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Starting now' }] }
              },
              children: [
                {
                  entry: {
                    type: 'message',
                    id: 'ccc33333',
                    message: { role: 'user', content: 'Also update the docs' }
                  },
                  children: []
                },
                {
                  entry: { type: 'message', id: 'ddd44444', message: { role: 'user', content: 'Abandoned attempt' } },
                  children: []
                }
              ]
            }
          ]
        }
      ],
      leafId: 'ccc33333'
    })
  })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/tree' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, /Session tree: 4 entries, 1 branch point/)
    assert.match(text, /Active branch: 3 entries/)

    // The digest shows where the branches are, not only the active path.
    assert.match(text, /Branch at assistant: Starting now \(bbb22222\):/)
    assert.match(text, /- user: Also update the docs \(ccc33333\) <- active/)
    assert.match(text, /- user: Abandoned attempt \(ddd44444\)/)

    assert.match(text, /Active branch tail:/)
    assert.match(text, /- user: Fix the bug \(aaa11111\)/)
    assert.match(text, /- user: Also update the docs \(ccc33333\) <- current/)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /tree truncates a long branch instead of flooding the chat', async () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    type: 'message',
    id: `entry-${String(index).padStart(4, '0')}`,
    message: { role: 'user', content: `turn ${index}` }
  }))

  const h = harness({
    getTree: async () => ({
      tree: [
        entries.reduceRight<Record<string, unknown> | null>(
          (child, entry) => ({ entry, children: child ? [child] : [] }),
          null
        )
      ],
      leafId: 'entry-0039'
    })
  })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/tree' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, /Session tree: 40 entries, no branches/)
    assert.match(text, /Active branch tail \(last 8 of 40\):/)
    assert.doesNotMatch(text, /turn 0\b/)
    assert.match(text, /turn 39 \(entry-00\) <- current/)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /tree reports an empty session', async () => {
  const h = harness({ getTree: async () => ({ tree: [], leafId: null }) })
  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/tree' }] } as any)
    assert.equal(h.texts().at(-1), 'Session tree is empty.')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /copy re-prints the last assistant message', async () => {
  const h = harness({ getLastAssistantText: async () => 'The answer is 42.' })
  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/copy' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, /Last assistant message \(select to copy\)/)
    assert.match(text, /The answer is 42\./)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /copy says so when there is nothing to copy', async () => {
  const h = harness({ getLastAssistantText: async () => null })
  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/copy' }] } as any)
    assert.equal(h.texts().at(-1), 'No assistant text to copy yet.')
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /tree falls back to the flat entries when pi cannot build the tree', async () => {
  const h = harness({
    // pi recurses while building the tree and overflows on long sessions.
    getTree: async () => {
      throw new Error('pi get_tree failed: Maximum call stack size exceeded')
    },
    getEntries: async () => ({
      entries: [
        { type: 'model_change', id: 'e0', parentId: null, provider: 'test', modelId: 'alpha' },
        { type: 'message', id: 'e1', parentId: 'e0', message: { role: 'user', content: 'Do the thing' } },
        { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: 'Done' } },
        { type: 'message', id: 'e3', parentId: 'e1', message: { role: 'assistant', content: 'Abandoned' } }
      ],
      leafId: 'e2'
    })
  })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/tree' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, /Session tree: 4 entries, 1 branch point/)
    assert.match(text, /Branch at user: Do the thing \(e1\):/)
    assert.match(text, /- assistant: Done \(e2\) <- active/)
    assert.match(text, /- assistant: Abandoned \(e3\)/)
    assert.match(text, /Active branch tail:/)
    assert.match(text, /- model: test\/alpha \(e0\)/)
    assert.match(text, /- assistant: Done \(e2\) <- current/)
  } finally {
    h.restore()
  }
})

test('PiAcpAgent: /tree handles a tree thousands of nodes deep', async () => {
  // A long session is one chain thousands of entries deep; recursive tree walks overflow there.
  const depth = 6000
  let node: any = {
    entry: { type: 'message', id: 'n0', parentId: null, message: { role: 'user', content: 'turn 0' } },
    children: []
  }
  const root = node
  for (let index = 1; index < depth; index += 1) {
    const child = {
      entry: {
        type: 'message',
        id: `n${index}`,
        parentId: `n${index - 1}`,
        message: { role: 'user', content: `turn ${index}` }
      },
      children: []
    }
    node.children.push(child)
    node = child
  }

  const h = harness({ getTree: async () => ({ tree: [root], leafId: `n${depth - 1}` }) })

  try {
    await h.agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: '/tree' }] } as any)

    const text = h.texts().at(-1) ?? ''
    assert.match(text, new RegExp(`Session tree: ${depth} entries, no branches`))
    assert.match(text, new RegExp(`Active branch tail \\(last 8 of ${depth}\\):`))
    assert.match(text, new RegExp(`turn ${depth - 1} .* <- current`))
  } finally {
    h.restore()
  }
})
