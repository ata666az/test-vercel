/**
 * Green Network - Vercel Edge Proxy
 * - Serves index.html at /
 * - Serves VLESS subscription at /ata
 * - Relays VLESS-over-WebSocket to target host
 * - HTTP reverse proxy fallback
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ========================== ENV ==========================
const UUID = process.env.UUID || 'd1cf4b9c-3e57-085d-b34a-797fcf601381';
const uuid = UUID.replace(/-/g, '');
const WSPATH = process.env.WSPATH || uuid.slice(0, 8);
const SUB_PATH = process.env.SUB_PATH || 'ata';
const NAME = process.env.NAME || 'VERCEL';
const DOMAIN = process.env.DOMAIN || '';
const FALLBACK_TARGET = process.env.REVERSE_PROXY_TARGET || '';

// ========================== WEBSOCKET SERVER ==========================
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let tcp = null;
  let headerBuffer = Buffer.alloc(0);
  let headerParsed = false;

  ws.on('message', (data) => {
    const buf = Buffer.from(data);

    if (!headerParsed) {
      headerBuffer = Buffer.concat([headerBuffer, buf]);
      if (headerBuffer.length < 24) return; // butuh minimal header VLESS

      const parsed = parseVlessHeader(headerBuffer);
      if (!parsed) return ws.close();

      headerParsed = true;
      const { version, host, port, payload } = parsed;

      // Kirim response VLESS (version + status 0)
      ws.send(Buffer.from([version, 0]));

      // Koneksi ke target
      tcp = net.connect({ host, port }, () => {
        if (payload.length > 0) tcp.write(payload);
      });

      tcp.on('data', (d) => {
        if (ws.readyState === ws.OPEN) ws.send(d);
      });
      tcp.on('error', () => ws.close());
      tcp.on('close', () => ws.close());
    } else if (tcp) {
      tcp.write(buf);
    }
  });

  ws.on('close', () => tcp && tcp.destroy());
  ws.on('error', () => tcp && tcp.destroy());
});

// ========================== VLESS HEADER PARSER ==========================
function parseVlessHeader(buf) {
  if (buf.length < 18) return null;
  const version = buf[0];
  const id = buf.slice(1, 17);

  // Validasi UUID
  for (let i = 0; i < 16; i++) {
    if (id[i] !== parseInt(uuid.substr(i * 2, 2), 16)) return null;
  }

  const optLen = buf[17];
  let i = 18 + optLen;
  if (buf.length < i + 4) return null;

  const port = buf.readUInt16BE(i); i += 2;
  const atyp = buf[i]; i += 1;

  let host;
  if (atyp === 1) {
    if (buf.length < i + 4) return null;
    host = buf.slice(i, i + 4).join('.');
    i += 4;
  } else if (atyp === 2) {
    const len = buf[i]; i += 1;
    if (buf.length < i + len) return null;
    host = buf.slice(i, i + len).toString();
    i += len;
  } else if (atyp === 3) {
    if (buf.length < i + 16) return null;
    const arr = [];
    for (let j = 0; j < 8; j++) arr.push(buf.readUInt16BE(i + j * 2).toString(16));
    host = arr.join(':');
    i += 16;
  } else {
    return null;
  }

  return { version, host, port, payload: buf.slice(i) };
}

// ========================== SUBSCRIPTION BUILDER ==========================
function buildSubscription(req) {
  const domain = DOMAIN || (req.headers.host || 'localhost');
  const vlessURL =
    `vless://${UUID}@${domain}:443` +
    `?encryption=none&security=tls&sni=${domain}` +
    `&fp=chrome&type=ws&host=${domain}` +
    `&path=%2F${WSPATH}#${NAME}`;
  return Buffer.from(vlessURL).toString('base64');
}

// ========================== HTTP REVERSE PROXY ==========================
async function reverseProxy(req, res, targetOrigin) {
  try {
    const target = new URL(targetOrigin);
    const targetUrl = new URL(req.url, target);

    const headers = { ...req.headers };
    delete headers.host;
    headers.host = target.host;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-real-ip'] = req.headers['x-forwarded-for'] || '';

    const resp = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      redirect: 'manual',
    });

    res.statusCode = resp.status;
    resp.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader('x-proxy-by', 'GreenNetwork-Vercel');

    const arrayBuffer = await resp.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    res.statusCode = 502;
    res.end(`Proxy Error: ${err.message}`);
  }
}

// ========================== MAIN HANDLER ==========================
module.exports = async (req, res) => {
  const url = req.url || '/';

  // 1. Root → serve index.html
  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(html);
    } catch {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<h1>Green Network Edge</h1><p>Proxy aktif.</p>');
    }
  }

  // 2. Subscription
  if (url === `/${SUB_PATH}` || url === `/${UUID}`) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(buildSubscription(req) + '\n');
  }

  // 3. WebSocket upgrade (VLESS)
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    // Cek path harus mengandung WSPATH
    if (!url.includes(WSPATH)) {
      res.statusCode = 404;
      return res.end('Not Found');
    }
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  // 4. Fallback: HTTP reverse proxy
  if (FALLBACK_TARGET) {
    return reverseProxy(req, res, FALLBACK_TARGET);
  }

  res.statusCode = 404;
  res.end('Not Found');
};

// Disable body parsing agar raw stream bisa diteruskan
module.exports.config = {
  api: { bodyParser: false },
};
