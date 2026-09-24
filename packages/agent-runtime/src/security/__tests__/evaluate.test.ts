/**
 * evaluate（PDP 核心）—— 纯函数直测：tier 结算优先序、CEL match 谓词、
 * strict fail-safe、默认兜底与 ask 询问材料；opts.realPath（门面递进来的真实路径解析）
 * 在谓词求值期间交给 inDir。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import { evaluate, buildMatchContext } from '../evaluate'
import { evaluateMatch } from '../celMatch'
import { assembleRules } from '../assemble'
import { buildPolicyVars } from '../policyVars'
import { createInlinePolicyMdReader } from '../builtinPolicies/inlineSources'
import type {
  MatchContext,
  ParsedPolicyFile,
  SecurityDecision,
  SecurityHostProvider,
  SecurityObject,
  SecurityRequest,
  SecurityRule
} from '../types'

const PATH_OBJECT: SecurityObject = {
  type: 'path',
  path: '/ws/file.txt',
  displayPath: '/ws/file.txt'
}
const COMMAND_OBJECT: SecurityObject = { type: 'command', channel: 'bash', command: 'ls -la' }
const GIT_OBJECT: SecurityObject = {
  type: 'gitTool',
  gitAction: 'init',
  command: 'git init',
  force: false,
  delete: false
}

function makeRequest(overrides: Partial<SecurityRequest> = {}): SecurityRequest {
  return {
    subject: { kind: 'agent', sessionId: 's1', agentKind: 'root' },
    action: 'read',
    object: PATH_OBJECT,
    environment: { host: 'desktop' },
    ...overrides
  }
}

/** 测试用 CEL 谓词（与 assemble 的策略规则同构：evaluateMatch + sep '/'） */
const cel =
  (expr: string) =>
  (ctx: MatchContext): boolean =>
    evaluateMatch(expr, { ...ctx }, '/')

function makeRule(overrides: Partial<SecurityRule> & { id: string }): SecurityRule {
  return {
    effect: 'allow',
    tier: 'static-allow',
    source: { kind: 'builtin', policy: 'test' },
    ...overrides
  }
}

const deny = (id: string, match?: string): SecurityRule =>
  makeRule({
    id,
    effect: 'deny',
    tier: 'deny',
    matchExpr: match,
    matches: match ? cel(match) : undefined
  })
const forceAllow = (id: string, match?: string): SecurityRule =>
  makeRule({
    id,
    effect: 'allow',
    tier: 'force-allow',
    source: { kind: 'session' },
    matches: match ? cel(match) : undefined
  })
const forceAsk = (id: string, match?: string): SecurityRule =>
  makeRule({
    id,
    effect: 'ask',
    tier: 'force-ask',
    matches: match ? cel(match) : undefined
  })
const ask = (id: string, match?: string): SecurityRule =>
  makeRule({
    id,
    effect: 'ask',
    tier: 'ask',
    matchExpr: match,
    matches: match ? cel(match) : undefined
  })
const staticAllow = (id: string, match?: string): SecurityRule =>
  makeRule({ id, effect: 'allow', tier: 'static-allow', matches: match ? cel(match) : undefined })

describe('evaluate — tier 结算优先序', () => {
  it('EV-1 deny 与 force-allow 同命中 → deny 胜出（内置保护压得住免询问）', () => {
    const decision = evaluate([forceAllow('c1'), deny('d1')], makeRequest())
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('d1')
    expect(decision.reason).toBe("Denied by security policy rule 'd1'")
  })

  it('EV-F1 force-ask 与 force-allow 同命中 → ask（免询问压不过「始终询问」）', () => {
    // 需求原型：某些对象即使开着免询问也要过目一次。梯子上 force-ask 就在 force-allow 之上
    const decision = evaluate([forceAllow('c1'), forceAsk('fa1')], makeRequest())
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('fa1')
    // force-allow 确实命中了（是被压过，不是没匹配上）；matched 按 tier 序，force-ask 在前
    expect(decision.matched).toEqual(['fa1', 'c1'])
  })

  it('EV-F2 deny 与 force-ask 同命中 → deny（拒绝恒在顶，没有 force-deny）', () => {
    const decision = evaluate([forceAsk('fa1'), deny('d1')], makeRequest())
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('d1')
    expect(decision.matched).toEqual(['d1', 'fa1'])
  })

  it('EV-F3 force-ask 胜出的路径询问不给「允许并记住」：那条授权压不过它，按钮会是假承诺', () => {
    const request = makeRequest({ action: 'read', object: { type: 'path', path: '/p/secret' } })
    // 普通 ask：给 rememberEntry（记住后由 force-allow 层放行）
    expect(evaluate([ask('a1')], request).ask).toEqual({
      command: 'Read(/p/secret)',
      rememberEntry: 'Read(/p/secret)'
    })
    // force-ask 胜出：同一条目只作展示，不给记忆入口
    expect(evaluate([ask('a1'), forceAsk('fa1')], request).ask).toEqual({
      command: 'Read(/p/secret)'
    })
  })

  it('EV-2 force-allow 与 ask 同命中 → allow（免询问压过静态 ask）', () => {
    const decision = evaluate([ask('a1'), forceAllow('c1')], makeRequest())
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('c1')
  })

  it('EV-3 ask 与 static-allow 同命中 → ask', () => {
    const decision = evaluate([staticAllow('s1'), ask('a1')], makeRequest())
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('a1')
  })

  it.each([
    ['path', PATH_OBJECT],
    ['command', COMMAND_OBJECT],
    ['gitTool', GIT_OBJECT]
  ] as const)(
    'EV-4 无命中 → default allow（无策略 = 放行），winning=default:%s，matched=[]',
    (type, object) => {
      const decision = evaluate([], makeRequest({ object }))
      expect(decision.effect).toBe('allow')
      expect(decision.winning).toBe(`default:${type}`)
      expect(decision.matched).toEqual([])
      expect(decision.ask).toBeUndefined()
    }
  )

  it('EV-5 includeForceAllow:false → force-allow 规则被跳过（matched 不含它）；ask 门下豁免失效回到 ask', () => {
    // 仅 force-allow 规则时：跳过后落 default allow
    const decision = evaluate([forceAllow('c1')], makeRequest(), { includeForceAllow: false })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('default:path')
    expect(decision.matched).toEqual([])

    // force-allow 本可豁免 ask 门；排除 force-allow 后门重新生效 —— 被动 UI 判定的语义
    const gated = evaluate([ask('a1'), forceAllow('c1')], makeRequest(), {
      includeForceAllow: false
    })
    expect(gated.effect).toBe('ask')
    expect(gated.winning).toBe('a1')
    expect(gated.matched).toEqual(['a1'])
  })

  it('EV-6 matched 含全部命中 id 按 tier 序；同 tier 多条时 winning=装配顺序第一条', () => {
    const rules = [staticAllow('s1'), ask('a1'), deny('d1'), ask('a2'), forceAllow('c1')]
    const decision = evaluate(rules, makeRequest())
    // tier 序：deny → force-allow → ask → static-allow；同 tier 内保持装配顺序
    expect(decision.matched).toEqual(['d1', 'c1', 'a1', 'a2', 's1'])
    expect(decision.winning).toBe('d1')

    const sameTier = evaluate([ask('a1'), ask('a2')], makeRequest())
    expect(sameTier.winning).toBe('a1')
  })
})

