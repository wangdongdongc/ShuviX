/**
 * e2e 运行记录 —— 每跑一次 e2e，在一份 JSONL 里追加几行，留着以后评估「e2e 在哪个阶段有用」。
 *
 * 记在仓库之外（缺省 `~/.shuvix-e2e/history.jsonl`，`SHUVIX_E2E_HISTORY` 改路径，设成空串就不记）：所有
 * worktree 与会话共用一份，换分支、删 worktree 都不丢。不是 `~/.shuvix` —— 那是应用自己的数据目录。
 *
 * 一次运行写成几行，同一个 `run`（开始时刻）串起来，**边跑边写**：中途被停掉的那一轮也留下跑完的那些文件。
 *   - `start`：为什么跑（`SHUVIX_E2E_PURPOSE`：release / change / bisect，缺省 adhoc）、提交、分支、工作区脏不脏、
 *     要跑几个文件；
 *   - `file`：每个 spec 文件跑完一行 —— 区域、结局、用时、用例数、失败的用例（全名 + 首行错误）、实例进程树的
 *     内存峰值与起了几个实例（harness 的 processTree 记下、这里读走）；
 *   - `end`：整轮的结局与用时（被停掉的那一轮没有这一行）。
 * 失败是什么性质（真回归 / 期望过时 / 不稳定 / 环境问题）跑的时候不知道，由修它的人事后补一行 `triage`
 * （`node e2e/history.mjs triage …`，见那个脚本）。
 *
 * 记录失败从不影响测试本身：写不进去只打一行警告。
 */
import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, relative } from 'path'
import type {
  Reporter,
  SerializedError,
  TestModule,
  TestRunEndReason,
  TestSpecification
} from 'vitest/node'
import { readMemRecord } from './processTree'

const ERROR_MAX = 300

/** 记录写到哪：环境变量优先（空串 = 不记） */
export function historyPath(): string | null {
  const configured = process.env.SHUVIX_E2E_HISTORY
  if (configured !== undefined) return configured.trim() || null
  return join(homedir(), '.shuvix-e2e', 'history.jsonl')
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? ''
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX)}…` : line
}

export default class HistoryReporter implements Reporter {
  private run = ''
  private startedAt = 0
  private readonly path = historyPath()

  private write(record: Record<string, unknown>): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify({ v: 1, run: this.run, ...record })}\n`)
    } catch (err) {
      console.warn(`[e2e history] could not write ${this.path}: ${(err as Error).message}`)
    }
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.startedAt = Date.now()
    this.run = new Date(this.startedAt).toISOString()
    this.write({
      type: 'start',
      purpose: process.env.SHUVIX_E2E_PURPOSE?.trim() || 'adhoc',
      sha: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: git(['status', '--porcelain']) !== '',
      planned: specifications.length
    })
  }

  onTestModuleEnd(module: TestModule): void {
    const file = relative(join(process.cwd(), 'e2e', 'specs'), module.moduleId)
    const tests = [...module.children.allTests()]
    const mem = readMemRecord(module.moduleId)
    this.write({
      type: 'file',
      file,
      area: file.split(/[\\/]/)[0] ?? '',
      state: module.state(),
      durationMs: Math.round(module.diagnostic().duration),
      tests: tests.length,
      failed: tests.filter((t) => t.result().state === 'failed').length,
      skipped: tests.filter((t) => t.result().state === 'skipped').length,
      failures: [...module.children.allTests('failed')].map((test) => ({
        name: test.fullName,
        error: firstLine(test.result().errors?.[0]?.message)
      })),
      ...(mem
        ? {
            peakRssMb: mem.peakRssMb,
            instances: mem.instances,
            killedStragglers: mem.killedStragglers,
            teardownMs: mem.teardownMs
          }
        : {})
    })
  }

  onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason
  ): void {
    this.write({
      type: 'end',
      reason,
      durationMs: Date.now() - this.startedAt,
      unhandledErrors: unhandledErrors.map((e) => firstLine(e.message))
    })
  }
}
