const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');
const { appendHistoryPoint, pruneHistory } = require('./history.cjs');
const { extractCycles, mergeCycles, purgeGhostCycles } = require('./waste.cjs');
const { REMOTE_PORT } = require('./remote-view.cjs');

const readJson = (filePath, fallback) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
};

class DesktopStore {
  constructor() {
    const root = app.getPath('userData');
    this.statePath = path.join(root, 'state.json');
    this.credentialsPath = path.join(root, 'credentials.json');
    this.historyPath = path.join(root, 'history.json');
    this.cyclesPath = path.join(root, 'cycles.json');
    this.remoteAccessPath = path.join(root, 'remote-access.json');
    this.windowStatePath = path.join(root, 'window-state.json');
  }

  // 主窗口尺寸/位置记忆：与 state.json 分开存放，避免渲染进程整体保存 state 时把它冲掉
  loadMainWindowState() { return readJson(this.windowStatePath, null); }
  saveMainWindowState(bounds) { writeJson(this.windowStatePath, bounds); return bounds; }

  loadState() { return readJson(this.statePath, null); }
  saveState(state) { writeJson(this.statePath, state); return state; }

  // 额度历史：{ accountId: [{ at, windows: { key: { remaining, amount, unit } } }] }
  loadHistory() { return readJson(this.historyPath, {}); }

  saveHistory(history) { writeJson(this.historyPath, history || {}); return history || {}; }

  appendHistory(accountId, windows, retentionDays) {
    writeJson(this.historyPath, appendHistoryPoint(this.loadHistory(), accountId, windows, Date.now(), retentionDays));
  }

  getHistory(accountId, retentionDays) {
    const history = pruneHistory(this.loadHistory(), retentionDays);
    writeJson(this.historyPath, history);
    return history[accountId] || [];
  }

  clearHistory() { writeJson(this.historyPath, {}); return true; }

  loadRemoteAccess() {
    const saved = readJson(this.remoteAccessPath, {});
    const decrypt = (value) => {
      if (!value || !safeStorage.isEncryptionAvailable()) return '';
      try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
      catch { return ''; }
    };
    const port = Number(saved.port);
    return {
      enabled: Boolean(saved.enabled),
      pairingKey: decrypt(saved.pairingKey),
      devices: Array.isArray(saved.devices) ? saved.devices.filter((device) => device && typeof device.id === 'string' && /^[\w-]{1,128}$/.test(device.id) && /^[a-f\d]{64}$/i.test(device.tokenHash || '')).map((device) => ({
        id: device.id,
        name: String(device.name || '未命名设备').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || '未命名设备',
        tokenHash: device.tokenHash.toLowerCase(),
        pairedAt: typeof device.pairedAt === 'string' ? device.pairedAt : null,
      })) : [],
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : REMOTE_PORT,
    };
  }

