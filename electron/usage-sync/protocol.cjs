'use strict';

// Append-only publication: each device/month gets unique blobs and commit files.
// No mutable "latest" index, conditional PUT, ETag, or cross-device overwrite.
const crypto = require('node:crypto');
const { encrypt, decrypt, SyncError, MAX_WIRE_BYTES } = require('./crypto.cjs');
const { HEAD_NAME, BLOB_NAME, SOURCE_ID } = require('./webdav.cjs');
const KEY_FILE = 'sync-key.json';
const COMMIT_NAME = new RegExp(`^r([1-9][0-9]{0,15})\\.(${SOURCE_ID})\\.commit\\.json$`);
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const isId = (id) => HEAD_NAME.test(`${id}.json`);
class SnapshotError extends SyncError {}

async function mapLimit(values, action) {
  let next = 0;
  const result = new Array(values.length);
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await action(values[index]); }
  }));
  const failure = settled.find((item) => item.status === 'rejected');
  if (failure) throw failure.reason;
  return result;
}

async function discover(dav) {
  const root = await dav.entries();
  const sources = new Map();
  let hasArtifacts = root.some((e) => !e.directory && BLOB_NAME.test(e.name));
  const source = (id) => {
    if (!sources.has(id)) sources.set(id, { sourceId: id, entries: [] });
    if (sources.size > 256) throw new SyncError('同步目录超过 256 个来源，请使用独立目录');
    return sources.get(id);
  };
  for (const entry of root) {
    const id = !entry.directory && entry.name.match(HEAD_NAME)?.[1];
    if (id) { source(id).legacy = entry.name; hasArtifacts = true; }
  }
  if (root.some((e) => e.directory && e.name === 'v2')) {
    const devices = (await dav.entries('v2')).filter((e) => e.directory && isId(e.name));
    if (devices.length > 256) throw new SyncError('同步目录超过 256 个来源，请使用独立目录');
    const months = (await mapLimit(devices, async (device) => (await dav.entries(`v2/${device.name}`))
      .filter((e) => e.directory && MONTH.test(e.name)).map((m) => ({ folder: `v2/${device.name}/${m.name}`, sourceId: device.name })))).flat();
    await mapLimit(months, async ({ folder, sourceId }) => {
      const files = await dav.entries(folder);
      if (files.some((e) => !e.directory && /\.(?:snapshot|commit)\.json$/.test(e.name))) hasArtifacts = true;
      for (const file of files) {
        const match = !file.directory && file.name.match(COMMIT_NAME);
        if (!match) continue;
        const revision = Number(match[1]);
        if (!Number.isSafeInteger(revision)) throw new SyncError('云端档案版本号无效');
        source(sourceId).entries.push({ sourceId, revision, path: `${folder}/${file.name}`, blob: `${folder}/r${revision}.${match[2]}.snapshot.json` });
      }
    });
  }
  return { sources, hasArtifacts };
}

async function ensureKey(dav, catalog, passphrase) {
  let result = await dav.get(KEY_FILE, null, 64 * 1024);
  if (result.status === 404) {
    if (catalog.hasArtifacts) throw new SyncError('云端加密校验文件缺失，但目录已有档案；请恢复 sync-key.json 或使用新的空目录');
    // MKCOL creates a collection atomically. Only its creator initializes the
    // write-once key; other devices wait for it and never overwrite the key.
    const claim = await dav.mkdir('key-init');
    result = await dav.get(KEY_FILE, null, 64 * 1024);
    if (result.status === 404 && claim.status === 201) {
      const wire = await encrypt({ kind: 'key', version: 1, vaultId: crypto.randomUUID() }, passphrase);
      try { await dav.put(KEY_FILE, wire); }
      catch (error) { result = await dav.get(KEY_FILE, null, 64 * 1024); if (result.status !== 200) throw error; }
      result = await dav.get(KEY_FILE, null, 64 * 1024);
    }
    for (let n = 0; result.status === 404 && n < 10; n++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      result = await dav.get(KEY_FILE, null, 64 * 1024);
    }
    if (result.status !== 200) throw new SyncError('同步目录初始化尚未完成，请稍后重试；若持续失败，请使用新的空目录');
  }
  const key = await decrypt(result.body, passphrase);
  if (key?.kind !== 'key' || key.version !== 1 || !isId(key.vaultId)) throw new SyncError('云端加密校验文件无效');
  return key.vaultId;
}

