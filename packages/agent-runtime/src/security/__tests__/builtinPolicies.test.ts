/**
 * 内置策略守护 —— md 是随包发布的编译期常量，解析失败/形态漂移属开发期错误，
 * 这里逐策略钉死形态与安全不变式（内置绝不静默放行写入）。
 *
 * 多语言约束：规则的**判定字段**唯一事实源恒为 en 文件（构建器忽略本地化文件的
 * effect/conditions/match 与 lets），各语言文件的这些字段仍必须与 en 逐字段一致 ——
 * 翻译漂移在此立刻红，而不是静默存在一份「看起来生效实际被忽略」的规则拷贝。
 * 唯一例外是 `prompt`（人读提示语，不参与匹配）：它按语言 overlay，比较时剥掉。
 */
import { describe, it, expect, vi } from 'vitest'
import { buildBuiltinPolicies, BUILTIN_POLICY_SPECS } from '../builtinPolicies'
import { parsePolicyDefinitionFile, serializePolicyDefinitionFile } from '../policyFile'
import { assembleRules } from '../assemble'
import { mergeConditions } from '../conditions'
import { evaluate } from '../evaluate'
import { buildPolicyVars } from '../policyVars'
import type {
  ParsedPolicyFile,
  PolicyRuleSpec,
  SecurityDecision,
  SecurityHostProvider,
  SecurityObject
} from '../types'

/** 剥掉人读提示语后的规则 —— 各语言之间做「判定字段一致」比较的口径 */
const withoutPrompt = (rule: PolicyRuleSpec): PolicyRuleSpec => {
  const { prompt: _prompt, ...rest } = rule
  return rest
}

const byName = (name: string): ParsedPolicyFile => {
  const policy = buildBuiltinPolicies().find((p) => p.name === name)
  expect(policy, `builtin policy '${name}' missing`).toBeDefined()
  return policy!
}

