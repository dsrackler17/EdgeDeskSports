/* The assertion kit every suite in this repository prints (tools/personal/_pg.js kit). */
export interface Kit {
  chk(label: string, ok: boolean, detail?: unknown): void;
  eq(label: string, got: unknown, want: unknown): void;
  near(label: string, got: number, want: number, tol: number): void;
  throws(label: string, fn: () => unknown, re?: RegExp): void;
  done(note?: string): number;
}

export function kit(name: string): Kit {
  let pass = 0, fail = 0;
  const failures: Array<{ label: string; detail?: unknown }> = [];
  const k: Kit = {
    chk(label, ok, detail) { if (ok) pass++; else { fail++; failures.push({ label, detail }); } },
    eq(label, got, want) {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      k.chk(label, g === w, { got, want });
    },
    near(label, got, want, tol) { k.chk(label, Number.isFinite(got) && Math.abs(got - want) <= tol, { got, want, tol }); },
    throws(label, fn, re) {
      try { fn(); k.chk(label, false, 'did not throw'); } catch (e) {
        const m = String((e as Error).message || e);
        k.chk(label, !re || re.test(m), m);
      }
    },
    done(note) {
      failures.forEach((f) => console.log('FAIL | ' + f.label + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
      if (note) console.log(note);
      console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + name + ' — ' + pass + ' passed, ' + fail + ' failed');
      return fail === 0 ? 0 : 1;
    }
  };
  return k;
}