  saveRemoteAccess({ enabled, pairingKey = '', devices = [], port = REMOTE_PORT }) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法启用远程查看');
    const normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) throw new Error('访问端口必须是 1024–65535 之间的整数');
    const safeDevices = (Array.isArray(devices) ? devices : []).filter((device) => device && typeof device.id === 'string' && /^[\w-]{1,128}$/.test(device.id) && /^[a-f\d]{64}$/i.test(device.tokenHash || '')).map((device) => ({
      id: device.id,
      name: String(device.name || '未命名设备').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || '未命名设备',
      tokenHash: device.tokenHash.toLowerCase(),
      pairedAt: typeof device.pairedAt === 'string' ? device.pairedAt : new Date().toISOString(),
    }));
    writeJson(this.remoteAccessPath, {
      enabled: Boolean(enabled),
      pairingKey: pairingKey ? safeStorage.encryptString(String(pairingKey)).toString('base64') : '',
      devices: safeDevices,
      port: normalizedPort,
    });
  }

  isRemoteTokenAuthorized(token) {
    const config = this.loadRemoteAccess();
    const digest = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    return config.devices.some((device) => {
      const left = Buffer.from(digest, 'hex');
      const right = Buffer.from(device.tokenHash, 'hex');
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    });
  }

  pairRemoteDevice({ pairingKey, id, name }) {
    const config = this.loadRemoteAccess();
    const supplied = Buffer.from(String(pairingKey || ''));
    const expected = Buffer.from(String(config.pairingKey || ''));
    if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error('配对信息已失效，请在电脑端刷新配对信息后重试');
    if (typeof id !== 'string' || !/^[\w-]{8,128}$/.test(id)) throw new Error('设备标识无效，请刷新页面后重新配对');
    const deviceName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!deviceName) throw new Error('请填写设备名称');
    const token = crypto.randomBytes(32).toString('base64url');
    const device = { id, name: deviceName, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), pairedAt: new Date().toISOString() };
    const devices = [...config.devices.filter((item) => item.id !== id), device];
    this.saveRemoteAccess({ ...config, devices });
    return { token, deviceId: device.id, deviceName: device.name };
  }

  removeRemoteDevice(id) {
    const config = this.loadRemoteAccess();
    this.saveRemoteAccess({ ...config, devices: config.devices.filter((device) => device.id !== id) });
    return this.listRemoteDevices();
  }

  listRemoteDevices() {
    const config = this.loadRemoteAccess();
    return config.devices.map(({ id, name, pairedAt }) => ({ id, name, pairedAt }));
  }

  // 周期浪费档案：{ accountId: [{ window, from, end, kind, observedAt, remaining, amount, limit, gapMs, reliable }] }
  // 永久保留，不受历史保留时长影响；每次全量扫描该账号历史提取，靠 mergeCycles 去重，天然支持回填
  loadCycles() { return readJson(this.cyclesPath, {}); }

  saveCycles(cycles) { writeJson(this.cyclesPath, cycles || {}); return cycles || {}; }

  archiveCycles(accountId, windowKeys) {
    if (!accountId || !Array.isArray(windowKeys) || !windowKeys.length) return;
    const points = this.loadHistory()[accountId] || [];
    if (points.length < 2) return;
    const all = this.loadCycles();
    // 合并前先清掉旧版算法可能留下的幽灵档案（early+natural 重复归档），有变化就回写
    const previous = all[accountId] || [];
    const merged = mergeCycles(purgeGhostCycles(previous), extractCycles(points, windowKeys));
    if (JSON.stringify(merged) !== JSON.stringify(previous)) {
      all[accountId] = merged;
      writeJson(this.cyclesPath, all);
    }
  }

  getCycles(accountId) { return purgeGhostCycles(this.loadCycles()[accountId] || []); }

  // 启动时全量清洗一次：历史账号（已停更/停用）的幽灵档案也一并清除
  purgeAllCycles() {
    const all = this.loadCycles();
    const next = Object.fromEntries(Object.entries(all).map(([accountId, cycles]) => [accountId, purgeGhostCycles(cycles)]));
    if (JSON.stringify(next) !== JSON.stringify(all)) writeJson(this.cyclesPath, next);
  }

  clearCycles() { writeJson(this.cyclesPath, {}); return true; }

  // 删除账号后清理它的周期档案
  pruneCyclesAccounts(accountIds) {
    const valid = new Set(accountIds);
    const all = this.loadCycles();
    const next = Object.fromEntries(Object.entries(all).filter(([accountId]) => valid.has(accountId)));
    writeJson(this.cyclesPath, next);
  }

  // 删除账号后清理它的历史，同时按当前保留天数裁剪
  pruneHistoryAccounts(accountIds, retentionDays) {
    writeJson(this.historyPath, pruneHistory(this.loadHistory(), retentionDays, Date.now(), new Set(accountIds)));
  }

  loadCredentials() { return readJson(this.credentialsPath, {}); }

  getSecrets(accountId) {
    const encrypted = this.loadCredentials()[accountId];
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return { credential: '', variables: {} };
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed === 'object' && parsed.version === 2) return { credential: String(parsed.credential || ''), variables: parsed.variables || {} };
    } catch {}
    return { credential: plain, variables: {} };
  }

  saveCredential(accountId, credential, variables) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
    const credentials = this.loadCredentials();
    const existing = this.getSecrets(accountId);
    const nextVariables = variables && typeof variables === 'object' ? { ...existing.variables, ...variables } : existing.variables;
    const payload = JSON.stringify({ version: 2, credential: credential || existing.credential || '', variables: nextVariables });
    credentials[accountId] = safeStorage.encryptString(payload).toString('base64');
    writeJson(this.credentialsPath, credentials);
    return true;
  }

  deleteSecretVariable(accountId, key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
    const credentials = this.loadCredentials();
    if (!credentials[accountId]) return true;
    const existing = this.getSecrets(accountId);
    const nextVariables = { ...(existing.variables || {}) };
    delete nextVariables[key];
    const payload = JSON.stringify({ version: 2, credential: existing.credential || '', variables: nextVariables });
    credentials[accountId] = safeStorage.encryptString(payload).toString('base64');
    writeJson(this.credentialsPath, credentials);
    return true;
  }

  getCredential(accountId) { return this.getSecrets(accountId).credential; }

  deleteCredential(accountId) {
    const credentials = this.loadCredentials();
    delete credentials[accountId];
    writeJson(this.credentialsPath, credentials);
    return true;
  }
}

module.exports = { DesktopStore };
