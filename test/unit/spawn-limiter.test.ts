import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_CONCURRENT_SPAWNS,
  DEFAULT_MAX_RESIDENT_SESSIONS,
  SpawnLimiter,
  maxConcurrentSpawns,
  maxResidentSessions
} from '../../src/acp/spawn-limiter.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('SpawnLimiter never runs more than its limit at once', async () => {
  const limiter = new SpawnLimiter(2)
  let inFlight = 0
  let peak = 0
  let finished = 0

  const task = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await tick()
    inFlight -= 1
    finished += 1
  }

  await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)))

  assert.equal(finished, 6, 'every queued task still runs')
  assert.equal(peak, 2, 'the bound holds under a burst')
  assert.equal(limiter.inFlight, 0, 'slots are released after the burst')
})

test('SpawnLimiter hands a released slot to the next waiter, not to a late caller', async () => {
  const limiter = new SpawnLimiter(1)
  const order: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = limiter.run(async () => {
    order.push('first')
    await firstGate
  })
  await tick()

  // Both are queued while the single slot is held.
  const second = limiter.run(async () => {
    order.push('second')
  })
  const third = limiter.run(async () => {
    order.push('third')
  })
  await tick()

  releaseFirst?.()
  await Promise.all([first, second, third])

  assert.deepEqual(order, ['first', 'second', 'third'], 'waiters run in arrival order')
  assert.equal(limiter.inFlight, 0)
})

test('SpawnLimiter surfaces a task failure without leaking its slot', async () => {
  const limiter = new SpawnLimiter(1)

  await assert.rejects(
    limiter.run(async () => {
      throw new Error('spawn failed')
    }),
    /spawn failed/
  )

  assert.equal(limiter.inFlight, 0, 'a failed spawn releases its slot')
  assert.equal(await limiter.run(async () => 'ok'), 'ok')
})

test('maxConcurrentSpawns defaults to a bounded value and honors a usable override', () => {
  assert.equal(maxConcurrentSpawns({}), DEFAULT_MAX_CONCURRENT_SPAWNS)
  assert.equal(maxConcurrentSpawns({ PI_ACP_MAX_CONCURRENT_SPAWNS: '4' }), 4)
  assert.equal(maxConcurrentSpawns({ PI_ACP_MAX_CONCURRENT_SPAWNS: '1' }), 1)

  for (const invalid of ['0', '-2', 'many', '', '1.5']) {
    assert.equal(
      maxConcurrentSpawns({ PI_ACP_MAX_CONCURRENT_SPAWNS: invalid }),
      DEFAULT_MAX_CONCURRENT_SPAWNS,
      `unusable value ${JSON.stringify(invalid)} falls back`
    )
  }
})

test('maxResidentSessions keeps a single session resident by default', () => {
  assert.equal(maxResidentSessions({}), DEFAULT_MAX_RESIDENT_SESSIONS)
  assert.equal(DEFAULT_MAX_RESIDENT_SESSIONS, 1)
  assert.equal(maxResidentSessions({ PI_ACP_MAX_RESIDENT_SESSIONS: '3' }), 3)

  for (const invalid of ['0', '-1', 'two', '']) {
    assert.equal(
      maxResidentSessions({ PI_ACP_MAX_RESIDENT_SESSIONS: invalid }),
      DEFAULT_MAX_RESIDENT_SESSIONS,
      `unusable value ${JSON.stringify(invalid)} falls back`
    )
  }
})
