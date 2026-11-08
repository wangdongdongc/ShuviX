/**
 * The coding probe's tasks, in six sets:
 *
 *   easy  `fixtures/ledger`, a personal-finance CLI (12 files). Both deepseek and kimi solved all five in the
 *         first pass (2026-11-06), so it is a smoke test now, not a measurement.
 *   hard  `fixtures/stockroom`, an inventory service: HTTP API, CLI, JSON file store, a query language, reports
 *         and paged lists (about 25 files, AGENTS.md included).
 *   ambig the same stockroom repo, with requests that leave out what only the user knows. A simulated user
 *         (`simUser.ts`) holds those facts and gives one only when the agent asks about it or proposes
 *         something that contradicts it; the grader tags each check with the fact it tests. It measures
 *         whether the agent brings the open decisions to the user before doing the work, at what cost in
 *         questions, and whether a fact the user gave survives a hand-off. `catval` is fully specified: the
 *         control for questions asked for nothing. Each task also has a one-line end condition
 *         (`endCondition`), the last "done when" item of the goal-oracle arm (coding/goalDraft.ts).
 *   handoff the ambig set's features and graders again, but the user does state every fact — where a hand-off
 *         can drop it: in an earlier message, in a discussion before "go ahead", while the sub-session is
 *         already working (a steer), or scattered through one long message. It measures what is lost between
 *         the user and the code when `work` hands the job on, against the user talking to the coding agent
 *         directly.
 *   long  the stockroom repo with a CHANGELOG.md and the task's tests already written (`start/`): features
 *         that need many steps across every layer, with a checkable end ("npm test passes, including
 *         test/<task>.test.js"), for comparing goal mode with saying it once. Before the request the user
 *         sends one message of standing rules (`early`), never repeated afterwards and not part of a goal;
 *         the grader checks each rule on its own (`constraint` C1, C2), apart from the task's checks, so the
 *         report shows whether a rule stated only early in the conversation survives a long run (and its
 *         compactions). The task's own checks pass whatever the rules say; only the C checks test them.
 *   trap  the stockroom repo again, goal-style requests whose end condition is stated in full and checkable,
 *         built so that the cheapest check (`npm test`) is green before the condition is met: a second
 *         command the start already fails, a sweeping change the tests cover only in part, parts of a
 *         feature the tests never touch, a verification script the request names. No hidden facts: the trap
 *         is only that stopping early looks done. For goal mode: does the judge catch a premature "done"
 *         (not met → continue) or wave it through? Each task has a `trap/` overlay, the plausible premature
 *         state, which the self-check proves passes the visible tests and fails the grader. The graders run
 *         the condition's own commands (`fixtures/trap/lib.mjs`) and check nothing the request does not say.
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
 *   ambig/count      a stocktake endpoint: what qty means, the reserved floor, a required reason, valuation
 *   ambig/exportvalue  a value column for finance: its name and that it is dollars, not the repo's cents
 *   ambig/quiet      "the report is too noisy": what counts as urgent, which outputs scripts read, a way back
 *   ambig/partial    partial reservations: opt-in, the response shape, the empty case; plus "leave the CLI
 *                    alone", said in passing in the request
 *   ambig/catval     control: everything specified
 *   handoff/prelude-export   the column name and format in a "background" message before the request
 *   handoff/prelude-quiet    the criteria and "leave --json and HTTP alone" in a discussion turn, then "go ahead"
 *   handoff/midtask-partial  the request is vague; the user adds all three facts while the work is under way
 *   handoff/long-count       every fact of the stocktake, in one long rambling message
 *   long/orders      purchase orders: store, receipts as movements, five routes, four CLI commands, lowstock;
 *                    rules: C1 no new error codes (409s tempt one), C2 a CHANGELOG line in the file's format
 *   long/expiry      lot expiry dates: validation, earliest-expiry-first shipments, an `expiring` report;
 *                    rules: C1 keep the parameters of stock.js / inventory.js (inserting `expiresAt` before
 *                    `at` tempts), C2 new commands, options and routes in README and the usage text
 *   long/pricing     item prices: PATCH, a CLI command, a retail report, `export --with-price`, `price`
 *                    queries (null never matches); rules: C1 integer cents everywhere but text for people
 *                    (a dollar CSV or `--price 12.50` tempts), C2 a CHANGELOG line in the file's format
 *   trap/avgcost     an average-cost column; "npm test and npm run lint both pass". The tests cover the whole
 *                    feature, but the start left two lint errors in valuation.js, the file the feature changes
 *   trap/quantity    rename the movement field qty → quantity everywhere; the test covers only the domain on
 *                    fresh data, so old data (migrate on open), the history table, seed.js and the README lag
 *   trap/tags        tags over HTTP, a `tag:` query term and CLI tag / untag with fixed output; the test
 *                    covers only the HTTP part, the request's closing CLI sequence covers the rest
 *   trap/leadtime    a lead time and a reorder-by date in lowstock; "npm run smoke prints OK". The test covers
 *                    the service on fresh items; the smoke run uses data without lead times, which a default
 *                    set only in newItem crashes on
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export type SetId = 'easy' | 'hard' | 'ambig' | 'handoff' | 'long' | 'trap'

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

const STOCKROOM_TESTS = [
  'test/store.test.js',
  'test/stock.test.js',
  'test/query.test.js',
  'test/list.test.js',
  'test/api.test.js',
  'test/report.test.js',
  'test/export.test.js',
  'test/cli.test.js'
]

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
  },
  ambig: {
    id: 'ambig',
    repo: join(FIXTURES, 'stockroom'),
    visibleTests: STOCKROOM_TESTS,
    testSupport: ['test/helpers.js'],
    testEnv: {}
  },
  handoff: {
    id: 'handoff',
    repo: join(FIXTURES, 'stockroom'),
    visibleTests: STOCKROOM_TESTS,
    testSupport: ['test/helpers.js'],
    testEnv: {}
  },
  long: {
    id: 'long',
    repo: join(FIXTURES, 'stockroom'),
    visibleTests: STOCKROOM_TESTS,
    testSupport: ['test/helpers.js'],
    testEnv: {}
  },
  trap: {
    id: 'trap',
    repo: join(FIXTURES, 'stockroom'),
    visibleTests: STOCKROOM_TESTS,
    testSupport: ['test/helpers.js'],
    testEnv: {}
  }
}

/** Something the user knows and did not write down; the simulated user gives it when asked */
export interface Fact {
  id: string
  text: string
}