function validateHead(value, sourceId, vaultId, entry) {
  if (value?.kind !== 'head' || value.version !== (entry ? 2 : 1) || value.vaultId !== vaultId || value.sourceId !== sourceId
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !/^[a-f0-9]{64}$/.test(value.dataHash || '')
    || (entry ? value.revision !== entry.revision || value.blob !== entry.blob : typeof value.blob !== 'string' || !BLOB_NAME.test(value.blob) || !value.blob.startsWith(`${sourceId}.`))) throw new SnapshotError('云端来源索引校验失败，已保留本地档案');
  return { ...value, path: entry?.path || `${sourceId}.json` };
}

async function readPublished(dav, source, vaultId, passphrase) {
  const heads = [], errors = [];
  if (source.legacy) {
    const response = await dav.get(source.legacy, null, 64 * 1024);
    if (response.status === 200) heads.push(validateHead(await decrypt(response.body, passphrase), source.sourceId, vaultId));
  }
  const revision = [...source.entries, ...heads].reduce((highest, item) => Math.max(highest, item.revision), 0);
  const entries = source.entries.filter((e) => e.revision === revision).sort((a, b) => a.path.localeCompare(b.path));
  await mapLimit(entries, async (entry) => {
    try {
      const response = await dav.get(entry.path, null, 64 * 1024);
      if (response.status !== 200) throw new SnapshotError('云端快照发布尚未完成，已保留本地档案，稍后会重试');
      let value;
      try { value = await decrypt(response.body, passphrase); } catch (error) { throw new SnapshotError(error.message); }
      heads.push(validateHead(value, source.sourceId, vaultId, entry));
    } catch (error) { errors.push(error); }
  });
  const current = heads.filter((h) => h.revision === revision).sort((a, b) => b.path.localeCompare(a.path));
  if (new Set(current.map((h) => h.dataHash)).size > 1) throw new SyncError('同一来源的相同版本存在内容冲突，已停止更新；请检查是否复制了设备档案库');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([entries.map((e) => e.path), current.map((h) => [h.path, h.revision, h.dataHash])])).digest('hex');
  return { revision, heads: current, fingerprint, complete: errors.length === 0, error: errors[0] || new SnapshotError('云端快照暂不可用，已保留本地档案，稍后会重试') };
}

async function loadSnapshot(dav, published, vaultId, passphrase, validate) {
  let failure;
  for (const head of published.heads) {
    try {
      const response = await dav.get(head.blob);
      if (response.status !== 200) throw new SnapshotError('云端快照暂不可用，已保留本地档案，稍后会重试');
      let snapshot;
      try { snapshot = await decrypt(response.body, passphrase); } catch (error) { throw new SnapshotError(error.message); }
      const origin = snapshot?.payload?.archives?.[0];
      if (snapshot?.kind !== 'snapshot' || snapshot.vaultId !== vaultId || snapshot.payload?.archives?.length !== 1 || origin?.sourceId !== head.sourceId || origin.revision !== head.revision || origin.dataHash !== head.dataHash) throw new SnapshotError('云端快照与完成标记不一致，已保留本地档案');
      let plan;
      try { plan = await validate(snapshot.payload); } catch { throw new SnapshotError('云端用量档案完整性校验失败，已保留本地档案'); }
      return { payload: snapshot.payload, plan };
    } catch (error) { failure ??= error; }
  }
  throw failure || published.error;
}

async function putVerified(dav, name, wire, limit) {
  await dav.put(name, wire);
  const response = await dav.get(name, null, limit);
  if (response.status !== 200 || !response.body.equals(wire)) throw new SnapshotError('云端文件写入校验失败，已保留此前的完整档案，请重试');
}

async function publish(dav, payload, vaultId, passphrase, now) {
  const local = payload.archives[0];
  const folder = `v2/${local.sourceId}/${new Date(now).toISOString().slice(0, 7)}`;
  await dav.ensureCollections(folder);
  const prefix = `${folder}/r${local.revision}.${crypto.randomUUID()}`;
  const blob = `${prefix}.snapshot.json`;
  await putVerified(dav, blob, await encrypt({ kind: 'snapshot', vaultId, payload }, passphrase), MAX_WIRE_BYTES);
  const head = { kind: 'head', version: 2, vaultId, sourceId: local.sourceId, revision: local.revision, dataHash: local.dataHash, blob };
  // Publication is last. On an ambiguous PUT keep both files; retry discovers
  // a committed version, while a failed publication cannot affect older files.
  await putVerified(dav, `${prefix}.commit.json`, await encrypt(head, passphrase), 64 * 1024);
  return head;
}

module.exports = { discover, ensureKey, readPublished, loadSnapshot, publish, SnapshotError };
