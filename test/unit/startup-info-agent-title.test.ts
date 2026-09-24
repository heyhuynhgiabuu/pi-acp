import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
  name: string
  version: string
}

// ACP defines `name` as the logical identity and `title` as the user-facing one, so a client that
// renders the title must not have to fall back to the package name.
test('PiAcpAgent: initialize advertises the package identity plus a user-facing title', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.equal(response.agentInfo?.name, pkg.name)
  assert.equal(response.agentInfo?.title, 'Pi Coding Agent')
  assert.equal(response.agentInfo?.version, pkg.version)
})
