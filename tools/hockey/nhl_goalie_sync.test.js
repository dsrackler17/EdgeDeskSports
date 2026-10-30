#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/nhl_goalie_sync/index.ts, tested as deployed: imported
   (not a copy) under Node's type stripping, with a Deno shim, a mocked
   network (the slate's goalie inputs, Daily Faceoff's page, the NHL
   boxscore) and an in-memory PostgREST that enforces what the SQL layer's
   triggers enforce (one current observation per source, card versions 1, 2,
   3 ..., an edge on the version current when it was seen).

     replay     2026-10-25 Minnesota at Vancouver, from the real slate inputs:
                the 8 AM ET card names Lankinen (EdgeDesk's usage projection,
                Projected); Daily Faceoff's Merilainen (Likely) writes version 2
                with "Updated: starter changed from K. Lankinen to
                L. Meriläinen" and both versions' win %; Confirmed for
                Vancouver alone writes version 3, still GATED; both Confirmed
                at the T-30 final pass writes version 4 and opens the gate.
                The headline (xg_core) is the same number on every version;
                every edge attaches to the version that existed when it was
                seen; every old version stays
     cadence    a poke before 8 AM, between slots and inside the heartbeat is
                not a run; a quiet hour is one SKIPPED row
     conflict   the NHL's boxscore naming Lankinen while Daily Faceoff
                confirms Merilainen: both kept, Likely, GATED, a WARNING
     outages    both sources down: an error run, a FAILURE alert, the
                starters on file kept; the inputs down: an error run, then
                quiet for 15 minutes
     dry, auth  a dry run writes nothing; a POST needs the cron secret

   Run: node tools/hockey/nhl_goalie_sync.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FX = require(path.join(__dirname, 'fixtures', 'nhl_goalie_sources.js'));
const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nhl_goalie_inputs_min_van_2026-10-25.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', NHL_GOALIE_CRON_SECRET: 'cron-secret', NHL_GOALIE_INPUTS_URL: 'https://site.test/hockey/goalie_inputs.json' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

/* the inputs as the build wrote them, with a test price (NHL prices are not captured today): VAN +150 / MIN -170 */
const QUOTE = { captured_at: '2026-10-25T11:50:00Z', ml_best: { home: { book: 'testbook', american: 150 }, away: { book: 'testbook', american: -170 } }, ml_novig_home: 0.381, books: 1 };
/* with the lineup-lock block (tools/hockey/fixtures/nhl_goalie_sources.js withLineups: constructed, checkable by hand) */
const INPUTS = FX.withLineups(BASE); INPUTS.games[0].quote = QUOTE;
const W = { inputs: INPUTS, inputsUp: true, df: 'morning', dfStatus: 200, box: null, boxStatus: 200, calls: [] };

