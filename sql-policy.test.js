const { test } = require('node:test');
const assert = require('node:assert');
const { classifySql } = require('./sql-policy');

const READ = 'readonly';
const WRITE = 'write';
const REJECT = 'reject';

const ro = sql => assert.deepStrictEqual(classifySql(sql).decision, READ, sql);
const wr = sql => assert.deepStrictEqual(classifySql(sql, true).decision, WRITE, sql);
const rj = sql => assert.deepStrictEqual(classifySql(sql).decision, REJECT, sql);

test('只读语句放行', () => {
  ro('select 1');
  ro('SELECT * FROM t_order WHERE id=1');
  ro('  \n\t SELECT 1');
  ro('sElEcT 1');
  ro('SHOW TABLES');
  ro('show create table t_order');
  ro('desc t_order');
  ro('DESCRIBE t_order');
  ro('EXPLAIN SELECT 1 FROM dual');
});

test('末尾分号与注释不构成多语句', () => {
  ro('SELECT 1;');
  ro('SELECT 1 ;');
  rj('SELECT 1 ;;');
  ro('SELECT * FROM t -- 注掉的东西; 分号不算');
  ro('SELECT * FROM t # 井号注释; 不算');
  ro('/* 头部注释; 不算 */ SELECT 1');
  ro('SELECT /* 中间; 注释 */ 1');
  ro('SELECT 1 /* 尾部 */ ;');
});

test('字符串字面量内的分号与关键字不触发判定', () => {
  ro("SELECT ';' AS x");
  ro("SELECT 'a;b' AS x");
  ro('SELECT "insert into t" AS x');
  ro("SELECT 'it\\'s; tricky' AS x");
  ro('SELECT `delete` FROM t');
  ro("SELECT 'drop table x' FROM dual");
});

test('多语句被拒绝', () => {
  rj('SELECT 1; DROP TABLE t');
  rj('SELECT 1; DELETE FROM t');
  rj("SELECT 'a;b' AS x; SELECT 2");
  rj('SHOW TABLES; SELECT 1');
});

test('DDL 无条件拒绝（写开关也救不了）', () => {
  for (const sql of [
    'DROP TABLE t', 'TRUNCATE t_user', 'ALTER TABLE t ADD COLUMN x int',
    'CREATE TABLE t (id int)', 'RENAME TABLE a TO b', 'GRANT ALL ON db TO u',
    'DELETE FROM t',
  ]) {
    const ddl = sql !== 'DELETE FROM t';
    if (ddl) assert.strictEqual(classifySql(sql).decision, REJECT, `裸执行应拒绝: ${sql}`);
    assert.strictEqual(
      classifySql(sql, true).decision, ddl ? REJECT : WRITE,
      `开写开关后 ${sql.split(' ')[0]} 应${ddl ? '仍拒绝' : '放行'}`
    );
  }
});

test('DML 需要写开关', () => {
  for (const sql of [
    'UPDATE t SET a=1 WHERE id=2', 'DELETE FROM t WHERE id=1',
    'INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)',
  ]) {
    assert.strictEqual(classifySql(sql).decision, REJECT, `未开开关应拒绝: ${sql}`);
    assert.match(classifySql(sql).reason, /allowWrite/);
    wr(sql);
  }
});

test('WITH 前缀按真实动词判定（MySQL 允许 WITH 修饰 DML）', () => {
  ro('WITH x AS (SELECT 1 AS id) SELECT * FROM x');
  ro('WITH x AS (SELECT id FROM t) , y AS (SELECT 1) SELECT * FROM x, y');
  assert.strictEqual(classifySql('WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)').decision, REJECT);
  assert.strictEqual(classifySql('WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)', true).decision, WRITE);
  wr('WITH x AS (SELECT id FROM t) UPDATE t SET a=1 WHERE id IN (SELECT id FROM x)');
});

test('SELECT INTO OUTFILE/DUMPFILE 被拒绝', () => {
  rj("SELECT * FROM t INTO OUTFILE '/tmp/x.csv'");
  rj("SELECT * FROM t INTO DUMPFILE '/tmp/x.bin'");
  ro('SELECT outfile_name FROM t');
});

test('可执行注释 /*! 被拒绝', () => {
  rj('/*! SELECT 1 */');
  rj('SELECT 1 /*! FROM t */');
  rj("SELECT '/*! x */' FROM dual");
});

test('锁行/事务语句拒绝', () => {
  rj('LOCK TABLES t READ');
  rj('START TRANSACTION');
  rj('CALL some_proc()');
  rj('SET @a = 1');
  rj('USE my_db');
  rj('LOAD DATA INFILE "/tmp/x" INTO TABLE t');
});

test('空输入与非字符串', () => {
  for (const bad of [ '', '   ', '   ;  ', null, undefined, 0, {}, [] ]) {
    const ret = classifySql(bad);
    assert.strictEqual(ret.decision, REJECT, String(bad));
  }
});

test('带尾部注释与多余空白的合法语句照常放行', () => {
  const sql = "  SELECT order_id AS x FROM T WHERE a='b;c' ; -- tail\n";
  assert.strictEqual(classifySql(sql).decision, READ);
  assert.strictEqual(classifySql("SELECT 1\n\n/* x */\n-- y\n").decision, READ);
});
