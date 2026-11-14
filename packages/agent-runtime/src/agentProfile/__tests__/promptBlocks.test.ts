/**
 * 提示词块（`agentProfile/promptBlocks.ts`）—— 取代了正文里的 `{{shuvix:*}}` 变量替换（2026-11-13）。
 * 这里接着守旧 `promptVars.test.ts` 还对得上的那几条意图：正文原样、空的块整块消失不留空行、宿主给的文本
 * 不再被二次处理、正文即完整系统提示词；逐行替换 / 未知占位符告警那些随机制一起删了。
 */
import { AGENT_PROMPT_BLOCKS } from '@shuvix/chat-protocol/agentPromptBlocks'
import { describe, it, expect } from 'vitest'
import { PROMPT_EXTENSION, promptExtensionsFor, sectionKeyOf } from '../../durable/prompt/sections'
import {
  composePersona,
  formatLanguageDisplay,
  renderDocumentBlock,
  renderEnvironment
} from '../promptBlocks'

describe('composePersona', () => {
  it('正文之后追加档案点名的块：各包在同名标签里，块之间空一行', () => {
    expect(
      composePersona(
        { systemPrompt: 'BASE', promptBlocks: ['drawing', 'environment'] },
        { drawing: 'DRAW', environment: '- Platform: darwin' }
      )
    ).toBe(
      'BASE\n\n<drawing>\nDRAW\n</drawing>\n\n<environment>\n- Platform: darwin\n</environment>'
    )
  })

  it('没有块的正文原样直出，只修剪首尾（派生 agent 现状）', () => {
    expect(composePersona({ systemPrompt: '  BODY  ' }, {})).toBe('BODY')
    expect(composePersona({ systemPrompt: '  BODY  ', promptBlocks: [] }, {})).toBe('BODY')
    // 正文内部的空行不收敛：用户写什么就是什么
    expect(composePersona({ systemPrompt: 'A\n\n\n\nB' }, {})).toBe('A\n\n\n\nB')
  })

  it('正文里残留的 {{shuvix:*}} 就是普通文字：不替换、不删除（即便宿主给了同名的块）', () => {
    const body = 'Dir: {{shuvix:workingDirectory}}\n\n{{shuvix:environment}}'
    expect(
      composePersona({ systemPrompt: body, promptBlocks: ['environment'] }, { environment: 'ENV' })
    ).toBe(`${body}\n\n<environment>\nENV\n</environment>`)
  })

  it('空的块整块消失：没有标签，也不留多余的空行', () => {
    const profile = {
      systemPrompt: 'HEAD',
      promptBlocks: ['document', 'drawing', 'environment'] as const
    }
    expect(
      composePersona(profile, { document: '', drawing: 'A-BLOCK', environment: '   \n ' })
    ).toBe('HEAD\n\n<drawing>\nA-BLOCK\n</drawing>')
    expect(composePersona(profile, { drawing: '' })).toBe('HEAD')
    expect(composePersona(profile, {})).toBe('HEAD')
    // 正文为空、只有块：不以空行开头
    expect(composePersona({ ...profile, systemPrompt: '  ' }, { drawing: 'D' })).toBe(
      '<drawing>\nD\n</drawing>'
    )
  })

  it('块的正文只修剪首尾，里面的内容原样（含 {{shuvix:*}} 与多个空行）', () => {
    expect(
      composePersona(
        { systemPrompt: 'B', promptBlocks: ['drawing'] },
        { drawing: '\n  literal {{shuvix:b}}\n\n\nC2  \n' }
      )
    ).toBe('B\n\n<drawing>\nliteral {{shuvix:b}}\n\n\nC2\n</drawing>')
  })

  it('没点名的块不出，即便宿主给了文本；`extensions` 例外 —— 宿主给了就出', () => {
    const texts = { document: 'DOC', drawing: 'DRAW', extensions: 'EXT', environment: 'ENV' }
    expect(composePersona({ systemPrompt: 'B', promptBlocks: ['environment'] }, texts)).toBe(
      'B\n\n<extensions>\nEXT\n</extensions>\n\n<environment>\nENV\n</environment>'
    )
    expect(composePersona({ systemPrompt: 'B' }, { drawing: 'DRAW' })).toBe('B')
  })

  it('块的先后固定（document → drawing → extensions → environment），与档案里写的顺序无关', () => {
    const texts = { document: 'DOC', drawing: 'DRAW', extensions: 'EXT', environment: 'ENV' }
    const expected =
      'B\n\n<document>\nDOC\n</document>\n\n<drawing>\nDRAW\n</drawing>\n\n' +
      '<extensions>\nEXT\n</extensions>\n\n<environment>\nENV\n</environment>'
    expect(
      composePersona(
        { systemPrompt: 'B', promptBlocks: ['environment', 'drawing', 'document'] },
        texts
      )
    ).toBe(expected)
    expect(
      composePersona(
        { systemPrompt: 'B', promptBlocks: ['document', 'drawing', 'environment'] },
        texts
      )
    ).toBe(expected)
  })

  it('指令文件 / 项目提示词那三项不是人设的块：点了名也不进人设（它们是独立段落）', () => {
    expect(
      composePersona(
        { systemPrompt: 'B', promptBlocks: ['agents_md', 'claude_md', 'project_prompt'] },
        { environment: 'ENV' }
      )
    ).toBe('B')
  })
})

