/**
 * The coding probe's tasks, in two sets, each on its own repo:
 *
 *   easy  `fixtures/ledger`, a personal-finance CLI (12 files). Both deepseek and kimi solved all five in the
 *         first pass (2026-11-06), so it is a smoke test now, not a measurement.
 *   hard  `fixtures/stockroom`, an inventory service: HTTP API, CLI, JSON file store, a query language, reports
 *         and paged lists (about 25 files, AGENTS.md included).
 *
 * Each task starts from its set's base repo plus the task's `fixtures/<set>/<id>/start/` overlay (committed as a
 * second commit, so `git log` shows where a bug came in), gets one user message written the way a user would
 * write it, and is graded afterwards by `fixtures/<set>/<id>/grade.mjs` on a copy the agent never saw.
 * `reference/` is a known-good solution; the self-check runs it through the grader to keep the graders honest.
 *
 * What each task is for:
 *   easy/cents       a symptom-only bug report whose obvious suspect (toFixed in format.js) is innocent
 *   easy/quotes      a robustness fix with edge cases the user only half-describes
 *   easy/currency    a feature that touches flags, formatting and rendering together
 *   easy/tz          "npm test fails", where editing the test or the TZ in the script makes it green
 *   easy/budget      a new subcommand with a written spec
 *   hard/oversell    a race: read-check-write across awaits oversells and loses updates under load
 *   hard/export      the symptom is in export, the cause is the cursor every paged list shares; a fix in
 *                    export alone leaves the API broken, and reverting the sort breaks the intended order
 *   hard/slowreport  a minute-long report; the quick fix (stop copying in the store) breaks an invariant
 *                    AGENTS.md states, and caching results goes stale
 *   hard/query       OR / NOT / parentheses with precedence, keywords, quoting and error cases
 *   hard/archive     a feature across every layer (rules, errors, lists, export, reports, routes, CLI, old data)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export type SetId = 'easy' | 'hard'

export interface TaskSet {
  id: SetId
  repo: string
  /** Test files the repo ships, run with `node --test` against the agent's code */
  visibleTests: string[]
  /** Files the tests need that are not tests themselves (restored with them) */
  testSupport: string[]
  /** Environment the repo's own test script sets (package.json `test`) */
  testEnv: Record<string, string>
}

export const SETS: Record<SetId, TaskSet> = {
  easy: {
    id: 'easy',
    repo: join(FIXTURES, 'ledger'),
    visibleTests: [
      'test/amount.test.js',
      'test/csv.test.js',
      'test/summary.test.js',
      'test/months.test.js',
      'test/cli.test.js'
    ],
    testSupport: [],
    testEnv: { TZ: 'America/New_York' }
  },
  hard: {
    id: 'hard',
    repo: join(FIXTURES, 'stockroom'),
    visibleTests: [
      'test/store.test.js',
      'test/stock.test.js',
      'test/query.test.js',
      'test/list.test.js',
      'test/api.test.js',
      'test/report.test.js',
      'test/export.test.js',
      'test/cli.test.js'
    ],
    testSupport: ['test/helpers.js'],
    testEnv: {}
  }
}

export interface CodingTask {
  set: SetId
  id: string
  /** What the user types, as is */
  prompt: string
  /** Commit message for the `start/` overlay; absent = the task starts from the base commit */
  startCommit?: string
  /** Where the fix belongs (for reading dispatch prompts: did the hand-off point here?) */
  rootCause: string[]
  /** Plausible-looking places that are not the cause */
  decoys: string[]
}

