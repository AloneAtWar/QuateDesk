const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

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
  }

  loadState() { return readJson(this.statePath, null); }
  saveState(state) { writeJson(this.statePath, state); return state; }

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

  getCredential(accountId) { return this.getSecrets(accountId).credential; }

  deleteCredential(accountId) {
    const credentials = this.loadCredentials();
    delete credentials[accountId];
    writeJson(this.credentialsPath, credentials);
    return true;
  }
}

module.exports = { DesktopStore };
