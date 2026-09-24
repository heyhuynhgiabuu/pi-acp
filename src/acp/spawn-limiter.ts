/**
 * Bound on how many `pi` processes may be starting at the same time.
 *
 * A client restoring its open threads issues `session/load` for all of them at once, and
 * `closeAllExcept` can only close sessions that finished registering. Without a bound, one
 * full pi process per thread starts before any of them can be closed, so a client with six
 * threads open peaks at six resident processes (about 1.5 GB) for a few seconds.
 */
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 2

/**
 * Cap on resident session processes. A client can ask for a process through several
 * requests (load, prompt, model/thinking sync), and each one that finds no live session
 * starts its own `pi`; without a cap nothing closes those until the next load. One is enough
 * for the working set, because a subagent child keeps its parent chain as well.
 */
export const DEFAULT_MAX_RESIDENT_SESSIONS = 1

/** Reads the configured resident-session cap, falling back when the value is unusable. */
export function maxResidentSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_ACP_MAX_RESIDENT_SESSIONS)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_RESIDENT_SESSIONS
}

/** Reads the configured bound, falling back when the value is absent or unusable. */
export function maxConcurrentSpawns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_ACP_MAX_CONCURRENT_SPAWNS)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_CONCURRENT_SPAWNS
}

/**
 * FIFO gate for spawns. A released slot is handed straight to the next waiter, so a new
 * caller can never take a slot that a waiter is already queued for.
 */
export class SpawnLimiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number = DEFAULT_MAX_CONCURRENT_SPAWNS) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  /** Spawns currently inside `run`, for tests and diagnostics. */
  get inFlight(): number {
    return this.active
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }

    return new Promise<void>(resolve => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active -= 1
    this.waiters.shift()?.()
  }
}
