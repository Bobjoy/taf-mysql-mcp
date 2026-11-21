const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, parseArgs, CONFIG_PATH } = require('./config');

const SERVANT = 'APP.TgDataAsyncServer.TgDataAsyncObj@tcp -h 127.0.0.1 -t 60000 -p 1234';

/** 造一个含配置文件的临时 cwd；content 为 undefined 时不建文件，为 null 时只建空目录 */
function inDir(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tafcfg-'));
  if (content !== undefined && content !== null) {
    const file = path.join(dir, CONFIG_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** 捕获抛出的错误消息，没有抛错则返回空串 */
const msg = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

test('配置文件提供全部配置项', () => {
  const dir = inDir({ servant: SERVANT, maxRows: 50 });
  const { config, filePath } = loadConfig(dir);
  assert.strictEqual(config.servant, SERVANT);
  assert.strictEqual(config.maxRows, 50);
  assert.strictEqual(config.allowWrite, false);
  assert.strictEqual(config.timeoutMs, 30000);
  assert.strictEqual(filePath, path.join(dir, CONFIG_PATH));
});

test('只给 servant，其余取默认', () => {
  const { config, warnings } = loadConfig(inDir({ servant: SERVANT }));
  assert.strictEqual(config.maxRows, 200);
  assert.strictEqual(config.timeoutMs, 30000);
  assert.deepStrictEqual(warnings, []);
});

test('不接受环境变量：只有 env 时直接报缺配置文件', () => {
  const saved = process.env.TAF_MYSQL_SERVANT;
  process.env.TAF_MYSQL_SERVANT = SERVANT;
  try {
    const message = msg(() => loadConfig(inDir(null)));
    assert.match(message, /未找到配置文件/);
    assert.match(message, new RegExp(CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (saved === undefined) delete process.env.TAF_MYSQL_SERVANT;
    else process.env.TAF_MYSQL_SERVANT = saved;
  }
});

test('配置文件必须在 .taf-mysql-mcp/config.json，旧的单文件名不认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tafcfg-'));
  fs.writeFileSync(path.join(dir, '.taf-mysql-mcp.json'), JSON.stringify({ servant: SERVANT }));
  assert.match(msg(() => loadConfig(dir)), /未找到配置文件/);
});

test('坏 JSON 大声失败并带上路径', () => {
  assert.match(msg(() => loadConfig(inDir('{ servant: '))), /解析失败/);
});

test('顶层不是对象就失败', () => {
  assert.match(msg(() => loadConfig(inDir([1, 2]))), /顶层必须是对象/);
  assert.match(msg(() => loadConfig(inDir('"just a string"'))), /顶层必须是对象/);
});

test('未识别的键给出告警，拼错大小写能被点名', () => {
  const { config, warnings } = loadConfig(inDir({ servant: SERVANT, allowwrite: true, foo: 1 }));
  assert.strictEqual(config.allowWrite, false, '拼错的键不得生效');
  assert.ok(warnings.some(w => /"foo"/.test(w)), JSON.stringify(warnings));
  assert.ok(warnings.some(w => /"allowwrite"/.test(w) && /"allowWrite"/.test(w)), JSON.stringify(warnings));
});

test('servant 缺对象名前缀直接报错，并带上文件路径', () => {
  const message = msg(() => loadConfig(inDir({ servant: 'tcp -h 127.0.0.1 -p 1' })));
  assert.match(message, /@/);
  assert.match(message, /config\.json/);
});

test('缺 servant 报错', () => {
  assert.match(msg(() => loadConfig(inDir({ maxRows: 10 }))), /缺少 "servant"/);
});

test('allowWrite 接受多种真值形态', () => {
  for (const v of [true, 1, '1', 'true']) {
    assert.strictEqual(loadConfig(inDir({ servant: SERVANT, allowWrite: v })).config.allowWrite, true, JSON.stringify(v));
  }
  for (const v of [false, 0, '0', 'no', 'TRUE']) {
    assert.strictEqual(loadConfig(inDir({ servant: SERVANT, allowWrite: v })).config.allowWrite, false, JSON.stringify(v));
  }
});

test('数值项必须是正整数，否则报错而不是静默取默认', () => {
  for (const bad of ['abc', 0, -5, 1.5, '12x', null]) {
    const message = msg(() => loadConfig(inDir({ servant: SERVANT, maxRows: bad })));
    assert.match(message, /maxRows 必须是正整数/, JSON.stringify(bad));
    assert.match(message, /config\.json/, JSON.stringify(bad));
  }
  assert.strictEqual(loadConfig(inDir({ servant: SERVANT, timeoutMs: 1500 })).config.timeoutMs, 1500);
  assert.strictEqual(loadConfig(inDir({ servant: SERVANT, maxRows: '77' })).config.maxRows, 77, '数字字符串应接受');
  assert.match(msg(() => loadConfig(inDir({ servant: SERVANT, timeoutMs: 'bad' }))), /timeoutMs 必须是正整数/);
});

test('parseArgs 无参数时四项全空', () => {
  assert.deepStrictEqual(parseArgs([]), { version: false, help: false, sql: '', configPath: '' });
});

test('parseArgs 认 --version/--help', () => {
  for (const flag of ['-v', '--version']) assert.strictEqual(parseArgs([flag]).version, true, flag);
  for (const flag of ['-h', '--help']) assert.strictEqual(parseArgs([flag]).help, true, flag);
});

test('parseArgs 认三种配置路径写法', () => {
  assert.strictEqual(parseArgs(['--config', '/a/b.json']).configPath, '/a/b.json');
  assert.strictEqual(parseArgs(['--config=/a/b.json']).configPath, '/a/b.json');
  assert.strictEqual(parseArgs(['/a/b.json']).configPath, '/a/b.json');
});

test('parseArgs 把 SQL 关键字开头的位置参数识别为 SQL', () => {
  assert.strictEqual(parseArgs(['select * from t']).sql, 'select * from t');
  assert.strictEqual(parseArgs(['  SELECT 1']).sql, '  SELECT 1');
  assert.strictEqual(parseArgs(['WITH d AS (select 1) select * from d']).sql, 'WITH d AS (select 1) select * from d');
  // --config 的值哪怕形如 SQL 也归配置路径，两者可同时给出
  const both = parseArgs(['--config', 'select.json', 'update t set a=1']);
  assert.strictEqual(both.configPath, 'select.json');
  assert.strictEqual(both.sql, 'update t set a=1');
  // 表名带下划线等非关键字开头的不算 SQL，仍走配置路径
  assert.strictEqual(parseArgs(['create_table.sql']).configPath, 'create_table.sql');
});

test('parseArgs 其余参数一律报错', () => {
  assert.match(msg(() => parseArgs(['--confg', '/a'])), /不认识的参数/);
  assert.match(msg(() => parseArgs(['--config'])), /后面要跟配置文件路径/);
  assert.match(msg(() => parseArgs(['--config', '/a', '/b'])), /只能指定一个配置文件/);
  assert.match(msg(() => parseArgs(['select 1', 'select 2'])), /只能直连执行一条 SQL/);
});

test('--config 的绝对路径生效，相对路径按 cwd 解析', () => {
  const dir = inDir({ servant: SERVANT });
  const other = path.join(dir, 'elsewhere.json');
  fs.copyFileSync(path.join(dir, CONFIG_PATH), other);
  assert.strictEqual(loadConfig(dir, other).filePath, other);
  assert.strictEqual(loadConfig(dir, 'elsewhere.json').filePath, other);
  assert.strictEqual(loadConfig(dir, '').filePath, path.join(dir, CONFIG_PATH));
});

test('~ 展开到家目录', () => {
  const file = path.join(os.homedir(), '.taf-mysql-mcp-spec-test.json');
  fs.writeFileSync(file, JSON.stringify({ servant: SERVANT }));
  try {
    assert.strictEqual(loadConfig('/etc', '~/.taf-mysql-mcp-spec-test.json').filePath, file);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('显式路径不存在时报错，同时点出默认位置', () => {
  const dir = inDir(null);
  const message = msg(() => loadConfig(dir, path.join(dir, 'nope.json')));
  assert.match(message, /未找到配置文件/);
  assert.match(message, /nope\.json/);
  assert.match(message, /默认位置/);
});
