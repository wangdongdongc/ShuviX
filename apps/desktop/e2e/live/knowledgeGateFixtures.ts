/**
 * 知识库把关探针（knowledgeGate.probe.ts / knowledgeWork.probe.ts）共用的素材：一个虚构项目「order-service」的
 * 提交内容与一个已经劣化的项目库。
 *
 * 提交内容照工作会话真会写的样子写：工作记录、进度、包装成「知识」的修复报告、排查过程、测试结果，中间夹着真正
 * 值得留的东西（一个决定和它的理由、一条约定、一个会再咬人的坑）。劣化的库是把这些东西不加筛选地收了一阵之后的样子：
 * 全堆在根目录、同一件事好几条、过程记录和长期知识混在一起。
 */

export interface OkfSeed {
  type: string
  title: string
  description: string
  tags: string[]
  body: string
  /** 出处（一条 `sources`）；缺省不写 */
  source?: string
  /** 追加的 frontmatter 原始行（如一条人工核实的章） */
  extra?: string[]
}

export const okf = (o: OkfSeed): string =>
  [
    '---',
    'shuvix: okf v0.2',
    `type: ${o.type}`,
    `title: ${o.title}`,
    `description: ${o.description}`,
    `tags: [${o.tags.join(', ')}]`,
    'status: stable',
    ...(o.source ? ['sources:', `  - resource: ${o.source}`] : []),
    ...(o.extra ?? []),
    '---',
    '',
    `# ${o.title}`,
    '',
    o.body,
    ''
  ].join('\n')

// ─── 提交内容 ─────────────────────────────────────────────

/** 纯工作记录：做了什么、改了哪些文件、测试结果、提交号 */
export const SUBMIT_WORKLOG = `# 本次会话工作记录：修复订单导出重复行

## 做了什么
1. 定位到 \`src/export/orderExport.ts\` 的 \`exportOrders\` 在翻页时会把上一页最后一行再写一遍。
2. 把游标从 \`offset\` 改成按 \`id\` 递增取下一页。
3. 在 \`src/export/__tests__/orderExport.test.ts\` 新增了 3 个用例。
4. 运行 \`npm test\`，214 个用例全部通过。
5. 提交：\`fix(export): page by id cursor\`（a81c3f2）。

## 修改的文件
- src/export/orderExport.ts
- src/export/__tests__/orderExport.test.ts

来源：本次会话；提交 a81c3f2。`

/** 同一份工作记录，但提交者说明是用户要求记的 */
export const SUBMIT_WORKLOG_USER_ASKED = `用户要求把本次工作记录进项目知识库。

${SUBMIT_WORKLOG}`

/** 包装成「知识」的修复报告：问题 / 原因 / 修复 / 验证，但修完之后没有留下任何以后还成立的东西 */
export const SUBMIT_FIX_REPORT = `# 订单导出出现重复行的问题及修复方案

## 问题
运营反馈导出的订单 CSV 里偶尔有重复行。

## 原因
\`src/export/orderExport.ts\` 的 \`exportOrders\` 用 \`offset\` 翻页，计算下一页时把 \`(page + 1) * size\` 写成了 \`page * size + size - 1\`，每页的最后一行会在下一页开头再出现一次。

## 修复
改为按 \`id\` 游标翻页（\`WHERE id > :lastId ORDER BY id LIMIT :size\`），不再依赖 offset。

## 验证
新增 3 个单测覆盖翻页边界，\`npm test\` 全部通过；用 12 万行测试数据导出，行数与数据库一致。

来源：src/export/orderExport.ts；提交 a81c3f2。`

/** 修复报告，但原因是一条以后还会咬人的约束（网关 60 秒超时） */
export const SUBMIT_FIX_LESSON = `# 订单导出超时问题及修复

## 问题
订单量超过 5 万的商户导出订单时页面报 504。

## 排查过程
1. 先怀疑是 SQL 慢，给 \`orders(merchant_id, created_at)\` 加了索引，查询从 9 秒降到 1.2 秒，但还是 504。
2. 再怀疑是 CSV 序列化慢，换了流式的 csv-stringify，本地导出 20 万行只要 15 秒，线上仍然 504。
3. 最后在网关日志里看到请求在 60 秒整被掐断：API 网关（\`infra/gateway/nginx.conf\` 的 \`proxy_read_timeout 60s\`）对所有后端请求有 60 秒的硬超时，而导出接口在写完全部数据前不发响应头。

## 修复
\`exportOrders\` 改成先发响应头、按 2000 条分页流式写出，首字节在 1 秒内发出，网关不再掐断。

## 验证
线上 30 万行导出成功，耗时 95 秒。

来源：infra/gateway/nginx.conf；src/export/orderExport.ts；提交 c4e91d0。`

