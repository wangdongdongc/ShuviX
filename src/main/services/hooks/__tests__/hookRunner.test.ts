/**
 * hookRunner 集成测试：实际 spawn shell 进程，不 mock。
 * 验证 stdin/stdout JSON 协议、exit 0/2/其他、超时、stderr 收集。
 */

import { describe, it, expect } from 'vitest'
import { tmpdir } from 'os'
import { runHookProcess } from '../hookRunner'
import type { HookEntry, HookInput } from '../types'

const ENV: Record<string, string> = { PATH: process.env.PATH ?? '' }

const INPUT: HookInput = {
  session_id: 'sess_test',
  hook_event_name: 'PreToolUse',
  cwd: tmpdir(),
  tool_name: 'bash',
  tool_input: { command: 'echo hi' }
}

describe('runHookProcess', () => {
  it('exit 0 with JSON stdout → output is parsed', async () => {
    const entry: HookEntry = {
      type: 'command',
      command: `printf '{"additionalContext":"foo"}'`
    }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.output).toEqual({ additionalContext: 'foo' })
  })

  it('exit 0 with empty stdout → output undefined', async () => {
    const entry: HookEntry = { type: 'command', command: 'true' }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(0)
    expect(r.output).toBeUndefined()
  })

  it('exit 0 with non-JSON stdout → output undefined, exit still 0', async () => {
    const entry: HookEntry = { type: 'command', command: 'echo hello' }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(0)
    expect(r.output).toBeUndefined()
  })

  it('exit 2 → stderr captured, exitCode=2', async () => {
    const entry: HookEntry = {
      type: 'command',
      command: 'echo "blocked: bad command" >&2; exit 2'
    }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('blocked: bad command')
    expect(r.timedOut).toBe(false)
  })

  it('non-0/2 exit → reported, not blocking', async () => {
    const entry: HookEntry = { type: 'command', command: 'exit 7' }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(7)
  })

  it('timeout → SIGKILL, timedOut=true, exitCode=null', async () => {
    const entry: HookEntry = { type: 'command', command: 'sleep 5', timeout: 1 }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.timedOut).toBe(true)
    // sleep 被 SIGKILL，exitCode 为 null
    expect(r.exitCode).toBeNull()
  })

  it('stdin JSON is delivered to the hook process', async () => {
    // 读 stdin 全部内容并按 JSON 解析后，把 session_id 当作 additionalContext 输出回来
    const entry: HookEntry = {
      type: 'command',
      command:
        `node -e "let d='';process.stdin.on('data',c=>d+=c);` +
        `process.stdin.on('end',()=>{const j=JSON.parse(d);` +
        `process.stdout.write(JSON.stringify({additionalContext:j.session_id}))})"`
    }
    const r = await runHookProcess(entry, INPUT, { cwd: tmpdir(), env: ENV })
    expect(r.exitCode).toBe(0)
    expect(r.output).toEqual({ additionalContext: 'sess_test' })
  })

  it('env vars are passed to the hook process', async () => {
    const entry: HookEntry = {
      type: 'command',
      command: 'printf \'{"additionalContext":"%s"}\' "$SHUVIX_FOO"'
    }
    const r = await runHookProcess(entry, INPUT, {
      cwd: tmpdir(),
      env: { ...ENV, SHUVIX_FOO: 'bar123' }
    })
    expect(r.exitCode).toBe(0)
    expect(r.output).toEqual({ additionalContext: 'bar123' })
  })
})
