/* The publisher's client side: the PostgREST client (bounded retries, no key
   in any message) and publishRun's call order and failure handling, against
   fakes. The database's own refusals are simulator/tests/sql.test.ts.
   node simulator/tests/publish.test.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kit } from './_kit.ts';
import { nflFixture, clone } from './_fixture.ts';
import { postgrestDb, DbError, type SimDb } from '../src/publish/db.ts';
import { publishRun, resultRows } from '../src/publish/publish.ts';
import { parseArgs, execute } from '../src/cli/run.ts';
import { writeSnapshot, codeHashes } from '../src/sports/nfl/inputs.ts';
import { hashCanonical } from '../src/core/canonical.ts';

const T = kit('simulator publisher (client side)');
const KEY = 'sk_test_' + 'x'.repeat(40);
const ENV = { SB_URL: 'https://example.supabase.co', SB_SERVICE_ROLE: KEY };
const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const noSleep = async () => {};

/* 1 configuration refusals */
T.throws('no SB_URL: nothing can be published', () => postgrestDb({ SB_SERVICE_ROLE: KEY }), /SB_URL/);
T.throws('an http (not https) URL is refused', () => postgrestDb({ SB_URL: 'http://example.supabase.co', SB_SERVICE_ROLE: KEY }), /SB_URL/);
T.throws('no service role key: nothing can be published', () => postgrestDb({ SB_URL: ENV.SB_URL }), /SB_SERVICE_ROLE/);
{
  let calls = 0;
  const db = postgrestDb(ENV, { fetchImpl: (async () => { calls++; return res(200, 1); }) as typeof fetch, sleep: noSleep });
  let err = ''; try { await db.rpc('delete_everything', {}); } catch (e) { err = (e as Error).message; }
  T.chk('a function outside sim_* is refused before any request', /non-simulator function/.test(err) && calls === 0, err);
}
/* 2 the request, and bounded retries on transient failures only */
{
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const replies = [res(503, 'busy'), res(200, { run_id: 'r1' })];
  const db = postgrestDb(ENV, { fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return replies.shift()!; }) as unknown as typeof fetch, sleep: noSleep });
  const out = await db.rpc('sim_begin_run', { p: { a: 1 } }) as any;
  T.chk('a 503 is retried and the second answer returned', out.run_id === 'r1' && seen.length === 2);
  const h = seen[0].init.headers as Record<string, string>;
  T.chk('POST to /rest/v1/rpc/<fn> with the key as apikey and bearer, JSON body', seen[0].url === 'https://example.supabase.co/rest/v1/rpc/sim_begin_run' && seen[0].init.method === 'POST'
    && h.apikey === KEY && h.Authorization === 'Bearer ' + KEY && seen[0].init.body === JSON.stringify({ p: { a: 1 } }));
}
{
  let calls = 0;
  const db = postgrestDb(ENV, { fetchImpl: (async () => { calls++; return res(400, { message: 'publication refused' }); }) as typeof fetch, sleep: noSleep });
  let e: any = null; try { await db.rpc('sim_publish_run', {}); } catch (x) { e = x; }
  T.chk('a 4xx is never retried (a deterministic refusal does not change on a second try)', e instanceof DbError && e.status === 400 && e.transient === false && calls === 1);
}
{
  let calls = 0; const waits: number[] = [];
  const db = postgrestDb(ENV, { fetchImpl: (async () => { calls++; return res(429, 'slow down'); }) as typeof fetch, sleep: async (ms: number) => { waits.push(ms); } });
  let e: any = null; try { await db.rpc('sim_put_results', {}); } catch (x) { e = x; }
  T.chk('429 is retried at most 3 times with backoff, then reported', e instanceof DbError && e.status === 429 && calls === 4 && JSON.stringify(waits) === JSON.stringify([500, 1000, 2000]), { calls, waits });
}
/* 3 the service role key never appears in an error, however often the server echoes it */
{
  const db = postgrestDb(ENV, { fetchImpl: (async () => res(500, 'bad key ' + KEY + ' / ' + KEY)) as typeof fetch, sleep: noSleep, retries: 0 });
  let m = ''; try { await db.rpc('sim_put_results', {}); } catch (x) { m = (x as Error).message; }
  T.chk('an error body echoing the key twice is redacted twice', m.length > 0 && !m.includes(KEY) && (m.match(/\[redacted\]/g) || []).length === 2, m);
  const db2 = postgrestDb(ENV, { fetchImpl: (async () => { throw new Error('connect failed for ' + KEY + ' ' + KEY); }) as typeof fetch, sleep: noSleep, retries: 1 });
  let m2 = '', transient = false; try { await db2.rpc('sim_put_results', {}); } catch (x) { m2 = (x as Error).message; transient = (x as DbError).transient; }
  T.chk('a network error is retried, then reported transient, with no key in it', transient && !m2.includes(KEY) && /network error/.test(m2), m2);
}

