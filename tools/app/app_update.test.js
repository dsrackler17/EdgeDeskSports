#!/usr/bin/env node
/* ===========================================================================
   An open tab picks up a new deploy (lib/edgedesk_update.js) and the version
   it compares against (tools/app/app_version.js → /app-version.json), offline
   with a simulated tab.

     loaded     the first read is the version the tab runs; nothing happens
     revisit    coming back to the tab when a new version is out: reload now
     in use     a new version found mid-session: a bar with Reload, and the
                next screen change or the next return to the tab reloads
     failures   a failed or malformed read changes nothing
     once       one reload per version, so a stale CDN copy cannot loop
     stamp      a hash of app.html and lib/: deterministic, moves with code
     wiring     app.html loads the checker; the workflow restamps on main

   Run: node tools/app/app_update.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'lib', 'edgedesk_update.js'));
const V = require(path.join(ROOT, 'tools', 'app', 'app_version.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* a tab: a document, a window, a clock and the deployed version file */
function tab(opts) {
  opts = opts || {};
  const T = { t: 1e6, version: opts.version || 'v1', fail: false, reloads: 0, reads: 0, session: {} };
  const L = { doc: {}, win: {} };
  const on = (bag) => (ev, fn) => { (bag[ev] = bag[ev] || []).push(fn); };
  const fire = (bag, ev) => (bag[ev] || []).forEach((fn) => fn());
  const body = { kids: [], appendChild(el) { this.kids.push(el); } };
  T.doc = {
    visibilityState: 'visible', body, addEventListener: on(L.doc),
    createElement() {
      const btn = { handlers: [], addEventListener(ev, fn) { this.handlers.push(fn); }, click() { this.handlers.forEach((f) => f()); } };
      return { className: '', style: {}, setAttribute() {}, set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector() { return btn; }, btn };
    }
  };
  T.win = { addEventListener: on(L.win), setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem: (k) => (k in T.session ? T.session[k] : null), setItem: (k, v) => { T.session[k] = String(v); } } };
  T.env = { win: T.win, doc: T.doc, now: () => T.t, reload: () => { T.reloads++; },
    fetchJson: () => { T.reads++; return T.fail ? Promise.reject(new Error('offline')) : Promise.resolve(T.version === null ? { nope: 1 } : { version: T.version }); } };
  T.hide = () => { T.doc.visibilityState = 'hidden'; fire(L.doc, 'visibilitychange'); };
  T.show = () => { T.doc.visibilityState = 'visible'; fire(L.doc, 'visibilitychange'); };
  T.nav = () => fire(L.win, 'hashchange');
  T.bar = () => body.kids.find((k) => k.className === 'edu-bar') || null;
  return T;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  chk('isNewer: only two different, non-empty versions', U.isNewer('a', 'b') && !U.isNewer('a', 'a') && !U.isNewer(null, 'b') && !U.isNewer('a', '') && !U.isNewer('a', undefined));

  /* loaded */
  let T = tab(), I = U.start(T.env);
  await I.ready;
  chk('the first read is the version this tab runs; no bar, no reload', I.state.loaded === 'v1' && T.reloads === 0 && !T.bar());

  /* revisit: away, a deploy, back → reload at once */
  T.hide(); T.t += 30 * 60e3; T.version = 'v2'; T.show(); await tick(); await tick();
  chk('back to the tab after a deploy: it reloads at once, no bar', T.reloads === 1 && !T.bar(), { reloads: T.reloads });

  /* in use: a deploy found by the timer while reading */
  T = tab(); I = U.start(T.env); await I.ready;
  T.t += 11 * 60e3; T.version = 'v2';
  await I.check(true);
  chk('a deploy found while the reader is on the page: a bar with Reload, no reload yet', !!T.bar() && /EdgeDesk was updated/.test(T.bar().innerHTML) && T.reloads === 0);
  T.nav();
  chk('…the next screen change reloads', T.reloads === 1);
  T = tab(); I = U.start(T.env); await I.ready;
  T.t += 11 * 60e3; T.version = 'v2'; await I.check(true);
  T.bar().btn.click();
  chk('…or the Reload button', T.reloads === 1);
  T = tab(); I = U.start(T.env); await I.ready;
  T.t += 11 * 60e3; T.version = 'v2'; await I.check(true);
  T.hide(); T.t += 60e3; T.show();
  chk('…or the next return to the tab', T.reloads === 1);

  /* no change */
  T = tab(); I = U.start(T.env); await I.ready;
  T.hide(); T.t += 30 * 60e3; T.show(); await tick(); T.nav();
  chk('no deploy: nothing happens on return or navigation', T.reloads === 0 && !T.bar() && T.reads === 2);
  T.hide(); T.t += 10e3; T.show(); await tick();
  chk('a quick return does not read again within a minute', T.reads === 2);

  /* failures */
  T = tab(); I = U.start(T.env); await I.ready;
  T.fail = true; T.t += 11 * 60e3; await I.check(true);
  T.fail = false; T.version = null; T.t += 11 * 60e3; await I.check(true);
  chk('a failed or malformed read changes nothing', T.reloads === 0 && !T.bar() && I.state.loaded === 'v1');
  T = tab(); T.fail = true; I = U.start(T.env); await I.ready;
  T.fail = false; T.t += 11 * 60e3; await I.check(true);
  chk('a tab whose first read failed takes the next read as its own version', I.state.loaded === 'v1' && T.reloads === 0);

  /* once */
  T = tab(); T.session[U.KEY] = 'v2'; I = U.start(T.env); await I.ready;
  T.hide(); T.t += 30 * 60e3; T.version = 'v2'; T.show(); await tick(); await tick();
  chk('one reload per version: a tab that already reloaded for v2 does not loop', T.reloads === 0 && !!T.bar());

  /* stamp */
  const a = V.stamp(), b = V.stamp();
  chk('the stamp is deterministic', a.version === b.version && /^[0-9a-f]{16}$/.test(a.version) && a.schema === V.SCHEMA);
  chk('the stamp covers app.html and every lib/ file', V.files(ROOT)[0] === 'app.html' && V.files(ROOT).includes('lib/edgedesk_update.js') && V.files(ROOT).every((p) => p === 'app.html' || p.startsWith('lib/')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-ver-'));
  fs.mkdirSync(path.join(tmp, 'lib'));
  fs.writeFileSync(path.join(tmp, 'app.html'), '<html>'); fs.writeFileSync(path.join(tmp, 'lib', 'x.js'), 'a');
  const s1 = V.stamp(tmp).version; fs.writeFileSync(path.join(tmp, 'lib', 'x.js'), 'b');
  const s2 = V.stamp(tmp).version; fs.writeFileSync(path.join(tmp, 'lib', 'x.js'), 'a');
  chk('the stamp moves when code changes, and back when it is restored', s1 !== s2 && V.stamp(tmp).version === s1);
  fs.rmSync(tmp, { recursive: true, force: true });
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8'));
  chk('app-version.json is a stamp the checker can read', file.schema === V.SCHEMA && /^[0-9a-f]{16}$/.test(file.version));

  /* wiring */
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  chk('app.html loads the checker', /<script src="\/lib\/edgedesk_update\.js\?v=[a-z0-9]+" defer><\/script>/.test(APP));
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'app-version.yml'), 'utf8');
  chk('the workflow restamps on main when app.html or lib/ changes, through push_generated.sh', /branches: \[main\]/.test(WF) && /'app\.html'/.test(WF) && /'lib\/\*\*'/.test(WF) && /app_version\.js --write/.test(WF) && /push_generated\.sh main .* -- app-version\.json/.test(WF));

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'app update check — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | threw ' + (e && e.stack || e)); process.exit(1); });
