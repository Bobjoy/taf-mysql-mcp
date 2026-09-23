'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

// 唯一的配置入口：<cwd>/.taf-mysql-mcp/config.json。没有环境变量兜底，
// 也没有内置默认地址——配置文件不在就报错，避免本意连测试库实际连上生产。
const CONFIG_PATH = path.join( '.taf-mysql-mcp', 'config.json' );

const KEYS = {
  servant: true,
  allowWrite: true,
  maxRows: true,
  timeoutMs: true,
};

class ConfigError extends Error {}
const fail = msg => { throw new ConfigError( msg ); };

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

function positiveInt( key, value, filePath ) {
  if ( Number.isInteger( value ) && value > 0 ) return value;
  if ( typeof value === 'string' && /^\s*\d+\s*$/.test( value ) && Number( value ) > 0 ) return Number( value );
  fail( `${filePath} 里的 ${key} 必须是正整数，给的是 ${JSON.stringify( value )}` );
}

function loadConfig( cwd = process.cwd() ) {
  const filePath = path.join( cwd, CONFIG_PATH );
  if ( !fs.existsSync( filePath ) ) {
    fail( `未找到配置文件 ${filePath}。servant 只能从该文件读取，本工具不接受环境变量、也不内置任何环境地址。` );
  }

  let parsed;
  try {
    parsed = JSON.parse( fs.readFileSync( filePath, 'utf8' ) );
  } catch ( err ) {
    fail( `配置文件解析失败：${filePath} —— ${err.message}` );
  }
  if ( !parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
    fail( `配置文件顶层必须是对象：${filePath}` );
  }

  const warnings = [];
  for ( const key of Object.keys( parsed ) ) {
    if ( key in KEYS ) continue;
    const near = Object.keys( KEYS ).find( v => v.toLowerCase() === key.toLowerCase() );
    warnings.push( near
      ? `${filePath} 里的 "${key}" 不是已知配置项，已忽略——是否想写 "${near}"？`
      : `${filePath} 里的 "${key}" 不是已知配置项，已忽略` );
  }

  if ( !parsed.servant ) {
    fail( `${filePath} 缺少 "servant"：请填写完整 servant 值。` );
  }
  if ( typeof parsed.servant !== 'string' || !parsed.servant.includes( '@' ) ) {
    fail( `${filePath} 的 servant 缺少 \`<应用名>.TgDataAsyncServer.TgDataAsyncObj@\` 前缀，只给 endpoint 是不够的。` );
  }

  // 键存在就按它校验，写 null 也算错——不做静默兜底
  const raw = ( key, def ) => ( key in parsed ? parsed[ key ] : def );

  return {
    config: {
      servant: parsed.servant.trim(),
      allowWrite: truthy( parsed.allowWrite ),
      maxRows: positiveInt( 'maxRows', raw( 'maxRows', 200 ), filePath ),
      timeoutMs: positiveInt( 'timeoutMs', raw( 'timeoutMs', 30000 ), filePath ),
    },
    warnings,
    filePath,
  };
}

module.exports = { loadConfig, CONFIG_PATH };
