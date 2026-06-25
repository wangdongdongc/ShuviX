/**
 * Full Compaction 提示词 — 借鉴 Claude Code 的 9 节结构化总结方案
 *
 * 核心逻辑：
 * 1. 要求模型先在 <analysis> 中分析，再在 <summary> 中输出结构化总结
 * 2. formatCompactSummary() 剥离 analysis、提取 summary
 *
 * 纯函数、零依赖 —— 桌面与扩展共用（见 runCompaction）。
 */

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool or function call.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, concepts, and patterns
   - Specific details like:
     - file names or resource references
     - important content snippets (code, text, data, etc.)
     - key definitions or configurations
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing key details, decisions, and context that would be essential for continuing the work without losing important information.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Concepts: List all important concepts, technologies, frameworks, or domain knowledge discussed.
3. Files and Key Content: Enumerate specific files, resources, or content examined, modified, or created. Pay special attention to the most recent messages and include relevant snippets where applicable and include a summary of why each item is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and relevant details where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Key Content:
   - [File or Resource 1]
      - [Summary of why this is important]
      - [Summary of the changes made, if any]
      - [Important Snippet]
   - [File or Resource 2]
      - [Important Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

/** 组装完整的压缩提示词 */
export function buildCompactionPrompt(): string {
  return NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + NO_TOOLS_TRAILER
}

/**
 * 格式化压缩摘要：
 * 1. 剥离 <analysis> 草稿区（提升质量的中间产物，最终不保留）
 * 2. 提取 <summary> 内容，替换标签为 "Summary:" 标题
 * 3. 清理多余空行
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary

  // 剥离 analysis 区块
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // 提取并格式化 summary 区块
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    const content = match[1] || ''
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${content.trim()}`)
  }

  // 清理多余空行
  formatted = formatted.replace(/\n\n+/g, '\n\n')

  return formatted.trim()
}

/** 构建压缩后展示给用户的摘要消息内容 */
export function buildSummaryContent(formattedSummary: string): string {
  return `This session is being continued from a previous conversation that has been compressed. The summary below covers the earlier portion of the conversation.

${formattedSummary}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
}
