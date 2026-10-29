/* FSIE test harness: named checks, a non-zero exit on any failure. */
'use strict';
function kit(name) {
  let n = 0, fails = 0;
  function chk(what, cond, detail) {
    n++;
    if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 500); cond = false; } }
    if (cond) return true;
    fails++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)));
    return false;
  }
  async function achk(what, fn) { n++; try { const r = await fn(); if (r) return true; fails++; console.error('  FAIL: ' + what); } catch (e) { fails++; console.error('  FAIL: ' + what + ' — ' + String(e && e.stack || e).slice(0, 500)); } return false; }
  function done() { console.log((fails ? 'FAILED ' : 'ok     ') + name + ' — ' + (n - fails) + '/' + n + ' checks'); return fails ? 1 : 0; }
  return { chk, achk, done };
}
module.exports = { kit };