describe('buildBuiltinPolicies', () => {
  it('BP-1 不 throw；恰 13 份；名字与 SPECS 一致且互异', () => {
    expect(() => buildBuiltinPolicies()).not.toThrow()
    const policies = buildBuiltinPolicies()
    expect(policies).toHaveLength(13)
    expect(policies.map((p) => p.name)).toEqual(BUILTIN_POLICY_SPECS.map((s) => s.name))
    expect(new Set(policies.map((p) => p.name)).size).toBe(13)
  })

  it('BP-1b 每份语言文件都声明 shuvix-builtin: true（新增内置策略漏写即红）', () => {
    for (const spec of BUILTIN_POLICY_SPECS) {
      for (const [language, source] of Object.entries(spec.sources)) {
        expect(source, `${spec.name}.${language}`).toMatch(/^shuvix-builtin: true$/m)
      }
    }
  })

  it('BP-2 不变式：内置策略不含静态 allow 规则（无策略即放行，无需内置豁免）', () => {
    // force-allow 不在此列且**必须**不在：出厂的 session-auto-allow / session-path-grants
    // 正是用它表达会话授权。要挡的是静态 allow —— 它只会白占一层 static-allow，
    // 既压不过询问门，又让"没有策略就是放行"这条默认语义多出一个等价的替身。
    for (const policy of buildBuiltinPolicies()) {
      for (const rule of policy.rules) {
        expect(rule.effect, `${policy.name} 存在内置 allow 规则`).not.toBe('allow')
      }
    }
  })

  it('BP-2b 不变式：每条内置规则的有效条件都限定 agent 主体（防护不作用于 user 主体）', () => {
    for (const policy of buildBuiltinPolicies()) {
      for (const rule of policy.rules) {
        const effective = mergeConditions(policy.scope, rule.conditions)
        expect(effective?.['subject.kind'], `${policy.name} 规则未限定 agent 主体`).toEqual([
          'agent'
        ])
      }
    }
  })

  it('BP-2c 不变式：凡引用 object 属性的内置规则都声明 object.type（strict 语义下不误拦他类客体）', () => {
    for (const policy of buildBuiltinPolicies()) {
      for (const rule of policy.rules) {
        const effective = mergeConditions(policy.scope, rule.conditions)
        // 不碰 object 属性的规则无需类型守卫 —— strict 只在跨 type 误引用时报错。
        // session-auto-allow 的 match 只看 vars.autoAllow，故意跨所有客体类型生效。
        if (!rule.match?.includes('object.')) continue
        expect(
          effective?.['object.type'],
          `${policy.name} 的 match 引用了 object 属性却缺 object.type 条件`
        ).toBeDefined()
      }
    }
  })

  it('BP-3 protect-system：deny × write × path × systemDirs let（字面系统目录 + vars.systemDirs），desktop 限定', () => {
    const policy = byName('protect-system')
    expect(policy.rules).toHaveLength(1)
    const rule = policy.rules[0]
    expect(rule.effect).toBe('deny')
    expect(policy.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    expect(rule.conditions).toEqual({ action: ['write'] })
    expect(rule.match).toContain('inDir(object.path, systemDirs)')
    expect(policy.lets!.systemDirs).toContain("'/etc'")
    expect(policy.lets!.systemDirs).toContain("'/System'")
    expect(policy.lets!.systemDirs).toContain('vars.systemDirs')
  })

  it('BP-3 ask-on-read：ask × read × path × 工作区/只读目录取反，desktop 限定（迁移前读取围栏的恢复）', () => {
    const policy = byName('ask-on-read')
    expect(policy.rules).toHaveLength(1)
    const rule = policy.rules[0]
    expect(rule.effect).toBe('ask')
    expect(policy.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    expect(rule.conditions).toEqual({ action: ['read'] })
    expect(rule.match).toContain('!inDir(object.path, vars.workspace)')
    expect(rule.match).toContain('!inDir(object.path, vars.toolResultsBase)')
    expect(rule.match).toContain('!inDir(object.path, vars.skillsDirs)')
    expect(rule.match).toContain('!inDir(object.path, vars.memoryDirs)')
  })

  it('BP-3 ask-on-write：ask × write × path 任意路径，desktop 限定（无 match —— 条件即全部）', () => {
    const policy = byName('ask-on-write')
    expect(policy.rules).toHaveLength(1)
    expect(policy.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    expect(withoutPrompt(policy.rules[0])).toEqual({
      effect: 'ask',
      conditions: { action: ['write'] }
    })
    expect(policy.rules[0].prompt).toBeTruthy()
    // 全域门：无 match 即无路径收窄
    expect(policy.rules[0].match).toBeUndefined()
  })

  it('BP-3 protect-credentials：deny × write + ask × read，共享同一 credentialDirs let（保护面一致）', () => {
    const policy = byName('protect-credentials')
    expect(policy.rules).toHaveLength(2)
    const [denyRule, askRule] = policy.rules
    expect(denyRule.effect).toBe('deny')
    expect(denyRule.conditions).toEqual({ action: ['write'] })
    expect(askRule.effect).toBe('ask')
    expect(askRule.conditions).toEqual({ action: ['read'] })
    // 主体/客体/端在 scope 里声明一次，两条规则共享（去重的正是它）
    expect(policy.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    for (const rule of policy.rules) {
      expect(rule.match).toContain('inDir(object.path, credentialDirs)')
    }
    // 凭据清单在 let 中共享（一份清单两条规则 —— 读写保护面不会漂移）
    const dirs = policy.lets!.credentialDirs
    expect(dirs).toContain("'.ssh'")
    expect(dirs).toContain("'.aws'")
    expect(dirs).toContain("'.gnupg'")
    expect(dirs).toContain("'.netrc'")
    expect(dirs).toContain('vars.home')
  })

  it('BP-3c block-catastrophic-commands：deny × execute × command × 三条结构化规则，两端同待遇', () => {
    const policy = byName('block-catastrophic-commands')
    expect(policy.rules).toHaveLength(3)
    // 无 env.host —— 扩展端当前没有命令工具，规则天然不命中；将来有了自动同待遇
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['command'] })
    for (const rule of policy.rules) {
      expect(rule.effect).toBe('deny')
      expect(rule.conditions).toEqual({ action: ['execute'] })
    }
    // 规则 0：递归强删根目录 —— 短选项簇（大小写各一支）或长选项齐全，且目标是 / 或 /*
    expect(policy.rules[0].match).toContain("hasShortFlags(c.argv, 'rf')")
    expect(policy.rules[0].match).toContain("hasShortFlags(c.argv, 'Rf')")
    expect(policy.rules[0].match).toContain('recursiveForce.all(')
    expect(policy.rules[0].match).toContain("a == '/'")
    expect(policy.rules[0].match).toContain("a == '/*'")
    // 规则 1：mkfs（名字相等或 mkfs. 前缀）/ dd 的 of= / 重定向 —— 打块设备的三种写法
    expect(policy.rules[1].match).toContain("c.base == 'mkfs' || c.base.startsWith('mkfs.')")
    expect(policy.rules[1].match).toContain("'of=' + d")
    expect(policy.rules[1].match).toContain('object.writes.exists(')
    // 规则 2：Windows 的两条，base 与参数都过 lowerAscii
    expect(policy.rules[2].match).toContain("lowerAscii() == 'format'")
    expect(policy.rules[2].match).toContain("startsWith('/w:')")
    // 清单本体在 lets 中（lets 只见 vars，故是纯字面清单）
    for (const prefix of ['/dev/sd', '/dev/nvme', '/dev/disk', '/dev/hd', '/dev/vd']) {
      expect(policy.lets!.blockDevices).toContain(prefix)
    }
    expect(policy.lets!.recursiveForce).toContain('--recursive')
    expect(policy.lets!.recursiveForce).toContain('--force')
  })

  it('BP-3c-b block-catastrophic-commands：三条规则的 match 都不看命令原文', () => {
    // 结构化改造的本质就是这一条：判定只读解析产物（commands / writes），不读
    // object.command。留一条原文正则在里面，前面所有「引号/嵌套/重定向」的收益都会被
    // 那条正则的误拦重新吃掉（`git commit -m "format c:"` 即是）。
    // 询问材料仍用 object.command（ask-on-command 要把原文摆给用户看），不受此约束。
    for (const rule of byName('block-catastrophic-commands').rules) {
      // 负向前瞻只排除 object.command 本身，object.commands 是允许的
      expect(rule.match).not.toMatch(/object\.command(?!s)/)
    }
  })

  it('BP-3 ask-on-command：ask × execute × command，无渠道收窄（无 match）', () => {
    const policy = byName('ask-on-command')
    expect(policy.rules).toHaveLength(1)
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['command'] })
    expect(withoutPrompt(policy.rules[0])).toEqual({
      effect: 'ask',
      conditions: { action: ['execute'] }
    })
    expect(policy.rules[0].prompt).toBeTruthy()
  })

  it('BP-3 git-safety：ask × gitTool，match 显式表达破坏性组合（init/restore、checkout&&force、branch&&delete）', () => {
    const policy = byName('git-safety')
    expect(policy.rules).toHaveLength(1)
    const rule = policy.rules[0]
    expect(rule.effect).toBe('ask')
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['gitTool'] })
    expect(rule.conditions).toBeUndefined()
    expect(rule.match).toContain("object.gitAction in ['init', 'restore']")
    expect(rule.match).toContain("object.gitAction == 'checkout' && object.force")
    expect(rule.match).toContain("object.gitAction == 'branch' && object.delete")
  })

  it('BP-3d ask-on-database：ask × execute × database × 可写连接，两端同待遇（刻意无 env.host 条件）', () => {
    const policy = byName('ask-on-database')
    expect(policy.rules).toHaveLength(1)
    const rule = policy.rules[0]
    expect(rule.effect).toBe('ask')
    // 无 env.host —— 扩展端没有 database 工具，规则天然不命中；钉住防日后被无声加上
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['database'] })
    expect(rule.conditions).toEqual({ action: ['execute'] })
    // 只读连接放行的判定在 match 里；刻意不按 SQL 文本分辨读写
    expect(rule.match).toBe('!object.readonly')
    expect(rule.match).not.toContain('sql')
  })

  it('BP-T1 出厂的调用门只有一道，且必须按工具名收窄（别的工具照走 L1 非事件快路）', () => {
    // 原先这条是「出厂一道调用门都没有」。ask-on-sub-session 是刻意加的第一道：
    // 开一条子会话开出去的是**一整场会自己跑的对话**，值得一次询问，而它没有路径/命令
    // 那样的专属客体，只能落在 invocation 上。
    //
    // 于是不变式换成更要紧的那一条：**调用门必须窄**。L1 每次工具调用都过，靠
    // 「probe 得 allow 就走非事件快路（不弹窗不记日志）」活着；一条不按 tool.name 收窄的
    // ask/deny 会让**每个**工具调用都落进真评估 —— 免询问会话会以每调用一条的速度刷爆
    // 决策 ring buffer。
    const gates: string[] = []
    for (const policy of buildBuiltinPolicies()) {
      for (const rule of policy.rules) {
        // allow/force-allow 命中 invocation 无害：L1 对 allow 一律走非事件快路，与默认放行同待遇
        if (rule.effect === 'allow' || rule.effect === 'force-allow') continue
        const effective = mergeConditions(policy.scope, rule.conditions)
        const objectTypes = effective?.['object.type']
        expect(objectTypes, `${policy.name} 的 ${rule.effect} 规则未限定 object.type`).toBeDefined()
        if (!objectTypes?.includes('invocation')) continue
        gates.push(policy.name)
        // 收窄的判据必须在规则里点名工具 —— 否则别的工具全被拖下快路
        expect(rule.match, `${policy.name} 的调用门未按 tool.name 收窄`).toContain('tool.name')
      }
    }
    expect(gates).toEqual(['ask-on-sub-session'])
  })

  it('BP-T2 ask-on-sub-session 只拦"开"这一个动作（发消息/等待/读取都不再问）', () => {
    const policy = byName('ask-on-sub-session')
    expect(policy.rules).toHaveLength(1)
    const rule = policy.rules[0]
    expect(rule.effect).toBe('ask')
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['invocation'] })
    expect(rule.conditions).toEqual({ action: ['execute'] })
    // 判据同时点名工具与动作：只有 create-sub-session 会问，session 工具的别的 action
    // （set-title / prompt / wait / read / stop）与别的工具一律走快路
    expect(rule.match).toContain("tool.name == 'session'")
    expect(rule.match).toContain("tool.operation == 'create-sub-session'")
  })

  it('BP-4 同语言两次调用返回同一引用（按语言缓存）；不同语言各自缓存', () => {
    expect(buildBuiltinPolicies()).toBe(buildBuiltinPolicies())
    expect(buildBuiltinPolicies('zh')).toBe(buildBuiltinPolicies('zh'))
    expect(buildBuiltinPolicies('zh')).not.toBe(buildBuiltinPolicies())
  })
})

