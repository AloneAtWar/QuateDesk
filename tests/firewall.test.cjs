const test = require('node:test');
const assert = require('node:assert/strict');
const { profileCovers, rulesCoverExe } = require('../electron/firewall.cjs');

const EXE = 'C:\\Program Files\\Quota Desk\\Quota Desk.exe';
// 一条默认「已启用 / 放行 / 全档 / 本程序」的 TCP 规则，用 over 覆盖字段
const rule = (over = {}) => ({ Enabled: 'True', Action: 'Allow', Profile: 'Any', Program: EXE, Protocol: 'TCP', ...over });

test('profileCovers：只有 Any 或三档齐全才算覆盖', () => {
  assert.equal(profileCovers('Any'), true);
  assert.equal(profileCovers('any'), true);
  assert.equal(profileCovers('Domain, Private, Public'), true);
  assert.equal(profileCovers('Public'), false);
  assert.equal(profileCovers('Domain, Private'), false);
  assert.equal(profileCovers(''), false);
});

test('rulesCoverExe：同程序路径的 TCP+UDP 全档放行齐备才通过', () => {
  assert.equal(rulesCoverExe([rule(), rule({ Protocol: 'UDP' })], EXE), true);
  // 程序路径大小写不敏感
  assert.equal(rulesCoverExe([rule({ Program: EXE.toLowerCase() }), rule({ Protocol: 'UDP' })], EXE.toLowerCase()), true);
  // Enabled 数字形式（枚举被序列化成 1/0）
  assert.equal(rulesCoverExe([rule({ Enabled: 1 }), rule({ Enabled: 1, Protocol: 'UDP' })], EXE), true);
});

test('rulesCoverExe：缺 UDP、档位不全、他程序路径、禁用或拦截规则都不通过', () => {
  // 只有 TCP 没有 UDP
  assert.equal(rulesCoverExe([rule()], EXE), false);
  // 档位只有"公用"
  assert.equal(rulesCoverExe([rule({ Profile: 'Public' }), rule({ Protocol: 'UDP', Profile: 'Public' })], EXE), false);
  // 规则指向别的程序
  assert.equal(rulesCoverExe([rule({ Program: 'C:\\other\\app.exe' }), rule({ Protocol: 'UDP', Program: 'C:\\other\\app.exe' })], EXE), false);
  // 规则被禁用
  assert.equal(rulesCoverExe([rule({ Enabled: 'False' }), rule({ Enabled: 0, Protocol: 'UDP' })], EXE), false);
  // 规则是拦截而非放行
  assert.equal(rulesCoverExe([rule({ Action: 'Block' }), rule({ Action: 'Block', Protocol: 'UDP' })], EXE), false);
});

test('rulesCoverExe：单对象（ConvertTo-Json 只有一条时的形态）与空结果', () => {
  assert.equal(rulesCoverExe(rule(), EXE), false);
  assert.equal(rulesCoverExe(null, EXE), false);
  assert.equal(rulesCoverExe([], EXE), false);
});
