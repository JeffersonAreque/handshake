// A tiny local HTTP/HTTPS proxy that Chromium is forced through while it
// opens a submitted URL. Every connection (first page, redirects, images,
// scripts, iframes) is resolved here, rejected if any address is private,
// and connected to the exact IP that was checked, so DNS rebinding can't
// switch it to an internal address afterwards.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateIp } from '../urlSafety.js';

async function resolvePublic(host, lookup) {
  host = host.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateIp)) throw new Error(`Blocked: ${host} resolves to a private address`);
  return addresses.find((a) => net.isIPv4(a)) ?? addresses[0];
}

export function startEgressProxy({ lookup = dns.lookup, log = () => {} } = {}) {
  const blocked = [];
  const block = (host, err) => { if (blocked.length < 50) blocked.push(host); log(err.message); };

  const server = http.createServer(async (req, res) => {
    // Plain-http proxying: req.url is absolute.
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (target.protocol !== 'http:') { res.writeHead(400).end(); return; }
    let ip;
    try { ip = await resolvePublic(target.hostname, lookup); } catch (err) { block(target.hostname, err); res.writeHead(403).end('Blocked by Handshake verifier'); return; }
    const upstream = http.request(
      { host: ip, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host }, setHost: false },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }
    );
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  server.on('connect', async (req, socket, head) => {
    // HTTPS tunnelling: "CONNECT host:port". TLS stays end to end.
    socket.on('error', () => {});
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
    if (!m) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    let ip;
    try { ip = await resolvePublic(m[1], lookup); } catch (err) { block(m[1], err); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(Number(m[2]), ip, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server: `http://127.0.0.1:${port}`,
        blocked,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
