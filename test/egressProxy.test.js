import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startEgressProxy } from '../src/verifier/egressProxy.js';

// "rebind.test" pretends to be a public name that resolves to loopback.
const lookup = async (host) => (host === 'rebind.test' ? [{ address: '127.0.0.1' }] : [{ address: '10.0.0.7' }]);

test('plain http through the proxy to a private address is blocked', async (t) => {
  const proxy = await startEgressProxy({ lookup });
  t.after(() => proxy.close());
  const { port } = new URL(proxy.server);
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: 'http://rebind.test/secret', headers: { host: 'rebind.test' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.deepEqual(proxy.blocked, ['rebind.test']);
});

test('CONNECT tunnels to private addresses are refused', async (t) => {
  const proxy = await startEgressProxy({ lookup });
  t.after(() => proxy.close());
  const { port } = new URL(proxy.server);
  for (const target of ['rebind.test:443', 'internal.test:443', '169.254.169.254:80', '[::1]:443']) {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(Number(port), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let data = '';
      s.on('data', (d) => { data += d; });
      s.on('end', () => resolve(data));
      s.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/, target);
  }
});
