const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('./config');

const SERVANT = 'APP.TgDataAsyncServer.TgDataAsyncObj@tcp -h 127.0.0.1 -t 60000 -p 1234';

function inDir(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tafcfg-'));
  if (json !== undefined) {
    fs.writeFileSync(path.join(dir, '.taf-mysql-mcp.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }
  return dir;
}

function withEnv(extra, fn) {
  const names = ['TAF_MYSQL_SERVANT', 'TAF_MYSQL_ALLOW_WRITE', 'TAF_MYSQL_MAX_ROWS', 'TAF_MYSQL_TIMEOUT_MS'];
  const saved = {};
  for (const k of names) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, extra);
  try { return fn(); } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/** 捕获抛出的错误消息，没有抛错则返回空串 */
const msg = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

test('环境变量提供配置', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT, TAF_MYSQL_MAX_ROWS: '50' }, () => {
    const { config, usedFile } = loadConfig(inDir());
    assert.strictEqual(config.servant, SERVANT);
    assert.strictEqual(config.maxRows, 50);
    assert.strictEqual(config.allowWrite, false);
    assert.strictEqual(config.timeoutMs, 30000);
    assert.strictEqual(usedFile, false);
  });
});

test('两边都没有 servant 时同时点出两个来源', () => {
  withEnv({}, () => {
    const message = msg(() => loadConfig(inDir()));
    assert.match(message, /servant/);
    assert.match(message, /TAF_MYSQL_SERVANT/);
    assert.match(message, /\.taf-mysql-mcp\.json/);
  });
});

test('文件覆盖环境变量', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT, TAF_MYSQL_MAX_ROWS: '50' }, () => {
    const dir = inDir({ servant: 'OTHER.App@tcp -h 203.0.113.9 -p 1', maxRows: 9, allowWrite: true });
    const { config, usedFile } = loadConfig(dir);
    assert.strictEqual(config.servant, 'OTHER.App@tcp -h 203.0.113.9 -p 1');
    assert.strictEqual(config.maxRows, 9);
    assert.strictEqual(config.allowWrite, true);
    assert.strictEqual(usedFile, true);
  });
});

test('文件只覆盖部分项，其余仍取 env', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT, TAF_MYSQL_MAX_ROWS: '50' }, () => {
    const { config } = loadConfig(inDir({ allowWrite: true }));
    assert.strictEqual(config.servant, SERVANT);
    assert.strictEqual(config.maxRows, 50);
    assert.strictEqual(config.allowWrite, true);
  });
});

test('坏 JSON 大声失败并带上路径', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
    assert.match(msg(() => loadConfig(inDir('{ servant: '))), /\.taf-mysql-mcp\.json 解析失败/);
  });
});

test('顶层不是对象就失败', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
    assert.match(msg(() => loadConfig(inDir([1, 2]))), /顶层必须是对象/);
    assert.match(msg(() => loadConfig(inDir('"just a string"'))), /顶层必须是对象/);
  });
});

test('未识别的键给出告警，拼错大小写能被点名', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
    const { config, warnings } = loadConfig(inDir({ allowwrite: true, foo: 1 }));
    assert.strictEqual(config.allowWrite, false, '拼错的键不得生效');
    assert.ok(warnings.some(w => /"foo"/.test(w)), JSON.stringify(warnings));
    assert.ok(warnings.some(w => /"allowwrite"/.test(w) && /"allowWrite"/.test(w)), JSON.stringify(warnings));
  });
});

test('servant 缺对象名前缀直接报错，并说明来自哪里', () => {
  withEnv({}, () => {
    const message = msg(() => loadConfig(inDir({ servant: 'tcp -h 127.0.0.1 -p 1' })));
    assert.match(message, /@/);
    assert.match(message, /\.taf-mysql-mcp\.json/);
  });
  withEnv({ TAF_MYSQL_SERVANT: 'tcp -h 127.0.0.1 -p 1' }, () => {
    assert.match(msg(() => loadConfig(inDir())), /TAF_MYSQL_SERVANT/);
  });
});

test('allowWrite 接受多种真值形态', () => {
  for (const v of [true, 1, '1', 'true']) {
    withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
      assert.strictEqual(loadConfig(inDir({ allowWrite: v })).config.allowWrite, true, JSON.stringify(v));
    });
  }
  for (const v of [false, 0, '0', 'no', 'TRUE']) {
    withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
      assert.strictEqual(loadConfig(inDir({ allowWrite: v })).config.allowWrite, false, JSON.stringify(v));
    });
  }
  withEnv({ TAF_MYSQL_SERVANT: SERVANT, TAF_MYSQL_ALLOW_WRITE: '1' }, () => {
    assert.strictEqual(loadConfig(inDir()).config.allowWrite, true);
  });
});

test('数值项必须是正整数，否则报错而不是静默取默认', () => {
  for (const bad of ['abc', 0, -5, 1.5, '12x', null]) {
    withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
      assert.match(msg(() => loadConfig(inDir({ maxRows: bad }))), /maxRows 必须是正整数/, JSON.stringify(bad));
    });
  }
  withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
    assert.strictEqual(loadConfig(inDir({ timeoutMs: 1500 })).config.timeoutMs, 1500);
    assert.strictEqual(loadConfig(inDir({ maxRows: '77' })).config.maxRows, 77, '数字字符串应接受');
  });
  withEnv({ TAF_MYSQL_SERVANT: SERVANT, TAF_MYSQL_TIMEOUT_MS: 'bad' }, () => {
    assert.match(msg(() => loadConfig(inDir())), /timeoutMs 必须是正整数.*TAF_MYSQL_TIMEOUT_MS/);
  });
});

test('文件不存在时不产生告警', () => {
  withEnv({ TAF_MYSQL_SERVANT: SERVANT }, () => {
    assert.deepStrictEqual(loadConfig(inDir()).warnings, []);
  });
});
