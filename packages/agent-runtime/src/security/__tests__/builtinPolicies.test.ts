/**
 * 内置策略守护 —— md 是随包发布的编译期常量，解析失败/形态漂移属开发期错误，
 * 这里逐策略钉死形态与安全不变式（内置绝不静默放行写入；出厂没有硬限制 —— 2026-10-01 用户裁定
 * 「默认尽可能少问」，出厂恰两份、都是普通 ask，内置规则里不许出现 deny / force-ask / force-allow）。
 *
 * 出厂两份：ask-on-external-path（文件工具在会话目录 `vars.sessionDirs` 与「允许并记住」的路径以外 ——
 * 读家目录里的文件、往任何地方写 —— 询问）与 ask-on-command（没圈进沙箱的命令询问）。
 *
 * 退役的十一份（protect-system、block-catastrophic-commands、protect-bot-files、protect-shuvix-config、
 * git-safety、ask-on-sub-session、ask-on-database、ask-on-new-site，第二轮的 protect-credentials、
 * ask-on-write、session-grants）不再随包发布；凡是借它们钉引擎机制的用例（deny 压过授权、
 * force-allow 压过询问且放行不带话、提示语只取胜出档、缺属性 fail-safe、env.host 条件先于 CEL…），
 * 改为经 fixtures/retiredPolicies.ts 把它们当作**用户策略**装上。
 *
 * 多语言约束：规则的**判定字段**唯一事实源恒为 en 文件（构建器忽略本地化文件的
 * effect/conditions/match 与 lets），各语言文件的这些字段仍必须与 en 逐字段一致 ——
 * 翻译漂移在此立刻红，而不是静默存在一份「看起来生效实际被忽略」的规则拷贝。
 * 唯一例外是 `prompt`（人读提示语，不参与匹配）：它按语言 overlay，比较时剥掉。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import { builtinObjectId } from '@shuvix/chat-protocol/mdMeta'
import { buildBuiltinPolicies, BUILTIN_POLICY_SPECS } from '../builtinPolicies'
import { parsePolicyDefinitionFile, serializePolicyDefinitionFile } from '../policyFile'
import { assembleRules } from '../assemble'
import { mergeConditions } from '../conditions'
import { evaluate } from '../evaluate'
import { buildPolicyVars } from '../policyVars'
import { inDirOnlyVarNames } from '../celMatch'
import { urlObjectOf } from '../urlObject'
import type {
  ParsedPolicyFile,
  PolicyRuleSpec,
  PolicyVarValue,
  SecurityDecision,
  SecurityHostProvider,
  SecurityObject
} from '../types'
import {
  createInlinePolicyMdReader,
  inlinedPolicyMdFileNames
} from '../builtinPolicies/inlineSources'
import { retiredPolicy, type RetiredPolicyName } from './fixtures/retiredPolicies'

/** 内置策略 md 的构建期内联读取口（运行时单测的宿主接缝；桌面/扩展各注入自己的） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 剥掉人读提示语后的规则 —— 各语言之间做「判定字段一致」比较的口径 */
const withoutPrompt = (rule: PolicyRuleSpec): PolicyRuleSpec => {
  const { prompt: _prompt, ...rest } = rule
  return rest
}

/**
 * 某份内置策略的各语言 md 原文表（键为语言代码，en 必有）—— 从内联读取口现取，
 * 重建改制前 spec.sources 的形状，让 BP-1b/5/6 那批「逐语言文件」守护几乎不用动
 */
const sourcesOf = (name: string): Record<string, string> & { en: string } => {
  const sources: Record<string, string> = {}
  for (const fileName of inlinedPolicyMdFileNames()) {
    if (fileName === `${name}.md`) sources.en = INLINE_POLICY_MD(fileName)!
    else if (fileName.startsWith(`${name}.`))
      sources[fileName.slice(name.length + 1, -'.md'.length)] = INLINE_POLICY_MD(fileName)!
  }
  expect(sources.en, `${name}.md 不在内联表里`).toBeTruthy()
  return sources as Record<string, string> & { en: string }
}

const byName = (name: string): ParsedPolicyFile => {
  const policy = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD }).find((p) => p.name === name)
  expect(policy, `builtin policy '${name}' missing`).toBeDefined()
  return policy!
}

/** 只装内置的最小 provider（形态守护用；行为判定一节有自己的完整版） */
const makeBareProvider = (): SecurityHostProvider => ({
  host: 'desktop',
  pathSep: '/',
  getVars: () => ({}),
  getSessionGrants: () => ({ allowList: [] }),
  readBuiltinPolicyMd: INLINE_POLICY_MD
})

describe('buildBuiltinPolicies', () => {
  it('BP-1 不 throw；恰 2 份、按装配序；名字与 SPECS 一致且互异', () => {
    expect(() => buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })).not.toThrow()
    const policies = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    expect(policies).toHaveLength(2)
    expect(policies.map((p) => p.name)).toEqual(BUILTIN_POLICY_SPECS.map((s) => s.name))
    expect(policies.map((p) => p.name)).toEqual(['ask-on-external-path', 'ask-on-command'])
    expect(new Set(policies.map((p) => p.name)).size).toBe(2)
  })

  it('BP-1c 内联表恰是两份 × en / zh / ja；退役的十一份一个语言文件都不剩', () => {
    const files = [...inlinedPolicyMdFileNames()].sort()
    expect(files).toEqual(
      BUILTIN_POLICY_SPECS.flatMap(({ name }) => [
        `${name}.ja.md`,
        `${name}.md`,
        `${name}.zh.md`
      ]).sort()
    )
    const retired: RetiredPolicyName[] = [
      'protect-system',
      'block-catastrophic-commands',
      'protect-bot-files',
      'protect-shuvix-config',
      'git-safety',
      'ask-on-sub-session',
      'ask-on-database',
      'ask-on-new-site',
      'protect-credentials',
      'ask-on-write',
      'session-grants'
    ]
    for (const name of retired) {
      expect(INLINE_POLICY_MD(`${name}.md`), name).toBeNull()
      expect(
        files.filter((f) => f.startsWith(`${name}.`)),
        name
      ).toEqual([])
    }
  })

  it('BP-1b 每份语言文件都声明 shuvix-builtin: true（新增内置策略漏写即红）', () => {
    for (const spec of BUILTIN_POLICY_SPECS) {
      for (const [language, source] of Object.entries(sourcesOf(spec.name))) {
        expect(source, `${spec.name}.${language}`).toMatch(/^shuvix-builtin: true$/m)
      }
    }
  })

  it('BP-2 不变式：内置策略不含静态 allow 规则（无策略即放行，无需内置豁免）', () => {
    // 静态 allow 只会白占一层 static-allow，既压不过询问门，又让"没有策略就是放行"这条默认语义
    // 多出一个等价的替身。豁免写成询问门 match 里的取反（会话目录、「允许并记住」）；force-allow
    // 出厂同样不用（BP-2d）。
    for (const policy of buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })) {
      for (const rule of policy.rules) {
        expect(rule.effect, `${policy.name} 存在内置 allow 规则`).not.toBe('allow')
      }
    }
  })

  it('BP-2b 不变式：每条内置规则的有效条件都限定 agent 主体（防护不作用于 user 主体）', () => {
    for (const policy of buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })) {
      for (const rule of policy.rules) {
        const effective = mergeConditions(policy.scope, rule.conditions)
        expect(effective?.['subject.kind'], `${policy.name} 规则未限定 agent 主体`).toEqual([
          'agent'
        ])
      }
    }
  })

  it('BP-2c 不变式：凡引用 object 属性的内置规则都声明 object.type（strict 语义下不误拦他类客体）', () => {
    for (const policy of buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })) {
      for (const rule of policy.rules) {
        const effective = mergeConditions(policy.scope, rule.conditions)
        // 不碰 object 属性的规则无需类型守卫 —— strict 只在跨 type 误引用时报错
        if (!rule.match?.includes('object.')) continue
        expect(
          effective?.['object.type'],
          `${policy.name} 的 match 引用了 object 属性却缺 object.type 条件`
        ).toBeDefined()
      }
    }
  })

  it('BP-2d 不变式：出厂没有硬限制、也没有越级放行 —— 没有一条内置规则是 deny / force-ask / force-allow（各语言、装配产物的 tier 都算）', () => {
    // 2026-10-01 用户裁定：内置策略默认尽可能少问、不设硬限制。deny 不可按命令豁免，force-ask
    // 连「允许并记住」与自动审查都答不了 —— 想要这种门，用户自己写一份策略（执行点都还在）。
    // force-allow 也不再用：「允许并记住」从前是 session-grants 的两条 force-allow，如今写成
    // ask-on-external-path 的 match 里的豁免 —— 出厂整套恰是普通 ask。
    for (const language of ['en', 'zh', 'ja']) {
      for (const policy of buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD })) {
        for (const [i, rule] of policy.rules.entries()) {
          expect(rule.effect, `${policy.name}#${i}（${language}）是 ${rule.effect}`).toBe('ask')
        }
      }
    }
    const tiers = assembleRules(makeBareProvider())
      .filter((r) => r.source.kind === 'builtin')
      .map((r) => [r.id, r.tier])
    expect(tiers).toEqual([
      ['ask-on-external-path#0', 'ask'],
      ['ask-on-external-path#1', 'ask'],
      ['ask-on-command#0', 'ask']
    ])
  })

  it('BP-3 ask-on-external-path：两条 ask × path，desktop 限定 —— #0 读家目录里、（只读）会话目录与授权之外的；#1 写会话目录与写授权之外的', () => {
    const policy = byName('ask-on-external-path')
    expect(policy.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    // 没有 let：凭据清单不再单列（凭据都在家目录里），会话目录由宿主按会话设置算好，经
    // vars.sessionDirs（可读写）与 vars.sessionReadDirs（只读：技能、内置知识库）给出
    expect(policy.lets).toBeUndefined()
    expect(policy.rules.map(withoutPrompt)).toEqual([
      {
        effect: 'ask',
        conditions: { action: ['read'] },
        // 只读会话目录只免读；写授权隐含读：读规则两份授权清单都认
        match:
          'inDir(object.path, vars.home)' +
          ' && !inDir(object.path, vars.sessionDirs)' +
          ' && !inDir(object.path, vars.sessionReadDirs)' +
          ' && !inDir(object.path, vars.grantedRead)' +
          ' && !inDir(object.path, vars.grantedWrite)'
      },
      {
        effect: 'ask',
        conditions: { action: ['write'] },
        match: '!inDir(object.path, vars.sessionDirs) && !inDir(object.path, vars.grantedWrite)'
      }
    ])
    for (const rule of policy.rules) {
      expect(rule.prompt).toBeTruthy()
      // 「免询问」开关随第一轮删掉了，没有哪条还读 vars.autoAllow
      expect(rule.match).not.toContain('autoAllow')
    }
  })

  it('BP-3s ask-on-external-path 读到的每个 vars 都只作 inDir 的目录参数 —— 宿主没给时装配替它绑 null：取反的豁免没了（多问），唯一的正向用法 vars.home 让读规则命中不了（BP-E4 / BP-E5）', () => {
    const [read, write] = byName('ask-on-external-path').rules
    expect(inDirOnlyVarNames(read.match!)).toEqual([
      'grantedRead',
      'grantedWrite',
      'home',
      'sessionDirs',
      'sessionReadDirs'
    ])
    expect(inDirOnlyVarNames(write.match!)).toEqual(['grantedWrite', 'sessionDirs'])
  })

  it('BP-3 ask-on-command：ask × execute × command，只问没被圈进沙箱的命令（无渠道收窄）', () => {
    const policy = byName('ask-on-command')
    expect(policy.rules).toHaveLength(1)
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['command'] })
    // 判据是宿主上报的 sandboxed 事实，不看命令文本；缺这个属性（手工构造的客体）按未圈住处理
    expect(withoutPrompt(policy.rules[0])).toEqual({
      effect: 'ask',
      conditions: { action: ['execute'] },
      match: '!has(object.sandboxed) || !object.sandboxed'
    })
    expect(policy.rules[0].prompt).toBeTruthy()
  })

  it('BP-T1 出厂没有调用门：没有一条内置规则的客体是 invocation（或不限客体），L1 对每次工具调用都是非事件快路', () => {
    // L1 每次工具调用都过，靠「probe 得 allow 就走非事件快路（不弹窗不记日志）」活着。出厂唯一的
    // 调用门 ask-on-sub-session 已于 2026-10-01 退役（用户想要可以自己装回，见 context.test 的 CT-RV6）；
    // 将来若要再加，它必须按 tool.name 收窄 —— 一条不收窄的 invocation 门会让**每个**工具调用都落进
    // 真评估、以每调用一条的速度刷爆决策 ring buffer。
    for (const policy of buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })) {
      for (const [i, rule] of policy.rules.entries()) {
        const effective = mergeConditions(policy.scope, rule.conditions)
        const objectTypes = effective?.['object.type']
        expect(objectTypes, `${policy.name}#${i} 未限定 object.type`).toBeDefined()
        expect(objectTypes, `${policy.name}#${i} 不限客体类型`).not.toContain('*')
        expect(objectTypes, `${policy.name}#${i} 是一道调用门`).not.toContain('invocation')
      }
    }
  })

  it('BP-4 同语言两次调用返回同一引用（按语言缓存）；不同语言各自缓存', () => {
    expect(buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })).toBe(
      buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    )
    expect(buildBuiltinPolicies({ language: 'zh', readMd: INLINE_POLICY_MD })).toBe(
      buildBuiltinPolicies({ language: 'zh', readMd: INLINE_POLICY_MD })
    )
    expect(buildBuiltinPolicies({ language: 'zh', readMd: INLINE_POLICY_MD })).not.toBe(
      buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    )
  })
})

