'use strict';

const READ_VERBS = new Set([ 'SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN' ]);
const WRITE_VERBS = new Set([ 'INSERT', 'UPDATE', 'DELETE', 'REPLACE' ]);

const reject = reason => ({ decision: 'reject', reason });

/**
 * 把字符串字面量、反引号标识符、注释替换成等长占位，只留下结构字符
 * 后续所有判定都基于掩码结果，避免字面量里的关键字/分号干扰
 */
function mask(sql) {
  const out = [];
  const len = sql.length;
  let i = 0;
  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      out.push(' '.repeat(stop - i));
      i = stop;
      continue;
    }
    if (ch === '#' || (ch === '-' && next === '-' && (i + 2 >= len || /[\s(]/.test(sql[i + 2])))) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? len : end;
      out.push(' '.repeat(stop - i));
      i = stop;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out.push(ch + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? ch : ''));
      i = j;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

/** 按掩码串切出带括号深度的词元 */
function tokenize(masked) {
  const tokens = [];
  let depth = 0;
  let word = '';
  let wordDepth = 0;
  const flush = () => {
    if (word) tokens.push({ word: word.toUpperCase(), depth: wordDepth });
    word = '';
  };
  for (let idx = 0; idx < masked.length; idx++) {
    const ch = masked[idx];
    if (/[A-Za-z_$]/.test(ch)) {
      if (!word) wordDepth = depth;
      word += ch;
      continue;
    }
    if (/[0-9@]/.test(ch)) { if (word) word += ch; continue; }
    flush();
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  flush();
  return tokens;
}

function classifySql(sql, allowWrite = false) {
  if (typeof sql !== 'string' || !sql.trim()) {
    return reject('SQL 必须是非空字符串');
  }
  if (sql.includes('/*!')) {
    return reject('禁止 MySQL 可执行注释 /*! ... */，它无法安全地静态判定');
  }
  const masked = mask(sql);
  const tokens = tokenize(masked);

  if (!tokens.length) return reject('未识别到任何 SQL 关键字');
  // 掩码等长：字面量与注释内的分号已被抹平，剩下的分号就是真分号
  if (masked.replace(/;\s*$/, '').includes(';')) {
    return reject('只接受单条 SQL（结尾分号可省略）');
  }
  const verb = resolveVerb(tokens);
  if (verb === 'WITH') return reject('WITH 之后未找到主语句');
  if (verb === 'SELECT') {
    const words = tokens.map(t => t.word);
    const at = words.indexOf('INTO');
    if (at !== -1 && /OUTFILE|DUMPFILE/.test(words[at + 1] || '')) {
      return reject('禁止 SELECT ... INTO OUTFILE/DUMPFILE，它会向数据库服务器写文件');
    }
  }

  if (READ_VERBS.has(verb)) return { decision: 'readonly', verb };
  if (WRITE_VERBS.has(verb)) {
    if (!allowWrite) {
      return reject(`${verb} 属于写操作，当前为只读模式。确认可写后设置环境变量 TAF_MYSQL_ALLOW_WRITE=1`);
    }
    return { decision: 'write', verb };
  }
  return reject(`${verb} 不在允许范围内：DDL/权限/事务/存储过程类语句一律禁止`);
}

function resolveVerb(tokens) {
  const head = tokens[0].word;
  if (head !== 'WITH') return head;
  // CTE 名/AS/RECURSIVE 同样处于 depth 0，因此只认第一个语句动词
  const real = tokens.slice(1)
    .find(t => t.depth === 0 && (READ_VERBS.has(t.word) || WRITE_VERBS.has(t.word)));
  return real ? real.word : 'WITH';
}

module.exports = { classifySql };
