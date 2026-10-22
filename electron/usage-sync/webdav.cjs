'use strict';

const { SyncError, MAX_WIRE_BYTES } = require('./crypto.cjs');
const SOURCE_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEAD_NAME = new RegExp(`^(${SOURCE_ID})\\.json$`);
const BLOB_NAME = new RegExp(`^${SOURCE_ID}\\.${SOURCE_ID}\\.snapshot\\.json$`);

function normalizeConfig(raw = {}, previous = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyncError('同步配置格式无效');
  const value = { ...previous, ...raw };
  const endpoint = String(value.endpoint || '').trim();
  const username = String(value.username || '').trim();
  const folder = String(value.folder ?? 'QuotaDesk').trim().replace(/^\/+|\/+$/g, '');
  // Empty password fields mean "keep saved secret"; secrets never travel back to the UI.
  const password = raw.password || previous.password || '';
  const passphrase = raw.passphrase || previous.passphrase || '';
  const enabled = Boolean(value.enabled);
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new SyncError('请填写完整的 WebDAV 服务地址'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new SyncError('WebDAV 地址须使用 HTTPS，且不含账号、密码、查询参数或片段（本机测试允许 HTTP）');
    if (endpoint.length > 2048) throw new SyncError('WebDAV 地址过长');
  }
  if (!folder || folder.length > 300 || folder.split('/').length > 8 || folder.split('/').some((p) => !p || p === '.' || p === '..' || /[\\\u0000-\u001f\u007f?#]/.test(p))) throw new SyncError('同步目录需要 1–8 级文件夹，不能包含 .、..、反斜线或 ?、#');
  if (username.length > 1024 || /[:\r\n\u0000]/.test(username)) throw new SyncError('WebDAV 用户名格式无效');
  if (typeof password !== 'string' || password.length > 4096) throw new SyncError('WebDAV 应用密码过长');
  if (typeof passphrase !== 'string' || (passphrase && (passphrase.length < 6 || passphrase.length > 1024))) throw new SyncError('同步加密口令需要 6–1024 个字符');
  if (enabled && (!endpoint || !username || !password || !passphrase)) throw new SyncError('启用同步前，请填写服务地址、用户名、应用密码和同步加密口令');
  const url = endpoint ? new URL(endpoint) : null;
  if (url && !url.pathname.endsWith('/')) url.pathname += '/';
  return { enabled, endpoint: url?.href || '', username, folder, password, passphrase };
}

function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new SyncError('WebDAV 目录响应格式无效');
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

// Accept generated direct children only; never follow hrefs supplied by a server.
function parseDirectory(xml, root) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:[\w.-]+:)?multistatus\b/i.test(xml) || !/<\/(?:[\w.-]+:)?multistatus\s*>\s*$/i.test(xml)) throw new SyncError('服务未返回完整的 WebDAV 目录，请检查地址是否为 WebDAV 入口');
  const base = new URL(root), entries = new Map();
  let directChildren = 0;
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi)) {
    const href = match[1].match(/<(?:[\w.-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?href\s*>/i);
    if (!href) continue;
    let url;
    try { url = new URL(xmlText(href[1].trim()), base); } catch { throw new SyncError('WebDAV 目录包含无效路径'); }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) continue;
    const relative = url.pathname.slice(base.pathname.length);
    const name = relative.replace(/\/$/, '');
    if (name && !name.includes('/')) directChildren++;
    if (!name || name === '.' || name === '..' || !/^[a-zA-Z0-9.-]+$/.test(name)) continue;
    entries.set(name, { name, directory: relative.endsWith('/') || /<(?:[\w.-]+:)?collection\b/i.test(match[1]) });
  }
  // Nutstore and some other providers cap a listing at 750 entries. Generated
  // files are partitioned by device/month; refuse a near-limit listing, not a
  // silently incomplete view that could select an old version.
  if (directChildren >= 700) throw new SyncError('同步子目录文件过多，请整理历史版本或使用新的同步目录');
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseListing(xml, root) {
  const sources = new Set(parseDirectory(xml, root).filter((entry) => !entry.directory).map((entry) => entry.name.match(HEAD_NAME)?.[1]).filter(Boolean));
  if (sources.size > 256) throw new SyncError('同步目录超过 256 个来源，请使用独立目录');
  return [...sources].sort();
}

class WebDavClient {
  constructor(config, { fetcher = fetch, signal } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.signal = signal;
    this.root = new URL(`${config.folder.split('/').map(encodeURIComponent).join('/')}/`, config.endpoint).href;
  }

  async requestUrl(url, method, { headers = {}, body, accept = [200, 201, 204], limit = MAX_WIRE_BYTES } = {}) {
    const timeout = AbortSignal.timeout(120_000);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetcher(url, { method, headers: { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`, 'Cache-Control': 'no-cache', ...headers },
        body, signal, redirect: 'manual', credentials: 'omit' });
      if (!accept.includes(response.status)) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new SyncError('WebDAV 账号认证失败或目录无读写权限，请检查用户名和应用密码');
        if (response.status >= 300 && response.status < 400) throw new SyncError('WebDAV 地址发生重定向，请填写最终服务地址（包括末尾 /）');
        if (response.status === 412) throw new SyncError('云端档案在同步期间发生变化，请重新同步；当前档案已保留');
        if (response.status === 507) throw new SyncError('WebDAV 存储空间或上传流量不足');
        throw new SyncError(`WebDAV ${method} 失败（HTTP ${response.status}）`);
      }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new SyncError('WebDAV 返回的文件过大'); }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > limit) throw new SyncError('WebDAV 返回的文件过大');
            chunks.push(Buffer.from(next.value));
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      }
      return { status: response.status, etag: response.headers.get('etag'), body: Buffer.concat(chunks, size) };
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (signal.aborted) throw new SyncError(this.signal?.aborted ? '同步已停止' : 'WebDAV 请求超时，稍后会自动重试');
      throw new SyncError('无法连接 WebDAV，请检查服务地址、网络、代理或证书');
    }
  }

  request(name, method, options) {
    return this.requestUrl(this.requestPath(name), method, options);
  }

  async ensureFolder() {
    let url = this.config.endpoint;
    for (const segment of this.config.folder.split('/')) {
      url = new URL(`${encodeURIComponent(segment)}/`, url).href;
      await this.requestUrl(url, 'MKCOL', { accept: [201, 405], limit: 64 * 1024 });
    }
  }

  async list() {
    return (await this.entries()).filter((entry) => !entry.directory).map((entry) => entry.name.match(HEAD_NAME)?.[1]).filter(Boolean);
  }

  async entries(folder = '') {
    const url = folder ? new URL(`${folder}/`, this.root).href : this.root;
    if (folder) this.requestPath(folder);
    const result = await this.requestUrl(url, 'PROPFIND', { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', accept: [207, 404], limit: 4 * 1024 * 1024 });
    return result.status === 404 ? [] : parseDirectory(result.body.toString('utf8'), url);
  }

  requestPath(name) {
    if (typeof name !== 'string' || name.length > 1024 || name.split('/').some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9.-]+$/.test(part))) throw new SyncError('无效的同步文件名');
    return new URL(name, this.root).href;
  }

  mkdir(folder) {
    return this.requestUrl(`${this.requestPath(folder)}/`, 'MKCOL', { accept: [201, 405], limit: 64 * 1024 });
  }

  async ensureCollections(folder) {
    const parts = folder.split('/');
    for (let n = 1; n <= parts.length; n++) await this.mkdir(parts.slice(0, n).join('/'));
  }

  get(name, etag, limit) { return this.request(name, 'GET', { headers: etag ? { 'If-None-Match': etag } : {}, accept: [200, 304, 404], limit }); }
  put(name, body, headers = {}) { return this.request(name, 'PUT', { body, headers: { 'Content-Type': 'application/json', ...headers }, limit: 64 * 1024 }); }
  remove(name) { return this.request(name, 'DELETE', { accept: [200, 204, 404], limit: 64 * 1024 }); }
}

module.exports = { WebDavClient, normalizeConfig, parseListing, parseDirectory, HEAD_NAME, BLOB_NAME, SOURCE_ID };
