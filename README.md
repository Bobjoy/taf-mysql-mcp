# taf-mysql-mcp

给 AI agent 用的 MySQL 查询 MCP server：通过 TAF 的 `TgDataAsync` 数据访问服务转发 SQL，**默认只读**，DDL 无条件禁止。

不需要本机装 mysql 客户端，也不需要数据库账号密码——走的就是你业务服务已经在用的那条 TAF 通道。

## 安装

```bash
npm install -g @bobjoy/taf-mysql-mcp
```

命令名不带 scope，装完就是 `taf-mysql-mcp`。

依赖 `@taf/taf-rpc` / `@taf/taf-stream`，这两个包只在公司私有 npm 源上。装不上时先确认 `@taf` scope 指向了私有源：

```bash
npm config get @taf:registry
```

## 配置

两种来源，**同一项以 `.taf-mysql-mcp.json` 为准，环境变量兜底**。

`.taf-mysql-mcp.json`（放在进程 cwd 下）：

```json
{
  "servant": "<应用名>.TgDataAsyncServer.TgDataAsyncObj@tcp -h <host> -t 60000 -p <port>",
  "allowWrite": false,
  "maxRows": 200,
  "timeoutMs": 30000
}
```

| 字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `servant` | `TAF_MYSQL_SERVANT` | 无 | 必填，完整 servant 值 |
| `allowWrite` | `TAF_MYSQL_ALLOW_WRITE=1` | `false` | 放开 INSERT / UPDATE / DELETE / REPLACE |
| `maxRows` | `TAF_MYSQL_MAX_ROWS` | `200` | 单次返回行数上限，超出截断并提示 |
| `timeoutMs` | `TAF_MYSQL_TIMEOUT_MS` | `30000` | 单次查询等待上限 |

`servant` 必须是 `<应用名>.TgDataAsyncServer.TgDataAsyncObj@tcp -h <host> -p <port> -t 60000` 这种完整值，只给 endpoint 不够。**本工具不猜应用名、不内置任何地址、也不提供默认环境**——避免本意连测试库实际连上了生产。配置缺失或格式不对时进程直接退出并说明是哪个来源给错了。

## 注册到 MCP 客户端

```json
{
  "mcpServers": {
    "taf-mysql": {
      "command": "taf-mysql-mcp",
      "env": { "TAF_MYSQL_SERVANT": "<应用名>.TgDataAsyncServer.TgDataAsyncObj@tcp -h <host> -t 60000 -p <port>" }
    }
  }
}
```

用配置文件而不是环境变量的话，注意 **cwd 是 MCP 客户端决定的**，不是你敲命令的目录；不确定就看启动时 stderr 上那行 `[config] ...`，它会把实际生效的配置全部打出来。

## 工具面

只有一个工具 `query(sql)`，一次一条 SQL，结尾分号可省。跨库查询写全限定表名 `<库名>.<表名>`。

## 安全边界

- 默认只读。
- `allowWrite=1` 才放开 DML（INSERT / UPDATE / DELETE / REPLACE）。
- **DDL 永远拒绝**：`TRUNCATE` / `DROP` / `ALTER` / `CREATE` / `RENAME` / `GRANT` 等，开了写开关也救不了。
- 判定不是看首关键字：先把字符串字面量、反引号标识符、注释替换成等长占位，再按括号深度取真正的语句动词。所以 `SELECT 'x; DROP TABLE t'`、`SELECT 1; DROP TABLE t`、`/*comment*/ DELETE ...`、`WITH d AS (...) DELETE ...` 都不会骗过去。
- `SELECT ... INTO OUTFILE / DUMPFILE` 拒绝（能把数据写到服务端磁盘）。
- `/*! ... */` 可执行注释拒绝（MySQL 会执行它，等于绕过判定）。

## 这个数据访问服务的实测行为

几条容易踩的，都是实测结论：

- **只支持 SELECT 族语句**。`SHOW TABLES` / `DESC 表名` / `EXPLAIN` 不会报错，而是返回 `result: "false"`，看起来像成功。本工具会把它识别出来并报成明确的失败，同时提示改用 `information_schema`：

  ```sql
  select table_name from information_schema.tables where table_schema = database();
  select column_name, data_type from information_schema.columns where table_name = '<表名>';
  ```

- SQL 本身报错时 `iRet = -9999`，`error` 里就是 MySQL 原始错误（`Table 'xxx' doesn't exist` 这类）。这是查询失败，不是网络失败。
- servant 地址或对象名配错时，TAF 客户端会一直挂到它自己的 60s 超时才 reject（`-13001 call remote server timeout`）。所以才有 `timeoutMs` 兜底，别指望它自动快速失败。
- 底层 `@taf/taf-rpc` 会在初始化和后台 endpoint 刷新时 `console.log` 到 stdout，而 stdio transport 的行分隔 JSON-RPC 一旦被非 JSON 行污染就整体失效。本工具在 require 它之前把 `log`/`info`/`debug`/`warn` 全部改道到 stderr，日志前缀 `[taf]`。

## 开发

```bash
npm test          # node --test，无额外依赖
```

`sql-policy.test.js` 是绕过用例集（注释、字面量、多语句、CTE 修饰的 DML、可执行注释、权限/事务/存储过程语句）；`config.test.js` 覆盖配置文件与环境变量的优先级和各类报错。改策略逻辑请先在这里加用例。