describe('composePersona —— 补充', () => {
  it('PB-CMP-1 什么都没有可说：正文是空白、点名的块全空 → 空串（没有游离的换行）；只有 extensions → 不以空行开头', () => {
    const profile = {
      systemPrompt: ' \n ',
      promptBlocks: ['document', 'drawing', 'environment'] as const
    }
    const empty = { document: '', drawing: '  ', environment: undefined }
    expect(composePersona(profile, empty)).toBe('')
    expect(composePersona(profile, { ...empty, extensions: 'E' })).toBe(
      '<extensions>\nE\n</extensions>'
    )
  })

  it('PB-VOC-1 守卫：词表里的每个名字恰有一个去处 —— 要么是人设里的块，要么选中一个同名的段落（不会两头都有，也不会两头都没有）', () => {
    for (const name of AGENT_PROMPT_BLOCKS) {
      const persona = composePersona(
        { systemPrompt: 'B', promptBlocks: [name] },
        { document: 'x', drawing: 'x', environment: 'x' }
      )
      const selected = promptExtensionsFor({
        kind: 'root',
        profile: { name: 'p', promptBlocks: [name] },
        toolNames: []
      })
      const isPersonaBlock = persona === `B\n\n<${name}>\nx\n</${name}>`
      const isSection =
        selected.length === 2 &&
        selected[0] === PROMPT_EXTENSION.persona &&
        sectionKeyOf(selected[1]!) === name
      expect([isPersonaBlock, isSection].filter(Boolean), name).toHaveLength(1)
      // 不是人设的块 → 人设就是正文；不是段落 → 只选中人设
      if (!isPersonaBlock) expect(persona, name).toBe('B')
      if (!isSection) expect(selected, name).toEqual([PROMPT_EXTENSION.persona])
    }
  })
})