describe('buildBuiltinPolicies — 多语言', () => {
  it('BP-5 每份策略的每个语言文件都可独立解析，且 name 与 spec 一致', () => {
    for (const spec of BUILTIN_POLICY_SPECS) {
      for (const [lang, raw] of Object.entries(spec.sources)) {
        const parsed = parsePolicyDefinitionFile(raw, spec.name)
        expect(parsed, `${spec.name}.${lang} 解析失败`).not.toBeNull()
        expect(parsed!.name, `${spec.name}.${lang} name 漂移`).toBe(spec.name)
      }
    }
  })

  it('BP-6 规则一致性：各语言文件的判定字段与 lets 与 en 逐字段一致（翻译漂移守护）', () => {
    // prompt 是唯一允许各语言不同的规则字段（人读提示语，不参与匹配）——
    // 比较时剥掉它，其余判定字段（effect/conditions/match）仍必须与 en 逐字一致
    for (const spec of BUILTIN_POLICY_SPECS) {
      const canonical = parsePolicyDefinitionFile(spec.sources.en, spec.name)!
      for (const [lang, raw] of Object.entries(spec.sources)) {
        if (lang === 'en') continue
        const localized = parsePolicyDefinitionFile(raw, spec.name)!
        expect(
          localized.rules.map(withoutPrompt),
          `${spec.name}.${lang} 的 rules 与 en 不一致`
        ).toEqual(canonical.rules.map(withoutPrompt))
        expect(localized.lets, `${spec.name}.${lang} 的 lets 与 en 不一致`).toEqual(canonical.lets)
      }
    }
  })

  it('BP-6b prompt 逐条本地化：每条内置规则都写了 prompt，且各语言互不相同', () => {
    // 内置策略「都加上 prompt」是这一版的约定；漏写一条即红。
    // 各语言不同则证明 overlay 生效（否则中/日用户会在询问卡片上读到英文）
    for (const spec of BUILTIN_POLICY_SPECS) {
      const canonical = parsePolicyDefinitionFile(spec.sources.en, spec.name)!
      canonical.rules.forEach((rule, i) => {
        expect(rule.prompt, `${spec.name}.en 规则 #${i} 缺 prompt`).toBeTruthy()
      })
      for (const [lang, raw] of Object.entries(spec.sources)) {
        if (lang === 'en') continue
        const localized = parsePolicyDefinitionFile(raw, spec.name)!
        expect(localized.rules, `${spec.name}.${lang} 规则条数与 en 不同`).toHaveLength(
          canonical.rules.length
        )
        localized.rules.forEach((rule, i) => {
          expect(rule.prompt, `${spec.name}.${lang} 规则 #${i} 缺 prompt`).toBeTruthy()
          expect(rule.prompt, `${spec.name}.${lang} 规则 #${i} 未翻译`).not.toBe(
            canonical.rules[i].prompt
          )
        })
      }
    }
  })

  it('BP-6c buildBuiltinPolicies 按语言 overlay prompt：判定字段恒取 en，prompt 取本地化文件', () => {
    const en = buildBuiltinPolicies()
    for (const language of ['zh', 'ja']) {
      const localized = buildBuiltinPolicies(language)
      for (const policy of localized) {
        const canonical = en.find((p) => p.name === policy.name)!
        const raw = BUILTIN_POLICY_SPECS.find((s) => s.name === policy.name)!.sources[language]
        const fromFile = parsePolicyDefinitionFile(raw, policy.name)!
        policy.rules.forEach((rule, i) => {
          expect(rule.prompt, `${policy.name}.${language} 规则 #${i} 未取本地化 prompt`).toBe(
            fromFile.rules[i].prompt
          )
          expect(withoutPrompt(rule), `${policy.name}.${language} 规则 #${i} 判定字段漂移`).toEqual(
            withoutPrompt(canonical.rules[i])
          )
        })
      }
    }
  })

  it('BP-7 语言回退：zh/zh-CN 取中文人读面，未知语言与缺省取 en；规则恒等于 en', () => {
    const en = buildBuiltinPolicies()
    const zh = buildBuiltinPolicies('zh')
    const zhCn = buildBuiltinPolicies('zh-CN')
    const fr = buildBuiltinPolicies('fr')

    const pick = (list: ParsedPolicyFile[]): ParsedPolicyFile =>
      list.find((p) => p.name === 'ask-on-write')!

    // 人读面本地化：zh 与 en 的 description 不同，zh-CN 基础语言回退到 zh
    expect(pick(zh).description).not.toBe(pick(en).description)
    expect(pick(zhCn).description).toBe(pick(zh).description)
    // 未知语言整文件回退 en
    expect(pick(fr).description).toBe(pick(en).description)

    // 判定字段与语言无关（安全语义唯一事实源 = en）；prompt 是人读面，随语言变
    for (const list of [zh, zhCn, fr]) {
      expect(list.map((p) => p.rules.map(withoutPrompt))).toEqual(
        en.map((p) => p.rules.map(withoutPrompt))
      )
      expect(list.map((p) => p.lets)).toEqual(en.map((p) => p.lets))
    }
    // fr 整文件回退 en，连 prompt 也是 en 原文
    expect(fr.map((p) => p.rules)).toEqual(en.map((p) => p.rules))
  })

  it('BP-8 ja 人读面同样本地化', () => {
    const ja = buildBuiltinPolicies('ja')
    const en = buildBuiltinPolicies()
    for (const policy of ja) {
      const canonical = en.find((p) => p.name === policy.name)!
      expect(policy.description).not.toBe(canonical.description)
      expect(policy.rules.map(withoutPrompt)).toEqual(canonical.rules.map(withoutPrompt))
    }
  })

  it('PU-8 serialize→parse 往返：全部内置 × en/zh/ja 逐字段不变（「创建覆盖副本」不改变安全语义的根契约）', () => {
    // 设置页的「创建覆盖副本」初值就是 serializePolicyDefinitionFile(内置)，
    // 用户不改一个字直接保存后，落盘文件被同一个解析器读回 —— 这条往返一旦不等，
    // 覆盖副本会在用户毫无察觉的情况下改变一道出厂防护的语义。
    for (const language of ['en', 'zh', 'ja']) {
      for (const policy of buildBuiltinPolicies(language)) {
        const label = `${policy.name}.${language}`
        const roundTripped = parsePolicyDefinitionFile(
          serializePolicyDefinitionFile(policy),
          policy.name
        )
        expect(roundTripped, `${label} 回读失败`).not.toBeNull()
        // 逐字段整体比较（scope/lets 缺省时两侧都无该键）
        expect(roundTripped, `${label} 往返漂移`).toEqual({
          name: policy.name,
          displayName: policy.displayName,
          description: policy.description,
          rules: policy.rules,
          ...(policy.scope ? { scope: policy.scope } : {}),
          ...(policy.lets ? { lets: policy.lets } : {}),
          body: policy.body
        })
      }
    }
  })

  it('BP-9 displayName：每份内置都有显示名（≠ name 的 slug）且 zh/ja 本地化', () => {
    const en = buildBuiltinPolicies()
    const zh = buildBuiltinPolicies('zh')
    const ja = buildBuiltinPolicies('ja')
    for (const policy of en) {
      // en 显示名存在且不是 kebab slug 本身
      expect(policy.displayName.length).toBeGreaterThan(0)
      expect(policy.displayName).not.toBe(policy.name)
      const zhPolicy = zh.find((p) => p.name === policy.name)!
      const jaPolicy = ja.find((p) => p.name === policy.name)!
      expect(zhPolicy.displayName).not.toBe(policy.displayName)
      expect(jaPolicy.displayName).not.toBe(policy.displayName)
    }
  })
})

