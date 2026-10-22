'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

async function mockWebDav(t) {
  const files = new Map();
  const folders = new Set(['/dav/']);
  const requests = [];
  const fixture = { files, folders, requests, fault: null, ignoreConditions: false, noEtags: false };
  const auth = `Basic ${Buffer.from('sync-user:app-password-for-tests').toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const record = { method: req.method, path: pathname, bytes: body.length, condition: req.headers['if-none-match'] || req.headers['if-match'] };
    requests.push(record);
    const reply = (status, content = '', headers = {}) => { record.status = status; res.writeHead(status, headers); res.end(content); };
    if (req.headers.authorization !== auth) return reply(401);
    const fault = await fixture.fault?.({ method: req.method, path: pathname, body });
    if (fault?.status) return reply(fault.status);
    if (req.method === 'MKCOL') {
      if (folders.has(pathname)) return reply(405);
      if (!folders.has(pathname.replace(/[^/]+\/$/, ''))) return reply(409);
      folders.add(pathname); return reply(201);
    }
    if (req.method === 'PROPFIND') {
      if (!folders.has(pathname)) return reply(404);
      const childFiles = [...files.keys()].filter((file) => file.startsWith(pathname) && !file.slice(pathname.length).includes('/'));
      const childFolders = [...folders].filter((folder) => folder !== pathname && folder.startsWith(pathname) && !folder.slice(pathname.length).replace(/\/$/, '').includes('/'));
      return reply(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${[pathname, ...childFolders, ...childFiles].map((file) => `<D:response><D:href>${file.replaceAll('&', '&amp;')}</D:href><D:propstat><D:prop><D:resourcetype>${folders.has(file) ? '<D:collection/>' : ''}</D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}</D:multistatus>`, { 'Content-Type': 'application/xml' });
    }
    const old = files.get(pathname);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!old) return reply(404);
      if (req.headers['if-none-match'] === old.etag) return reply(304);
      return reply(200, req.method === 'HEAD' ? '' : old.body, { ...(!fixture.noEtags ? { ETag: old.etag } : {}), 'Content-Length': old.body.length });
    }
    if (req.method === 'PUT') {
      if (!folders.has(pathname.replace(/[^/]+$/, ''))) return reply(409);
      if (!fixture.ignoreConditions && ((req.headers['if-none-match'] === '*' && old) || (req.headers['if-match'] && req.headers['if-match'] !== old?.etag))) return reply(412);
      const etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
      files.set(pathname, { body, etag });
      if (fault?.disconnectAfterCommit) { req.socket.destroy(); return; }
      return reply(old ? 204 : 201, '', !fixture.noEtags ? { ETag: etag } : {});
    }
    if (req.method === 'DELETE') { files.delete(pathname); return reply(old ? 204 : 404); }
    return reply(405);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.endpoint = `http://127.0.0.1:${server.address().port}/dav/`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return fixture;
}

module.exports = { mockWebDav };