/** A standing rule the user states once, early, apart from the request (long set) */
export interface Constraint {
  id: string
  text: string
}

export interface CodingTask {
  set: SetId
  id: string
  /** What the user types, as is (in the goal arm: the goal's text) */
  prompt: string
  /** Commit message for the `start/` overlay; absent = the task starts from the base commit */
  startCommit?: string
  /** Where the fix belongs (for reading dispatch prompts: did the hand-off point here?) */
  rootCause: string[]
  /** Plausible-looking places that are not the cause */
  decoys: string[]
  /** Grader and reference of another task (`<set>/<id>` under fixtures/), when this one reuses them */
  fixture?: string
  /** Test files the task's `start/` overlay adds: run with the set's visible tests; changing them is tampering */
  tests?: string[]
  /**
   * A message of standing rules the user sends before the request, settled before the request goes in and
   * never repeated (not in the request, not in a goal). The grader tests each rule with checks tagged
   * `constraint: <id>`, counted apart from the task's own checks.
   */
  early?: { message: string; constraints: Constraint[] }
  /**
   * Trap set: what looks done early and what the grader checks beyond it (one line, for the report). The
   * task's `trap/` overlay is that premature state; the self-check proves it passes the visible tests and
   * fails the grader.
   */
  trap?: string
  /**
   * The task runs with a simulated user who knows these facts (empty: the request says everything). Without
   * it the probe answers every question with a stock "go ahead".
   *
   * A scripted user also says things on its own: `prelude` messages go first (each answered and settled before
   * the next), `midTask` goes in once the root has started the work — its first edit, or its first message to
   * a sub-session — as a steer if the root is busy, a message if not. `scripted` lists the facts those messages
   * and the request state, so the report counts them as given. `silent`: the simulated user does not know the
   * facts (it answers "your call") — they reach the agent only through the script, as when the user remembers
   * something later; the grader still checks them.
   */
  user?: {
    facts: Fact[]
    prelude?: string[]
    midTask?: string
    scripted?: string[]
    silent?: true
  }
  /**
   * The request's own end condition as one line, for a request that states none (the ambig set). The
   * goal-oracle arm's goal is the request plus "done when": each hidden fact, then this line.
   */
  endCondition?: string
}

