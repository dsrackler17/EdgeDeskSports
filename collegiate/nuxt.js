'use strict';
/* ===========================================================================
   EdgeDesk collegiate — reading the data a Nuxt 3 page carries.

   Both platforms that build most Division I athletics sites (SIDEARM's
   current sites and WMT's) render with Nuxt 3, which ships the page's own
   data inside the HTML as <script id="__NUXT_DATA__"> — a JSON array in the
   "devalue" flattened form: entry 0 is the root, objects and arrays hold the
   indices of their members, and a few tagged arrays (["Reactive", i],
   ["Set", ...], ["Map", k, v, ...], ["Date", iso]) carry types. Reading that
   is reading exactly what the school's page shows, with no HTML scraping.
   =========================================================================== */

/* devalue's constants */
const CONST = { '-1': undefined, '-2': undefined, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 };
/* Nuxt's revivers wrap one value; we only need the value */
const WRAPPERS = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef', 'NuxtError', 'Island', 'Object']);

function unflatten(arr) {
  if (!Array.isArray(arr)) throw new Error('not a devalue payload');
  const memo = new Map();
  const hyd = (i) => {
    if (typeof i !== 'number') return undefined;
    if (i < 0) return CONST[String(i)];
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        const t = v[0];
        if (WRAPPERS.has(t)) { const r = v.length > 1 ? hyd(v[1]) : undefined; memo.set(i, r); return r; }
        if (t === 'Date') { memo.set(i, v[1]); return v[1]; }
        if (t === 'BigInt') { memo.set(i, Number(v[1])); return Number(v[1]); }
        if (t === 'RegExp') { memo.set(i, String(v[1])); return String(v[1]); }
        if (t === 'Set') { const r = []; memo.set(i, r); for (let k = 1; k < v.length; k++) r.push(hyd(v[k])); return r; }
        if (t === 'Map' || t === 'null') {
          const r = {}; memo.set(i, r);
          for (let k = 1; k < v.length; k += 2) r[t === 'Map' ? String(hyd(v[k])) : v[k]] = hyd(v[k + 1]);
          return r;
        }
        memo.set(i, null); return null;                 /* a type we do not read */
      }
      const r = []; memo.set(i, r);
      for (const x of v) r.push(hyd(x));
      return r;
    }
    const r = {}; memo.set(i, r);
    for (const k of Object.keys(v)) r[k] = hyd(v[k]);
    return r;
  };
  return hyd(0);
}

/* the page's data, or null when the page carries none */
function nuxtData(html) {
  const m = String(html || '').match(/<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return unflatten(JSON.parse(m[1])); } catch (_) { return null; }
}

module.exports = { unflatten, nuxtData };
