/**
 * hookConfig 测试：解析合法/语法坏/schema 坏 JSON，watcher 重载。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// hookConfig.ts → paths.ts → electron。测试环境无 electron，mock 掉
vi.mock('../../../utils/paths', () => ({
  getUserConfigDir: () => '/tmp/shuvix-test-config'
}))

import { loadConfigFile, watchHookFiles, type LoadedConfig } from '../hookConfig'
import type { HookSource } from '../types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-hook-cfg-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('loadConfigFile', () => {
  it('missing file → ok with count=0 (not an error)', () => {
    const r = loadConfigFile(join(tmp, 'nope.json'))
    expect(r.status).toEqual({ ok: true, count: 0 })
    expect(r.groups.size).toBe(0)
  })

  it('valid example-hooks.json loads successfully', () => {
    const fixtureRoot = join(__dirname, 'fixtures', 'example-hooks.json')
    const r = loadConfigFile(fixtureRoot)
    expect(r.status.ok).toBe(true)
    if (r.status.ok) {
      expect(r.status.count).toBeGreaterThan(0)
    }
    expect(r.groups.has('PreToolUse')).toBe(true)
    expect(r.groups.has('SessionStart')).toBe(true)
  })

  it('syntax-broken JSON → parse error, groups empty', () => {
    const f = join(tmp, 'broken.json')
    writeFileSync(f, '{ "hooks": { "PreToolUse": [')
    const r = loadConfigFile(f)
    expect(r.status.ok).toBe(false)
    if (!r.status.ok) {
      expect(r.status.kind).toBe('parse')
    }
    expect(r.groups.size).toBe(0)
  })

  it('top-level not an object → schema error', () => {
    const f = join(tmp, 'arr.json')
    writeFileSync(f, '[]')
    const r = loadConfigFile(f)
    expect(r.status.ok).toBe(false)
    if (!r.status.ok) {
      expect(r.status.kind).toBe('schema')
    }
  })

  it('null/missing hooks field → ok with count=0', () => {
    const f = join(tmp, 'empty.json')
    writeFileSync(f, '{}')
    const r = loadConfigFile(f)
    expect(r.status).toEqual({ ok: true, count: 0 })
  })

  it('unknown event name → reported, others still load', () => {
    const f = join(tmp, 'mixed.json')
    writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'true' }] }],
          NotAnEvent: [{ hooks: [{ type: 'command', command: 'true' }] }]
        }
      })
    )
    const r = loadConfigFile(f)
    expect(r.status.ok).toBe(false)
    if (!r.status.ok) {
      expect(r.status.errors?.some((e) => e.includes('NotAnEvent'))).toBe(true)
    }
    expect(r.groups.has('PreToolUse')).toBe(true)
  })

  it('bad entry skipped, sibling entries kept', () => {
    const f = join(tmp, 'partial.json')
    writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [
                { type: 'command', command: 'good' },
                { type: 'http' /* not supported */, command: 'bad' },
                { type: 'command' /* missing command */ },
                { type: 'command', command: 'ok2', timeout: -1 /* invalid */ }
              ]
            }
          ]
        }
      })
    )
    const r = loadConfigFile(f)
    expect(r.status.ok).toBe(false)
    const grp = r.groups.get('PreToolUse')
    expect(grp).toBeDefined()
    expect(grp![0].hooks).toHaveLength(1)
    expect(grp![0].hooks[0].command).toBe('good')
  })

  it('matcher non-string → group skipped, others kept', () => {
    const f = join(tmp, 'badmatcher.json')
    writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 123, hooks: [{ type: 'command', command: 'skipped' }] },
            { matcher: 'bash', hooks: [{ type: 'command', command: 'kept' }] }
          ]
        }
      })
    )
    const r = loadConfigFile(f)
    expect(r.status.ok).toBe(false)
    const grp = r.groups.get('PreToolUse')
    expect(grp).toHaveLength(1)
    expect(grp![0].hooks[0].command).toBe('kept')
  })
})

describe('watchHookFiles', () => {
  function waitForChange(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (predicate()) return resolve()
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for change'))
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  it('reload() reflects new file contents', () => {
    const f = join(tmp, 'g.json')
    writeFileSync(f, JSON.stringify({ hooks: {} }))
    let snapshot: Map<HookSource, LoadedConfig> | null = null
    const w = watchHookFiles([{ source: 'global', path: f }], (loaded) => {
      snapshot = loaded
    })
    expect(w.getLoaded().get('global')?.status.ok).toBe(true)

    writeFileSync(
      f,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] }
      })
    )
    w.reload()
    const g = w.getLoaded().get('global')!
    expect(g.status.ok).toBe(true)
    if (g.status.ok) {
      expect(g.status.count).toBe(1)
    }
    expect(snapshot).not.toBeNull()

    return w.close()
  })

  it('parse error keeps previous groups, reports new status', () => {
    const f = join(tmp, 'g.json')
    writeFileSync(
      f,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] }
      })
    )
    const w = watchHookFiles([{ source: 'global', path: f }], () => {})
    const beforeGroups = w.getLoaded().get('global')!.groups
    expect(beforeGroups.get('PreToolUse')?.[0].hooks).toHaveLength(1)

    writeFileSync(f, '{ broken')
    w.reload()
    const after = w.getLoaded().get('global')!
    expect(after.status.ok).toBe(false)
    // groups 仍是上次成功的
    expect(after.groups.get('PreToolUse')?.[0].hooks).toHaveLength(1)

    return w.close()
  })

  it('watches file creation in project dir', async () => {
    const projectDir = join(tmp, 'proj')
    mkdirSync(join(projectDir, '.shuvix'), { recursive: true })
    const f = join(projectDir, '.shuvix', 'hooks.json')

    let changeCount = 0
    const w = watchHookFiles(
      [{ source: 'project', path: f }],
      () => {
        changeCount += 1
      },
      50
    )
    expect(w.getLoaded().get('project')?.status).toEqual({ ok: true, count: 0 })

    writeFileSync(
      f,
      JSON.stringify({
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'log' }] }] }
      })
    )
    await waitForChange(() => changeCount > 0)
    expect(w.getLoaded().get('project')?.status.ok).toBe(true)
    await w.close()
  })
})