describe('evaluate — CEL match 谓词（旧结构化匹配语义的等价表达）', () => {
  it('EV-7 match 省略=恒命中；action 条件不命中时落 default', () => {
    const anyAction = evaluate([deny('d1')], makeRequest({ action: 'write' }))
    expect(anyAction.winning).toBe('d1')

    const readOnly = evaluate([deny('d1', "action == 'read'")], makeRequest({ action: 'write' }))
    expect(readOnly.matched).toEqual([])
    expect(readOnly.winning).toBe('default:path')
  })

  it('EV-8 subject 条件：agentKind、profile（空串缺省使未带 profile 的请求安全地不命中）', () => {
    const spawnedOnly = evaluate([deny('d1', "subject.agentKind == 'spawned'")], makeRequest())
    expect(spawnedOnly.matched).toEqual([])

    const profileRule = [deny('d1', "subject.profile == 'widget'")]
    // 请求未带 profileName：上下文补空串 → 表达式求 false（而非报错误拦）
    const noProfile = evaluate(profileRule, makeRequest())
    expect(noProfile.matched).toEqual([])

    const withProfile = evaluate(
      profileRule,
      makeRequest({
        subject: { kind: 'agent', sessionId: 's1', agentKind: 'root', profileName: 'widget' }
      })
    )
    expect(withProfile.winning).toBe('d1')
  })

  it('EV-9 environment 条件：env.host 不命中 extension 请求', () => {
    const decision = evaluate(
      [deny('d1', "env.host == 'desktop'")],
      makeRequest({ environment: { host: 'extension' } })
    )
    expect(decision.matched).toEqual([])
  })

  it('EV-10 type 守卫：object.type 条件对他类客体求 false（不落 fail-safe）', () => {
    const pathRule = [deny('d1', "object.type == 'path' && inDir(object.path, '/')")]
    const warn = vi.fn()
    const decision = evaluate(pathRule, makeRequest({ object: COMMAND_OBJECT }), { warn })
    expect(decision.matched).toEqual([])
    // && 吸收：type 守卫已 false，object.path 缺失不产生错误
    expect(warn).not.toHaveBeenCalled()
  })

  it('EV-11 inDir 段边界语义：全等命中；/foo 命中 /foo/bar、不命中 /foobar', () => {
    const rule = [deny('d1', "inDir(object.path, '/foo')")]
    const hit = (path: string): boolean =>
      evaluate(rule, makeRequest({ object: { type: 'path', path, displayPath: path } })).matched
        .length > 0

    expect(hit('/foo')).toBe(true)
    expect(hit('/foo/bar')).toBe(true)
    expect(hit('/foobar')).toBe(false)
  })

  it('EV-12 命令收窄走 tool 维度：tool.name 条件区分 bash/ssh；channel 属性同样可用', () => {
    const sshOnly = [deny('d1', "object.type == 'command' && tool.name == 'ssh'")]
    expect(
      evaluate(sshOnly, makeRequest({ object: COMMAND_OBJECT, tool: { name: 'bash' } })).matched
    ).toEqual([])
    expect(
      evaluate(
        sshOnly,
        makeRequest({
          object: { type: 'command', channel: 'ssh', command: 'ls' },
          tool: { name: 'ssh' }
        })
      ).winning
    ).toBe('d1')

    const sshChannel = [deny('d2', "object.type == 'command' && object.channel == 'ssh'")]
    expect(evaluate(sshChannel, makeRequest({ object: COMMAND_OBJECT })).matched).toEqual([])
  })

  it('EV-13 gitTool 属性条件：gitAction 收窄 + force/delete 细化（git-safety 的匹配形态）', () => {
    const gitSafety = [
      ask(
        'g1',
        "object.type == 'gitTool' && (object.gitAction in ['init', 'restore'] || (object.gitAction == 'checkout' && object.force))"
      )
    ]
    expect(evaluate(gitSafety, makeRequest({ object: GIT_OBJECT })).winning).toBe('g1')

    const plainCheckout = makeRequest({
      object: {
        type: 'gitTool',
        gitAction: 'checkout',
        command: 'git checkout main',
        force: false,
        delete: false
      }
    })
    expect(evaluate(gitSafety, plainCheckout).matched).toEqual([])

    const forcedCheckout = makeRequest({
      object: {
        type: 'gitTool',
        gitAction: 'checkout',
        command: 'git checkout --force main',
        force: true,
        delete: false
      }
    })
    expect(evaluate(gitSafety, forcedCheckout).winning).toBe('g1')
  })
})

