/**
 * 子会话工具面的真模型探针 —— 不断言，只跑一遍并把转写摊开。
 *
 * 判据是人读的：模型有没有走岔、在哪一步停下来想、有没有为一句文案多花一轮。
 * 用 `PROBE_PROMPT` 换任务、`PROBE_MODEL` 换模型（子串匹配），
 * `PROBE_OUT` 指定转写落点。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { startProbe, type Probe } from './probe'

const PROMPT = process.env.PROBE_PROMPT ?? '测试一个 session 子会话功能，执行一个前台任务和后台任务'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-probe.txt')

let probe: Probe

beforeAll(async () => {
  probe = await startProbe({
    workdir: mkdtempSync(join(tmpdir(), 'probe-ws-')),
    preferModel: process.env.PROBE_MODEL,
    title: 'sub-session probe'
  })
  // 扮演那个会点「允许一次」的用户；PROBE_NO_ALLOW=1 时不装，用来**故意**探
  // 「子会话卡在询问上」那条路径
  if (!process.env.PROBE_NO_ALLOW) await probe.autoAllow()
}, 120_000)

afterAll(async () => {
  await probe?.stop()
})

it(
  'run one real turn and dump the transcript',
  async () => {
    await probe.ask(probe.rootSessionId, PROMPT)
    await probe.dump(OUT)
  },
  15 * 60 * 1000
)
