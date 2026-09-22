#!/usr/bin/env node
'use strict';

// @taf/taf-rpc 会在初始化与后台 endpoint 刷新时 console.log 到 stdout，
// 而 stdio transport 的行分隔 JSON-RPC 一旦被非 JSON 行污染就会整体失效。
// 必须在 require 之前把这些出口改道到 stderr。
console.log = console.info = console.debug = console.warn = ( ...args ) => console.error( '[taf]', ...args );

const { McpServer } = require( '@modelcontextprotocol/sdk/server/mcp.js' );
const { StdioServerTransport } = require( '@modelcontextprotocol/sdk/server/stdio.js' );
const { z } = require( 'zod' );
const { classifySql } = require( './sql-policy' );
const { loadConfig, FILE_NAME } = require( './config' );
const { ETG: DB } = require( './TgDataAsyncProxy' );

let Taf;
try {
  Taf = require( '@taf/taf-rpc' );
} catch {
  console.error( '缺少 TAF RPC 客户端 @taf/taf-rpc（在公司私有 npm 源上），请先安装。' );
  process.exit( 1 );
}

const USAGE = `taf-mysql-mcp 配置错误。

配置来源两套，同一项以 ${FILE_NAME} 为准、环境变量兜底：
  ${FILE_NAME}（放在进程 cwd 下，注意 MCP 客户端决定的 cwd）
    {
      "servant":   "<应用名>.TgDataAsyncServer.TgDataAsyncObj@tcp -h <host> -t 60000 -p <port>",
      "allowWrite": false,
      "maxRows":    200,
      "timeoutMs":  30000
    }
  环境变量：TAF_MYSQL_SERVANT / TAF_MYSQL_ALLOW_WRITE=1 / TAF_MYSQL_MAX_ROWS / TAF_MYSQL_TIMEOUT_MS

servant 必须是完整值。本工具不猜应用名、不内置任何地址，也不提供默认环境，
避免本意连测试库实际连上生产。

allowWrite=1 才放开 INSERT/UPDATE/DELETE/REPLACE；TRUNCATE/DROP/ALTER 等 DDL 永远拒绝。
timeoutMs 是单次查询等待上限——TAF 客户端自身的超时很长，servant 配错时会一直挂着，靠这个值兜住。`;

function createPool( servant, timeoutMs ) {
  const communicator = Taf.Communicator.New();
  communicator.setProperty( 'timeout', timeoutMs );
  const proxy = communicator.stringToProxy( DB.TgDataAsyncProxy, servant, '', { keepAlive: true, heartInterval: 20000 } );
  return {
    // 生成的 JCE 代理只认 SelectReq，返回值也要按 response.return / stRsp 拆包
    select( sql ) {
      const req = new DB.SelectReq();
      req.readFromObject( {
        sql,
        param: JSON.stringify( [] ),
        option: JSON.stringify( { skipSqlCheck: true } ),
      } );
      return proxy.select( req ).then( ret => {
        const { return: iRet, arguments: args } = ret.response;
        return iRet === 0 ? args.stRsp.toObject() : { iRet, error: args.stRsp.error };
      } );
    },
  };
}

let loaded;
try {
  loaded = loadConfig();
} catch ( err ) {
  console.error( `${err.message}\n\n${USAGE}` );
  process.exit( 1 );
}

const { config, warnings, usedFile } = loaded;
for ( const warning of warnings ) console.error( `[config] ${warning}` );
console.error( `[config] ${usedFile ? `已读取 ${FILE_NAME}` : '未找到配置文件，使用环境变量'} | servant=${config.servant} | ${config.allowWrite ? '可读可写' : '只读'} | maxRows=${config.maxRows} | timeoutMs=${config.timeoutMs}` );

const pool = createPool( config.servant, config.timeoutMs );

function text( content, isError = false ) {
  return { content: [ { type: 'text', text: content } ], isError };
}