describe('evaluate — ask 询问材料', () => {
  // 默认放行后 ask 只来自显式规则：用一条无 match 的 ask 触发询问材料构造
  const ASK_GATE = [ask('gate')]

  it('EV-14 path：read → Read(<path>) 且可记住；write → Write(...)；其余 action 按 read 处理', () => {
    const read = evaluate(ASK_GATE, makeRequest({ action: 'read' }))
    expect(read.ask).toEqual({
      command: 'Read(/ws/file.txt)',
      rememberEntry: 'Read(/ws/file.txt)'
    })

    const write = evaluate(ASK_GATE, makeRequest({ action: 'write' }))
    expect(write.ask).toEqual({
      command: 'Write(/ws/file.txt)',
      rememberEntry: 'Write(/ws/file.txt)'
    })

    // 非 read/write 的 path action（如 execute）按 read 模式产 Read 条目
    const execute = evaluate(ASK_GATE, makeRequest({ action: 'execute' }))
    expect(execute.ask).toEqual({
      command: 'Read(/ws/file.txt)',
      rememberEntry: 'Read(/ws/file.txt)'
    })
  })

  it('EV-15 command/gitTool 的 ask → ask.command=命令原文；rememberEntry 缺省（allowList 无命令条目形态）', () => {
    const command = evaluate(ASK_GATE, makeRequest({ action: 'execute', object: COMMAND_OBJECT }))
    expect(command.ask!.command).toBe('ls -la')
    expect(command.ask!.rememberEntry).toBeUndefined()

    const gitTool = evaluate(ASK_GATE, makeRequest({ action: 'execute', object: GIT_OBJECT }))
    expect(gitTool.ask!.command).toBe('git init')
    expect(gitTool.ask!.rememberEntry).toBeUndefined()
  })

  it('EV-15b database 的 ask → ask.command = 一行注释写明连接名 + SQL 原文（多行/超长都不截断改写）；rememberEntry 缺省', () => {
    const sql = `WITH recent AS (\n  SELECT * FROM orders WHERE created_at > '2024-01-01'\n)\nSELECT ${'c'.repeat(300)} FROM recent;`
    const object: SecurityObject = {
      type: 'database',
      sql,
      credential: 'prod-mysql',
      dbType: 'mysql',
      readonly: false
    }

    const asked = evaluate(ASK_GATE, makeRequest({ action: 'execute', object }))
    // 批准一条写语句时必须看得见它落在哪个连接上（生产库还是测试库）
    expect(asked.ask!.command).toBe(`-- prod-mysql\n${sql}`)
    expect(asked.ask!.rememberEntry).toBeUndefined()
    // 没有连接名（或是空串）→ 只有 SQL
    for (const credential of [undefined, '']) {
      const bare: SecurityObject = { ...object, credential }
      expect(
        evaluate(ASK_GATE, makeRequest({ action: 'execute', object: bare })).ask!.command
      ).toBe(sql)
    }

    // 同客体的 allow/deny 不产询问材料
    expect(
      evaluate([staticAllow('s1')], makeRequest({ action: 'execute', object })).ask
    ).toBeUndefined()
    expect(evaluate([deny('d1')], makeRequest({ action: 'execute', object })).ask).toBeUndefined()
  })

  it('EV-16 allow/deny 无 ask；allow 无 reason', () => {
    const allow = evaluate([staticAllow('s1')], makeRequest())
    expect(allow.ask).toBeUndefined()
    expect(allow.reason).toBeUndefined()

    const denied = evaluate([deny('d1')], makeRequest())
    expect(denied.ask).toBeUndefined()
  })
})

describe('evaluate — tool 维度与 invocation 客体', () => {
  const INVOCATION_OBJECT: SecurityObject = { type: 'invocation' }
  /** invocation 客体请求（L1 全工具门形态：action=execute + tool 维度） */
  const invocationRequest = (tool?: SecurityRequest['tool']): SecurityRequest =>
    makeRequest({ action: 'execute', tool, object: INVOCATION_OBJECT })

  it('EV-T1 ask × invocation 守卫 ×（带 tool 维度）→ ask，winning 正确', () => {
    const decision = evaluate(
      [ask('gate', "object.type == 'invocation'")],
      invocationRequest({ name: 'ssh' })
    )
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('gate')
    expect(decision.matched).toEqual(['gate'])
  })

  it('EV-T2 tool.name in [ssh,browser]：ssh 命中；bash 不命中 → default allow', () => {
    const rules = [ask('gate', "object.type == 'invocation' && tool.name in ['ssh', 'browser']")]

    const hit = evaluate(rules, invocationRequest({ name: 'ssh' }))
    expect(hit.effect).toBe('ask')
    expect(hit.winning).toBe('gate')

    const miss = evaluate(rules, invocationRequest({ name: 'bash' }))
    expect(miss.effect).toBe('allow')
    expect(miss.matched).toEqual([])
    expect(miss.winning).toBe('default:invocation')
  })

  it('EV-T2b tool 维度横切：deny × path × tool.name==edit 只对 edit 工具的 path 请求生效；无 tool 维度求 false', () => {
    const rules = [deny('d1', "object.type == 'path' && tool.name == 'edit'")]
    const request = (tool?: SecurityRequest['tool']): SecurityRequest =>
      makeRequest({ action: 'write', tool })

    const hit = evaluate(rules, request({ name: 'edit' }))
    expect(hit.effect).toBe('deny')
    expect(hit.winning).toBe('d1')

    const otherTool = evaluate(rules, request({ name: 'write' }))
    expect(otherTool.matched).toEqual([])
    expect(otherTool.winning).toBe('default:path')

    // 请求无 tool 维度（被动 UI 等非工具路径）：tool.name 补空串 → 求 false 而非报错
    const warn = vi.fn()
    const noTool = evaluate(rules, request(undefined), { warn })
    expect(noTool.matched).toEqual([])
    expect(noTool.winning).toBe('default:path')
    expect(warn).not.toHaveBeenCalled()
  })

  it('EV-T3 invocation 守卫 × 非 invocation 客体（path/command）→ 不命中', () => {
    const rules = [deny('d1', "object.type == 'invocation'")]
    for (const object of [PATH_OBJECT, COMMAND_OBJECT]) {
      const decision = evaluate(
        rules,
        makeRequest({ action: 'execute', tool: { name: 'ssh' }, object })
      )
      expect(decision.matched).toEqual([])
      expect(decision.winning).toBe(`default:${object.type}`)
    }
  })

  it('EV-T4 无 match 规则 × invocation 客体 → 命中', () => {
    const decision = evaluate([deny('d1')], invocationRequest({ name: 'ssh' }))
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('d1')
  })

  it('EV-T5 invocation ask 询问材料：有 operation → "name: operation"；无 → "name"；rememberEntry 恒缺省', () => {
    const gate = [ask('gate', "object.type == 'invocation'")]

    const withOp = evaluate(gate, invocationRequest({ name: 'ssh', operation: 'connect' }))
    expect(withOp.ask!.command).toBe('ssh: connect')
    expect(withOp.ask!.rememberEntry).toBeUndefined()

    const noOp = evaluate(gate, invocationRequest({ name: 'ssh' }))
    expect(noOp.ask!.command).toBe('ssh')
    expect(noOp.ask!.rememberEntry).toBeUndefined()
  })
})

