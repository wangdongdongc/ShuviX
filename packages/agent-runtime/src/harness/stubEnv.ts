/**
 * 最小 `ExecutionEnv` 占位实现 —— 派生 agent 用它。
 *
 * `AgentHarness` 的构造参数要求一个 `ExecutionEnv`（FileSystem + Shell），但它自己
 * **一次都不调用**这些方法 —— 只是原样透传给 `systemPrompt` 回调的上下文，供应用层
 * 在拼提示词时读文件用。真正依赖它的是 pi 自带的 `loadSkills` / `loadPromptTemplates` /
 * `executeShellWithCapture`，而 ShuviX 有自己的实现（Node fs + skillService + 文件工具）。
 *
 * 派生 agent 的提示词在创建时就拼好了，用不上执行环境：给这个占位即可，任何方法被调用都会
 * 抛出明确错误而不是静默返回错误结果。根会话用宿主给的真环境（桌面 `NodeExecutionEnv`）。
 */
import { ExecutionError, FileError } from '@earendil-works/pi-agent-core'
import type { ExecutionEnv, Result } from '@earendil-works/pi-agent-core'

function fileErr<T>(method: string): Result<T, FileError> {
  return {
    ok: false,
    error: new FileError(
      'not_supported',
      `ExecutionEnv.${method} 在这里不可用 —— 文件访问请走 ShuviX 自己的文件工具。`
    )
  } as Result<T, FileError>
}

/** 创建一个所有方法都返回 not_supported 的 ExecutionEnv */
export function createStubExecutionEnv(cwd = '/'): ExecutionEnv {
  const fs =
    <T>(method: string) =>
    async (): Promise<Result<T, FileError>> =>
      fileErr<T>(method)
  return {
    cwd,
    absolutePath: fs<string>('absolutePath'),
    joinPath: fs<string>('joinPath'),
    readTextFile: fs<string>('readTextFile'),
    readTextLines: fs<string[]>('readTextLines'),
    readBinaryFile: fs<Uint8Array>('readBinaryFile'),
    writeFile: fs<void>('writeFile'),
    appendFile: fs<void>('appendFile'),
    fileInfo: fs('fileInfo'),
    listDir: fs('listDir'),
    canonicalPath: fs<string>('canonicalPath'),
    exists: fs<boolean>('exists'),
    createDir: fs<void>('createDir'),
    remove: fs<void>('remove'),
    createTempDir: fs<string>('createTempDir'),
    createTempFile: fs<string>('createTempFile'),
    cleanup: async () => {},
    exec: async () =>
      ({
        ok: false,
        error: new ExecutionError(
          'shell_unavailable',
          'ExecutionEnv.exec 在这里不可用 —— 命令请走 ShuviX 自己的 bash 工具。'
        )
      }) as Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  } as unknown as ExecutionEnv
}
