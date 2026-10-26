/**
 * 检测规则的校验函数 —— 移植自 magpie（yetone/magpie v0.1.1548，MIT，Copyright (c) 2026 yetone）的
 * internal/redact/redact.go / more.go。逐条保留它的取舍：每条规则只认它有把握的，去误报比多抓重要。
 *
 * 位置都是 UTF-16 下标（JS 字符串），magpie 是字节下标；用到的边界字符都是 ASCII，两者一致。
 */
import { ipInCidrs, parseIp } from '../security/cidr'

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const TOKEN_CH = ALNUM + '_-'
export const DIGITS = '0123456789'

const isAsciiLetter = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
const hasLetter = (v: string): boolean => /[A-Za-z]/.test(v)
const hasDigit = (v: string): boolean => /[0-9]/.test(v)

/** strings.Trim(v, cutset) 的等价：两端去掉 cutset 里的字符 */
export function trimChars(v: string, cutset: string): string {
  let a = 0
  let b = v.length
  while (a < b && cutset.includes(v[a])) a++
  while (b > a && cutset.includes(v[b - 1])) b--
  return v.slice(a, b)
}

/** 全由同一个字符组成（strings.Trim(v, v[:1]) == ""） */
const oneCharRepeated = (v: string): boolean => v.length > 0 && trimChars(v, v[0]) === ''

// ─────────────────────────── 密钥类 ───────────────────────────

/** 不是值本身、而是占位的写法：${PASS}、<password>、**** */
export function notAVariable(v: string): boolean {
  if (v === '' || '$%{<[*'.includes(v[0])) return false
  return trimChars(v, '*xX.') !== ''
}

/** key / token 的值，而不是一个词或一个数：字母和数字都有，或者 16 个字符以上且不全是数字 */
function keyValue(v: string): boolean {
  if (!notAVariable(v)) return false
  return hasLetter(v) && (hasDigit(v) || v.length >= 16)
}

/** 名字和值之间可以出现的分隔 */
const KEY_SEPARATORS = ['为', '為', '是', '：', ':', '=', 'は', '는']

/** 数字后面跟着这些，说明它在计数（位数、字节、时长、次数），不是 key */
const QUANTITY_UNITS = [
  '位',
  '比特',
  '字节',
  '字節',
  '个',
  '個',
  '次',
  '秒',
  '毫秒',
  '分钟',
  '分鐘',
  '小时',
  '小時',
  '天',
  '年',
  'bit',
  'byte',
  'ms',
  'sec',
  'min',
  'ビット',
  'バイト',
  '비트',
  '바이트'
]

/**
 * s[a:b] 是 key：keyValue，或者紧跟在 为 / 是 / ：/ = 后面、六位以上、不在计数的纯数字
 * （密钥为12231241 算；密钥为 2048 位、令牌 300000 毫秒不算）。
 */