// TAF 调用失败时 reject 的不是 Error，而是 { request, response } 结构
function reasonOf( err ) {
  if ( err instanceof Error ) return err.message;
  const remote = err && err.response && err.response.error;
  if ( remote ) return `${remote.code ?? ''} ${remote.message || remote}`.trim();
  const message = err && err.message;
  return message || JSON.stringify( err ) || String( err );
}

async function runQuery( sql ) {
  let ret;
  try {
    ret = await Promise.race( [
      pool.select( sql ),
      new Promise( ( _, reject ) => setTimeout( () => reject( new Error( 'TIMEOUT' ) ), config.timeoutMs ) ),
    ] );
  } catch ( err ) {
    if ( err.message === 'TIMEOUT' ) {
      return text( `查询超时（${config.timeoutMs}ms 未返回）。多半是 servant 地址或对象名不对，或当前网络到不了该环境。可调整 timeoutMs。`, true );
    }
    return text( `TAF 调用失败：${reasonOf( err )}`, true );
  }

  if ( ret.iRet !== 0 ) {
    return text( `查询失败 iRet=${ret.iRet}|${ret.error || '未知错误'}`, true );
  }

  let rows;
  try {
    rows = JSON.parse( ret.result );
  } catch {
    return text( `执行完成，未返回结果集。原始返回：${ret.result}` );
  }
  // 网关执行不了这条 SQL 时返回字面量 false（语法错误、SHOW/DESC/EXPLAIN 等都是这个形状）
  if ( rows === false ) {
    return text( '数据访问服务没有返回结果集：这条 SQL 网关执行不了。该服务只支持 SELECT 族语句，SHOW TABLES / DESC / EXPLAIN 均无效；查表清单用 select table_name from information_schema.tables where table_schema = database()，查字段用 information_schema.columns。', true );
  }

  if ( !Array.isArray( rows ) ) return text( JSON.stringify( rows ) );
  if ( !rows.length ) return text( '0 行' );

  const shown = rows.slice( 0, config.maxRows );
  const notice = rows.length > config.maxRows
    ? `\n共 ${rows.length} 行，仅返回前 ${config.maxRows} 行（放大请调整 maxRows 或在 SQL 里加 LIMIT）`
    : '';
  return text( `${shown.length} 行${notice}\n${JSON.stringify( shown )}` );
}

const server = new McpServer( { name: 'taf-mysql-mcp', version: '1.0.0' } );

server.registerTool(
  'query',
  {
    title: '查询 MySQL（经 TAF 数据访问服务）',
    description: [
      '经 TAF 数据访问服务查询 MySQL。',
      '一次只传一条 SQL，结尾分号可省。',
      config.allowWrite
        ? '允许 SELECT 以及 INSERT/UPDATE/DELETE/REPLACE。'
        : '当前只读：仅允许 SELECT。',
      'TRUNCATE、DROP、ALTER、CREATE 等 DDL 一律拒绝。',
      '该服务只支持 SELECT 族语句：SHOW TABLES / DESC / EXPLAIN 不生效，查表清单用 select table_name from information_schema.tables where table_schema = database()，查字段用 information_schema.columns。',
      '跨库查询用全限定表名，如 <库名>.<表名>。',
      `未加 LIMIT 的大表查询最多返回 ${config.maxRows} 行，会被截断。`,
    ].join( ' ' ),
    inputSchema: {
      sql: z.string().min( 1 ).describe( '单条 SQL 语句' ),
    },
  },
  async ( { sql } ) => {
    const verdict = classifySql( sql, config.allowWrite );
    if ( verdict.decision === 'reject' ) return text( `已拒绝：${verdict.reason}`, true );
    try {
      return await runQuery( sql );
    } catch ( err ) {
      return text( `执行异常：${err.message}`, true );
    }
  }
);

server.connect( new StdioServerTransport() ).catch( err => {
  console.error( 'taf-mysql-mcp 启动失败:', err );
  process.exit( 1 );
} );
