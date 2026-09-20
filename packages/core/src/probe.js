// probe.js - enumerate the pointer targets on a rendered page.
//
// This function is INJECTED INTO THE PAGE and runs in the page's own context,
// so it must be entirely self-contained: no imports, no closure variables, no
// optional chaining on anything that might not exist. Everything it needs is
// passed in as a plain object.
//
// Why a real browser is required at all, and therefore why this project has a
// backend: target size is not a property of the HTML, it is a property of the
// LAYOUT. Padding, flex sizing, transforms, a stylesheet that loads late and a
// font that swaps can each change how big a button is. You cannot answer "how
// big is this button" by reading the markup, so we lay the page out and
// measure what is actually there.

/**
 * Selectors for things a pointer can operate. Kept close to what established
 * accessibility tooling treats as a target so that our results can be compared
 * against theirs rather than talking past them.
 */
export const TARGET_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex^="-"])',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="option"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="treeitem"]', '[role="combobox"]',
].join(',');

/**
 * Collect every pointer target on the page, with the facts needed to judge it.
 *
 * Returns plain JSON so it can cross the browser boundary unchanged.
 *
 * @param {{selector: string, maxTargets: number}} opts
 */
export function collectTargets(opts) {
  var SELECTOR = opts && opts.selector ? opts.selector : null;
  var MAX = opts && opts.maxTargets ? opts.maxTargets : 1500;
  if (!SELECTOR) throw new Error('collectTargets: selector is required');

  // ---- helpers, all inlined because this runs in the page ----------------

  function cssPath(el) {
    // A selector a human can paste into devtools. Short-circuits on an id.
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var name = node.nodeName.toLowerCase();
      var parent = node.parentNode;
      if (parent && parent.children) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].nodeName === node.nodeName) same.push(parent.children[i]);
        }
        if (same.length > 1) name += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(name);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function visibleText(el) {
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }

  /**
   * Best-effort accessible name. Not a full accname implementation, and
   * labelled as best-effort wherever it is shown, because claiming a complete
   * accname computation and shipping an approximation is worse than saying
   * what this is.
   */
  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var ref = el.getAttribute('aria-labelledby');
    if (ref) {
      var out = [];
      var ids = ref.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var r = document.getElementById(ids[i]);
        if (r) out.push((r.innerText || r.textContent || '').trim());
      }
      if (out.length) return out.join(' ').trim();
    }
    if (el.nodeName === 'INPUT' || el.nodeName === 'SELECT' || el.nodeName === 'TEXTAREA') {
      if (el.labels && el.labels.length) {
        var l = [];
        for (var j = 0; j < el.labels.length; j++) l.push((el.labels[j].innerText || '').trim());
        var joined = l.join(' ').trim();
        if (joined) return joined;
      }
      var ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
      if (el.type === 'submit' || el.type === 'button') return el.value || '';
    }
    var txt = visibleText(el);
    if (txt) return txt;
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var alt = el.querySelector ? el.querySelector('img[alt]') : null;
    if (alt) return (alt.getAttribute('alt') || '').trim();
    return '';
  }

  /**
   * The Inline exception of SC 2.5.8: "The target is in a sentence, or its
   * size is otherwise constrained by the line-height of non-target text."
   *
   * Detected rather than assumed: the element must lay out inline AND sit
   * among text that is not itself a target. A link that is the only content
   * of its container is not in a sentence, however it is displayed.
   */
  function inlineInSentence(el, cs) {
    var d = cs.display;
    if (d !== 'inline' && d !== 'inline-block' && d !== 'inline-flex') return false;
    if (d !== 'inline') return false;                 // block-ish boxes are not line-constrained
    var parent = el.parentElement;
    if (!parent) return false;
    var own = (el.textContent || '').replace(/\s+/g, ' ').trim();
    var all = (parent.textContent || '').replace(/\s+/g, ' ').trim();
    if (all.length <= own.length + 1) return false;   // nothing around it
    // Require genuine prose either side, not just whitespace or a bullet.
    var surrounding = all.replace(own, '').replace(/[\s•|/,·>-]+/g, '');
    return surrounding.length >= 8;
  }

  function isRendered(el, cs, rect) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (el.closest && el.closest('[inert]')) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  // ---- walk ---------------------------------------------------------------

  var nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  var results = [];
  var skipped = { notRendered: 0, disabled: 0, pointerEventsNone: 0, overBudget: 0 };
  var seen = new Set();

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (seen.has(el)) continue;                 // an element can match several selectors
    seen.add(el);

    if (results.length >= MAX) { skipped.overBudget++; continue; }

    var cs = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();

    if (!isRendered(el, cs, rect)) { skipped.notRendered++; continue; }
    // A disabled control is not operable, so it is not a target for this
    // criterion. Counting it would inflate our own failure numbers.
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') { skipped.disabled++; continue; }
    if (cs.pointerEvents === 'none') { skipped.pointerEventsNone++; continue; }

    var scrollX = window.scrollX || 0, scrollY = window.scrollY || 0;
    results.push({
      tag: el.nodeName.toLowerCase(),
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      name: accessibleName(el),
      selector: cssPath(el),
      href: el.getAttribute('href') || null,
      // Document coordinates, so a report is stable regardless of scroll.
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      w: rect.width,
      h: rect.height,
      display: cs.display,
      inlineExempt: inlineInSentence(el, cs),
      // Reported so a reader can see whether the author sized this or the
      // browser did. We do NOT claim the User Agent exception from it,
      // because "not modified by the author" is not decidable from here.
      nativeControl: el.nodeName === 'INPUT' || el.nodeName === 'SELECT' || el.nodeName === 'TEXTAREA',
      inViewport: rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0,
    });
  }

  // A page with no viewport meta tag is laid out by a phone at a default
  // width of around 980 CSS px and then scaled down to fit the screen. Every
  // target on it therefore shrinks by that ratio before a finger ever arrives,
  // and the shrink is invisible to any checker that reads CSS pixels alone.
  // This is measured rather than inferred: the layout width is read from the
  // document and compared against the screen the page is being shown on.
  // The layout width is reported raw. The SCALE is deliberately NOT computed
  // here: in the page, the layout viewport and window.innerWidth are the same
  // number, so any ratio between them is 1 by construction. The caller knows
  // the width it asked the browser for, so it is the only party that can
  // compute the shrink honestly.
  var meta = document.querySelector('meta[name="viewport" i]');
  var layoutW = Math.max(
    document.documentElement ? document.documentElement.clientWidth : 0,
    window.innerWidth || 0
  );

  return {
    targets: results,
    skipped: skipped,
    page: {
      title: document.title || '',
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : null,
      lang: document.documentElement ? document.documentElement.lang || null : null,
      hasViewportMeta: !!meta,
      viewportMeta: meta ? meta.getAttribute('content') : null,
      layoutWidth: layoutW,
    },
    truncated: skipped.overBudget > 0,
  };
}
