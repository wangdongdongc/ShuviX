/**
 * `summarizeSystemNotice` —— 后台完成通知的一行摘要。
 *
 * 通知正文是主进程写给**模型**看的，格式属于两个生产方：
 *   - 后台任务：`bgTaskService.formatExitNotice`
 *     （apps/desktop/src/main/services/bgTaskService.ts:123-142）
 *   - 子会话：`subSessionRunner.settle`
 *     （apps/desktop/src/main/services/subSessionRunner.ts:498-525，notice 拼在 513-525）
 * 下面两个夹具函数**逐行照抄**那两处的拼法，生产方改格式时这里会一起红 —— 这正是想要的：
 * 摘要解析是「够看」的宽松解析，跟着格式走，认不出的退回首行而不是报错。
 *
 * 上限两道：命令 / 标题先裁到 48（状态与时长不能被长命令挤出行尾），整句再裁到 80；
 * 截断是 `clipLine` 的语义（超过 max 切到 max-3 补 `...`）。
 */
import { describe, it, expect } from 'vitest'
import { summarizeSystemNotice } from '../systemNotice'

const LOG_PATH = '/Users/me/Library/Application Support/shuvix/tool_results/sess-1/call_1.log'

/**
 * 同 bgTaskService.formatExitNotice（:123-142）：
 *   `<background-task pid status duration>` / 命令 / [Last output: + 尾部若干行] / Full log: / 闭合
 */
function bgNotice(opts: {
  command: string
  status: string
  duration: string
  pid?: number
  tail?: string[]
  logPath?: string
}): string {
  const lines = [
    `<background-task pid="${opts.pid ?? 4242}" status="${opts.status}" duration="${opts.duration}">`,
    opts.command
  ]
  if (opts.tail?.length) {
    lines.push('Last output:')
    lines.push(...opts.tail)
  }
  lines.push(`Full log: ${opts.logPath ?? LOG_PATH}`, '</background-task>')
  return lines.join('\n')
}

/**
 * 同 subSessionRunner.settle（:513-525）：
 *   `<sub-session id title status>` / 一句说明 / [It is asking: …] / 一句建议 / 闭合，空项 filter 掉
 */
function subNotice(opts: { id: string; title: string; status: string; asked?: string[] }): string {
  return [
    `<sub-session id="${opts.id}" title="${opts.title}" status="${opts.status}">`,
    opts.status === 'waiting-input'
      ? 'It stopped to ask the user for approval and cannot continue until the user answers in that session.'
      : 'The turn you started in the background has finished.',
    opts.asked?.length ? `It is asking: ${opts.asked.join(' | ')}` : '',
    opts.status === 'waiting-input'
      ? 'Tell the user what it is waiting for — you cannot answer it yourself.'
      : 'Collect it with the session tool: action "wait-for-sub-sessions".',
    '</sub-session>'
  ]
    .filter(Boolean)
    .join('\n')
}

describe('summarizeSystemNotice —— 后台任务通知', () => {
  it('N-1 完整通知 → 恰一条 background-task：命令 · 状态 · 时长；Last output / Full log 不进摘要', () => {
    // 回归：直接拿首行当摘要，摘要位上就是一截尖括号标签
    const notice = bgNotice({
      command: 'npm test',
      status: 'exited with code 0',
      duration: '12s',
      tail: ['> vitest run', 'Test Files  3 passed (3)']
    })
    const out = summarizeSystemNotice(notice)
    expect(out).toEqual([{ kind: 'background-task', text: 'npm test · exited with code 0 · 12s' }])
    expect(out[0].text).not.toContain('Last output')
    expect(out[0].text).not.toContain('Full log')
    expect(out[0].text).not.toContain('passed')
  })

  it('N-2 带空格的状态值原样保留：stopped by the user / killed by SIGTERM / exited with code 1', () => {
    // 生产方三种状态（formatExitNotice 的三岔），属性值里的空格不能被切在第一个空格上
    for (const status of ['stopped by the user', 'killed by SIGTERM', 'exited with code 1']) {
      const out = summarizeSystemNotice(
        bgNotice({ command: 'npm run dev', status, duration: '3s' })
      )
      expect(out).toEqual([{ kind: 'background-task', text: `npm run dev · ${status} · 3s` }])
    }
  })

  it('N-3 命令里的引号 / 重定向 / `>` / CJK 原样保留；多行命令只取首行', () => {
    // 回归：标签正则若对正文里的 `>` 或引号敏感，带重定向的命令会让整条通知认不出来
    const commands = [
      'echo "hello world" > out.txt',
      "grep -rn 'TODO' src | sort > /tmp/todo.txt",
      'npm run build -- --outDir 输出目录'
    ]
    for (const command of commands) {
      const out = summarizeSystemNotice(
        bgNotice({ command, status: 'exited with code 0', duration: '1s' })
      )
      expect(out).toEqual([
        { kind: 'background-task', text: `${command} · exited with code 0 · 1s` }
      ])
    }

    const multiLine = summarizeSystemNotice(
      bgNotice({
        command: "printf 'a\\n'\nprintf 'b\\n'",
        status: 'exited with code 0',
        duration: '1s'
      })
    )
    expect(multiLine).toEqual([
      { kind: 'background-task', text: "printf 'a\\n' · exited with code 0 · 1s" }
    ])
  })
})

describe('summarizeSystemNotice —— 子会话通知', () => {
  it('N-4 标题 · 状态；waiting-input（含 It is asking 行）与 idle 都不带正文行', () => {
    const waiting = summarizeSystemNotice(
      subNotice({
        id: 'child-1',
        title: 'Fix tests',
        status: 'waiting-input',
        asked: ['Run `npm test`?']
      })
    )
    expect(waiting).toEqual([{ kind: 'sub-session', text: 'Fix tests · waiting-input' }])
    expect(waiting[0].text).not.toContain('It is asking')

    const idle = summarizeSystemNotice(
      subNotice({ id: 'child-1', title: 'Fix tests', status: 'idle' })
    )
    expect(idle).toEqual([{ kind: 'sub-session', text: 'Fix tests · idle' }])
    expect(idle[0].text).not.toContain('Collect it')
  })
})

