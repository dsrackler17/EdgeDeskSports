'use strict';
/* The assertion kit every suite in this repository prints (simulator/tests/_kit.ts, in CommonJS). */
function kit(name) {
  let pass = 0, fail = 0; const failures = [];
  const k = {
    chk(label, ok, detail) { if (ok) pass++; else { fail++; failures.push({ label, detail }); } },
    eq(label, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); k.chk(label, g === w, { got, want }); },
    near(label, got, want, tol) { k.chk(label, Number.isFinite(got) && Math.abs(got - want) <= tol, { got, want, tol }); },
    throws(label, fn, re) {
      try { fn(); k.chk(label, false, 'did not throw'); } catch (e) { const m = String((e && e.message) || e); k.chk(label, !re || re.test(m), m); }
    },
    async rejects(label, fn, re) {
      try { await fn(); k.chk(label, false, 'did not reject'); } catch (e) { const m = String((e && e.message) || e); k.chk(label, !re || re.test(m), m); }
    },
    done(note) {
      failures.forEach((f) => console.log('FAIL | ' + f.label + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
      if (note) console.log(note);
      console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + name + ' — ' + pass + ' passed, ' + fail + ' failed');
      return fail === 0 ? 0 : 1;
    },
    get failed() { return fail; },
  };
  return k;
}
module.exports = { kit };