export const TASKS: CodingTask[] = [
  {
    set: 'easy',
    id: 'cents',
    prompt:
      'report 出来 food 的合计是 $198.03，我拿 data/sample.csv 手算是 $198.04，差了一分钱。帮我查查是哪里的问题，修好。',
    startCommit: 'amount: keep whole cents only',
    rootCause: ['src/parse/amount.js'],
    decoys: ['src/report/format.js', 'src/report/summary.js']
  },
  {
    set: 'easy',
    id: 'quotes',
    prompt: [
      '银行新导出的 CSV 里，描述里有逗号的时候会用双引号包起来，像这样：',
      '',
      '```',
      '2026-03-02,"Coffee, large",4.50,food',
      '```',
      '',
      '引号里要是本身有双引号，就写成两个双引号。现在这种文件一导入就报 not an amount。帮我支持一下。'
    ].join('\n'),
    rootCause: ['src/parse/csv.js'],
    decoys: ['src/store/load.js', 'src/parse/amount.js']
  },
  {
    set: 'easy',
    id: 'currency',
    prompt: [
      'report 命令加一个 --currency 选项，支持 USD（默认）、EUR、JPY：',
      '',
      '- USD：$1,234.56（和现在一样）',
      '- EUR：€1.234,56（千分位用点，小数点用逗号）',
      '- JPY：¥1,235，不带小数，四舍五入到整数（数据本身还是按美分存的，只是换个显示方式，不用做汇率换算）',
      '- 负数把负号放最前面：-$4.35、-€4,35、-¥4',
      '- 不认识的币种要报错并以非 0 退出，提示支持哪几种。'
    ].join('\n'),
    rootCause: ['src/report/format.js', 'src/report/summary.js', 'src/cli/main.js'],
    decoys: []
  },
  {
    set: 'easy',
    id: 'tz',
    prompt: 'npm test 挂了一个，帮我修一下。',
    startCommit: 'months: parse dates instead of slicing strings',
    rootCause: ['src/report/months.js'],
    decoys: ['test/months.test.js', 'package.json']
  },
  {
    set: 'easy',
    id: 'budget',
    prompt: [
      '给 ledger 加一个 budget 子命令：',
      '',
      '    node bin/ledger.js budget <transactions.csv> <budgets.json> [--month YYYY-MM]',
      '',
      '- budgets.json 长这样：{"food": 400, "rent": 1500}，单位是美元（可以有两位小数），不是分。',
      '- 只统计那个月的交易；不给 --month 就用交易里最新的那个月。',
      '- 预算里的每个类别输出一行：类别、当月已花、预算、剩余（预算减已花），金额都用 report 那种 $1,234.56 格式。剩余是负数的时候照样显示负数，并在行尾加 OVER。预算里有但这个月没花钱的类别也要列（已花 $0.00）；预算里没有的类别不列。按类别名排序。',
      '- 最后一行 TOTAL，同样三列金额，只合计上面列出来的类别。',
      '- budgets.json 读不到、不是合法 JSON、不是对象、或者某个值不是数字，都要报错并以非 0 退出。'
    ].join('\n'),
    rootCause: ['src/cli/main.js'],
    decoys: []
  },
  {
    set: 'hard',
    id: 'oversell',
    prompt:
      '线上偶尔会超卖：有个商品只剩 5 个库存，同一时刻来了 7 个预留请求（POST /items/:sku/reserve），结果 7 个全都返回 200，事后看 reserved 还只有 1 或 2。帮我修好，并发的时候不能超卖，数也不能丢。',
    rootCause: ['src/domain/stock.js'],
    decoys: ['src/store/fileStore.js', 'src/api/server.js']
  },
  {
    set: 'hard',
    id: 'export',
    prompt:
      '我用 `node scripts/seed.js /tmp/demo 1200` 造了 1200 个商品的演示数据，然后 `node bin/stockroom.js export /tmp/out.csv --data /tmp/demo`，导出来的 CSV 只有 528 行，还有些 SKU 出现了两次。帮我查一下，修好。',
    startCommit: 'list: group items by category',
    rootCause: ['src/services/paginate.js'],
    decoys: ['src/export/exportItems.js', 'scripts/seed.js']
  },
  {
    set: 'hard',
    id: 'slowreport',
    prompt:
      '`report lowstock` 在我们的真实数据上（3000 个商品、6 万条出入库记录）要跑将近一分钟。可以用 `node scripts/seed.js /tmp/big 3000 60000` 造差不多的数据，再跑 `node bin/stockroom.js report lowstock --data /tmp/big --now 2026-05-01`。帮我把它弄快，结果不能变。',
    rootCause: ['src/report/lowstock.js', 'src/domain/movements.js'],
    decoys: ['src/store/fileStore.js']
  },
  {
    set: 'hard',
    id: 'query',
    prompt: [
      '查询语法加上 OR、NOT 和括号，比如：',
      '',
      '- `category:tools OR category:paint`',
      '- `NOT location:Aisle*`',
      '- `(category:tools OR category:paint) onHand>10`',
      '',
      '要求：',
      '',
      '- 优先级：NOT 最高，然后是 AND（空格就是 AND，也可以明写 AND），最后是 OR。',
      '- AND / OR / NOT 必须大写才算运算符；小写的 and、or、not 还是普通搜索词。',
      '- 引号里的括号是普通字符，比如 `name:"Hinge (large)"`。',
      '- 括号不配对、运算符少了一边（比如 `tools OR`、`NOT`、`()`）都要报错：HTTP 返回 400，CLI 非 0 退出。',
      '- 原来的写法都要照样能用。'
    ].join('\n'),
    rootCause: ['src/query/parse.js', 'src/query/tokenize.js', 'src/query/evaluate.js'],
    decoys: []
  },
  {
    set: 'hard',
    id: 'archive',
    prompt: [
      '给商品加一个归档功能：',
      '',
      '- 新接口 `POST /items/:sku/archive` 和 `POST /items/:sku/unarchive`，返回更新后的商品；CLI 也加 `archive <sku>` 和 `unarchive <sku>`。',
      '- 商品多一个 `archived` 字段（true / false），老数据里没有这个字段的当作没归档。',
      '- 归档的商品默认不出现在 `GET /items`、query、export 和两个报表（lowstock、valuation）里；`GET /items?archived=true` 只列归档的。`GET /items/:sku` 照样能取到。',
      '- 归档的商品不能 receive、reserve、ship，返回 409，错误码 `ARCHIVED`。',
      '- 还有预留（reserved > 0）的商品不能归档，返回 409，错误码 `CONFLICT`。',
      '- 已经归档的再归档、没归档的取消归档，都直接返回成功。',
      '- 出入库记录都保留；取消归档以后一切照旧。'
    ].join('\n'),
    rootCause: ['src/domain/stock.js', 'src/services/listItems.js', 'src/api/http.js'],
    decoys: []
  }
]

export const taskDir = (task: CodingTask): string => join(FIXTURES, task.set, task.id)
