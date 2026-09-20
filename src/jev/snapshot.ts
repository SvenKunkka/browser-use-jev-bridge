/**
 * In-page observation primitives.
 *
 * The DOM-side code below is a port of `jev_ultrafast/snapshot.js` and the
 * inline guard / act snippets from `jev_ultrafast/browser.py`
 * (browser-use/jev-ultrafast, MIT — see LICENSES/jev-ultrafast.LICENSE).
 *
 * Deliberate differences from upstream, all of them documented in
 * docs/ARCHITECTURE.md § "Porting notes":
 *
 *  1. `marker`, `page_key` and each entry of `guards` are digested inside the
 *     page instead of being returned verbatim. Upstream transports them over a
 *     raw CDP `returnByValue` call; here they travel through the Pi cell's
 *     stdout channel, which has a 1 MB capture limit, and the raw guard tuples
 *     (each carrying up to 6 000 characters of scope text) routinely exceed it.
 *     Only equality is ever tested on these values, so a digest is sufficient.
 *  2. Element rectangles are rounded to whole pixels so sub-pixel reflow does
 *     not spuriously invalidate a fingerprint.
 *  3. An `unsupported` block is added. It carries page-level signals (iframes,
 *     file inputs, canvas, shadow roots, open dialogs) that the hybrid router
 *     uses to decide that a page belongs to Browser Use Pi, not to Jev.
 *
 * Everything else — the selector set, role mapping, accessible-name algorithm,
 * visibility rules, the guard tuple, the action-space shape and the scroll/wait
 * pseudo-actions — follows upstream.
 */

/** Installed once per document; every other snippet reuses it. */
const CACHE_PRELUDE = String.raw`
  const cache = window.__bujbJev ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const digest = value => {
    const s = JSON.stringify(value);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2 + c, 2246822519) >>> 0);
      h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
    }
    return s.length.toString(36) + '-' + h1.toString(36) + '-' + h2.toString(36);
  };
  cache.digest = digest;
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e); cache.nodes.set(id, e); return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map(role => '[role="' + role + '"]').join(',');
  const role = e => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey = () => digest([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])]);
  cache.guard = e => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || ''];
  };
  cache.guardDigest = node => {
    const guard = cache.guard(cache.nodes.get(node));
    return guard === null ? null : digest(guard);
  };
`;

/**
 * Full observation. Returns null while the document is unusable (navigating).
 * Evaluated as an expression, so it is safe to pass straight to page.evaluate.
 */
export const SNAPSHOT_SOURCE = `(() => {
  if (!document.body) return null;
${CACHE_PRELUDE}
  const actions = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = {node: identity(e), role: rname, label: name(e) || rname,
      rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}};
    for (const key of ['checked','selected','expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base, kind: 'select', value: o.value,
          current_value: [...e.selectedOptions].map(o => o.label).join(', '), label: base.label + ' → ' + o.label});
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value = 'value' in e ? String(e.value) :
        e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      actions.push({...base, kind: editable ? 'fill' : 'click', value});
      if (editable) actions.push({...base, kind: 'click', value, label: 'Open ' + base.label});
    }
  }
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange(); let node, length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value); length += value.length;
    }
  }
  const text = words.join('\\n').slice(0, 6000), height = document.documentElement.scrollHeight;
  const pageKey = cache.pageKey(), guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guardDigest(a.node);
  // Compare meaning and identity. Geometry is resolved and hit-tested again just before input.
  const semantics = actions.map(({rect, ...action}) => action);
  const marker = digest([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text, semantics, pageKey]);
  const omittedActions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => a.id = 'e' + (i + 1));
  if (scrollY + innerHeight < height - 2) actions.push({id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560});
  if (scrollY > 0) actions.push({id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560});
  actions.push({id: 'wait', kind: 'wait', label: 'Wait for the page to update'});

  const frames = [...document.querySelectorAll('iframe,frame')];
  let crossOrigin = 0;
  for (const f of frames) { try { if (!f.contentDocument) crossOrigin++; } catch { crossOrigin++; } }
  let shadowRoots = 0, scanned = 0;
  for (const e of document.querySelectorAll('*')) {
    if (++scanned > 4000) break;
    if (e.shadowRoot) shadowRoots++;
  }
  const unsupported = {
    iframes: frames.length,
    crossOriginIframes: crossOrigin,
    fileInputs: document.querySelectorAll('input[type="file"]').length,
    canvases: document.querySelectorAll('canvas').length,
    shadowRoots,
    openDialogs: document.querySelectorAll('dialog[open]').length,
    passwordFields: document.querySelectorAll('input[type="password"]').length,
  };

  return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: {y: scrollY, height}, actions, marker, pageKey, guards, omittedActions, unsupported};
})()`;

/** Marker only. Re-runs the observation and returns its digest (upstream MARKER). */
export const MARKER_SOURCE = `(() => { const state = ${SNAPSHOT_SOURCE}; return state?.marker ?? null; })()`;

/**
 * Node-scoped freshness probe used before CLICK / SELECT, exactly as upstream:
 * the form-control page key plus this one node's guard must both still match.
 */
export function guardSource(node: number): string {
  return `(() => { const c = window.__bujbJev; return c ? [c.pageKey(), c.guardDigest(${Number(node)})] : null; })()`;
}

/**
 * Immediately-before-input re-check. Returns viewport coordinates, or null when
 * the node is gone, invisible, disabled, read-only, off-screen or occluded.
 * For SELECT it performs the value change in-page and confirms it.
 * Port of the `target` snippet in jev_ultrafast/browser.py.
 */
export function actTargetSource(action: unknown): string {
  return `(action => {
    const e = window.__bujbJev?.nodes.get(action.node);
    if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
        !e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return null;
    if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    if (!e.contains(document.elementFromPoint(x, y))) return null;
    if (action.kind === 'select') {
      if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
          !o.disabled && !o.closest('optgroup[disabled]'))) return null;
      e.value = action.value;
      e.dispatchEvent(new Event('input', {bubbles:true}));
      e.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return {x, y};
  })(${JSON.stringify(action)})`;
}

/**
 * Post-input settle. Waits two animation frames, and for combobox fills also
 * waits (briefly) for autocomplete options to become visible.
 * Port of the `after_input` snippet in jev_ultrafast/browser.py.
 */
export function settleSource(action: unknown): string {
  return `(action => new Promise(resolve => {
    const field = window.__bujbJev?.nodes.get(action.node);
    const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
    let frames = 0, stopped = false;
    const finish = () => { stopped = true; resolve(true); };
    setTimeout(finish, autocomplete ? 200 : 50);
    const ready = () => {
      if (stopped) return;
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
        .split(/\\s+/).filter(Boolean);
      const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
      const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
      if (++frames >= 2 && (!autocomplete || options.some(e => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
          e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
      }))) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  }))(${JSON.stringify(action)})`;
}