describe('buildBuiltinPolicies — 多语言', () => {
  it('BP-5 每份策略的每个语言文件都可独立解析，且 name 与 spec 一致', () => {
    for (const spec of BUILTIN_POLICY_SPECS) {
      for (const [lang, raw] of Object.entries(sourcesOf(spec.name))) {
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
      const canonical = parsePolicyDefinitionFile(sourcesOf(spec.name).en, spec.name)!
      for (const [lang, raw] of Object.entries(sourcesOf(spec.name))) {
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
      const canonical = parsePolicyDefinitionFile(sourcesOf(spec.name).en, spec.name)!
      canonical.rules.forEach((rule, i) => {
        expect(rule.prompt, `${spec.name}.en 规则 #${i} 缺 prompt`).toBeTruthy()
      })
      for (const [lang, raw] of Object.entries(sourcesOf(spec.name))) {
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
    const en = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    for (const language of ['zh', 'ja']) {
      const localized = buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD })
      for (const policy of localized) {
        const canonical = en.find((p) => p.name === policy.name)!
        const raw = sourcesOf(policy.name)[language]
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
    const en = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    const zh = buildBuiltinPolicies({ language: 'zh', readMd: INLINE_POLICY_MD })
    const zhCn = buildBuiltinPolicies({ language: 'zh-CN', readMd: INLINE_POLICY_MD })
    const fr = buildBuiltinPolicies({ language: 'fr', readMd: INLINE_POLICY_MD })

    const pick = (list: ParsedPolicyFile[]): ParsedPolicyFile =>
      list.find((p) => p.name === 'ask-on-external-path')!

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
    const ja = buildBuiltinPolicies({ language: 'ja', readMd: INLINE_POLICY_MD })
    const en = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
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
      for (const policy of buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD })) {
        const label = `${policy.name}.${language}`
        const roundTripped = parsePolicyDefinitionFile(
          serializePolicyDefinitionFile(policy),
          policy.name
        )
        expect(roundTripped, `${label} 回读失败`).not.toBeNull()
        // 逐字段整体比较（scope/lets 缺省时两侧都无该键）
        expect(roundTripped, `${label} 往返漂移`).toEqual({
          name: policy.name,
          // 对象 id 也要原样回来：覆盖副本沿用内置 id，否则它挂不上内置的元数据
          objectId: policy.objectId,
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
    const en = buildBuiltinPolicies({ readMd: INLINE_POLICY_MD })
    const zh = buildBuiltinPolicies({ language: 'zh', readMd: INLINE_POLICY_MD })
    const ja = buildBuiltinPolicies({ language: 'ja', readMd: INLINE_POLICY_MD })
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
  /** 家目录与 ShuviX 的两处数据（~/.shuvix、userData） */
  const HOME = '/Users/u'
  const SHUVIX_HOME = `${HOME}/.shuvix`
  const USER_DATA = `${HOME}/Library/Application Support/ShuviX`
  /** 工作目录（在家目录里 —— 最常见的形态） */
  const WS = `${HOME}/proj`
  /** 本会话的临时目录（命令的 $TMPDIR） */
  const TMP = '/private/tmp/shuvix-501/abcd1234'
  /** 所有会话的 artifacts 根，与本会话那一格 */
  const R = `${SHUVIX_HOME}/artifacts`
  const A = `${R}/sess-1`
  /** 本会话的工具结果 */
  const TR = `${USER_DATA}/tool_results/sess-1`
  /** 本会话勾选的一个知识库（改动都提交进它自己的 git，可回退 —— 所以可读写） */
  const KB = `${SHUVIX_HOME}/knowledge/notes`
  /** 会话目录（可读写）—— 桌面 sessionDirsView 给的那一份（与命令沙箱同一份清单） */
  const SESSION_DIRS = [WS, TMP, A, TR, KB]
  /** 应用包里随包发布的资源（内置技能、内置知识库） */
  const APP_RESOURCES = '/Applications/ShuviX.app/Contents/Resources'
  /** 用户启用的一个技能（在家目录里） */
  const SKILL = `${SHUVIX_HOME}/skills/foo`
  /**
   * 只读会话目录 —— 技能（内置 + 启用的）与内置知识库：读免问，写照问（技能是 agent 自己要遵守的
   * 指令）。应用包那两项在家目录外，读本来就不问；在家目录里的启用技能才看得出这份清单的作用
   */
  const SESSION_READ_DIRS = [`${APP_RESOURCES}/skills`, `${APP_RESOURCES}/knowledge`, SKILL]

  /** 桌面宿主的完整变量表（会话 sess-1、工作目录 WS、uid 501） */
  const DESKTOP_VARS: Record<string, PolicyVarValue> = {
    workspace: WS,
    toolResultsBase: `${USER_DATA}/tool_results`,
    skillsDirs: [`${SHUVIX_HOME}/skills`, `${APP_RESOURCES}/skills`],
    memoryDirs: [`${SHUVIX_HOME}/memory`],
    home: HOME,
    botsDir: `${SHUVIX_HOME}/bots`,
    builtinKnowledgeDir: `${APP_RESOURCES}/knowledge`,
    sessionArtifactsDir: A,
    // 宿主照旧供给的事实变量：出厂已没有策略读它们（退役策略的夹具装上时用得到）
    shuvixConfigDirs: [
      `${SHUVIX_HOME}/policies`,
      `${SHUVIX_HOME}/agents`,
      `${SHUVIX_HOME}/hooks`,
      `${SHUVIX_HOME}/skills`
    ],
    systemDirs: [],
    sessionDirs: SESSION_DIRS,
    sessionReadDirs: SESSION_READ_DIRS
  }

  /** 从变量表里拿掉若干键（模拟宿主压根没给） */
  const withoutKeys = (
    vars: Record<string, PolicyVarValue>,
    keys: readonly string[]
  ): Record<string, PolicyVarValue> =>
    Object.fromEntries(Object.entries(vars).filter(([key]) => !keys.includes(key)))

  /** 值为 undefined 的缺失形态 —— PolicyVarValue 不收 undefined，只能强转 */
  const withUndefined = (name: string): Record<string, PolicyVarValue> =>
    ({ ...DESKTOP_VARS, [name]: undefined }) as unknown as Record<string, PolicyVarValue>

  function makeProvider(overrides: Partial<SecurityHostProvider> = {}): SecurityHostProvider {
    return {
      host: 'desktop',
      pathSep: '/',
      getVars: () => DESKTOP_VARS,
      getSessionGrants: () => ({ allowList: [] }),
      readBuiltinPolicyMd: INLINE_POLICY_MD,
      ...overrides
    }
  }

  /** 会话里「允许并记住」过这些条目的 provider（Read(...) / Write(...) 字面值） */
  const grantedProvider = (
    allowList: string[],
    overrides: Partial<SecurityHostProvider> = {}
  ): SecurityHostProvider => makeProvider({ getSessionGrants: () => ({ allowList }), ...overrides })

  /** 装上若干退役策略夹具（按用户策略）的 provider —— 借它们钉引擎机制 */
  const withRetired = (
    names: RetiredPolicyName[],
    overrides: Partial<SecurityHostProvider> = {}
  ): SecurityHostProvider =>
    makeProvider({ getUserPolicies: () => names.map((name) => retiredPolicy(name)), ...overrides })

  interface DecideOpts {
    subjectKind?: 'agent' | 'user'
    host?: 'desktop' | 'extension'
    provider?: SecurityHostProvider
    warn?: (msg: string) => void
    /** 经由的工具（省略 = 非工具路径）：只有点名 tool.name 的规则才看它 */
    tool?: { name: string; operation?: string }
  }

  /**
   * 内置策略（+ 装上的夹具）的完整装配 + 统一评估。
   *
   * vars 必须走 buildPolicyVars（生产路径 context.ts 同款）：直接用 provider.getVars() 会缺
   * grantedRead/grantedWrite —— 外部目录门的豁免被绑成 null，「允许并记住」过的路径照样问
   * （assemble.test CV-1b）。
   */
  function decide(action: string, object: SecurityObject, opts: DecideOpts = {}): SecurityDecision {
    const provider = opts.provider ?? makeProvider()
    const vars = buildPolicyVars(provider)
    return evaluate(
      assembleRules(provider, vars),
      {
        subject: { kind: opts.subjectKind ?? 'agent', sessionId: 's1', agentKind: 'root' },
        action,
        ...(opts.tool ? { tool: opts.tool } : {}),
        object,
        environment: { host: opts.host ?? 'desktop', platform: 'darwin' }
      },
      { vars, warn: opts.warn }
    )
  }

  const at = (path: string): SecurityObject => ({ type: 'path', path })

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

  /** 一组各自独立的告警出口：evaluate 的 fail-safe 与 provider.logger（缺目录变量那一行） */
  const warnSinks = (): {
    evalWarn: Mock<(msg: string) => void>
    logWarn: Mock<(msg: string) => void>
    logger: NonNullable<SecurityHostProvider['logger']>
  } => {
    const logWarn = vi.fn<(msg: string) => void>()
    return {
      evalWarn: vi.fn<(msg: string) => void>(),
      logWarn,
      logger: { info: vi.fn(), warn: logWarn, error: vi.fn() }
    }
  }

  /** 「not provided」那一行的原文（assemble 按 logger × 策略 × 变量只记一次） */
  const notProvided = (name: string): string =>
    `security policy 'ask-on-external-path': vars.${name} is not provided by the host; inDir treats it as no directory`

  /** 判决的形状：放行（default，零命中）或外部目录门的哪一条 */
  type Expect = 'allow' | '#0' | '#1'

  /** 断言一次判决是 expected 的样子；问的那两格还要给「允许并记住」（条目即真实去处） */
  const expectShape = (
    label: string,
    action: string,
    path: string,
    decision: SecurityDecision,
    expected: Expect
  ): void => {
    const got = {
      label,
      effect: decision.effect,
      tier: decision.tier,
      winning: decision.winning,
      matched: decision.matched
    }
    if (expected === 'allow') {
      expect(got).toEqual({
        label,
        effect: 'allow',
        tier: 'default',
        winning: 'default:path',
        matched: []
      })
      expect(decision.ask, label).toBeUndefined()
      expect(decision.prompt, label).toBeUndefined()
      return
    }
    const id = `ask-on-external-path${expected}`
    expect(got).toEqual({ label, effect: 'ask', tier: 'ask', winning: id, matched: [id] })
    const entry = `${action === 'write' ? 'Write' : 'Read'}(${path})`
    expect(decision.ask, label).toEqual({ command: entry, rememberEntry: entry })
  }

  // block-catastrophic-commands 已退役（2026-10-01）；它的夹具仍是命令解析 / PowerShell 扫描 /
  // commandFacts 投影经 CEL 的端到端覆盖，见 blockCatastrophicCommands.test.ts。

  // ── ask-on-external-path：会话目录以外的读写 ─────────────────────────────────────
  //
  // 文件工具在会话目录（vars.sessionDirs：工作目录、本会话临时目录、artifacts、工具结果、勾选的知识库
  // —— 与命令沙箱同一份清单）里自由读写，在只读会话目录（vars.sessionReadDirs：技能、内置知识库）里
  // 自由读；在那之外，读家目录里的文件问（#0），往任何地方写问（#1）。家目录外的读不问（系统位置、
  // /opt/homebrew、应用包）。凭据（~/.ssh、~/.aws、加密 API key 的密钥……）都在家目录里，不再单列一份
  // 清单。「允许并记住」过的路径是 match 里的豁免（不是 force-allow）：读授权只免读，写授权读写都免。

  it('BP-E1 行为表：家目录里、（只读）会话目录外的读 → #0；会话目录或只读会话目录里、或家目录外的读放行；会话目录外的写（家目录内外、只读会话目录里都算）→ #1；会话目录里的写放行 —— 问的都给「允许并记住」，零告警', () => {
    const rows: Array<[string, 'read' | 'write', string, Expect]> = [
      // 读：家目录里、会话目录外 → 问
      ['家目录里的普通文件', 'read', `${HOME}/notes.txt`, '#0'],
      ['家目录本身（列目录）', 'read', HOME, '#0'],
      ['私钥 —— 凭据在家目录里，不必单列', 'read', `${HOME}/.ssh/id_rsa`, '#0'],
      ['~/.aws', 'read', `${HOME}/.aws/credentials`, '#0'],
      ['加密 API key 用的密钥', 'read', `${SHUVIX_HOME}/.session-state`, '#0'],
      ['个人文件夹', 'read', `${HOME}/Documents/a.pdf`, '#0'],
      ['ShuviX 自己的配置', 'read', `${SHUVIX_HOME}/policies/p.md`, '#0'],
      ['CLI 令牌', 'read', `${SHUVIX_HOME}/cli-token`, '#0'],
      ['别的会话的工具结果', 'read', `${USER_DATA}/tool_results/sess-2/r.txt`, '#0'],
      ['别的会话的 artifacts', 'read', `${R}/sess-2/x.svg`, '#0'],
      ['没勾的知识库', 'read', `${SHUVIX_HOME}/knowledge/other/a.md`, '#0'],
      ['没启用的技能', 'read', `${SHUVIX_HOME}/skills/bar/SKILL.md`, '#0'],
      // 读：会话目录里 → 放行
      ['工作目录里的源码', 'read', `${WS}/src/a.ts`, 'allow'],
      ['工作目录本身', 'read', WS, 'allow'],
      ['本会话的临时目录', 'read', `${TMP}/x`, 'allow'],
      ['本会话的 artifacts', 'read', `${A}/chart.svg`, 'allow'],
      ['本会话的工具结果', 'read', `${TR}/r.txt`, 'allow'],
      ['本会话勾选的知识库', 'read', `${KB}/a.md`, 'allow'],
      // 读：只读会话目录里 → 放行
      ['启用的技能', 'read', `${SKILL}/SKILL.md`, 'allow'],
      ['启用的技能目录本身', 'read', SKILL, 'allow'],
      // 读：家目录外 → 放行
      ['系统文件', 'read', '/etc/hosts', 'allow'],
      ['/opt/homebrew', 'read', '/opt/homebrew/bin/node', 'allow'],
      ['应用包里的内置知识库', 'read', `${APP_RESOURCES}/knowledge/shuvix/en/agent-md.md`, 'allow'],
      ['别处的临时目录', 'read', '/private/tmp/other/x', 'allow'],
      // 写：会话目录外 → 问（家目录内外都一样）
      ['家目录里的普通文件', 'write', `${HOME}/notes.txt`, '#1'],
      ['~/.ssh', 'write', `${HOME}/.ssh/authorized_keys`, '#1'],
      ['shell 启动文件', 'write', `${HOME}/.zshrc`, '#1'],
      ['ShuviX 自己的配置', 'write', `${SHUVIX_HOME}/policies/p.md`, '#1'],
      ['别的会话的 artifacts', 'write', `${R}/sess-2/x.svg`, '#1'],
      ['系统目录', 'write', '/etc/hosts', '#1'],
      ['别处的临时目录', 'write', '/private/tmp/x', '#1'],
      // 写：只读会话目录里 → 照问（只读会话目录只免读）
      ['启用的技能', 'write', `${SKILL}/SKILL.md`, '#1'],
      ['内置技能', 'write', `${APP_RESOURCES}/skills/drawing/SKILL.md`, '#1'],
      ['内置知识库', 'write', `${APP_RESOURCES}/knowledge/x.md`, '#1'],
      // 写：会话目录里 → 放行
      ['工作目录里的源码', 'write', `${WS}/src/a.ts`, 'allow'],
      // 工作目录整个都是会话目录：出厂对文件工具不再单独守 git 元数据（命令那一侧的围栏是沙箱的事）
      ['工作目录里的 git hooks', 'write', `${WS}/.git/hooks/pre-commit`, 'allow'],
      ['本会话的临时目录', 'write', `${TMP}/f`, 'allow'],
      ['本会话的 artifacts', 'write', `${A}/chart.svg`, 'allow'],
      ['本会话的工具结果', 'write', `${TR}/r.txt`, 'allow'],
      ['本会话勾选的知识库', 'write', `${KB}/sub/a.md`, 'allow']
    ]
    const sinks = warnSinks()
    const opts: DecideOpts = {
      provider: makeProvider({ logger: sinks.logger }),
      warn: sinks.evalWarn
    }
    for (const [label, action, path, expected] of rows) {
      expectShape(`${action} ${label}`, action, path, decide(action, at(path), opts), expected)
    }
    expect(sinks.evalWarn).not.toHaveBeenCalled()
    expect(sinks.logWarn).not.toHaveBeenCalled()
  })

  it('BP-E2 「允许并记住」是 match 里的豁免：读授权只免读，写授权读写都免；授权按路径段比、可以是一个文件；历史的 Bash(...) 条目什么都不免', () => {
    const DOCS = `${HOME}/docs`
    const rows: Array<[string, string[], 'read' | 'write', string, Expect]> = [
      ['读授权 × 读', [`Read(${DOCS})`], 'read', `${DOCS}/a.md`, 'allow'],
      ['读授权 × 写', [`Read(${DOCS})`], 'write', `${DOCS}/a.md`, '#1'],
      ['写授权 × 读（写授权含读）', [`Write(${DOCS})`], 'read', `${DOCS}/a.md`, 'allow'],
      ['写授权 × 写', [`Write(${DOCS})`], 'write', `${DOCS}/sub/a.md`, 'allow'],
      ['家目录外的写授权 × 写', ['Write(/etc/app)'], 'write', '/etc/app/x.conf', 'allow'],
      ['家目录外的读授权 × 写', ['Read(/etc/app)'], 'write', '/etc/app/x.conf', '#1'],
      // 路径段边界：同前缀的兄弟不算
      ['同前缀兄弟 × 读', [`Write(${DOCS})`], 'read', `${HOME}/docs-old/a.md`, '#0'],
      ['同前缀兄弟 × 写', [`Write(${DOCS})`], 'write', `${HOME}/documents/a.md`, '#1'],
      // 授权一个文件：只免那一个
      [
        '文件授权 × 那个文件',
        [`Read(${HOME}/.ssh/config)`],
        'read',
        `${HOME}/.ssh/config`,
        'allow'
      ],
      [
        '文件授权 × 同目录别的文件',
        [`Read(${HOME}/.ssh/config)`],
        'read',
        `${HOME}/.ssh/id_rsa`,
        '#0'
      ],
      // 历史条目解析为 null：不授予任何东西
      ['Bash(...) 条目', [`Bash(cat ${HOME}/notes.txt)`], 'read', `${HOME}/notes.txt`, '#0']
    ]
    const sinks = warnSinks()
    for (const [label, allowList, action, path, expected] of rows) {
      const decision = decide(action, at(path), {
        provider: grantedProvider(allowList, { logger: sinks.logger }),
        warn: sinks.evalWarn
      })
      // 放行的那几格是 default、零命中：门根本没命中，不是被哪条 force-allow 压过
      expectShape(label, action, path, decision, expected)
    }
    expect(sinks.evalWarn).not.toHaveBeenCalled()
    expect(sinks.logWarn).not.toHaveBeenCalled()
  })

  it('BP-E3 （只读）会话目录与家目录都按路径段比：同前缀的兄弟、更长的 id、artifacts 根本身都不算会话目录；/Users/uu 不在 /Users/u 里', () => {
    const rows: Array<[string, 'read' | 'write', string, Expect]> = [
      ['工作目录的同前缀兄弟', 'write', `${WS}-evil/x`, '#1'],
      ['工作目录的同前缀兄弟', 'read', `${WS}-evil/x`, '#0'],
      ['artifacts 根本身', 'write', R, '#1'],
      ['artifacts 根下直接的文件', 'write', `${R}/x.svg`, '#1'],
      ['同前缀的兄弟会话', 'write', `${R}/sess-1-evil/x.svg`, '#1'],
      ['更长的会话 id', 'write', `${R}/sess-10/x.svg`, '#1'],
      ['更长的会话 id', 'read', `${R}/sess-10/x.svg`, '#0'],
      ['临时目录的同前缀兄弟', 'write', `${TMP}0/f`, '#1'],
      ['工具结果的同前缀兄弟', 'read', `${TR}.bak/r.txt`, '#0'],
      ['启用技能的同前缀兄弟', 'read', `${SKILL}-old/SKILL.md`, '#0'],
      ['勾选知识库的同前缀兄弟', 'write', `${KB}2/a.md`, '#1'],
      ['与家目录同前缀的别人家', 'read', '/Users/uu/notes.txt', 'allow'],
      ['与家目录同前缀的别人家', 'write', '/Users/uu/notes.txt', '#1']
    ]
    for (const [label, action, path, expected] of rows) {
      expectShape(`${action} ${label}`, action, path, decide(action, at(path)), expected)
    }
  })

  it.each<
    [
      name: 'sessionDirs' | 'sessionReadDirs',
      rows: Array<['read' | 'write', string, Expect]>,
      grant: string,
      grantedPath: string
    ]
  >([
    [
      'sessionDirs',
      [
        ['write', `${WS}/src/a.ts`, '#1'],
        ['write', `${TMP}/f`, '#1'],
        ['read', `${WS}/src/a.ts`, '#0'],
        ['read', `${A}/chart.svg`, '#0'],
        // 另一份清单照常：只读会话目录里的读照旧放行
        ['read', `${SKILL}/SKILL.md`, 'allow'],
        ['read', '/etc/hosts', 'allow'],
        ['read', `${TMP}/f`, 'allow']
      ],
      `Write(${WS})`,
      `${WS}/src/a.ts`
    ],
    [
      'sessionReadDirs',
      [
        ['read', `${SKILL}/SKILL.md`, '#0'],
        ['write', `${SKILL}/SKILL.md`, '#1'],
        // 另一份清单照常：会话目录里的读写照旧放行
        ['read', `${WS}/src/a.ts`, 'allow'],
        ['write', `${WS}/src/a.ts`, 'allow'],
        ['read', `${APP_RESOURCES}/skills/drawing/SKILL.md`, 'allow']
      ],
      `Read(${SKILL})`,
      `${SKILL}/SKILL.md`
    ]
  ])(
    'BP-E4 宿主没给 vars.%s（缺键 / undefined）→ 只会多问：那份清单里的读（写）都问，家目录外的读照旧放行，授权照旧免；只记一行「not provided」。空清单（宿主算不出时给的）同样多问、不记',
    (name, rows, grant, grantedPath) => {
      const variants: Array<[string, Record<string, PolicyVarValue>, string[]]> = [
        ['缺键', withoutKeys(DESKTOP_VARS, [name]), [notProvided(name)]],
        ['undefined', withUndefined(name), [notProvided(name)]],
        ['空清单', { ...DESKTOP_VARS, [name]: [] }, []]
      ]
      for (const [label, vars, expectedLines] of variants) {
        // 一个变体一个 logger，贯穿有 / 无授权两个 provider 的全部判定（去重按 logger 键控）
        const sinks = warnSinks()
        const off = makeProvider({ getVars: () => vars, logger: sinks.logger })
        const opts: DecideOpts = { provider: off, warn: sinks.evalWarn }
        // 评估两轮：「只记一次」要在重复评估下成立
        for (let round = 0; round < 2; round++) {
          for (const [action, path, expected] of rows) {
            expectShape(
              `${label} 第 ${round} 轮 ${action} ${path}`,
              action,
              path,
              decide(action, at(path), opts),
              expected
            )
          }
        }
        // 「允许并记住」照旧免 —— 缺清单没有变成一张免不掉的询问
        const granted = grantedProvider([grant], { getVars: () => vars, logger: sinks.logger })
        expectShape(
          `${label} 授权之后读`,
          'read',
          grantedPath,
          decide('read', at(grantedPath), { provider: granted, warn: sinks.evalWarn }),
          'allow'
        )
        // 不是 fail-safe 蒙出来的 ask：缺的变量被绑成 null，inDir 当「没有这个目录」
        expect(sinks.evalWarn, label).not.toHaveBeenCalled()
        expect(
          sinks.logWarn.mock.calls.map((c) => String(c[0])),
          label
        ).toEqual(expectedLines)
      }
    }
  )

  it('BP-E5 宿主没给 vars.home（缺键 / undefined）→ 读规则唯一的正向 inDir 命中不了：读一律放行（门失效，与 BP-B11 同一个代价）；写规则不受牵连照问；只记一行。空串同样放行、不记', () => {
    const variants: Array<[string, Record<string, PolicyVarValue>, string[]]> = [
      ['缺键', withoutKeys(DESKTOP_VARS, ['home']), [notProvided('home')]],
      ['undefined', withUndefined('home'), [notProvided('home')]],
      // 空串是宿主明说「没有这个目录」：inDir 对它恒不命中，无须绑定也无须告警
      ['空串', { ...DESKTOP_VARS, home: '' }, []]
    ]
    for (const [label, vars, expectedLines] of variants) {
      const sinks = warnSinks()
      const opts: DecideOpts = {
        provider: makeProvider({ getVars: () => vars, logger: sinks.logger }),
        warn: sinks.evalWarn
      }
      for (let round = 0; round < 2; round++) {
        const rows: Array<['read' | 'write', string, Expect]> = [
          ['read', `${HOME}/notes.txt`, 'allow'],
          ['read', `${HOME}/.ssh/id_rsa`, 'allow'],
          ['write', `${HOME}/notes.txt`, '#1'],
          ['write', `${WS}/src/a.ts`, 'allow']
        ]
        for (const [action, path, expected] of rows) {
          expectShape(
            `${label} 第 ${round} 轮 ${action} ${path}`,
            action,
            path,
            decide(action, at(path), opts),
            expected
          )
        }
      }
      expect(sinks.evalWarn, label).not.toHaveBeenCalled()
      expect(
        sinks.logWarn.mock.calls.map((c) => String(c[0])),
        label
      ).toEqual(expectedLines)
    }
  })

  it('BP-E6 宿主把会话目录指错了（家目录、根目录）也只抬得起 ask-on-external-path 自己：用户装回的 deny（系统目录）照拒、force-ask（ShuviX 配置、bot 文件）照问，「允许并记住」过也一样', () => {
    const variants: Array<[string, string]> = [
      ['指到家目录', HOME],
      ['指到根目录', '/']
    ]
    /** 指错的那一项（或 Write(/) 授权）罩不罩得住这条路径 —— 罩住了，外部目录门就不命中 */
    const exempted = (dir: string, path: string, allowList: string[]): boolean =>
      allowList.length > 0 || dir === '/' || path.startsWith(`${dir}/`)
    /** 外部目录门之外的门：用户装回的三份退役夹具 */
    const FENCES: RetiredPolicyName[] = [
      'protect-system',
      'protect-shuvix-config',
      'protect-bot-files'
    ]
    const rows: Array<
      [string, string, SecurityDecision['effect'], SecurityDecision['tier'], string]
    > = [
      [
        'ShuviX 的 agent 文件',
        `${SHUVIX_HOME}/agents/a.md`,
        'ask',
        'force-ask',
        'protect-shuvix-config#0'
      ],
      ['bot 文件', `${SHUVIX_HOME}/bots/scout.md`, 'ask', 'force-ask', 'protect-bot-files#0'],
      ['系统目录', '/etc/x', 'deny', 'deny', 'protect-system#0']
    ]

    for (const [label, dir] of variants) {
      const vars: Record<string, PolicyVarValue> = { ...DESKTOP_VARS, sessionDirs: [dir] }
      const sinks = warnSinks()
      for (const allowList of [[], ['Write(/)', 'Read(/)']]) {
        const provider = withRetired(FENCES, {
          getVars: () => vars,
          logger: sinks.logger,
          getSessionGrants: () => ({ allowList })
        })
        for (const [what, path, effect, tier, winning] of rows) {
          const decision = decide('write', at(path), { provider, warn: sinks.evalWarn })
          expect({
            label,
            allowList,
            what,
            effect: decision.effect,
            tier: decision.tier,
            winning: decision.winning,
            matched: decision.matched
          }).toEqual({
            label,
            allowList,
            what,
            effect,
            tier,
            winning,
            // 外部目录门被罩住时只剩那道门自己命中；没罩住（家目录外的系统目录）时它照样命中，只是没胜出
            matched: exempted(dir, path, allowList)
              ? [winning]
              : [winning, 'ask-on-external-path#1']
          })
        }
      }

      // 指错的后果就是外部目录门这一格：家目录里的读写都不再问（宿主的 sessionDirsView 从不把家目录
      // 或根目录交出来 —— 覆盖家目录的工作目录不算会话目录）
      const off = makeProvider({ getVars: () => vars, logger: sinks.logger })
      for (const action of ['read', 'write'] as const) {
        expectShape(
          `${label} ${action}`,
          action,
          `${HOME}/.ssh/id_rsa`,
          decide(action, at(`${HOME}/.ssh/id_rsa`), { provider: off, warn: sinks.evalWarn }),
          'allow'
        )
      }
      expect(sinks.evalWarn, label).not.toHaveBeenCalled()
      expect(sinks.logWarn, label).not.toHaveBeenCalled()
    }
  })

  it('BP-E7 「允许并记住」的往返：卡片上的 rememberEntry 记进会话授权后，同一个请求就放行（读 / 写、家目录内外各一格）', () => {
    const cases: Array<['read' | 'write', string]> = [
      ['read', `${HOME}/notes.txt`],
      ['read', `${HOME}/.ssh/config`],
      ['write', `${HOME}/notes.txt`],
      ['write', '/etc/hosts']
    ]
    for (const [action, path] of cases) {
      const asked = decide(action, at(path))
      expect(asked.effect, `${action} ${path}`).toBe('ask')
      const entry = asked.ask?.rememberEntry
      expect(entry, `${action} ${path}`).toBe(`${action === 'write' ? 'Write' : 'Read'}(${path})`)
      expectShape(
        `${action} ${path} 记住之后`,
        action,
        path,
        decide(action, at(path), { provider: grantedProvider([entry!]) }),
        'allow'
      )
    }
  })

  it('BP-N3 env.host 守卫：desktop 外部目录门就位（家目录里的读归 #0，系统目录 / 家目录里的写归 #1，全是 ask）；extension 同请求全部 default allow', () => {
    const cases: Array<[string, string, SecurityObject, string]> = [
      ['凭据读', 'read', at(`${HOME}/.ssh/id_rsa`), 'ask-on-external-path#0'],
      ['凭据写', 'write', at(`${HOME}/.ssh/id_rsa`), 'ask-on-external-path#1'],
      ['系统目录写', 'write', at('/etc/hosts'), 'ask-on-external-path#1'],
      ['家目录里的普通写', 'write', at(`${HOME}/doc.txt`), 'ask-on-external-path#1']
    ]
    for (const [label, action, object, winning] of cases) {
      const desktop = decide(action, object)
      expect({ label, effect: desktop.effect, winning: desktop.winning }).toEqual({
        label,
        effect: 'ask',
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

  it('BP-N4 扩展端空 vars 端到端：任意路径读写与 git 操作 allow 且零告警（外部目录门限定 desktop；出厂没有 git 策略）', () => {
    const warn = vi.fn()
    const provider = makeProvider({
      host: 'extension',
      // 扩展端没有文件系统：变量一律空值，也不给 sessionDirs —— env.host 条件先挡住，缺键无从读起
      getVars: () => ({
        workspace: '',
        toolResultsBase: '',
        skillsDirs: [],
        memoryDirs: [],
        home: '',
        botsDir: '',
        builtinKnowledgeDir: '',
        sessionArtifactsDir: '',
        systemDirs: []
      }),
      logger: { info: vi.fn(), warn, error: vi.fn() }
    })
    const opts: DecideOpts = { provider, host: 'extension', warn }

    const pathCases: Array<[string, string]> = [
      ['read', '/anywhere/f.txt'],
      ['write', '/anywhere/f.txt'],
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
    expect(git.effect).toBe('allow')
    expect(git.winning).toBe('default:gitTool')
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-N8 user 主体：家目录里的读写 / 系统目录写 / 命令 / git 破坏操作全不命中 → allow', () => {
    const cases: Array<[string, SecurityObject]> = [
      ['read', at(`${HOME}/.ssh/id_rsa`)],
      ['write', at(`${HOME}/.ssh/id_rsa`)],
      ['write', at('/etc/hosts')],
      ['write', at(`${HOME}/doc.txt`)],
      ['read', at(`${HOME}/Documents/a`)],
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

  it('BP-N11 fail-safe 方向：database 客体缺 readonly 属性 → 用户装的 ask-on-database（退役夹具）仍 ask 且告警含规则 id（保护不静默蒸发）', () => {
    const warn = vi.fn()
    // 属性缺失是 PEP 违约；strict 语义下 !object.readonly 报错 → ask 规则 fail-safe 命中
    const incomplete: SecurityObject = {
      type: 'database',
      sql: 'SELECT 1',
      credential: 'prod-mysql',
      dbType: 'mysql'
    }
    const decision = decide('execute', incomplete, {
      warn,
      provider: withRetired(['ask-on-database'])
    })

    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('ask-on-database#0')
    const failSafe = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('match evaluation failed'))
    expect(failSafe).toHaveLength(1)
    expect(failSafe[0]).toContain("'ask-on-database#0'")
    expect(failSafe[0]).toContain('treating as matched (fail-safe)')
  })

  // ── 命中提示语的组合 ──────────────────────────────────────────────────────────
  /** 某份内置策略的显示名（不硬编码文案 —— 它随界面语言变） */
  const displayNameOf = (policy: string, language?: string): string =>
    buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD }).find((p) => p.name === policy)!
      .displayName
  /** 某条内置规则的 prompt 原文（同上，取自 md 而不是抄进断言） */
  const promptOf = (policy: string, index: number, language?: string): string =>
    buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD }).find((p) => p.name === policy)!
      .rules[index].prompt!

  it('BP-P1 外部目录门的两条各带自己那一段：读家目录里的文件 → #0 的话；写会话目录外 → #1 的话；署名都是这份策略的显示名', () => {
    for (const [action, path, index] of [
      ['read', `${HOME}/.ssh/id_rsa`, 0],
      ['write', `${HOME}/notes.txt`, 1]
    ] as const) {
      const decision = decide(action, at(path))
      expect(decision.prompt, action).toEqual({
        text: promptOf('ask-on-external-path', index),
        rules: [`ask-on-external-path#${index}`],
        policies: [displayNameOf('ask-on-external-path')]
      })
    }
    // 两条话不同：读说的是「进上下文」，写说的是「看清路径与改动」
    expect(promptOf('ask-on-external-path', 0)).not.toBe(promptOf('ask-on-external-path', 1))
  })

  it('BP-P2 写系统目录（用户装的 protect-system deny + 内置 #1 ask 同时命中）→ 只带 protect-system 那段', () => {
    const protectSystem = retiredPolicy('protect-system')
    const decision = decide('write', at('/etc/hosts'), {
      provider: withRetired(['protect-system'])
    })
    expect(decision.effect).toBe('deny')
    expect(decision.matched).toEqual(['protect-system#0', 'ask-on-external-path#1'])
    // 非胜出 tier 不贡献：deny 赢了，询问门那句话就无关了
    expect(decision.prompt).toEqual({
      text: protectSystem.rules[0].prompt,
      rules: ['protect-system#0'],
      policies: [protectSystem.displayName]
    })
  })

  it('BP-P3 放行不带话：出厂「允许并记住」过的写是零命中的放行；装回退役的 ask-on-write + session-grants 夹具时，force-allow 压过询问门放行，哪怕它自己写了 prompt 也不带', () => {
    // 出厂：授权是外部目录门 match 里的豁免 —— 门根本没命中
    const builtin = decide('write', at(`${HOME}/notes.txt`), {
      provider: grantedProvider([`Write(${HOME})`])
    })
    expect(builtin).toMatchObject({ effect: 'allow', tier: 'default', matched: [] })
    expect(builtin.prompt).toBeUndefined()

    // 夹具：从前的形状 —— 询问门 + 一层 force-allow 的授权规则
    const grants = retiredPolicy('session-grants')
    expect(grants.rules[1].prompt).toBeTruthy()
    const decision = decide('write', at(`${HOME}/notes.txt`), {
      provider: withRetired(['ask-on-write', 'session-grants'], {
        getSessionGrants: () => ({ allowList: [`Write(${HOME})`] })
      })
    })
    expect(decision.effect).toBe('allow')
    expect(decision.tier).toBe('force-allow')
    expect(decision.winning).toBe('session-grants#1')
    // 夹具的询问门照样命中，只是被压过（外部目录门被授权豁免了，不在其列）
    expect(decision.matched).toEqual(['session-grants#1', 'ask-on-write#0'])
    expect(decision.prompt).toBeUndefined()
  })

  it('BP-P4 language=zh/ja：prompt 与署名换成对应语言，effect/winning/matched 一字不变', () => {
    for (const [action, path, index] of [
      ['read', `${HOME}/.ssh/id_rsa`, 0],
      ['write', '/etc/hosts', 1]
    ] as const) {
      const en = decide(action, at(path))
      for (const language of ['zh', 'ja']) {
        const provider = makeProvider({ getLanguage: () => language })
        const decision = decide(action, at(path), { provider })
        const label = `${action} × ${language}`

        expect(decision.effect, label).toBe(en.effect)
        expect(decision.winning, label).toBe(en.winning)
        expect(decision.matched, label).toEqual(en.matched)

        expect(decision.prompt!.text, label).toBe(promptOf('ask-on-external-path', index, language))
        expect(decision.prompt!.text, label).not.toBe(en.prompt!.text)
        expect(decision.prompt!.policies, label).toEqual([
          displayNameOf('ask-on-external-path', language)
        ])
      }
    }
  })

  it('BP-U1 用户自己写的路径询问门不认「允许并记住」，除非它自己引用 vars.granted*：装回 protect-credentials 夹具，Read(~/.ssh) 记住过照样问（卡片仍给 rememberEntry —— 引擎对路径 ask 一律给）', () => {
    const remembered = withRetired(['protect-credentials'], {
      getSessionGrants: () => ({ allowList: [`Read(${HOME}/.ssh)`] })
    })
    const decision = decide('read', at(`${HOME}/.ssh/id_rsa`), { provider: remembered })
    expect(decision).toMatchObject({
      effect: 'ask',
      tier: 'ask',
      winning: 'protect-credentials#0'
    })
    // 外部目录门被授权豁免了，只剩夹具这一条
    expect(decision.matched).toEqual(['protect-credentials#0'])
    expect(decision.ask?.rememberEntry).toBe(`Read(${HOME}/.ssh/id_rsa)`)

    // 对照：没装夹具时同一条授权放行
    expect(
      decide('read', at(`${HOME}/.ssh/id_rsa`), {
        provider: grantedProvider([`Read(${HOME}/.ssh)`])
      })
    ).toMatchObject({ effect: 'allow', winning: 'default:path' })
  })

  // ── 内置知识库：随应用包发布，在家目录外 ──────────────────────────────────────────
  //
  // 随应用包发布的目录刻意不设拒写策略（裁决见 builtinPolicies/index.ts 头注释）：读与别的家目录外
  // 位置一样不问，写与会话目录外的写同待遇 —— #1，「允许并记住」能免。

  it('BP-K1 内置知识库：读放行且零命中；写与会话目录外的写同待遇（#1，给记住，「允许并记住」能免）', () => {
    const builtinKnowledgeDir = DESKTOP_VARS.builtinKnowledgeDir as string
    const path = `${builtinKnowledgeDir}/shuvix-formats/agent-md.md`

    expectShape('读', 'read', path, decide('read', at(path)), 'allow')
    expectShape('写', 'write', path, decide('write', at(path)), '#1')
    expectShape(
      '写授权',
      'write',
      path,
      decide('write', at(path), { provider: grantedProvider([`Write(${builtinKnowledgeDir})`]) }),
      'allow'
    )
  })

  // ── 只守一个目录的 force-ask（借退役的 protect-bot-files 夹具）：宿主没给目录变量 / 扩展端 ───────────
  //
  // 出厂已没有这种门，但用户可以写（照抄夹具就是一份）。assemble 把 deny / ask 两档里只作 inDir 目录
  // 参数、宿主又没给（缺键或 undefined）的变量绑成 null：inDir 当「没有这个目录」。不绑的话缺键报错
  // 被 fail-safe 当成命中 —— 一条只守一个目录的 force-ask 就成了对每一次写的 force-ask，「允许并记住」
  // 也免不掉。绑了之后，正向的门没有目录可守（失效），取反的豁免没了（多问）：两个方向都是契约接受的
  // 代价，BP-B11 与 BP-E4 / BP-E5 把代价的形状钉住。告警走 provider.logger（按 logger × 策略 × 变量只记
  // 一次）；evaluate 的 warn 是 fail-safe 出口，一次都不该响。

  /** 一份 bot 文件（夹具守的那个目录里） */
  const botFile = (path = `${SHUVIX_HOME}/bots/scout.md`): SecurityObject => at(path)

  it('BP-B6 env.host 条件先于 CEL：用户装的 protect-bot-files 在扩展端不命中、零告警（连 vars.botsDir 都不读）', () => {
    // 对照：桌面端照常命中，tier 是 force-ask
    expect(
      decide('write', botFile(), { provider: withRetired(['protect-bot-files']) })
    ).toMatchObject({ effect: 'ask', tier: 'force-ask', winning: 'protect-bot-files#0' })

    // scope 里的 `env.host: [desktop]` 是 native 条件，排在 CEL 之前 —— 扩展端这条规则根本不跑，
    // 连 `vars.botsDir` 都不会去读（这里的 getVars 刻意不给它）。守卫若被放宽，缺的 botsDir
    // 会被 assemble 绑成 null、以一行 provider.logger 告警露出来，而不是 strict 报错 +
    // fail-safe —— 所以 evaluate 的 warn 与 logger 两个出口都钉成零调用
    const warn = vi.fn()
    const logWarn = vi.fn()
    const provider = withRetired(['protect-bot-files'], {
      host: 'extension',
      getVars: () => ({
        workspace: '',
        toolResultsBase: '',
        skillsDirs: [],
        memoryDirs: [],
        home: '',
        systemDirs: []
      }),
      logger: { info: vi.fn(), warn: logWarn, error: vi.fn() }
    })
    const decision = decide('write', botFile(), { provider, host: 'extension', warn })
    expect(decision.effect).toBe('allow')
    expect(decision.matched).not.toContain('protect-bot-files#0')
    expect(warn).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('BP-B11 用户装了 protect-bot-files、桌面宿主没供给 botsDir（缺键 / undefined / 空串）：门失效，而不是变成「每次写都 force-ask」', () => {
    const variants: Array<[string, Record<string, PolicyVarValue>, number]> = [
      ['缺键', withoutKeys(DESKTOP_VARS, ['botsDir']), 1],
      ['undefined', withUndefined('botsDir'), 1],
      // 空串是宿主明说「没有这个目录」（扩展端就这么供给）：inDir 恒不命中，无须绑定也无须告警
      ['空串', { ...DESKTOP_VARS, botsDir: '' }, 0]
    ]

    for (const [label, vars, expectedLines] of variants) {
      // 一个变体一个 logger，贯穿有 / 无授权两个 provider 的全部判定（去重按 logger 键控）
      const logWarn = vi.fn()
      const evalWarn = vi.fn()
      const logger = { info: vi.fn(), warn: logWarn, error: vi.fn() }
      const off = withRetired(['protect-bot-files'], { getVars: () => vars, logger })
      const granted = withRetired(['protect-bot-files'], {
        getVars: () => vars,
        logger,
        getSessionGrants: () => ({
          allowList: [`Write(${HOME}/elsewhere)`, `Write(${SHUVIX_HOME}/bots)`]
        })
      })
      const ordinaryWrite = at(`${HOME}/elsewhere/f.txt`)

      // 没有授权：会话目录外的普通写落回外部目录门，且照给「允许并记住」（force-ask 没有胜出）
      const asked = decide('write', ordinaryWrite, { provider: off, warn: evalWarn })
      expect(asked.effect, label).toBe('ask')
      expect(asked.winning, label).toBe('ask-on-external-path#1')
      expect(asked.matched, label).not.toContain('protect-bot-files#0')
      expect(asked.ask?.rememberEntry, label).toBeTruthy()

      // 「允许并记住」过：普通写放行 —— 不绑的话这里会是一张免不掉的 force-ask
      const remembered = decide('write', ordinaryWrite, { provider: granted, warn: evalWarn })
      expect(remembered.effect, label).toBe('allow')
      expect(remembered.winning, label).toBe('default:path')

      // 接受的代价：门没有目录可守，bot 文件本身的写也跟着被授权放行
      expect(decide('write', botFile(), { provider: granted, warn: evalWarn }).effect, label).toBe(
        'allow'
      )

      expect(evalWarn, label).not.toHaveBeenCalled()
      const lines = logWarn.mock.calls.map((c) => String(c[0]))
      expect(lines, label).toHaveLength(expectedLines)
      for (const line of lines) {
        expect(line, label).toContain("'protect-bot-files'")
        expect(line, label).toContain('vars.botsDir')
      }
    }
  })

  // ── ~/.shuvix：出厂不再专门守（protect-shuvix-config / protect-bot-files 已退役） ─────────────────────
  //
  // 策略 / agent / hook / bot 文件在家目录里、会话目录外：读写都是一张普通的外部目录询问（给「允许并
  // 记住」，审查答得了它）；启用的技能是只读会话目录，读免问、写照问。想让这些目录「只问人」，用户自己
  // 装回那两份（夹具即原文，force-ask 的形状由 BP-B6 / BP-B11 / BP-E6 与 context.test 的 CT-RV4 钉住）。

  it('BP-C0 ~/.shuvix 里的读写只归外部目录门（tier ask，给记住）：policies / agents / hooks / bots / 没勾的知识库 / widgets 读写都问；启用的技能只免读；本会话 artifacts 与勾选的知识库读写都放行', () => {
    const rows: Array<[string, Expect, Expect]> = [
      [`${SHUVIX_HOME}/policies/x.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/policies/ask-on-external-path.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/agents/permission-reviewer.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/hooks/auto-review.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/bots/scout.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/knowledge/other/a.md`, '#0', '#1'],
      [`${SHUVIX_HOME}/widgets/w1/index.html`, '#0', '#1'],
      // 只读会话目录：技能是 agent 自己要遵守的指令，改它照问
      [`${SKILL}/SKILL.md`, 'allow', '#1'],
      [`${A}/chart.svg`, 'allow', 'allow'],
      [`${KB}/a.md`, 'allow', 'allow']
    ]
    for (const [path, read, write] of rows) {
      expectShape(`read ${path}`, 'read', path, decide('read', at(path)), read)
      expectShape(`write ${path}`, 'write', path, decide('write', at(path)), write)
    }
  })

  // ── url：出厂没有任何策略（ask-on-new-site 已退役）─────────────────────────────────
  //
  // 客体由宿主经 urlObjectOf 构造（{type:'url', url, scheme, host, origin, browser}）。出厂对 url 一条
  // 规则都没有 —— 用户自己的 Chrome 也一样。下面再借退役的 ask-on-new-site 夹具（按用户策略装上）钉两件
  // 引擎的事：客体缺属性时 fail-safe 的方向（以及 && 另一侧已定时 CEL 吸收错误），和路径授权管不到地址。

  /** 宿主构造的 url 客体（缺省是 Chrome 里的） */
  const urlObject = (raw: string, browser: 'app' | 'chrome' = 'chrome'): SecurityObject => ({
    type: 'url',
    ...urlObjectOf(raw, browser)
  })

  it.each([
    'https://a.example/p?q=1',
    'http://a.example:8080/',
    'blob:https://a.example/0b1c',
    'view-source:https://a.example/p',
    'about:blank',
    'chrome://settings'
  ])(
    'BP-S2 出厂：Chrome 与应用内浏览器面板里的 %s 都放行（default:url），零命中、不带话、零告警',
    (raw) => {
      const warn = vi.fn()
      for (const browser of ['chrome', 'app'] as const) {
        const decision = decide('navigate', urlObject(raw, browser), { warn })
        expect({ browser, effect: decision.effect, winning: decision.winning }).toEqual({
          browser,
          effect: 'allow',
          winning: 'default:url'
        })
        expect(decision.matched, browser).toEqual([])
        expect(decision.prompt, browser).toBeUndefined()
      }
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('BP-S6 fail-safe：url 客体缺 browser（PEP 违约）、地址是网页 → 用户装的 ask-on-new-site（退役夹具）仍 ask，告警里有规则 id 与 fail-safe 字样', () => {
    const warn = vi.fn()
    const { browser: _browser, ...incomplete } = urlObject('https://a.example/') as Record<
      string,
      string
    >
    const decision = decide('navigate', incomplete as SecurityObject, {
      warn,
      provider: withRetired(['ask-on-new-site'])
    })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('ask-on-new-site#0')
    const failSafe = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('match evaluation failed'))
    expect(failSafe).toHaveLength(1)
    expect(failSafe[0]).toContain("'ask-on-new-site#0'")
    expect(failSafe[0]).toContain('treating as matched (fail-safe)')
  })

  it('BP-S6 缺 browser、地址不属于任何站点 → && 的另一侧已定为假：不命中、也不告警（CEL 吸收错误）', () => {
    const warn = vi.fn()
    const { browser: _browser, ...incomplete } = urlObject('about:blank') as Record<string, string>
    const decision = decide('navigate', incomplete as SecurityObject, {
      warn,
      provider: withRetired(['ask-on-new-site'])
    })
    expect(decision.effect).toBe('allow')
    expect(decision.winning).toBe('default:url')
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-S6 客体属性给齐：装着夹具，Chrome / 应用内、网页 / 空白页各判一次，零告警', () => {
    const warn = vi.fn()
    const provider = withRetired(['ask-on-new-site'], {
      logger: { info: vi.fn(), warn, error: vi.fn() }
    })
    const effects = (
      [
        ['https://a.example/', 'chrome'],
        ['about:blank', 'chrome'],
        ['https://a.example/', 'app']
      ] as const
    ).map(
      ([raw, browser]) => decide('navigate', urlObject(raw, browser), { provider, warn }).effect
    )
    expect(effects).toEqual(['ask', 'allow', 'allow'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('BP-S8 会话的路径授权（允许并记住）管不到地址：装着 ask-on-new-site 夹具，allowList 里有 Read / Write 条目照样 ask', () => {
    const provider = withRetired(['ask-on-new-site'], {
      getSessionGrants: () => ({ allowList: ['Read(/)', `Read(${HOME})`, `Write(${WS})`] })
    })
    const decision = decide('navigate', urlObject('https://a.example/'), { provider })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('ask-on-new-site#0')
    // 授权只在外部目录门的 match 里起作用，那份策略的 scope 收在 path 上：它的规则根本没被求值
    expect(decision.matched).toEqual(['ask-on-new-site#0'])
  })

  // ── 命令门：只看宿主上报的沙箱事实 ─────────────────────────────────────────────
  //
  // 命令门只看客体上的 `sandboxed`（宿主**实际**把这次执行圈进了 OS 沙箱）：受限命令本来就只能
  // 碰会话目录（与外部目录门同一份清单），不再多问一遍；沙箱没套上、或宿主什么都没说，就问 ——
  // 缺信息只会多问，绝不因此放行。

  /**
   * 命令客体 —— 结构属性按「宿主没注入解析器」补齐（parsed:false、空 commands / writes）：出厂策略
   * 不读它们，但一份读它们的用户策略（如退役的 block-catastrophic-commands）读缺键会 fail-safe 拒死
   * 一切（blockCatastrophicCommands.test BC-80）
   */
  const commandAt = (fields: Record<string, string | boolean>): SecurityObject => ({
    type: 'command',
    command: 'ls -la',
    channel: 'bash',
    parsed: false,
    commands: [],
    writes: [],
    ...fields
  })

  it('PO-1 ask-on-command：圈进沙箱的命令放行（default:command）；没圈住 / 客体缺 sandboxed / ssh 一律问；用户对命令的 force-allow 压得过它', () => {
    const sinks = warnSinks()
    const opts: DecideOpts = {
      provider: makeProvider({ logger: sinks.logger }),
      warn: sinks.evalWarn
    }

    const confined = decide('execute', commandAt({ sandboxed: true }), opts)
    expect(confined).toMatchObject({ effect: 'allow', winning: 'default:command', matched: [] })
    expect(confined.ask).toBeUndefined()
    expect(confined.prompt).toBeUndefined()

    const asked: Array<[string, SecurityObject]> = [
      ['sandboxed:false', commandAt({ sandboxed: false })],
      // 手工构造、没有这个属性的客体按「没圈住」处理 —— 宿主没说圈住，就是没圈住
      ['缺 sandboxed', commandAt({})],
      [
        'ssh（带 host）、sandboxed:false',
        commandAt({ channel: 'ssh', host: 'prod', sandboxed: false })
      ]
    ]
    for (const [label, object] of asked) {
      const decision = decide('execute', object, opts)
      expect({
        label,
        effect: decision.effect,
        winning: decision.winning,
        matched: decision.matched
      }).toEqual({
        label,
        effect: 'ask',
        winning: 'ask-on-command#0',
        matched: ['ask-on-command#0']
      })
      expect(decision.prompt, label).toEqual({
        text: promptOf('ask-on-command', 0),
        rules: ['ask-on-command#0'],
        policies: [displayNameOf('ask-on-command')]
      })
    }
    // 缺属性那一格是 has() 挡下的，不是求值报错后 fail-safe 蒙中的 ask
    expect(sinks.evalWarn).not.toHaveBeenCalled()
    expect(sinks.logWarn).not.toHaveBeenCalled()

    // 出厂已没有「免询问」：要放宽只能自己写一份 force-allow（「允许并记住」只管路径）
    const trusted = decide('execute', commandAt({ sandboxed: false }), {
      provider: makeProvider({
        getUserPolicies: () => [
          {
            name: 'trust-commands',
            displayName: 'trust-commands',
            description: '',
            rules: [{ effect: 'force-allow', match: "object.type == 'command'" }],
            body: ''
          }
        ]
      }),
      warn: sinks.evalWarn
    })
    expect(trusted).toMatchObject({ effect: 'allow', winning: 'trust-commands#0' })
    // 询问门照样命中，只是被 force-allow 压过 —— 不是「sandboxed 没被读到」
    expect(trusted.matched).toEqual(['trust-commands#0', 'ask-on-command#0'])
    expect(trusted.prompt).toBeUndefined()

    // PEP 违约：手工客体把 sandboxed 写成非布尔的真值 → `!object.sandboxed` 求值报错 → fail-safe
    // 当命中，照问（门面总把它归一成布尔，见 context.test PO-7；这里钉的是「绝不因此放行」）
    const malformed = warnSinks()
    const truthyString = decide('execute', commandAt({ sandboxed: 'yes' }), {
      warn: malformed.evalWarn
    })
    expect(truthyString).toMatchObject({ effect: 'ask', winning: 'ask-on-command#0' })
    const failSafe = malformed.evalWarn.mock.calls.map((c) => String(c[0]))
    expect(failSafe).toHaveLength(1)
    expect(failSafe[0]).toContain("'ask-on-command#0'")
    expect(failSafe[0]).toContain('treating as matched (fail-safe)')
  })
})

/**
 * 读取那一面与退役变量的守护：ask-on-read 删了，沙箱的读写视图变量（sandboxRead* / sandboxWrit* /
 * sandboxProtectedPatterns / sandboxActive）与工作区写入视图（workspaceWrit* / workspaceProtectedPatterns）
 * 宿主也不再提供，凭据清单 credentialDirs 随 protect-credentials 一起删了 —— 不能有哪份内置策略还引用
 * 它们（引用了就是一个指向未设变量的门），也不能有哪份的人读面还提退役策略的名字（一句指向不存在的
 * 策略的说明）。
 */
describe('内置策略 × 退役的变量与名字', () => {
  const LANGUAGES = ['en', 'zh', 'ja'] as const

  /** 每份内置策略 × 每种语言的解析结果 */
  const parsedAll = (): Array<{ name: string; language: string; policy: ParsedPolicyFile }> =>
    BUILTIN_POLICY_SPECS.flatMap(({ name }) => {
      const sources = sourcesOf(name)
      return LANGUAGES.map((language) => {
        const raw = sources[language]
        expect(raw, `${name}.${language}`).toBeTruthy()
        const policy = parsePolicyDefinitionFile(raw, name)
        expect(policy, `${name}.${language} parses`).not.toBeNull()
        return { name, language, policy: policy! }
      })
    })

  it('BP-RD2 没有哪份内置策略（任何语言）的 match / let / scope 引用宿主已不提供的变量（沙箱视图、工作区写入视图、credentialDirs、autoAllow）或 ask-on-read', () => {
    const banned =
      /sandboxRead|sandboxWrit|sandboxProtectedPatterns|sandboxActive|workspaceWrit|workspaceProtectedPatterns|credentialDirs|autoAllow|ask-on-read/
    const hits: string[] = []
    for (const { name, language, policy } of parsedAll()) {
      const texts = [
        ...policy.rules.map((r) => r.match ?? ''),
        ...Object.values(policy.lets ?? {}),
        JSON.stringify(policy.scope ?? {}),
        ...policy.rules.map((r) => JSON.stringify(r.conditions ?? {}))
      ]
      for (const text of texts) if (banned.test(text)) hits.push(`${name}.${language}: ${text}`)
    }
    expect(hits).toEqual([])
    expect(BUILTIN_POLICY_SPECS.map((s) => s.name)).not.toContain('ask-on-read')
  })

  it('BP-G1 没有哪份内置策略（任何语言）的描述、正文或规则提示语提到退役策略的名字', () => {
    const retired: Array<RetiredPolicyName | 'ask-on-read'> = [
      'ask-on-read',
      'protect-credentials',
      'ask-on-write',
      'session-grants',
      'protect-system',
      'block-catastrophic-commands',
      'protect-bot-files',
      'protect-shuvix-config',
      'git-safety',
      'ask-on-sub-session',
      'ask-on-database',
      'ask-on-new-site'
    ]
    const hits: string[] = []
    for (const { name, language, policy } of parsedAll()) {
      const texts: Array<[string, string]> = [
        ['description', policy.description],
        ['body', policy.body],
        ['displayName', policy.displayName],
        ...policy.rules.map((r, i): [string, string] => [`rule #${i} prompt`, r.prompt ?? ''])
      ]
      for (const [where, text] of texts) {
        for (const old of retired) {
          if (text.includes(old)) hits.push(`${name}.${language} ${where}: ${old}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})

/**
 * 内置策略的对象 id（`shuvix-id`，md 扩展元数据只认它）：每份 × 每门语言的 md 都写着
 * `policy:builtin:<name>`；装配取 en 那份的 id，所以本地化文件的 id 必须与 en 相同，且在任何界面语言下
 * buildBuiltinPolicies 交出的都是同一个 id。
 */
describe('内置策略的对象 id（shuvix-id）', () => {
  it('BP-ID1 每份 × 每门语言：原文解析出的 objectId = policy:builtin:<name>，与 en 相同', () => {
    for (const { name } of BUILTIN_POLICY_SPECS) {
      const expected = builtinObjectId('policy', name)
      const sources = sourcesOf(name)
      expect(Object.keys(sources).sort(), name).toEqual(['en', 'ja', 'zh'])
      const en = parsePolicyDefinitionFile(sources.en, name)
      expect(en?.objectId, `${name}.en`).toBe(expected)
      for (const [lang, raw] of Object.entries(sources)) {
        const ids = [...raw.matchAll(/^shuvix-id: (.+)$/gm)].map((m) => m[1])
        expect(ids, `${name}.${lang}`).toEqual([expected])
        expect(parsePolicyDefinitionFile(raw, name)?.objectId, `${name}.${lang}`).toBe(en?.objectId)
      }
    }
  })

  it.each(['en', 'zh', 'zh-CN', 'ja', 'fr'])(
    'BP-ID2 buildBuiltinPolicies({language: %s})：每份的 objectId 都是 policy:builtin:<name>',
    (language) => {
      const built = buildBuiltinPolicies({ language, readMd: INLINE_POLICY_MD })
      expect(built.map((p) => [p.name, p.objectId])).toEqual(
        BUILTIN_POLICY_SPECS.map(({ name }) => [name, builtinObjectId('policy', name)])
      )
    }
  )
})