describe('renderEnvironment', () => {
  const lines = (text: string): string[] => text.split('\n')

  it('PB-ENV-1 给了的每项事实一行，次序固定（与对象里键的先后无关），别的什么都没有', () => {
    // 键故意倒着写
    expect(
      renderEnvironment('en', {
        appVersion: '1.2.3',
        language: 'English (en)',
        date: '2026-11-13',
        os: 'Darwin 25',
        shell: 'bash',
        platform: 'darwin',
        isGitRepo: 'Yes',
        tempDirectoryLine: '- Temp: `/t`',
        workingDirectory: '/w'
      })
    ).toBe(
      [
        '- Working directory: /w',
        // 临时目录那一行整行照收，不加标签
        '- Temp: `/t`',
        '- Git repository: Yes',
        '- Platform: darwin',
        '- Shell: bash',
        '- OS: Darwin 25',
        '- Current date: 2026-11-13',
        '- User language: English (en)',
        // 版本的值带 `ShuviX ` 前缀
        '- ShuviX version: ShuviX 1.2.3'
      ].join('\n')
    )
  })

  it('PB-ENV-2 没给 / 空的事实不留行也不留空行；一项都没有 → 空串，点了名的 environment 块整块不出', () => {
    expect(renderEnvironment('en', {})).toBe('')
    expect(renderEnvironment('en', { platform: 'linux', date: '2026-11-13' })).toBe(
      '- Platform: linux\n- Current date: 2026-11-13'
    )
    expect(
      renderEnvironment('en', {
        workingDirectory: '',
        isGitRepo: '',
        tempDirectoryLine: '  \n ',
        shell: undefined,
        platform: 'linux'
      })
    ).toBe('- Platform: linux')
    // 临时目录那一行修剪首尾
    expect(
      renderEnvironment('en', { tempDirectoryLine: '  - Temp: x \n', platform: 'linux' })
    ).toBe('- Temp: x\n- Platform: linux')
    // 没有事实的 environment：不出空的 <environment> 标签
    expect(
      composePersona(
        { systemPrompt: 'B', promptBlocks: ['environment'] },
        { environment: renderEnvironment('en', {}) }
      )
    ).toBe('B')
  })

  it('PB-ENV-3 标签跟界面语言走，整张表回退（zh-CN → zh，不认识的语言 / 没给 → en）；Platform / Shell / OS 三种语言同名', () => {
    const facts = {
      workingDirectory: '/w',
      isGitRepo: 'Yes',
      date: 'd',
      language: 'l',
      appVersion: '1'
    }
    const zh = [
      '- 工作目录: /w',
      '- Git 仓库: Yes',
      '- 当前日期: d',
      '- 用户语言: l',
      '- ShuviX 版本: ShuviX 1'
    ]
    const ja = [
      '- 作業ディレクトリ: /w',
      '- Git リポジトリ: Yes',
      '- 現在の日付: d',
      '- ユーザー言語: l',
      '- ShuviX バージョン: ShuviX 1'
    ]
    const en = [
      '- Working directory: /w',
      '- Git repository: Yes',
      '- Current date: d',
      '- User language: l',
      '- ShuviX version: ShuviX 1'
    ]
    expect(lines(renderEnvironment('en', facts))).toEqual(en)
    for (const lang of ['zh', 'zh-CN', 'ZH']) {
      expect(lines(renderEnvironment(lang, facts)), lang).toEqual(zh)
    }
    for (const lang of ['ja', 'ja-JP']) {
      expect(lines(renderEnvironment(lang, facts)), lang).toEqual(ja)
    }
    for (const lang of ['ko', '', undefined]) {
      expect(lines(renderEnvironment(lang, facts)), String(lang)).toEqual(en)
    }
    const fixed = ['- Platform: p', '- Shell: s', '- OS: o']
    for (const lang of ['en', 'zh', 'ja']) {
      expect(lines(renderEnvironment(lang, { platform: 'p', shell: 's', os: 'o' })), lang).toEqual(
        fixed
      )
    }
  })
})

describe('renderDocumentBlock', () => {
  it('PB-DOC-1 有路径才有这一块（只有说明不成块）；说明修剪后跟在路径后面空一行；标签跟界面语言走', () => {
    expect(renderDocumentBlock('en', {})).toBe('')
    expect(renderDocumentBlock('en', { path: '' })).toBe('')
    expect(renderDocumentBlock('en', { path: '', kindGuide: 'GUIDE' })).toBe('')
    expect(renderDocumentBlock('en', { path: 'notes/a.md' })).toBe('Open document: `notes/a.md`')
    expect(renderDocumentBlock('en', { path: 'notes/a.md', kindGuide: '  \n ' })).toBe(
      'Open document: `notes/a.md`'
    )
    expect(renderDocumentBlock('en', { path: 'notes/a.md', kindGuide: '\nGUIDE\n' })).toBe(
      'Open document: `notes/a.md`\n\nGUIDE'
    )
    expect(renderDocumentBlock('zh', { path: 'a.md' })).toBe('打开的文档: `a.md`')
    expect(renderDocumentBlock('zh-CN', { path: 'a.md' })).toBe('打开的文档: `a.md`')
    expect(renderDocumentBlock('ja', { path: 'a.md' })).toBe('開いているドキュメント: `a.md`')
    expect(renderDocumentBlock('fr', { path: 'a.md' })).toBe('Open document: `a.md`')
    expect(renderDocumentBlock(undefined, { path: 'a.md' })).toBe('Open document: `a.md`')
  })
})

describe('formatLanguageDisplay', () => {
  it('支持的语言 → 「原生名 (代码)」；地区后缀与大小写归一到基础语言', () => {
    expect(formatLanguageDisplay('zh')).toBe('中文 (zh)')
    expect(formatLanguageDisplay('en')).toBe('English (en)')
    expect(formatLanguageDisplay('ja')).toBe('日本語 (ja)')
    expect(formatLanguageDisplay('zh-CN')).toBe('中文 (zh)')
    expect(formatLanguageDisplay('EN-us')).toBe('English (en)')
  })

  it('未知语言原样返回代码；没给 → 按 en', () => {
    expect(formatLanguageDisplay('fr')).toBe('fr')
    expect(formatLanguageDisplay('pt-BR')).toBe('pt')
    expect(formatLanguageDisplay(undefined)).toBe('English (en)')
    expect(formatLanguageDisplay('')).toBe('English (en)')
  })
})