describe('summarizeSystemNotice —— 合并通知与降级', () => {
  it('N-5 两条通知以空行拼成一条（合并窗口）→ 两句，顺序与 kind 各归各', () => {
    // AgentSession.flushNotices 用 '\n\n' 把同一窗口里到达的通知拼成一条下发
    const merged = [
      bgNotice({ command: 'npm test', status: 'exited with code 0', duration: '12s' }),
      subNotice({ id: 'child-1', title: 'Fix tests', status: 'idle' })
    ].join('\n\n')
    expect(summarizeSystemNotice(merged)).toEqual([
      { kind: 'background-task', text: 'npm test · exited with code 0 · 12s' },
      { kind: 'sub-session', text: 'Fix tests · idle' }
    ])
  })

  it('N-6 认不出的格式 → unknown，文本取首个非空行（去首尾空白）', () => {
    expect(summarizeSystemNotice('  \n  Something happened  \nmore lines')).toEqual([
      { kind: 'unknown', text: 'Something happened' }
    ])
  })

  it('N-7 空串 / 只有空白 → []', () => {
    expect(summarizeSystemNotice('')).toEqual([])
    expect(summarizeSystemNotice('  \n\t\n')).toEqual([])
  })

  it('N-8 上限：命令先裁到 48（60 字符 → 45 + ...）；整句再裁到 80；unknown 也裁到 80', () => {
    // 头部 60 字符 → 48（45 + '...'），之后再拼状态与时长
    const command = 'echo ' + 'x'.repeat(55)
    expect(command).toHaveLength(60)
    const head = command.slice(0, 45) + '...'
    expect(head).toHaveLength(48)

    const shortEnough = summarizeSystemNotice(
      bgNotice({ command, status: 'exited with code 0', duration: '12s' })
    )
    expect(shortEnough).toEqual([
      { kind: 'background-task', text: `${head} · exited with code 0 · 12s` }
    ])
    expect(shortEnough[0].text.length).toBeLessThanOrEqual(80)

    // 整句超 80：头 48 + ' · stopped by the user' + ' · ' + 一个超长时长（解析不校验数值）
    const joined = `${head} · stopped by the user · 3600000s`
    expect(joined.length).toBeGreaterThan(80)
    const whole = summarizeSystemNotice(
      bgNotice({ command, status: 'stopped by the user', duration: '3600000s' })
    )
    expect(whole).toEqual([{ kind: 'background-task', text: joined.slice(0, 77) + '...' }])
    expect(whole[0].text).toHaveLength(80)

    // unknown 分支同一把尺
    const longLine = 'z'.repeat(100)
    expect(summarizeSystemNotice(longLine)).toEqual([
      { kind: 'unknown', text: 'z'.repeat(77) + '...' }
    ])
  })

  it('N-9 属性缺失：无属性的 background-task 只剩命令；sub-session 退到 id，再退到正文首行', () => {
    // 一条通知不该在摘要位上是空白
    expect(
      summarizeSystemNotice('<background-task>\nmake\nFull log: /x.log\n</background-task>')
    ).toEqual([{ kind: 'background-task', text: 'make' }])

    expect(
      summarizeSystemNotice('<sub-session id="x">\nThe turn has finished.\n</sub-session>')
    ).toEqual([{ kind: 'sub-session', text: 'x' }])

    expect(summarizeSystemNotice('<sub-session>\nThe turn has finished.\n</sub-session>')).toEqual([
      { kind: 'sub-session', text: 'The turn has finished.' }
    ])
  })

  it('N-10 半截标签（有开无闭）→ unknown，文本是那一行（裁到 80）', () => {
    // 正则要求配对闭合；没闭合就按认不出处理，退回首行而不是抛错或匹配到文件尾
    const open = '<background-task pid="1" status="exited with code 0" duration="1s">'
    const out = summarizeSystemNotice(`${open}\nnpm test\nFull log: /x.log`)
    expect(out).toEqual([{ kind: 'unknown', text: open }])
    expect(out[0].text.length).toBeLessThanOrEqual(80)

    const longOpen = `<background-task pid="1" status="${'exited with code 0 '.repeat(4).trim()}" duration="1s">`
    expect(longOpen.length).toBeGreaterThan(80)
    expect(summarizeSystemNotice(`${longOpen}\nnpm test`)).toEqual([
      { kind: 'unknown', text: longOpen.slice(0, 77) + '...' }
    ])
  })

  it('N-11 标题里未转义的引号：不抛，按属性正则的现状解出「Fix 」（修法在 subSessionRunner.settle）', () => {
    // 生产方把 title 原样塞进 `title="…"`，标题自带引号时属性串就成了 `title="Fix "auth" tests"`。
    // ATTR_RE（`name="value"`）会在第一个引号处收口：title 解成 'Fix '，后面的 `auth" tests"`
    // 匹配不上任何属性名，status 仍能解出。这里钉的是「不抛 + 当前输出」——
    // 要修的是生产方转义（subSessionRunner.settle），而不是让解析方猜引号归属。
    const notice = subNotice({ id: 'child-1', title: 'Fix "auth" tests', status: 'idle' })
    expect(() => summarizeSystemNotice(notice)).not.toThrow()
    expect(summarizeSystemNotice(notice)).toEqual([{ kind: 'sub-session', text: 'Fix  · idle' }])
  })
})
