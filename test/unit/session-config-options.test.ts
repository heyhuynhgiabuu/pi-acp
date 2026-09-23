import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for model and thinking selectors', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getAvailableThinkingLevels() {
          return null
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: { provider: 'test', id: 'beta' }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.models?.currentModelId, 'test/beta')
    assert.equal(result.modes?.currentModeId, 'high')
    assert.deepEqual(result.configOptions, [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: 'test/beta',
        options: [
          { value: 'test/alpha', name: 'test/Alpha', description: null },
          { value: 'test/beta', name: 'test/Beta', description: null }
        ]
      },
      {
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set the reasoning effort for this session',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Thinking: off', description: null },
          { value: 'minimal', name: 'Thinking: minimal', description: null },
          { value: 'low', name: 'Thinking: low', description: null },
          { value: 'medium', name: 'Thinking: medium', description: null },
          { value: 'high', name: 'Thinking: high', description: null },
          { value: 'xhigh', name: 'Thinking: xhigh', description: null }
        ]
      }
    ])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: newSession uses Pi-advertised thinking levels including max', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
        },
        async getAvailableThinkingLevels() {
          return ['off', 'max']
        },
        async getState() {
          return { thinkingLevel: 'max', model: { provider: 'test', id: 'alpha' } }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.modes?.currentModeId, 'max')
    assert.deepEqual(
      result.modes?.availableModes.map(mode => mode.id),
      ['off', 'max']
    )
    const thoughtOption = result.configOptions?.find(option => option.id === 'thought_level')
    assert.ok(thoughtOption && thoughtOption.type === 'select')
    assert.deepEqual(
      thoughtOption.options.flatMap(option =>
        'value' in option ? [option.value] : option.options.map(child => child.value)
      ),
      ['off', 'max']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: newSession only advertises off when Pi reports no reasoning levels', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
        },
        async getAvailableThinkingLevels() {
          return []
        },
        async getState() {
          return { thinkingLevel: 'high', model: { provider: 'test', id: 'alpha' } }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.modes?.currentModeId, 'off')
    assert.deepEqual(
      result.modes?.availableModes.map(mode => mode.id),
      ['off']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: newSession closes Pi when thinking-level discovery fails', async () => {
  const conn = new FakeAgentSideConnection()
  const closedSessionIds: string[] = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getAvailableThinkingLevels() {
        throw new Error('thinking-level RPC failed')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha' } }
      }
    }
  }
  const sessions = {
    async create() {
      return session
    },
    close(sessionId: string) {
      closedSessionIds.push(sessionId)
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    /thinking-level RPC failed/
  )
  assert.deepEqual(closedSessionIds, ['s1'])
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'beta', name: 'Beta' }
          ]
        }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return state.model.id === 'beta' ? ['off', 'max'] : ['off', 'high']
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    },
    async publishContextUsage() {
      // Context usage publishing is covered in test/unit/context-usage.test.ts.
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/beta'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
  const thoughtOption = result.configOptions.find(option => option.id === 'thought_level')
  assert.ok(thoughtOption && thoughtOption.type === 'select')
  assert.deepEqual(
    thoughtOption.options.flatMap(option =>
      'value' in option ? [option.value] : option.options.map(child => child.value)
    ),
    ['off', 'max']
  )
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: setSessionMode accepts Pi-advertised max and refreshes config options', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'off',
    model: { provider: 'test', id: 'alpha' }
  }
  const setThinkingLevels: string[] = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getAvailableThinkingLevels() {
        return ['off', 'max']
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        setThinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionMode({ sessionId: 's1', modeId: 'max' } as any)

  assert.deepEqual(setThinkingLevels, ['max'])
  assert.ok(
    conn.updates.some(({ update }) => update.sessionUpdate === 'current_mode_update' && update.currentModeId === 'max')
  )
})

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
        }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return ['off', 'max']
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'max'
  } as any)

  assert.deepEqual(thinkingLevels, ['max'])
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'max')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'max'
      }
    },
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})
