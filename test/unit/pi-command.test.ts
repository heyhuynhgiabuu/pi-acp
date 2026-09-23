import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultPiCommand,
  findPiChangelogPath,
  getPiCommandVersion,
  shouldUseShellForPiCommand
} from '../../src/pi-rpc/command.js'

test('defaultPiCommand: uses pi.cmd on Windows and pi elsewhere', () => {
  const originalPlatform = process.platform

  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    assert.equal(defaultPiCommand(), 'pi.cmd')

    Object.defineProperty(process, 'platform', { value: 'darwin' })
    assert.equal(defaultPiCommand(), 'pi')
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForPiCommand: enables shell for Windows cmd launchers only', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })

  try {
    assert.equal(shouldUseShellForPiCommand('pi.cmd'), true)
    assert.equal(shouldUseShellForPiCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\pi.CMD'), true)
    assert.equal(shouldUseShellForPiCommand('pi.bat'), true)
    assert.equal(shouldUseShellForPiCommand('pi'), false)
    assert.equal(shouldUseShellForPiCommand('C:\\tools\\pi.exe'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForPiCommand: keeps shell disabled on non-Windows', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })

  try {
    assert.equal(shouldUseShellForPiCommand('pi.cmd'), false)
    assert.equal(shouldUseShellForPiCommand('pi'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('getPiCommandVersion treats an invalid executable as unavailable', () => {
  assert.equal(getPiCommandVersion(''), null)
})

test('Pi command helpers use the configured executable and find its installed package', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'pi command-'))
  const packageDir = join(tempDir, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const binDir = join(packageDir, 'dist', 'bundle')
  const scriptPath = join(binDir, 'cli.js')
  const executablePath = process.platform === 'win32' ? join(binDir, 'pi.cmd') : scriptPath
  const changelogPath = join(packageDir, 'CHANGELOG.md')
  const previousCommand = process.env.PI_ACP_PI_COMMAND

  try {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }))
    writeFileSync(changelogPath, '# fake Pi changelog\n')
    writeFileSync(scriptPath, 'process.stdout.write("v0.87.1\\n")\n')
    if (process.platform === 'win32') {
      writeFileSync(executablePath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
    } else {
      writeFileSync(scriptPath, '#!/usr/bin/env node\nprocess.stdout.write("v0.87.1\\n")\n')
      chmodSync(executablePath, 0o755)
    }
    process.env.PI_ACP_PI_COMMAND = executablePath

    assert.equal(getPiCommandVersion(), '0.87.1')
    const foundChangelogPath = findPiChangelogPath()
    assert.equal(foundChangelogPath, realpathSync(changelogPath))
    assert.equal(readFileSync(foundChangelogPath!, 'utf8'), '# fake Pi changelog\n')
  } finally {
    if (previousCommand === undefined) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = previousCommand
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('findPiChangelogPath locates the Pi package beside a global command shim', () => {
  const globalPrefix = mkdtempSync(join(tmpdir(), 'pi global shim-'))
  const shimPath = join(globalPrefix, 'pi.cmd')
  const packageDir = join(globalPrefix, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const changelogPath = join(packageDir, 'CHANGELOG.md')

  try {
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(shimPath, '@echo off\\r\\n')
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }))
    writeFileSync(changelogPath, '# fake global Pi changelog\\n')

    assert.equal(findPiChangelogPath(shimPath), realpathSync(changelogPath))
  } finally {
    rmSync(globalPrefix, { recursive: true, force: true })
  }
})