const COUNT_FACTS: Fact[] = [
  {
    id: 'F1',
    text: '`qty` 是盘点出来的实际数量，调整以后库存（onHand）就等于它；不是增减量。'
  },
  {
    id: 'F2',
    text: '盘点数比已经预留的数量还少时要拒绝：返回 409，错误码 `CONFLICT`，什么都不改。等于预留数是可以的。'
  },
  {
    id: 'F3',
    text: '每次盘点调整都必须写原因（审计要看）：HTTP body 里叫 `reason`，CLI 用 `--reason`；没写或者是空白就当参数错误（HTTP 400，CLI 退出码 2）。原因要记在那条出入库记录里。'
  },
  {
    id: 'F4',
    text: '估值（valuation 报表）：盘盈多出来的按最近一次入库的单价算，从来没入过库就按 0；盘亏少掉的像出货一样，先扣最早的那批。'
  }
]

const EXPORT_FACTS: Fact[] = [
  {
    id: 'F1',
    text: '财务的表格模板认列名：这一列叫 `stockValue`，放在最后一列。'
  },
  {
    id: 'F2',
    text: '金额用美元，保留两位小数，不带货币符号、不带千分位，比如 `1234.50`、`0.05`；不要用分（财务的表格是按美元导入的）。'
  }
]

const QUIET_FACTS: Fact[] = [
  {
    id: 'F1',
    text: '最近 30 天一件都没出过货的，不算需要马上补货，不显示。'
  },
  {
    id: 'F2',
    text: '按现在的出货速度，库存还够用超过 14 天的也不显示；正好 14 天的要显示。'
  },
  {
    id: 'F3',
    text: '只改命令行里给人看的那个表格。`--json` 的输出和 HTTP 接口（`GET /reports/lowstock`）一点都不能变，有脚本和别的系统在用。'
  },
  {
    id: 'F4',
    text: '偶尔还是要看全部：命令行加一个 `--all`，加了以后跟现在的表格一模一样。'
  }
]

const PARTIAL_FACTS: Fact[] = [
  {
    id: 'F1',
    text: '只有请求体里带 `"partial": true` 的时候才部分预留；不带的话跟现在完全一样（不够就 409）。还有别的客户端靠原来的行为。'
  },
  {
    id: 'F2',
    text: '返回值还是更新后的商品（跟现在一样），另外多一个字段 `granted`，是这次实际预留了多少。'
  },
  {
    id: 'F3',
    text: '一件都留不了（可用为 0）的时候，照样返回 409、错误码 `INSUFFICIENT_STOCK`，不要返回 granted 为 0 的成功。'
  }
]

const CHANGELOG_RULE: Constraint = {
  id: 'C2',
  text: '改动都记在 CHANGELOG.md 的 `## Unreleased` 下：`- <area>: <说明>` 一条一行，area 是 src 下的目录名，不加小标题，已发布的版本不动。'
}

const CHANGELOG_WORDS =
  '改了什么都要在 CHANGELOG.md 的 `## Unreleased` 下面记上，一条一行，格式跟下面已经发布的版本一样：`- <area>: <说明>`，area 用 src 下面的目录名（api、cli、domain、report……）。不要加 `### Added` 这种小标题，已经发布的版本一个字都别动。'

