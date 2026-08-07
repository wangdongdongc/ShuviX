/**
 * 最小 `ExecutionEnv` 占位实现。
 *
 * `AgentHarness` 的构造参数要求一个 `ExecutionEnv`（FileSystem + Shell），但它自己
 * **一次都不调用**这些方法 —— 只是原样透传给 `systemPrompt` 回调的上下文，供应用层
 * 在拼提示词时读文件用。真正依赖它的是 pi 自带的 `loadSkills` / `loadPromptTemplates` /
 * `executeShellWithCapture`，而 ShuviX 两端都有自己的实现（桌面 Node fs + skillService，
 * 扩展 FSA/OPFS + fileTools）。
 *
 * 因此浏览器宿主不需要为了跑 harness 去实现一整套 FSA 版 ExecutionEnv：给这个占位即可，
 * 任何方法被调用都会抛出明确错误而不是静默返回错误结果。桌面用真的 `NodeExecutionEnv`。
 */
import { ExecutionError, FileError } from '@earendil-works/pi-agent-core'
import type { ExecutionEnv, Result } from '@earendil-works/pi-agent-core'

function fileErr<T>(method: string): Result<T, FileError> {
  return {
    ok: false,
    error: new FileError(
      'not_supported',
      `ExecutionEnv.${method} 在本宿主上不可用 —— 文件访问请走宿主自己的文件工具（FSA/OPFS）。`
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
          'ExecutionEnv.exec 在本宿主上不可用 —— 浏览器端没有 shell。'
        )
      }) as Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  } as unknown as ExecutionEnv
}
