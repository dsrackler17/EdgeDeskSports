#!/usr/bin/env node
/* ===========================================================================
   Signal Center's database layer on a real PostgreSQL
   (supabase/signal_center.sql and its migration mirror).

     node tools/signal_center/sql.test.js      (SC_SQL_REQUIRED=1 in CI)

   The billing rule and the operator list are installed verbatim from
   supabase/billing_hardening.sql, and the notice table from
   supabase/personal_research.sql, so the gates are tested against the code
   production runs. Payloads are built by the real engine.

     file         applies twice (idempotent) and its report reads ok; it has no
                  psql meta-command and applies as ONE raw string (the SQL
                  editor); the migration copy is byte-identical
     roles        anon and signed-in roles cannot read or write any table; the
                  service role cannot write a table directly; only the doors
     lease        one run at a time; a stale run is failed, never resumed
     ingest       idempotent (same hash, no new row); a new hash is a new version
                  and the old one is kept; bad shapes, the copy rule and
                  fixtures are refused and recorded; two workers racing on one
                  key store it once
     history      versions, events, Model DNA and the config log refuse update,
                  delete and truncate, even for the table owner; an identity
                  never changes
     placement    shadow publishes nothing; live publishes VERIFIED signals of
                  live sports at or above the label; an operator's hold sticks;
                  invalidation withdraws the signal and its graphics; older
                  signals about the same subject are superseded; started events
                  expire
     gates        Full Access sees numbers; a signed-in non-subscriber, a lapsed
                  subscriber and anon see the number-free preview, limited by
                  sc_config; operators see shadow; the detail door follows
     feed         filters, sorts, keyset pages without duplicates; bad cursors
     graphics     only for the current version and its exact payload; immutable;
                  a new version outdates them; approval needs a published signal
     simulator    the server re-checks a simulation signal against the
                  published rows and refuses a mismatch as VERIFIED
     notices      entitled readers who asked get one user_alerts row per signal,
                  deduplicated and cooled down; non-subscribers get none
     scale        5,000 signals: the feed's first page and a deep page in ms
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const T = PG.kit('signal center sql');
const chk = T.chk;
const lit = PG.lit;
const F = (n) => path.join(ROOT, 'supabase', n);
const SQLF = F('signal_center.sql');
const MIRROR = F('migrations/20261024120000_signal_center.sql');

/* ── static ───────────────────────────────────────────────────────────── */
const text = fs.readFileSync(SQLF, 'utf8');
chk('no psql meta-command on any line', text.split('\n').every((l) => !l.trimStart().startsWith('\\')));
chk('the migration mirror is byte-identical', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR, 'utf8') === text);
chk('no client write grant anywhere in the file', !/grant\s+(insert|update|delete|all)[^;]*\bto\s+(anon|authenticated)/i.test(text));
chk('core PostgreSQL only: no pgcrypto call (Supabase keeps it off the doors\' search_path)', !/\b(digest|gen_random_bytes|crypt|gen_salt|hmac)\s*\(/i.test(text.replace(/--[^\n]*/g, '')));
chk('no anon grant on a reader door that returns numbers',!/grant execute on function public\.sc_(feed|signal|signal_version|model_dna_current)\([^)]*\)\s+to\s+[^;]*anon/i.test(text));

