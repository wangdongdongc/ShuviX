/**
 * macOS 后端：每条命令一份运行时生成的 deny-default Seatbelt profile，经 `/usr/bin/sandbox-exec` 加载。
 *
 * 为什么是它：Developer ID 分发、不进 App Sandbox 的 Electron 应用，能在用户真实环境里细粒度收窄
 * 子进程权限的只有 Seatbelt（Endpoint Security 要 Apple 批的 entitlement + root，Network Extension
 * 要系统扩展）。Codex / Claude Code / Gemini CLI / Cursor / Zed 走的都是这条路。
 * `sandbox-exec` 在 man page 里标着 deprecated，但 macOS 26 仍随系统发布、Apple 自己的构建工具在用。
 *
 * sandbox-exec 是**原地 exec**：spawn 拿到的 pid 就是 bash 的 `$$`，也是进程组号 ——
 * bgTaskService 按进程组停任务不受影响（模型停后台任务走 `shuvix task stop <pid>`，见 profile.ts）。
 */
import { spawnSync } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import type { ShellInvocation } from '../../../../utils/toolUtils/shell'
import { buildSandboxSpec } from '../../spec'
import type { ProbeResult, SandboxBackend, SandboxHostPaths, SandboxSpec } from '../../types'
import { compileSeatbeltProfile } from './profile'

/** 写死路径，不查 PATH —— PATH 里的同名文件可以是任何东西 */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

function toArgs(spec: SandboxSpec): string[] {
  const { profile, params } = compileSeatbeltProfile(spec)
  const defines = Object.entries(params).flatMap(([key, value]) => ['-D', `${key}=${value}`])
  return ['-p', profile, ...defines, '--']
}

export function createSeatbeltBackend(): SandboxBackend {
  return {
    id: 'seatbelt',

    probe(paths: SandboxHostPaths): ProbeResult {
      if (!existsSync(SANDBOX_EXEC))
        return { available: false, reason: `${SANDBOX_EXEC} not found` }
      // 用与真实 profile **同形**的规格探：外层若已是 allow-default 沙箱，最小 profile 能过、
      // deny-default 的真家伙却会以 71 失败（嵌套时只允许重套完全相同的 profile）
      let workspace: string
      try {
        workspace = realpathSync(tmpdir())
      } catch {
        workspace = tmpdir()
      }
      const built = buildSandboxSpec(
        paths,
        { sessionId: 'probe', workingDirectory: workspace, grantedWrite: [], grantedRead: [] },
        (p) => p
      )
      if (!built.ok) return { available: false, reason: `probe spec rejected: ${built.reason}` }
      const result = spawnSync(SANDBOX_EXEC, [...toArgs(built.spec), '/usr/bin/true'], {
        timeout: 10_000,
        encoding: 'utf-8'
      })
      if (result.error) return { available: false, reason: result.error.message }
      if (result.status === 0) return { available: true }
      const stderr = (result.stderr || '').trim().split('\n')[0]
      return {
        available: false,
        reason: stderr || `sandbox-exec exited with ${result.status ?? result.signal}`
      }
    },

    wrap(spec: SandboxSpec, invocation: ShellInvocation): ShellInvocation {
      return {
        file: SANDBOX_EXEC,
        args: [...toArgs(spec), invocation.file, ...invocation.args]
      }
    },

    /**
     * 沙箱本身没起来：profile 编译失败 65、已在别的沙箱里 71，且此时命令一个字节都还没跑 ——
     * 日志只有 sandbox-exec 自己那一行。命令里自己调 sandbox-exec 失败也会留下同样的行，
     * 但前面通常还有别的输出，所以只认「第一行就是它」。
     */
    startupFailure(output: string, exitCode: number | null): string | null {
      if (exitCode !== 65 && exitCode !== 71) return null
      const first = output.trimStart().split('\n', 1)[0] ?? ''
      return first.startsWith('sandbox-exec:') ? first : null
    }
  }
}
