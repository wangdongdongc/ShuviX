/**
 * 判定型 hook 全链路 —— 真 runner → 真 SubAgentManager → 真 createAgentFactory → 真运行时 →
 * faux provider。假的只有宿主适配面（工具解析透传结果契约的 `next`、模型构建返回 faux 模型）。
 *
 * 这一层钉的是各层单测拼不出来的东西：模型只调一次 `next` 就出结论（请求恰一次、诱饵留在队列里）、
 * 请求里工具表只有 `next`、任务文本里既有事件围栏也有契约段；以及「没有意见」在真链路上的样子 ——
 * 只写散文（追问一次后放弃）、模型报错（不追问）、中途被外部中止（不等流收尾）。
 *
 * 暂挂（pi-durable P1-01）：这条链路跑在 pi 0.80 的 AgentHarness 上，那个运行时已随切换删除；
 * 派生 agent（hook 派发的就是派生 agent）要到 phase 2 才落到 pi-durable 的子对话上，
 * 届时按同样的 faux provider 剧本重写这七条（用例原文见 git 历史里的本文件）。
 */
import { describe, it } from 'vitest'

describe('判定型 hook 全链路（真 manager / createAgent / 运行时 + faux provider）', () => {
  // 暂挂原因（七条同一个）：派生 agent 的运行时（旧 AgentHarness）已删除，durable 版在 phase 2
  it.todo(
    'DR-1 模型只调一次 next → {result, hook}、恰一次请求、诱饵留在队列；请求工具表恰 [next]，任务文本里有事件围栏与契约段 (pi-durable p2)'
  )
  it.todo(
    'DR-2 模型只写散文、追问一次后仍不调 next → null；恰两次请求（原请求 + 一次追问） (pi-durable p2)'
  )
  it.todo(
    'DR-3 模型调用报错 → null、一次请求（出错的一轮不追问）；end.error 带 provider 原话 (pi-durable p2)'
  )
  it.todo('DR-4 先交不合格的 next、再改正 → 拿到改正后的结论，恰两次请求 (pi-durable p2)')
  it.todo(
    'DR-5 思考档位：会话 high、档案没声明 → 请求带 reasoning high；档案声明 off → 请求不带 reasoning (pi-durable p2)'
  )
  it.todo(
    'DR-6 next 与普通工具同批 → 返回捕获的结论、不挂住、不进追问；请求至多两次 (pi-durable p2)'
  )
  it.todo(
    'DR-7 请求进行中外部 signal 落下 → decide 很快返回 null（不等流收尾）；流随后按中止收尾，坑位清空 (pi-durable p2)'
  )
})
