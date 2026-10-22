'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT = 'quotadesk-encrypted-usage';
const MAX_PLAIN_BYTES = 256 * 1024 * 1024;
const MAX_CIPHER_BYTES = 64 * 1024 * 1024;
const MAX_WIRE_BYTES = 90 * 1024 * 1024;
const AAD = Buffer.from(`${FORMAT}:1:scrypt-32768-8-1:aes-256-gcm:gzip`);

class SyncError extends Error {}

function decode(value, length, max = length) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new SyncError('云端加密文件格式无效');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < length || bytes.length > max || bytes.toString('base64') !== value) throw new SyncError('云端加密文件格式无效');
  return bytes;
}

async function keyFor(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 6 || passphrase.length > 1024) throw new SyncError('同步加密口令需要 6–1024 个字符，两台设备必须填写相同口令');
  return scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function encrypt(value, passphrase) {
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > MAX_PLAIN_BYTES) throw new SyncError('本机档案超过 256 MB，暂不支持上传此档案');
  const compressed = await gzip(plain);
  if (compressed.length > MAX_CIPHER_BYTES) throw new SyncError('压缩后的档案超过 64 MB，暂不支持上传此档案');
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const key = await keyFor(passphrase, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    return Buffer.from(JSON.stringify({ format: FORMAT, version: 1, kdf: 'scrypt-32768-8-1',
      salt: salt.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  } finally { key.fill(0); }
}

async function decrypt(wire, passphrase) {
  if (!Buffer.isBuffer(wire)) wire = Buffer.from(wire);
  if (wire.length > MAX_WIRE_BYTES) throw new SyncError('云端加密文件过大');
  let envelope;
  try { envelope = JSON.parse(wire.toString('utf8')); } catch { throw new SyncError('云端加密文件不是完整的 JSON'); }
  if (envelope?.format !== FORMAT || envelope.version !== 1 || envelope.kdf !== 'scrypt-32768-8-1') throw new SyncError('不支持的云端加密格式，请检查同步目录或升级应用');
  const salt = decode(envelope.salt, 16), nonce = decode(envelope.nonce, 12), tag = decode(envelope.tag, 16);
  const ciphertext = decode(envelope.ciphertext, 1, MAX_CIPHER_BYTES);
  const key = await keyFor(passphrase, salt);
  let compressed;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new SyncError('无法解密云端档案：加密口令不同，或文件已损坏。未覆盖云端档案'); }
  finally { key.fill(0); }
  try { return JSON.parse((await gunzip(compressed, { maxOutputLength: MAX_PLAIN_BYTES })).toString('utf8')); }
  catch { throw new SyncError('云端档案内容损坏或解压后超过 256 MB'); }
}

module.exports = { encrypt, decrypt, SyncError, MAX_WIRE_BYTES };
