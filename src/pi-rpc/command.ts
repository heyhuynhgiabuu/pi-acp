import { spawnSync } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { platform } from 'node:os'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  return override ?? defaultPiCommand()
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}

export function getPiCommandVersion(command = getPiCommand(process.env.PI_ACP_PI_COMMAND)): string | null {
  try {
    const result = crossSpawn.sync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000
    })
    if (result.error || result.status !== 0) return null

    const output = (result.stdout.trim() || result.stderr.trim()).replace(/^v/i, '')
    return output || null
  } catch {
    return null
  }
}

export function findPiChangelogPath(command = getPiCommand(process.env.PI_ACP_PI_COMMAND)): string | null {
  for (const candidate of resolvePiCommandPaths(command)) {
    let directory: string
    try {
      directory = dirname(realpathSync(candidate))
    } catch {
      continue
    }

    while (true) {
      const changelog = findPiChangelogInPackageDirectory(directory)
      if (changelog) return changelog

      const siblingPackageChangelog = findPiChangelogInPackageDirectory(
        join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent')
      )
      if (siblingPackageChangelog) return siblingPackageChangelog

      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  return null
}

function findPiChangelogInPackageDirectory(directory: string): string | null {
  try {
    const packageJson: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (
      typeof packageJson !== 'object' ||
      packageJson === null ||
      Array.isArray(packageJson) ||
      !('name' in packageJson) ||
      packageJson.name !== '@earendil-works/pi-coding-agent'
    ) {
      return null
    }

    const changelog = join(directory, 'CHANGELOG.md')
    return existsSync(changelog) ? changelog : null
  } catch {
    return null
  }
}

function resolvePiCommandPaths(command: string): string[] {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return [resolve(command)]

  const locator = platform() === 'win32' ? 'where' : 'which'
  const result = spawnSync(locator, [command], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return []

  return result.stdout
    .split(/\r?\n/)
    .map(candidate => candidate.trim())
    .filter(Boolean)
}
