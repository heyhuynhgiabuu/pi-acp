import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent, PiSessionStats } from '../../src/pi-rpc/process.js'

// Every test that drives an agent shares this helper, so pointing the adapter's own
// state directory at a temp dir here keeps test sessions out of the real
// ~/.pi/pi-acp/session-map.json. Tests may override PI_ACP_HOME before importing this.
process.env.PI_ACP_HOME ??= mkdtempSync(join(tmpdir(), 'pi-acp-home-'))

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  readonly elicitationRequests: unknown[] = []
  nextElicitationResponse: unknown = { action: 'accept', content: { value: 'typed by user' } }

  async unstable_createElicitation(params: unknown): Promise<unknown> {
    this.elicitationRequests.push(params)
    return this.nextElicitationResponse
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  getSessionStatsCount = 0

  sessionStats: PiSessionStats = {}
  /** When set, `getSessionStats()` rejects with this error. */
  sessionStatsError: unknown = null

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getAvailableThinkingLevels(): Promise<string[] | null> {
    return null
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getSessionStats(): Promise<PiSessionStats> {
    this.getSessionStatsCount += 1
    if (this.sessionStatsError) throw this.sessionStatsError
    return this.sessionStats
  }

  private exitHandlers: Array<() => void> = []

  onExit(handler: () => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  /** Simulate the pi subprocess exiting (or failing to spawn). */
  exit(): void {
    const handlers = this.exitHandlers
    this.exitHandlers = []
    for (const handler of handlers) handler()
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
