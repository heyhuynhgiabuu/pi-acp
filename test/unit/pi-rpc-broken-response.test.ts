import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { PiRpcProcess } from '../../src/pi-rpc/process.js'

type FakeChild = { child: any; stdout: PassThrough; written: string[] }

function makeFakeChild(): FakeChild {
  const stdout = new PassThrough()
  const written: string[] = []
  const child: any = new EventEmitter()
  child.stdout = stdout
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {}
  child.stdin = {
    write: (line: string, cb?: (error?: Error | null) => void) => {
      written.push(String(line))
      cb?.(null)
      return true
    }
  }
  return { child, stdout, written }
}

function makeProcess(child: any): PiRpcProcess {
  return new (PiRpcProcess as unknown as new (c: any) => PiRpcProcess)(child)
}

function nextTicks(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)))
}

// A response line can be unparseable in practice: pi fails while serializing a very deep tree, or a
// line gets truncated. Treating that as a prelude line used to leave the request pending until its
// timeout, so callers could not fall back.
test('PiRpcProcess: an unparseable response rejects its request instead of hanging', async () => {
  const { child, stdout, written } = makeFakeChild()
  const proc = makeProcess(child)

  const request = proc.getTree()
  // Attach the assertion before the rejection lands, or the runner sees an unhandled rejection.
  const rejected = assert.rejects(() => request, /could not be parsed/)
  const sent = JSON.parse(written[0]) as { id: string }

  // Not valid JSON, but clearly a response for that id.
  stdout.write(`{"type":"response","id":"${sent.id}","success":true,"data":{"tree":[[[[\n`)
  await nextTicks()
  await rejected
})

test('PiRpcProcess: a prelude line is still captured, not treated as a response', async () => {
  const { child, stdout, written } = makeFakeChild()
  const proc = makeProcess(child)

  stdout.write('Context loaded from /tmp/project/AGENTS.md\n')
  await nextTicks()

  const request = proc.getMessages()
  const sent = JSON.parse(written[0]) as { id: string }
  stdout.write(
    `${JSON.stringify({ type: 'response', id: sent.id, command: 'get_messages', success: true, data: {} })}\n`
  )
  await nextTicks()

  await request
  assert.deepEqual(proc.consumePreludeLines(), ['Context loaded from /tmp/project/AGENTS.md'])
})