(async () => {
  const db = await PG.start('scsql');
  if (db.skip) {
    if (process.env.SC_SQL_REQUIRED === '1') { console.log('FAIL | PostgreSQL is required here: ' + db.skip); process.exit(1); }
    console.log('NOTE | ' + db.skip + ' — the SQL suite did not run');
    process.exit(T.done());
  }
  const J = (s) => { const t = String(s).trim().split('\n').filter(Boolean).pop(); return t ? JSON.parse(t) : null; };
  const svc = (q) => J(db.service('select to_jsonb(' + q + ');'));
  const as = (uid, q) => J(db.as(uid, 'select to_jsonb(' + q + ');'));
  const anon = (q) => J(db.anon('select to_jsonb(' + q + ');'));
  const jl = (v) => lit(JSON.stringify(v)) + '::jsonb';
  const SUB = '11111111-1111-4111-8111-111111111111', NOSUB = '22222222-2222-4222-8222-222222222222', LAPSED = '33333333-3333-4333-8333-333333333333';
  const ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a'; /* billing_is_admin's founding operator */
  try {
    /* ---- production's billing rule, operator list and notice table ---- */
    const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8');
    const slice = (src, start, end) => { const i0 = src.indexOf(start); if (i0 < 0) throw new Error('not found: ' + start); return src.slice(i0, src.indexOf(end, i0) + end.length); };
    const PR = fs.readFileSync(F('personal_research.sql'), 'utf8');
    const FU = fs.readFileSync(F('funnel.sql'), 'utf8');
    db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
      ${slice(BH, 'create or replace function public.billing_row_grants_access(', '$$;')}
      ${slice(BH, 'create or replace function public.billing_is_admin()', '$$;')}
      create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
        select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
      ${slice(PR, 'create or replace function public.edp_copy_ok(p text)', '$$;')}
      ${slice(PR, 'create table if not exists public.user_alerts (', 'grant select on public.user_alerts to authenticated;')}
      ${slice(FU, 'create table if not exists public.user_event_kinds (', '\n);')}
      insert into auth.users (id, email) values (${lit(SUB)}, 'sub@x'), (${lit(NOSUB)}, 'free@x'), (${lit(LAPSED)}, 'lapsed@x'), (${lit(ADMIN)}, 'op@x');
      insert into public.subscriptions values (${lit(SUB)}, 'active', 'price_x', now() + interval '20 days'), (${lit(LAPSED)}, 'canceled', 'price_x', now() - interval '30 days');`);

    /* ---- apply ---- */
    /* pgcrypto where Supabase keeps it: in the extensions schema, outside the
       doors' search_path (2026-10-24: digest() resolved here, not in production) */
    db.sql('drop extension if exists pgcrypto; create schema if not exists extensions; create extension pgcrypto with schema extensions;');
    let out = db.applyFile(SQLF);
    chk('applies, and every report row is ok', (out.match(/\|ok/g) || []).length === 12 && !/CHECK THIS/.test(out), out.slice(-1500));
    out = db.applyFile(SQLF);
    chk('applies again identically (idempotent)', (out.match(/\|ok/g) || []).length === 12 && !/CHECK THIS/.test(out));
    chk('the Signal Center seat is registered as a client event, once', +db.sql(`select count(*) from public.user_event_kinds where event_name = 'primary_nav_signals' and source = 'client';`) === 1);
    /* the SQL editor sends the file as ONE raw string */
    const sh = path.join(db.home, 'editor.sh');
    fs.writeFileSync(path.join(db.home, 'editor.sql'), text);
    fs.writeFileSync(sh, db.bin + '/psql -h ' + db.home + ' -p ' + db.port + ' -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -t -A -c "$(cat ' + path.join(db.home, 'editor.sql') + ')"\n');
    let ed = '';
    try { ed = cp.execSync(process.getuid && process.getuid() === 0 ? 'chown postgres ' + sh + ' && su postgres -c "sh ' + sh + '"' : 'sh ' + sh, { encoding: 'utf8' }); } catch (e) { ed = 'ERR ' + (e.stdout || '') + (e.stderr || e.message); }
    chk('applies as one raw string, as the SQL editor sends it', /\|ok/.test(ed) && !/ERR|ERROR/.test(ed), ed.slice(0, 600));

    /* ---- roles ---- */
    chk('anon cannot read sc_signals', /permission denied/.test(db.mustFail(() => db.anon('select count(*) from public.sc_signals;')) || ''));
    chk('a subscriber cannot read sc_signals directly', /permission denied/.test(db.mustFail(() => db.as(SUB, 'select count(*) from public.sc_signals;')) || ''));
    chk('a subscriber cannot read the versions table directly', /permission denied/.test(db.mustFail(() => db.as(SUB, 'select count(*) from public.sc_signal_versions;')) || ''));
    chk('a subscriber cannot call the ingest door', /permission denied/.test(db.mustFail(() => db.as(SUB, "select public.sc_ingest(gen_random_uuid(), '[]'::jsonb);")) || ''));
    chk('anon cannot call the feed door', /permission denied/.test(db.mustFail(() => db.anon("select public.sc_feed('{}'::jsonb, null, 10);")) || ''));
    chk('anon cannot call the detail door', /permission denied/.test(db.mustFail(() => db.anon('select public.sc_signal(1);')) || ''));
    chk('the service role cannot write sc_signals directly', /permission denied/.test(db.mustFail(() => db.service("insert into public.sc_signals (signal_key, category, sport, event_kind, subject_key, subject_label, outcome_id, headline, public_headline, evidence_class, evidence_rank, verification_state, score, label) values ('sc1-0000000000000000','FORECAST_SHIFT','nfl','game','a','a','a','a','a','OBSERVED',3,'VERIFIED',10,'Monitor');")) || ''));
    chk('a subscriber cannot switch the mode', /operators only/.test(db.mustFail(() => db.as(SUB, "select public.sc_admin_set_mode('live', null);")) || ''));
    chk('a subscriber cannot open the operator queue', /operators only/.test(db.mustFail(() => db.as(SUB, "select public.sc_admin_queue('{}'::jsonb, null, 10);")) || ''));
    const st0 = anon('public.sc_status()');
    chk('anon status: deployed, shadow, not entitled, not an operator', st0.deployed && st0.mode === 'shadow' && st0.entitled === false && st0.admin === false);
    chk('subscriber status: entitled', as(SUB, 'public.sc_status()').entitled === true);
    chk('lapsed subscriber status: not entitled', as(LAPSED, 'public.sc_status()').entitled === false);
    chk('the founding operator is an operator', as(ADMIN, 'public.sc_status()').admin === true);

    /* ---- payloads from the real engine ---- */
    const NOW = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const game = (k, home, away, startsInH, sport) => ({ sport: sport || 'nfl', league: sport || 'nfl', season: 2026, event_key: k, event_at: iso(NOW + startsInH * 3600e3),
      home: { name: home, abbr: home.slice(0, 3).toUpperCase() }, away: { name: away, abbr: away.slice(0, 3).toUpperCase() }, research_href: '#game/nfl/' + k, source: { id: 'gr', label: 'game research', ref: 'x' } });
    const snap = (id, minsAgo, p, ver) => ({ snapshot_id: id, at: iso(NOW - minsAgo * 60e3), built_at: iso(NOW - minsAgo * 60e3), p_home: p, model_id: ver || 'm1', model_version: ver || 'm1', data_status: 'OK', consistent: true, inputs: {} });
    const shift = (g, a, b, pa, pb, ver) => E.forecastShifts([snap(a, 120, pa), snap(b, 60, pb, ver)], g, { now: NOW, reliability: { m1: 'VALIDATED' } }).signals[0];
    const G1 = game('nfl|T_A_B', 'Alpha Team', 'Beta Team', 48);
    const p1 = shift(G1, 's1', 's2', 0.40, 0.55);            /* big */
    const p2 = shift(game('nfl|T_C_D', 'Gamma Team', 'Delta Team', 48), 's3', 's4', 0.50, 0.535); /* small */
    const p3 = shift(game('nba|N1', 'Echo Team', 'Fox Team', 30, 'nba'), 's5', 's6', 0.30, 0.45);
    const p4 = shift(game('nfl|T_E_F', 'Golf Team', 'Hotel Team', -1), 's7', 's8', 0.30, 0.45); /* already started */
    chk('engine payloads built', [p1, p2, p3, p4].every(Boolean) && p1.score.label !== 'Monitor', [p1 && p1.score, p2 && p2.score]);
    const begin = (k) => svc("public.sc_begin_run(" + jl({ engine_version: E.VERSION, spec_version: E.SPEC.id, idempotency_key: k || null, source_commit: 'abcdef0' }) + ")");
    const ingest = (run, items) => svc('public.sc_ingest(' + lit(run) + '::uuid, ' + jl(items.map((p) => ({ payload: p }))) + ')');
    const finish = (run) => svc('public.sc_finish_run(' + lit(run) + "::uuid, 'completed', '{}'::jsonb, null)");

    /* ---- lease ---- */
    const r1 = begin('k1');
    chk('a run begins', r1.busy === false && /^[0-9a-f-]{36}$/.test(r1.run_id) && r1.mode === 'shadow');
    chk('a second run is told the lease is held', begin('k2').busy === true);
    chk('ingest into a run that does not exist is refused', /not running/.test(db.mustFail(() => db.service("select public.sc_ingest(gen_random_uuid(), '[]'::jsonb);")) || ''));

    /* ---- ingest (shadow) ---- */
    let ig = ingest(r1.run_id, [p1, p2, p3, p4]);
    chk('four new signals', ig.inserted === 4 && ig.rejected === 0, ig);
    chk('shadow mode publishes nothing', ig.published === 0 && ig.items.every((i) => i.publication === 'SHADOW'));
    chk('a signal for a started event is stored EXPIRED', ig.items.find((i) => i.signal_key === p4.signal_key).lifecycle === 'EXPIRED');
    chk('…saying the event had started', db.sql('select lifecycle_reason from public.sc_signals where signal_key = ' + lit(p4.signal_key) + ';').trim() === 'the event had started when the signal was detected');
    /* a tournament (season kind) whose end has passed: it ended, nothing "started" */
    const p5 = JSON.parse(JSON.stringify(p4)); p5.event_kind = 'season'; p5.identity = Object.assign({}, p5.identity, { t: 'tournament' }); p5.signal_key = E.signalKey(p5.identity); p5.version_hash = E.versionHash(p5);
    const ig5 = ingest(r1.run_id, [p5]);
    chk('a tournament signal detected after its competition ended is EXPIRED, saying it ended', ig5.items[0].lifecycle === 'EXPIRED'
      && db.sql('select lifecycle_reason from public.sc_signals where signal_key = ' + lit(p5.signal_key) + ';').trim() === 'the competition had ended when the signal was detected', ig5);
    ig = ingest(r1.run_id, [p1, p2]);
    chk('the same payloads again: unchanged, no new row (idempotent)', ig.unchanged === 2 && ig.inserted === 0 && ig.versioned === 0);
    const bad = [Object.assign({}, p1, { signal_key: 'nope' }), Object.assign({}, p2, { headline: 'Lock of the week' }), Object.assign({}, p3, { fixture: true }), Object.assign({}, p1, { schema: 'x' })];
    ig = ingest(r1.run_id, bad);
    chk('a bad key, a tout headline, a fixture and a wrong schema are all refused', ig.rejected === 4 && ig.inserted === 0, ig.items.map((i) => i.rejected));
    chk('…and recorded in sc_failures', +db.sql("select count(*) from public.sc_failures where stage = 'ingest';").trim() === 4);
    /* a new version: the same key, a different version hash */
    const p1b = JSON.parse(JSON.stringify(p1));
    p1b.evidence.summary = p1b.evidence.summary + ' (re-evaluated)';
    p1b.version_hash = E.versionHash(p1b);
    ig = ingest(r1.run_id, [p1b]);
    chk('a changed payload is version 2 of the same signal', ig.versioned === 1 && ig.items[0].version === 2, ig);
    chk('…and version 1 is still stored', +db.sql("select count(*) from public.sc_signal_versions v join public.sc_signals s using (signal_id) where s.signal_key = " + lit(p1.signal_key) + ';').trim() === 2);
    chk('versions refuse update even for the owner', /append-only/.test(db.mustFail(() => db.sql("update public.sc_signal_versions set reason = 'correction';")) || ''));
    chk('versions refuse delete', /append-only/.test(db.mustFail(() => db.sql('delete from public.sc_signal_versions;')) || ''));
    chk('versions refuse truncate', /append-only/.test(db.mustFail(() => db.sql('truncate public.sc_signal_versions cascade;')) || ''));
    chk('events refuse update', /append-only/.test(db.mustFail(() => db.sql("update public.sc_signal_events set kind = 'held';")) || ''));
    chk('a signal identity never changes', /immutable/.test(db.mustFail(() => db.sql("update public.sc_signals set subject_key = 'x';")) || ''));
    chk('a signal is never deleted', /delete refused/.test(db.mustFail(() => db.sql('delete from public.sc_signals;')) || ''));

    /* ---- concurrency: two workers, one key ---- */
    const pc = shift(game('nfl|T_RACE', 'Race Home', 'Race Away', 48), 'r1', 'r2', 0.4, 0.5);
    const r2run = r1.run_id;
    const raceSql = "set role service_role; select public.sc_ingest(" + lit(r2run) + "::uuid, " + jl([{ payload: pc }]) + ");";
    const b1 = db.background(raceSql), b2 = db.background(raceSql);
    const w1 = b1.wait(20000), w2 = b2.wait(20000);
    chk('two racing workers both finish', w1.code === 0 && w2.code === 0, [w1, w2]);
    chk('…and the key is stored once, with one version', db.sql("select count(*) from public.sc_signals where signal_key = " + lit(pc.signal_key) + "; select count(*) from public.sc_signal_versions v join public.sc_signals s using (signal_id) where s.signal_key = " + lit(pc.signal_key) + ';').trim().split('\n').join(',') === '1,1');

    /* ---- feed in shadow ---- */
    chk('a subscriber sees an empty feed in shadow mode', as(SUB, "public.sc_feed('{}'::jsonb, null, 10)").items.length === 0);
    const aq = as(ADMIN, "public.sc_admin_queue('{}'::jsonb, null, 50)");
    chk('the operator queue sees the shadow signals', aq.items.length >= 5 && aq.admin === true, aq.items.length);
    finish(r1.run_id);
    chk('after the run, a new one may begin', begin('k3').busy === false);
    db.sql("update public.sc_runs set started_at = now() - interval '2 hours' where status = 'running';");
    let r3 = begin('k4');
    chk('a run older than the lease is failed and a new one begins', r3.busy === false && +db.sql("select count(*) from public.sc_runs where status = 'failed' and error->>'reason' like 'lease expired%';").trim() === 1);

    /* ---- a shared source's warning publishes with the sports it serves ---- */
    const sl = (live, sport) => db.sql("select public.sc_sport_live('" + JSON.stringify(live) + "'::jsonb, " + lit(sport) + ');').trim();
    chk('sport_live: a sport is live when listed', sl(['nfl'], 'nfl') === 't' && sl(['nfl'], 'cfb') === 'f');
    chk('sport_live: "football" is live when NFL or college football is', sl(['cfb'], 'football') === 't' && sl(['nba'], 'football') === 'f');
    chk('sport_live: "all" is live when any sport is, never with none', sl(['golf'], 'all') === 't' && sl([], 'all') === 'f');
    chk('sport_live: a malformed list is never live', db.sql("select public.sc_sport_live('{}'::jsonb, 'all') is not true and public.sc_sport_live(null, 'nfl') is not true;").trim() === 't');

    /* ---- live ---- */
    /* history stored in shadow: a verified change recorded before a game that has since started */
    const hx = shift(game('nfl|T_HX', 'Hist Home', 'Hist Away', -0.5), 'hx1', 'hx2', 0.30, 0.45);
    chk('a verified signal whose game has started is stored EXPIRED in shadow', hx.verification.state === 'VERIFIED' && ingest(r3.run_id, [hx]).items[0].lifecycle === 'EXPIRED');
    const eligibleSql = "select count(*) from public.sc_signals where publication = 'SHADOW' and verification_state = 'VERIFIED' and lifecycle <> 'WITHDRAWN' and not fixture and sport in ('nfl','cfb') and public.sc_label_rank(label) >= public.sc_label_rank('Routine');";
    /* an operator holds one eligible shadow signal first: going live must not override that */
    const heldId = +db.sql("select signal_id from public.sc_signals where publication = 'SHADOW' and verification_state = 'VERIFIED' and lifecycle <> 'WITHDRAWN' and not fixture and sport in ('nfl','cfb') and public.sc_label_rank(label) >= public.sc_label_rank('Routine') order by signal_id limit 1;").trim();
    as(ADMIN, 'public.sc_admin_act(' + heldId + ", 'hold', 'checking it first')");
    const eligible = +db.sql(eligibleSql).trim();
    const mode = as(ADMIN, "public.sc_admin_set_mode('live', array['nfl','cfb'])");
    chk('the operator switches to live for nfl and cfb', mode.mode === 'live');
    chk('…and the change is logged', +db.sql("select count(*) from public.sc_config_log where key in ('mode','live_sports');").trim() === 2);
    chk('going live publishes the eligible shadow signals of the live sports', eligible > 0 && mode.promoted === eligible && +db.sql(eligibleSql).trim() === 0, { eligible, promoted: mode.promoted });
    chk('…each with a published event naming the operator', +db.sql("select count(*) from public.sc_signal_events where kind = 'published' and actor like 'admin:%' and detail->>'reason' = 'the mode was switched to live';").trim() === eligible);
    chk('…but an operator\'s hold is never overridden', db.sql('select publication from public.sc_signals where signal_id = ' + heldId + ';').trim() === 'HELD');
    chk('…and history is published as history: a verified signal whose game had started (EXPIRED) is published by the switch', db.sql('select lifecycle || \',\' || publication from public.sc_signals where signal_key = ' + lit(hx.signal_key) + ';').trim() === 'EXPIRED,PUBLISHED', hx.score.label);
    /* a run publishes under the mode it began in: switching mid-run changes nothing */
    const qx = shift(game('nfl|L_X', 'Xray Team', 'Yankee Team', 30), 'x1', 'x2', 0.35, 0.52);
    chk('a run begun in shadow keeps publishing nothing after the switch', ingest(r3.run_id, [qx]).items[0].publication === 'SHADOW');
    finish(r3.run_id);
    const r3b = begin('k4b');
    r3.run_id = r3b.run_id;
    const q1 = shift(game('nfl|L_A', 'Juliet Team', 'Kilo Team', 30), 'l1', 'l2', 0.35, 0.52);
    const q2 = shift(game('nba|L_B', 'Lima Team', 'Mike Team', 30, 'nba'), 'l3', 'l4', 0.35, 0.52);
    const q3 = JSON.parse(JSON.stringify(shift(game('nfl|L_C', 'Nov Team', 'Osc Team', 30), 'l5', 'l6', 0.35, 0.52)));
    q3.verification = { state: 'UNVERIFIED', checks: [], failed: ['x'] }; q3.version_hash = E.versionHash(q3);
    const q4 = shift(game('nfl|L_D', 'Papa Team', 'Que Team', 30), 'l7', 'l8', 0.50, 0.531); /* Monitor */
    const q5 = shift(game('nfl|L_E', 'Romeo Team', 'Sierra Team', 30), 'l9', 'l10', 0.30, 0.47);
    const q6 = shift(game('nfl|L_F', 'Tango Team', 'Uni Team', 30), 'l11', 'l12', 0.30, 0.48);
    ig = ingest(r3.run_id, [q1, q2, q3, q4, q5, q6]);
    const pubOf = (p) => ig.items.find((i) => i.signal_key === p.signal_key).publication;
    chk('live: a verified NFL signal above the label is PUBLISHED', pubOf(q1) === 'PUBLISHED', ig.items);
    chk('live: an NBA signal (not a live sport) stays SHADOW', pubOf(q2) === 'SHADOW');
    chk('live: an UNVERIFIED signal stays SHADOW', pubOf(q3) === 'SHADOW');
    chk('live: the label rule decides (Monitor stays SHADOW, Routine and above publish)', pubOf(q4) === (q4.score.label === 'Monitor' ? 'SHADOW' : 'PUBLISHED'), q4.score);
    const q3id = +db.sql('select signal_id from public.sc_signals where signal_key = ' + lit(q3.signal_key) + ';').trim();
    chk('an UNVERIFIED signal cannot be published by an operator', /only a VERIFIED/.test(db.mustFail(() => db.as(ADMIN, 'select public.sc_admin_act(' + q3id + ", 'publish', null);")) || ''));
    chk('the database refuses a published unverified row outright', /check/.test(db.mustFail(() => db.sql("update public.sc_signals set publication = 'PUBLISHED' where signal_key = " + lit(q3.signal_key) + ';')) || ''));

    /* ---- gates ---- */
    const subFeed = as(SUB, "public.sc_feed('{}'::jsonb, null, 25)");
    /* the door's default scope is active: what the switch published as history (expired) is in the history scope */
    const promotedActive = +db.sql("select count(*) from public.sc_signal_events e join public.sc_signals s using (signal_id) where e.kind = 'published' and e.detail->>'reason' = 'the mode was switched to live' and s.lifecycle = 'ACTIVE';").trim();
    const expectPub = [q1, q4, q5, q6].filter((p) => E.SPEC.labels.findIndex((l) => l.label === p.score.label) <= 2).length + promotedActive;
    chk('Full Access: the subscriber sees the published signals with their numbers', subFeed.access === 'full' && subFeed.items.length === expectPub && subFeed.items.every((i) => /%/.test(i.headline) && i.values && i.values.current), subFeed.items.map((i) => i.headline));
    chk('Full Access: no shadow, unverified or NBA signal leaks', subFeed.items.every((i) => ['nfl', 'cfb'].indexOf(i.sport) >= 0 && i.verification === 'VERIFIED'));
    const freeFeed = as(NOSUB, "public.sc_feed('{}'::jsonb, null, 25)");
    chk('a signed-in non-subscriber gets the preview', freeFeed.access === 'preview' && freeFeed.reason === 'not_entitled');
    chk('…limited by sc_config.free.feed_limit (3)', freeFeed.items.length <= 3 && freeFeed.limit === 3);
    chk('…with no paid number: no headline, no values, no percentage in the free headline', freeFeed.items.every((i) => i.headline === undefined && i.values === undefined && !/\d%|\bpp\b/.test(i.public_headline) && i.locked === true), freeFeed.items);
    chk('a lapsed subscriber gets the preview', as(LAPSED, "public.sc_feed('{}'::jsonb, null, 25)").access === 'preview');
    const pub = anon('public.sc_public_feed(10)');
    chk('anon: the public preview, number-free, within the limit', pub.access === 'preview' && pub.items.length <= 3 && pub.items.every((i) => !/\d%/.test(i.public_headline)));
    chk('anon: the preview only shows Notable-or-above free categories', pub.items.every((i) => ['Major', 'Notable'].indexOf(i.label) >= 0));
    db.sql("update public.sc_config set value = jsonb_set(value, '{feed_limit}', '1') where key = 'free';");
    chk('the free limit is read from configuration, not code', anon('public.sc_public_feed(10)').items.length <= 1);
    db.sql("update public.sc_config set value = jsonb_set(value, '{feed_limit}', '3') where key = 'free';");
    const sid = +db.sql('select signal_id from public.sc_signals where signal_key = ' + lit(q1.signal_key) + ';').trim();
    const det = as(SUB, 'public.sc_signal(' + sid + ')');
    chk('detail, Full Access: payload, versions, events, timeline', det.access === 'full' && det.payload && det.payload.signal_key === q1.signal_key && det.versions.length === 1 && det.events.some((e) => e.kind === 'published') && Array.isArray(det.timeline));
    chk('detail, Full Access: the payload hash is the database’s SHA-256', /^[0-9a-f]{64}$/.test(det.payload_sha256));
    const detFree = as(NOSUB, 'public.sc_signal(' + sid + ')');
    chk('detail, non-subscriber: preview or locked, never the payload', detFree.payload === undefined && ['preview', 'locked'].indexOf(detFree.access) >= 0, detFree);
    const shadowId = +db.sql('select signal_id from public.sc_signals where signal_key = ' + lit(q2.signal_key) + ';').trim();
    chk('detail of a shadow signal: not found for a subscriber', as(SUB, 'public.sc_signal(' + shadowId + ')').found === false);
    chk('…but visible to an operator', as(ADMIN, 'public.sc_signal(' + shadowId + ')').access === 'full');
    chk('a past version is readable by Full Access', as(SUB, 'public.sc_signal_version(' + sid + ', 1)').payload.signal_key === q1.signal_key);
    chk('…and not by a non-subscriber', as(NOSUB, 'public.sc_signal_version(' + sid + ', 1)').found === false);

    /* ---- supersession, hold, invalidation, expiry ---- */
    const G9 = game('nfl|L_G', 'Victor Team', 'Whiskey Team', 30);
    const s1 = E.forecastShifts([snap('g1', 200, 0.30), snap('g2', 150, 0.45)], G9, { now: NOW }).signals[0];
    const s2 = E.forecastShifts([snap('g2', 150, 0.45), snap('g3', 100, 0.62)], G9, { now: NOW }).signals[0];
    ingest(r3.run_id, [s1]); ingest(r3.run_id, [s2]);
    const lc = (k) => db.sql('select lifecycle from public.sc_signals where signal_key = ' + lit(k) + ';').trim();
    chk('an older signal about the same subject and outcome is SUPERSEDED by a newer one', s1.subject.key === s2.subject.key ? lc(s1.signal_key) === 'SUPERSEDED' : true, [s1.subject.key, s2.subject.key, lc(s1.signal_key)]);
    as(ADMIN, 'public.sc_admin_act(' + sid + ", 'hold', 'checking the source')");
    const q1b = JSON.parse(JSON.stringify(q1)); q1b.summary += ' (re-read)'; q1b.version_hash = E.versionHash(q1b);
    ingest(r3.run_id, [q1b]);
    chk('an operator hold sticks through a new version', db.sql('select publication from public.sc_signals where signal_id = ' + sid + ';').trim() === 'HELD');
    chk('a withdrawal needs a reason', /needs a reason/.test(db.mustFail(() => db.as(ADMIN, 'select public.sc_admin_act(' + sid + ", 'withdraw', null);")) || ''));
    as(ADMIN, 'public.sc_admin_act(' + sid + ", 'publish', 'source checked')");
    chk('an operator republishes', db.sql('select publication from public.sc_signals where signal_id = ' + sid + ';').trim() === 'PUBLISHED');

    /* ---- graphics ---- */
    const cur = J(db.sql('select to_jsonb(x) from (select s.current_version_id as vid, v.payload_sha256 as sha from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id where s.signal_id = ' + sid + ') x;'));
    const old = J(db.sql('select to_jsonb(x) from (select v.version_id as vid, v.payload_sha256 as sha from public.sc_signal_versions v where v.signal_id = ' + sid + ' and v.version = 1) x;'));
    const gput = (items) => svc('public.sc_put_graphics(' + lit(r3.run_id) + '::uuid, ' + jl(items) + ')');
    let gr = gput([{ version_id: cur.vid, payload_sha256: cur.sha, template: 'probability_shift', template_version: 'sg1', format: 'square', content: { template: 'probability_shift', n: 1 } },
      { version_id: cur.vid, payload_sha256: cur.sha, template: 'probability_shift', template_version: 'sg1', format: 'landscape', content: { template: 'probability_shift', n: 2 } }]);
    chk('graphics for the current version are stored READY', gr.generated === 2 && gr.refused === 0, gr);
    gr = gput([{ version_id: cur.vid, payload_sha256: cur.sha, template: 'probability_shift', template_version: 'sg1', format: 'square', content: { template: 'probability_shift', n: 1 } }]);
    chk('the same graphic again is not stored twice', gr.generated === 0 && gr.unchanged === 1);
    gr = gput([{ version_id: old.vid, payload_sha256: old.sha, template: 'probability_shift', template_version: 'sg1', format: 'square', content: {} }, { version_id: cur.vid, payload_sha256: 'f'.repeat(64), template: 'probability_shift', template_version: 'sg1', format: 'portrait', content: {} }]);
    chk('a graphic for an old version, or from a different payload, is refused', gr.refused === 2 && gr.generated === 0);
    chk('a stored graphic’s content is immutable', /immutable/.test(db.mustFail(() => db.sql("update public.sc_graphics set content = '{}'::jsonb;")) || ''));
    const gid = +db.sql("select graphic_id from public.sc_graphics where signal_id = " + sid + " and format = 'square';").trim();
    chk('a subscriber cannot approve a graphic', /operators only/.test(db.mustFail(() => db.as(SUB, 'select public.sc_admin_graphic(' + gid + ", 'approve_external');")) || ''));
    chk('an operator approves the current graphic of a published signal', as(ADMIN, 'public.sc_admin_graphic(' + gid + ", 'approve_external')").ok === true);
    chk('Full Access sees the graphics in the detail', as(SUB, 'public.sc_signal(' + sid + ')').graphics.filter((g) => g.status === 'READY' && g.current).length === 2);
    const q1c = JSON.parse(JSON.stringify(q1b)); q1c.summary += ' (corrected)'; q1c.version_hash = E.versionHash(q1c);
    const corr = svc('public.sc_ingest(' + lit(r3.run_id) + '::uuid, ' + jl([{ payload: q1c, reason: 'correction' }]) + ')');
    chk('a correction is ingested as a new version', corr.versioned === 1, corr);
    chk('a new version marks the old graphics OUTDATED', +db.sql("select count(*) from public.sc_graphics where signal_id = " + sid + " and status = 'OUTDATED';").trim() === 2);
    chk('…and revokes an external approval on them', db.sql("select external_approval from public.sc_graphics where graphic_id = " + gid + ';').trim() === 'REVOKED');
    chk('…and the version reason is kept', db.sql('select reason from public.sc_signal_versions where signal_id = ' + sid + ' order by version desc limit 1;').trim() === 'correction');
    const cur2 = J(db.sql('select to_jsonb(x) from (select s.current_version_id as vid, v.payload_sha256 as sha from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id where s.signal_id = ' + sid + ') x;'));
    gput([{ version_id: cur2.vid, payload_sha256: cur2.sha, template: 'probability_shift', template_version: 'sg1', format: 'square', content: { n: 3 } }]);
    const q1d = JSON.parse(JSON.stringify(q1c)); q1d.verification = { state: 'INVALIDATED', checks: [], failed: ['source_missing'] }; q1d.version_hash = E.versionHash(q1d);
    ingest(r3.run_id, [q1d]);
    chk('an invalidation withdraws the signal', db.sql('select publication || \',\' || lifecycle from public.sc_signals where signal_id = ' + sid + ';').trim() === 'WITHDRAWN,WITHDRAWN');
    chk('…and its current graphics', +db.sql("select count(*) from public.sc_graphics where signal_id = " + sid + " and status = 'WITHDRAWN';").trim() >= 1);
    chk('…and it leaves the feed', as(SUB, "public.sc_feed('{}'::jsonb, null, 25)").items.every((i) => i.signal_id !== sid));
    chk('…while every earlier version is kept', +db.sql('select count(*) from public.sc_signal_versions where signal_id = ' + sid + ';').trim() === 4);
    const q5id = +db.sql('select signal_id from public.sc_signals where signal_key = ' + lit(q5.signal_key) + ';').trim();
    db.sql("update public.sc_signals set event_at = now() - interval '1 minute' where signal_id = " + q5id + ';');
    const fin = finish(r3.run_id);
    chk('finishing a run expires signals whose event has started', fin.expired >= 1 && lc(q5.signal_key) === 'EXPIRED', fin);
    chk('…a game saying the event started', db.sql('select lifecycle_reason from public.sc_signals where signal_id = ' + q5id + ';').trim() === 'the event started');

    /* ---- simulator: the server re-checks ---- */
    db.sql(`create table public.sim_runs (run_id uuid primary key, status text);
      create table public.sim_team_results (run_id uuid, entity_id text, outcome text, probability numeric);
      insert into public.sim_runs values ('aaaaaaaa-0000-4000-8000-000000000001', 'completed'), ('aaaaaaaa-0000-4000-8000-000000000002', 'completed');
      insert into public.sim_team_results values ('aaaaaaaa-0000-4000-8000-000000000001', 'TTU', 'cfp_field', 0.552), ('aaaaaaaa-0000-4000-8000-000000000002', 'TTU', 'cfp_field', 0.628);`);
    const run = (id, at) => ({ run_id: id, model_version: 'v1', rules_version: 'r1', engine_version: 'e1', n_sims: 100000, input_snapshot_at: at, completed_at: at, published_at: at, validation_summary: {} });
    const row = (p) => ({ entity_id: 'TTU', entity_name: 'Texas Tech', outcome: 'cfp_field', probability: p, mcse: Math.sqrt(p * (1 - p) / 1e5), provenance: 'Estimated', applicable: true });
    const simOk = E.simulationShifts({ sport: 'cfb', competition: 'NCAA FBS', season: '2026', previous: run('aaaaaaaa-0000-4000-8000-000000000001', iso(NOW - 2 * 86400e3)), current: run('aaaaaaaa-0000-4000-8000-000000000002', iso(NOW - 3600e3)) },
      { previous: [row(0.552)], current: [row(0.628)] }, { now: NOW }).signals[0];
    const simBad = E.simulationShifts({ sport: 'cfb', competition: 'NCAA FBS', season: '2026', previous: run('aaaaaaaa-0000-4000-8000-000000000001', iso(NOW - 2 * 86400e3)), current: run('aaaaaaaa-0000-4000-8000-000000000002', iso(NOW - 3600e3)) },
      { previous: [row(0.552)], current: [Object.assign(row(0.700), { entity_id: 'TTU' })] }, { now: NOW }).signals[0];
    simBad.identity.x = 'bad'; simBad.signal_key = E.signalKey(simBad.identity); simBad.version_hash = E.versionHash(simBad);
    const r4 = begin('k5');
    ig = ingest(r4.run_id, [simOk, simBad]);
    const vOf = (p) => ig.items.find((i) => i.signal_key === p.signal_key).verification;
    chk('a simulation signal matching the published rows stays VERIFIED', vOf(simOk) === 'VERIFIED', ig.items);
    chk('a simulation signal whose numbers are not the published rows is stored UNVERIFIED', vOf(simBad) === 'UNVERIFIED');
    chk('…with the server check in its audit trail', +db.sql("select count(*) from public.sc_signal_events e join public.sc_signals s using (signal_id) where s.signal_key = " + lit(simBad.signal_key) + " and e.kind = 'server_check' and (e.detail->>'ok')::boolean = false;").trim() === 1);

    /* ---- notices ---- */
    as(SUB, "public.sc_save_preferences('{\"sports\":[\"nfl\"],\"min_label\":\"Routine\",\"notify\":true}'::jsonb)");
    const np = as(NOSUB, "public.sc_save_preferences('{\"sports\":[\"nfl\"],\"min_label\":\"Routine\",\"notify\":true}'::jsonb)");
    chk('a non-subscriber may save preferences, told notices need Full Access', np.stored === true && np.notices_need_full_access === true);
    chk('an unknown category is refused', /unknown category/.test(db.mustFail(() => db.as(SUB, "select public.sc_save_preferences('{\"categories\":[\"PICKS\"]}'::jsonb);")) || ''));
    chk('anon cannot save preferences', /permission denied/.test(db.mustFail(() => db.anon("select public.sc_save_preferences('{}'::jsonb);")) || ''));
    chk('a reader reads their own preferences', as(SUB, 'public.sc_my_preferences()').notify === true);
    chk('a reader cannot read another reader’s preferences row', +db.as(NOSUB, 'select count(*) from public.sc_preferences where user_id = ' + lit(SUB) + ';').trim() === 0);
    const n1 = svc('public.sc_notify(' + lit(r4.run_id) + '::uuid)');
    const subAlerts = +db.sql("select count(*) from public.user_alerts where user_id = " + lit(SUB) + " and payload->>'source' = 'signal_center';").trim();
    chk('the subscriber who asked gets notices', n1.sent >= 1 && subAlerts === n1.sent, n1);
    chk('the non-subscriber gets none (fail closed)', +db.sql("select count(*) from public.user_alerts where user_id = " + lit(NOSUB) + ';').trim() === 0);
    chk('…deduplicated by the existing user_alerts_once key', db.sql("select count(*) = count(distinct dedupe_key) from public.user_alerts;").trim() === 't');
    chk('a reader gets at most five notices from one fan-out', subAlerts <= 5, subAlerts);
    const n2 = svc('public.sc_notify(' + lit(r4.run_id) + '::uuid)');
    const subAlerts2 = +db.sql("select count(*) from public.user_alerts where user_id = " + lit(SUB) + " and payload->>'source' = 'signal_center';").trim();
    chk('a second fan-out sends nothing new: what the cap held back stays held', n2.sent === 0 && subAlerts2 === subAlerts, { subAlerts, n2 });
    chk('the unread count is the reader’s Signal Center notices', as(SUB, 'public.sc_unread_count()') === subAlerts2);
    chk('notices open in Signal Center', +db.sql("select count(*) from public.user_alerts where payload->>'href' like '#signals/s/%';").trim() === subAlerts2);
    /* cooldown: a second signal about a subject just notified is held back */
    const notified = J(db.sql("select to_jsonb(x) from (select s.subject_key from public.sc_notification_log l join public.sc_signals s using (signal_id) where l.user_id = " + lit(SUB) + " limit 1) x;"));
    const sameSubject = JSON.parse(JSON.stringify(q6)); sameSubject.identity.extra = 'second'; sameSubject.signal_key = E.signalKey(sameSubject.identity);
    sameSubject.subject.key = notified.subject_key; sameSubject.version_hash = E.versionHash(sameSubject);
    ingest(r4.run_id, [sameSubject]);
    const n3 = svc('public.sc_notify(' + lit(r4.run_id) + '::uuid)');
    chk('a second signal about the same subject inside the cooldown is not sent', n3.sent === 0 && n3.skipped >= 1, n3);
    finish(r4.run_id);

    /* ---- pulse, Model DNA, failures ---- */
    const pulse = anon('public.sc_pulse(24)');
    chk('the pulse counts published signals for anyone, with no headline or number', pulse.published >= 1 && JSON.stringify(pulse).indexOf('headline') < 0 && typeof pulse.by_sport === 'object', pulse);
    const r5 = begin('k6');
    const dnaRec = { schema: 'edgedesk_model_dna_v1', model_key: 'nfl:edgedesk_football', sport: 'nfl', label: 'EdgeDesk NFL model', grade: 'EARLY', grade_means: 'x', live: { winner: { n: 12, brier: null } }, evaluated_at: iso(NOW) };
    let dn = svc('public.sc_put_dna(' + lit(r5.run_id) + '::uuid, ' + jl([dnaRec, { schema: 'nope' }]) + ')');
    chk('a Model DNA record is stored; a wrong shape is refused', dn.stored === 1);
    dn = svc('public.sc_put_dna(' + lit(r5.run_id) + '::uuid, ' + jl([dnaRec]) + ')');
    chk('the same record is stored once', dn.stored === 0);
    chk('Full Access reads Model DNA in full, with its history', as(SUB, "public.sc_model_dna_current('nfl')")[0].history.length === 1);
    chk('a non-subscriber reads the summary only', as(NOSUB, "public.sc_model_dna_current('nfl')")[0].locked === true && as(NOSUB, "public.sc_model_dna_current('nfl')")[0].live === undefined);
    chk('Model DNA refuses update', /append-only/.test(db.mustFail(() => db.sql("update public.sc_model_dna set grade = 'VALIDATED';")) || ''));
    const fails = as(ADMIN, 'public.sc_admin_failures(50)');
    chk('the operator lists open failures', fails.length >= 4);
    chk('…and resolves one', as(ADMIN, 'public.sc_admin_resolve_failure(' + fails[0].id + ')').resolved === true);
    chk('a failure’s record cannot be edited', /only resolution/.test(db.mustFail(() => db.sql("update public.sc_failures set error = 'x';")) || ''));
    chk('a non-operator cannot list failures', /operators only/.test(db.mustFail(() => db.as(SUB, 'select public.sc_admin_failures(5);')) || ''));
    finish(r5.run_id);

    /* ---- backfill: history found in the ledger after the fact ---- */
    const GB = game('cfb|BF_1', 'Bravo U', 'Charlie U', -72, 'cfb'); /* played three days ago */
    const bf1 = E.forecastShifts([snap('b1', 240 * 60, 0.40), snap('b2', 200 * 60, 0.52)], GB, { now: NOW, reliability: { m1: 'VALIDATED' } }).signals[0];
    const bf2 = E.forecastShifts([snap('b2', 200 * 60, 0.52), snap('b3', 120 * 60, 0.66)], GB, { now: NOW, reliability: { m1: 'VALIDATED' } }).signals[0];
    chk('engine: a change found days after its record is backfilled, scored as of that record', bf1.backfilled === true && bf1.timestamps.scored_as_of === bf1.timestamps.source_published_at
      && bf1.timestamps.detected_at === iso(NOW) && bf1.score.components.find((c) => c.id === 'freshness').value === 1, [bf1.timestamps, bf1.score.components]);
    chk('engine: whether it was backfilled never changes its version', E.versionHash(Object.assign({}, bf1, { backfilled: false })) === bf1.version_hash);
    const r6 = begin('k7');
    ig = ingest(r6.run_id, [bf2]);
    ig = ingest(r6.run_id, [bf1]);
    const rowOf = (k) => J(db.sql('select to_jsonb(x) from (select signal_id, lifecycle, publication, backfilled, signal_at, first_detected_at, source_at, superseded_by from public.sc_signals where signal_key = ' + lit(k) + ') x;'));
    const b1r = rowOf(bf1.signal_key), b2r = rowOf(bf2.signal_key);
    chk('backfilled history is stored as found later, placed at its record’s time', b1r.backfilled && b2r.backfilled && Date.parse(b2r.signal_at) === Date.parse(bf2.timestamps.source_published_at)
      && Date.parse(b2r.first_detected_at) > Date.parse(b2r.signal_at) + 100 * 3600e3, [b1r, b2r]);
    chk('the older record found second is superseded by the newer one at once', b1r.lifecycle === 'SUPERSEDED' && b1r.superseded_by === b2r.signal_id && b2r.lifecycle === 'EXPIRED', [b1r, b2r]);
    chk('a live run publishes verified history (expired, superseded) of a live sport', b1r.publication === 'PUBLISHED' && b2r.publication === 'PUBLISHED', [b1r.publication, b2r.publication]);
    const scopeIds = (scope) => as(SUB, "public.sc_feed('{\"scope\":\"" + scope + "\",\"sport\":\"cfb\"}'::jsonb, null, 50)").items.map((i) => i.signal_id);
    chk('the timeline scope shows the latest per subject, current and past', scopeIds('timeline').indexOf(b2r.signal_id) >= 0 && scopeIds('timeline').indexOf(b1r.signal_id) < 0);
    chk('the history scope shows the superseded one too', scopeIds('history').indexOf(b1r.signal_id) >= 0 && scopeIds('history').indexOf(b2r.signal_id) >= 0);
    chk('the active scope (the door’s default) shows neither', as(SUB, "public.sc_feed('{\"sport\":\"cfb\"}'::jsonb, null, 50)").items.every((i) => i.signal_id !== b1r.signal_id && i.signal_id !== b2r.signal_id));
    chk('an unknown scope is refused', /unknown scope/.test(db.mustFail(() => db.as(SUB, "select public.sc_feed('{\"scope\":\"everything\"}'::jsonb, null, 10);")) || ''));
    const bfItem = as(SUB, "public.sc_feed('{\"scope\":\"history\",\"sport\":\"cfb\"}'::jsonb, null, 50)").items.find((i) => i.signal_id === b2r.signal_id);
    chk('a feed item says it was found later, and when it happened', bfItem && bfItem.backfilled === true && Date.parse(bfItem.signal_at) === Date.parse(b2r.signal_at));
    const p168 = anon('public.sc_pulse(168)');
    chk('the pulse counts history on the day it happened (5 days ago in, 8 days ago out)', p168.backfilled === 1 && anon('public.sc_pulse(336)').backfilled === 2, [p168.backfilled]);
    chk('when a signal happened never changes', /immutable/.test(db.mustFail(() => db.sql('update public.sc_signals set signal_at = now() where signal_id = ' + b2r.signal_id + ';')) || ''));
    /* a backfilled signal for a game still ahead is published, but nobody is notified of old news */
    const bf3 = E.forecastShifts([snap('c1', 600, 0.30), snap('c2', 400, 0.47)], game('nfl|BF_2', 'Delta Club', 'Echo Club', 30), { now: NOW, reliability: { m1: 'VALIDATED' } }).signals[0];
    ig = ingest(r6.run_id, [bf3]);
    const b3r = rowOf(bf3.signal_key);
    chk('a backfilled signal for an upcoming game is active and published', bf3.backfilled && b3r.lifecycle === 'ACTIVE' && b3r.publication === 'PUBLISHED', b3r);
    svc('public.sc_notify(' + lit(r6.run_id) + '::uuid)');
    chk('…and never becomes a notice (not even a held one)', +db.sql('select count(*) from public.sc_notification_log where signal_id = ' + b3r.signal_id + ';').trim() === 0);
    finish(r6.run_id);
    /* stored unpublished, then published by a live run: production's state
       after the 00:25 UTC run, whose history an earlier engine left
       unpublished while the mode was already live (so no switch will come) */
    as(ADMIN, "public.sc_admin_set_mode('shadow', null)");
    chk('in shadow mode an operator’s pulse counts the unpublished signals, and says so', as(ADMIN, 'public.sc_pulse(24)').includes_unpublished === true && anon('public.sc_pulse(24)').includes_unpublished === false);
    const r7 = begin('k8');
    const sh1 = shift(game('nfl|SH_1', 'Fox Club', 'Golf Club', 30), 'h1', 'h2', 0.30, 0.47);
    const sh2 = shift(game('nfl|SH_2', 'Hotel Club', 'India Club', 30), 'h3', 'h4', 0.30, 0.47);
    ingest(r7.run_id, [sh1, sh2]);
    chk('a shadow run publishes nothing pending', svc('public.sc_publish_pending(' + lit(r7.run_id) + '::uuid)') === 0 && rowOf(sh1.signal_key).publication === 'SHADOW');
    as(ADMIN, 'public.sc_admin_act(' + rowOf(sh2.signal_key).signal_id + ", 'hold', 'checking')");
    finish(r7.run_id);
    db.sql(`update public.sc_config set value = '"live"' where key = 'mode';`); /* live already: no switch, no promotion */
    const r8 = begin('k9');
    const promoted = svc('public.sc_publish_pending(' + lit(r8.run_id) + '::uuid)');
    chk('a live run publishes what is still unpublished, by the publication rule', promoted >= 1 && rowOf(sh1.signal_key).publication === 'PUBLISHED', promoted);
    chk('…an operator’s hold sticks', rowOf(sh2.signal_key).publication === 'HELD');
    chk('…a sport that is not live stays in shadow', rowOf(q2.signal_key).publication === 'SHADOW');
    chk('…an unverified signal stays in shadow', rowOf(q3.signal_key).publication === 'SHADOW');
    chk('…and the publication is in the audit trail', +db.sql("select count(*) from public.sc_signal_events where signal_id = " + rowOf(sh1.signal_key).signal_id + " and kind = 'published' and run_id = " + lit(r8.run_id) + '::uuid;').trim() === 1);
    chk('a client cannot call the door', /permission denied/.test(db.mustFail(() => db.as(ADMIN, 'select public.sc_publish_pending(' + lit(r8.run_id) + '::uuid);')) || ''));
    /* a disagreement whose closing is on record is not offered for another */
    const GD = game('nfl|CV_1', 'Kilo Club', 'Lima Club', 30);
    const named = (h, a, minsAgo) => ({ book: 'DraftKings', source: 'espn', captured_at: iso(NOW - minsAgo * 60e3), moneyline: { home: h, away: a }, home: { name: 'Kilo Club' }, away: { name: 'Lima Club' } });
    const dRow = { game: GD, model: { p_home: 0.64, at: iso(NOW - 30 * 60e3), snapshot_id: 'cv1', model_id: 'm1', model_version: 'm1' }, quote: named(-110, -110, 20) };
    const dv = E.marketDivergence([dRow], { now: NOW }).signals[0];
    const cvRow = { game: GD, model: { p_home: 0.53, at: iso(NOW - 5 * 60e3), snapshot_id: 'cv2', model_id: 'm1', model_version: 'm1' }, quote: named(-110, -110, 4) };
    const cv = E.marketConvergence([dv], [cvRow], { now: NOW })[0];
    chk('engine: a test disagreement and its closing', dv && cv && cv.identity.from === dv.signal_key, [!!dv, !!cv]);
    const prior = () => svc('(select coalesce(jsonb_agg(payload->>\'signal_key\'), \'[]\'::jsonb) from public.sc_prior_divergences())');
    ingest(r8.run_id, [dv]);
    chk('an open disagreement is a convergence candidate', prior().indexOf(dv.signal_key) >= 0);
    ingest(r8.run_id, [cv]);
    chk('…until its closing is on record (recorded once, not once per later quote)', prior().indexOf(dv.signal_key) < 0);
    finish(r8.run_id);

    /* ---- the feed at scale: filters, sorts, pages ---- */
    db.sql(`insert into public.sc_signals (signal_key, category, sport, league, event_kind, subject_key, subject_label, outcome_id, event_key, event_at, teams, market_type,
              headline, public_headline, change_pp, evidence_class, evidence_rank, verification_state, score, label, rarity, lifecycle, publication, published_at, first_detected_at, signal_at, current_version)
            select 'sc1-' || lpad(to_hex(1000000 + i), 16, '0'), case when i % 3 = 0 then 'MARKET_DIVERGENCE' else 'FORECAST_SHIFT' end, case when i % 2 = 0 then 'nfl' else 'cfb' end, 'x', 'game',
                   'team:' || (i % 97), 'Team ' || (i % 97), 'home_win', 'ev' || i, now() + interval '2 days', array['team ' || (i % 97)], 'moneyline',
                   'Team ' || (i % 97) || ' win probability up ' || (i % 20) || '.0 pp to 50.0%', 'EdgeDesk forecast moved toward Team ' || (i % 97), (i % 20)::numeric - 5, 'UNEXPLAINED', 1, 'VERIFIED',
                   (i % 100), case when i % 100 >= 70 then 'Major' when i % 100 >= 50 then 'Notable' when i % 100 >= 30 then 'Routine' else 'Monitor' end, (i % 10) / 10.0,
                   'ACTIVE', 'PUBLISHED', now(), now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval, 1
              from generate_series(1, 5000) i;
            insert into public.sc_signal_versions (signal_id, version, version_hash, payload, payload_sha256, reason, engine_version, spec_version)
            select signal_id, 1, 'sv1-' || lpad(to_hex(signal_id), 16, '0'), jsonb_build_object('summary', headline, 'event', jsonb_build_object('label', 'x')), repeat('a', 64), 'initial', 'e', 's'
              from public.sc_signals where current_version_id is null;
            update public.sc_signals s set current_version_id = v.version_id from public.sc_signal_versions v where v.signal_id = s.signal_id and s.current_version_id is null;
            analyze public.sc_signals; analyze public.sc_signal_versions;`);
    const t0 = Date.now();
    const page1 = as(SUB, "public.sc_feed('{}'::jsonb, null, 25)");
    const firstMs = Date.now() - t0;
    chk('5,000 published signals: the first page is 25 with a cursor', page1.items.length === 25 && !!page1.next_cursor);
    const seen = new Set(page1.items.map((i) => i.signal_id));
    let cursor = page1.next_cursor, pages = 1, dup = 0, ordered = true, last = page1.items[page1.items.length - 1].signal_at;
    while (cursor && pages < 8) {
      const pg = as(SUB, "public.sc_feed('{}'::jsonb, " + lit(cursor) + ', 25)');
      pg.items.forEach((i) => { if (seen.has(i.signal_id)) dup++; seen.add(i.signal_id); if (i.signal_at > last) ordered = false; last = i.signal_at; });
      cursor = pg.next_cursor; pages++;
    }
    chk('keyset paging: no duplicate across 8 pages, newest first', dup === 0 && ordered && seen.size === 200, { dup, ordered, n: seen.size });
    const nflOnly = as(SUB, "public.sc_feed('{\"sport\":\"nfl\"}'::jsonb, null, 50)");
    chk('filter: sport', nflOnly.items.length === 50 && nflOnly.items.every((i) => i.sport === 'nfl'));
    chk('filter: category', as(SUB, "public.sc_feed('{\"category\":\"MARKET_DIVERGENCE\"}'::jsonb, null, 30)").items.every((i) => i.category === 'MARKET_DIVERGENCE'));
    chk('filter: team', as(SUB, "public.sc_feed('{\"team\":\"Team 42\"}'::jsonb, null, 30)").items.every((i) => /Team 42/.test(i.subject)));
    chk('filter: minimum label', as(SUB, "public.sc_feed('{\"min_label\":\"Major\"}'::jsonb, null, 30)").items.every((i) => i.label === 'Major'));
    const shiftSort = as(SUB, "public.sc_feed('{\"sort\":\"shift\"}'::jsonb, null, 30)").items;
    chk('sort: largest shift first', shiftSort.every((x, i, a) => i === 0 || Math.abs(a[i - 1].change_pp) >= Math.abs(x.change_pp)));
    const disSort = as(SUB, "public.sc_feed('{\"sort\":\"disagreement\"}'::jsonb, null, 30)").items;
    chk('sort: largest disagreement first, divergences only', disSort.every((x, i, a) => x.category === 'MARKET_DIVERGENCE' && (i === 0 || Math.abs(a[i - 1].change_pp) >= Math.abs(x.change_pp))));
    chk('sort: rarity', as(SUB, "public.sc_feed('{\"sort\":\"rarity\"}'::jsonb, null, 30)").items.every((x, i, a) => i === 0 || (a[i - 1].rarity === null ? -1 : a[i - 1].rarity) >= (x.rarity === null ? -1 : x.rarity)));
    chk('a cursor from another sort is refused', /another sort/.test(db.mustFail(() => db.as(SUB, "select public.sc_feed('{\"sort\":\"score\"}'::jsonb, " + lit(page1.next_cursor) + ', 10);')) || ''));
    chk('a malformed cursor is refused', /bad cursor/.test(db.mustFail(() => db.as(SUB, "select public.sc_feed('{}'::jsonb, 'not-base64!!', 10);")) || ''));
    chk('an unknown sort is refused', /unknown sort/.test(db.mustFail(() => db.as(SUB, "select public.sc_feed('{\"sort\":\"hype\"}'::jsonb, null, 10);")) || ''));
    const t1 = Date.now();
    const deep = as(SUB, "public.sc_feed('{\"sport\":\"cfb\",\"min_label\":\"Notable\"}'::jsonb, null, 25)");
    const filtMs = Date.now() - t1;
    const t2 = Date.now(); anon('public.sc_pulse(168)'); const pulseMs = Date.now() - t2;
    const t3 = Date.now(); anon('public.sc_public_feed(3)'); const prevMs = Date.now() - t3;
    console.log('NOTE | latency at 5,000 signals (psql round trip included): first page ' + firstMs + ' ms, filtered page ' + filtMs + ' ms, 7-day pulse ' + pulseMs + ' ms, public preview ' + prevMs + ' ms');
    chk('latency at 5,000 signals stays under a second per call (round trip included)', firstMs < 1000 && filtMs < 1000 && pulseMs < 1000 && prevMs < 1000 && deep.items.length > 0, { firstMs, filtMs, pulseMs, prevMs });
    const plan = db.sql("explain select signal_id from public.sc_signals where publication = 'PUBLISHED' order by signal_at desc, signal_id desc limit 26;");
    chk('the recent feed (by the moment each signal describes) is served by its index', /sc_signals_time_idx/.test(plan), plan);

    /* ---- the owner's door (the database owner, with the connection string) ---- */
    chk('anon cannot use the owner\'s mode door', /permission denied/.test(db.mustFail(() => db.anon("select public.sc_owner_set_mode('live', null, 'x');")) || ''));
    chk('an operator account cannot use it either (it is not an API door)', /permission denied/.test(db.mustFail(() => db.as(ADMIN, "select public.sc_owner_set_mode('live', null, 'x');")) || ''));
    chk('nor can the job', /permission denied/.test(db.mustFail(() => db.service("select public.sc_owner_set_mode('live', null, 'x');")) || ''));
    chk('nor can anyone reach the switch\'s internals', /permission denied/.test(db.mustFail(() => db.as(ADMIN, "select public.sc_set_mode('live', null, null, 'x', 'x');")) || '')
      && /permission denied/.test(db.mustFail(() => db.service("select public.sc_promote_shadow('x');")) || '')
      && /permission denied/.test(db.mustFail(() => db.service("select public.sc_place_shadow('x', null, 'x');")) || ''));
    chk('the owner must say why', /say why/.test(db.mustFail(() => db.sql("select public.sc_owner_set_mode('live', null, '  ');")) || ''));
    const shadowOf = (sports) => +db.sql("select count(*) from public.sc_signals where publication = 'SHADOW' and verification_state = 'VERIFIED' and lifecycle <> 'WITHDRAWN' and not fixture and sport in (" + sports.map(lit).join(',') + ") and public.sc_label_rank(label) >= public.sc_label_rank('Routine');").trim();
    const nbaShadow = shadowOf(['nba']), liveShadow = shadowOf(['nfl', 'cfb', 'nba', 'nhl']);
    const own = J(db.sql("select public.sc_owner_set_mode('live', array['nfl','cfb','nba','nhl'], 'live for every sport with a source (owner, 2026-10-24)');"));
    chk('the owner switches to live for more sports, and every eligible shadow signal of them publishes (NBA included)', own.mode === 'live' && nbaShadow > 0 && own.promoted === liveShadow && shadowOf(['nfl', 'cfb', 'nba', 'nhl']) === 0 && JSON.stringify(own.live_sports) === '["nfl","cfb","nba","nhl"]', { own, nbaShadow, liveShadow });
    chk('…logged with the reason and no account', +db.sql("select count(*) from public.sc_config_log where changed_by is null and reason like 'live for every sport%';").trim() === 2);
    chk('…and the events name the owner', +db.sql("select count(*) from public.sc_signal_events where kind = 'published' and actor = 'owner';").trim() === liveShadow);
    const back = J(db.sql("select public.sc_owner_set_mode('shadow', null, 'back to shadow for the next checks');"));
    chk('switching to shadow publishes nothing and keeps the live sports', back.mode === 'shadow' && back.promoted === 0 && JSON.stringify(back.live_sports) === '["nfl","cfb","nba","nhl"]');

    /* ---- upgrade: rows an earlier engine stored before signal_at and backfilled existed (production's
       371 from 2026-10-24 00:25 UTC): dated by the engine's 180-minute rule and placed in record time ---- */
    db.sql('alter table public.sc_signals drop column signal_at, drop column backfilled;');
    const legacy = (key, ev, srcAgo, life) => `('${key}', 'FORECAST_SHIFT', 'cfb', 'game', 'cfb:up', 'Upgrade U', 'home_win', '${ev}', now() + interval '1 day', 'Upgrade U win probability up 4.0 pp to 50.0%', 'EdgeDesk forecast moved toward Upgrade U',
      4, 'UNEXPLAINED', 1, 'VERIFIED', 40, 'Routine', '${life}', 'SHADOW', now() - interval '${srcAgo}', now() - interval '1 minute')`;
    db.sql(`insert into public.sc_signals (signal_key, category, sport, event_kind, subject_key, subject_label, outcome_id, event_key, event_at, headline, public_headline,
              change_pp, evidence_class, evidence_rank, verification_state, score, label, lifecycle, publication, source_at, first_detected_at) values
            ${legacy('sc1-00000000000000a1', 'cfb|UPG', '5 days', 'EXPIRED')}, ${legacy('sc1-00000000000000a2', 'cfb|UPG', '4 days', 'EXPIRED')}, ${legacy('sc1-00000000000000a3', 'cfb|UPG2', '30 minutes', 'ACTIVE')};`);
    /* each with its stored version, as production's rows have (current_version_id set): what makes the
       upgrade's second pass queue the deferred foreign key's checks */
    db.sql(`insert into public.sc_signal_versions (signal_id, version, version_hash, payload, payload_sha256, reason, engine_version, spec_version)
              select signal_id, 1, 'sv1-' || substr(md5(signal_key), 1, 16), jsonb_build_object('signal_key', signal_key), repeat('0', 64), 'initial', 'e', 's'
                from public.sc_signals where signal_key like 'sc1-00000000000000a%';
            alter table public.sc_signals disable trigger sc_signals_guard;  -- this file's guard reads the columns dropped above; production's older guard did not
            update public.sc_signals s set current_version_id = v.version_id from public.sc_signal_versions v where v.signal_id = s.signal_id and s.signal_key like 'sc1-00000000000000a%';
            alter table public.sc_signals enable trigger sc_signals_guard;`);
    /* as the deploy applies it: one transaction (psql -1). Production's first
       try (2026-10-24 01:14 UTC) failed here: "cannot ALTER TABLE sc_signals
       because it has pending trigger events" (the row updates queue the
       deferred foreign key's checks; the RLS loop then alters the table) */
    try { out = db.applyFileAtomic(SQLF); } catch (e) { out = 'FAILED: ' + String(e.message || e).slice(0, 600); }
    chk('the file upgrades a table whose rows predate the columns, in one transaction as the deploy applies it', (out.match(/\|ok/g) || []).length === 12 && !/CHECK THIS|FAILED/.test(out), out.slice(-600));
    const up = (k) => J(db.sql('select to_jsonb(x) from (select signal_id, backfilled, lifecycle, superseded_by, extract(epoch from signal_at - source_at) as at_record, extract(epoch from signal_at - first_detected_at) as at_detection from public.sc_signals where signal_key = ' + lit(k) + ') x;'));
    const u1 = up('sc1-00000000000000a1'), u2 = up('sc1-00000000000000a2'), u3 = up('sc1-00000000000000a3');
    chk('upgrade: a row found days after its record is backfilled and dated by that record', u1.backfilled && +u1.at_record === 0 && u2.backfilled && +u2.at_record === 0, [u1, u2]);
    chk('upgrade: a row found within the hour is dated by its detection', !u3.backfilled && +u3.at_detection === 0, u3);
    chk('upgrade: the older of two expired signals about one subject is superseded by the newer, with an event', u1.lifecycle === 'SUPERSEDED' && u1.superseded_by === u2.signal_id && u2.lifecycle === 'EXPIRED'
      && +db.sql("select count(*) from public.sc_signal_events where signal_id = " + u1.signal_id + " and kind = 'superseded' and detail->>'note' = 'placed in record time';").trim() === 1, [u1, u2]);
    const evN = db.sql('select count(*) from public.sc_signal_events;').trim();
    db.applyFile(SQLF);
    chk('upgrade: applying the file again moves nothing', db.sql('select count(*) from public.sc_signal_events;').trim() === evN && up('sc1-00000000000000a1').lifecycle === 'SUPERSEDED');

    /* ---- rollback: removes every piece, leaves the rest of the project, and the file applies again ---- */
    const RB = F('signal_center_rollback.sql');
    const rbText = fs.readFileSync(RB, 'utf8');
    chk('the rollback has no psql meta-commands', !/^\\/m.test(rbText));
    chk('the rollback drops every function the file creates', [...text.matchAll(/create or replace function public\.(sc_[a-z_]+)\(/g)].map((x) => x[1])
      .every((fn) => new RegExp('drop function if exists public\\.' + fn + '\\(').test(rbText)));
    const notices = +db.sql("select count(*) from public.user_alerts where payload->>'source' = 'signal_center';");
    const others = +db.sql("select count(*) from public.user_alerts where coalesce(payload->>'source', '') <> 'signal_center';");
    let rb = db.applyFile(RB);
    chk('the rollback reports ok', /Signal Center is removed\|ok/.test(rb), rb.slice(-400));
    chk('no sc_ table or function is left', +db.sql("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'sc\\_%';") === 0
      && +db.sql("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'sc\\_%';") === 0);
    chk('the Signal Center notices go, every other notice stays', notices > 0 && +db.sql("select count(*) from public.user_alerts where payload->>'source' = 'signal_center';") === 0
      && +db.sql('select count(*) from public.user_alerts;') === others, { notices, others });
    chk('the project rules it read are untouched', !!db.sql("select to_regprocedure('public.community_is_entitled(uuid)')").trim() && !!db.sql("select to_regprocedure('public.billing_is_admin()')").trim());
    chk('the seat event kind goes with it', +db.sql("select count(*) from public.user_event_kinds where event_name = 'primary_nav_signals';") === 0);
    rb = db.applyFile(RB);
    chk('the rollback runs twice safely', /Signal Center is removed\|ok/.test(rb));
    out = db.applyFile(SQLF);
    chk('and the file applies again after a rollback', (out.match(/\|ok/g) || []).length === 12 && !/CHECK THIS/.test(out), out.slice(-800));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();