/** 进度 / 待办 */
export const SUBMIT_PROGRESS = `# 支付回调重构 —— 当前进度

- [x] 阶段一：把回调验签抽到 \`src/pay/verify.ts\`（已完成）
- [x] 阶段二：回调处理改成先落库再异步处理（已完成）
- [ ] 阶段三：接入沙箱环境联调（进行中，卡在沙箱环境拿不到证书）
- [ ] 阶段四：灰度 10% 流量

下一步：明天先找运维要沙箱证书，然后继续阶段三。

来源：本次会话。`

/** 排查过程 + 一个真结论 */
export const SUBMIT_NARRATIVE = `# 排查记录：CI 上 order-service 的集成测试随机失败

过程：
1. 一开始怀疑是测试之间共享了数据库，给每个用例加了事务回滚，没用。
2. 接着怀疑端口冲突，把端口改成随机，还是偶发失败。
3. 打开 DEBUG 日志后发现失败时 Redis 报 \`READONLY You can't write against a read only replica\`。
4. 查到 CI 的 Redis 是主从两个容器，\`REDIS_URL\` 指向的服务名 \`redis\` 经 DNS 轮询，有时解析到从库。
5. 把 CI 的 \`REDIS_URL\` 改成 \`redis-master:6379\` 后连跑 30 次全部通过。

结论：CI 里 \`redis\` 这个服务名会解析到主库或从库；要写 Redis 的地方必须连 \`redis-master\`。

来源：.github/workflows/ci.yml；docker-compose.ci.yml；本次会话。`

/** 一个决定和它的理由：该收 */
export const SUBMIT_DECISION = `# 订单号不用自增 ID

订单号（\`order_no\`）用「日期 + 机房号 + 6 位随机数」的 18 位字符串，不用数据库自增 ID：自增 ID 会暴露每天的订单量，而且分库之后不同库会撞号。这是做分库时定的，\`src/order/orderNo.ts\` 里只有生成逻辑，没有写原因。

来源：src/order/orderNo.ts；用户在本次会话中的说明。`

/** 复述代码：目录结构和函数清单 */
export const SUBMIT_RESTATE = `# order-service 目录结构与主要函数

- \`src/order/\` 订单核心：\`createOrder\` 创建订单，\`cancelOrder\` 取消订单，\`orderNo.ts\` 生成订单号。
- \`src/pay/\` 支付：\`verify.ts\` 回调验签，\`refund.ts\` 退款。
- \`src/export/\` 导出：\`orderExport.ts\` 把订单导出为 CSV。
- 入口是 \`src/index.ts\`，用 express，端口从环境变量 \`PORT\` 读。
- 测试在各目录的 \`__tests__\` 下，用 vitest。

来源：src/ 目录。`

/** 与库里已有的一条讲同一件事，没有新东西 */
export const SUBMIT_DUPLICATE = `# 订单号的生成规则

订单号是 18 位字符串：日期、机房号加 6 位随机数。没有用数据库的自增 ID，因为那样别人能从订单号看出每天有多少单，分库以后各个库之间还会重号。

来源：src/order/orderNo.ts。`

/** 给已有的一条补一个新事实 */
export const SUBMIT_EXTEND = `预发环境（staging）的 Redis 也是主从：服务名 \`redis-stg\` 同样会解析到从库，写操作要连 \`redis-stg-master\`。

来源：deploy/staging/values.yaml。`

/** 某一刻的测试结果 */
export const SUBMIT_SNAPSHOT = `# 测试结果

2026-11-10 在 main（3f9e2ab）上跑了全量测试：214 个用例全部通过，耗时 41 秒，覆盖率 81.3%，lint 无告警。

来源：本次会话运行 \`npm test\` 的输出。`

