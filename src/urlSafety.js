// Guards the verifier against SSRF: only public http(s) URLs may be opened.
import dns from 'node:dns/promises';
import net from 'node:net';

export class UnsafeUrlError extends Error {}

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
]) blockList.addSubnet(addr, prefix, 'ipv6');

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockList.check(mapped[1], 'ipv4');
    return blockList.check(ip, 'ipv6');
  }
  return blockList.check(ip, 'ipv4');
}

/** Syntax checks only (no DNS). Returns a URL object. */
export function parsePublicUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new UnsafeUrlError('Not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
  if (String(input).length > 2048) throw new UnsafeUrlError('URL is too long');
  return url;
}

/**
 * Throws UnsafeUrlError unless the URL is http(s) and its host resolves only
 * to public IPs. `lookup` is injectable for tests.
 */
export async function assertPublicUrl(input, { allowPrivate = false, lookup = dns.lookup } = {}) {
  const url = parsePublicUrl(input);
  if (allowPrivate) return url;
  await assertPublicHost(url.hostname, { lookup });
  return url;
}

export async function assertPublicHost(hostname, { lookup = dns.lookup } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('Local hosts are not allowed');
  }
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address); }
    catch { throw new UnsafeUrlError(`Could not resolve ${host}`); }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) throw new UnsafeUrlError('URL points to a private or reserved address');
}
