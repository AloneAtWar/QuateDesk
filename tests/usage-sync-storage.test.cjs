const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-sync-storage-'));
const key = crypto.randomBytes(32);
let available = true;
const stubModule = new Module('electron-stub', null);
stubModule.exports = {
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (text) => {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString: (bytes) => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  },
};
stubModule.loaded = true;
require.cache[require.resolve('electron')] = stubModule;
const { DesktopStore } = require('../electron/storage.cjs');
const { UsageSyncService } = require('../electron/usage-sync/index.cjs');
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

test('同步密码独立加密落盘，公开配置没有密文或明文，留空保留密码且重启可恢复', () => {
  const store = new DesktopStore();
  const make = () => new UsageSyncService({ storage: store, archives: {} });
  const service = make();
  service.saveConfig({ enabled: true, endpoint: 'https://example.com/dav/', username: 'test-user', folder: 'QuotaDesk', password: 'dummy-app-password', passphrase: 'shared-encryption-passphrase-for-tests' });
  service.saveConfig({ enabled: false, password: '', passphrase: '' });
  const config = store.loadUsageSyncConfig();
  assert.equal(config.password, 'dummy-app-password');
  assert.equal(config.passphrase, 'shared-encryption-passphrase-for-tests');
  const raw = fs.readFileSync(store.usageSyncConfigPath, 'utf8');
  assert.equal(raw.includes(config.password), false); assert.equal(raw.includes(config.passphrase), false);
  const resumed = make();
  assert.equal(resumed.status().config.enabled, false);
  assert.equal(resumed.status().config.hasPassword, true);
  assert.equal(resumed.status().config.hasPassphrase, true);
  const visible = JSON.stringify(resumed.status());
  assert.equal(visible.includes(config.password), false); assert.equal(visible.includes(config.passphrase), false);
  assert.equal(visible.includes(JSON.parse(raw).secrets), false);
});

test('系统凭据不可用时拒绝保存并保留原配置，读取失败不会让应用无法启动', () => {
  const store = new DesktopStore();
  const before = fs.readFileSync(store.usageSyncConfigPath, 'utf8');
  available = false;
  try {
    assert.throws(() => store.saveUsageSyncConfig({ password: 'new-secret', passphrase: 'new-secret-long-enough' }), /加密不可用/);
    assert.equal(fs.readFileSync(store.usageSyncConfigPath, 'utf8'), before);
    const service = new UsageSyncService({ storage: store, archives: {} });
    assert.equal(service.status().config.enabled, false);
    assert.match(service.status().lastError, /无法读取/);
  } finally { available = true; }
});
