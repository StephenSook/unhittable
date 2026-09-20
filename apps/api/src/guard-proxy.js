// guard-proxy.js - close the gap between checking an address and connecting to it.
//
// THE HOLE THIS FIXES. The scanner used to validate a hostname with Node's
// resolver and then call route.continue(), letting Chromium resolve the same
// name again and connect on its own. Those are two separate lookups, so an
// attacker running their own DNS server can answer the first with a public
// address and the second with 127.0.0.1, a private range, or the cloud
// metadata endpoint. That is DNS rebinding, and an application-level
// allowlist cannot prevent it, because the check and the connection are
// performed by different resolvers at different moments.
//
// THE FIX. Chromium is pointed at this proxy, which is the only thing that
// ever opens a socket. It resolves the name ONCE, validates every address it
// gets back, and connects to the exact address it validated. There is no
// second lookup for an attacker to answer differently, because there is no
// second lookup.
//
// TLS still works end to end: for CONNECT we open a raw tunnel to the
// validated IP and Chromium performs its own handshake through it, so the
// certificate is checked against the real hostname and we never see the
// plaintext or hold a key.

import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns/promises';
import { blockedAddressReason, isBlockedHostname } from '@unhittable/core/url-guard.js';

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve a host and return one address that is safe to connect to, or throw
 * with the reason. EVERY returned address must be acceptable: a host with one
 * public and one private record is a rebinding attempt, not a coincidence.
 */
export async function resolveSafely(hostname, lookup = dns.lookup, addressPolicy = blockedAddressReason) {
  const bare = String(hostname).replace(/^\[|\]$/g, '');

  if (isBlockedHostname(bare)) throw new Error(`${bare} is a machine-local name`);

  if (net.isIP(bare)) {
    const why = addressPolicy(bare);
    if (why) throw new Error(`${bare} is ${why}`);
    return bare;
  }

  const records = await lookup(bare, { all: true, verbatim: true });
  if (!records || records.length === 0) throw new Error(`${bare} does not resolve`);
  for (const r of records) {
    const why = addressPolicy(r.address);
    if (why) throw new Error(`${bare} resolves to ${r.address}, which is ${why}`);
  }
  return records[0].address;
}

/** Ordinary web ports only. A tunnel to 22 or 6379 is not a page load. */
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/**
 * An HTTP proxy that only ever connects to addresses it has just validated.
 *
 * @param {object} [opts]
 * @param {Function} [opts.lookup]         injected for tests
 * @param {Function} [opts.addressPolicy]  injected for tests ONLY, so the
 *   tunnel mechanics can be exercised against a loopback fixture. It is a
 *   code parameter with no path from an HTTP request, and a test below
 *   asserts the DEFAULT still refuses loopback so the relaxation cannot
 *   reach production.
 * @param {Set<number>} [opts.allowedPorts] injected for tests ONLY; a test
 *   asserts the shipped default is exactly {80, 443, 8080, 8443}.
 * @param {Function} [opts.onBlocked]
 */
export function createGuardProxy({ lookup = dns.lookup, onBlocked, addressPolicy = blockedAddressReason, allowedPorts = ALLOWED_PORTS } = {}) {
  const blocked = [];
  const note = (host, why) => {
    if (blocked.length < 100) blocked.push({ host, why });
    onBlocked?.({ host, why });
  };

  // Every tunnel socket is tracked, because a CONNECT tunnel is a raw socket
  // the HTTP server does not own and close() therefore waits on it for ever.
  // The corpus seeder hung on exactly this after scanning all forty sites.
  const tunnels = new Set();

  const server = http.createServer(async (req, res) => {
    // Plain HTTP arrives in absolute form because we are a proxy.
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end('bad target'); return; }
    if (target.protocol !== 'http:') { res.writeHead(403).end('scheme refused'); return; }

    const port = Number(target.port) || 80;
    if (!allowedPorts.has(port)) {
      note(target.hostname, `port ${port} is not a web port`);
      res.writeHead(403).end('refused by fence');
      return;
    }

    let ip;
    try { ip = await resolveSafely(target.hostname, lookup, addressPolicy); }
    catch (e) { note(target.hostname, e.message); res.writeHead(403).end('refused by fence'); return; }

    const upstream = http.request({
      host: ip,                                          // the validated address, not the name
      port,
      method: req.method,
      path: target.pathname + target.search,
      headers: { ...req.headers, host: target.host },    // preserve virtual hosting
      timeout: CONNECT_TIMEOUT_MS,
    }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });

    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('timeout', () => upstream.destroy());
    req.pipe(upstream);
  });

  // HTTPS, and anything else tunnelled.
  server.on('connect', async (req, clientSocket, head) => {
    const idx = String(req.url).lastIndexOf(':');
    const rawHost = idx > 0 ? String(req.url).slice(0, idx) : String(req.url);
    const port = Number(String(req.url).slice(idx + 1)) || 443;

    if (!allowedPorts.has(port)) {
      note(rawHost, `port ${port} is not a web port`);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    let ip;
    try { ip = await resolveSafely(rawHost, lookup, addressPolicy); }
    catch (e) { note(rawHost, e.message); clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }

    tunnels.add(clientSocket);
    clientSocket.on('close', () => tunnels.delete(clientSocket));

    const upstream = net.connect({ host: ip, port }, () => {
      tunnels.add(upstream);
      upstream.on('close', () => tunnels.delete(upstream));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return {
    server,
    blocked,
    listen: () => new Promise((resolve) => {
      // Loopback only. This proxy is laxer about nothing at all, and it must
      // never be reachable from off-box.
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    close: () => new Promise((resolve) => {
      // Keep-alive sockets AND raw CONNECT tunnels, or close() never returns.
      for (const s of tunnels) s.destroy();
      tunnels.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
      // A socket that is already gone can leave close() waiting on nothing.
      setTimeout(resolve, 1500).unref?.();
    }),
  };
}
