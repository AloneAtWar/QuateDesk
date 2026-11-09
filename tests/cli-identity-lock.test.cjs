const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 直接演练 main.cjs 里的 cliIdentityPatch：用户编辑过标识（identityLocked，含清空）后，
// 轮询身份回填必须尊重用户值；未编辑过的账号保留原有自动补齐 / 跟随行为。
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const patchSource = source.slice(source.indexOf('const cliIdentityPatch ='), source.indexOf('// ── 网络代理设置'));

function patch(account, { kind = 'codex', resolvedSource = 'snapshot', display = 'user@example.com' } = {}) {
  const context = vm.createContext({
    CLI_KINDS: ['claude', 'codex', 'gemini', 'kimi', 'grok', 'copilot', 'grokbot'],
    resolveCliAuth: () => ({ source: resolvedSource, auth: { token: 't' } }),
    cliIdentity: () => ({ fingerprint: 'fp-1', display }),
    store: { saveCredential: () => {} },
  });
  const cliIdentityPatch = vm.runInContext(`${patchSource}\ncliIdentityPatch`, context);
  return cliIdentityPatch(account, kind, { variables: {} });
}

test('快照账号标识为空时仍自动补齐登录名（自动填一次保留）', () => {
  const result = patch({ id: 'a', identity: '', cliAuthSource: 'snapshot' });
  assert.equal(result.identity, 'user@example.com');
});

test('用户清空标识后（identityLocked）轮询不再回填', () => {
  const result = patch({ id: 'a', identity: '', identityLocked: true, cliAuthSource: 'snapshot' });
  assert.equal(result.identity, '');
});

test('用户手填的标识不被覆盖（原有行为）', () => {
  const result = patch({ id: 'a', identity: '我的备注', cliAuthSource: 'snapshot' });
  assert.equal(result.identity, '我的备注');
});

test('镜像账号默认跟随本机登录，但用户编辑过（identityLocked）同样尊重', () => {
  assert.equal(patch({ id: 'a', identity: '' }, { resolvedSource: 'live' }).identity, 'user@example.com');
  assert.equal(patch({ id: 'a', identity: '', identityLocked: true }, { resolvedSource: 'live' }).identity, '');
});

test('非 CLI 类厂商不做身份维护', () => {
  assert.equal(patch({ id: 'a', identity: '' }, { kind: 'mimo' }), null);
});