/** 一份会话总结：五项里只有两项以后还用得上 */
export const SUBMIT_MIXED = `# 会话总结：退款接口改造

1. 修改的文件：\`src/pay/refund.ts\`、\`src/pay/__tests__/refund.test.ts\`、\`docs/api/refund.md\`。
2. 用户明确要求：这个项目的提交信息一律用英文、祈使句开头（如 \`fix(pay): handle partial refund\`），不要用中文。
3. 待办：部分退款的金额校验还没做，下次继续。
4. 踩坑：\`npm run dev\` 之前必须先起本地 Redis（\`docker compose up -d redis\`），否则服务启动时卡在连接 Redis，不报错，30 秒后才超时退出——这次在这上面花了二十分钟。
5. 测试：\`npm test\` 全部通过（217 个用例）。

来源：本次会话；package.json 的 dev 脚本；src/config/redis.ts。`

/** 一件会反复做的事的做法：该收 */
export const SUBMIT_HOWTO = `# 在本地重放一条支付回调

联调时不用等支付平台真的回调，可以在本地重放：

1. 从预发的 \`pay_notify_log\` 表里取一条回调原文（\`raw_body\` 和 \`headers\` 两列）。
2. \`npm run replay-notify -- --file notify.json\`，脚本会带上原签名头 POST 到本地的 \`/pay/notify\`。
3. 本地验签用的是 \`config/certs/sandbox.pem\`；重放预发的回调要先把 \`PAY_CERT\` 指到预发的证书，否则验签必定失败。

来源：scripts/replay-notify.ts；src/pay/verify.ts。`

/** 环境里的一条事实：该收 */
export const SUBMIT_ENVFACT = `这个项目只能用 Node 20：\`better-sqlite3\` 锁在 9.x，在 Node 22 上没有预编译包，\`npm install\` 会退回源码编译并失败（报 \`node-gyp\` 找不到 Python）。\`.nvmrc\` 里写了 20，但 \`package.json\` 的 \`engines\` 没写，所以装依赖时不会有提示。

来源：.nvmrc；package.json；本次会话里 \`npm install\` 的报错。`

/** 用户的一条长期偏好：该收 */
export const SUBMIT_USERPREF = `用户要求：这个项目里所有对外接口的错误信息都要同时给中文和英文（\`message\` 中文、\`message_en\` 英文），因为海外商户的技术人员看不懂中文。新增接口时不要只写一种。

来源：用户在本次会话中的说明。`

/** 往已经劣化的库里交的一条：值得留，主题落在最挤的那一块（导出） */
export const SUBMIT_INTO_CROWDED = `# 导出的 CSV 必须带 UTF-8 BOM

订单导出的 CSV 文件开头必须写 UTF-8 BOM（\`\\uFEFF\`）：运营用 Excel 直接打开，没有 BOM 时中文全部乱码。运营为此反馈过两次，\`src/export/orderExport.ts\` 里写 BOM 的那一行没有注释，容易被当成多余的删掉。

来源：src/export/orderExport.ts；用户在本次会话中的说明。`

// ─── 库 ─────────────────────────────────────────────────

/** 「重复」「补充」两个用例的小库：各有一条现成的 */
export const SMALL_BASE: Record<string, string> = {
  'order/order-number.md': okf({
    type: 'Decision',
    title: '订单号规则',
    description: '要改订单号格式、或想换成自增 ID 时打开。',
    tags: ['order'],
    source: '/work/order-service/src/order/orderNo.ts',
    body: '订单号 `order_no` 是 18 位字符串：8 位日期 + 4 位机房号 + 6 位随机数。不用数据库自增 ID：自增 ID 会暴露日订单量，分库后不同库还会撞号。'
  }),
  'ci/redis.md': okf({
    type: 'Entity',
    title: 'CI 里的 Redis',
    description: 'CI 的集成测试报 Redis READONLY、或要改 CI 的 REDIS_URL 时打开。',
    tags: ['ci', 'redis'],
    source: '/work/order-service/docker-compose.ci.yml',
    body: "CI 的 Redis 是主从两个容器。服务名 `redis` 经 DNS 轮询会解析到主库或从库；要写 Redis 的地方必须连 `redis-master:6379`，否则偶发 `READONLY You can't write against a read only replica`。"
  })
}

const SRC = '/work/order-service'

