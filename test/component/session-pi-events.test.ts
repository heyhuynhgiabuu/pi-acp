import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(options: { onThinkingLevelChanged?: (sessionId: string, proc: unknown) => void } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    onThinkingLevelChanged: options.onThinkingLevelChanged as any
  })

  return { session, proc, conn }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function texts(conn: FakeAgentSideConnection): string[] {
  return conn.updates
    .map(update => (update.update as any)?.content?.text)
    .filter((text): text is string => typeof text === 'string')
}

test('PiAcpSession: reports an automatic compaction with its outcome', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({ type: 'compaction_start', reason: 'threshold' } as any)
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: { summary: 'Summarized the first 20 turns', tokensBefore: 150000, estimatedTokensAfter: 32000 },
    aborted: false,
    willRetry: false
  } as any)

  await flush()
  const messages = texts(conn)
  assert.match(messages[0] ?? '', /automatic compaction/)
  assert.match(messages[1] ?? '', /Summarized the first 20 turns/)
  assert.match(messages[1] ?? '', /tokens before: 150000/)
})

test('PiAcpSession: reports a failed or aborted compaction', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({ type: 'compaction_start', reason: 'overflow' } as any)
  proc.emit({ type: 'compaction_end', reason: 'overflow', aborted: false, errorMessage: 'provider exploded' } as any)
  await flush()

  assert.match(texts(conn)[1] ?? '', /Compaction failed: provider exploded/)

  proc.emit({ type: 'compaction_start', reason: 'threshold' } as any)
  proc.emit({ type: 'compaction_end', reason: 'threshold', aborted: true } as any)
  await flush()

  assert.match(texts(conn)[3] ?? '', /Compaction was aborted/)
})

test('PiAcpSession: a manual compaction is reported by the command, not twice', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({ type: 'compaction_start', reason: 'manual' } as any)
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'manual summary' } } as any)

  assert.deepEqual(texts(conn), [])
})

test('PiAcpSession: still understands the legacy auto_compaction events', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({ type: 'auto_compaction_start', reason: 'threshold' } as any)
  proc.emit({ type: 'auto_compaction_end', reason: 'threshold', result: { summary: 'legacy summary' } } as any)

  await flush()
  const messages = texts(conn)
  assert.equal(messages.length, 2)
  assert.match(messages[1] ?? '', /legacy summary/)
})

test('PiAcpSession: keeps the client session title in sync when pi renames it', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({ type: 'session_info_changed', name: 'Renamed in pi' } as any)
  proc.emit({ type: 'session_info_changed' } as any)

  await flush()
  const updates = conn.updates
    .map(update => update.update as any)
    .filter(update => update.sessionUpdate === 'session_info_update')
  assert.equal(updates.length, 2)
  assert.equal(updates[0]?.title, 'Renamed in pi')
  assert.equal(updates[1]?.title, null)
})

test('PiAcpSession: surfaces extension errors as a warning', async () => {
  const { proc, conn } = createSession()
  await flush()

  proc.emit({
    type: 'extension_error',
    extensionPath: '/Users/someone/.pi/extensions/broken.ts',
    event: 'tool_call',
    error: 'cannot read properties of undefined'
  } as any)

  await flush()
  const update = conn.updates.at(-1) as any
  assert.match(update?.update?.content?.text ?? '', /broken\.ts/)
  assert.match(update?.update?.content?.text ?? '', /tool_call/)
  assert.match(update?.update?.content?.text ?? '', /cannot read properties/)
  assert.equal(update?.update?._meta?.piAcp?.notify?.level, 'warning')
})

test('PiAcpSession: forwards a thinking level change to the client', async () => {
  const seen: string[] = []
  const { proc, conn } = createSession({
    onThinkingLevelChanged: (sessionId, procArg) => {
      seen.push(`${sessionId}:${procArg === undefined ? 'missing-proc' : 'proc'}`)
    }
  })

  proc.emit({ type: 'thinking_level_changed', level: 'xhigh' } as any)

  await flush()
  const update = conn.updates.at(-1) as any
  assert.equal(update?.update?.sessionUpdate, 'current_mode_update')
  assert.equal(update?.update?.currentModeId, 'xhigh')
  assert.deepEqual(seen, ['s1:proc'])
})
