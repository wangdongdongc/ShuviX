/**
 * 检测规则表 —— 移植自 magpie（yetone/magpie v0.1.1548，MIT，Copyright (c) 2026 yetone）的
 * internal/redact/redact.go 与 more.go：同样的模式、同样的去误报校验、同样的「只认有把握的」。
 *
 * 和原版不同的只有**怎么跑**。magpie 用 Go 的 RE2，任何正则都是线性时间；JS 的正则会回溯，同一个模式
 * 在长文本上可能退化成平方级（一串十万个字母数字里只要有一个 `@`，邮箱规则就会从每个位置往后扫一遍）。
 * 所以每条规则都声明一种跑法，保证总代价和文本长度成线性：
 *   - `anchored`：匹配不定长、但一定挨着某个标志串（`sk-`、`@`、`://`、字段名里的 `pass`）。从每个标志串
 *     往左按字符类回溯出起点（有上限），在那个起点上只试一次（粘性正则），向前最多看 `ahead` 个字符；
 *     同一个起点只试一次。
 *   - `window`：magpie 里带 `fold` 的规则 —— 只在标志词前后 back / ahead 的窗口里跑，窗口从行首或词首开始
 *     （照搬 magpie 的 matches）；相邻窗口合并。
 *   - `global`：整段文本跑，只给定长（最长几十个字符）或锚在行首、开头必须是特定词的模式。
 *
 * Node 22 的正则不支持行内修饰符 `(?i:…)`，大小写不敏感的片段用 ci() 展开成字符类。
 */
import type { SensitiveCategory } from './categories'
import {
  ALNUM,
  DIGITS,
  TOKEN_CH,
  bucketOK,
  chineseID,
  dateOK,
  homeAt,
  hostOK,
  ibanAt,
  ipv4At,
  ipv6OK,
  keyAt,
  lineHostOK,
  lineUserOK,
  luhn,
  macOK,
  notAVariable,
  notCode,
  notUserinfo,
  passportOK,
  realEmail,
  secretValue,
  serialOK,
  ssnOK,
  userOK
} from './checks'

/** 一次匹配：整段与各分组的 [起, 止)（分组没参与匹配为 undefined） */
export interface RawMatch {
  groups: Array<[number, number] | undefined>
}

type Scanner = (s: string, lower: () => string) => RawMatch[]

export interface DetectRule {
  /** 规则名（策略里的 `object.rule`） */
  id: string
  /** 匹配归的类；按分组拆成几处的规则（groups）不用它 */
  category?: SensitiveCategory
  /** 匹配左右不能紧贴的字符（嵌在更长单词里的不算） */
  bound?: string
  /** 值本身的校验 */
  ok?: (v: string) => boolean
  /** 按上下文校验 s[a:b] */
  at?: (s: string, a: number, b: number) => boolean
  /** 代替 ok 的校验，可以把值收窄 */
  fix?: (s: string, a: number, b: number) => [number, number] | null
  /** 取第一个参与匹配的分组（每个分支各有一个分组的模式） */
  anyGroup?: boolean
  /** 一次匹配拆成几处，各自成一个值（user@host 的用户与主机） */
  groups?: Array<{ category: SensitiveCategory; ok: (v: string) => boolean }>
  scan: Scanner
}

// ─────────────────────────── 构造正则的小工具 ───────────────────────────

/** ASCII 字母大小写不敏感地展开成字符类：ci('ssn') → [Ss][Ss][Nn]；其余字符原样 */
function ci(fragment: string): string {
  return fragment.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
}

/** 把 RegExpExecArray（d 标志）换成 RawMatch，位置加上 offset */
function toRaw(m: RegExpExecArray, offset: number): RawMatch {
  const indices = m.indices!
  return {
    groups: Array.from({ length: indices.length }, (_, i) => {
      const pair = indices[i]
      return pair ? ([pair[0] + offset, pair[1] + offset] as [number, number]) : undefined
    })
  }
}

