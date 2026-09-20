// Every pattern in the "real patterns" test below was taken verbatim from a
// site this project actually tried to scan. An earlier matcher truncated each
// pattern at its first wildcard and therefore read all of them as "Disallow:
// /", wrongly excluding 18 of 40 sites. These tests exist so that cannot
// silently return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsPathMatches, parseRobots, isAllowed, statusMeaning } from '../src/robots.js';

test('a plain prefix matches as a prefix', () => {
  assert.equal(robotsPathMatches('/private', '/private/thing'), true);
  assert.equal(robotsPathMatches('/private', '/private'), true);
  assert.equal(robotsPathMatches('/private', '/public'), false);
  assert.equal(robotsPathMatches('/', '/anything'), true, 'Disallow: / blocks everything');
  assert.equal(robotsPathMatches('', '/anything'), false, 'an empty Disallow forbids nothing');
});

test('a wildcard matches any sequence, and does not swallow the whole site', () => {
  assert.equal(robotsPathMatches('/*?cmd=x', '/?cmd=x'), true);
  assert.equal(robotsPathMatches('/*?cmd=x', '/a/b?cmd=x'), true);
  assert.equal(robotsPathMatches('/*?cmd=x', '/'), false, 'THE BUG: this must not match the homepage');
  assert.equal(robotsPathMatches('/*/print', '/a/print'), true);
  assert.equal(robotsPathMatches('/*/print', '/'), false);
});

test('a trailing dollar anchors the end', () => {
  assert.equal(robotsPathMatches('/*/print$', '/guides/print'), true);
  assert.equal(robotsPathMatches('/*/print$', '/guides/print/extra'), false);
  assert.equal(robotsPathMatches('/*.pdf$', '/docs/a.pdf'), true);
  assert.equal(robotsPathMatches('/*.pdf$', '/docs/a.pdf?x=1'), false);
});

test('REAL PATTERNS: none of these forbid a homepage', () => {
  // Verbatim from the robots.txt of sites in scripts/sites.json.
  const patterns = [
    '/*/print$',                                  // GOV.UK
    '/*/media/oembed',                            // Parkinson's Foundation, Michael J. Fox Foundation
    '/*/Search',                                  // Cleveland Clinic
    '*?scrollToReview=true',                      // CVS
    '/*?prices_first*',                           // GoodRx
    '/*/wiki/index.php/MediaWiki',                // W3C WAI
    '/*?s=',                                      // Deque
    '/*shop/iphone/payments/overlay/*',           // Apple
    '/*/files/',                                  // MDN
    '/*/partials*',                               // NPR
    '*?jw_start',                                 // Associated Press
    '/*/charities-non-profits/tax-exempt-organization-search',  // IRS
    '/*?cmd=_mobile-activate-outside',            // PayPal
    '/*?success',                                 // CFPB
  ];
  for (const p of patterns) {
    assert.equal(robotsPathMatches(p, '/'), false, `"${p}" must not block the homepage`);
  }
  // And each must still block what it is actually for.
  assert.equal(robotsPathMatches('/*/media/oembed', '/x/media/oembed'), true);
  assert.equal(robotsPathMatches('/*?s=', '/?s=hello'), true);
  assert.equal(robotsPathMatches('*?jw_start', '/video?jw_start=10'), true);
  assert.equal(robotsPathMatches('/*/files/', '/en-US/files/'), true);
});

test('groups are split on user-agent, and consecutive agents share rules', () => {
  const g = parseRobots(`
    User-agent: Googlebot
    User-agent: Bingbot
    Disallow: /search

    User-agent: *
    Disallow: /admin
    Allow: /admin/public
  `);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].agents, ['googlebot', 'bingbot']);
  assert.equal(g[0].rules.length, 1);
  assert.deepEqual(g[1].agents, ['*']);
  assert.equal(g[1].rules.length, 2);
});

test('the longest matching rule wins, and Allow breaks a tie', () => {
  const txt = 'User-agent: *\nDisallow: /a\nAllow: /a/b\n';
  assert.equal(isAllowed(txt, 'Unhittable', '/a/x').allowed, false);
  assert.equal(isAllowed(txt, 'Unhittable', '/a/b/c').allowed, true, 'the longer Allow wins');
  const tie = 'User-agent: *\nDisallow: /x\nAllow: /x\n';
  assert.equal(isAllowed(tie, 'Unhittable', '/x').allowed, true, 'an equal-length tie allows');
});

test('a group naming us overrides the wildcard group entirely', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Unhittable\nDisallow: /secret\n';
  assert.equal(isAllowed(txt, 'Unhittable', '/').allowed, true, 'our own group applies, not the wildcard');
  assert.equal(isAllowed(txt, 'Unhittable', '/secret').allowed, false);
  assert.equal(isAllowed(txt, 'SomeOtherBot', '/').allowed, false, 'everyone else still gets the wildcard');
});

test('a total block is honoured', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow: /', 'Unhittable', '/').allowed, false);
  assert.equal(isAllowed('User-agent: *\nDisallow:', 'Unhittable', '/').allowed, true);
  assert.equal(isAllowed('', 'Unhittable', '/').allowed, true);
});

test('HTTP status follows RFC 9309, which reads 4xx as an absence of rules', () => {
  assert.equal(statusMeaning(200).parse, true);
  // The mistake that cost three sites: a 403 is not a prohibition.
  assert.equal(statusMeaning(403).allowed, true);
  assert.equal(statusMeaning(404).allowed, true);
  assert.equal(statusMeaning(410).allowed, true);
  // But a rate limit and a server error both mean stop.
  assert.equal(statusMeaning(429).allowed, false);
  assert.equal(statusMeaning(500).allowed, false);
  assert.equal(statusMeaning(503).allowed, false);
});