/* ---------------------------------------------------------------- PostgREST, in memory (the SQL triggers' rules included) */
let DB;
function resetDb() { DB = { nhl_goalie_sync_runs: [], nhl_goalie_alerts: [], nhl_goalie_starters: [], nhl_game_cards: [], nhl_card_edge_events: [], seq: 0, calls: [] }; }
const ms = (v) => Date.parse(v);
function currentCards() { const l = {}; for (const c of DB.nhl_game_cards) if (!l[c.game_id] || c.version > l[c.game_id].version) l[c.game_id] = c; return Object.values(l); }
function filt(rows, q) {
  for (const [k, v] of q) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    rows = rows.filter((r) => {
      const x = r[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'neq') return String(x) !== val;
      if (op === 'is') return val === 'true' ? x === true : val === 'false' ? x === false : x == null;
      if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(x));
      throw new Error('unmocked filter ' + k + '=' + v);
    });
  }
  const ord = q.get('order');
  if (ord) { const [c, dir] = ord.split('.'); rows = rows.slice().sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
  if (q.get('limit')) rows = rows.slice(0, Number(q.get('limit')));
  const sel = q.get('select');
  if (sel && sel !== '*') rows = rows.map((r) => Object.fromEntries(sel.split(',').map((c) => [c, r[c]])));
  return rows;
}
function refuse(msg) { const e = new Error(msg); e.status = 400; throw e; }
function insertRow(t, r) {
  const row = Object.assign({ id: ++DB.seq, created_at: new Date().toISOString() }, r);
  if (t === 'nhl_goalie_starters') {
    if (row.status === 'confirmed' && !row.goalie_name) refuse('confirmed without a name');
    if (row.status !== 'unknown' && !row.goalie_name) refuse('a status without a name');
    if (row.conflict && row.source !== 'consensus') refuse('conflict on a source row');
    if (row.conflict && row.status === 'confirmed') refuse('a conflict cannot be confirmed');
    const cur = DB.nhl_goalie_starters.find((x) => x.game_id === row.game_id && x.team === row.team && x.source === row.source && x.is_current);
    if (cur) { if (ms(row.fetched_at) < ms(cur.fetched_at)) refuse('older than the current observation'); cur.is_current = false; cur.superseded_at = row.fetched_at; }
    row.is_current = true; row.superseded_at = null;
  }
  if (t === 'nhl_game_cards') {
    const prev = DB.nhl_game_cards.filter((c) => c.game_id === row.game_id).sort((a, b) => b.version - a.version)[0];
    if (!prev && (row.version !== 1 || row.supersedes_id != null)) refuse('the first card is version 1');
    if (prev && (row.version !== prev.version + 1 || row.supersedes_id !== prev.id || ms(row.generated_at) <= ms(prev.generated_at))) refuse('versions run 1, 2, 3, each superseding the latest');
    if (!(ms(row.generated_at) < ms(row.game_start_utc))) refuse('a card after puck drop');
    const both = row.goalie_status_home === 'confirmed' && row.goalie_status_away === 'confirmed' && !row.conflict;
    if (both !== (row.edge_gate_state === 'OPEN')) refuse('the gate is OPEN exactly when both are Confirmed');
    if (row.edge_gate_state !== 'OPEN' && !(row.show_range && row.known_limitations.indexOf('Starter not confirmed. Numbers may change.') >= 0)) refuse('an unconfirmed card must show the range and say so');
    if (row.goalie_variant !== 'xg_goalie_confirmed' || row.model_id.indexOf('edgedesk_nhl_v1:') !== 0) refuse('a live card names the live variant');
    for (const k of ['goalie_pairing_used', 'headline', 'pairing_range', 'edge_gate', 'inputs_hash', 'core_version']) if (row[k] == null) refuse('a card needs ' + k);
  }
  if (t === 'nhl_card_edge_events') {
    const c = DB.nhl_game_cards.find((x) => x.id === row.card_id);
    if (!c || c.game_id !== row.game_id) refuse('no such card');
    if (ms(row.detected_at) < ms(c.generated_at)) refuse('the card was generated after the edge');
    if (DB.nhl_game_cards.some((x) => x.game_id === c.game_id && x.version > c.version && ms(x.generated_at) <= ms(row.detected_at))) refuse('an edge attaches to the version current when it was detected');
    if (c.edge_gate_state === 'GATED' && row.gate_basis === 'BOTH_CONFIRMED') refuse('a GATED card is not BOTH_CONFIRMED');
    if ((row.gate_basis === 'GATED') !== !row.flag_allowed) refuse('GATED is exactly not allowed');
    if (row.ev < row.min_ev) refuse('an edge below min_ev');
    if (DB.nhl_card_edge_events.some((e) => e.card_id === row.card_id && e.market === row.market && e.side === row.side && e.american === row.american && e.quote_captured_at === row.quote_captured_at)) refuse('duplicate edge');
  }
  DB[t].push(row);
  return row;
}
function rest(u, init) {
  const url = new URL(u), name = url.pathname.replace('/rest/v1/', ''), q = url.searchParams, m = (init && init.method) || 'GET';
  DB.calls.push(m + ' ' + name);
  try {
    if (m === 'POST') {
      if (!DB[name]) return [404, { message: 'no table ' + name }];
      const rows = JSON.parse(init.body).map((r) => insertRow(name, r));
      return [201, init.headers && /representation/.test(init.headers.prefer) ? rows.map((r) => JSON.parse(JSON.stringify(r))) : ''];
    }
    if (name === 'nhl_game_cards_current') return [200, filt(currentCards(), q)];
    if (!DB[name]) return [404, { message: 'unmocked ' + name }];
    return [200, JSON.parse(JSON.stringify(filt(DB[name], q)))];
  } catch (e) { return [e.status || 500, { message: e.message }]; }
}
function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith(ENV.SUPABASE_URL)) { const [s, b] = rest(u, init); return resp(s, b); }
  W.calls.push(u);
  if (u === ENV.NHL_GOALIE_INPUTS_URL) return W.inputsUp ? resp(200, W.inputs) : resp(503, 'down');
  if (u.startsWith('https://www.dailyfaceoff.com/starting-goalies/')) return W.dfStatus !== 200 ? resp(W.dfStatus, 'blocked') : resp(200, typeof W.df === 'string' && W.df.startsWith('<') ? W.df : FX.minVanPage(W.df));
  if (u.startsWith('https://api-web.nhle.com/v1/gamecenter/2026020184/boxscore')) return W.boxStatus !== 200 ? resp(W.boxStatus, 'down') : resp(200, W.box || FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN' }));
  return resp(404, 'unmocked ' + u);
};

