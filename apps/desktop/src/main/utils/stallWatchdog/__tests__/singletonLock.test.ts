import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SINGLETON_LOCK_FILE, liveSingletonLockHolder } from '../singletonLock'

describe.skipIf(process.platform === 'win32')('liveSingletonLockHolder', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuvix-singleton-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Chromium 的锁：指向 `<host>-<pid>` 的符号链接（目标不存在也没关系） */
  const lockTo = (target: string): void => symlinkSync(target, join(dir, SINGLETON_LOCK_FILE))

  it('no lock file, or no userData dir → null', () => {
    expect(liveSingletonLockHolder(dir)).toBeNull()
    expect(liveSingletonLockHolder(join(dir, 'missing'))).toBeNull()
  })

  it('a regular file instead of a symlink → null', () => {
    writeFileSync(join(dir, SINGLETON_LOCK_FILE), `host-${process.ppid}`)
    expect(liveSingletonLockHolder(dir)).toBeNull()
  })

  it('a dead holder → null', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    expect(dead).toBeGreaterThan(0)
    lockTo(`host-${dead}`)
    expect(liveSingletonLockHolder(dir)).toBeNull()
  })

  it('a lock held by this very process → null', () => {
    lockTo(`host-${process.pid}`)
    expect(liveSingletonLockHolder(dir)).toBeNull()
  })

  it('a live holder → host and pid, split at the last hyphen', () => {
    lockTo(`my-mac-mini.local-${process.ppid}`)
    expect(liveSingletonLockHolder(dir)).toEqual({ host: 'my-mac-mini.local', pid: process.ppid })
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'a process we may not signal (EPERM) still counts as alive',
    () => {
      lockTo('host-1')
      expect(liveSingletonLockHolder(dir)).toEqual({ host: 'host', pid: 1 })
    }
  )

  it.each(['garbage', 'host-', 'host-12ab', 'host-0', 'host-99999999999999999999'])(
    'a malformed target %j → null',
    (target) => {
      lockTo(target)
      expect(liveSingletonLockHolder(dir)).toBeNull()
    }
  )
})
