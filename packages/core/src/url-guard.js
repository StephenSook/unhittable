// url-guard.js - refuse to fetch anything that is not a public web page.
//
// This service takes a URL from a stranger and loads it in a real browser on
// our infrastructure. That is a server-side request forgery primitive unless
// it is fenced, and the fence has to be in front of the browser rather than
// behind it: by the time a page has loaded, a request to a cloud metadata
// endpoint has already happened.
//
// Two rules that decide whether a guard like this actually works:
//
//   1. Validate the RESOLVED ADDRESS, never the hostname. A name you control
//      can point anywhere, so `evil.example.com A 127.0.0.1` walks straight
//      through a hostname allowlist.
//   2. Re-validate on every hop. A public host that answers 302 to
//      http://169.254.169.254/ defeats a check performed only on the URL the
//      user typed.
//
// The address arithmetic is pure and lives here so it can be tested without a
// network, and the DNS-dependent part is a thin separate function.

/** Parse and sanity-check a user-supplied URL. Throws with a usable message. */
export function normaliseTargetUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Enter a URL.');
  }
  let input = raw.trim();
  // Accept "example.com" the way a browser address bar would.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) input = 'https://' + input;

  let u;
  try { u = new URL(input); } catch { throw new Error(`That is not a URL I can parse: ${raw}`); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http and https are supported, not ${u.protocol.replace(':', '')}.`);
  }
  if (u.username || u.password) {
    throw new Error('Credentials in the URL are not accepted.');
  }
  if (!u.hostname) throw new Error('That URL has no host.');
  // A bare host with no dot is either a local machine name or a search term.
  if (!u.hostname.includes('.') && !isIpLiteral(u.hostname)) {
    throw new Error(`"${u.hostname}" is not a public host name.`);
  }
  u.hash = '';
  return u;
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);
}

/** Host names that resolve to infrastructure regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain',
  'metadata', 'metadata.google.internal', 'metadata.goog',
  'instance-data', 'instance-data.ec2.internal',
]);

export function isBlockedHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  // Anything inside a private or machine-local zone.
  return /\.(local|localhost|internal|intranet|lan|home|corp|localdomain)$/.test(h);
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

// Every IPv4 range that is not a public host, with the reason it is here.
const V4_BLOCKS = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local, includes the cloud metadata endpoint'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
].map(([base, bits, why]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0, why }));

/**
 * Is this literal address one we refuse to connect to?
 * Returns null when the address is acceptable, or the reason when it is not.
 */
export function blockedAddressReason(addr) {
  if (typeof addr !== 'string' || !addr) return 'not an address';
  let a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);

  // An IPv4-mapped or IPv4-compatible IPv6 address must be judged as the IPv4
  // address it carries, or ::ffff:127.0.0.1 is a loopback that looks like v6.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a) || /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return blockedAddressReason(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return blockedAddressReason(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (a.includes(':')) {
    if (a === '::' ) return 'unspecified address';
    if (a === '::1') return 'IPv6 loopback';
    const head = a.split(':')[0];
    const n = parseInt(head || '0', 16);
    if (Number.isNaN(n)) return 'unparseable IPv6 address';
    if ((n & 0xfe00) === 0xfc00) return 'IPv6 unique local address';
    if ((n & 0xffc0) === 0xfe80) return 'IPv6 link-local';
    if ((n & 0xff00) === 0xff00) return 'IPv6 multicast';
    if (a.startsWith('2001:db8')) return 'IPv6 documentation range';
    if (a.startsWith('64:ff9b:')) return 'NAT64 translation range';
    return null;
  }

  const v = ipv4ToInt(a);
  if (v === null) return 'unparseable IPv4 address';
  if (v === 0xffffffff) return 'broadcast address';
  for (const b of V4_BLOCKS) {
    if ((v & b.mask) >>> 0 === b.base) return b.why;
  }
  return null;
}

/**
 * Full check for one hop. `resolve` is injected so this is testable without a
 * network and so the caller can supply a resolver with a timeout.
 *
 * @param {URL|string} url
 * @param {(hostname: string) => Promise<string[]>} resolve
 */
export async function assertFetchable(url, resolve) {
  const u = url instanceof URL ? url : normaliseTargetUrl(url);

  if (isBlockedHostname(u.hostname)) {
    throw new Error(`Refusing to load ${u.hostname}: that name is machine-local, not a public site.`);
  }

  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(u.hostname)) {
    const why = blockedAddressReason(bare);
    if (why) throw new Error(`Refusing to load ${u.hostname}: ${why}.`);
    return u;
  }

  let addresses;
  try {
    addresses = await resolve(u.hostname);
  } catch (e) {
    throw new Error(`Could not resolve ${u.hostname}.`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`${u.hostname} does not resolve to any address.`);
  }
  // EVERY address must be acceptable. A host with one public and one private
  // record is a rebinding attempt, not a lucky coincidence.
  for (const a of addresses) {
    const why = blockedAddressReason(a);
    if (why) throw new Error(`Refusing to load ${u.hostname}: it resolves to ${a}, which is ${why}.`);
  }
  return u;
}
