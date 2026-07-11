import { describe, it, expect } from 'vitest'
// bash-audit 实现已上移到 @shuvix/agent-runtime（各端共享）；这里通过工厂构造后测试
import { findDangerousPattern, makeBashAudit } from '@shuvix/agent-runtime'
import type { HookInput } from '../../types'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }
const bashAuditHandler = makeBashAudit(noopLogger)

const makeInput = (command: string): HookInput => ({
  session_id: 'sess',
  hook_event_name: 'PreToolUse',
  cwd: '/tmp',
  tool_name: 'bash',
  tool_input: { command }
})

describe('findDangerousPattern — POSIX', () => {
  it.each([
    ['rm -rf /', 'rm -rf /'],
    ['rm -rf /*', 'rm -rf /'],
    ['sudo rm -rf /', 'rm -rf /'],
    [':(){ :|:& };:', 'fork bomb (bash)'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['mkfs /dev/sda', 'mkfs'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd to disk device'],
    ['dd if=foo of=/dev/nvme0n1', 'dd to disk device']
  ])('catches %s', (cmd, expected) => {
    expect(findDangerousPattern(cmd)).toBe(expected)
  })
})

describe('findDangerousPattern — Windows', () => {
  it.each([
    ['format C:', 'format <drive>:'],
    ['format C: /q', 'format <drive>:'],
    ['format c: /fs:ntfs', 'format <drive>:'],
    ['del /s /q C:\\', 'recursive delete from drive root'],
    ['del /S /Q D:\\', 'recursive delete from drive root'],
    ['rd /s /q C:\\', 'recursive delete from drive root'],
    ['rmdir /s /q C:\\', 'recursive delete from drive root'],
    ['cipher /w:C:', 'cipher /w drive wipe'],
    ['%0|%0', 'fork bomb (cmd)'],
    ['%0 | %0', 'fork bomb (cmd)'],
    ['Remove-Item -Recurse -Force C:\\', 'PowerShell Remove-Item drive root'],
    ['Remove-Item -Path C:\\ -Recurse -Force', 'PowerShell Remove-Item drive root']
  ])('catches %s', (cmd, expected) => {
    expect(findDangerousPattern(cmd)).toBe(expected)
  })

  it.each([
    'ls -la',
    'rm -rf node_modules', // 没指向根
    'echo "rm -rf /" > file.txt', // 字面量出现但 / 后跟引号，不命中（regex 要求 / 后跟空白/EOL/*）
    'find . -name "*.log" -delete',
    'cat /etc/passwd' // 读 /etc 不归这层管（pathSafety 管写）
  ])('does not match safe command "%s"', (cmd) => {
    expect(findDangerousPattern(cmd)).toBeNull()
  })
})

describe('bashAuditHandler', () => {
  it('returns deny on dangerous command', async () => {
    const out = await bashAuditHandler(makeInput('rm -rf /'))
    expect(out).toBeDefined()
    expect(out!.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out!.hookSpecificOutput?.reason).toContain('rm -rf /')
  })

  it('returns undefined on benign command', async () => {
    const out = await bashAuditHandler(makeInput('npm test'))
    expect(out).toBeUndefined()
  })

  it('returns undefined when tool_input has no command', async () => {
    const out = await bashAuditHandler({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      cwd: '/tmp',
      tool_input: {}
    })
    expect(out).toBeUndefined()
  })
})