/**
 * 劣化的库：26 条 OKF 条目 + 1 篇用户自己的笔记，全在根目录。
 *   导出 4 条（一份工作记录、一份排查过程、两条讲分页大小的）
 *   Redis / CI 3 条（一份排查过程、一条与它结论相同的、一条本地开发的坑）
 *   支付回调 4 条（进度、会话总结各一，两条长期知识）
 *   订单 4 条（订单号两条重复，状态机一条经人工核实）
 *   发版 4 条（清单、回滚各一，一份发版流水、一份测试结果）
 *   约定与杂项 7 条（目录结构复述、待办、慢查询排查过程……）
 */
export const CROWDED_BASE: Record<string, string> = {
  '订单导出超时修复.md': okf({
    type: 'Memory',
    title: '订单导出超时修复',
    description: '订单导出超时的修复记录。',
    tags: ['export'],
    source: `${SRC}/src/export/orderExport.ts`,
    body: '## 做了什么\n1. `exportOrders` 改成先发响应头再流式写出。\n2. 分页大小见 [导出分页大小](/导出分页大小.md)。\n3. 新增 4 个单测，`npm test` 全部通过。\n4. 提交 c4e91d0。\n\n## 修改的文件\n- src/export/orderExport.ts\n- src/export/__tests__/orderExport.test.ts'
  }),
  '订单导出超时排查记录.md': okf({
    type: 'Memory',
    title: '订单导出超时排查记录',
    description: '订单导出 504 的排查过程。',
    tags: ['export', 'gateway'],
    source: `${SRC}/infra/gateway/nginx.conf`,
    body: '1. 先怀疑 SQL 慢，加了索引，没用。\n2. 再怀疑 CSV 序列化慢，换流式库，没用。\n3. 最后发现 API 网关对所有后端请求有 60 秒硬超时（`proxy_read_timeout 60s`），导出接口写完全部数据前不发响应头，所以被掐断。\n\n结论：任何可能超过 60 秒的接口都必须在 60 秒内发出首字节（流式），或者改成异步任务。'
  }),
  '导出性能优化-2.md': okf({
    type: 'Memory',
    title: '导出性能优化（第二轮）',
    description: '导出性能第二轮优化的结果。',
    tags: ['export', 'performance'],
    source: `${SRC}/src/export/orderExport.ts`,
    body: '第二轮把分页从 500 调到 2000，30 万行导出从 160 秒降到 95 秒。试过 5000：快不了多少，但单页内存涨到 400MB，容器会 OOM。最终定 2000。'
  }),
  '导出分页大小.md': okf({
    type: 'Decision',
    title: '导出分页大小',
    description: '想调整导出的分页大小时打开。',
    tags: ['export'],
    source: `${SRC}/src/export/orderExport.ts`,
    body: '订单导出每页 2000 条。再小则总耗时明显变长，再大则单页内存过高（5000 条时约 400MB，容器内存上限 512MB）。'
  }),
  'CI集成测试随机失败排查.md': okf({
    type: 'Memory',
    title: 'CI 集成测试随机失败排查',
    description: 'CI 集成测试随机失败的排查过程。',
    tags: ['ci'],
    source: `${SRC}/.github/workflows/ci.yml`,
    body: '1. 怀疑测试共享数据库，加事务回滚，没用。\n2. 怀疑端口冲突，改随机端口，没用。\n3. 日志里看到 Redis 报 READONLY。\n4. CI 的 `redis` 服务名会解析到从库。\n5. 改成 `redis-master:6379` 后连跑 30 次通过。'
  }),
  'ci-redis.md': okf({
    type: 'Entity',
    title: 'CI 里的 Redis',
    description: 'CI 的集成测试报 Redis READONLY 时打开。',
    tags: ['ci', 'redis'],
    source: `${SRC}/docker-compose.ci.yml`,
    body: 'CI 的 Redis 是主从两个容器，服务名 `redis` 会解析到主库或从库；要写 Redis 的地方必须连 `redis-master:6379`。'
  }),
  '本地开发先起Redis.md': okf({
    type: 'Memory',
    title: '本地开发要先起 Redis',
    description: '`npm run dev` 卡住不动时打开。',
    tags: ['dev', 'redis'],
    source: `${SRC}/src/config/redis.ts`,
    body: '`npm run dev` 之前必须先 `docker compose up -d redis`：服务启动时会卡在连接 Redis，不报错，30 秒后才超时退出。'
  }),
  '支付回调重构进度.md': okf({
    type: 'Memory',
    title: '支付回调重构进度',
    description: '支付回调重构的当前进度。',
    tags: ['pay'],
    body: '- [x] 阶段一：验签抽到 `src/pay/verify.ts`\n- [x] 阶段二：先落库再异步处理\n- [ ] 阶段三：沙箱联调（卡在证书）\n- [ ] 阶段四：灰度 10%\n\n下一步：找运维要沙箱证书。'
  }),
  '支付回调验签.md': okf({
    type: 'Concept',
    title: '支付回调验签',
    description: '支付回调验签失败、或平台证书要轮换时打开。',
    tags: ['pay', 'security'],
    source: `${SRC}/src/pay/verify.ts`,
    body: '回调用支付平台的公钥验签（RSA2）。平台证书每年 3 月轮换：新证书放到 `config/certs/` 后要同时保留旧证书 7 天，轮换期间两把都要能验过。去重见 [支付回调幂等](/支付回调幂等.md)。'
  }),
  '支付回调幂等.md': okf({
    type: 'Decision',
    title: '支付回调幂等',
    description: '改支付回调的去重逻辑之前打开。',
    tags: ['pay'],
    source: `${SRC}/src/pay/notify.ts`,
    body: '支付平台会重发回调（最多 8 次、跨 24 小时）。以 `notify_id` 去重，去重记录保留 7 天；不能用订单号去重——同一订单的部分退款会产生多条不同的回调。'
  }),
  '支付回调重构-会话总结.md': okf({
    type: 'Memory',
    title: '支付回调重构 会话总结',
    description: '支付回调重构那次会话的总结。',
    tags: ['pay'],
    body: '本次会话完成了阶段一和阶段二。修改的文件：`src/pay/verify.ts`、`src/pay/notify.ts`、`src/pay/__tests__/notify.test.ts`。测试全部通过（209 个）。提交 7be2a10、91d04cf。'
  }),
  '订单号规则.md': okf({
    type: 'Decision',
    title: '订单号规则',
    description: '要改订单号格式时打开。',
    tags: ['order'],
    source: `${SRC}/src/order/orderNo.ts`,
    body: '订单号 `order_no` 是 18 位字符串：8 位日期 + 4 位机房号 + 6 位随机数。'
  }),
  '订单号不用自增ID.md': okf({
    type: 'Decision',
    title: '订单号不用自增 ID',
    description: '想把订单号换成自增 ID 时打开。',
    tags: ['order'],
    source: `${SRC}/src/order/orderNo.ts`,
    body: '订单号不用数据库自增 ID：自增 ID 会暴露每天的订单量，分库之后不同库还会撞号。所以用日期 + 机房号 + 随机数。'
  }),
  '订单状态机.md': okf({
    type: 'Concept',
    title: '订单状态机',
    description: '加订单状态、或改状态流转之前打开。',
    tags: ['order'],
    source: `${SRC}/src/order/state.ts`,
    extra: [
      'generated: { by: "shuvix-work/deepseek-v4-flash", at: "2026-10-12T03:10:00.000Z" }',
      'verified: { by: "human:wdd", at: "2026-10-20T08:00:00.000Z" }'
    ],
    body: '`created → paid → shipped → completed`；`created` 和 `paid` 可以到 `cancelled`，`shipped` 之后只能走退货（`returning → returned`）。状态只能前进，任何回退都要走人工工单。'
  }),
  '取消订单的坑.md': okf({
    type: 'Memory',
    title: '取消已支付订单',
    description: '改 cancelOrder、或遇到「订单已取消但钱没退」时打开。',
    tags: ['order', 'pay'],
    source: `${SRC}/src/order/cancel.ts`,
    body: '已支付的订单取消时必须先退款成功、再把状态改成 `cancelled`。反过来做的话，退款失败会留下「已取消但没退钱」的订单，对账对不上。'
  }),
  '发版检查清单.md': okf({
    type: 'Guide',
    title: '发版检查清单',
    description: '发版之前打开。',
    tags: ['release'],
    source: `${SRC}/scripts/release.sh`,
    body: '1. 全量测试通过。\n2. 数据库迁移已在预发跑过。\n3. 周五和节假日前一天不发版。\n4. 发版后盯 30 分钟错误率；出问题按 [回滚步骤](/回滚步骤.md) 处理。'
  }),
  '2026-10-28发版记录.md': okf({
    type: 'Memory',
    title: '2026-10-28 发版记录',
    description: '10 月 28 日那次发版的记录。',
    tags: ['release'],
    body: '14:02 开始发版 v3.8.0。14:10 迁移完成。14:15 全量。14:45 错误率正常，发版结束。本次包含：导出流式化、支付回调重构阶段二。'
  }),
  '回滚步骤.md': okf({
    type: 'Guide',
    title: '回滚步骤',
    description: '发版后要回滚时打开。',
    tags: ['release'],
    source: `${SRC}/scripts/rollback.sh`,
    body: '`scripts/rollback.sh <上一个版本号>`。数据库迁移不自动回滚：迁移只加不删，旧版本代码能在新表结构上跑，所以只回滚代码。'
  }),
  '测试结果-1103.md': okf({
    type: 'Memory',
    title: '测试结果 11-03',
    description: '11 月 3 日的测试结果。',
    tags: ['test'],
    body: '11 月 3 日在 main 上跑全量测试：212 个用例通过，覆盖率 80.9%，耗时 39 秒。'
  }),
  '提交信息约定.md': okf({
    type: 'Memory',
    title: '提交信息约定',
    description: '写提交信息之前打开。',
    tags: ['convention'],
    source: 'shuvix://session/0193a1c2-probe',
    body: '提交信息一律用英文、祈使句开头，带范围：`fix(pay): handle partial refund`。用户明确要求过，不要用中文。'
  }),
  '金额用分.md': okf({
    type: 'Memory',
    title: '金额一律用分',
    description: '新增金额字段、或做金额运算之前打开。',
    tags: ['convention', 'pay'],
    source: `${SRC}/src/pay/money.ts`,
    body: '所有金额在代码和数据库里都是以「分」为单位的整数（`amount_cents`），只在展示层转成元。不要用浮点数存金额。'
  }),
  '目录结构.md': okf({
    type: 'Memory',
    title: '目录结构',
    description: '项目的目录结构。',
    tags: ['structure'],
    source: `${SRC}/src`,
    body: '- `src/order/` 订单\n- `src/pay/` 支付\n- `src/export/` 导出\n- `src/index.ts` 入口\n- 测试在各目录的 `__tests__` 下'
  }),
  '待办事项.md': okf({
    type: 'Memory',
    title: '待办事项',
    description: '还没做完的事。',
    tags: ['todo'],
    body: '- 部分退款的金额校验\n- 导出加进度条\n- 沙箱证书找运维要'
  }),
  '数据库迁移规范.md': okf({
    type: 'Guide',
    title: '数据库迁移规范',
    description: '写数据库迁移之前打开。',
    tags: ['database'],
    source: `${SRC}/migrations/README.md`,
    body: '迁移只加不删：删列分两次发版——第一次代码不再读写该列，第二次才删列。这样任何一次发版都能只回滚代码（见 [回滚步骤](/回滚步骤.md)）。'
  }),
  '慢查询排查-orders表.md': okf({
    type: 'Memory',
    title: 'orders 表慢查询排查',
    description: 'orders 表慢查询的排查过程。',
    tags: ['database', 'order'],
    source: `${SRC}/migrations/0042_orders_user_created_idx.sql`,
    body: '1. 慢查询日志里「我的订单」列表要 4 秒。\n2. EXPLAIN 显示走的是 `idx_user`，然后 filesort。\n3. 加了联合索引 `idx_user_created(user_id, created_at)`，降到 30ms。\n\n结论：按用户查订单并按时间排序的查询必须走 `idx_user_created`；新写这类查询时确认 EXPLAIN 没有 filesort。'
  }),
  '退款接口改造-会话总结.md': okf({
    type: 'Memory',
    title: '退款接口改造 会话总结',
    description: '退款接口改造那次会话的总结。',
    tags: ['pay'],
    body: '修改的文件：`src/pay/refund.ts`、`src/pay/__tests__/refund.test.ts`。测试全部通过（217 个）。待办：部分退款的金额校验。'
  }),
  // 用户自己的笔记：没有 frontmatter，管理员不该动
  '随手记.md': '# 随手记\n\n- 运维联系人：老周（证书、网关的事找他）\n- 每月 1 号对账\n'
}
