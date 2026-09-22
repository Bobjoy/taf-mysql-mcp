'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const FILE_NAME = '.taf-mysql-mcp.json';

const KEYS = {
  servant: { env: 'TAF_MYSQL_SERVANT', def: '' },
  allowWrite: { env: 'TAF_MYSQL_ALLOW_WRITE', def: false },
  maxRows: { env: 'TAF_MYSQL_MAX_ROWS', def: 200 },
  timeoutMs: { env: 'TAF_MYSQL_TIMEOUT_MS', def: 30000 },
};

class ConfigError extends Error {}
const fail = msg => { throw new ConfigError( msg ); };

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

function positiveInt( key, value, from ) {
  if ( Number.isInteger( value ) && value > 0 ) return value;
  if ( typeof value === 'string' && /^\s*\d+\s*$/.test( value ) && Number( value ) > 0 ) return Number( value );
  fail( `${key} 必须是正整数，${from} 给的是 ${JSON.stringify( value )}` );
}

function loadConfig( cwd = process.cwd() ) {
  const filePath = path.join( cwd, FILE_NAME );
  const usedFile = fs.existsSync( filePath );
  const fileVals = {};
  const warnings = [];

  if ( usedFile ) {
    let parsed;
    try {
      parsed = JSON.parse( fs.readFileSync( filePath, 'utf8' ) );
    } catch ( err ) {
      fail( `.taf-mysql-mcp.json 解析失败：${filePath} —— ${err.message}` );
    }
    if ( !parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {
      fail( `.taf-mysql-mcp.json 顶层必须是对象，实际是 ${Array.isArray( parsed ) ? 'array' : typeof parsed}` );
    }
    for ( const key of Object.keys( parsed ) ) {
      if ( key in KEYS ) continue;
      const near = Object.keys( KEYS ).find( v => v.toLowerCase() === key.toLowerCase() );
      warnings.push( near
        ? `${filePath} 里的 "${key}" 不是已知配置项，已忽略——是否想写 "${near}"？`
        : `${filePath} 里的 "${key}" 不是已知配置项，已忽略` );
    }
    Object.assign( fileVals, parsed );
  }

  const pick = key => {
    if ( key in fileVals ) return { value: fileVals[ key ], from: filePath };
    const raw = ( process.env[ KEYS[ key ].env ] || '' ).trim();
    return raw ? { value: raw, from: KEYS[ key ].env } : { value: KEYS[ key ].def, from: '默认值' };
  };

  const servant = pick( 'servant' );
  if ( !servant.value ) {
    fail( `未提供 servant：请在 ${KEYS.servant.env} 环境变量或 ${FILE_NAME} 的 "servant" 字段里给出完整 servant 值。` );
  }
  if ( typeof servant.value !== 'string' || !servant.value.includes( '@' ) ) {
    fail( `${servant.from} 的 servant 缺少 \`<应用名>.TgDataAsyncServer.TgDataAsyncObj@\` 前缀，只给 endpoint 是不够的。` );
  }

  const allowWrite = pick( 'allowWrite' );
  const rows = pick( 'maxRows' );
  const timeout = pick( 'timeoutMs' );

  return {
    config: {
      servant: servant.value.trim(),
      allowWrite: truthy( allowWrite.value ),
      maxRows: positiveInt( 'maxRows', rows.value, rows.from ),
      timeoutMs: positiveInt( 'timeoutMs', timeout.value, timeout.from ),
    },
    warnings,
    usedFile,
  };
}

module.exports = { loadConfig, FILE_NAME };
