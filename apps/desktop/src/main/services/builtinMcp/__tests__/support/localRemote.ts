/**
 * 「远端」= 本机的 `/bin/sh -s`，HOME 指向一个临时目录。
 *
 * 远端任务的每个操作都是一段经 stdin 交给 `ssh host sh -s` 的脚本（sshControl.sshScript），ssh 本身只是
 * 搬运工 —— 所以把脚本直接喂给本机的 sh，跑的就是远端那一半的全部逻辑：runner、进程组、退出码落盘、
 * 字节偏移续读、清理。macOS 上 sh 是 bash（走 `set -m` 那条进程组路径），Linux CI 上是 dash。
 */
import { spawn } from 'child_process'
import type { SshExecResult } from '../../sshControl'

export function runLocalScript(
  home: string,
  script: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], {
      env: { ...process.env, HOME: home, SHELL: '/bin/sh', ...opts.env },
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 60_000)
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdoutBytes = Buffer.concat(out)
      resolve({
        stdout: stdoutBytes.toString('utf-8'),
        stdoutBytes,
        stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(script)
  })
}

/** 等到条件成立（轮询），超时抛错 */
export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}