describe('evaluate — strict fail-safe（谓词求值错误的处置）', () => {
  // 求值必 throw 的 match（未知顶层名字）—— fail-safe 分支的触发器
  const THROWING_MATCH = 'bogusVar == "x"'

  it('EV-W1 match true → 命中；match false → 不命中（default allow）', () => {
    const hit = evaluate([deny('d1', 'true')], makeRequest())
    expect(hit.effect).toBe('deny')
    expect(hit.winning).toBe('d1')

    const miss = evaluate([deny('d1', 'false')], makeRequest())
    expect(miss.effect).toBe('allow')
    expect(miss.winning).toBe('default:path')
    expect(miss.matched).toEqual([])
  })

  it('EV-W2 strict 缺失属性：deny 误引用他类属性（无 type 守卫）→ fail-safe 命中 + warn', () => {
    const warn = vi.fn()
    // command 客体上取 object.path：缺键报错 → deny 按 fail-safe 视为命中
    const decision = evaluate(
      [deny('d1', "inDir(object.path, '/ws')")],
      makeRequest({ object: COMMAND_OBJECT }),
      { warn }
    )
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['d1'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("'d1'")
    expect(warn.mock.calls[0][0]).toContain('treating as matched (fail-safe)')
  })

  it('EV-W3 fail-safe deny：match 抛错 → 视为命中，warn 恰 1 次且含规则 id 与 fail-safe 文案', () => {
    const warn = vi.fn()
    const decision = evaluate([deny('d1', THROWING_MATCH)], makeRequest(), { warn })
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('d1')
    expect(decision.matched).toEqual(['d1'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("'d1'")
    expect(warn.mock.calls[0][0]).toContain('treating as matched (fail-safe)')
  })

  it('EV-W4 fail-safe ask：match 抛错 → ask 胜出且询问材料照常生成', () => {
    const warn = vi.fn()
    const decision = evaluate([ask('a1', THROWING_MATCH)], makeRequest(), { warn })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('a1')
    expect(decision.ask).toEqual({
      command: 'Read(/ws/file.txt)',
      rememberEntry: 'Read(/ws/file.txt)'
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('EV-W5 fail-safe allow：static-allow 的 match 抛错 → 不命中（不白送放行），warn 含 not matched', () => {
    const warn = vi.fn()
    const decision = evaluate([staticAllow('s1', THROWING_MATCH)], makeRequest(), { warn })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('default:path')
    expect(decision.matched).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('treating as not matched')
  })

  it('EV-W6 非布尔结果走同一 fail-safe：deny + match:"action" → 命中，warn 含 must evaluate to a boolean', () => {
    const warn = vi.fn()
    const decision = evaluate([deny('d1', 'action')], makeRequest(), { warn })
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['d1'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('must evaluate to a boolean')
  })

  it('EV-W7 opts.vars 缺省=空表：引用 vars.workspace 不传 vars → fail-safe deny；传了则按 inDir 定夺', () => {
    const rule = [deny('d1', 'inDir(object.path, vars.workspace)')]

    // 不传 vars：vars.workspace 缺键 throw → fail-safe 命中
    const failSafe = evaluate(rule, makeRequest())
    expect(failSafe.effect).toBe('deny')
    expect(failSafe.matched).toEqual(['d1'])

    // 传 vars：/ws 内命中、/outside 外不命中（一正一反）
    const withVars = { vars: { workspace: '/ws' } }
    expect(evaluate(rule, makeRequest(), withVars).effect).toBe('deny')
    const outside = makeRequest({
      object: { type: 'path', path: '/outside/f.txt', displayPath: '/outside/f.txt' }
    })
    const missed = evaluate(rule, outside, withVars)
    expect(missed.effect).toBe('allow')
    expect(missed.matched).toEqual([])
  })

  it('EV-W8 opts.warn 缺省：fail-safe 触发不 crash、决策正确', () => {
    const decision = evaluate([deny('d1', THROWING_MATCH)], makeRequest())
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toBe('d1')
  })

  it('EV-W9 match-false 不遮蔽其他规则：[deny(false), ask(无 match)] → ask 胜出', () => {
    const decision = evaluate([deny('d1', 'false'), ask('a1')], makeRequest())
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('a1')
    expect(decision.matched).toEqual(['a1'])
  })

  it('EV-N4 fail-safe × tier 交互：误写 ask 规则 fail-safe 命中 + force-allow 同在 → allow；fail-safe deny + force-allow → deny', () => {
    const warn = vi.fn()
    // ask 规则求值必错 → fail-safe 视为命中，但 force-allow 压过 ask → 结果 allow
    const askFailSafe = evaluate([ask('a1', THROWING_MATCH), forceAllow('c1')], makeRequest(), {
      warn
    })
    expect(askFailSafe.effect).toBe('allow')
    expect(askFailSafe.winning).toBe('c1')
    expect(askFailSafe.matched).toEqual(['c1', 'a1'])

    // deny 规则 fail-safe 命中 + force-allow 同在 → deny 压过 force-allow
    const denyFailSafe = evaluate([deny('d1', THROWING_MATCH), forceAllow('c1')], makeRequest(), {
      warn
    })
    expect(denyFailSafe.effect).toBe('deny')
    expect(denyFailSafe.winning).toBe('d1')
    expect(denyFailSafe.matched).toEqual(['d1', 'c1'])
  })

  it('CF-1 force-allow 的 match 抛错 → 视为不命中（不白送放行）：[ask 恒命中, force-allow 抛错] → ask', () => {
    const warn = vi.fn()
    const decision = evaluate([ask('a1'), forceAllow('c1', THROWING_MATCH)], makeRequest(), {
      warn
    })

    // fail-safe 判定读的是**归一后的 rule.effect**（force-allow → allow）而不是 tier：
    // 若改按 tier 判（force-allow 不等于 'allow' 故视为命中），一条求值失败的授权规则
    // 会把"授权失效"变成"授权白送"，方向与本模块的 fail-safe 原则相反。
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('a1')
    expect(decision.matched).toEqual(['a1'])
    expect(decision.matched).not.toContain('c1')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("'c1'")
    expect(warn.mock.calls[0][0]).toContain('treating as not matched')
  })

  it('CF-2 force-allow 的 match 求值为非布尔（vars.grantedRead）→ 不命中，warn 含 must evaluate to a boolean', () => {
    const warn = vi.fn()
    const decision = evaluate([ask('a1'), forceAllow('c1', 'vars.grantedRead')], makeRequest(), {
      vars: { grantedRead: ['/ws'] },
      warn
    })
    expect(decision.effect).toBe('ask')
    expect(decision.matched).toEqual(['a1'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('must evaluate to a boolean')
    expect(warn.mock.calls[0][0]).toContain('treating as not matched')
  })

  it('CF-3 force-allow 读 object.path 但客体是 command 且无 object.type 守卫 → 不命中（strict 缺键报错走同一兜底）', () => {
    const warn = vi.fn()
    const decision = evaluate(
      [ask('a1'), forceAllow('c1', 'inDir(object.path, vars.grantedRead)')],
      makeRequest({ action: 'execute', object: COMMAND_OBJECT }),
      { vars: { grantedRead: ['/ws'] }, warn }
    )
    expect(decision.effect).toBe('ask')
    expect(decision.matched).toEqual(['a1'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('treating as not matched')
  })

  it('EV-W10 match 与 tier 正交：无 match 的 force-allow + match-true 的 ask 同在 → force-allow 胜出', () => {
    const decision = evaluate([ask('a1', 'true'), forceAllow('c1')], makeRequest())
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('c1')
    expect(decision.matched).toEqual(['c1', 'a1'])
  })
})

/**
 * 命中提示语的汇总（collectPrompt）—— 纯人读面，不参与匹配、不改三态判决。
 * 只有 ask / deny 收集：放行的操作不带话（allow/force-allow 上的 prompt 只在策略页显示）。
 */
describe('evaluate — 命中提示语（prompt）', () => {
  const DEFAULT_SOURCE: SecurityRule['source'] = {
    kind: 'builtin',
    policy: 'test',
    policyDisplayName: 'Test Policy'
  }

  /** tier 决定 effect（与装配期 TIER_BY_EFFECT 同构）；prompt 省略 = 该规则不带话 */
  const promptRule = (
    id: string,
    tier: SecurityRule['tier'],
    prompt?: string,
    opts: { match?: string; source?: SecurityRule['source'] } = {}
  ): SecurityRule => {
    const rule = makeRule({
      id,
      effect: tier === 'deny' ? 'deny' : tier === 'ask' ? 'ask' : 'allow',
      tier,
      matchExpr: opts.match,
      matches: opts.match ? cel(opts.match) : undefined,
      source: opts.source ?? DEFAULT_SOURCE
    })
    if (prompt !== undefined) rule.prompt = prompt
    return rule
  }

  it('EV-P1 deny 命中带 prompt → prompt={text, rules, policies}；ask 同形', () => {
    const denied = evaluate([promptRule('d1', 'deny', 'Write refused.')], makeRequest())
    expect(denied.effect).toBe('deny')
    expect(denied.prompt).toEqual({
      text: 'Write refused.',
      rules: ['d1'],
      policies: ['Test Policy']
    })

    const asked = evaluate([promptRule('a1', 'ask', 'Check the diff first.')], makeRequest())
    expect(asked.effect).toBe('ask')
    expect(asked.prompt).toEqual({
      text: 'Check the diff first.',
      rules: ['a1'],
      policies: ['Test Policy']
    })
  })

  it('EV-P2 static-allow 与 force-allow 命中带 prompt → 不投递（decision.prompt 缺席）', () => {
    for (const tier of ['static-allow', 'force-allow'] as const) {
      const decision = evaluate([promptRule('r1', tier, '放行不带话')], makeRequest())
      expect(decision.effect, tier).toBe('allow')
      expect(decision.winning, tier).toBe('r1')
      expect(decision.prompt, tier).toBeUndefined()
    }
  })

  it('EV-P3 胜出 tier 内 3 条命中、2 条带 prompt → 按规则数组序 \\n\\n 拼接；winning 仍是首条', () => {
    const decision = evaluate(
      [
        promptRule('a1', 'ask'),
        promptRule('a2', 'ask', 'second'),
        promptRule('a3', 'ask', 'third')
      ],
      makeRequest()
    )
    expect(decision.winning).toBe('a1')
    expect(decision.matched).toEqual(['a1', 'a2', 'a3'])
    // 刻意不是「只取 winning」：用户自己写的规则恒排在内置之后，只认 winner 他就永远看不到
    expect(decision.prompt).toEqual({
      text: 'second\n\nthird',
      rules: ['a2', 'a3'],
      policies: ['Test Policy']
    })
  })

  it('EV-P4 deny 与 ask 同时命中 → 只收 deny 那段（非胜出 tier 不贡献）', () => {
    const decision = evaluate(
      [promptRule('a1', 'ask', 'ask says this'), promptRule('d1', 'deny', 'deny says that')],
      makeRequest()
    )
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['d1', 'a1'])
    expect(decision.prompt).toEqual({
      text: 'deny says that',
      rules: ['d1'],
      policies: ['Test Policy']
    })
  })

  it('EV-P5 命中规则一条 prompt 都没有 → prompt 缺席，其余字段逐字段照旧', () => {
    expect(evaluate([promptRule('a1', 'ask'), promptRule('a2', 'ask')], makeRequest())).toEqual({
      effect: 'ask',
      matched: ['a1', 'a2'],
      winning: 'a1',
      reason: undefined,
      prompt: undefined,
      ask: { command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' }
    })
  })

  it('EV-P6 部分带 prompt → rules 只含贡献者 id；matched 仍是全部命中 id', () => {
    const decision = evaluate(
      [
        promptRule('a1', 'ask'),
        promptRule('a2', 'ask', 'only this one talks'),
        promptRule('a3', 'ask')
      ],
      makeRequest()
    )
    expect(decision.matched).toEqual(['a1', 'a2', 'a3'])
    expect(decision.prompt!.rules).toEqual(['a2'])
  })

  it('EV-P7 文本去重：两条不同策略同文案 → text 一段，rules 两个 id、policies 两个显示名', () => {
    const decision = evaluate(
      [
        promptRule('p1#0', 'ask', 'same words', {
          source: { kind: 'builtin', policy: 'p1', policyDisplayName: 'Policy One' }
        }),
        promptRule('p2#0', 'ask', 'same words', {
          source: { kind: 'user', policy: 'p2', policyDisplayName: 'Policy Two' }
        })
      ],
      makeRequest()
    )
    // 去重只作用于文本 —— 归因（rules/policies）保持完整
    expect(decision.prompt).toEqual({
      text: 'same words',
      rules: ['p1#0', 'p2#0'],
      policies: ['Policy One', 'Policy Two']
    })
  })

  it('EV-P8 署名：policies 按装配序去重；缺 displayName 回退 source.policy；derived 规则 policies 为空', () => {
    const p: SecurityRule['source'] = { kind: 'builtin', policy: 'p', policyDisplayName: 'P' }
    const sameP = evaluate(
      [
        promptRule('p#0', 'ask', 'first', { source: p }),
        promptRule('p#1', 'ask', 'second', { source: p })
      ],
      makeRequest()
    )
    expect(sameP.prompt).toEqual({
      text: 'first\n\nsecond',
      rules: ['p#0', 'p#1'],
      policies: ['P']
    })

    // displayName 缺省（解析器恒回退为 name，这里模拟绕过解析器的产物）
    const fallback = evaluate(
      [promptRule('q#0', 'ask', 'text', { source: { kind: 'user', policy: 'q' } })],
      makeRequest()
    )
    expect(fallback.prompt!.policies).toEqual(['q'])

    // derived 规则没有策略文件可署名，但文案照常投递
    const derived = evaluate(
      [promptRule('derived:x', 'ask', 'from host code', { source: { kind: 'derived' } })],
      makeRequest()
    )
    expect(derived.prompt).toEqual({ text: 'from host code', rules: ['derived:x'], policies: [] })
  })

  it('EV-P9 手工构造的空串/纯空白 prompt（绕过解析器）→ 视为无 prompt，不产出空段落', () => {
    const mixed = evaluate(
      [
        promptRule('a1', 'ask', '   '),
        promptRule('a2', 'ask', ''),
        promptRule('a3', 'ask', 'real text')
      ],
      makeRequest()
    )
    expect(mixed.prompt).toEqual({ text: 'real text', rules: ['a3'], policies: ['Test Policy'] })

    const allBlank = evaluate(
      [promptRule('a1', 'ask', ''), promptRule('a2', 'ask', '\n\t ')],
      makeRequest()
    )
    expect(allBlank.prompt).toBeUndefined()
  })

  it('EV-P10 fail-safe 命中（match 抛错的 deny/ask）的规则同样贡献 prompt', () => {
    for (const tier of ['deny', 'ask'] as const) {
      const warn = vi.fn()
      const decision = evaluate(
        [promptRule('r1', tier, '保护不静默蒸发', { match: 'bogusVar == "x"' })],
        makeRequest(),
        { warn }
      )
      expect(decision.effect, tier).toBe(tier)
      expect(decision.prompt, tier).toEqual({
        text: '保护不静默蒸发',
        rules: ['r1'],
        policies: ['Test Policy']
      })
      expect(warn, tier).toHaveBeenCalledTimes(1)
    }
  })

  it('EV-P11 includeForceAllow:false 丢弃 force-allow 后 ask 胜出 → 收 ask 的 prompt', () => {
    const rules = [
      promptRule('c1', 'force-allow', 'force-allow 不带话'),
      promptRule('a1', 'ask', 'the gate speaks')
    ]
    // force-allow 在场时判决是 allow —— 放行不带话
    expect(evaluate(rules, makeRequest()).prompt).toBeUndefined()

    const gated = evaluate(rules, makeRequest(), { includeForceAllow: false })
    expect(gated.effect).toBe('ask')
    expect(gated.prompt).toEqual({
      text: 'the gate speaks',
      rules: ['a1'],
      policies: ['Test Policy']
    })
  })

  it('EV-P12 零命中走 default allow → 无 prompt', () => {
    const decision = evaluate(
      [promptRule('a1', 'ask', 'never reached', { match: 'false' })],
      makeRequest()
    )
    expect(decision).toEqual({ effect: 'allow', matched: [], winning: 'default:path' })
  })
})

/**
 * opts.realPath —— 门面按次给出的真实路径解析，evaluate 只负责在谓词求值期间把它交给 inDir
 * （换路径客体、记忆化都是门面的事，见 context.test 的 CT-R 系列）。解析器一律是一张表的假件。
 */
describe('evaluate — opts.realPath（inDir 按位置比较）', () => {
  /** 一张表的假解析器：写法 → 真实去处，表外原样 */
  const resolverOf = (table: Record<string, string>): Mock<(p: string) => string> =>
    vi.fn((p: string): string => table[p] ?? p)
  const pathRequest = (path: string, action = 'read'): SecurityRequest =>
    makeRequest({ action, object: { type: 'path', path, displayPath: path } })

  const INLINE_POLICY_MD = createInlinePolicyMdReader()
  /** 内置策略 + 给定用户策略的装配（每次现装配 —— lets 按装配 memoize，复用一份会把上次的值带过来） */
  function decideAssembled(
    request: SecurityRequest,
    realPath: ((p: string) => string) | undefined,
    userPolicies: ParsedPolicyFile[] = []
  ): SecurityDecision {
    const provider: SecurityHostProvider = {
      host: 'desktop',
      pathSep: '/',
      getVars: () => ({
        workspace: '/ws',
        toolResultsBase: '/tool-results',
        skillsDirs: ['/skills'],
        memoryDirs: [],
        home: '/home/u',
        botsDir: '/home/u/.shuvix/bots',
        builtinKnowledgeDir: '/opt/shuvix/knowledge',
        sessionArtifactsDir: '/home/u/.shuvix/artifacts/sess-1',
        systemDirs: [],
        dotfiles: '/data'
      }),
      getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
      readBuiltinPolicyMd: INLINE_POLICY_MD,
      getUserPolicies: () => userPolicies
    }
    const vars = buildPolicyVars(provider)
    return evaluate(assembleRules(provider, vars), request, { vars, realPath })
  }

  it('EV-R1 解析器到得了 inDir：工作区里一条指向受保护目录的链接 → deny；不给解析器 → 按写法落 default allow', () => {
    const rules = [deny('d1', "inDir(object.path, '/protected')")]
    const request = pathRequest('/ws/link')
    const realPath = resolverOf({ '/ws/link': '/protected/secret' })

    const located = evaluate(rules, request, { realPath })
    expect(located).toMatchObject({ effect: 'deny', winning: 'd1', matched: ['d1'] })
    expect(realPath).toHaveBeenCalledWith('/ws/link')

    const written = evaluate(rules, request)
    expect(written).toEqual({ effect: 'allow', matched: [], winning: 'default:path' })

    // 分工：evaluate 不改写客体 —— ask 材料照客体上的 path 出（换成真实去处是门面的事）
    const asked = evaluate([ask('a1', "inDir(object.path, '/protected')")], request, { realPath })
    expect(asked.ask).toEqual({ command: 'Read(/ws/link)', rememberEntry: 'Read(/ws/link)' })
  })

  it('EV-R2 惰性求值的 lets 也在解析器的作用域里：let 里的 inDir 按位置算；lets 算出来的凭据目录也按位置比', () => {
    // 一条 let 自己调 inDir：它在规则求值当中才被算（惰性），那时解析器已经生效
    const linkedHome: ParsedPolicyFile = {
      name: 'linked-home',
      displayName: 'linked-home',
      description: '',
      lets: { homeIsLinked: 'inDir(vars.home, vars.dotfiles)' },
      rules: [{ effect: 'deny', match: "object.type == 'path' && homeIsLinked" }],
      body: ''
    }
    const inWorkspace = pathRequest('/ws/f.txt')
    const homeMovesToData = resolverOf({ '/home/u': '/data/u' })
    expect(decideAssembled(inWorkspace, homeMovesToData, [linkedHome])).toMatchObject({
      effect: 'deny',
      winning: 'linked-home#0'
    })
    expect(decideAssembled(inWorkspace, undefined, [linkedHome])).toMatchObject({
      effect: 'allow',
      winning: 'default:path'
    })

    // 内置 protect-credentials 的 credentialDirs 就是 lets 算出来的：~/.ssh 本身是链接时，
    // 真实位置上的私钥照样归它管（不给解析器 → 只被 ask-on-read 当成一次普通的区外读）
    const sshIsLinked = resolverOf({ '/home/u/.ssh': '/data/ssh' })
    const key = pathRequest('/data/ssh/id_rsa')
    expect(decideAssembled(key, sshIsLinked)).toMatchObject({
      effect: 'ask',
      winning: 'protect-credentials#1'
    })
    expect(decideAssembled(key, undefined)).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-read#0'
    })
    expect(decideAssembled(pathRequest('/data/ssh/new_key', 'write'), sshIsLinked)).toMatchObject({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
  })

  it('EV-R3 恒等解析器与不给解析器逐字段同一个判决（内置全套 × 读写 × 各类位置 × 非路径客体）', () => {
    const identity = (p: string): string => p
    const requests: SecurityRequest[] = [
      pathRequest('/ws/f.txt'),
      pathRequest('/ws/f.txt', 'write'),
      pathRequest('/home/u/.ssh/id_rsa'),
      pathRequest('/home/u/.ssh/id_rsa', 'write'),
      pathRequest('/etc/hosts', 'write'),
      pathRequest('/outside/x'),
      makeRequest({
        action: 'execute',
        object: { ...COMMAND_OBJECT, parsed: false, commands: [], writes: [] }
      })
    ]
    for (const request of requests) {
      expect(decideAssembled(request, identity)).toEqual(decideAssembled(request, undefined))
    }
  })

  it('EV-R4 引擎自己不记忆：同一个参数被几条规则引用就问几次，每次 evaluate 都重新问（记忆化在门面，见 CT-R5）', () => {
    const realPath = resolverOf({})
    const rules = [deny('d1', "inDir(object.path, '/a')"), ask('a1', "inDir(object.path, '/a')")]
    evaluate(rules, pathRequest('/x'), { realPath })
    expect(realPath.mock.calls.map(([p]) => p)).toEqual(['/x', '/a', '/x', '/a'])
    evaluate(rules, pathRequest('/x'), { realPath })
    expect(realPath).toHaveBeenCalledTimes(8)
  })

  it('EV-R5 ask 材料里的 requestedPath：客体带着且与 path 不同才给；force-ask 胜出时照给（只是不给 rememberEntry）', () => {
    const redirected = makeRequest({
      object: { type: 'path', path: '/home/u/.ssh/id_rsa', requestedPath: '/ws/key' }
    })
    expect(evaluate([ask('a1')], redirected).ask).toEqual({
      command: 'Read(/home/u/.ssh/id_rsa)',
      rememberEntry: 'Read(/home/u/.ssh/id_rsa)',
      requestedPath: '/ws/key'
    })
    expect(evaluate([ask('a1'), forceAsk('fa1')], redirected).ask).toEqual({
      command: 'Read(/home/u/.ssh/id_rsa)',
      requestedPath: '/ws/key'
    })

    // 写法就是真实去处：不给这一栏（卡片上不多一行）
    const same = makeRequest({
      object: { type: 'path', path: '/ws/f.txt', requestedPath: '/ws/f.txt' }
    })
    const materials = evaluate([ask('a1')], same).ask
    expect(materials).toEqual({ command: 'Read(/ws/f.txt)', rememberEntry: 'Read(/ws/f.txt)' })
    expect(materials).not.toHaveProperty('requestedPath')
  })
})

describe('buildMatchContext', () => {
  it('EV-C1 固定命名空间补空串缺省；object 剔除 undefined 属性；depth 缺省 0', () => {
    const ctx = buildMatchContext(
      {
        subject: { kind: 'user', sessionId: '' },
        action: 'read',
        object: { type: 'path', path: '/x', displayPath: undefined },
        environment: { host: 'desktop' }
      },
      { workspace: '/ws' }
    )
    expect(ctx.subject).toEqual({
      kind: 'user',
      agentKind: '',
      profile: '',
      sessionId: '',
      depth: 0
    })
    expect(ctx.tool).toEqual({ name: '', operation: '' })
    expect(ctx.env).toEqual({ host: 'desktop', platform: '' })
    expect(ctx.object).toEqual({ type: 'path', path: '/x' })
    expect('displayPath' in ctx.object).toBe(false)
    expect(ctx.vars).toEqual({ workspace: '/ws' })
  })

  it('EV-D1 搬运属性描述符而非取值：惰性 getter 不被当场读取、不进枚举、不进序列化', () => {
    // 命令客体的结构属性是「非枚举 + 惰性」的 getter（见 context.ts buildCommandObject）：
    // 惰性保证没有策略引用它时解析器一次都不跑，非枚举保证决策日志的序列化既看不见它
    // 也不会反过来触发解析。用 Object.entries/展开运算符实现这个搬运会同时打破三条。
    let reads = 0
    const object: Record<string, unknown> = { type: 'command', command: 'ls -la' }
    Object.defineProperty(object, 'commands', {
      enumerable: false,
      get: () => {
        reads++
        return [{ base: 'ls' }]
      }
    })

    const ctx = buildMatchContext(
      {
        subject: { kind: 'agent', sessionId: 's1' },
        action: 'execute',
        object: object as SecurityObject,
        environment: { host: 'desktop' }
      },
      {}
    )

    expect(reads).toBe(0)
    expect(Object.keys(ctx.object)).toEqual(['type', 'command'])
    expect(JSON.stringify(ctx.object)).not.toContain('commands')
    expect(reads).toBe(0)

    // 真读的时候才触发，且拿到的是原 getter 的值
    expect(ctx.object.commands).toEqual([{ base: 'ls' }])
    expect(reads).toBe(1)
  })

  it('EV-D2 普通值属性照常搬运；值为 undefined 的属性被剔除（与缺键同义）', () => {
    const ctx = buildMatchContext(
      {
        subject: { kind: 'agent', sessionId: 's1' },
        action: 'execute',
        object: {
          type: 'command',
          command: 'ls',
          channel: 'bash',
          parsed: false,
          writes: [],
          cwd: undefined
        } as SecurityObject,
        environment: { host: 'desktop' }
      },
      {}
    )
    expect(ctx.object).toEqual({
      type: 'command',
      command: 'ls',
      channel: 'bash',
      parsed: false,
      writes: []
    })
    expect('cwd' in ctx.object).toBe(false)
  })
})