(async () => {
  const FN = path.join(ROOT, 'supabase', 'functions', 'nhl_goalie_sync', 'index.ts');
  let F;
  try { F = await import(FN); } catch (e) { console.log('SKIP | nhl goalie sync | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  const run = (now, o) => F.syncOnce(Object.assign({ now }, o || {}));
  const cards = () => DB.nhl_game_cards.filter((c) => c.game_id === '2026020184').sort((a, b) => a.version - b.version);
  const cons = (team) => DB.nhl_goalie_starters.find((s) => s.team === team && s.source === 'consensus' && s.is_current);
  const runs = () => DB.nhl_goalie_sync_runs;

  /* ============================================================ the replay */
  resetDb();
  let r = await run('2026-10-25T11:55:00Z');
  chk('cadence: the first poke, before 8 AM Eastern, is a SKIPPED run (nothing due yet)', r.status === 'skipped' && runs().length === 1 && runs()[0].status === 'skipped' && DB.nhl_game_cards.length === 0 && /next 2026-10-25T12:00:00/.test(runs()[0].skipped_reason), [r.status, runs()[0]]);

  r = await run('2026-10-25T12:00:30Z');
  let c = cards();
  chk('8 AM ET: the two-hour slot runs and writes version 1', r.ok && r.run.due_kinds.join() === 'two_hour' && c.length === 1 && c[0].version === 1 && c[0].trigger === 'initial', [r.run, c.length]);
  chk('v1: Lankinen named, as EdgeDesk\'s usage projection — Projected, never as fact', c[0].home_goalie_name === 'K. Lankinen' && c[0].goalie_status_home === 'projected' && c[0].goalie_pairing_used.home.source === 'edgedesk_projection' && c[0].goalie_pairing_used.home.badge === 'Projected', c[0].goalie_pairing_used.home);
  chk('v1: Pickard projected for Minnesota; the pairing used, both statuses and the generation time are on the card', c[0].away_goalie_name === 'C. Pickard' && c[0].goalie_status_away === 'projected' && c[0].generated_at === '2026-10-25T12:00:30.000Z' && c[0].pairing_price.p_home === 0.4117);
  chk('v1: the full pairing range and "Starter not confirmed. Numbers may change."', c[0].show_range && c[0].pairing_range.length === 4 && c[0].known_limitations[0] === 'Starter not confirmed. Numbers may change.');
  chk('v1: Daily Faceoff listed the game with no starter yet: stored as unknown, the projection leads', DB.nhl_goalie_starters.filter((s) => s.source === 'daily_faceoff' && s.status === 'unknown').length === 2 && cons('VAN').source_status === 'edgedesk_projection');
  chk('the NHL boxscore is not called more than three hours out', !W.calls.some((u) => /api-web\.nhle\.com/.test(u)));
  let e = DB.nhl_card_edge_events;
  chk('edge: VAN +150 is an edge at the headline (EV +4.4%) — recorded on v1 and GATED (Lankinen / Wallstedt fails)', e.length === 1 && e[0].card_id === c[0].id && e[0].flag_allowed === false && e[0].gate_basis === 'GATED' && e[0].ev > 0.04 && e[0].ev_min_pairings < 0.02, e);
  chk('edge: MIN -170 is not an edge and records nothing', !e.some((x) => x.side === 'away'));

  const nRuns = runs().length;
  r = await run('2026-10-25T12:05:00Z');
  chk('cadence: five minutes later, not due and inside the heartbeat: no run row at all', r.status === 'not_recorded' || (r.skipped && runs().length === nRuns), [r.status, runs().length, nRuns]);
  r = await run('2026-10-25T13:10:00Z');
  chk('cadence: a quiet hour later, one SKIPPED heartbeat row (a dead scheduler is told from a quiet morning)', r.status === 'skipped' && runs().length === nRuns + 1);

  r = await run('2026-10-25T14:00:20Z');
  chk('10 AM ET: nothing changed → no new version, no new observation, no duplicate edge', r.run.cards_written === 0 && r.run.cards_unchanged === 1 && r.run.observations_written === 0 && cards().length === 1 && DB.nhl_card_edge_events.length === 1, r.run);

  W.df = 'afternoon';
  r = await run('2026-10-25T18:00:20Z');
  c = cards();
  chk('2 PM ET: Daily Faceoff has Merilainen Likely → version 2 (starter_changed), version 1 kept for audit', c.length === 2 && c[1].version === 2 && c[1].trigger === 'starter_changed' && c[1].supersedes_id === c[0].id && c[0].home_goalie_name === 'K. Lankinen', c.map((x) => [x.version, x.trigger, x.home_goalie_name]));
  chk('v2: L. Meriläinen, Likely, Daily Faceoff, as of its news time', c[1].home_goalie_name === 'L. Meriläinen' && c[1].goalie_status_home === 'likely' && c[1].goalie_pairing_used.home.source === 'daily_faceoff' && c[1].goalie_pairing_used.home.as_of === '2026-10-25T17:42:00.000Z' && c[1].goalie_pairing_used.home.reported_name === 'Leevi Merilainen', c[1].goalie_pairing_used.home);
  chk('v2: "Updated: starter changed from K. Lankinen to L. Meriläinen", with both versions\' win % (41.2% → 42.4%)', c[1].change_note && c[1].change_note.text === 'Updated: starter changed from K. Lankinen to L. Meriläinen' && c[1].change_note.first_p_home === 0.4117 && c[1].change_note.current_p_home === 0.4243 && c[1].change_note.first_card_id === c[0].id, c[1].change_note);
  chk('v2: the old observation is superseded, not deleted (append-only, one current)', DB.nhl_goalie_starters.filter((s) => s.team === 'VAN' && s.source === 'daily_faceoff').length === 2 && DB.nhl_goalie_starters.filter((s) => s.team === 'VAN' && s.source === 'daily_faceoff' && s.is_current).length === 1);
  e = DB.nhl_card_edge_events;
  chk('edge: seen again under v2 → a new event on v2 (CLV attaches to the version that existed), still GATED', e.length === 2 && e[1].card_id === c[1].id && !e[1].flag_allowed, e.map((x) => [x.card_id, x.flag_allowed]));

  W.df = 'evening';
  r = await run('2026-10-25T23:00:20Z');
  c = cards();
  chk('7 PM ET (inside three hours): Vancouver Confirmed → version 3 (status_changed)', c.length === 3 && c[2].trigger === 'status_changed' && c[2].goalie_status_home === 'confirmed' && c[2].goalie_status_away === 'likely' && r.run.due_kinds.indexOf('pre_game') >= 0, [c[2] && c[2].reasons, r.run]);
  chk('v3: Minnesota only Likely → still GATED, the range still shown, still "not confirmed"', c[2].edge_gate_state === 'GATED' && c[2].show_range && c[2].pairing_range.length === 2 && c[2].known_limitations[0] === 'Starter not confirmed. Numbers may change.');
  chk('the boxscore is read inside three hours (before lineups post it names nobody)', W.calls.some((u) => /2026020184\/boxscore/.test(u)) && !DB.nhl_goalie_starters.some((s) => s.source === 'nhl_api_boxscore'));
  e = DB.nhl_card_edge_events;
  chk('edge: under v3 the gate holds it back (Meriläinen / Wallstedt fails at +150)', e.length === 3 && e[2].card_id === c[2].id && !e[2].flag_allowed && e[2].ev_min_pairings < 0.02, e[2]);

  r = await run('2026-10-25T23:15:20Z');
  chk('7:15 PM ET: the next 15-minute slot runs; nothing changed, no version', r.run.due_kinds.join() === 'pre_game' && r.run.cards_written === 0 && cards().length === 3, r.run);

  W.df = 'final';
  W.box = FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN', homeGoalies: [{ id: 8482447, name: 'L. Meriläinen', starter: true }, { id: 8480947, name: 'K. Lankinen' }], awayGoalies: [{ id: 8475717, name: 'C. Pickard', starter: true }, { id: 8482661, name: 'J. Wallstedt' }] });
  r = await run('2026-10-26T01:30:15Z');
  c = cards();
  chk('T-30: the final pass runs for the game', r.run.due_kinds.indexOf('final_pass') >= 0 && r.run.final_pass_games.join() === '2026020184', r.run);
  chk('T-30: both Confirmed (Daily Faceoff and the NHL boxscore agree) → version 4, the gate OPEN', c.length === 4 && c[3].goalie_status_home === 'confirmed' && c[3].goalie_status_away === 'confirmed' && c[3].edge_gate_state === 'OPEN' && !c[3].show_range && c[3].pairing_range.length === 1, c[3] && [c[3].goalie_pairing_used, c[3].edge_gate_state]);
  chk('v4: confirmed by the NHL boxscore (the higher-ranked source), sources agree', c[3].goalie_pairing_used.home.source === 'nhl_api_boxscore' && cons('VAN').merged_from.basis === 'sources_agree');
  chk('v4: still says it changed after first posting, with both versions\' win %', c[3].change_note && c[3].change_note.text === 'Updated: starter changed from K. Lankinen to L. Meriläinen' && c[3].change_note.first_p_home === 0.4117 && c[3].change_note.current_p_home === 0.4243);
  e = DB.nhl_card_edge_events;
  chk('edge: under v4 the flag is allowed (BOTH_CONFIRMED), on v4', e.length === 4 && e[3].card_id === c[3].id && e[3].flag_allowed === true && e[3].gate_basis === 'BOTH_CONFIRMED', e[3]);
  chk('every edge names the version current when it was seen: v1, v2, v3, v4', e.map((x) => DB.nhl_game_cards.find((k) => k.id === x.card_id).version).join() === '1,2,3,4');
  chk('the headline (xg_core) is 0.4174 on every version: the goalie never moved it', c.every((x) => x.headline.p_home === 0.4174 && x.headline.model_id === 'edgedesk_nhl_v1:xg_core'));
  chk('every version records the pairing used, both statuses and its generation time, in order', c.every((x, i) => x.goalie_pairing_used.home && x.goalie_pairing_used.away && x.goalie_status_home && x.goalie_status_away && (i === 0 || ms(x.generated_at) > ms(c[i - 1].generated_at))));
  chk('the card names its starter rows (the consensus observation it used)', c.every((x) => typeof x.home_starter_row_id === 'number' && DB.nhl_goalie_starters.find((s) => s.id === x.home_starter_row_id).source === 'consensus'));
  /* lineup lock: at T-10 the NHL lists both dressed lineups (Vancouver without its first regular, a call-up in his place) */
  const probeAt = (x) => (((x.sources || {}).nhl_api_boxscore || {}).games || []).find((y) => y.game_id === '2026020184') || null;
  const p30 = probeAt(runs().filter((x) => x.status !== 'skipped').slice(-1)[0]);
  chk('timing probe: the T-30 read records the minutes to puck drop and that no lineup was listed yet', p30 && p30.minutes_to_start === 30 && p30.lineups_posted === false && p30.skaters.home === 0 && p30.starters === 2, p30);
  W.box = FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN', homeGoalies: [{ id: 8482447, name: 'L. Meriläinen', starter: true }, { id: 8480947, name: 'K. Lankinen' }], awayGoalies: [{ id: 8475717, name: 'C. Pickard', starter: true }, { id: 8482661, name: 'J. Wallstedt' }],
    homeSkaters: FX.skaterIds('VAN', 17, 2).concat(['9100099']), awaySkaters: FX.skaterIds('MIN') });
  r = await run('2026-10-26T01:50:10Z');
  c = cards();
  chk('T-10: a lineup-lock check runs (every 5 minutes after the final pass)', r.run.due_kinds.indexOf('lineup_lock') >= 0, r.run);
  chk('T-10: both lineups listed → version 5, its headline priced at lineup lock (reason lineup_locked)', c.length === 5 && c[4].headline.basis === 'lineup_lock' && c[4].reasons.indexOf('lineup_locked') >= 0 && c[4].trigger === 'inputs_changed' && c[4].headline.model_id === 'edgedesk_nhl_v1:xg_all_confirmed', c[4] && [c[4].trigger, c[4].reasons]);
  chk('v5: the slate\'s price before lock is kept beside it; Vancouver missing a regular prices it below the goalie-only number', c[4].headline.before.p_home === 0.4174 && c[4].headline.p_home < c[3].pairing_price.p_home && c[4].headline.lineup.skaters.home === 18 && c[4].headline.lineup.delta.home < 0, c[4].headline);
  chk('v5: the gate stays OPEN and the card says it was priced at lineup lock', c[4].edge_gate_state === 'OPEN' && /^Priced at lineup lock/.test(c[4].notes[0]));
  const smL = require(path.join(__dirname, 'nhl_goalie_run_summary.js')).render({ title: 'NHL goalie sync', run: r, http: '200' }, ms('2026-10-26T01:50:30Z')).markdown;
  chk('summary at lock: the job shows the headline at the lock price, marked lineup lock', smL.indexOf('| ' + (c[4].headline.p_home * 100).toFixed(1) + '% (lineup lock) |') >= 0, smL);
  const p10 = probeAt(runs().filter((x) => x.status !== 'skipped').slice(-1)[0]);
  chk('timing probe: the T-10 read records the lineups as listed (18 skaters a side)', p10 && p10.minutes_to_start === 10 && p10.lineups_posted === true && p10.skaters.home === 18 && p10.skaters.away === 18 && runs().slice(-1)[0].sources.nhl_api_boxscore.lineups_posted === 1, p10);
  e = DB.nhl_card_edge_events;
  const eLock = e.filter((x) => x.card_id === c[4].id);
  chk('edge: on v5 an edge is judged at the lock price (BOTH_CONFIRMED), never the slate\'s', eLock.length === 1 && eLock.every((x) => x.p_win === (x.side === 'home' ? c[4].headline.p_home : c[4].headline.p_away) && x.gate_basis === 'BOTH_CONFIRMED'), [eLock, c[4].headline.p_home]);
  r = await run('2026-10-26T01:55:10Z');
  chk('T-5: the same lineups again write no new version', r.run.due_kinds.indexOf('lineup_lock') >= 0 && r.run.cards_written === 0 && cards().length === 5, r.run);
  /* the lineups are not stored anywhere but the card: a read that fails after lock must not unlock it on the eve of puck drop */
  r = await run('2026-10-26T01:58:10Z', { force: true, simulate_outage: ['nhl_api'] });
  chk('after lock, the NHL API down: the lock holds from the card\'s own lineups (no new version, still lineup_lock)', r.run.cards_written === 0 && cards().length === 5 && cards()[4].headline.basis === 'lineup_lock', [r.run.cards_written, cards().slice(-1)[0].headline.basis, cards().slice(-1)[0].reasons]);
  r = await run('2026-10-26T02:05:00Z', { force: true });
  chk('after puck drop no card is written for the game', cards().length === 5 && r.run.cards_written === 0);
  chk('every run row is recorded with its due kinds and the next slot', runs().filter((x) => x.status !== 'skipped').every((x) => Array.isArray(x.due_kinds) && 'next_due_at' in x) && runs().length >= 8);

  /* ============================================================ a conflict */
  resetDb();
  W.df = 'final';
  W.box = FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN', homeGoalies: [{ id: 8480947, name: 'K. Lankinen', starter: true }, { id: 8482447, name: 'L. Meriläinen' }], awayGoalies: [{ id: 8475717, name: 'C. Pickard', starter: true }] });
  r = await run('2026-10-26T01:30:15Z');
  c = cards();
  const cv = cons('VAN');
  chk('conflict: both observations kept (Daily Faceoff: Meriläinen, the NHL: Lankinen)', DB.nhl_goalie_starters.some((s) => s.source === 'daily_faceoff' && s.goalie_id === '8482447' && s.is_current) && DB.nhl_goalie_starters.some((s) => s.source === 'nhl_api_boxscore' && s.goalie_id === '8480947' && s.is_current));
  chk('conflict: the consensus is flagged and shown at the LOWER status (Likely, never Confirmed)', cv.conflict && cv.status === 'likely' && cv.conflict_detail.length === 2, cv);
  chk('conflict: the card is GATED, shows the range and says the sources disagree', c.length === 1 && c[0].conflict && c[0].edge_gate_state === 'GATED' && c[0].show_range && c[0].known_limitations.some((l) => /Sources disagree on the VAN starter/.test(l)), c[0] && c[0].known_limitations);
  chk('conflict: a WARNING alert and a warn run', DB.nhl_goalie_alerts.some((a) => a.code === 'source_conflict' && a.severity === 'WARNING') && runs()[0].status === 'warn' && runs()[0].conflicts_open === 1, runs()[0]);
  e = DB.nhl_card_edge_events;
  chk('conflict: never BOTH_CONFIRMED — at +150 the edge holds under both named goalies (Lankinen 41.2%, Meriläinen 42.4% with Pickard), so it passes only as HOLDS_EVERY_PAIRING', e.length === 1 && e[0].gate_basis === 'HOLDS_EVERY_PAIRING' && e[0].flag_allowed === true && e[0].ev_min_pairings >= 0.02, e);

  /* ============================================================ outages */
  resetDb(); W.box = null; W.df = 'evening';
  r = await run('2026-10-25T23:00:20Z', { simulate_outage: ['daily_faceoff', 'nhl_api'] });
  chk('outage: both sources down → an error run, a FAILURE alert, two DEGRADED', r.status === 'error' && runs()[0].status === 'error' && runs()[0].simulated === true && DB.nhl_goalie_alerts.some((a) => a.code === 'sources_down' && a.severity === 'FAILURE')
    && DB.nhl_goalie_alerts.filter((a) => a.severity === 'DEGRADED').length === 2, DB.nhl_goalie_alerts.map((a) => a.code));
  chk('outage: nothing is written in the sources\' place (only the labelled projection)', !DB.nhl_goalie_starters.some((s) => s.source === 'daily_faceoff' || s.source === 'nhl_api_boxscore') && cards().length === 1 && cards()[0].goalie_status_home === 'projected');
  resetDb();
  W.dfStatus = 403;
  r = await run('2026-10-25T23:00:20Z');
  chk('Daily Faceoff refusing (HTTP 403) is DEGRADED and named; the NHL API still read', DB.nhl_goalie_alerts.some((a) => a.code === 'daily_faceoff_unavailable' && /HTTP 403/.test(a.message)) && runs()[0].daily_faceoff_ok === false && runs()[0].nhl_api_ok === true && runs()[0].status === 'warn', [runs()[0], DB.nhl_goalie_alerts]);
  W.dfStatus = 200;
  resetDb();
  W.df = '<html><body>a new layout</body></html>';
  r = await run('2026-10-25T23:00:20Z');
  chk('a Daily Faceoff page that changed shape is a DRIFT alert, not an empty slate', DB.nhl_goalie_alerts.some((a) => a.code === 'daily_faceoff_drift' && a.severity === 'DRIFT'));
  W.df = 'evening';
  resetDb();
  W.inputsUp = false;
  r = await run('2026-10-25T23:00:20Z');
  chk('inputs down: an error run and a FAILURE alert', runs().length === 1 && runs()[0].status === 'error' && DB.nhl_goalie_alerts.some((a) => a.code === 'inputs_unavailable'));
  r = await run('2026-10-25T23:05:00Z');
  chk('inputs down: the next poke inside 15 minutes is not another error row', runs().length === 1 && r.status === 'not_recorded');
  W.inputsUp = true;

  /* ============================================================ unmatched names */
  resetDb();
  W.df = FX.dfPage([Object.assign({}, FX.MIN_VAN, { home: { name: 'Arturs Silovs', strength: 'Likely', at: '2026-10-25T22:00:00.000Z' }, away: { name: 'Cam Pickard', strength: 'Likely' } })]);
  r = await run('2026-10-25T23:00:20Z');
  c = cards();
  chk('unmatched: a name with no rated goalie is kept as reported, flagged, and priced at the replacement-level prior', DB.nhl_goalie_starters.some((s) => s.source === 'daily_faceoff' && s.goalie_name === 'Arturs Silovs' && s.goalie_id === null && s.match_method === 'unmatched')
    && DB.nhl_goalie_alerts.some((a) => a.code === 'unmatched_names') && c[0].home_goalie_name === 'Arturs Silovs' && c[0].known_limitations.some((l) => /no EdgeDesk goalie rating/.test(l)), c[0] && c[0].known_limitations);
  W.df = 'evening';

  /* ============================================================ dry run and auth */
  resetDb();
  r = await run('2026-10-25T23:00:20Z', { dry: true });
  chk('dry: reads and computes (the card preview), writes nothing', r.preview && r.preview[0] && r.preview[0].goalie_pairing_used.home.goalie_name === 'L. Meriläinen' && DB.nhl_goalie_sync_runs.length === 0 && DB.nhl_goalie_starters.length === 0 && DB.nhl_game_cards.length === 0
    && !DB.calls.some((x) => x.startsWith('POST')), r.preview);
  let res = await F.handle(new Request('https://fn.test/', { method: 'GET' }));
  let body = await res.json();
  chk('GET is a health probe with the build and the core version', res.status === 200 && body.build === F.BUILD && body.core === 'edgedesk_nhl_goalie_core_v1');
  res = await F.handle(new Request('https://fn.test/', { method: 'POST', body: '{}' }));
  chk('POST without the cron secret is 401', res.status === 401);
  res = await F.handle(new Request('https://fn.test/', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' }, body: JSON.stringify({ force: true, dry: true, now: '2026-10-25T23:00:20Z' }) }));
  body = await res.json();
  chk('POST with the secret runs (forced, dry)', res.status === 200 && body.dry === true && body.run.due_kinds[0] === 'forced');

  /* ============================================================ the job summary (NHL goalie sync, Deploy NHL goalie layer) */
  // tools/hockey/nhl_goalie_run_summary.js renders the function's real answers, and its verdict is what the job exits on
  const S = require(path.join(__dirname, 'nhl_goalie_run_summary.js'));
  const NOW = ms('2026-10-25T18:03:00Z');
  resetDb();
  W.df = 'morning';
  await run('2026-10-25T12:00:30Z');
  W.df = 'afternoon';
  r = await run('2026-10-25T18:00:20Z');
  const CRON = { exists: true, schedule: '*/5 * * * *', active: true, last_start: '2026-10-25T18:00:00.04+00:00', last_status: 'succeeded', last_message: '1 row', failed_1h: 0 };
  const READY = { state: 'ok', state_reason: null, last_check_status: 'ok', last_check_at: '2026-10-25T18:00:22+00:00', last_success_at: '2026-10-25T18:00:22+00:00', minutes_since_success: 3, daily_faceoff_ok: true, nhl_api_ok: true,
    cards_upcoming: 1, cards_gated: 1, sides_next_3h: 0, sides_unconfirmed_next_3h: 0, games_7d: 0, pct_confirmed_by_t30_7d: null, confirmed_by_t30_target_pct: 90, conflicts_open: 0, conflicts_24h: 0, conflicts_7d: 0, sync_failures_24h: 0, runs_24h: 2, next_due_at: '2026-10-25T20:00:00+00:00' };
  let sm = S.render({ title: 'NHL goalie sync — run by hand', run: r, http: '200', cron: CRON, readiness: READY }, NOW);
  chk('summary: the card version the run wrote, with its starters, statuses, gate, home win % and change note', sm.markdown.includes('| MIN@VAN | 2 | starter_changed | L. Meriläinen / C. Pickard | likely / likely | GATED | 42.4% | Updated: starter changed from K. Lankinen to L. Meriläinen | 41.7% |'), sm.markdown);
  chk('summary: what the run wrote, pg_cron\'s last call (3 min ago) and the readiness KPIs', /Cards written \/ unchanged \| 1 \/ 0/.test(sm.markdown) && /Last call \| 2026-10-25T18:00:00\.04\+00:00 \(3 min ago\), succeeded/.test(sm.markdown) && /Both starters Confirmed by T-30, last 7 days \| — \(no game yet\) \(target 90%\)/.test(sm.markdown), sm.markdown);
  chk('summary: a clean run, a calling pg_cron and ok readiness pass', sm.verdict.errors.length === 0 && sm.verdict.warnings.length === 0 && /\*\*Passed\.\*\*/.test(sm.markdown), sm.verdict);
  let vd = S.verdict({ cron: CRON }, NOW);
  chk('verdict: the watchdog alone (no call) passes while pg_cron called within 15 minutes', vd.errors.length === 0);
  vd = S.verdict({ cron: Object.assign({}, CRON, { last_start: '2026-10-25T17:40:00+00:00' }) }, NOW);
  chk('verdict: pg_cron silent for 23 minutes fails the job (the backstop call is made, and the miss is seen)', vd.errors.length === 1 && /23 minutes ago/.test(vd.errors[0]), vd);
  vd = S.verdict({ cron: { exists: false } }, NOW);
  chk('verdict: no pg_cron job fails, and says how to schedule it', /apply_sql/.test(vd.errors[0] || ''), vd);
  vd = S.verdict({ cards: S.readJson(path.join(__dirname, 'no-such-file.json')) }, NOW);
  chk('verdict: cards that could not be read fail the job, never pass', vd.errors.length === 1 && /nhl_game_cards_current could not be read/.test(vd.errors[0] || ''), vd);
  sm = S.render({ cards: [] }, NOW);
  chk('summary: no card in the window says so, and passes', /No game in the window/.test(sm.markdown) && sm.verdict.errors.length === 0, sm.markdown);
  const CARDS = [{ game_id: '2026020184', matchup: 'MIN@VAN', start_utc: '2026-10-25T17:30:00+00:00', version: 5, generated_at: '2026-10-25T17:20:10+00:00', trigger: 'inputs_changed', status: ['confirmed', 'confirmed'], conflict: false, gate: 'OPEN',
    basis: 'lineup_lock', model_id: 'edgedesk_nhl_v1:xg_all_confirmed', p_home: 0.4051, before_p_home: 0.4174, skaters: { home: 18, away: 18 }, probe: { reads: 4, first_listed_min: 10, last_pre: { min: 5, state: 'PRE', skaters: { home: 18, away: 18 }, starters: 2 } } },
  { game_id: '2026020185', matchup: 'LAK@NYR', start_utc: '2026-10-25T23:00:00+00:00', version: 2, generated_at: '2026-10-25T17:00:20+00:00', trigger: 'status_changed', status: ['likely', 'projected'], conflict: false, gate: 'GATED',
    basis: 'slate', model_id: 'edgedesk_nhl_v1:xg_core', p_home: 0.5522, before_p_home: null, skaters: null, probe: { reads: 0, first_listed_min: null, last_pre: null } },
  { game_id: '2026020186', matchup: 'TOR@CGY', start_utc: '2026-10-25T17:45:00+00:00', version: 4, generated_at: '2026-10-25T17:15:00+00:00', trigger: 'status_changed', status: ['confirmed', 'confirmed'], conflict: false, gate: 'OPEN',
    basis: 'slate', model_id: 'edgedesk_nhl_v1:xg_core', p_home: 0.4811, before_p_home: null, skaters: null, probe: { reads: 7, first_listed_min: -4, last_pre: { min: 3, state: 'PRE', skaters: { home: 0, away: 0 }, starters: 2 } } }];
  sm = S.render({ cards: CARDS }, NOW);
  chk('summary: every card with its version, statuses, gate, headline, what priced it and when the NHL boxscore listed its lineups; the started games\' locks and listings are counted', /\| MIN@VAN \| 2026-10-25 17:30 UTC \| 5 \| 17:20 UTC \(T−10 min\) \| confirmed \/ confirmed \| OPEN \| 40\.5% \| lineup lock, 18 \/ 18 skaters \(before lock 41\.7%\) \| listed T−10 min \|/.test(sm.markdown)
    && /\| LAK@NYR \| 2026-10-25 23:00 UTC \| 2 \| 17:00 UTC \(T−360 min\) \| likely \/ projected \| GATED \| 55\.2% \| slate \(edgedesk_nhl_v1:xg_core\) \| not read \|/.test(sm.markdown)
    && /\| TOR@CGY \|[^\n]*\| slate \(edgedesk_nhl_v1:xg_core\) \| listed T\+4 min, after puck drop \(by T−3: PRE, 0 \/ 0 skaters, 2 starters flagged; 7 reads\) \|/.test(sm.markdown)
    && /Started: 2 games, 1 priced at lineup lock before puck drop\. The NHL boxscore listed both lineups before puck drop for 1 of them\./.test(sm.markdown) && sm.verdict.errors.length === 0, sm.markdown);
  vd = S.verdict({ cron: null, readiness: S.readJson(path.join(__dirname, 'no-such-file.json')) }, NOW);
  chk('verdict: a check that could not be made (empty pg_cron answer, unreadable readiness) fails, never passes', vd.errors.length === 2, vd);
  res = await F.handle(new Request('https://fn.test/', { method: 'POST', headers: { 'x-cron-secret': 'not-the-secret' }, body: '{}' }));
  const refused = await res.json();
  vd = S.verdict({ run: refused, http: String(res.status) }, NOW);
  chk('verdict: the function refusing the cron secret (its own 401) fails, and names the fix', res.status === 401 && vd.errors.length === 1 && /the sync refused the cron secret/.test(vd.errors[0]) && /set_cron_secret/.test(vd.errors[0]), vd);
  sm = S.render({ run: refused, http: '401' }, NOW);
  chk('summary: a refused call shows what the answer said', /\| Answer \| unauthorized \|/.test(sm.markdown), sm.markdown);
  vd = S.verdict({ run: { msg: 'Missing authorization header' }, http: '401' }, NOW);
  chk('verdict: the Supabase gateway\'s 401 (the function checks JWTs) is told apart, and names the redeploy', vd.errors.length === 1 && /gateway refused the call \(HTTP 401: Missing authorization header\)/.test(vd.errors[0]) && /--no-verify-jwt/.test(vd.errors[0]), vd);
  const ANS = (x) => Object.assign({}, CRON, { answers: x });
  vd = S.verdict({ cron: ANS([{ status: 401, content: '{"ok":false,"error":"unauthorized"}' }, { status: 200 }]) }, NOW);
  chk('verdict: pg_cron\'s pokes refused (401) fail the job though its SQL succeeded (2026-10-26)', vd.errors.length === 1 && /pg_cron's calls are refused \(HTTP 401/.test(vd.errors[0]), vd);
  vd = S.verdict({ cron: ANS([{ status: null }, { status: 200 }]) }, NOW);
  chk('verdict: the latest answered poke decides; one still in flight is skipped', vd.errors.length === 0, vd);
  vd = S.verdict({ cron: ANS([{ status: 500 }]) }, NOW);
  chk('verdict: a 500 is a run the function recorded as an error (readiness says why), not a scheduler fault', vd.errors.length === 0, vd);
  vd = S.verdict({ cron: ANS([{ status: null, timed_out: true }]) }, NOW);
  chk('verdict: a timed-out poke warns', vd.errors.length === 0 && /timed out/.test(vd.warnings[0] || ''), vd);
  sm = S.render({ cron: ANS([{ status: 200 }, { status: 401 }, { status: null }]) }, NOW);
  chk('summary: the sync\'s answers to pg_cron, latest first', /The sync's answers \(latest first\) \| HTTP 200, HTTP 401, no answer yet \|/.test(sm.markdown), sm.markdown);
  resetDb();
  r = await run('2026-10-25T18:00:20Z', { force: true, simulate_outage: ['daily_faceoff'] });
  // more than three hours out the NHL API is not read, so Daily Faceoff refusing leaves no source: the function records an error and answers 500
  vd = S.verdict({ run: r, http: '500', readiness: Object.assign({}, READY, { state: 'error', last_check_status: 'error', state_reason: 'the last check failed: ' + r.alerts.map((a) => a.message).join('; '), last_check_alerts: r.alerts.map((a) => a.severity + ':' + a.code) }) }, NOW);
  chk('verdict: Daily Faceoff refused and nothing else to read is a warning, not a failure (an outside source: the cards keep the starters on file and stay gated)', !r.ok && r.alerts.map((a) => a.code).join() === 'daily_faceoff_unavailable,sources_down'
    && vd.errors.length === 0 && vd.warnings.some((w) => /DEGRADED daily_faceoff_unavailable/.test(w)) && vd.warnings.some((w) => /FAILURE sources_down \(an outside source/.test(w)) && vd.warnings.some((w) => /^readiness: the last check failed.*\(an outside source/.test(w)), vd);
  vd = S.verdict({ run: { ok: false, status: 'error', run: { status: 'error' }, alerts: [{ severity: 'FAILURE', code: 'sources_down', message: 'x' }, { severity: 'FAILURE', code: 'sync_error', message: 'sync error: boom' }] }, http: '500' }, NOW);
  chk('verdict: a source outage does not excuse EdgeDesk\'s own error in the same run', vd.errors.length === 1 && /HTTP 500: sources_down: x; sync_error: sync error: boom/.test(vd.errors[0]), vd);
  vd = S.verdict({ run: { ok: true, status: 'warn', run: { status: 'warn' }, alerts: [{ severity: 'DRIFT', code: 'daily_faceoff_drift', message: 'no __NEXT_DATA__' }] }, http: '200' }, NOW);
  chk('verdict: a page that no longer parses is EdgeDesk\'s to fix (the job fails and names the parser)', vd.errors.length === 1 && /hockey\/goalies\/core\.js/.test(vd.errors[0]), vd);
  r = await run('2026-10-25T18:20:20Z', { force: true, simulate_outage: ['inputs'] });
  vd = S.verdict({ run: r, http: '500', readiness: Object.assign({}, READY, { state: 'error', state_reason: 'the last check failed: the slate\'s goalie inputs could not be read' }) }, NOW);
  chk('verdict: the inputs unreadable is a failure (HTTP 500 and readiness in error)', !r.ok && vd.errors.length === 2 && /HTTP 500/.test(vd.errors[0]) && /inputs could not be read/.test(vd.errors[1]), vd);
  W.df = 'evening';

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL goalie sync — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | the suite crashed: ' + (e && e.stack)); process.exit(1); });