/** 在 text 上跑全局正则（re 必须带 g 与 d），位置加 offset */
function execAll(re: RegExp, text: string, offset: number): RawMatch[] {
  const out: RawMatch[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(toRaw(m, offset))
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

/** sub 在 text 里出现的每个位置 */
function positionsOf(text: string, sub: string): number[] {
  const out: number[] = []
  for (let i = text.indexOf(sub); i >= 0; i = text.indexOf(sub, i + sub.length)) out.push(i)
  return out
}

function containsAny(text: string, subs: readonly string[]): boolean {
  return subs.some((sub) => text.includes(sub))
}

/** 整段跑；有标志串时先确认文本里有其一（magpie 的 markers / fold 预筛） */
function global(
  source: string,
  flags: string,
  prefilter?: { markers?: readonly string[]; fold?: readonly string[] }
): Scanner {
  const re = new RegExp(source, `gd${flags}`)
  return (s, lower) => {
    if (prefilter?.markers && !containsAny(s, prefilter.markers)) return []
    if (prefilter?.fold && !containsAny(lower(), prefilter.fold)) return []
    return execAll(re, s, 0)
  }
}

/**
 * 从每个标志串出发只试一次。起点 = 标志串位置往左、按 leftChars 回溯（最多 maxBack 个）；给了
 * firstChar 时再往右挪到第一个满足它的字符。向前最多看到标志串之后 ahead 个字符。
 * caseFold：在小写文本里找标志串（标志串写成小写）。
 */
function anchored(
  source: string,
  flags: string,
  opts: {
    markers: readonly string[]
    caseFold?: boolean
    leftChars?: string
    maxBack?: number
    firstChar?: (c: string) => boolean
    ahead: number
    /**
     * 起点前一个字符不能是这些（规则的 bound）—— 先查再跑正则：`eyJeyJeyJ…` 这种一长串里，除了第一个
     * 都在单词中间，不先排除就会每个都扫一遍整串
     */
    boundBefore?: string
    /** 跑正则之前的额外条件（start = 起点，at = 标志串位置）；不满足就跳过 */
    before?: (s: string, start: number, at: number) => boolean
  }
): Scanner {
  const re = new RegExp(source, `yd${flags}`)
  const leftChars = opts.leftChars ?? ''
  const maxBack = opts.maxBack ?? 0
  const boundBefore = opts.boundBefore ?? ''
  return (s, lower) => {
    const haystack = opts.caseFold ? lower() : s
    if (!containsAny(haystack, opts.markers)) return []
    const tried = new Set<number>()
    const out: RawMatch[] = []
    for (const marker of opts.markers) {
      for (const at of positionsOf(haystack, marker)) {
        let start = at
        while (start > 0 && at - start < maxBack && leftChars.includes(s[start - 1])) start--
        if (opts.firstChar) {
          while (start < at && !opts.firstChar(s[start])) start++
          if (!opts.firstChar(s[start])) continue
        }
        if (tried.has(start)) continue
        tried.add(start)
        if (start > 0 && boundBefore.includes(s[start - 1])) continue
        if (opts.before && !opts.before(s, start, at)) continue
        const end = Math.min(s.length, at + marker.length + opts.ahead)
        // 截在文本中间时补一个 NUL：模式里的 `$` 不能把截断处当成行尾；NUL 不落进任何值的字符类，
        // 等同于在截断处停下（被截短的值靠 bound 按原文判）
        const slice = s.slice(start, end) + (end < s.length ? '\u0000' : '')
        re.lastIndex = 0
        const m = re.exec(slice)
        if (m) out.push(toRaw(m, start))
      }
    }
    return out
  }
}

/**
 * 只在标志词前后的窗口里跑（magpie 的 matches）：窗口从行首、或往回不超过 back 的词首开始 ——
 * 模式里的 `^` 与词边界因此和整段跑时一样成立；标志词嵌在更长的单词里就跳过。相邻窗口合并。
 */
function windowed(
  source: string,
  flags: string,
  opts: { fold: readonly string[]; back: number; ahead: number }
): Scanner {
  const re = new RegExp(source, `gd${flags}`)
  const wordish = ALNUM + '_.-'
  return (s, lower) => {
    const low = lower()
    if (!containsAny(low, opts.fold)) return []
    const wins: Array<[number, number]> = []
    for (const f of opts.fold) {
      for (const at of positionsOf(low, f)) {
        let start = Math.max(0, at - opts.back)
        // 只在窗口里往回找换行：lastIndexOf 会一路找到文本开头，满篇没有换行时每个标志词都扫一遍
        let nl = at - 1
        while (nl >= start && s[nl] !== '\n') nl--
        if (nl >= start) {
          start = nl + 1
        } else if (start > 0) {
          while (start < at && wordish.includes(s[start - 1])) start++
          if (start === at && (ALNUM + '_').includes(s[at - 1])) continue // 在更长的单词里
        }
        wins.push([start, Math.min(s.length, at + f.length + opts.ahead)])
      }
    }
    wins.sort((a, b) => a[0] - b[0])
    const out: RawMatch[] = []
    for (let k = 0; k < wins.length; k++) {
      const w: [number, number] = [wins[k][0], wins[k][1]]
      while (k + 1 < wins.length && wins[k + 1][0] <= w[1]) {
        k++
        w[1] = Math.max(w[1], wins[k][1])
      }
      out.push(...execAll(re, s.slice(w[0], w[1]), w[0]))
    }
    return out
  }
}

/**
 * PEM 私钥块：`-----BEGIN … PRIVATE KEY-----` 到它之后第一个配对的 `-----END … PRIVATE KEY-----`（同 magpie 的
 * `[\s\S]+?` 懒惰匹配）。BEGIN 与 END 各自线性地找：一个 BEGIN 之后没有 END，后面的 BEGIN 也不会有；
 * 落在已认出的块里的 BEGIN 跳过 —— 一串 BEGIN 只配一个 END 时不会每个都扫到末尾。
 */
function privateKeyBlocks(): Scanner {
  const begin = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g
  const end = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g
  return (s) => {
    if (!s.includes('PRIVATE KEY')) return []
    const out: RawMatch[] = []
    begin.lastIndex = 0
    for (let b = begin.exec(s); b; b = begin.exec(s)) {
      // 中间至少隔一个字符（[\s\S]+?）
      end.lastIndex = b.index + b[0].length + 1
      const e = end.exec(s)
      if (!e) break
      const stop = e.index + e[0].length
      out.push({ groups: [[b.index, stop]] })
      begin.lastIndex = stop
    }
    return out
  }
}

// ─────────────────────────── 共用片段 ───────────────────────────

/** 字段名或值的引号（可选）："、'，或 JSON 字符串里写的 \" */
const QUOTE = String.raw`(?:\\?["'])?`
/** 秘密值的字符 */
const SECRET_CH = String.raw`[A-Za-z0-9_\-./+=~!@#%^&*]`
/** 句末的句号不算进值里 */
const VALUE_END = String.raw`[A-Za-z0-9_\-/+=~!@#%^&*]`

/** 存秘密的字段名里会有的词：DB_PASSWORD、apiKey、x-api-key、client_secret */
const SECRET_NAMES = String.raw`password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential`
/** 字段名规则的标志串（小写，在小写文本里找） */
const SECRET_NAME_MARKERS = ['pass', 'secret', 'token', 'key', 'credential']

/** 中日韩里密码的叫法 */
const CJK_PASSWORD_NAMES = [
  '密码',
  '密碼',
  '口令',
  'PIN码',
  'PIN碼',
  'PIN 码',
  '安全码',
  '安全碼',
  'パスワード',
  '暗証番号',
  '비밀번호',
  '암호',
  '비번'
]

/** 中日韩里密钥、秘密、令牌的叫法 */
const CJK_KEY_NAMES = [
  '密钥',
  '密鑰',
  '秘钥',
  '秘鑰',
  '私钥',
  '私鑰',
  '金钥',
  '金鑰',
  '令牌',
  '权杖',
  '權杖',
  '授权码',
  '授權碼',
  '秘密鍵',
  'トークン',
  'シークレット',
  'APIキー',
  'アクセスキー',
  '토큰',
  '비밀키',
  'API 키',
  'API키'
]

/** 名字后面跟着值：：、:、=、为、為、是、は、는，带不带引号都行 */
function cjkNamed(names: readonly string[]): string {
  return (
    `(?:${names.join('|')})[ \\t]*(?:[:：=][ \\t]*|[为為是][ \\t]*[:：]?[ \\t]*|は[ \\t]*|는[ \\t]*)?` +
    `(?:\\\\?["'“「])?(${SECRET_CH}{3,63}${VALUE_END})`
  )
}

/** 标签和值之间可以有的东西：Passport No.: … */
const SEP = String.raw`["']?[ \t]*(?:[:#=：][ \t]*)?`
/** 日期里写出的月份名 */
const MONTHS = `(?:${['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map(ci).join('|')})[a-z]*\\.?`
/** 路径里的用户名：文件夹名能有的字符，但不是 $USER、%USERNAME%、<name>、{user} */
const PATH_NAME = '[^\\s/\\\\:*?"\'<>|,;()\\[\\]{}`$%]{1,64}'
/** 主机名，带点或不带点 */
const HOST_RE = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*`
/** Unix 的用户名 */
const UNIX_USER = String.raw`[a-z_][a-z0-9_.-]{0,31}`
/** 单独一行上的用户名（登录信息里那样） */
const LINE_USER = String.raw`[A-Za-z0-9_][A-Za-z0-9._-]{0,31}`
/** 桶或容器名，末尾不带点或连字符（句末的句号不算进来） */
const BUCKET_RE = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?`

const BUCKET_HOSTS = [
  'amazonaws.com',
  'googleapis.com',
  'cloud.google.com',
  'aliyuncs.com',
  'myqcloud.com',
  'windows.net',
  'cloudflarestorage.com',
  'digitaloceanspaces.com',
  'myhuaweicloud.com',
  'volces.com'
]

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))
const IDENT_CH = ALNUM + '_.-'

