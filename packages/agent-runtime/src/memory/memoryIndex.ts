/**
 * 项目记忆索引渲染 —— `<project_memory>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 两层结构，对应两种成本：**常驻区**是 `pinned` 记忆的正文（每会话全额付，用于那些
 * 「必须照办、不能指望模型自己想起来展开」的条目）；**索引区**每条只有一行召回条件
 * （O(N) 常付，正文按需 read）。索引里刻意不写完整路径 —— 根路径在表头给一次，
 * 条目只给 slug，否则每条要多付一个绝对路径。
 *
 * 索引是**注入时现扫现渲染**的，不落地成文件：物理索引文件会与正文漂移（改了正文忘改
 * 索引是常态），现扫就没有第二份真相、没有第二次写入、没有索引维护。
 *
 * **只读（2026-09-11）**：新的知识库接手了「值得带到以后会话」这件事，这个库不再写入 ——
 * 写入段落整段删除，表头改为声明只读并指向知识库。于是**零条记忆时整段不输出**：没有可召回的
 * 东西，也没有要引导的写入，再印一句「还没有记忆」只是每会话白付的字。
 * 已有的条目继续注入：它们是真的知识，重写一遍没有收益；改正与延伸去知识库里做。
 *
 * 留下的两条措辞是实测定下来的，别当成随手写的散文（Kimi API，N=20，任务明显该召回时看
 * 模型是否 read 记忆、路径对不对）：
 *
 *   条目标识用 frontmatter 的 name（旧）   召回 65%   路径正确  0%
 *   条目标识用 `<slug>.md`                 召回 95%   路径正确 95%
 *   每条再给绝对路径                       召回 90%   —— 不值得那份开销
 *
 *   表头只说「read one at <root>/<file>」   直接命中 15/20 召回
 *   表头加「动手前先对一遍索引」            直接命中 20/20，无关任务仍 19/20 不召回
 *
 * 路径正确率 0% 不是概率问题：旧实现只把 name 交给模型，而 name 取自 frontmatter、
 * 与文件名会漂（模型写记忆时很自然填一句人话），它于是无从知道 slug。
 *
 * 文案刻意压到最短：它每个会话必付。
 * 英文：模型面文本，与内置策略的 en 基准同源；用户可见的中日文案不走这里。
 */
import type { ParsedMemoryFile } from './memoryFile'

/** 日期戳；无 updated 时不带括号 */
function stamp(m: ParsedMemoryFile): string {
  return m.updated ? ` (${m.updated})` : ''
}

/**
 * 渲染围栏正文。`memoryDir` 为该项目的记忆目录绝对路径（表头引用一次）。
 * 零条记忆返回空串 —— 调用方据此整段不注入。
 */
export function renderMemoryIndex(
  memories: readonly ParsedMemoryFile[],
  memoryDir: string
): string {
  if (memories.length === 0) return ''

  const root = memoryDir.replace(/[/\\]+$/, '')
  const pinned = memories.filter((m) => m.pinned)
  const indexed = memories.filter((m) => !m.pinned)
  const sections: string[] = []

  sections.push(
    `Things learned earlier on this project, kept in a retired store — **read-only**: never\nwrite or edit here, put a correction or anything new in the knowledge base instead. Each\nentry records what was true when written; verify any code detail against the current code\nbefore relying on it. Before you start work, check whether any entry matches what you are\nabout to touch — an entry you skipped is a mistake you are about to repeat. Read one with\n\`read\` at ${root}/<file>.`
  )

  if (pinned.length > 0) {
    // 带上文件名：常驻记忆一样可能需要更正，而更正要先知道文件叫什么
    const blocks = pinned.map((m) => `### \`${m.slug}.md\`${stamp(m)}\n${m.body}`)
    sections.push(`## Always applies\n\n${blocks.join('\n\n')}`)
  }

  if (indexed.length > 0) {
    // 条目标识用**文件名**而不是 frontmatter 的 name：name 会跟文件名漂（模型写记忆时
    // 很自然填一句人话），而模型拿到的唯一标识若不是文件名，它就拼不出路径。
    // 实测（N=20，任务明显该召回）：只给 name 时召回 65% / 路径正确 0%；
    // 给 `<slug>.md` 时 95% / 95%。每条再给绝对路径并不更好（90%），不值得那份开销。
    const lines = indexed.map(
      (m) =>
        `- \`${m.slug}.md\`${stamp(m)} — ${m.recall.trim() || m.description.trim() || '(no recall condition recorded)'}`
    )
    sections.push(`## Index\n\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}
