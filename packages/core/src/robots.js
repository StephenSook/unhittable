// robots.js - decide whether an automated sweep may fetch a path.
//
// Used only by the corpus seeder. A single scan a person asks for is a
// browser visit and does not need permission; sweeping forty homepages on a
// schedule is a crawl and does. That distinction is deliberate and is stated
// on the site rather than assumed.
//
// Follows RFC 9309. The part that matters and that a naive implementation
// gets wrong is the path matching: `*` is a wildcard and `$` anchors the end,
// so a rule like
//
//     Disallow: /*?cmd=_mobile-activate-outside
//
// forbids query strings on any path and says nothing whatsoever about "/".
// A first version of this code truncated each pattern at its first `*`,
// turning that rule into `Disallow: /`, and excluded 18 of 40 sites from the
// corpus, every one of them wrongly. The tests below are built from those
// real patterns.

/**
 * Does a robots.txt path pattern match this path?
 *
 * Matching is a PREFIX match with `*` meaning any sequence and a trailing `$`
 * meaning the pattern must reach the end of the path.
 */
export function robotsPathMatches(pattern, path) {
  if (pattern === '') return false;          // "Disallow:" with no value forbids nothing
  let re = '^';
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  for (const c of body) {
    if (c === '*') re += '.*';
    else re += c.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
  }
  if (anchored) re += '$';
  try { return new RegExp(re).test(path); } catch { return false; }
}

/** Split a robots.txt into groups of {agents, rules}. */
export function parseRobots(text) {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group of rules.
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * May `ua` fetch `path`?
 *
 * Precedence is RFC 9309's: the most specific group wins over the wildcard
 * group, and within a group the LONGEST matching pattern wins. A tie between
 * an Allow and a Disallow of equal length resolves to allow.
 */
export function isAllowed(text, ua, path) {
  const groups = parseRobots(text);
  if (groups.length === 0) return { allowed: true, why: 'no rules' };

  const lower = String(ua).toLowerCase();
  // A named group for us takes precedence over the wildcard group entirely.
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && lower.includes(a)));
  const wild = groups.filter((g) => g.agents.includes('*'));
  const applicable = named.length ? named : wild;
  if (applicable.length === 0) return { allowed: true, why: 'no group applies to this agent' };

  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (!robotsPathMatches(r.path, path)) continue;
      const len = r.path.length;
      // Longest wins; on an exact tie, Allow wins.
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) {
        best = { allow: r.allow, len, path: r.path };
      }
    }
  }
  if (!best) return { allowed: true, why: 'no rule matches this path' };
  return { allowed: best.allow, why: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` };
}

/**
 * What a robots.txt HTTP status means, per RFC 9309 section 2.3.1.
 *
 * A 4xx other than 429 means there are no rules, so fetching is permitted.
 * Treating a 403 as "forbidden" is a natural-looking mistake: it excluded
 * three government and hospital sites from our corpus for a status the
 * standard says to read as an absence of rules.
 */
export function statusMeaning(status) {
  if (status >= 200 && status < 300) return { parse: true, allowed: null, why: 'rules present' };
  if (status === 429) return { parse: false, allowed: false, why: 'rate limited, back off' };
  if (status >= 400 && status < 500) return { parse: false, allowed: true, why: `HTTP ${status}: RFC 9309 treats 4xx as no restrictions` };
  if (status >= 500) return { parse: false, allowed: false, why: `HTTP ${status}: server error, assume disallowed` };
  return { parse: false, allowed: false, why: `unexpected status ${status}` };
}