export function keyAt(s: string, a: number, b: number): boolean {
  const v = s.slice(a, b)
  if (keyValue(v)) return true
  if (v.length < 6 || trimChars(v, DIGITS) !== '') return false
  const before = s.slice(0, a).replace(/[ \t"'“「\\]+$/, '')
  const after = s.slice(b).replace(/^[ \t]+/, '')
  return (
    KEY_SEPARATORS.some((c) => before.endsWith(c)) &&
    !QUANTITY_UNITS.some((u) => after.startsWith(u))
  )
}

/** 像密钥而不像代码的值：字母和数字都有，不是调用、引用或它自己的占位写法 */
export function secretValue(v: string): boolean {
  if (!notAVariable(v) || v.startsWith('process.env') || v.startsWith('os.')) return false
  return hasDigit(v) && hasLetter(v)
}

const IDENT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/

/**
 * 排除代码里只是「提到」秘密的写法：一次调用（privateKey: toBase64Url(…)），或者冒号后面没有引号、
 * 后面还跟着代码的类型名 / 读取（secretKey: Uint8Array;、private_key: details.2,）。
 * 写在代码里的秘密是字符串、带引号；等号后面或者行尾的（.env、日志、YAML）照样算。
 */
export function notCode(s: string, a: number, b: number): boolean {
  if (!IDENT_PATH.test(s.slice(a, b))) return true
  const rest = s.slice(b).replace(/^[ \t]+/, '')
  if (rest.startsWith('(')) return false
  if (
    (a > 0 && (s[a - 1] === '"' || s[a - 1] === "'")) ||
    !s
      .slice(0, a)
      .replace(/[ \t]+$/, '')
      .endsWith(':')
  ) {
    return true
  }
  return rest === '' || !';,)}]|?&<>'.includes(rest[0])
}

// ─────────────────────────── 邮箱 ───────────────────────────

/**
 * s[a] 落在 URL 的 authority 里（scheme:// 之后、主机之前）：从这里往回到 // 之间没有 / ? # 空白 引号 < > @。
 * 那里的 @ 是 userinfo 的结尾，前面是用户名或密码，后面是主机 —— 不是邮箱。
 */
function inUserinfo(s: string, a: number): boolean {
  let i = a
  while (i > 0 && !' \t\r\n/?#"\'<>@`'.includes(s[i - 1])) i--
  if (i < 3 || s[i - 1] !== '/' || s[i - 2] !== '/' || s[i - 3] !== ':') return false
  const j = i - 3 // scheme 的冒号
  let k = j
  while (k > 0 && (/[A-Za-z0-9]/.test(s[k - 1]) || '+.-'.includes(s[k - 1]))) k--
  while (k < j && !isAsciiLetter(s[k])) k++ // scheme 以字母开头
  return k < j
}

export function notUserinfo(s: string, a: number): boolean {
  return !inUserinfo(s, a)
}

/** 不是任何顶级域名的文件扩展名：logo@2x.png、intro@2x.mp4 是文件名 */
const FILE_EXT = new Set(
  (
    'jpg jpeg png gif webp svg heic heif avif bmp tif tiff ico icns pdf svgz apng jxl psd eps lottie ' +
    'mp4 m4v webm mkv avi mp3 m4a wav ogg flac aac ttf otf woff woff2 eot json yaml yml toml xml txt ' +
    'csv tsv log html htm css scss less js mjs cjs jsx ts tsx doc docx xls xlsx ppt pptx gz tgz tar ' +
    'rar 7z dmg'
  ).split(' ')
)

/** 同时也是顶级域名的扩展名：前面有倍率才算文件名（icon@2x.zip），ops@files.zip 是邮箱 */
const SCALE_EXT = new Set(['zip', 'mov', 'md', 'map'])
const SCALE_RE = /^[0-9]+(?:\.[0-9]+)?x$/

function fileHost(host: string): boolean {
  const dot = host.lastIndexOf('.')
  const ext = host.slice(dot + 1)
  return FILE_EXT.has(ext) || (dot > 0 && SCALE_EXT.has(ext) && SCALE_RE.test(host.slice(0, dot)))
}

const FAKE_HOSTS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  '.test',
  '.invalid',
  '.example'
]

export function realEmail(v: string): boolean {
  const host = v.slice(v.lastIndexOf('@') + 1).toLowerCase()
  if (fileHost(host)) return false
  for (const fake of FAKE_HOSTS) {
    if (host === fake.replace(/^\./, '') || host.endsWith(fake)) return false
  }
  return !host.startsWith('noreply') && !v.includes('noreply@')
}

// ─────────────────────────── 个人信息：号码 ───────────────────────────

export function chineseID(v: string): boolean {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (v.charCodeAt(i) - 48) * w[i]
  return v.slice(17).toUpperCase() === '10X98765432'[sum % 11]
}

export function luhn(v: string): boolean {
  const ds: number[] = []
  for (const c of v) if (c >= '0' && c <= '9') ds.push(c.charCodeAt(0) - 48)
  if (ds.length < 15 || ds.length > 19) return false
  let sum = 0
  for (let i = 0; i < ds.length; i++) {
    let d = ds[ds.length - 1 - i]
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function ssnOK(v: string): boolean {
  const d = v.replace(/[- ]/g, '')
  if (
    d.length !== 9 ||
    d.slice(0, 3) === '000' ||
    d.slice(0, 3) === '666' ||
    d[0] === '9' ||
    d.slice(3, 5) === '00' ||
    d.slice(5) === '0000'
  ) {
    return false
  }
  // 广告和示例里印的那几个，以及同一个数字九遍
  if (d === '123456789' || d === '078051120' || d === '219099999') return false
  return !oneCharRepeated(d)
}

export function passportOK(v: string): boolean {
  let n = 0
  for (const c of v) if (c >= '0' && c <= '9') n++
  return n >= 5 && !oneCharRepeated(v)
}

const IBAN_LEN: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30
}

/** 去掉空格后符合该国长度，且首四位挪到末尾后 mod 97 为 1 */
function ibanOK(raw: string): boolean {
  const v = raw.replace(/ /g, '')
  const n = IBAN_LEN[v.slice(0, 2)]
  if (n === undefined || n !== v.length) return false
  const r = v.slice(4) + v.slice(0, 4)
  let m = 0
  for (const c of r) {
    if (c >= '0' && c <= '9') m = (m * 10 + (c.charCodeAt(0) - 48)) % 97
    else if (c >= 'A' && c <= 'Z') m = (m * 100 + (c.charCodeAt(0) - 65) + 10) % 97
    else return false
  }
  return m === 1
}

/** s[a:b] 处的 IBAN，或者去掉被正则一并吃进来的、后面那个全大写单词后的 IBAN（BE68 5390 0754 7034 THEN） */
export function ibanAt(s: string, a: number, b: number): [number, number] | null {
  for (;;) {
    if (ibanOK(s.slice(a, b))) return [a, b]
    const i = s.slice(a, b).lastIndexOf(' ')
    if (i < 0) return null
    b = a + i
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** 能是某人生日的日期：真实的月和日，1900 年以后 */
export function dateOK(v: string): boolean {
  const ns = v.match(/\d+/g) ?? []
  const valid = (y: number, m: number, d: number): boolean =>
    y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31
  if (ns.length === 2) {
    // March 5, 1990 或 5 March 1990
    const l = v.toLowerCase()
    for (const [i, m] of MONTHS.entries()) {
      if (l.includes(m)) {
        let d = Number(ns[0])
        let y = Number(ns[1])
        if (ns[0].length === 4) [d, y] = [y, d]
        return valid(y, i + 1, d)
      }
    }
    return false
  }
  if (ns.length !== 3) return false
  if (ns[0].length === 4) return valid(Number(ns[0]), Number(ns[1]), Number(ns[2]))
  const [p, q, y] = ns.map(Number)
  return valid(y, p, q) || valid(y, q, p)
}

const PLACEHOLDER_MACS = new Set([
  '00:00:00:00:00:00',
  'ff:ff:ff:ff:ff:ff',
  '00:11:22:33:44:55',
  'aa:bb:cc:dd:ee:ff',
  '01:23:45:67:89:ab',
  '12:34:56:78:9a:bc',
  'xx:xx:xx:xx:xx:xx'
])

/** 排除文档和代码里代指地址的写法、广播地址，以及十二个十进制数字（日期或成对的计数更像它） */
export function macOK(v: string): boolean {
  const l = v.replace(/-/g, ':').toLowerCase()
  if (PLACEHOLDER_MACS.has(l)) return false
  return /[a-f]/.test(l)
}

export function serialOK(v: string): boolean {
  return v.length >= 6 && hasDigit(v) && !oneCharRepeated(v)
}

// ─────────────────────────── 用户名、主机、IP、存储桶 ───────────────────────────

/** 文档和容器里代指用户名的写法，以及 /Users 下不属于任何人的目录 */
const NOT_NAMES = new Set([
  'shared',
  'public',
  'guest',
  'default',
  'default user',
  'all users',
  'user',
  'username',
  'user_name',
  'yourname',
  'your-name',
  'your_name',
  'yourusername',
  'you',
  'me',
  'name',
  'example',
  'foo',
  'bar',
  'someone',
  'john',
  'jdoe',
  'runner',
  'node',
  'vscode',
  'codespace',
  'linuxbrew',
  '...'
])

/** 家目录里的用户名，去掉句末的句号 */
export function homeAt(s: string, a: number, b: number): [number, number] | null {
  while (b > a && s[b - 1] === '.') b--
  if (b === a || s[a] === '.' || NOT_NAMES.has(s.slice(a, b).toLowerCase())) return null
  return [a, b]
}

/** 服务和云镜像的用户（说明不了用户是谁），以及聊天里「User:」行会写的词 */
const NOT_USERS = new Set(
  (
    'git root ec2-user ubuntu admin postgres www-data nobody centos debian fedora azureuser opc core ' +
    'vagrant docker str string int bool any none null nil true false undefined hi hello hey yes no ok ' +
    'okay thanks continue go stop help test y n'
  ).split(' ')
)

export function userOK(v: string): boolean {
  const l = v.toLowerCase()
  return v.length >= 2 && !NOT_USERS.has(l) && !NOT_NAMES.has(l)
}

/** 代码里取值的对象：user = request.user、hostname = socket.gethostname */
const CODE_OBJECTS = new Set(
  (
    'self this os process request req ctx context config cfg conf settings env args opts options ' +
    'props params session socket platform window location url u r c s m p x data info user'
  ).split(' ')
)

/** 每个人的 ssh 和 git 都会去的主机，以及不是主机名的 hostname 取值 */
const PUBLIC_HOSTS = new Set(
  (
    'github.com gitlab.com bitbucket.org ssh.dev.azure.com vs-ssh.visualstudio.com localhost host ' +
    'hostname server remote example your-server str string none null true false undefined'
  ).split(' ')
)

/** 「User:」「hostname:」行上带点的值是从代码对象里读出来的，不是写出来的：request.user、os.hostname */
function inCode(v: string): boolean {
  const lower = v.toLowerCase()
  const dot = lower.indexOf('.')
  if (dot < 0) return false
  const first = lower.slice(0, dot)
  const last = lower.slice(lower.lastIndexOf('.') + 1)
  return (
    CODE_OBJECTS.has(first) ||
    NOT_USERS.has(last) ||
    NOT_NAMES.has(last) ||
    PUBLIC_HOSTS.has(last) ||
    last === 'login' ||
    last === 'username'
  )
}

/** 聊天记录里「User:」行单独写的词 */
const CHAT_WORDS = new Set(
  (
    'done why what how sure please retry next again great good nice cool fix go-ahead proceed lgtm ' +
    'required optional unknown anonymous guest current me'
  ).split(' ')
)

const EXAMPLE_HOSTS = [
  'example.com',
  'example.org',
  'example.net',
  '.example',
  '.test',
  '.invalid',
  '.localhost'
]

export function hostOK(v: string): boolean {
  const l = v.replace(/\.+$/, '').toLowerCase()
  if (
    l.length < 2 ||
    PUBLIC_HOSTS.has(l) ||
    l.startsWith('process.') ||
    l.startsWith('os.') ||
    l.startsWith('env.')
  ) {
    return false
  }
  if (parseIp(l)) return false // 地址归 IP 类
  for (const ex of EXAMPLE_HOSTS) {
    if (l === ex.replace(/^\./, '') || l.endsWith(ex)) return false
  }
  return true
}

export const lineUserOK = (v: string): boolean =>
  userOK(v) && !inCode(v) && !CHAT_WORDS.has(v.toLowerCase())
export const lineHostOK = (v: string): boolean => hostOK(v) && !inCode(v)

/**
 * 不属于任何具体的人的地址段：私有、共享（CGNAT）、回环、链路本地、组播、未指定、文档、基准测试、保留，
 * 外加 IPv6 只认全局单播（2000::/3）。
 */
const NOT_PUBLIC = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
  '64:ff9b::/96',
  '100::/64'
]

/** 人人都用的公共 DNS，说明不了用户是谁 */
const RESOLVERS = new Set([
  '8.8.8.8',
  '8.8.4.4',
  '1.1.1.1',
  '1.0.0.1',
  '9.9.9.9',
  '149.112.112.112',
  '208.67.222.222',
  '208.67.220.220',
  '114.114.114.114',
  '223.5.5.5',
  '223.6.6.6',
  '119.29.29.29',
  '180.76.76.76',
  '2001:4860:4860::8888',
  '2001:4860:4860::8844',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001'
])

function publicIP(text: string): boolean {
  const ip = parseIp(text)
  if (!ip) return false
  if (RESOLVERS.has(text.toLowerCase())) return false
  if (ip.family === 6 && !ipInCidrs(text, '2000::/3')) return false
  return !ipInCidrs(text, NOT_PUBLIC)
}

/**
 * s[a:b] 的点分四段是公网地址，不是更长地址的一段、也不是版本号：1.2.3.4.5、v1.2.3.4、==1.2.3.4、
 * Chrome/120.0.6099.109、version 2.31.0.1。
 */
export function ipv4At(s: string, a: number, b: number): boolean {
  if (a > 0) {
    const c = s[a - 1]
    if ((ALNUM + '._-=~^').includes(c)) return false
    // 产品的版本，不是 URL 的主机
    if (c === '/' && a >= 2 && (ALNUM + '._-').includes(s[a - 2])) return false
  }
  if (b < s.length) {
    const c = s[b]
    if ((ALNUM + '_-').includes(c)) return false
    if (c === '.' && b + 1 < s.length && s[b + 1] >= '0' && s[b + 1] <= '9') return false
  }
  const before = s
    .slice(Math.max(0, a - 16), a)
    .replace(/[ \t:="']+$/, '')
    .toLowerCase()
  for (const w of ['version', 'ver', 'release', 'build', 'rev', '版本']) {
    // 这个词本身，而不是别的词的结尾：server、observer
    if (
      before.endsWith(w) &&
      (before.length === w.length || !(ALNUM + '_').includes(before[before.length - w.length - 1]))
    ) {
      return false
    }
  }
  return publicIP(s.slice(a, b))
}

export function ipv6OK(v: string): boolean {
  if ((v.match(/:/g) ?? []).length < 2) return false
  const ip = parseIp(v)
  return ip?.family === 6 && publicIP(v)
}

/** 文档和示例里起的桶名 */
const NOT_BUCKETS = new Set(
  (
    'bucket my-bucket mybucket bucket-name bucketname my-bucket-name your-bucket your-bucket-name ' +
    'yourbucket example-bucket examplebucket amzn-s3-demo-bucket doc-example-bucket s3 www storage ' +
    'container mycontainer my-container mystorageaccount account upload download batch b v1 v2 api'
  ).split(' ')
)

export function bucketOK(v: string): boolean {
  const l = v.toLowerCase()
  return l.length >= 3 && !NOT_BUCKETS.has(l) && trimChars(l, DIGITS) !== ''
}
