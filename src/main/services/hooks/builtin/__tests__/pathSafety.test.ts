import { describe, it, expect } from 'vitest'
import { homedir, platform } from 'os'
import { resolve } from 'path'
import { isBlockedPath, pathSafetyHandler } from '../pathSafety'
import type { HookInput } from '../../types'

const HOME = homedir()
const IS_WIN = platform() === 'win32'
const IS_DARWIN = platform() === 'darwin'

const makeInput = (path: string): HookInput => ({
  session_id: 'sess',
  hook_event_name: 'PreToolUse',
  cwd: '/tmp',
  tool_name: 'write',
  tool_input: { path }
})

describe('isBlockedPath — cross-platform credentials', () => {
  it.each([
    [resolve(HOME, '.ssh', 'id_rsa'), true],
    [resolve(HOME, '.ssh'), true],
    [resolve(HOME, '.aws', 'credentials'), true],
    [resolve(HOME, '.gnupg', 'pubring.kbx'), true],
    [resolve(HOME, '.config', 'gh', 'hosts.yml'), true],
    [resolve(HOME, '.netrc'), true],
    [resolve(HOME, '.sshfoo'), false], // 不是 .ssh 子路径
    [resolve(HOME, 'projects', 'foo.ts'), false]
  ])('isBlocked(%s) = %s', (path, expected) => {
    expect(isBlockedPath(path)).toBe(expected)
  })
})

describe.skipIf(IS_WIN)('isBlockedPath — POSIX', () => {
  it.each([
    ['/etc/passwd', true],
    ['/etc/', true],
    ['/etc', true],
    ['/usr/bin/ls', true],
    ['/bin/sh', true],
    ['/sbin/init', true],
    ['/root/.bashrc', true],
    ['/boot/grub.cfg', true],
    ['/tmp/anything', false],
    ['/Users/someone/code/etcdoc', false] // /etc 字符串出现但不是路径
  ])('POSIX isBlocked(%s) = %s', (path, expected) => {
    expect(isBlockedPath(path)).toBe(expected)
  })
})

describe.skipIf(!IS_DARWIN)('isBlockedPath — macOS', () => {
  it.each([
    ['/System/Library/Foo', true],
    ['/Library/LaunchDaemons/x.plist', true],
    ['/private/etc/passwd', true],
    ['/private/var/db/x', true]
  ])('darwin isBlocked(%s) = %s', (path, expected) => {
    expect(isBlockedPath(path)).toBe(expected)
  })
})

describe.skipIf(!IS_WIN)('isBlockedPath — Windows', () => {
  // 注意：os.platform() 仅在真实运行平台是 win32 时返回 win32；
  // CI 在 windows runner 上运行时这组才会跑。
  it.each([
    [process.env.SystemRoot ?? 'C:\\Windows', true],
    [resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), true],
    [process.env.ProgramFiles ?? 'C:\\Program Files', true],
    [resolve(HOME, 'AppData', 'Roaming', 'Microsoft', 'Credentials'), true],
    // Windows 大小写不敏感
    [(process.env.SystemRoot ?? 'C:\\Windows').toUpperCase(), true],
    [resolve(HOME, 'projects', 'foo.ts'), false]
  ])('win32 isBlocked(%s) = %s', (path, expected) => {
    expect(isBlockedPath(path)).toBe(expected)
  })
})

describe('pathSafetyHandler', () => {
  it('blocks write to a credential path', async () => {
    const out = await pathSafetyHandler(makeInput(resolve(HOME, '.ssh', 'id_rsa')))
    expect(out).toBeDefined()
    expect(out!.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out!.hookSpecificOutput?.reason).toContain('.ssh')
  })

  it('allows write to user project dir', async () => {
    const out = await pathSafetyHandler(makeInput(resolve(HOME, 'projects', 'x.txt')))
    expect(out).toBeUndefined()
  })

  it('ignores input without path', async () => {
    const out = await pathSafetyHandler({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      cwd: '/tmp',
      tool_input: {}
    })
    expect(out).toBeUndefined()
  })
})
