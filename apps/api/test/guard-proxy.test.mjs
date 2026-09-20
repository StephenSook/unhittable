// The fence that actually holds. Everything here exists because an
// application-level allowlist cannot stop DNS rebinding: the check and the
// connection happen in different resolvers at different moments, and the
// attacker controls what the second one is told.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGuardProxy, resolveSafely, ALLOWED_PORTS } from '../src/guard-proxy.js';

const asLookup = (...addresses) => async () => addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
const permissive = () => null;

test('a private literal never reaches a resolver', async () => {
  const never = async () => { throw new Error('the resolver must not be consulted'); };
  await assert.rejects(resolveSafely('127.0.0.1', never), /loopback/);
  await assert.rejects(resolveSafely('169.254.169.254', never), /metadata/);
  await assert.rejects(resolveSafely('[::1]', never), /loopback/);
  assert.equal(await resolveSafely('93.184.216.34', never), '93.184.216.34');
});

test('machine-local names are refused by name', async () => {
  const never = async () => { throw new Error('must not resolve'); };
  await assert.rejects(resolveSafely('localhost', never), /machine-local/);
  await assert.rejects(resolveSafely('metadata.google.internal', never), /machine-local/);
  await assert.rejects(resolveSafely('db.internal', never), /machine-local/);
});

test('THE REBINDING CASE: a pleasant name resolving privately is refused', async () => {
  await assert.rejects(resolveSafely('totally-fine.example.com', asLookup('127.0.0.1')),
    /resolves to 127\.0\.0\.1, which is loopback/);
  await assert.rejects(resolveSafely('ok.example.com', asLookup('169.254.169.254')), /metadata/);
  // One bad record among good ones sinks the host: that shape IS the attack.
  await assert.rejects(resolveSafely('mixed.example.com', asLookup('93.184.216.34', '10.0.0.5')),
    /10\.0\.0\.5/);
});

test('THE STRUCTURAL FIX: exactly one lookup happens per connection', async () => {
  // This is the property that makes rebinding impossible rather than
  // unlikely. If the proxy looked up twice, or if it handed a NAME to the
  // socket layer for a second resolution, an attacker could answer the two
  // differently. It resolves once and connects to that address.
  let calls = 0;
  const counting = async () => { calls++; return [{ address: '93.184.216.34', family: 4 }]; };
  const ip = await resolveSafely('example.com', counting);
  assert.equal(calls, 1, 'resolveSafely must consult DNS exactly once');
  assert.ok(net.isIP(ip), 'and must return an ADDRESS, never a name, so no second lookup can occur');
});

test('only ordinary web ports are tunnelled', async () => {
  assert.deepEqual([...ALLOWED_PORTS].sort((a, b) => a - b), [80, 443, 8080, 8443]);
  const proxy = createGuardProxy({ lookup: asLookup('93.184.216.34'), addressPolicy: permissive });
  const url = await proxy.listen();
  const port = Number(new URL(url).port);

  const tryConnect = (hostPort) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', () => resolve('ERROR'));
    setTimeout(() => { s.destroy(); resolve(buf.split('\r\n')[0] || 'TIMEOUT'); }, 3000);
  });

  assert.match(await tryConnect('example.com:22'), /403/, 'SSH must be refused');
  assert.match(await tryConnect('example.com:6379'), /403/, 'Redis must be refused');
  await proxy.close();
});

test('a blocked host is refused and the reason is recorded', async () => {
  const proxy = createGuardProxy({ lookup: asLookup('10.0.0.7') });
  const url = await proxy.listen();
  const port = Number(new URL(url).port);

  const line = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', () => resolve('ERROR'));
    setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 3000);
  });
  assert.match(line, /403/);
  assert.equal(proxy.blocked.length, 1);
  assert.match(proxy.blocked[0].why, /10\.0\.0\.7/);
  await proxy.close();
});

test('the tunnel actually carries traffic when the address is allowed', async () => {
  // The other half: a fence that refuses everything is not a fence, it is an
  // outage. addressPolicy is relaxed here so a loopback fixture can stand in
  // for a public host; the next test proves the DEFAULT does not do that.
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`served ${req.headers.host}${req.url}`);
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;

  // The fixture binds an ephemeral port, which the shipped fence correctly
  // refuses. The first version of this test did not account for that and
  // failed against working code. The port set is injected here and the
  // default is asserted separately above.
  const proxy = createGuardProxy({
    lookup: asLookup('127.0.0.1'),
    addressPolicy: permissive,
    allowedPorts: new Set([originPort]),
  });
  const proxyUrl = await proxy.listen();
  const pPort = Number(new URL(proxyUrl).port);

  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: pPort, method: 'GET',
      path: `http://fixture.example.com:${originPort}/hello`,
      headers: { host: `fixture.example.com:${originPort}` },
    }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); });
    req.on('error', reject);
    req.end();
  });
  // The Host header must survive, or virtual hosting breaks for every site
  // sharing an address.
  assert.match(body, /served fixture\.example\.com/);
  await proxy.close();
  await new Promise((r) => origin.close(r));
});

test('THE DEFAULT POLICY IS STRICT: no injection means loopback is refused', async () => {
  // The relaxation above is acceptable only because of this.
  const proxy = createGuardProxy({ lookup: asLookup('127.0.0.1') });
  const url = await proxy.listen();
  const port = Number(new URL(url).port);
  const line = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT anything.example.com:443 HTTP/1.1\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', () => resolve('ERROR'));
    setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 3000);
  });
  assert.match(line, /403/, 'the shipped default must refuse a host that resolves to loopback');
  await proxy.close();
});

test('the proxy binds to loopback only, never to an external interface', async () => {
  const proxy = createGuardProxy();
  const url = await proxy.listen();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(proxy.server.address().address, '127.0.0.1');
  await proxy.close();
});
