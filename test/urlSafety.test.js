import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateIp, UnsafeUrlError } from '../src/urlSafety.js';

const fakeLookup = (map) => async (host) => (map[host] ?? []).map((address) => ({ address }));

test('private and reserved IPs are detected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

test('rejects non-http schemes, credentials and local hosts', async () => {
  for (const url of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://user:pw@example.com', 'http://localhost:3000', 'http://127.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data']) {
    await assert.rejects(assertPublicUrl(url, { lookup: fakeLookup({}) }), UnsafeUrlError, url);
  }
});

test('rejects hostnames that resolve to private IPs', async () => {
  const lookup = fakeLookup({ 'evil.example': ['93.184.216.34', '10.0.0.5'], 'nowhere.example': [] });
  await assert.rejects(assertPublicUrl('https://evil.example', { lookup }), UnsafeUrlError);
  await assert.rejects(assertPublicUrl('https://nowhere.example', { lookup }), UnsafeUrlError);
});

test('accepts public URLs, and private ones only when allowed', async () => {
  const lookup = fakeLookup({ 'example.com': ['93.184.216.34'] });
  assert.equal((await assertPublicUrl('https://example.com/page', { lookup })).hostname, 'example.com');
  assert.equal((await assertPublicUrl('http://localhost:3000/x', { allowPrivate: true })).port, '3000');
});