/* 4 publishRun against a recording fake */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-sim-pub-'));
try {
  const snap = clone(nflFixture());
  snap.data.code_sha256 = codeHashes(); snap.input_hash = hashCanonical(snap.data);     // TEST ONLY: re-stamped to this checkout (see cli.test.ts)
  const file = path.join(tmp, 'snapshot.json'); writeSnapshot(file, snap);
  const o = await execute(parseArgs(['--snapshot', file, '--runs', '1000', '--dry-run', '--allow-unreconciled', '--out', path.join(tmp, 'run')]), () => {});
  const fake = (opt: { existing?: string; failOn?: string; publish?: unknown } = {}) => {
    const calls: Array<{ name: string; args: any }> = [];
    const db: SimDb = { async rpc(name, args) {
      calls.push({ name, args });
      if (name === opt.failOn) throw new Error('INJECTED at ' + name);
      if (name === 'sim_begin_run') return opt.existing ? { run_id: 'old', status: opt.existing, existing: true } : { run_id: 'new', status: 'running', existing: false };
      if (name === 'sim_publish_run') return opt.publish || { published: true, status: 'completed' };
      return null;
    } };
    return { db, calls };
  };
  const rows = resultRows(o);
  {
    const f = fake();
    const p = await publishRun(o, { db: f.db, chunk: 100 });
    const names = f.calls.map((c) => c.name);
    const order = ['sim_begin_run', 'sim_put_snapshot', ...Array(Math.ceil(rows.length / 100)).fill('sim_put_results'), 'sim_put_entities', 'sim_put_traces', 'sim_publish_run'];
    T.eq('begin, snapshot, results in chunks, entities, traces, then one publish call', names, order);
    T.chk('every result row is sent exactly once', f.calls.filter((c) => c.name === 'sim_put_results').reduce((a, c) => a + c.args.p_rows.length, 0) === rows.length && rows.length === 32 * o.results.outcomes.length);
    const b = f.calls[0].args.p;
    T.chk('the run row carries the input hash, the gates and the sum rules the database re-checks', b.input_hash === o.results.run.input_hash && Array.isArray(b.gates) && b.expected.sum_rules.length > 0 && /^[0-9a-f]{64}$/.test(b.idempotency_key));
    T.chk('the result says published', p.published && p.run_id === 'new' && p.status === 'completed');
  }
  {
    const f = fake({ existing: 'completed' });
    const p = await publishRun(o, { db: f.db });
    T.chk('identical inputs already completed: nothing is uploaded again', f.calls.length === 1 && p.existing && !p.published && p.run_id === 'old');
  }
  {
    const f = fake({ failOn: 'sim_put_entities' });
    let err = ''; try { await publishRun(o, { db: f.db, chunk: 1000 }); } catch (e) { err = (e as Error).message; }
    const last = f.calls[f.calls.length - 1];
    T.chk('an upload failure marks the run failed and never calls sim_publish_run', /INJECTED/.test(err) && last.name === 'sim_fail_run' && last.args.p_run === 'new' && last.args.p_error.code === 'upload_failed' && !f.calls.some((c) => c.name === 'sim_publish_run'), f.calls.map((c) => c.name));
  }
  {
    const f = fake({ publish: { published: false, status: 'failed', errors: ['sum rule'] } });
    let err = ''; try { await publishRun(o, { db: f.db }); } catch (e) { err = (e as Error).message; }
    T.chk('a publication the database refuses is reported, and not marked failed a second time', /refused the publication/.test(err) && !f.calls.some((c) => c.name === 'sim_fail_run'));
  }
  {
    const f = fake({ publish: { published: false, status: 'superseded' } });
    const p = await publishRun(o, { db: f.db });
    T.chk('a run from older inputs comes back superseded, not published', !p.published && p.status === 'superseded');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(T.done());
