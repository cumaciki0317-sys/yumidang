import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const decoder = require('./src/safe-decode-uri.cjs');
const queryFile = require.resolve('query-string');
const queryRequire = createRequire(queryFile);
const queryModule = { exports: {} };
vm.runInNewContext(readFileSync(queryFile, 'utf8'), {
  module: queryModule, exports: queryModule.exports,
  require: name => name === 'decode-uri-component' ? decoder : queryRequire(name),
});
const query = queryModule.exports;
const plain = value => JSON.parse(JSON.stringify(value));

test('actual query-string parser preserves normal URL values and options', () => {
  assert.deepEqual(plain(query.parse('q=%EA%B0%80&emoji=%F0%9F%98%80&space=a+b&plus=a%2Bb')), {
    emoji: '😀', plus: 'a+b', q: '가', space: 'a b',
  });
  assert.deepEqual(plain(query.parse('a=1&a=2&empty=&missing')), { a: ['1','2'], empty: '', missing: null });
  assert.deepEqual(plain(query.parse('a+b=c+d&encoded%2Bkey=x%2By')), { 'a b':'c d', 'encoded+key':'x+y' });
  assert.equal(query.parse('q=%EA%B0%80+a', {decode:false}).q, '%EA%B0%80+a');
});

test('malformed values stay contained and decoded output is never decoded again', () => {
  assert.equal(query.parse('q=%&x=%GG').q, '%');
  assert.equal(query.parse('q=%&x=%GG').x, '%GG');
  for (const input of ['%E2%82', '%E2%28%A1', '%ED%A0%80', '%C0%AF']) {
    assert.equal(typeof query.parse('q='+input).q, 'string');
  }
  assert.equal(query.parse('q=%25C2%FF').q, '%C2%FF');
});

test('large malformed percent sequence finishes in a bounded subprocess', () => {
  const result = spawnSync(process.execPath, ['-e',
    `const d=require(${JSON.stringify(require.resolve('./src/safe-decode-uri.cjs'))}); const input='%FF'.repeat(100000); if(d(input)!==input) process.exit(2);`
  ], {timeout:5000, encoding:'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
