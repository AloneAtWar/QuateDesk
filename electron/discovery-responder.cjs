const dgram = require('node:dgram');

// 局域网发现：手机 App 在 UDP 43188 上广播探测包，电脑单播回应身份与访问地址。
// 只回地址与设备身份，不携带任何配对密钥；远程查看未启用时不应答。
const DISCOVERY_PORT = 43188;
const PROBE_MAGIC = 'QD-DISCOVER';
const RESPONSE_MAGIC = 'QD-DISCOVER-R';
const PROBE_VERSION = 1;
const MAX_PACKET = 1024;

const parseProbe = (buffer) => {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_PACKET) return null;
  let packet;
  try { packet = JSON.parse(buffer.toString('utf8')); } catch { return null; }
  if (!packet || packet.m !== PROBE_MAGIC || Number(packet.v) !== PROBE_VERSION) return null;
  const nonce = String(packet.n || '').slice(0, 64);
  if (!/^[\w-]{4,64}$/.test(nonce)) return null;
  return { nonce };
};

// getPayload() 动态取当前身份信息（端口/网卡可能变化），应答器本身无需重启
function startDiscoveryResponder({ port = DISCOVERY_PORT, getPayload, onError = () => {} }) {
  if (typeof getPayload !== 'function') return Promise.reject(new Error('missing_payload_provider'));
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const fail = (error) => {
      try { socket.close(); } catch { /* already closed */ }
      reject(error);
    };
    socket.once('error', fail);
    socket.on('message', (packet, remote) => {
      const probe = parseProbe(packet);
      if (!probe) return;
      let body;
      try {
        body = JSON.stringify({ ...getPayload(), m: RESPONSE_MAGIC, v: PROBE_VERSION, n: probe.nonce });
      } catch { return; }
      socket.send(Buffer.from(body, 'utf8'), remote.port, remote.address, (error) => {
        if (error) onError(error);
      });
    });
    socket.bind(port, () => {
      socket.removeListener('error', fail);
      socket.on('error', onError);
      resolve({
        port: socket.address().port,
        close: () => new Promise((done) => socket.close(done)),
      });
    });
  });
}

module.exports = { DISCOVERY_PORT, startDiscoveryResponder };