describe('内置策略行为判定（assembleRules + evaluate 端到端）', () => {
  /** 内置策略引用的完整桌面变量表 */
  const DESKTOP_VARS: Record<string, string | string[]> = {
    workspace: '/ws',
    toolResultsBase: '/tool-results',
    skillsDirs: ['/skills/a', '/skills/b'],
    memoryDirs: ['/memory'],
    home: '/Users/u',
    botsDir: '/Users/u/.shuvix/bots',
    systemDirs: []
  }

  function makeProvider(overrides: Partial<SecurityHostProvider> = {}): SecurityHostProvider {
    return {
      host: 'desktop',
      pathSep: '/',
      getVars: () => DESKTOP_VARS,
      getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
      ...overrides
    }
  }

  interface DecideOpts {
    subjectKind?: 'agent' | 'user'
    host?: 'desktop' | 'extension'
    provider?: SecurityHostProvider
    warn?: (msg: string) => void
  }

  /**
   * 仅内置策略的完整装配 + 统一评估。
   *
   * vars 必须走 buildPolicyVars（生产路径 context.ts 同款）：直接用 provider.getVars()
   * 会缺 autoAllow/grantedRead/grantedWrite，strict 语义下 session-* 两份策略的 match
   * 报错走 fail-safe —— force-allow 规则视为不命中（方向安全），但每次评估都刷告警。
   */
  function decide(action: string, object: SecurityObject, opts: DecideOpts = {}): SecurityDecision {
    const provider = opts.provider ?? makeProvider()
    const vars = buildPolicyVars(provider)
    return evaluate(
      assembleRules(provider, vars),
      {
        subject: { kind: opts.subjectKind ?? 'agent', sessionId: 's1', agentKind: 'root' },
        action,
        object,
        environment: { host: opts.host ?? 'desktop', platform: 'darwin' }
      },
      { vars, warn: opts.warn }
    )
  }

  /** gitTool 客体属性齐全（布尔恒在 —— PEP 对偶约定） */
  const gitObject = (
    gitAction: string,
    flags: { force?: boolean; del?: boolean } = {}
  ): SecurityObject => ({
    type: 'gitTool',
    gitAction,
    command: `git ${gitAction}`,
    force: flags.force ?? false,
    delete: flags.del ?? false
  })

  it('BP-N2 git-safety 行为判定表：init/restore/checkout(force)/branch(delete) → ask，其余组合 → allow', () => {
    const cases: Array<[string, { force?: boolean; del?: boolean }, 'ask' | 'allow']> = [
      ['init', {}, 'ask'],
      ['restore', {}, 'ask'],
      ['checkout', {}, 'allow'],
      ['checkout', { force: true }, 'ask'],
      ['branch', {}, 'allow'],
      ['branch', { del: true }, 'ask'],
      ['add', {}, 'allow'],
      ['commit', {}, 'allow'],
      ['status', {}, 'allow']
    ]
    for (const [gitAction, flags, expected] of cases) {
      const decision = decide('execute', gitObject(gitAction, flags))
      expect({ gitAction, flags, effect: decision.effect }).toEqual({
        gitAction,
        flags,
        effect: expected
      })
      expect(decision.winning).toBe(expected === 'ask' ? 'git-safety#0' : 'default:gitTool')
    }
  })

  // block-catastrophic-commands 的行为判定表已迁往 blockCatastrophicCommands.test.ts ——
  // 它是唯一读结构事实的内置策略，用例要起 tree-sitter 解析器，与本文件「md 形态守卫 +
  // 各策略一两条行为抽查」的定位不同（BP-3c / BP-3c-b 仍在本文件守形态）。

  it('BP-N3 env.host 守卫：desktop 各门就位（deny/ask/deny/ask）；extension 同请求全部 default allow', () => {
    const cases: Array<[string, string, SecurityObject, 'deny' | 'ask', string]> = [
      [
        '凭据路径写',
        'write',
        { type: 'path', path: '/Users/u/.ssh/id_rsa' },
        'deny',
        'protect-credentials#0'
      ],
      [
        '凭据路径读',
        'read',
        { type: 'path', path: '/Users/u/.ssh/id_rsa' },
        'ask',
        'protect-credentials#1'
      ],
      ['系统目录写', 'write', { type: 'path', path: '/etc/hosts' }, 'deny', 'protect-system#0'],
      ['普通路径写', 'write', { type: 'path', path: '/Users/u/doc.txt' }, 'ask', 'ask-on-write#0']
    ]
    for (const [label, action, object, effect, winning] of cases) {
      const desktop = decide(action, object)
      expect({ label, effect: desktop.effect, winning: desktop.winning }).toEqual({
        label,
        effect,
        winning
      })

      const extension = decide(action, object, { host: 'extension' })
      expect({ label, effect: extension.effect, winning: extension.winning }).toEqual({
        label,
        effect: 'allow',
        winning: 'default:path'
      })
    }
  })

  it('BP-N4 扩展端空 vars 端到端：任意路径读写 allow 且零告警；git 破坏性操作仍 ask（git-safety 无 host 守卫）', () => {
    const warn = vi.fn()
    const provider = makeProvider({
      host: 'extension',
      // 对齐 apps/extension/src/runtime/securityProvider.ts 的空值供给
      getVars: () => ({
        workspace: '',
        toolResultsBase: '',
        skillsDirs: [],
        memoryDirs: [],
        home: '',
        botsDir: '',
        systemDirs: []
      }),
      logger: { info: vi.fn(), warn, error: vi.fn() }
    })
    const opts: DecideOpts = { provider, host: 'extension', warn }

    const pathCases: Array<[string, string]> = [
      ['read', '/anywhere/f.txt'],
      ['write', '/anywhere/f.txt'],
      // home='' 时 credentialDirs 形如 '/.ssh'：host 守卫必须先挡住
      ['read', '/.ssh/id_rsa'],
      ['write', '/etc/hosts']
    ]
    for (const [action, path] of pathCases) {
      const decision = decide(action, { type: 'path', path }, opts)
      expect({ action, path, effect: decision.effect }).toEqual({ action, path, effect: 'allow' })
      expect(decision.winning).toBe('default:path')
    }
    expect(warn).not.toHaveBeenCalled()

    const git = decide('execute', gitObject('init'), opts)
    expect(git.effect).toBe('ask')
    expect(git.winning).toBe('git-safety#0')
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-N5 决策归因：凭据读写归因 protect-credentials（装配序先于 ask-on-read）；普通区外读归因 ask-on-read', () => {
    const write = decide('write', { type: 'path', path: '/Users/u/.ssh/id_rsa' })
    expect(write.effect).toBe('deny')
    expect(write.winning).toBe('protect-credentials#0')

    // 凭据读同时命中 ask-on-read（工作区外读）：winning 归因先装配的 protect-credentials
    const read = decide('read', { type: 'path', path: '/Users/u/.ssh/id_rsa' })
    expect(read.effect).toBe('ask')
    expect(read.winning).toBe('protect-credentials#1')
    expect(read.matched).toEqual(['protect-credentials#1', 'ask-on-read#0'])

    const other = decide('read', { type: 'path', path: '/Users/u/other.txt' })
    expect(other.effect).toBe('ask')
    expect(other.winning).toBe('ask-on-read#0')
  })

  it('BP-N7 ask-on-read 三豁免：workspace/toolResultsBase/skillsDirs（数组各项）内读 allow；三者之外 ask', () => {
    const exempt = ['/ws/f.txt', '/tool-results/r.json', '/skills/a/SKILL.md', '/skills/b/sub/x.md']
    for (const path of exempt) {
      const decision = decide('read', { type: 'path', path })
      expect({ path, effect: decision.effect }).toEqual({ path, effect: 'allow' })
      expect(decision.winning).toBe('default:path')
    }

    const outside = decide('read', { type: 'path', path: '/elsewhere/f.txt' })
    expect(outside.effect).toBe('ask')
    expect(outside.winning).toBe('ask-on-read#0')
  })

  it('BP-N8 user 主体：凭据写/系统目录写/普通写/区外读/命令/git 破坏操作 六策略全不命中 → allow', () => {
    const cases: Array<[string, SecurityObject]> = [
      ['write', { type: 'path', path: '/Users/u/.ssh/id_rsa' }],
      ['write', { type: 'path', path: '/etc/hosts' }],
      ['write', { type: 'path', path: '/Users/u/doc.txt' }],
      ['read', { type: 'path', path: '/elsewhere/f.txt' }],
      ['execute', { type: 'command', channel: 'bash', command: 'rm -rf /' }],
      ['execute', gitObject('init')]
    ]
    for (const [action, object] of cases) {
      const decision = decide(action, object, { subjectKind: 'user' })
      expect({ action, object, effect: decision.effect }).toEqual({
        action,
        object,
        effect: 'allow'
      })
      expect(decision.matched).toEqual([])
    }
  })

  /** database 客体属性齐全（PEP 对偶约定：该 type 的已知属性全部给值） */
  const dbObject = (readonly: boolean, sql = 'SELECT 1'): SecurityObject => ({
    type: 'database',
    sql,
    credential: 'prod-mysql',
    dbType: 'mysql',
    readonly
  })

  it('BP-N9 ask-on-database 行为判定表：可写连接 ask（不论 SQL 读写）、只读连接放行、非 execute/非 agent/他类客体不命中', () => {
    // ① 可写连接：SQL 文本形态无关（询问层刻意不判读 SQL）
    for (const sql of ['SELECT * FROM users', "INSERT INTO users VALUES (1, 'a')"]) {
      const decision = decide('execute', dbObject(false, sql))
      expect({ sql, effect: decision.effect }).toEqual({ sql, effect: 'ask' })
      expect(decision.winning).toBe('ask-on-database#0')
    }

    // ② 只读连接：DB 服务端已拒写，无需确认
    const readonly = decide('execute', dbObject(true))
    expect(readonly.effect).toBe('allow')
    expect(readonly.winning).toBe('default:database')

    // ③ action 非 execute（策略的 action 守卫）
    const wrongAction = decide('read', dbObject(false))
    expect(wrongAction.effect).toBe('allow')
    expect(wrongAction.winning).toBe('default:database')

    // ④ user 主体：内置防护只作用于 agent
    const asUser = decide('execute', dbObject(false), { subjectKind: 'user' })
    expect(asUser.effect).toBe('allow')
    expect(asUser.matched).toEqual([])

    // ⑤ 他类客体一律不被数据库门牵连
    const others: Array<[string, SecurityObject]> = [
      ['command', { type: 'command', channel: 'bash', command: 'psql -c "drop table t"' }],
      ['path', { type: 'path', path: '/Users/u/doc.txt' }],
      ['gitTool', gitObject('init')],
      ['invocation', { type: 'invocation' }]
    ]
    for (const [label, object] of others) {
      const decision = decide(label === 'path' ? 'write' : 'execute', object)
      expect(decision.matched, `${label} 客体被数据库门牵连`).not.toContain('ask-on-database#0')
    }
  })

  it('BP-N10 database 客体属性齐全性：可写/只读各评估一次，logger.warn 零调用（无 strict fail-safe）', () => {
    const warn = vi.fn()
    const provider = makeProvider({ logger: { info: vi.fn(), warn, error: vi.fn() } })
    const opts: DecideOpts = { provider, warn }

    expect(decide('execute', dbObject(false), opts).effect).toBe('ask')
    expect(decide('execute', dbObject(true), opts).effect).toBe('allow')
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-N11 fail-safe 方向：database 客体缺 readonly 属性 → 仍 ask 且告警含规则 id（保护不静默蒸发）', () => {
    const warn = vi.fn()
    // 属性缺失是 PEP 违约；strict 语义下 !object.readonly 报错 → ask 规则 fail-safe 命中
    const incomplete: SecurityObject = {
      type: 'database',
      sql: 'SELECT 1',
      credential: 'prod-mysql',
      dbType: 'mysql'
    }
    const decision = decide('execute', incomplete, { warn })

    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('ask-on-database#0')
    const failSafe = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('match evaluation failed'))
    expect(failSafe).toHaveLength(1)
    expect(failSafe[0]).toContain("'ask-on-database#0'")
    expect(failSafe[0]).toContain('treating as matched (fail-safe)')
  })

  // ── 命中提示语的真实组合（内置策略确实两两同 tier 命中的那几处）
  /** 某份内置策略的显示名（不硬编码文案 —— 它随界面语言变） */
  const displayNameOf = (policy: string, language?: string): string =>
    buildBuiltinPolicies(language).find((p) => p.name === policy)!.displayName
  /** 某条内置规则的 prompt 原文（同上，取自 md 而不是抄进断言） */
  const promptOf = (policy: string, index: number, language?: string): string =>
    buildBuiltinPolicies(language).find((p) => p.name === policy)!.rules[index].prompt!

  it('BP-P1 区外读凭据文件：protect-credentials#1 与 ask-on-read#0 同 tier 命中 → 两段文案 + 两个署名', () => {
    const decision = decide('read', { type: 'path', path: '/Users/u/.ssh/id_rsa' })
    expect(decision.effect).toBe('ask')
    // 归因不变：winning 仍是先装配的那条（提示语汇总不改变胜出规则）
    expect(decision.winning).toBe('protect-credentials#1')
    expect(decision.matched).toEqual(['protect-credentials#1', 'ask-on-read#0'])
    expect(decision.prompt).toEqual({
      // 装配序：protect-credentials 在 ask-on-read 之前
      text: `${promptOf('protect-credentials', 1)}\n\n${promptOf('ask-on-read', 0)}`,
      rules: ['protect-credentials#1', 'ask-on-read#0'],
      policies: [displayNameOf('protect-credentials'), displayNameOf('ask-on-read')]
    })
  })

  it('BP-P2 写系统目录（protect-system deny + ask-on-write ask 同时命中）→ 只带 protect-system 那段', () => {
    const decision = decide('write', { type: 'path', path: '/etc/hosts' })
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['protect-system#0', 'ask-on-write#0'])
    // 非胜出 tier 不贡献：deny 赢了，询问门那句话就无关了
    expect(decision.prompt).toEqual({
      text: promptOf('protect-system', 0),
      rules: ['protect-system#0'],
      policies: [displayNameOf('protect-system')]
    })
  })

  it('BP-P3 autoAllow 打开后的普通写 → effect allow 且无 prompt（放行不带话）', () => {
    const provider = makeProvider({
      getSessionGrants: () => ({ autoAllow: true, allowList: [] })
    })
    const decision = decide('write', { type: 'path', path: '/ws/f.txt' }, { provider })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('session-auto-allow#0')
    expect(decision.prompt).toBeUndefined()
  })

  it('BP-P4 language=zh/ja：prompt 换成对应语言，effect/winning/matched 一字不变', () => {
    const en = decide('read', { type: 'path', path: '/Users/u/.ssh/id_rsa' })
    for (const language of ['zh', 'ja']) {
      const provider = makeProvider({ getLanguage: () => language })
      const decision = decide('read', { type: 'path', path: '/Users/u/.ssh/id_rsa' }, { provider })

      expect(decision.effect, language).toBe(en.effect)
      expect(decision.winning, language).toBe(en.winning)
      expect(decision.matched, language).toEqual(en.matched)

      expect(decision.prompt!.text, language).toBe(
        `${promptOf('protect-credentials', 1, language)}\n\n${promptOf('ask-on-read', 0, language)}`
      )
      expect(decision.prompt!.text, language).not.toBe(en.prompt!.text)
      expect(decision.prompt!.policies, language).toEqual([
        displayNameOf('protect-credentials', language),
        displayNameOf('ask-on-read', language)
      ])
    }
  })

  it('BP-P5 扩展端（空 vars）git 破坏性操作 ask → 带 git-safety 那段 prompt', () => {
    const warn = vi.fn()
    const provider = makeProvider({
      host: 'extension',
      getVars: () => ({
        workspace: '',
        toolResultsBase: '',
        skillsDirs: [],
        memoryDirs: [],
        home: '',
        systemDirs: []
      }),
      logger: { info: vi.fn(), warn, error: vi.fn() }
    })
    const decision = decide('execute', gitObject('checkout', { force: true }), {
      provider,
      host: 'extension',
      warn
    })

    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('git-safety#0')
    expect(decision.prompt).toEqual({
      text: promptOf('git-safety', 0),
      rules: ['git-safety#0'],
      policies: [displayNameOf('git-safety')]
    })
    expect(warn).not.toHaveBeenCalled()
  })

  // ── protect-bot-notes：唯一一份 force-ask 的内置门 ────────────────────────
  //
  // 它守的是 `~/.shuvix/bots/` —— agent 唯一会去改**关于它自己**的那份文件。设计 §8.2
  // 明确接受「每次笔记归纳都撞一张卡」这个代价，所以这一组钉的全是那个代价的形状：
  // 谁撞、谁不撞、免询问开着还撞不撞、以及撞的时候到底几张卡。
  //
  // 放在本文件而不是某个 bot 测试里，是因为它是一份**内置策略**：它的判定完全由
  // md + 引擎决定，与 botService 有没有把笔记派发出去无关。

  const botFile = (path = '/Users/u/.shuvix/bots/scout.md'): SecurityObject => ({
    type: 'path',
    path
  })
  const autoAllowProvider = (): SecurityHostProvider =>
    makeProvider({ getSessionGrants: () => ({ autoAllow: true, allowList: [] }) })

  it('BP-B1 agent 写 bots 目录 → ask，归因 protect-bot-notes#0（tier 是 force-ask）', () => {
    const decision = decide('write', botFile())
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('protect-bot-notes#0')
    // ask-on-write 同样命中（任意写都问）—— 归因取装配序靠前的那条，但 tier 由 force 决定
    expect(decision.matched).toContain('ask-on-write#0')
  })

  it('BP-B2 免询问开着照样 ask —— force-ask 压过 session-auto-allow 的 force-allow', () => {
    // 这是这份策略存在的**全部理由**：笔记段跑在节流之后、没人看着的时候，而一次整份
    // 重写既可能悄悄丢掉半份笔记，也可能改掉分界线以上的人设。对照组是同一开关下的普通写
    const provider = autoAllowProvider()
    expect(decide('write', botFile(), { provider }).effect).toBe('ask')
    expect(decide('write', botFile(), { provider }).winning).toBe('protect-bot-notes#0')
    // 对照：工作区里的普通写在同一开关下是放行的 —— 免询问本身没坏，只是盖不住这一道
    expect(decide('write', { type: 'path', path: '/ws/f.txt' }, { provider }).effect).toBe('allow')
  })

  it('BP-B3 「允许并记住」也压不过：授权了整个 bots 目录仍然 ask', () => {
    // session-path-grants 与 session-auto-allow 同为 force-allow 层，而这道门在它之上。
    // 少了这条，用户在第一张卡上点一次「允许并记住」就等于永久关掉了这道门
    const provider = makeProvider({
      getSessionGrants: () => ({
        autoAllow: false,
        allowList: ['Write(/Users/u/.shuvix/bots)']
      })
    })
    const decision = decide('write', botFile(), { provider })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('protect-bot-notes#0')
  })

  it('BP-B4 force-ask 胜出时不给 rememberEntry —— 不给一个点了不生效的按钮', () => {
    // buildAskMaterials 的这一刀是 BP-B3 的 UI 对位：那条「记住」的授权落在 force-allow
    // 层、压不过这道门，把按钮画出来等于给一个假承诺。对照普通写（同样 ask）是给的
    const guarded = decide('write', botFile())
    expect(guarded.ask?.command).toBeTruthy()
    expect(guarded.ask?.rememberEntry).toBeUndefined()

    const ordinary = decide('write', { type: 'path', path: '/ws/f.txt' })
    expect(ordinary.effect).toBe('ask')
    expect(ordinary.ask?.rememberEntry).toBeTruthy()
  })

  it('BP-B5 user 主体不受约束：同一路径的写在 user 主体下放行', () => {
    // 主体模型的分界（BP-2b 的行为面）：用户在设置页里保存 bot md 走的是 user 主体，
    // 内置防护一条都不作用于它 —— 否则用户每按一次保存都要给自己弹一张卡
    const decision = decide('write', botFile(), { subjectKind: 'user' })
    expect(decision.effect).toBe('allow')
    expect(decision.matched).toEqual([])
  })

  it('BP-B6 扩展端不命中：同一请求在 extension 下放行且零告警', () => {
    // scope 里的 `env.host: [desktop]` 是native 条件，排在 CEL 之前 —— 所以扩展端连
    // `vars.botsDir` 都不会去读（它在扩展端根本不存在，读了就是一次 strict 报错 + 告警）
    const warn = vi.fn()
    const provider = makeProvider({
      host: 'extension',
      getVars: () => ({
        workspace: '',
        toolResultsBase: '',
        skillsDirs: [],
        memoryDirs: [],
        home: '',
        systemDirs: []
      })
    })
    const decision = decide('write', botFile(), { provider, host: 'extension', warn })
    expect(decision.effect).toBe('allow')
    expect(decision.matched).not.toContain('protect-bot-notes#0')
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-B7 前缀边界：目录内与子目录内命中，同前缀的兄弟目录不命中', () => {
    // `inDir` 就是 allowList 那个 matchesPathEntry（按路径段而不是按字符串前缀），
    // 所以 `bots-evil` 不是 `bots` 的里面 —— 这条守的是那个 `+ sep`
    const table: Array<[string, boolean]> = [
      ['/Users/u/.shuvix/bots/scout.md', true],
      ['/Users/u/.shuvix/bots/.runs/scout/decisions.jsonl', true],
      // 目录本身（不带尾斜杠）也算在内 —— matchesPathEntry 的等值分支
      ['/Users/u/.shuvix/bots', true],
      ['/Users/u/.shuvix/bots-evil/scout.md', false],
      ['/Users/u/.shuvix/botsy.md', false],
      ['/Users/u/.shuvix/agents/scout.md', false]
    ]
    for (const [path, guarded] of table) {
      const decision = decide('write', botFile(path))
      expect({ path, winning: decision.winning === 'protect-bot-notes#0' }).toEqual({
        path,
        winning: guarded
      })
    }
  })

  it('BP-B8 读不归它管：bots 目录的读由 ask-on-read 兜（区外读），免询问能免掉', () => {
    // 策略正文明写「它一个字都没说读」。读之所以照样问，是因为 bots 目录在工作区之外 ——
    // 两道门的 tier 不同，于是免询问对读生效、对写不生效
    const read = decide('read', botFile())
    expect(read.effect).toBe('ask')
    expect(read.winning).toBe('ask-on-read#0')
    expect(read.matched).not.toContain('protect-bot-notes#0')

    const provider = autoAllowProvider()
    expect(decide('read', botFile(), { provider }).effect).toBe('allow')
  })

  it('BP-B9 一次笔记归纳的账：免询问关着两张卡（read + write），开着一张（只剩 write）', () => {
    // 策略正文按这个口径记账（D13 修正的就是这句）。笔记段拿的是 read + edit 两个工具，
    // 而 edit 的写在 apply 层还要过一次 enforcePath —— 所以「两张卡」不是估算，是两次 evaluate
    const off = ['read', 'write'].map((a) => decide(a, botFile()).effect)
    expect(off).toEqual(['ask', 'ask'])

    const provider = autoAllowProvider()
    const on = ['read', 'write'].map((a) => decide(a, botFile(), { provider }).effect)
    expect(on).toEqual(['allow', 'ask'])
  })

  it('BP-B10 询问文案取自 md：写 bots 目录带 protect-bot-notes 那段，且署名在最前', () => {
    // 同 tier 只有它自己（ask-on-write 落在下一层 ask，不贡献文案）—— 用户看到的那张卡
    // 只讲「这是一份 bot 自己的定义文件」，不掺一句泛泛的「有人要写文件」
    const decision = decide('write', botFile())
    expect(decision.prompt).toEqual({
      text: promptOf('protect-bot-notes', 0),
      rules: ['protect-bot-notes#0'],
      policies: [displayNameOf('protect-bot-notes')]
    })
  })
})
