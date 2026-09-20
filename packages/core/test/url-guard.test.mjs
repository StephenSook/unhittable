// A guard is only evidence if it can be shown to FIRE. Every acceptance case
// below is paired with a rejection case that differs by as little as possible,
// so a guard that silently accepted everything would fail this file rather
// than pass it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseTargetUrl, isBlockedHostname, blockedAddressReason, assertFetchable,
} from '../src/url-guard.js';

const never = async () => { throw new Error('resolver must not be called'); };
const resolvesTo = (...addrs) => async () => addrs;

test('a bare host is treated the way an address bar would treat it', () => {
  assert.equal(normaliseTargetUrl('example.com').href, 'https://example.com/');
  assert.equal(normaliseTargetUrl('  https://example.com/a?b=1  ').href, 'https://example.com/a?b=1');
  assert.equal(normaliseTargetUrl('http://example.com/#frag').hash, '', 'the fragment never reaches the server');
});

test('non-web schemes are refused by name', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com/', 'data:text/html,hi']) {
    assert.throws(() => normaliseTargetUrl(bad), /Only http and https/, `${bad} should be refused`);
  }
  // javascript: has no host, so it fails earlier, but it must still fail.
  assert.throws(() => normaliseTargetUrl('javascript:alert(1)'));
});

test('credentials in the URL are refused', () => {
  assert.throws(() => normaliseTargetUrl('https://user:pw@example.com/'), /Credentials/);
  assert.throws(() => normaliseTargetUrl('https://user@example.com/'), /Credentials/);
});

test('empty and unparseable input is refused with a usable message', () => {
  assert.throws(() => normaliseTargetUrl(''), /Enter a URL/);
  assert.throws(() => normaliseTargetUrl('   '), /Enter a URL/);
  assert.throws(() => normaliseTargetUrl(null), /Enter a URL/);
  assert.throws(() => normaliseTargetUrl('https://'), /not a URL I can parse|no host/);
});

test('a dotless host is refused, because it is a machine name or a typo', () => {
  assert.throws(() => normaliseTargetUrl('http://intranet/'), /not a public host name/);
  assert.throws(() => normaliseTargetUrl('localhost'), /not a public host name/);
  // but an IP literal has no dots requirement problem
  assert.doesNotThrow(() => normaliseTargetUrl('http://93.184.216.34/'));
});

test('machine-local names are blocked whatever DNS would say', () => {
  for (const h of ['localhost', 'LOCALHOST', 'metadata.google.internal', 'metadata',
                   'instance-data', 'printer.local', 'db.internal', 'host.lan', 'x.corp']) {
    assert.equal(isBlockedHostname(h), true, `${h} should be blocked`);
  }
  for (const h of ['example.com', 'www.google.com', 'internal-affairs.org', 'localhostess.co']) {
    assert.equal(isBlockedHostname(h), false, `${h} should be allowed`);
  }
});

test('every reserved IPv4 range is recognised, and public addresses are not', () => {
  const blocked = {
    '0.0.0.0': /this network/,
    '10.1.2.3': /private/,
    '100.64.0.1': /carrier-grade NAT/,
    '127.0.0.1': /loopback/,
    '169.254.169.254': /metadata/,          // the one that matters
    '172.16.0.1': /private/,
    '172.31.255.255': /private/,
    '192.168.1.1': /private/,
    '198.18.0.1': /benchmarking/,
    '224.0.0.1': /multicast/,
    '255.255.255.255': /broadcast/,
  };
  for (const [ip, why] of Object.entries(blocked)) {
    assert.match(String(blockedAddressReason(ip)), why, `${ip} should be blocked`);
  }
  // Addresses immediately OUTSIDE the private blocks must pass, which is what
  // proves the masks are the right width rather than merely wide.
  for (const ip of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0',
                    '192.167.255.255', '192.169.0.0', '126.255.255.255', '128.0.0.1',
                    '93.184.216.34', '8.8.8.8']) {
    assert.equal(blockedAddressReason(ip), null, `${ip} should be allowed`);
  }
});