/** 字段名最长多少（再长就不是写出来的名字了） */
const MAX_FIELD_NAME = 256

/**
 * 字段赋值规则的前置条件：标志串所在的那个名字（IDENT_CH 的一串）不太长，且后面紧跟着赋值
 * （可选引号、空白、`:` 或 `=`）。不满足就不跑正则 —— 否则一长串名字里的每个 `pass` 都要回溯一遍整串。
 */
function assignedField(s: string, start: number, at: number): boolean {
  let e = at
  while (e < s.length && e - start < MAX_FIELD_NAME && IDENT_CH.includes(s[e])) e++
  if (e < s.length && IDENT_CH.includes(s[e])) return false
  return /^(?:\\?["'])?[ \t]*[:=]/.test(s.slice(e, e + 64))
}

// ─────────────────────────── 规则 ───────────────────────────

/**
 * 规则顺序有意义：两条规则认出同一段（起点和长度都一样）时取排在前面的那条，所以 OPENAI_API_KEY=sk-…
 * 归 API_KEY 而不是 SECRET（与 magpie 一致）。
 */
export const DETECT_RULES: readonly DetectRule[] = [
  {
    id: 'private-key',
    category: 'PRIVATE_KEY',
    scan: privateKeyBlocks()
  },
  {
    id: 'sk-key',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(String.raw`sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['sk-'],
      ahead: 1024
    })
  },
  // 中转站自己的：oc_sk_…、or_sk_…
  {
    id: 'relay-key',
    category: 'API_KEY',
    bound: TOKEN_CH,
    ok: secretValue,
    scan: anchored(String.raw`[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['_sk_'],
      leftChars: 'abcdefghijklmnopqrstuvwxyz',
      maxBack: 4,
      ahead: 1024
    })
  },
  {
    id: 'git-host-token',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(
      String.raw`(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})`,
      '',
      { boundBefore: TOKEN_CH, markers: ['gh', 'github_pat_', 'glpat-'], ahead: 1024 }
    )
  },
  {
    id: 'google-api-key',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(String.raw`AIza[0-9A-Za-z_-]{35}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['AIza'],
      ahead: 64
    })
  },
  {
    id: 'slack-token',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(String.raw`xox[abposr]-[0-9A-Za-z-]{10,}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['xox'],
      ahead: 1024
    })
  },
  {
    id: 'stripe-key',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(String.raw`(?:sk|rk)_live_[0-9A-Za-z]{20,}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['sk_live_', 'rk_live_'],
      ahead: 1024
    })
  },
  {
    id: 'aws-access-key',
    category: 'API_KEY',
    bound: ALNUM,
    scan: anchored(String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`, '', {
      boundBefore: ALNUM,
      markers: ['AKIA', 'ASIA'],
      ahead: 32
    })
  },
  {
    id: 'vendor-key',
    category: 'API_KEY',
    bound: TOKEN_CH,
    scan: anchored(
      String.raw`(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})`,
      '',
      {
        boundBefore: TOKEN_CH,
        markers: ['hf_', 'gsk_', 'xai-', 'npm_', 'pypi-', 'dop_v1_', 'SG.'],
        ahead: 1024
      }
    )
  },
  {
    id: 'jwt',
    category: 'TOKEN',
    bound: TOKEN_CH,
    scan: anchored(String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, '', {
      boundBefore: TOKEN_CH,
      markers: ['eyJ'],
      ahead: 16384
    })
  },
  // user:password@host 里的密码，或者 Redis URL 那种没有用户的 :password@host
  {
    id: 'url-password',
    category: 'PASSWORD',
    ok: notAVariable,
    scan: anchored(String.raw`[A-Za-z][A-Za-z0-9+.-]*://[^\s:@/?#"'<>]*:([^\s@/?#"'<>]{3,})@`, '', {
      markers: ['://'],
      leftChars: ALNUM + '+.-',
      maxBack: 32,
      firstChar: isLetter,
      ahead: 1024
    })
  },
  // password = …、API_KEY: "…"，.env 和配置文件里那样
  {
    id: 'secret-field',
    category: 'SECRET',
    ok: secretValue,
    at: notCode,
    scan: anchored(
      `[A-Za-z0-9_.-]*(?:${SECRET_NAMES})[A-Za-z0-9_.-]*${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{8,})`,
      'i',
      {
        markers: SECRET_NAME_MARKERS,
        caseFold: true,
        leftChars: IDENT_CH,
        maxBack: 64,
        ahead: 4096,
        before: assignedField
      }
    )
  },
  // 只叫 key 的字段（providers.json 里的 "key": "oc_sk_…"）：只认长的、字母数字都有的值 —— 代码里什么都叫 key
  {
    id: 'key-field',
    category: 'SECRET',
    ok: secretValue,
    at: notCode,
    scan: anchored(`${QUOTE}key${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{16,})`, 'i', {
      markers: ['key'],
      caseFold: true,
      leftChars: '"\'\\',
      maxBack: 2,
      ahead: 4096,
      // 等价于原版开头的 (?:^|[^A-Za-z0-9_.-])
      before: (s, start) => start === 0 || !IDENT_CH.includes(s[start - 1])
    })
  },
  // 中日韩消息里写在名字后面的密码：密码：786kih、密碼是 hunter2、パスワード: …
  {
    id: 'cjk-password',
    category: 'PASSWORD',
    ok: notAVariable,
    scan: windowed(cjkNamed(CJK_PASSWORD_NAMES), 'i', {
      fold: CJK_PASSWORD_NAMES.map((n) => n.toLowerCase()),
      back: 64,
      ahead: 100
    })
  },
  // 同样写法的密钥、秘密、令牌：密钥为 …、令牌是 …、金鑰： …
  {
    id: 'cjk-key',
    category: 'SECRET',
    at: keyAt,
    scan: windowed(cjkNamed(CJK_KEY_NAMES), 'i', {
      fold: CJK_KEY_NAMES.map((n) => n.toLowerCase()),
      back: 64,
      ahead: 100
    })
  },
  // 中文消息里英文名字后接 为 / 為 / 是 / ：：apikey 为 …、token 是 …、API Key：…
  {
    id: 'copula-key',
    category: 'SECRET',
    at: keyAt,
    scan: windowed(
      `(?:${SECRET_NAMES}|pwd|api[ ]key|access[ ]key|secret[ ]key|key|\\bpin(?:[ ]?code)?)${QUOTE}` +
        `[ \\t]*(?:[为為是][ \\t]*[:：]?|：)[ \\t]*(?:\\\\?["'“「])?(${SECRET_CH}{3,}${VALUE_END})`,
      'i',
      { fold: ['为', '為', '是', '：'], back: 24, ahead: 260 }
    )
  },

  {
    id: 'email',
    category: 'EMAIL',
    bound: ALNUM + '._%+-',
    ok: realEmail,
    at: (s, a) => notUserinfo(s, a),
    scan: anchored(
      String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`,
      '',
      {
        boundBefore: ALNUM + '._%+-',
        markers: ['@'],
        leftChars: ALNUM + '._%+-',
        maxBack: 128,
        ahead: 320
      }
    )
  },
  {
    id: 'cn-id-card',
    category: 'ID_CARD',
    bound: ALNUM,
    ok: chineseID,
    scan: global(
      String.raw`[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]`,
      ''
    )
  },
  {
    id: 'cn-mobile',
    category: 'PHONE',
    bound: DIGITS,
    scan: global(String.raw`(?:\+?86[- ]?)?1[3-9]\d{9}`, '')
  },
  {
    id: 'bank-card',
    category: 'BANK_CARD',
    bound: DIGITS,
    ok: luhn,
    scan: global(String.raw`[3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?`, '')
  },

  // ── 细分的个人信息（对应 magpie more.go）──

  // 美国社保号：照写法 123-45-6789，或者 SSN 后面的九位数字；在 SSA 发放的号段里
  {
    id: 'ssn',
    category: 'SSN',
    bound: ALNUM + '-',
    ok: ssnOK,
    scan: global(String.raw`\d{3}-\d{2}-\d{4}`, '', { markers: ['-'] })
  },
  {
    id: 'ssn-labelled',
    category: 'SSN',
    bound: DIGITS,
    ok: ssnOK,
    scan: windowed(
      `(?:\\b${ci('ssn')}|\\b${ci('social')}[ \\t]+${ci('security')}(?:[ \\t]+(?:${ci('number')}|${ci('no')}\\.?|#))?)` +
        `${SEP}(?:${ci('is')}[ \\t]+)?["']?(\\d{9}|\\d{3} \\d{2} \\d{4})`,
      '',
      { fold: ['ssn', 'social'], back: 8, ahead: 80 }
    )
  },
  {
    id: 'passport',
    category: 'PASSPORT',
    anyGroup: true,
    bound: ALNUM,
    ok: passportOK,
    scan: windowed(
      `(?:\\b${ci('passport')}(?:[ \\t]*(?:${ci('no')}\\.?|${ci('number')}|${ci('num')}|#))?|\\b${ci('reisepass')}(?:${ci('nummer')})?)` +
        `${SEP}(?:(?:${ci('is')}|${ci('was')})[ \\t]+)?["']?([A-Z0-9]{6,9})` +
        `|(?:护照(?:号码|号)?|護照(?:號碼|号码|番号)?|パスポート(?:番号)?)[ \\t]*(?:[:：=][ \\t]*)?(?:是[ \\t]*|は[ \\t]*)?["']?([A-Z0-9]{6,9})`,
      '',
      { fold: ['passport', 'reisepass', '护照', '護照', 'パスポート'], back: 8, ahead: 80 }
    )
  },
  // IBAN，连写或者四个一组印出来的，按校验码认
  {
    id: 'iban',
    category: 'IBAN',
    bound: ALNUM,
    fix: ibanAt,
    scan: global(
      String.raw`[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)`,
      ''
    )
  },
  // 说明它是生日的词后面的日期；单独一个日期不算
  {
    id: 'birthday',
    category: 'BIRTHDAY',
    bound: DIGITS,
    ok: dateOK,
    scan: windowed(
      `(?:(?:\\b${ci('date')}[ \\t]+${ci('of')}[ \\t]+${ci('birth')}|\\b${ci('birth')}[ \\t_-]?${ci('date')}|\\b${ci('birthday')}|\\b${ci('dob')}\\b|\\b${ci('d')}\\.${ci('o')}\\.${ci('b')}\\.?|\\b${ci('born')}(?:[ \\t]+${ci('on')})?|\\b${ci('geburtsdatum')}|\\b${ci('geboren')}(?:[ \\t]+${ci('am')})?)|生日|出生日期|出生年月日|出生于|出生於|出生|誕生日|生年月日)` +
        `${SEP}(?:(?:${ci('is')}|${ci('was')})[ \\t]+|是[ \\t]*|为[ \\t]*|為[ \\t]*|は[ \\t]*)?["']?` +
        `(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{4}[ \\t]*年[ \\t]*\\d{1,2}[ \\t]*月[ \\t]*\\d{1,2}[ \\t]*日?|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}` +
        `|${MONTHS}[ \\t]+\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?[ \\t]+${MONTHS},?[ \\t]+\\d{4})`,
      '',
      {
        fold: [
          'birth',
          'dob',
          'd.o.b',
          'born',
          'geburt',
          'geboren',
          '生日',
          '出生',
          '誕生日',
          '生年月日'
        ],
        back: 16,
        ahead: 80
      }
    )
  },
  // MAC 地址；不是 IPv6 地址或证书指纹的一段
  {
    id: 'mac',
    category: 'MAC',
    bound: ALNUM + ':-',
    ok: macOK,
    scan: global(
      String.raw`[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}`,
      ''
    )
  },
  // S/N、Serial、序列号 和分隔符后面的序列号；不是 serial port 或 Serial.println
  {
    id: 'serial',
    category: 'SERIAL',
    anyGroup: true,
    bound: ALNUM + '-',
    ok: serialOK,
    scan: windowed(
      `(?:\\b${ci('serial')}[ \\t_-]?(?:${ci('number')}|${ci('num')}|${ci('no')}\\.?|#)?|\\b${ci('s/n')}|\\b${ci('sn')})` +
        `(?:[ \\t]*\\([^)\\n]{1,20}\\))?["']?[ \\t]*[:#=：][ \\t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})` +
        `|(?:序列号|序列號|シリアル番号|${ci('seriennummer')})[ \\t]*[:：=]?[ \\t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})`,
      '',
      { fold: ['serial', 's/n', 'sn', '序列', 'シリアル', 'seriennummer'], back: 8, ahead: 80 }
    )
  },
  // 家目录里的用户名：/Users/<name>、/home/<name>；路径的其余部分不动
  {
    id: 'home-path',
    category: 'USERNAME',
    fix: homeAt,
    scan: windowed(
      `(?:^|[^A-Za-z0-9_.~/\\\\-])(?:file://)?(?:/mnt/[a-z])?/(?:Users|home)/(${PATH_NAME})`,
      '',
      { fold: ['/users/', '/home/'], back: 16, ahead: 80 }
    )
  },
  {
    id: 'windows-home',
    category: 'USERNAME',
    anyGroup: true,
    fix: homeAt,
    scan: windowed(
      `(?:^|[^A-Za-z0-9])[A-Za-z]:(?:\\\\{1,4}|/)(?:${ci('users')}|${ci('documents and settings')})(?:\\\\{1,4}|/)` +
        `(?:([A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)+)(?:\\\\|/)|(${PATH_NAME}))`,
      '',
      { fold: ['users', 'documents and settings'], back: 12, ahead: 100 }
    )
  },
  // shell 提示符里的 user@host（user@host:~$、[user@host ~]$）；git@github.com 不是谁的
  {
    id: 'shell-prompt',
    groups: [
      { category: 'USERNAME', ok: userOK },
      { category: 'HOSTNAME', ok: hostOK }
    ],
    scan: anchored(
      `(${UNIX_USER})@(${HOST_RE})(?::[~/]|:[ \\t]*$|[ \\t]+[~/]|[ \\t]*[$%#>][ \\t]|[ \\t]*[$%#>]$)`,
      'm',
      {
        markers: ['@'],
        leftChars: 'abcdefghijklmnopqrstuvwxyz0123456789_.-',
        maxBack: 32,
        ahead: 320,
        // 等价于原版开头的 (?:^|[^A-Za-z0-9._%+-])；用户名得以小写字母或下划线开头
        before: (s, start) =>
          /[a-z_]/.test(s[start] ?? '') &&
          (start === 0 || !(ALNUM + '._%+-').includes(s[start - 1]))
      }
    )
  },
  // ssh、scp、rsync 收到的 user@host
  {
    id: 'ssh-target',
    groups: [
      { category: 'USERNAME', ok: userOK },
      { category: 'HOSTNAME', ok: hostOK }
    ],
    scan: global(
      `\\b(?:${['ssh', 'scp', 'sftp', 'rsync', 'mosh', 'ssh-copy-id'].map(ci).join('|')})\\b[^\\n@]{0,80}?[ \\t"'](${UNIX_USER})@(${HOST_RE})`,
      '',
      { markers: ['@'] }
    )
  },
  // hostname: x、HOSTNAME=x、值单独在后面的一行；或者 ssh config 里 Host 下面缩进的 HostName x
  {
    id: 'hostname-line',
    category: 'HOSTNAME',
    anyGroup: true,
    ok: lineHostOK,
    scan: global(
      `^[ \\t]*["']?(?:(?:${ci('host')}[ \\t_-]?${ci('name')}|${ci('computer')}[ \\t_-]?${ci('name')}|${ci('machine')}[ \\t_-]?${ci('name')}|${ci('device')}[ \\t_-]?${ci('name')})|主机名|主機名|計算機名|コンピュータ名|コンピューター名)["']?` +
        `[ \\t]*[:=：][ \\t]*(?:["'](${HOST_RE})["'][ \\t]*[,;]?|(${HOST_RE}))[ \\t]*$|^[ \\t]+HostName[ \\t]+(${HOST_RE})[ \\t]*$`,
      'm',
      { fold: ['name', '主机', '主機', '計算機', 'コンピュータ'] }
    )
  },
  // User: x、USER=x、值单独在后面的一行；或者 ssh config 里 Host 下面缩进的 User x
  {
    id: 'user-line',
    category: 'USERNAME',
    anyGroup: true,
    ok: lineUserOK,
    scan: global(
      `^[ \\t]*["']?(?:(?:${ci('user')}[ \\t_-]?${ci('name')}|${ci('login')}[ \\t_-]?${ci('name')}|${ci('user')}|${ci('login')}|${ci('logname')})|用户名|用戶名|ユーザー名)["']?` +
        `[ \\t]*[:=：][ \\t]*(?:["'](${LINE_USER})["'][ \\t]*[,;]?|(${LINE_USER}))[ \\t]*$|^[ \\t]+User[ \\t]+(${LINE_USER})[ \\t]*$`,
      'm',
      { fold: ['user', 'login', 'logname', '用户', '用戶', 'ユーザー'] }
    )
  },
  // 公网 IP；不是私有、回环、链路本地、CGNAT、文档用的，也不是版本号
  {
    id: 'ipv4',
    category: 'IP',
    at: ipv4At,
    scan: global(
      String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}`,
      '',
      { markers: ['.'] }
    )
  },
  {
    id: 'ipv6',
    category: 'IP',
    bound: ALNUM + ':_',
    ok: ipv6OK,
    scan: global(String.raw`[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}`, '', { markers: [':'] })
  },
  // 云存储桶：s3://<b>、gs://<b>、oss://、cos://、abfss://<c>@<account>…
  {
    id: 'bucket-url',
    groups: [
      { category: 'BUCKET', ok: bucketOK },
      { category: 'BUCKET', ok: bucketOK }
    ],
    scan: global(
      `\\b(?:${['s3a?', 's3n', 'gs', 'oss', 'cosn?', 'obs', 'r2', 'ks3', 'bos', 'tos', 'az', 'azure', 'wasbs?', 'abfss?'].map(ci).join('|')})://` +
        `(${BUCKET_RE})(?:@([a-z0-9]{3,24})\\.(?:blob|dfs)\\.core\\.windows\\.net)?`,
      '',
      { markers: ['://'] }
    )
  },
  // <b>.s3.amazonaws.com、<account>.blob.core.windows.net
  {
    id: 'bucket-host',
    category: 'BUCKET',
    ok: bucketOK,
    scan: windowed(
      String.raw`(?:^|[^A-Za-z0-9.-])([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)\.(?:s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?|s3-accelerate\.amazonaws\.com` +
        String.raw`|storage\.googleapis\.com|oss-[a-z0-9-]+\.aliyuncs\.com|cos\.[a-z0-9-]+\.myqcloud\.com|obs\.[a-z0-9-]+\.myhuaweicloud\.com|r2\.cloudflarestorage\.com` +
        String.raw`|(?:blob|dfs)\.core\.windows\.net|[a-z0-9-]+\.digitaloceanspaces\.com|tos-[a-z0-9-]+\.volces\.com)`,
      '',
      { fold: BUCKET_HOSTS, back: 128, ahead: 32 }
    )
  },
  // s3.amazonaws.com/<b>、<account>.blob.core.windows.net/<c>
  {
    id: 'bucket-path',
    category: 'BUCKET',
    ok: bucketOK,
    scan: windowed(
      String.raw`(?:^|[^A-Za-z0-9.-])(?:s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?|storage\.googleapis\.com|storage\.cloud\.google\.com` +
        String.raw`|[a-z0-9]{3,24}\.blob\.core\.windows\.net|oss-[a-z0-9-]+\.aliyuncs\.com|[a-z0-9-]+\.digitaloceanspaces\.com)/(` +
        BUCKET_RE +
        ')',
      '',
      { fold: BUCKET_HOSTS, back: 48, ahead: 80 }
    )
  }
]
