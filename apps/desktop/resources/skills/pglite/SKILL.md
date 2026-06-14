---
name: pglite
description: "ShuviX 内置嵌入式 Postgres（基于 PGLite WebAssembly），通过 `shuvix pglite` CLI 调用。**当你需要在项目里跑 SQL——做 CSV/JSON 分析、向量相似度检索、关系建模/原型、临时数据透视——且不想让用户装真实 Postgres server 时**——加载本 skill 并通过 `bash` 工具调用 `shuvix pglite`。已支持的扩展：vector / pg_trgm / fuzzystrmatch / hstore / ltree / tablefunc / cube / earthdistance / citext / intarray / unaccent / uuid-ossp。"
---

# `shuvix pglite` —— 嵌入式 Postgres

ShuviX 自带一个 WebAssembly 版本的 PostgreSQL 17（PGLite），通过 CLI `shuvix pglite` 调用。**所有调用都需要走 `bash` 工具发起**。

```bash
shuvix pglite -c "SELECT 1 AS n, 'hello' AS msg;"
shuvix pglite -c "CREATE TABLE t(id int); INSERT INTO t VALUES (1),(2); SELECT * FROM t;"
shuvix pglite -f /workspace/migrations/001.sql
echo "SELECT now();" | shuvix pglite -
shuvix pglite --extension vector -c "SELECT '[1,2,3]'::vector;"
shuvix pglite -V         # 运行时信息
shuvix pglite --help     # 完整 usage
```

输出是 **psql-style 对齐文本**：

```
 n |  msg
---+-------
 1 | hello
(1 row)
```

需要程序读？SQL 自己生成 JSON 即可：
```bash
shuvix pglite -c "SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM users LIMIT 100) t;"
```

## 何时用 `shuvix pglite` vs 别的方式

| 场景 | 选择 |
|---|---|
| 用 SQL 分析项目内的 CSV/JSON/Parquet 数据 | **`shuvix pglite`**——`COPY ... FROM` 直接导入 |
| 临时建模 / 原型（建表、插数据、查询） | **`shuvix pglite`**——开启项目持久化后跨调用保留 |
| 向量相似度检索（RAG 实验） | **`shuvix pglite --extension vector`** |
| 用户机器**已有**真实 Postgres 服务器 | 走 `bash` + `psql` 连接他们的服务器；本工具是嵌入式独立 DB，不是远程客户端 |
| 简单计算 / 字符串处理 / 跨表 join 但数据量大 | 嵌入式 WASM 单进程，**百万行级以内**够用；过大考虑分批 |

## 关键特性

### 多语句一次执行
`-c "A; B; C;"` 会按顺序执行所有语句，输出按结果集分块拼接：
```bash
shuvix pglite -c "
CREATE TABLE sales(region text, amount int);
INSERT INTO sales VALUES ('north', 100), ('south', 200);
SELECT region, sum(amount) FROM sales GROUP BY region ORDER BY 1;
"
```

### COPY FROM / COPY TO 与项目沙箱
PGLite 把项目工作目录 + 引用目录挂载进 WASM 文件系统，可以直接：
```bash
shuvix pglite -c "
CREATE TABLE rows(id int, name text);
COPY rows FROM '/workspace/data.csv' WITH (FORMAT csv, HEADER true);
SELECT count(*) FROM rows;
"
```

**沙箱边界注意**：当前 `COPY TO` 写文件**不受 ShuviX 细粒度只读边界保护**——它走的是宿主文件系统（沿用 bash 进程的写权限）。换句话说，如果某个目录被项目标记为「只读引用」，`shuvix pglite` 的 `COPY TO` 仍可能写入。**别依赖 SQL 层执行只读约束**，要么明确写到 `/workspace` 下，要么 SELECT 出来由调用方决定落盘位置。

### 数据持久化
项目设置 **「持久化数据存储」**（`pglitePersist`）控制：
- **开启**：数据存到 `<project>/.shuvix/pglite/data/`，同项目的所有 `shuvix pglite` 调用共享；session 关闭/重启后数据仍在
- **关闭**（默认）：内存模式，per-session 隔离，进程结束即丢

建议：原型/分析迭代时开启持久化；一次性查询保持内存模式。

### 扩展加载
```bash
shuvix pglite --extension vector --extension pg_trgm -c "
CREATE TABLE docs(id int, embedding vector(3), title text);
INSERT INTO docs VALUES (1, '[1,0,0]', 'apple'), (2, '[0,1,0]', 'banana');
SELECT id, title FROM docs ORDER BY embedding <-> '[1,0.1,0]' LIMIT 1;
"
```

可用扩展：

| 扩展 | 用途 |
|---|---|
| `vector` | pgvector，向量相似度（`<->` 等距离运算符） |
| `pg_trgm` | trigram 模糊文本匹配（`similarity()`、`%` 运算符） |
| `fuzzystrmatch` | soundex / levenshtein / metaphone 语音相似 |
| `hstore` | key-value 列 |
| `ltree` | 层级标签（树状路径查询） |
| `tablefunc` | crosstab / 透视表 |
| `cube`, `earthdistance` | 多维点 / 地理距离 |
| `citext` | 大小写不敏感文本 |
| `intarray` | 整数数组运算 |
| `unaccent` | 去除变音符号 |
| `uuid-ossp` | UUID 生成 |

扩展是**幂等加载**的（`CREATE EXTENSION IF NOT EXISTS`），重复 `--extension` 没副作用。

## 重要语义差异（与真实 Postgres 不一致的地方）

1. **没有 psql meta 命令**：`\d`、`\dt`、`\l` 这些 psql 客户端语法**不工作**。用 information_schema：
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sales';
   ```
2. **单连接、单数据库**：嵌入式 PGLite 是单进程单实例，无 role 系统，所有调用都以同一身份运行。
3. **不支持的功能**：parallel query、background workers、logical replication 等需要后台进程的特性都没有。
4. **大结果集会一次性返回**：`SELECT * FROM huge_table` 会把所有行拼成文本一次性回包，**写 LIMIT** 是好习惯。
5. **每次 `shuvix pglite` 调用是独立事务上下文**：跨 CLI 调用想用事务，要么把多语句塞在同一个 `-c` 里（包 `BEGIN; ... COMMIT;`），要么放到 `.sql` 文件里 `-f` 跑。

## 退出码

- `0` 成功
- `1`：SQL 错误（详细信息进 stderr）
- `2`：CLI 参数错误（如 `-c` 后面缺值）

## 调试小贴士

- 想看当前数据库里有哪些表：
  `shuvix pglite -c "\dt"` **不行**；用
  `shuvix pglite -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"`
- 想看版本：`shuvix pglite -c "SELECT version();"`
- 想清空当前项目的持久化数据：删除 `<project>/.shuvix/pglite/data/` 目录即可