test('IPv6 loopback, unique-local, link-local and multicast are blocked', () => {
  assert.match(String(blockedAddressReason('::1')), /loopback/);
  assert.match(String(blockedAddressReason('::')), /unspecified/);
  assert.match(String(blockedAddressReason('fc00::1')), /unique local/);
  assert.match(String(blockedAddressReason('fd12:3456::1')), /unique local/);
  assert.match(String(blockedAddressReason('fe80::1')), /link-local/);
  assert.match(String(blockedAddressReason('ff02::1')), /multicast/);
  assert.match(String(blockedAddressReason('2001:db8::1')), /documentation/);
  assert.equal(blockedAddressReason('2606:2800:220:1:248:1893:25c8:1946'), null, 'a real public v6 address');
});

test('an IPv4 address smuggled inside IPv6 is judged as the IPv4 address', () => {
  // The trick this catches: ::ffff:127.0.0.1 is loopback wearing a v6 hat.
  assert.match(String(blockedAddressReason('::ffff:127.0.0.1')), /loopback/);
  assert.match(String(blockedAddressReason('::ffff:169.254.169.254')), /metadata/);
  assert.match(String(blockedAddressReason('::ffff:7f00:1')), /loopback/, 'hex form of 127.0.0.1');
  assert.match(String(blockedAddressReason('::ffff:a9fe:a9fe')), /metadata/, 'hex form of 169.254.169.254');
  assert.match(String(blockedAddressReason('::127.0.0.1')), /loopback/, 'deprecated v4-compatible form');
  assert.equal(blockedAddressReason('::ffff:93.184.216.34'), null, 'a public v4 in v6 clothing is fine');
});

test('a bracketed or zoned address is still judged correctly', () => {
  assert.match(String(blockedAddressReason('[::1]')), /loopback/);
  assert.match(String(blockedAddressReason('fe80::1%en0')), /link-local/);
});

test('assertFetchable judges the RESOLVED address, not the pleasant name', async () => {
  // The whole point. A perfectly ordinary hostname that resolves to loopback.
  await assert.rejects(
    assertFetchable(normaliseTargetUrl('https://totally-fine.example.com/'), resolvesTo('127.0.0.1')),
    /resolves to 127\.0\.0\.1, which is loopback/,
  );
  await assert.rejects(
    assertFetchable(normaliseTargetUrl('https://ok.example.com/'), resolvesTo('169.254.169.254')),
    /metadata/,
  );
});

test('one bad record among good ones is still a rejection', async () => {
  // A rebinding attempt looks exactly like this. Any single private record
  // has to sink the whole host.
  await assert.rejects(
    assertFetchable(normaliseTargetUrl('https://mixed.example.com/'), resolvesTo('93.184.216.34', '10.0.0.5')),
    /10\.0\.0\.5/,
  );
});

test('a genuinely public host passes', async () => {
  const u = await assertFetchable(normaliseTargetUrl('https://example.com/page'), resolvesTo('93.184.216.34'));
  assert.equal(u.hostname, 'example.com');
  assert.equal(u.pathname, '/page');
});

test('an IP literal never reaches the resolver', async () => {
  // Public literal: allowed, and the resolver must not be consulted.
  const u = await assertFetchable(normaliseTargetUrl('http://93.184.216.34/'), never);
  assert.equal(u.hostname, '93.184.216.34');
  // Private literal: refused, still without a lookup.
  await assert.rejects(assertFetchable(normaliseTargetUrl('http://127.0.0.1:8080/'), never), /loopback/);
  await assert.rejects(assertFetchable(normaliseTargetUrl('http://[::1]/'), never), /loopback/);
});

test('a host that does not resolve is refused rather than attempted', async () => {
  await assert.rejects(
    assertFetchable(normaliseTargetUrl('https://nx.example.com/'), async () => []),
    /does not resolve/,
  );
  await assert.rejects(
    assertFetchable(normaliseTargetUrl('https://nx.example.com/'), async () => { throw new Error('ENOTFOUND'); }),
    /Could not resolve/,
  );
});
