#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — the database layer on a real PostgreSQL
   (supabase/market_foresight.sql, market_foresight_rollback.sql).

     node tools/foresight/sql.test.js        (MF_SQL_REQUIRED=1 in CI)

   static      the migration copy is byte-identical; no client write grant;
               no psql meta-command; the layer creates mf_* objects only
   install     applies twice; every report row ok
   roles       anon and signed-in readers cannot touch a table or a job door;
               the service role writes only through doors
   lease       one run at a time; a changed methodology digest is refused
   idempotent  the same input hash changes nothing; a new one appends a
               version; versions refuse update and delete; the fixture
               namespace is refused
   readers     shadow: only operators read; live: derived measurements of
               publishable models; full timelines for Full Access (or the
               operator's public_timeline switch); consensus members never
               named outside operators; an unlisted or removed Collective
               model disappears at once; keyset paging; a forged cursor
               refused; off: every door answers mode off
   operators   settlement verifications are operator-only and append-only;
               pending rules list the linked markets' digests
   rollback    removes the layer and leaves every source table untouched
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const E = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_foresight.js'));
const S = require(path.join(__dirname, 'fixtures', 'synthetic.js'));
const T = PG.kit('Market Foresight SQL');
const ROOT = PG.ROOT;
const F = (n) => path.join(ROOT, 'supabase', n);
const LAYER = fs.readFileSync(F('market_foresight.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(F('market_foresight_rollback.sql'), 'utf8');
const MPATH = path.join(ROOT, 'research', 'foresight', 'methodology', 'mf-v1.json');
const M = JSON.parse(fs.readFileSync(MPATH, 'utf8'));
const SHA = crypto.createHash('sha256').update(fs.readFileSync(MPATH)).digest('hex');

/* ---------------------------------------------------------------- static */
T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261025120000_market_foresight.sql'), 'utf8') === LAYER);
T.chk('no client write grant', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('no psql meta-command in either file', [LAYER, ROLLBACK].every((s) => !/^\s*\\/m.test(s)));
const created = [...LAYER.matchAll(/create\s+(?:or\s+replace\s+)?(?:table(?:\s+if\s+not\s+exists)?|function|view|index(?:\s+if\s+not\s+exists)?|trigger)\s+(?:public\.)?([a-z_0-9.]+)/gi)].map((m) => m[1].replace(/^public\./, ''));
T.chk('the layer creates mf_* objects only', created.length > 20 && created.every((n) => /^mf_/.test(n)), created.filter((n) => !/^mf_/.test(n)));
T.chk('the layer writes no foreign table', !/(insert\s+into|update|delete\s+from|truncate)\s+(?!public\.mf_)(public|collective|odds|auth)\.[a-z_]+/i.test(LAYER.replace(/--[^\n]*/g, '')));
T.chk('the rollback drops mf_* only', [...ROLLBACK.matchAll(/drop\s+(?:table|function)\s+if\s+exists\s+public\.([a-z_0-9]+)/gi)].every((m) => /^mf_/.test(m[1])));

const db = PG.start('mfsql');
if (db.skip) {
  if (process.env.MF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = PG.lit;
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const SUB = '00000000-0000-0000-0000-0000000000aa', NOSUB = '00000000-0000-0000-0000-0000000000bb', ADMIN = '00000000-0000-0000-0000-0000000000cc';
const CM_LISTED = '11111111-1111-1111-1111-111111111111', CM_UNLISTED = '22222222-2222-2222-2222-222222222222', CM_REMOVED = '33333333-3333-3333-3333-333333333333';
const asSub = (q) => db.as(SUB, q), asNo = (q) => db.as(NOSUB, q), asAdm = (q) => db.as(ADMIN, q);
const call = (who, fn) => J(who('select ' + fn + ';'));
const svc = (fn) => J(db.service('select ' + fn + ';'));
const fails = (fn) => !!db.mustFail(fn);

/* the synthetic world, renamed out of the fixture namespace (which the
   doors refuse) so that it can be stored in this throwaway database */
function rename(game) {
  const s = JSON.stringify(game)
    .replace(/SYN_/g, 'T_')
    .replace(/"m1"/g, '"collective:' + CM_LISTED + '"').replace(/"m2"/g, '"collective:' + CM_UNLISTED + '"').replace(/"m3"/g, '"collective:' + CM_REMOVED + '"')
    .replace(/"m4"/g, '"collective:44444444-4444-4444-4444-444444444444"').replace(/"m5"/g, '"collective:55555555-5555-5555-5555-555555555555"')
    .replace(/"m6"/g, '"collective:66666666-6666-6666-6666-666666666666"')
    .replace(/syn_/g, 'tm_');
  return JSON.parse(s);
}
const NOW = new Date(S.K3 + 86400000).toISOString();
const RES = E.evaluate({ games: S.GAMES.map(rename) }, M, NOW);
const R = E.rules(M);
const gameRows = RES.games.map((g) => ({ sport: g.sport, event_id: g.event_id, kickoff: g.kickoff, home: g.home, away: g.away, state: g.state,
  has_kalshi: !!g.series['kalshi:moneyline'], n_units: g.unit_keys.length, n_measured: RES.units.filter((u) => u.event_id === g.event_id && u.status === 'measured').length,
  input_hash: g.input_hash, payload: g }));
const unitRows = RES.units.map((u) => ({ unit_key: u.unit_key, sport: u.sport, event_id: u.event_id, kickoff: u.kickoff, source: u.source, model_key: u.model_key,
  model_label: u.model_label, model_version: u.model_version, creator: u.creator, market: u.market, measure: u.measure, venue: u.venue, status: u.status,
  exclusion_reason: u.status === 'excluded' ? u.exclusion_reason : null, cls: u.metrics && u.metrics.cls || null,
  precedence: u.metrics && u.metrics.move && u.metrics.move.precedence || null, horizon_bucket: u.horizon_bucket, published_at: u.published_at, input_hash: u.input_hash, payload: u }));
const sumRows = E.summarize(RES.units, R).map((s) => ({ window: 'all', key: s.key, source: s.source, model_key: s.model_key, model_label: s.model_label, model_version: s.model_version,
  sport: s.sport, market: s.market, venue: s.venue, horizon_bucket: s.horizon_bucket, evidence: s.evidence, payload: s }));
const begin = (p) => svc('public.mf_job_begin(' + lit(JSON.stringify(p)) + '::jsonb)');
const meth = { version: 'mf-v1', sha256: SHA, spec: M, frozen_at: '2026-10-25' };
const putG = (run, rows) => svc('public.mf_job_put_games(' + lit(run) + '::uuid, ' + lit(JSON.stringify(rows)) + '::jsonb)');
const putU = (run, rows) => svc('public.mf_job_put_units(' + lit(run) + '::uuid, ' + lit(JSON.stringify(rows)) + '::jsonb)');
const putS = (run, rows) => svc('public.mf_job_put_summaries(' + lit(run) + '::uuid, ' + lit(JSON.stringify(rows)) + '::jsonb)');
const finish = (run, p) => svc('public.mf_job_finish(' + lit(run) + '::uuid, ' + lit(JSON.stringify(p)) + '::jsonb)');

try {
  /* the world the layer lives in: the project's entitlement and operator
     rules, the Collective's listing columns, the Kalshi tables */
  db.sql(`create or replace function public.community_is_entitled(u uuid) returns boolean language sql stable as $$ select u = ${lit(SUB)}::uuid $$;
    create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select auth.uid() = ${lit(ADMIN)}::uuid $$;
    create schema collective;
    create table collective.creators (id uuid primary key, slug text, display_name text, is_listed boolean, status text, removed_at timestamptz);
    create table collective.models (id uuid primary key, creator_id uuid references collective.creators (id), name text, is_listed boolean);
    insert into collective.creators values ('aaaaaaaa-0000-0000-0000-000000000001', 'listed', 'Listed', true, 'active', null),
      ('aaaaaaaa-0000-0000-0000-000000000002', 'hidden', 'Hidden', false, 'active', null), ('aaaaaaaa-0000-0000-0000-000000000003', 'gone', 'Gone', true, 'active', now());
    insert into collective.models values (${lit(CM_LISTED)}, 'aaaaaaaa-0000-0000-0000-000000000001', 'm', true), (${lit(CM_UNLISTED)}, 'aaaaaaaa-0000-0000-0000-000000000002', 'm', true),
      (${lit(CM_REMOVED)}, 'aaaaaaaa-0000-0000-0000-000000000003', 'm', true);
    create table public.kalshi_markets (ticker text primary key, series_ticker text, rules_primary text);
    create table public.kalshi_game_links (market_ticker text primary key, sport text, kickoff_at timestamptz);
    insert into public.kalshi_markets values ('KXNFLGAME-X-HOM', 'KXNFLGAME', 'If the home team wins the game, including overtime, the market resolves Yes.');
    insert into public.kalshi_game_links values ('KXNFLGAME-X-HOM', 'nfl', now() - interval '1 day');`);
  const srcBefore = db.sql('select (select count(*) from collective.models) || \'|\' || (select count(*) from public.kalshi_markets) || \'|\' || (select count(*) from public.kalshi_game_links);');

  let out = db.applyFile(F('market_foresight.sql'));
  T.chk('applies; every report row is ok or a stated pending', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length >= 9, out);
  out = db.applyFile(F('market_foresight.sql'));
  T.chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out), out.slice(0, 300));
  out = db.applyFileAtomic(F('market_foresight.sql'));
  T.chk('and as the SQL editor sends it (one transaction)', !/CHECK THIS/.test(out));

  /* ---------------------------------------------------------------- roles */
  T.chk('anon cannot read a table', fails(() => db.anon('select * from public.mf_units;')));
  T.chk('a signed-in reader cannot read a table', fails(() => asSub('select * from public.mf_units;')));
  T.chk('anon cannot call a job door', fails(() => db.anon("select public.mf_job_begin('{}'::jsonb);")));
  T.chk('a subscriber cannot call a job door', fails(() => asSub("select public.mf_job_put_units('00000000-0000-0000-0000-000000000000'::uuid, '[]'::jsonb);")));
  T.chk('an operator cannot call a job door either', fails(() => asAdm("select public.mf_job_finish('00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb);")));
  T.chk('the service role cannot write a table directly (doors only)', fails(() => db.service("insert into public.mf_config (key, value) values ('x', '1');")));
  T.chk('the owner door is no API role\'s', fails(() => db.service("select public.mf_owner_set_mode('live', 'x');")) && fails(() => asAdm("select public.mf_owner_set_mode('live', 'x');")));

  /* ---------------------------------------------------------------- lease and methodology */
  const b1 = begin({ methodology: meth, trigger: 'test', engine: 'test' });
  T.chk('a run begins', !b1.busy && /^[0-9a-f-]{36}$/.test(b1.run_id), b1);
  T.chk('a second run while one is running gets busy', begin({ methodology: meth, trigger: 'test' }).busy === true);
  T.chk('a changed digest under mf-v1 is refused', fails(() => begin({ methodology: Object.assign({}, meth, { sha256: 'f'.repeat(64) }), trigger: 'test' })));
  T.chk('the methodology is stored with its digest, and refuses edits', db.sql("select sha256 from public.mf_methodologies where version = 'mf-v1';") === SHA
    && fails(() => db.sql("update public.mf_methodologies set spec = '{}' where version = 'mf-v1';")));

  /* ---------------------------------------------------------------- writes */
  const run = b1.run_id;
  let w = putG(run, gameRows);
  T.chk('games stored', w.inserted === gameRows.length && w.unchanged === 0, w);
  w = putU(run, unitRows);
  T.chk('units stored', w.inserted === unitRows.length, w);
  w = putU(run, unitRows);
  T.chk('the same input hashes again: nothing changes (idempotent)', w.inserted === 0 && w.updated === 0 && w.unchanged === unitRows.length, w);
  T.chk('one version per distinct input', +db.sql('select count(*) from public.mf_unit_versions;') === unitRows.length);
  const changed = JSON.parse(JSON.stringify(unitRows[0]));
  changed.input_hash = 'mfh-' + 'a'.repeat(16); changed.payload.note = 'a corrected record';
  w = putU(run, [changed]);
  T.chk('a new input hash replaces the current row and appends a version', w.updated === 1 && +db.sql('select count(*) from public.mf_unit_versions;') === unitRows.length + 1);
  T.chk('versions refuse update', fails(() => db.sql('update public.mf_unit_versions set payload = \'{}\';')));
  T.chk('versions refuse delete', fails(() => db.sql('delete from public.mf_unit_versions;')));
  T.chk('versions refuse truncate', fails(() => db.sql('truncate public.mf_unit_versions;')));
  putU(run, [unitRows[0]]);
  const fx = JSON.parse(JSON.stringify(unitRows[1])); fx.event_id = 'SYN_G1'; fx.payload.event_id = 'SYN_G1';
  T.chk('a fixture event id is refused by the door, even on a reused hash', fails(() => putU(run, [fx])));
  fx.input_hash = 'mfh-' + 'b'.repeat(16); fx.unit_key = 'mfu-' + 'b'.repeat(16); fx.payload.unit_key = fx.unit_key;
  T.chk('…and as a new row', fails(() => putU(run, [fx])));
  T.chk('a fixture game is refused', fails(() => putG(run, [Object.assign({}, gameRows[0], { event_id: 'SYN_G9', payload: Object.assign({}, gameRows[0].payload, { event_id: 'SYN_G9' }) })])));
  const mis = JSON.parse(JSON.stringify(unitRows[2])); mis.event_id = 'T_OTHER';
  T.chk('a row whose payload names another game is refused', fails(() => putU(run, [mis])));
  const fm = JSON.parse(JSON.stringify(unitRows[1])); fm.model_key = 'syn_b';
  T.chk('a fixture model key is refused by the database', fails(() => putU(run, [fm])));
  const wrongM = JSON.parse(JSON.stringify(unitRows[1])); wrongM.payload.methodology = 'mf-v9';
  T.chk('a row computed under another methodology is refused', fails(() => putU(run, [wrongM])));
  const bad = JSON.parse(JSON.stringify(unitRows[1])); bad.status = 'excluded'; bad.exclusion_reason = null;
  T.chk('an excluded unit without its reason is refused', fails(() => putU(run, [bad])));
  const sw = putS(run, sumRows);
  T.chk('summaries stored as the run\'s complete set', sw.upserted === sumRows.length, sw);
  T.chk('a finished run', finish(run, { status: 'ok', counts: RES.counts, coverage: RES.coverage, lead_lag: RES.lead_lag, incremental: RES.incremental, sources: { draftkings: { status: 'connected' } } }).status === 'ok');
  T.chk('a finished run cannot change', fails(() => db.sql("update public.mf_runs set status = 'failed' where run_id = " + lit(run) + ';')) && fails(() => finish(run, { status: 'ok' })));
  T.chk('a finished run cannot be deleted', fails(() => db.sql('delete from public.mf_runs where run_id = ' + lit(run) + ';')));
  T.chk('the next run is free to begin', begin({ methodology: meth, trigger: 'test' }).busy === false);
  const r2 = J(db.sql("select to_jsonb(run_id) from public.mf_runs where status = 'running';"));
  T.chk('writing with a finished run is refused', fails(() => putU(run, [unitRows[0]])));
  const sw2 = putS(r2, sumRows.slice(0, 3));
  T.chk('a later complete set removes summaries it no longer produces', sw2.removed === sumRows.length - 3 && +db.sql('select count(*) from public.mf_summaries;') === 3, sw2);
  putS(r2, sumRows);
  finish(r2, { status: 'ok', counts: RES.counts, coverage: RES.coverage, lead_lag: RES.lead_lag });

  /* ---------------------------------------------------------------- readers: shadow */
  const st = call(db.anon, 'public.mf_status()');
  T.chk('anyone: the status says shadow and carries coverage, the methodology and no forecast', st.mode === 'shadow' && st.methodology.version === 'mf-v1' && Array.isArray(st.coverage)
    && !/forecast_value|"F"/.test(JSON.stringify(st)));
  T.chk('shadow: anon gets no measurements', call(db.anon, "public.mf_overview('{}'::jsonb)").locked === true);
  T.chk('shadow: a subscriber gets no measurements', call(asSub, "public.mf_game('nfl', 'T_G1')").locked === true);
  const admO = call(asAdm, "public.mf_overview('{}'::jsonb)");
  T.chk('shadow: an operator reviews everything', Array.isArray(admO.summaries) && admO.summaries.length > 0);
  T.chk('a non-operator cannot switch the mode', fails(() => asSub("select public.mf_admin_set_mode('live', 'x');")));

  /* ---------------------------------------------------------------- readers: live */
  call(asAdm, "public.mf_admin_set_mode('live', 'test')");
  T.chk('the switch is logged', +db.sql("select count(*) from public.mf_config_log where key = 'mode';") === 1);
  const ov = call(db.anon, "public.mf_overview('{}'::jsonb)");
  const keys = ov.summaries.map((s) => s.model_key);
  T.chk('live: anon reads summaries', ov.summaries.length > 0 && ov.mode === 'live');
  T.chk('live: a listed Collective model is shown', keys.indexOf('collective:' + CM_LISTED) >= 0);
  T.chk('live: an unlisted creator\'s model is not', keys.indexOf('collective:' + CM_UNLISTED) < 0);
  T.chk('live: a removed creator\'s model is not', keys.indexOf('collective:' + CM_REMOVED) < 0);
  T.chk('live: a model the Collective does not know is not (fail closed)', keys.indexOf('collective:44444444-4444-4444-4444-444444444444') < 0);
  T.chk('live: EdgeDesk models and the consensus are shown', keys.indexOf('tm_b') >= 0 && keys.some((k) => /^collective-consensus-/.test(k)));
  const ovNfl = call(db.anon, `public.mf_overview('{"market":"total"}'::jsonb)`);
  T.chk('filters: market', ovNfl.summaries.length > 0 && ovNfl.summaries.every((s) => s.market === 'total'));
  T.chk('a window other than all, 30d or 7d is refused', fails(() => db.anon(`select public.mf_overview('{"window":"99y"}'::jsonb);`)));

  const gAnon = call(db.anon, "public.mf_game('nfl', 'T_G1')");
  T.chk('live: anon reads a game\'s derived measurements', gAnon.found && gAnon.units.length > 0 && gAnon.full_access === false);
  T.chk('without Full Access the observation segments are withheld (coverage kept)', gAnon.game.series['draftkings:spread'].segments === undefined && gAnon.game.series['draftkings:spread'].segments_locked === true
    && gAnon.game.series['draftkings:spread'].n_observations === 8);
  T.chk('consensus members are not named to anon', !JSON.stringify(gAnon).includes('"members"'));
  T.chk('forecasts of unpublishable models are not in the game', !JSON.stringify(gAnon.game.forecasts).includes(CM_UNLISTED) && !JSON.stringify(gAnon.units).includes(CM_UNLISTED));
  const gNo = call(asNo, "public.mf_game('nfl', 'T_G1')");
  T.chk('a signed-in reader without Full Access gets no segments', gNo.full_access === false && gNo.game.series['draftkings:spread'].segments === undefined);
  const gSub = call(asSub, "public.mf_game('nfl', 'T_G1')");
  T.chk('Full Access reads the full timeline (every segment, raw prices)', gSub.full_access === true && gSub.game.series['draftkings:spread'].segments.length === 4
    && gSub.game.series['draftkings:spread'].segments[0].raw.price_home === -110);
  T.chk('…but still not consensus member names', !JSON.stringify(gSub).includes('"members"'));
  const gAdm = call(asAdm, "public.mf_game('nfl', 'T_G1')");
  T.chk('an operator sees consensus members', JSON.stringify(gAdm).includes('"members"'));
  call(asAdm, "public.mf_admin_set_public_timeline(true, 'test')");
  T.chk('the operator\'s public_timeline switch opens timelines to anon', call(db.anon, "public.mf_game('nfl', 'T_G1')").game.series['draftkings:spread'].segments.length === 4);
  call(asAdm, "public.mf_admin_set_public_timeline(false, 'test')");
  T.chk('an unknown game is not found', call(db.anon, "public.mf_game('nfl', 'NOPE')").found === false);

  const p1 = call(db.anon, "public.mf_games_list('{}'::jsonb, null, 2)");
  T.chk('games list: newest first, keyset paged', p1.items.length === 2 && !!p1.next && Date.parse(p1.items[0].kickoff) >= Date.parse(p1.items[1].kickoff));
  const p2 = call(db.anon, 'public.mf_games_list(\'{}\'::jsonb, ' + lit(p1.next) + ', 2)');
  T.chk('games list: the next page continues with no overlap', p2.items.length === 2 && p2.items.every((x) => p1.items.every((y) => y.event_id !== x.event_id)));
  T.chk('games list: a forged cursor is refused', fails(() => db.anon("select public.mf_games_list('{}'::jsonb, 'not-a-cursor!!', 5);")));
  T.chk('games list: the limit is bounded', call(db.anon, "public.mf_games_list('{}'::jsonb, null, 100000)").items.length <= 100);

  const md = call(db.anon, `public.mf_model('{"source":"edgedesk","model_key":"tm_a"}'::jsonb, null, 200)`);
  T.chk('model page: the complete record, misses and exclusions included', md.found && md.units.some((u) => u.status === 'excluded') && md.units.some((u) => u.status === 'measured')
    && md.counts.units === md.units.length);
  T.chk('model page: separate summaries, no composite score', md.summaries.length > 0 && md.summaries.every((s) => !('score' in s) && !('grade' in s)));
  T.chk('model page: an unlisted Collective model is not found', call(db.anon, 'public.mf_model(' + lit(JSON.stringify({ source: 'collective', model_key: 'collective:' + CM_UNLISTED })) + '::jsonb, null, 10)').found === false);
  const pg1 = call(db.anon, `public.mf_model('{"source":"edgedesk","model_key":"tm_a"}'::jsonb, null, 2)`);
  T.chk('model page: keyset paged', pg1.units.length === 2 && !!pg1.next);
  const em = call(db.anon, "public.mf_embed('edgedesk', 'tm_b')");
  T.chk('embed: top line with its sample, nothing more', em.found && em.rows.length > 0 && em.rows.every((r) => r.closer && 'measured' in r) && !JSON.stringify(em).includes('segments'));
  T.chk('embed: an unlisted model has none', call(db.anon, "public.mf_embed('collective', 'collective:" + CM_UNLISTED + "')").found === false);
  db.sql("update collective.creators set is_listed = false where slug = 'listed';");
  T.chk('a creator who unlists disappears at once (checked at read time)', call(db.anon, "public.mf_overview('{}'::jsonb)").summaries.every((s) => s.model_key !== 'collective:' + CM_LISTED));
  db.sql("update collective.creators set is_listed = true where slug = 'listed';");

  /* ---------------------------------------------------------------- operators */
  T.chk('only an operator lists the rules to verify', fails(() => asSub('select public.mf_admin_pending_rules();')));
  const pr = call(asAdm, 'public.mf_admin_pending_rules()');
  const dig = crypto.createHash('sha256').update('If the home team wins the game, including overtime, the market resolves Yes.', 'utf8').digest('hex');
  T.chk('pending rules: the linked market\'s rules text with its sha256, unverified', pr.installed && pr.rules.length === 1 && pr.rules[0].rules_sha256 === dig && pr.rules[0].verified === false);
  T.chk('a non-operator cannot verify a settlement', fails(() => asSub('select public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNFLGAME', sport: 'nfl', rules_sha256: dig, overtime: 'included', tie: 'push' })) + '::jsonb);')));
  const vv = call(asAdm, 'public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNFLGAME', sport: 'nfl', rules_sha256: dig, overtime: 'included', tie: 'push', note: 'read 2026-10-25' })) + '::jsonb)');
  T.chk('an operator verifies, stamped with who', vv.id > 0 && vv.verified_by === ADMIN);
  T.chk('the job reads the verifications', svc('public.mf_job_verifications()').length === 1);
  T.chk('pending rules now shows it verified', call(asAdm, 'public.mf_admin_pending_rules()').rules[0].verified === true);
  T.chk('a verification cannot be edited or deleted', fails(() => db.sql("update public.mf_settlement_verifications set tie = 'no';")) && fails(() => db.sql('delete from public.mf_settlement_verifications;')));
  T.chk('a malformed digest is refused', fails(() => asAdm('select public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNFLGAME', sport: 'nfl', rules_sha256: 'abc', overtime: 'included', tie: 'push' })) + '::jsonb);')));
  T.chk('operators see the runs', call(asAdm, 'public.mf_admin_runs(5)').length >= 2);

  /* ---------------------------------------------------------------- off */
  call(asAdm, "public.mf_admin_set_mode('off', 'rollback drill')");
  T.chk('off: the status says off and nothing else', JSON.stringify(call(db.anon, 'public.mf_status()')) === '{"mode":"off"}');
  T.chk('off: every reader door is locked', call(db.anon, "public.mf_overview('{}'::jsonb)").locked === true && call(asSub, "public.mf_game('nfl', 'T_G1')").locked === true
    && call(db.anon, "public.mf_embed('edgedesk', 'tm_b')").found === false);
  T.chk('off keeps every stored row (the switch is non-destructive)', +db.sql('select count(*) from public.mf_units;') === unitRows.length);

  /* ---------------------------------------------------------------- rollback */
  out = db.applyFile(F('market_foresight_rollback.sql'));
  T.chk('the rollback removes every mf object', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 2, out);
  T.chk('and leaves every source table as it was', db.sql('select (select count(*) from collective.models) || \'|\' || (select count(*) from public.kalshi_markets) || \'|\' || (select count(*) from public.kalshi_game_links);') === srcBefore);
  out = db.applyFile(F('market_foresight.sql'));
  T.chk('the layer installs again after a rollback', !/CHECK THIS/.test(out));
} catch (e) {
  T.chk('the suite ran to the end', false, String(e.message).slice(0, 2000));
} finally { db.stop(); }
process.exit(T.done());
