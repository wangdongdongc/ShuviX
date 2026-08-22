/**
 * ShuviX 文件类型标记（`shuvix: <type> v<n>`）—— 全部 `shuvix: xxx` 契约共用的判别层。
 *
 * 词汇表：frontmatter 里的 `shuvix` key 声明这份 markdown 的文件类型，值为 `<type> v<n>`
 * （现有取值：agent v1 / policy v1 / chart v1 / wiki-entry v1 / wiki-topic v1，常量分别
 * 定义在各自契约模块）。此前 chart / wiki 契约各抄一份判别正则，本模块把「frontmatter
 * 提取 + 标记读取」收敛为单一实现：
 *   - 判别只做正则、不引 YAML 解析器 —— chat-protocol 是零依赖叶子包（同 chart 契约的取舍）；
 *   - frontmatter 只认（剥 BOM 与前导空白后的）文件开头（`^` 不带 m 标志）：正文中段的
 *     `---` 块不会被误认；
 *   - 标记行容忍缩进 / 引号 / `shuvix:` 后无空格 / 版本号缺省（判别版本无关，为演进留位）；
 *     同一 frontmatter 出现多个 `shuvix` 键时以首行为准 —— 一份文件恰一个类型；
 *   - 本模块的 frontmatter 提取**拒绝空 frontmatter**（`---` 紧跟 `---`）—— 与 agent/policy
 *     解析侧（agent-runtime 的 markdownFrontmatter.ts）刻意不合并：那侧空 frontmatter 合法
 *     （全字段走缺省），两侧语义各有测试钉住。
 *
 * 消费方：chartFileContract / wikiFileContract 的判别，以及统一 frontmatter 属性卡
 * （app-shell）按 type 查描述符 —— 单一真源，判别语义不再各处漂移。
 */

/** 文件类型标记的 frontmatter key —— 各契约的 *_MARKER_KEY 常量同值 */
export const SHUVIX_MARKER_KEY = 'shuvix'

/** 解析出的类型标记：`shuvix: wiki-entry v1` → { type: 'wiki-entry', version: 1 } */
export interface ShuvixMarker {
  type: string
  /** `v<n>` 缺省时为 null（判别版本无关，写入侧恒带版本） */
  version: number | null
}

/** 文件开头的 frontmatter 块（不带 m 标志：`^` 即字符串起始；拒绝空 frontmatter，见文件头） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** frontmatter 内的类型标记行（容忍缩进、引号、`shuvix:` 后无空格与版本号缺省） */
const MARKER_LINE_RE = /^[ \t]*shuvix[ \t]*:[ \t]*['"]?([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+v(\d+))?/m

/** 剥 BOM 与前导空白（JS 正则的 `\s` 含 U+FEFF）—— frontmatter 必须落在剥离后的文件开头 */
function head(text: string): string {
  return text.replace(/^\s+/, '')
}

/** 文件开头 frontmatter 块的 YAML 原文；无（或不在开头 / 空块）返回 null */
export function frontmatterOf(text: string): string | null {
  const m = FRONTMATTER_RE.exec(head(text))
  return m ? m[1] : null
}

/** 从 frontmatter YAML 原文读类型标记（首个 `shuvix:` 行为准）；无标记返回 null */
export function readShuvixMarker(yaml: string): ShuvixMarker | null {
  const m = MARKER_LINE_RE.exec(yaml)
  if (!m) return null
  return { type: m[1], version: m[2] ? Number(m[2]) : null }
}

/** 整份文本的类型标记（frontmatter 提取 + 标记读取）；非 shuvix 契约文件返回 null */
export function detectShuvixMarker(text: string): ShuvixMarker | null {
  const fm = frontmatterOf(text)
  return fm === null ? null : readShuvixMarker(fm)
}

/**
 * 解析器级校验结果（frontmatter 属性卡的状态徽章/横幅数据源；经 ChatApi 的
 * `shuvixMd.validate` 暴露，实现见 agent-runtime 的 validateShuvixMdText）。
 * status：valid = 对应解析器可解析（messages 为软告警）；invalid = 整份拒绝
 * （messages 为拒绝原因；agent 解析器暂无诊断通道，可为空）；unknown = 该类型
 * 尚无校验器（宽容读取的展示型契约，卡片不显示校验态）。
 */
export interface ShuvixMdValidation {
  status: 'valid' | 'invalid' | 'unknown'
  /** 解析器诊断原文（人读英文，不本地化 —— 与日志同源，便于对照排查） */
  messages: string[]
}