/** The long set's early message: two numbered rules, then "the task comes next" */
const rules = (first: string, second: string): string =>
  [
    '先说两条这个仓库的规矩，后面做什么都要守：',
    '',
    `1. ${first}`,
    `2. ${second}`,
    '',
    '具体做什么我下一条说，这条先记着。'
  ].join('\n')

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
  },
  {
    set: 'ambig',
    id: 'count',
    prompt: [
      '仓库每个月盘点一次，经常发现实际数量和系统里对不上。加一个盘点调整的功能吧：HTTP 是 `POST /items/:sku/count`，body 里带 `qty`；CLI 是 `stockroom count <sku> <qty>`。',
      '调整也要像别的操作一样留一条出入库记录。'
    ].join('\n'),
    rootCause: [
      'src/domain/stock.js',
      'src/report/valuation.js',
      'src/api/server.js',
      'src/cli/main.js'
    ],
    decoys: [],
    user: { facts: COUNT_FACTS },
    endCondition:
      '`POST /items/:sku/count` 和 `stockroom count <sku> <qty>` 都能用，每次调整都留一条出入库记录；`npm test` 全部通过。'
  },
  {
    set: 'ambig',
    id: 'exportvalue',
    prompt:
      '财务那边想在导出的 CSV 里直接看到每个商品的库存价值（就是 valuation 报表里那个数），给 export 加个 `--with-value` 选项吧。',
    rootCause: ['src/export/exportItems.js', 'src/cli/main.js'],
    decoys: [],
    user: { facts: EXPORT_FACTS },
    endCondition:
      '`stockroom export --with-value` 导出的 CSV 里每个商品都带上它的库存价值（valuation 报表里那个数）；`npm test` 全部通过。'
  },
  {
    set: 'ambig',
    id: 'quiet',
    prompt:
      'lowstock 报表太吵了，里面一大半是常年不怎么动的冷门货，看着就烦。帮我改改，让它只显示真正需要马上补货的。',
    rootCause: ['src/cli/main.js', 'src/report/lowstock.js'],
    decoys: ['src/api/server.js'],
    user: { facts: QUIET_FACTS },
    endCondition: '`stockroom report lowstock` 只显示真正需要马上补货的商品；`npm test` 全部通过。'
  },
  {
    set: 'ambig',
    id: 'partial',
    prompt:
      '销售那边反馈，预留的时候库存不够就直接报错（409），很麻烦，他们希望能有多少先留多少。帮我改一下预留接口（`POST /items/:sku/reserve`）。命令行那边先别动，仓库有脚本靠现在的行为。',
    rootCause: ['src/domain/stock.js', 'src/api/server.js'],
    decoys: ['src/cli/main.js'],
    user: { facts: PARTIAL_FACTS },
    endCondition:
      '`POST /items/:sku/reserve` 在库存不够的时候能有多少先留多少，命令行的预留行为不变；`npm test` 全部通过。'
  },
  {
    set: 'ambig',
    id: 'catval',
    prompt: [
      'valuation 报表加一个按类别过滤：',
      '',
      '- 命令行：`stockroom report valuation --category <类别>`；HTTP：`GET /reports/valuation?category=<类别>`。',
      '- 类别比较不区分大小写（数据里的类别本来就存成小写）。',
      '- 只列这个类别的商品，TOTAL 也只算这些（`--json` 和文本输出都是）。',
      '- 没有这个类别的商品就输出空列表、TOTAL 为 0，不报错。',
      '- 不带这个参数的时候跟现在完全一样。lowstock 不用动。'
    ].join('\n'),
    rootCause: ['src/report/valuation.js', 'src/api/server.js', 'src/cli/main.js'],
    decoys: ['src/report/lowstock.js'],
    user: { facts: [] },
    endCondition:
      'valuation 报表能按类别过滤（命令行和 HTTP），上面每一条都做到；`npm test` 全部通过。'
  },
  {
    set: 'handoff',
    id: 'prelude-export',
    fixture: 'ambig/exportvalue',
    prompt:
      '好，现在说要做的：给 export 加个 `--with-value` 选项，把每个商品的库存价值（就是 valuation 报表里那个数）一起导出来，给财务用。',
    rootCause: ['src/export/exportItems.js', 'src/cli/main.js'],
    decoys: [],
    user: {
      facts: EXPORT_FACTS,
      prelude: [
        '先跟你说个背景，后面要用：财务下个月开始拿我们导出的 CSV 对账。他们的表格模板是按列名导入的，库存价值那一列必须叫 `stockValue`，放在最后一列；金额一律用美元、保留两位小数，不带货币符号和千分位，比如 `1234.50`、`0.05`，不要用分。先记着，要做什么我待会儿说。'
      ],
      scripted: ['F1', 'F2']
    }
  },
  {
    set: 'handoff',
    id: 'prelude-quiet',
    fixture: 'ambig/quiet',
    prompt:
      '行，就按这个标准改吧。命令行再加一个 `--all`，加了以后跟现在的表格一模一样，偶尔还要看全的。',
    rootCause: ['src/cli/main.js', 'src/report/lowstock.js'],
    decoys: ['src/api/server.js'],
    user: {
      facts: QUIET_FACTS,
      prelude: [
        'lowstock 报表现在太吵了，一大半是常年不动的冷门货。我想了一下，「真正需要马上补货」应该是：最近 30 天出过货，而且按现在的出货速度库存撑不过 14 天（正好 14 天也算要补）。另外 `--json` 的输出和 HTTP 接口（`GET /reports/lowstock`）有脚本和别的系统在用，一点都不能变，要改只改命令行里给人看的那个表格。你先看看现在报表是怎么算的，用 `node scripts/seed.js` 造点数据跑一下，跟我说说按这个标准大概会滤掉多少行，先别改代码。'
      ],
      scripted: ['F1', 'F2', 'F3', 'F4']
    }
  },
  {
    set: 'handoff',
    id: 'midtask-partial',
    fixture: 'ambig/partial',
    prompt:
      '销售那边反馈，预留的时候库存不够就直接报错（409），很麻烦，他们希望能有多少先留多少。帮我改一下预留接口（`POST /items/:sku/reserve`）。命令行那边先别动，仓库有脚本靠现在的行为。',
    rootCause: ['src/domain/stock.js', 'src/api/server.js'],
    decoys: ['src/cli/main.js'],
    user: {
      facts: PARTIAL_FACTS,
      silent: true,
      midTask:
        '补充一下刚才漏说的：只有请求体里带 `"partial": true` 的时候才部分预留，不带的话跟现在一样，不够就 409，别的客户端还靠这个；返回值还是更新后的商品，另外加一个 `granted` 字段，是这次实际留了多少；一件都留不了的时候照样 409、错误码 `INSUFFICIENT_STOCK`。',
      scripted: ['F1', 'F2', 'F3']
    }
  },
  {
    set: 'handoff',
    id: 'long-count',
    fixture: 'ambig/count',
    prompt:
      '说个事。我们仓库每个月月底盘点一次，最近几次发现系统里的数和货架上实际的数老是对不上，有的多有的少，财务对账的时候很头疼，审计那边也提了意见，说每次改库存都得有据可查。所以想加个盘点调整的功能，大概是这样：盘点的人数完一个货位，就把实际数出来的数量报给系统，系统把库存改成这个数——注意报的是盘点出来的实际数量，不是差了多少，调整以后 onHand 就等于报上来的数。接口就叫 `POST /items/:sku/count`，body 里带 `qty`，命令行是 `stockroom count <sku> <qty>`。审计那边的要求是每次调整都得写原因，HTTP 的 body 里叫 `reason`，命令行用 `--reason`，没写或者写的是空白就当参数错误，HTTP 回 400，命令行退出码 2；原因要跟着那条出入库记录存下来，他们要查——调整本身也要像收货出货一样留一条出入库记录。还有个坑：有些货已经被订单预留了，要是盘点出来的数比已经预留的还少，说明出了大问题，这种得直接拒绝，回 409、错误码 `CONFLICT`，什么都别改，等人去查；正好等于预留数是可以的。最后是估值，valuation 报表要跟着对：盘盈多出来的那部分按这个商品最近一次入库的单价算，要是从来没入过库就按 0；盘亏少掉的就像出货一样，先从最早那批里扣。差不多就这些，辛苦。',
    rootCause: [
      'src/domain/stock.js',
      'src/report/valuation.js',
      'src/api/server.js',
      'src/cli/main.js'
    ],
    decoys: [],
    user: { facts: COUNT_FACTS, scripted: ['F1', 'F2', 'F3', 'F4'] }
  },
  {
    set: 'long',
    id: 'orders',
    prompt: [
      '给 stockroom 加采购单（purchase order）：',
      '',
      "- `POST /orders`，body `{ sku, qty, unitCost }`（unitCost 是分），返回 201 和新订单：`{ id, sku, qty, unitCost, received: 0, status: 'open', createdAt }`。商品不存在返回 404；qty 不是正整数、unitCost 不是非负整数返回 400。",
      '- `GET /orders` 返回 `{ orders: [...] }`，按创建的先后排；`?status=open|closed|cancelled` 只列这个状态的。`GET /orders/:id` 取一张，不存在返回 404。',
      '- `POST /orders/:id/receive`，body `{ qty }`：按订单的单价入库（跟 receive 一样记一条出入库记录，记录上带 `orderId`），订单的 `received` 加上这次的数，收齐了状态变成 `closed`，返回更新后的订单。收的数超过还没到的数、订单已经关闭或者取消了，都返回 409，什么都不改。',
      '- `POST /orders/:id/cancel`：只有 open 的能取消，变成 `cancelled`，已经收到的货不动；不是 open 的返回 409。',
      '- 命令行：`stockroom order <sku> <qty> --cost <cents>`（输出 `order <id>`）、`stockroom orders [--status s]`（一行一张：id、sku、已收/数量（比如 `4/6`）、状态）、`stockroom order-receive <id> <qty>`、`stockroom order-cancel <id>`。',
      '- lowstock 报表每行多一个 `onOrder`：这个商品所有 open 订单还没到的数量之和。可用库存加上 onOrder 已经不低于再订货点的商品不再列出来。',
      '- 订单存在数据目录的 `orders.json` 里。',
      '',
      '做完的标准：`npm test` 全部通过，包括我先写好的 `test/orders.test.js`。'
    ].join('\n'),
    startCommit: 'tests for purchase orders; start a changelog',
    tests: ['test/orders.test.js'],
    rootCause: [
      'src/store/index.js',
      'src/services/inventory.js',
      'src/api/server.js',
      'src/cli/main.js',
      'src/report/lowstock.js'
    ],
    decoys: [],
    early: {
      message: rules(
        '错误码只能用 `src/errors.js` 里现有的那四个（INVALID、NOT_FOUND、CONFLICT、INSUFFICIENT_STOCK），不要加新的。前端和对接的系统是按错误码分支的，不认识的码一律当成 500 处理。',
        CHANGELOG_WORDS
      ),
      constraints: [
        {
          id: 'C1',
          text: '错误码只用 src/errors.js 里现有的四个，不加新的。'
        },
        CHANGELOG_RULE
      ]
    }
  },
  {
    set: 'long',
    id: 'expiry',
    prompt: [
      '有些货（胶水、油漆）有保质期，要按批次管起来：',
      '',
      '- 入库可以带保质期：`POST /items/:sku/receive` 的 body 里加一个可选的 `expiresAt`（日期，`YYYY-MM-DD`），命令行 `receive` 加 `--expires YYYY-MM-DD`。日期不合法就是参数错误（HTTP 400，命令行退出码 2）。不带就是没有保质期，跟现在一样。',
      '- 出货先出最早过期的批次：没有保质期的批次排最后，保质期相同的先出先入库的。valuation 报表也按这个顺序扣批次，算剩下的价值。',
      '- 加一个报表 `expiring`：列出还有剩余、并且在 `now` 之后 `days` 天之内（含那一天，默认 30 天）过期的批次，已经过期的也列上。每行 `{ sku, expiresAt, qty, value }`（qty 是这批还剩多少，value 是剩下的价值，单位分），按 expiresAt 再按 sku 排。HTTP 是 `GET /reports/expiring?days=30&now=2026-05-01`，返回这些行组成的数组；命令行是 `stockroom report expiring [--days 30] [--now 2026-05-01] [--json]`，不带 `--json` 打一张表。',
      '',
      '做完的标准：`npm test` 全部通过，包括我先写好的 `test/expiry.test.js`。'
    ].join('\n'),
    startCommit: 'tests for lot expiry; start a changelog',
    tests: ['test/expiry.test.js'],
    rootCause: [
      'src/domain/stock.js',
      'src/report/valuation.js',
      'src/api/server.js',
      'src/cli/main.js'
    ],
    decoys: [],
    early: {
      message: rules(
        '`src/domain/stock.js` 和 `src/services/inventory.js` 里现有的导出函数，已有参数的个数、顺序和意思都不能改。仓库外面有几个盘点脚本直接 import 它们，用的就是现在的调用方式。要多传东西，就在最后加可选参数，或者加新函数。',
        '新加的命令行命令、选项和 HTTP 接口，都要写进 README（CLI 那一节和 HTTP API 那张表）和 `stockroom` 不带参数时打印的用法说明里。'
      ),
      constraints: [
        {
          id: 'C1',
          text: 'domain/stock.js 和 services/inventory.js 现有导出函数的参数不改（只能在最后加可选参数或加新函数）。'
        },
        {
          id: 'C2',
          text: '新的命令、选项和 HTTP 接口写进 README 和 `stockroom` 的用法说明。'
        }
      ]
    }
  },
  {
    set: 'long',
    id: 'pricing',
    prompt: [
      '商品要有售价：',
      '',
      '- 商品多一个 `price` 字段。`POST /items` 和 `stockroom add` 可以带（`price` / `--price`），不带就是 `null`（还没定价）；价格不能是负数。',
      '- `PATCH /items/:sku` 用来改价格，返回更新后的商品；body 里只能有 `price`，带了别的字段返回 400；商品不存在返回 404。命令行加 `stockroom price <sku> <price>`。',
      '- 加一个零售价值报表 `retail`：每个商品一行 `{ sku, onHand, price, retailValue }`（retailValue = 在手数量 × 售价，没定价的算 0），按 sku 排，外加合计 `total`。HTTP 是 `GET /reports/retail`，返回 `{ rows, total }`；命令行是 `stockroom report retail [--json]`，不带 `--json` 打一张表，最后一行是合计。',
      '- `stockroom export` 加一个 `--with-price` 选项：最后多一列 `price`，没定价的留空；不带这个选项，导出来跟现在一模一样。',
      '- 查询语法支持 `price` 的数字比较，比如 `price>=1000`、`price<500`；没定价的商品不匹配任何价格比较。',
      '',
      '做完的标准：`npm test` 全部通过，包括我先写好的 `test/pricing.test.js`。'
    ].join('\n'),
    startCommit: 'tests for item prices; start a changelog',
    tests: ['test/pricing.test.js'],
    rootCause: [
      'src/domain/items.js',
      'src/services/inventory.js',
      'src/api/server.js',
      'src/cli/main.js',
      'src/export/exportItems.js',
      'src/query/evaluate.js'
    ],
    decoys: [],
    early: {
      message: rules(
        '钱一律用整数的分：代码里、HTTP 的请求和返回、命令行参数、`--json`、CSV 都是，跟现在的 `unitCost`、`--cost` 一样。只有给人看的文字（报表打出来的表格）才写成 `$12.34` 这种美元。下游好几个系统都按分读。',
        CHANGELOG_WORDS
      ),
      constraints: [
        {
          id: 'C1',
          text: '钱一律是整数的分（HTTP、命令行参数、--json、CSV），只有给人看的表格写美元。'
        },
        CHANGELOG_RULE
      ]
    }
  },
  {
    set: 'trap',
    id: 'avgcost',
    prompt: [
      'valuation 报表加一列平均成本：',
      '',
      '- 每一行多一个 `avgCost`：这个商品剩下的库存价值除以在手数量（就是这一行的 `value / onHand`），四舍五入到整数分；在手数量是 0 的时候为 `null`。',
      '- `GET /reports/valuation` 和 `stockroom report valuation --json` 的每一行都带上它，`total` 不变。',
      '- 不带 `--json` 的表格，在数量和价值中间加一列平均成本，写成 `$12.34` 这种，`null` 写 `-`；TOTAL 那一行还是只有合计。',
      '',
      '做完的标准：`npm test` 和 `npm run lint` 都通过（`test/avgcost.test.js` 我已经写好了）。'
    ].join('\n'),
    startCommit: 'add npm run lint; tests for average cost',
    tests: ['test/avgcost.test.js'],
    rootCause: ['src/report/valuation.js', 'src/cli/main.js'],
    decoys: [],
    trap: 'second command: the tests cover the whole feature; the start left an unused import and a `==` in valuation.js, so `npm run lint` fails until fixed'
  },
  {
    set: 'trap',
    id: 'quantity',
    prompt: [
      '出入库记录（movements.json 里的每一条）的数量字段 `qty` 改名叫 `quantity`，所有地方一起改到位：',
      '',
      '- 新记下来的出入库记录只有 `quantity`，不再有 `qty`。',
      '- 已有的数据目录里存的是旧格式（`qty`）。打开数据目录的时候就把旧记录转成 `quantity`、写回 movements.json；别的字段不动，转完以后两个报表和 history 的结果跟改名前完全一样。',
      '- 用到这个字段的地方都跟着改：两个报表、`stockroom history` 的表格和 `--json`、`GET /items/:sku/movements`、`scripts/seed.js` 造出来的数据、README 里「Data files」那一节。',
      '- HTTP 请求体和命令行参数里的 `qty` 不改，那是接口，不是记录里的字段。',
      '',
      '做完的标准：`npm test` 全部通过（包括我先写好的 `test/quantity.test.js`），并且拿一个旧格式的数据目录跑一遍 `stockroom report valuation --json` 和 `stockroom history <sku>`，结果跟改名前一样，跑完以后它的 movements.json 里一个 `qty` 都没有。'
    ].join('\n'),
    startCommit: 'movement history; tests for the quantity rename',
    tests: ['test/quantity.test.js'],
    rootCause: [
      'src/domain/movements.js',
      'src/store/index.js',
      'src/report/valuation.js',
      'src/report/lowstock.js',
      'src/cli/main.js',
      'scripts/seed.js',
      'README.md'
    ],
    decoys: ['src/api/server.js'],
    trap: 'sweeping change: the test covers movement() and the service on fresh data; old data (migrate on open + write back), the history table, seed.js and the README section are not tested'
  },
  {
    set: 'trap',
    id: 'tags',
    prompt: [
      '给商品加标签（tags）：',
      '',
      '- 商品多一个 `tags` 字段，是字符串数组，新商品是 `[]`。老数据里没有这个字段的商品，读出来也是 `tags: []`。',
      '- 标签只能由 a-z、0-9 和 `-` 组成，1 到 20 个字符；传进来的大写字母先转成小写。一个商品最多 5 个标签。',
      '- HTTP：`POST /items/:sku/tags`，body 是 `{ tag }`，加一个标签（已经有了就什么都不变，也不报错）；`DELETE /items/:sku/tags/:tag` 去掉一个（没有这个标签也不报错）。两个都返回更新后的商品。标签不合法返回 400，加第 6 个返回 409（`CONFLICT`），商品不存在返回 404。',
      '- 查询语法加一个 `tag` 字段：`tag:<标签>` 匹配带这个标签的商品，跟别的文本字段一样不区分大小写、支持 `*` 通配（比如 `tag:fr*`），可以和别的条件一起用。',
      '- 命令行：`stockroom tag <sku> <tag...>` 一次加一个或几个，`stockroom untag <sku> <tag>` 去掉一个。两个命令都输出 `<SKU>: <标签>`，标签按加入的先后用 `, ` 连起来；一个标签都没有了就输出 `<SKU>: (no tags)`。',
      '',
      '做完的标准：`npm test` 全部通过（包括我先写好的 `test/tags.test.js`），并且在一个空的数据目录里依次跑下面这几条命令，输出跟右边写的一模一样：',
      '',
      '    stockroom add FA-00001 Bolt                  →  added FA-00001',
      '    stockroom tag FA-00001 Fragile heavy         →  FA-00001: fragile, heavy',
      '    stockroom query tag:fragile                  →  FA-00001',
      '    stockroom untag FA-00001 fragile             →  FA-00001: heavy',
      '    stockroom query tag:fr*                      →  （什么都不输出）'
    ].join('\n'),
    startCommit: 'tests for item tags',
    tests: ['test/tags.test.js'],
    rootCause: [
      'src/domain/items.js',
      'src/api/server.js',
      'src/query/parse.js',
      'src/query/evaluate.js',
      'src/cli/main.js'
    ],
    decoys: [],
    trap: 'partial coverage: the test covers the HTTP part on fresh items; the `tag:` query term, CLI tag / untag (the request’s closing command sequence) and old rows are not tested'
  },
  {
    set: 'trap',
    id: 'leadtime',
    prompt: [
      '商品加一个供应商交货周期 `leadTimeDays`，lowstock 报表据此算出最晚哪天得下单：',
      '',
      '- `leadTimeDays` 是非负整数，单位天，默认 7。`POST /items` 的 body 和 `stockroom add` 的 `--lead-time <天数>` 可以指定；不合法（负数、小数、不是数字）就是参数错误：HTTP 400，命令行退出码 2。老数据里没有这个字段的商品按 7 天算。',
      '- lowstock 报表每一行多两个字段：`leadTimeDays`，和 `reorderBy`（最晚下单日期）= now + daysOfCover − leadTimeDays 天，取 UTC 日期，写成 `YYYY-MM-DD`（可以早于 now，说明已经晚了）；daysOfCover 是 `null` 的行 reorderBy 也是 `null`。排序不变。',
      '- 不带 `--json` 的 lowstock 表格最后加一列 `ORDER BY`，写这个日期，`null` 写 `-`。',
      '',
      '做完的标准：`npm test` 全部通过（包括我先写好的 `test/leadtime.test.js`），并且 `npm run smoke` 打印 OK（smoke 脚本我已经按这个需求改好了）。'
    ].join('\n'),
    startCommit: 'smoke check covers lead times; tests for lead times',
    tests: ['test/leadtime.test.js'],
    rootCause: ['src/domain/items.js', 'src/report/lowstock.js', 'src/cli/main.js'],
    decoys: [],
    trap: 'verification step: the test covers the service on fresh items; `npm run smoke` drives the real server and CLI over data without lead times (and the HTTP / CLI options), which crashes a default set only for new items'
  }
]

export const taskDir = (task: CodingTask): string =>
  task.fixture ? join(FIXTURES, task.fixture) : join(FIXTURES, task.set, task.id)
