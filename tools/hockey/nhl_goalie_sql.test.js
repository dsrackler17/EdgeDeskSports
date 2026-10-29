#!/usr/bin/env node
/* ===========================================================================
   The NHL starting-goalie layer on a real PostgreSQL
   (supabase/nhl_goalie_layer.sql, nhl_goalie_v2_registry.sql,
   nhl_goalie_cron.sql, nhl_goalie_layer_rollback.sql).

     node tools/hockey/nhl_goalie_sql.test.js     (NHL_SQL_REQUIRED=1 in CI)

   Applies the layer twice (idempotent), then attacks it:
     roles        anon and authenticated read; nobody but service_role writes
     starters     a new observation supersedes the current one (is_current
                  off, superseded_at set); one current per game, team and
                  source; any update — even turning is_current off by hand —
                  delete and truncate are refused, for service_role too; an
                  older observation cannot displace a newer one; Confirmed
                  needs a name; a conflict is never Confirmed
     cards        versions 1, 2, 3 per game, each superseding the latest,
                  before puck drop; an unconfirmed card must show the range
                  and "Starter not confirmed. Numbers may change."; the gate
                  is OPEN exactly when both are Confirmed; a card naming
                  another goalie variant (the experimental v2) is refused
     edges, CLV   an edge attaches to the card version current when it was
                  detected (a superseded or a not-yet-posted version is
                  refused); a GATED card is never BOTH_CONFIRMED; the CLV
                  grade rides the edge, so it names that version too
     readiness    % of games with both starters Confirmed by T-30 (the grace
                  minutes included), sync failures, source conflicts, a
                  silent scheduler, a sync that never ran
     the card     FRESH / STALE (15-minute rule inside three hours) / FAILED /
                  NO_RUN / PREGAME; the latest version and the first one
     registry     v2 registers EXPERIMENTAL with no result; the live variant
                  stays xg_goalie_confirmed
     cron         the poke without its secret records a failed run and a
                  FAILURE alert; with it, it queues
     rollback     removes the layer
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('NHL goalie layer');
const ROOT = PG.ROOT;
const F = (n) => path.join(ROOT, 'supabase', n);
const LAYER = fs.readFileSync(F('nhl_goalie_layer.sql'), 'utf8');

T.chk('the layer never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261025230000_nhl_goalie_layer.sql'), 'utf8') === LAYER);
T.chk('the v2 registry file is current (node tools/hockey/build_goalie_v2_registry_sql.js)', require(path.join(ROOT, 'tools', 'hockey', 'build_goalie_v2_registry_sql.js')).build() === fs.readFileSync(F('nhl_goalie_v2_registry.sql'), 'utf8'));
T.chk('no psql meta-command in any file', ['nhl_goalie_layer.sql', 'nhl_goalie_v2_registry.sql', 'nhl_goalie_cron.sql', 'nhl_goalie_layer_rollback.sql'].every((n) => !/^\s*\\/m.test(fs.readFileSync(F(n), 'utf8'))));
T.chk('no psql meta-command in the job\'s checks', ['nhl_goalie_readiness_check.sql', 'nhl_goalie_cron_check.sql', 'nhl_goalie_cards_check.sql'].every((n) => !/^\s*\\/m.test(fs.readFileSync(path.join(__dirname, 'sql', n), 'utf8'))));

const db = PG.start('nhlgoal');
if (db.skip) {
  if (process.env.NHL_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = PG.lit;
const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const why = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };
const J = (s) => JSON.parse(s.split('\n').filter(Boolean).pop());
const last = (s) => s.split('\n').filter(Boolean).pop();
try {
  let out = db.applyFile(F('nhl_goalie_layer.sql'));
  T.chk('the layer applies; every report row is ok', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 6, out);
  out = db.applyFile(F('nhl_goalie_layer.sql'));
  T.chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 6, out.slice(0, 300));

  /* ---- starters ---- */
  const START = "now() + interval '5 hours'";
  const obs = (o) => last(db.service(`insert into public.nhl_goalie_starters (game_id, game_start_utc, team, side, goalie_id, goalie_name, status, source, source_status, source_updated_at, fetched_at, conflict, conflict_detail, match_method)
    values (${lit(o.game || 'g1')}, ${o.start || START}, ${lit(o.team || 'VAN')}, ${lit(o.side || 'home')}, ${lit(o.id === undefined ? '8480947' : o.id)}, ${lit(o.name === undefined ? 'K. Lankinen' : o.name)}, ${lit(o.status || 'projected')},
      ${lit(o.source || 'daily_faceoff')}, ${lit(o.raw || null)}, ${o.updated || 'null'}, ${o.at || 'now()'}, ${o.conflict ? 'true' : 'false'}, ${o.conflict ? lit(JSON.stringify(o.detail || [{ source: 'a' }, { source: 'b' }])) : 'null'}, ${lit(o.method || 'team_initial')}) returning id;`));
  const p1 = obs({ source: 'edgedesk_projection', at: "now() - interval '6 hours'", method: 'projection' });
  const d1 = obs({ at: "now() - interval '5 hours'", status: 'projected', raw: 'Unconfirmed' });
  const d2 = obs({ at: "now() - interval '1 hour'", id: '8482447', name: 'L. Meriläinen', status: 'likely', raw: 'Likely' });
  const cur = db.sql("select string_agg(id || ':' || is_current || ':' || (superseded_at is not null), ',' order by id) from public.nhl_goalie_starters where source = 'daily_faceoff'");
  T.chk('starters: a new observation supersedes the current one (is_current off, superseded_at set), the old row kept', cur === d1 + ':false:true,' + d2 + ':true:false', cur);
  T.chk('starters: the projection is its own source and stays current', db.sql(`select is_current from public.nhl_goalie_starters where id = ${p1}`) === 't');
  T.chk('starters: an observation older than the current one is refused', fails(() => obs({ at: "now() - interval '3 hours'" })));
  T.chk('starters: no update — not even turning is_current off by hand — for service_role too', fails(() => db.service(`update public.nhl_goalie_starters set is_current = false, superseded_at = now() where id = ${d2};`))
    && fails(() => db.sql(`update public.nhl_goalie_starters set status = 'confirmed' where id = ${d2};`)) && fails(() => db.sql(`select set_config('edgedesk.nhl_goalie_supersede', 'on', false); update public.nhl_goalie_starters set goalie_name = 'X' where id = ${d2};`)));
  T.chk('starters: no delete, no truncate', fails(() => db.service('delete from public.nhl_goalie_starters;')) && fails(() => db.sql('truncate public.nhl_goalie_starters;')));
  T.chk('starters: Confirmed needs a name; a status needs a name', fails(() => obs({ status: 'confirmed', id: null, name: null })) && fails(() => obs({ status: 'likely', id: null, name: null })));
  T.chk('starters: unknown with no name is fine (a source listing the game with no starter yet)', !fails(() => obs({ game: 'g8', status: 'unknown', id: null, name: null, method: 'none' })));
  T.chk('starters: a conflict is only on the consensus, and never Confirmed', fails(() => obs({ conflict: true, status: 'likely' })) && fails(() => obs({ source: 'consensus', conflict: true, status: 'confirmed' })));
  const c1 = obs({ source: 'consensus', at: "now() - interval '5 hours'", status: 'projected', method: 'projection' });
  const c2 = obs({ source: 'consensus', at: "now() - interval '1 hour'", id: '8482447', name: 'L. Meriläinen', status: 'likely', method: 'id' });
  const cA = obs({ source: 'consensus', team: 'MIN', side: 'away', id: '8475717', name: 'C. Pickard', at: "now() - interval '1 hour'", status: 'likely', method: 'id' });
  T.chk('starters: the current view holds one row per game, team and source', db.anon("select count(*) from public.nhl_goalie_starters_current where game_id = 'g1' and team = 'VAN' and source = 'consensus';") === '1'
    && db.sql("select count(*) from (select game_id, team, source, count(*) from public.nhl_goalie_starters where is_current group by 1, 2, 3 having count(*) > 1) x") === '0');
  T.chk('roles: anon reads the starters, the cards and the KPIs', /\d/.test(db.anon('select count(*) from public.nhl_goalie_starters;')) && db.anon('select count(*) from public.nhl_goalie_readiness;') === '1');
  T.chk('roles: anon and authenticated cannot write', fails(() => db.anon("insert into public.nhl_goalie_starters (game_id, game_start_utc, team, side, status, source, fetched_at) values ('g9', now() + interval '1 day', 'VAN', 'home', 'unknown', 'daily_faceoff', now());"))
    && fails(() => db.as('00000000-0000-0000-0000-000000000001', "insert into public.nhl_goalie_sync_runs (status, started_at) values ('ok', now());")));

  /* ---- cards ---- */
  const LIM = "'[\"Starter not confirmed. Numbers may change.\"]'";
  const card = (o) => `insert into public.nhl_game_cards (game_id, version, game_start_utc, home, away, generated_at, trigger, reasons, supersedes_id, goalie_pairing_used, goalie_status_home, goalie_status_away, home_goalie_name, away_goalie_name, home_starter_row_id, away_starter_row_id, conflict,
      headline, pairing_price, pairing_range, show_range, edge_gate, edge_gate_state, known_limitations, change_note, model_id, goalie_variant, inputs_hash, core_version)
    values (${lit(o.game || 'g1')}, ${o.version || 1}, ${o.start || START}, 'VAN', 'MIN', ${o.at || 'now()'}, ${lit(o.trigger || 'initial')}, ${lit(JSON.stringify(o.reasons || []))}, ${o.supersedes || 'null'}, '{"home":{"goalie_name":"K. Lankinen"},"away":{"goalie_name":"C. Pickard"}}',
      ${lit(o.sh || 'projected')}, ${lit(o.sa || 'projected')}, 'K. Lankinen', 'C. Pickard', ${o.hrow || 'null'}, ${o.arow || 'null'}, ${o.conflict ? 'true' : 'false'}, ${o.headline ? lit(JSON.stringify(o.headline)) : `'{"p_home":0.4174,"model_id":"edgedesk_nhl_v1:xg_core"}'`}, '{"p_home":0.4117}',
      '[{"p_home":0.4117},{"p_home":0.3935}]', ${o.show === false ? 'false' : 'true'}, '{"state":"x"}', ${lit(o.gate || 'GATED')}, ${o.lim || LIM}, ${o.note ? lit(JSON.stringify(o.note)) : 'null'},
      ${lit(o.model || 'edgedesk_nhl_v1:xg_core')}, ${lit(o.variant || 'xg_goalie_confirmed')}, 'h', 'edgedesk_nhl_goalie_core_v1') returning id;`;
  const v1 = last(db.service(card({ at: "now() - interval '5 hours'", hrow: c1, arow: cA })));
  T.chk('cards: version 1 is stored, naming its starter rows', /^\d+$/.test(v1) && db.sql(`select home_starter_row_id from public.nhl_game_cards where id = ${v1}`) === c1);
  T.chk('cards: a second version 1 is refused', fails(() => db.service(card({}))));
  T.chk('cards: version 3 before version 2 is refused; version 2 must supersede the latest', fails(() => db.service(card({ version: 3, supersedes: v1, trigger: 'starter_changed' }))) && fails(() => db.service(card({ version: 2, supersedes: 999999, trigger: 'starter_changed' }))));
  T.chk('cards: a card generated after puck drop is refused', fails(() => db.service(card({ game: 'g2', start: "now() - interval '1 minute'" }))));
  T.chk('cards: an unconfirmed card without the range or without the "not confirmed" line is refused', fails(() => db.service(card({ game: 'g3', show: false }))) && fails(() => db.service(card({ game: 'g3', lim: "'[]'" }))));
  T.chk('cards: an unconfirmed card cannot open the gate; a confirmed one cannot stay GATED', fails(() => db.service(card({ game: 'g3', gate: 'OPEN' }))) && fails(() => db.service(card({ game: 'g3', sh: 'confirmed', sa: 'confirmed', gate: 'GATED' }))));
  T.chk('cards: a conflict keeps the gate GATED even with both statuses Confirmed (the merge never sends that, the table still refuses it)', fails(() => db.service(card({ game: 'g3', sh: 'confirmed', sa: 'confirmed', conflict: true, gate: 'OPEN', show: false, lim: "'[]'" }))));
  const v2why = why(() => db.service(card({ game: 'g3', variant: 'NHL-GOALIE-V2' })));
  T.chk('cards: a card priced by another goalie variant (the experimental v2) is refused: v2 cannot reach a live card', /cannot reach a live card/.test(v2why), v2why);
  T.chk('cards: a card naming another model than edgedesk_nhl_v1 is refused', fails(() => db.service(card({ game: 'g3', model: 'edgedesk_nhl_v2:xg' }))));
  const v2 = last(db.service(card({ version: 2, supersedes: v1, trigger: 'starter_changed', at: "now() - interval '1 hour'", hrow: c2, arow: cA, note: { text: 'Updated: starter changed from K. Lankinen to L. Meriläinen', first_p_home: 0.4117, current_p_home: 0.4243 } })));
  T.chk('cards: version 2 supersedes version 1, which stays for audit', db.sql("select string_agg(version::text, ',' order by version) from public.nhl_game_cards where game_id = 'g1'") === '1,2' && db.anon("select version from public.nhl_game_cards_current where game_id = 'g1';") === '2');
  /* the lineup lock (hockey/goalies/core.js nhlgLockPrice): a later version whose headline was priced at lock, under the inputs_changed trigger */
  const both = { sh: 'confirmed', sa: 'confirmed', gate: 'OPEN', show: false, lim: "'[]'" };
  const k1 = last(db.service(card(Object.assign({ game: 'g7', at: "now() - interval '40 minutes'" }, both))));
  const k2why = why(() => db.service(card(Object.assign({ game: 'g7', version: 2, supersedes: k1, trigger: 'inputs_changed', reasons: ['lineup_locked', 'inputs_changed'], at: "now() - interval '10 minutes'",
    headline: { basis: 'lineup_lock', model_id: 'edgedesk_nhl_v1:xg_all_confirmed', p_home: 0.4051, before: { model_id: 'edgedesk_nhl_v1:xg_core', p_home: 0.4174 } } }, both))));
  const k2 = db.sql("select id from public.nhl_game_cards where game_id = 'g7' and version = 2");
  T.chk('cards: a lineup-lock version is stored as the sync writes it (inputs_changed, reason lineup_locked, the lock headline), the live variant and production model id unchanged', /^\d+$/.test(k1) && /^\d+$/.test(k2)
    && db.sql("select headline->>'basis' || ' ' || (reasons ? 'lineup_locked')::text from public.nhl_game_cards where game_id = 'g7' and version = 2") === 'lineup_lock true', k2why);
  T.chk('cards: no update, no delete, no truncate', fails(() => db.service(`update public.nhl_game_cards set trigger = 'initial' where id = ${v2};`)) && fails(() => db.service('delete from public.nhl_game_cards;')) && fails(() => db.sql('truncate public.nhl_game_cards cascade;')));

  /* ---- edges and CLV, attached to the version that existed ---- */
  const edge = (o) => `insert into public.nhl_card_edge_events (card_id, game_id, market, side, line, american, book, quote_source, quote_captured_at, p_win, ev, min_ev, ev_min_pairings, flag_allowed, gate_basis, detected_at)
    values (${o.card}, 'g1', ${lit(o.market || 'moneyline')}, ${lit(o.side || 'home')}, ${o.line == null ? 'null' : o.line}, ${o.american || 150}, 'testbook', 'captured', ${o.qat || "'2026-10-25 11:50:00+00'"}, 0.4174, ${o.ev == null ? 0.0435 : o.ev}, 0.02, -0.016,
      ${o.allowed ? 'true' : 'false'}, ${lit(o.basis || 'GATED')}, ${o.at}) returning id;`;
  const e1 = last(db.service(edge({ card: v1, at: "now() - interval '3 hours'" })));
  T.chk('edges: an edge seen while version 1 was current attaches to version 1', /^\d+$/.test(e1));
  T.chk('edges: attaching it to version 2, posted after it was seen, is refused', fails(() => db.service(edge({ card: v2, at: "now() - interval '3 hours'", american: 151 }))));
  const e2why = why(() => db.service(edge({ card: v1, at: "now() - interval '30 minutes'", american: 152 })));
  T.chk('edges: attaching a later edge to version 1 once version 2 was current is refused (CLV attaches to the version that existed)', /attaches to the version that existed/.test(e2why), e2why);
  const e2 = last(db.service(edge({ card: v2, at: "now() - interval '30 minutes'", american: 152 })));
  T.chk('edges: the same later edge on version 2 is stored', /^\d+$/.test(e2));
  T.chk('edges: a GATED version is never BOTH_CONFIRMED; GATED is never allowed; below min_ev is not an edge', fails(() => db.service(edge({ card: v2, at: 'now()', basis: 'BOTH_CONFIRMED', allowed: true, american: 160 })))
    && fails(() => db.service(edge({ card: v2, at: 'now()', basis: 'GATED', allowed: true, american: 161 }))) && fails(() => db.service(edge({ card: v2, at: 'now()', ev: 0.01, american: 162 }))));
  T.chk('edges: a line is required off the moneyline; the same edge twice is refused', fails(() => db.service(edge({ card: v2, at: 'now()', market: 'total', side: 'over', american: 163 }))) && fails(() => db.service(edge({ card: v2, at: "now() - interval '30 minutes'", american: 152 }))));
  T.chk('CLV: a close captured before the edge, or after puck drop, is refused', fails(() => db.service(`insert into public.nhl_card_edge_clv (edge_event_id, closing_american, closing_captured_at, clv_pct) values (${e1}, 130, now() - interval '4 hours', 0.05);`))
    && fails(() => db.service(`insert into public.nhl_card_edge_clv (edge_event_id, closing_american, closing_captured_at, clv_pct) values (${e1}, 130, now() + interval '6 hours', 0.05);`)));
  db.service(`insert into public.nhl_card_edge_clv (edge_event_id, closing_american, closing_book, closing_captured_at, clv_pct) values (${e1}, 130, 'testbook', now() + interval '4 hours', 0.087);`);
  const clv = J(db.anon(`select row_to_json(x) from public.nhl_card_edge_clv_detail x where edge_event_id = ${e1};`));
  T.chk('CLV: the grade names the card version the edge was seen under (version 1, Lankinen), not the latest', clv.card_version === 1 && clv.card_id === Number(v1) && clv.goalie_pairing_used.home.goalie_name === 'K. Lankinen' && Number(clv.clv_pct) === 0.087, clv);

  /* ---- runs, readiness, the card ---- */
  const runRow = (status, o) => last(db.service(`insert into public.nhl_goalie_sync_runs (status, started_at, finished_at, daily_faceoff_ok, nhl_api_ok, unmatched, message, trigger, due_kinds)
    values (${lit(status)}, ${o && o.at || 'now()'} - interval '30 seconds', ${o && o.at || 'now()'}, ${o && o.df === false ? 'false' : 'true'}, true, ${o && o.unmatched || 0}, ${lit(o && o.message || null)}, 'test', '{two_hour}') returning run_id;`));
  runRow('ok', { at: "now() - interval '55 minutes'" });
  let gc = J(db.anon("select public.nhl_goalie_card('g1');"));
  T.chk('card: FRESH, the latest version and the first one, every source\'s current row', gc.freshness === 'FRESH' && gc.card.version === 2 && gc.first.version === 1 && gc.first.pairing_price.p_home === 0.4117 && gc.versions === 2
    && gc.starters.home.some((s) => s.source === 'daily_faceoff' && s.goalie_name === 'L. Meriläinen') && gc.starters.home.some((s) => s.source === 'edgedesk_projection'), gc);
  T.chk('card: the change note travels with the version', gc.card.change_note.text === 'Updated: starter changed from K. Lankinen to L. Meriläinen');
  T.chk('card: a game with no card says so', J(db.anon("select public.nhl_goalie_card('nope');")).state === 'NO_CARD');
  /* games already played: one Confirmed both sides by T-30, one confirmed only after T-30, one with a conflict */
  const past = (g, hrs) => `now() - interval '${hrs} hours'`;
  for (const [g, h] of [['p1', 30], ['p2', 20], ['p3', 10]]) db.service(card({ game: g, start: past(g, h), at: `now() - interval '${h + 4} hours'` }));
  obs({ game: 'p1', start: past('p1', 30), source: 'consensus', status: 'confirmed', at: "now() - interval '31 hours'", method: 'id' });
  obs({ game: 'p1', start: past('p1', 30), team: 'MIN', side: 'away', id: '8475717', name: 'C. Pickard', source: 'consensus', status: 'confirmed', at: "now() - interval '30 hours 27 minutes'", method: 'id' });  /* T-27: inside the 5-minute grace */
  obs({ game: 'p2', start: past('p2', 20), source: 'consensus', status: 'likely', at: "now() - interval '21 hours'", method: 'id' });
  obs({ game: 'p2', start: past('p2', 20), source: 'consensus', status: 'confirmed', at: "now() - interval '20 hours 10 minutes'", method: 'id' });       /* confirmed at T-10: too late */
  obs({ game: 'p2', start: past('p2', 20), team: 'MIN', side: 'away', id: '8475717', name: 'C. Pickard', source: 'consensus', status: 'confirmed', at: "now() - interval '21 hours'", method: 'id' });
  obs({ game: 'p3', start: past('p3', 10), source: 'consensus', status: 'likely', conflict: true, at: "now() - interval '11 hours'", method: 'id' });
  obs({ game: 'p3', start: past('p3', 10), team: 'MIN', side: 'away', id: '8475717', name: 'C. Pickard', source: 'consensus', status: 'confirmed', at: "now() - interval '11 hours'", method: 'id' });
  obs({ source: 'consensus', at: "now() - interval '10 minutes'", status: 'likely', conflict: true, id: '8482447', name: 'L. Meriläinen', method: 'id' }); /* an open conflict on g1 */
  let rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('readiness: % of games with both starters Confirmed by T-30 (1 of 3; the grace counted, a late confirmation and a conflict not)', rd.games_7d === 3 && rd.games_confirmed_by_t30_7d === 1 && Number(rd.pct_confirmed_by_t30_7d) === 33.3 && Number(rd.pct_sides_confirmed_by_t30_7d) === 66.7, rd);
  T.chk('readiness: source conflicts open now and over 24 hours', rd.conflicts_open === 1 && rd.conflicts_24h >= 2, rd);
  T.chk('readiness: an open conflict is a warning', rd.state === 'warn' && /conflict/.test(rd.state_reason), rd);
  runRow('error', { at: "now() - interval '50 minutes'", message: 'no starter source could be read', df: false });
  db.service("insert into public.nhl_goalie_alerts (run_id, severity, code, message) values ((select run_id from public.nhl_goalie_sync_runs where status = 'error' order by finished_at desc limit 1), 'FAILURE', 'sources_down', 'both sources down');");
  rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('readiness: a failed check is an error, a sync failure and a FAILURE alert in 24 h, Daily Faceoff down counted', rd.state === 'error' && rd.sync_failures_24h === 1 && rd.failures_24h === 1 && rd.consecutive_failures === 1 && rd.daily_faceoff_down_24h === 1 && /failed/.test(rd.state_reason), rd);
  gc = J(db.anon("select public.nhl_goalie_card('g1');"));
  T.chk('card: after a failed check the card says FAILED (the starters shown are the last known, labelled)', gc.freshness === 'FAILED' && /failed/.test(gc.reason) && gc.card.version === 2, gc.freshness);
  T.chk('pipeline ledger: the last status reads error', db.anon("select value from public.nhl_goalie_meta where key = 'nhl_goalie_sync_last_status';") === 'error');
  runRow('ok', { at: "now() - interval '45 minutes'" });
  /* a check 45 minutes old: fine for a game five hours out, stale inside three hours */
  T.chk('card: a check 45 minutes old is FRESH five hours out', J(db.anon("select public.nhl_goalie_card('g1');")).freshness === 'FRESH');
  db.service(card({ game: 'g4', start: "now() + interval '2 hours'", at: "now() - interval '1 hour'" }));
  gc = J(db.anon("select public.nhl_goalie_card('g4');"));
  T.chk('card: inside three hours of puck drop the same check is STALE (the 15-minute cadence), with the time', gc.freshness === 'STALE' && /last checked/.test(gc.reason), gc);
  gc = J(db.anon("select public.nhl_goalie_card('p1');"));
  T.chk('card: after puck drop, PREGAME: the last version before it', gc.freshness === 'PREGAME' && gc.card.version === 1);

  /* ---- the v2 registry ---- */
  T.chk('registry: before the research registry exists, the file refuses (nothing registered)', fails(() => db.applyFile(F('nhl_goalie_v2_registry.sql'))));
  db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
    create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
    create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
    create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
    create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
    create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
      from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
      left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
  out = db.applyFile(F('nhl_goalie_v2_registry.sql'));
  T.chk('registry: v2 registers; it reads EXPERIMENTAL with no result; live cards still use the v1 variant', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 2, out);
  out = db.applyFile(F('nhl_goalie_v2_registry.sql'));
  T.chk('registry: registering twice changes nothing', !/CHECK THIS/.test(out) && db.sql('select count(*) from public.research_model_versions') === '1');
  const ver = db.sql("select status, provenance, promotion_criteria ->> 'decision_rule', min_sample, holdout_window::text, validation_window::text, (forking_paths -> 'candidates_tried' -> 0 ->> 'evaluated_against_outcomes') from public.research_model_versions v join public.research_models m on m.id = v.model_id where m.model_key = 'NHL-GOALIE-V2'");
  T.chk('registry: the version carries its promotion criteria, the minimum sample and the windows, written before any backtest', /^experimental\|T3\|/.test(ver) && /every criterion below holds/.test(ver) && /\|500\|/.test(ver) && /\[2026-10-26,2027-04-17\)/.test(ver) && /\[2020-10-01,2026-07-01\)/.test(ver) && /\|false$/.test(ver), ver);
  T.chk('registry: no result row', db.sql('select count(*) from public.research_model_results') === '0');
  T.chk('registry: the config names v2 and keeps the live variant', db.sql("select value from public.nhl_goalie_config where key = 'goalie_v2_version'") === '0.1' && db.sql("select value from public.nhl_goalie_config where key = 'goalie_v2_live'") === 'false'
    && db.sql("select value from public.nhl_goalie_config where key = 'live_goalie_variant'") === 'xg_goalie_confirmed');
  T.chk('registry: still, no live card can name v2', fails(() => db.service(card({ game: 'g5', variant: 'NHL-GOALIE-V2' }))));

  /* ---- a fresh layer: the never-run and silent-scheduler states ---- */
  out = db.applyFile(F('nhl_goalie_layer_rollback.sql'));
  T.chk('rollback removes the layer', /\|ok/.test(out) && db.sql("select to_regclass('public.nhl_goalie_starters') is null") === 't', out);
  db.applyFile(F('nhl_goalie_layer.sql'));
  rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('readiness: a sync that has never run is an error', rd.state === 'error' && /never run/.test(rd.state_reason), rd);
  T.chk('card: before any run, NO_RUN', J(db.anon("select public.nhl_goalie_card('g1');")).freshness === 'NO_RUN');
  db.service("insert into public.nhl_goalie_sync_runs (status, started_at, finished_at, trigger) values ('ok', now() - interval '2 hours', now() - interval '2 hours', 'test');");
  rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('readiness: no run of any kind in 90 minutes is an error (the scheduler is not calling)', rd.state === 'error' && /scheduler/.test(rd.state_reason), rd);
  db.service("insert into public.nhl_goalie_sync_runs (status, skipped_reason, started_at, finished_at, trigger) values ('skipped', 'no slot due', now(), now(), 'test');");
  rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('readiness: a heartbeat (skipped) row keeps a quiet morning from looking dead', rd.state === 'ok' && rd.skipped_24h === 1, rd);

  /* ---- the cron poke ---- */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create table if not exists cron.job_run_details (jobid bigint, runid bigserial, status text, return_message text, start_time timestamptz, end_time timestamptz);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.calls (url text, headers jsonb); create sequence if not exists net.req_seq;
    create table if not exists net._http_response (id bigint, status_code integer, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz default now());
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, headers); select nextval('net.req_seq') $$;`);
  out = db.applyFile(F('nhl_goalie_cron.sql'));
  T.chk('cron: scheduled every five minutes; the report flags the missing secret', /1 the five-minute poke is scheduled\|ok/.test(out) && /CHECK THIS: select vault\.create_secret/.test(out) && db.sql("select schedule from cron.job where jobname = 'nhl_goalie_sync'") === '*/5 * * * *', out);
  let pk = J(db.sql('select public.nhl_goalie_poke();'));
  rd = J(db.anon('select row_to_json(r) from public.nhl_goalie_readiness r;'));
  T.chk('forced failure: no secret is a failed run and a FAILURE alert, visible in the KPIs', pk.queued === false && rd.last_check_status === 'error' && rd.failures_24h >= 1 && rd.state === 'error'
    && db.sql('select code from public.nhl_goalie_alerts order by id desc limit 1') === 'no_cron_secret', [pk, rd]);
  db.sql("insert into vault.decrypted_secrets values ('nhl_goalie_cron_secret', 's3cret');");
  pk = J(db.sql('select public.nhl_goalie_poke();'));
  T.chk('cron: the poke keeps its pg_net request id, so the function\'s answer can be read beside it', db.sql('select count(*) from public.nhl_goalie_pokes where request_id = ' + Number(pk.request_id)) === '1', pk);
  T.chk('cron: no client may read the pokes', fails(() => db.anon('select * from public.nhl_goalie_pokes;')) || db.anon('select count(*) from public.nhl_goalie_pokes;') === '0');
  T.chk('cron: with the secret, the poke queues with the x-cron-secret header', pk.queued === true && db.sql("select headers ->> 'x-cron-secret' from net.calls limit 1") === 's3cret' && /nhl_goalie_sync$/.test(db.sql('select url from net.calls limit 1')));
  T.chk('cron: no client may call the poke', fails(() => db.anon('select public.nhl_goalie_poke();')) && fails(() => db.as('00000000-0000-0000-0000-000000000001', 'select public.nhl_goalie_poke();')));
  out = db.applyFile(F('nhl_goalie_cron.sql'));
  T.chk('cron: applying it twice keeps one job', db.sql("select count(*) from cron.job where jobname = 'nhl_goalie_sync'") === '1');

  /* ---- what NHL goalie sync (the GitHub job) reads: tools/hockey/sql, judged by tools/hockey/nhl_goalie_run_summary.js ---- */
  const S = require(path.join(__dirname, 'nhl_goalie_run_summary.js'));
  const CHECK = (n) => fs.readFileSync(path.join(__dirname, 'sql', n), 'utf8');
  let ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  T.chk('job: pg_cron scheduled but never run reads as never called (the job fails)', ck.exists === true && ck.schedule === '*/5 * * * *' && ck.active === true && ck.last_start === null && /never called/.test(S.verdict({ cron: ck }, Date.now()).errors[0] || ''), ck);
  db.sql("insert into cron.job_run_details (jobid, status, return_message, start_time, end_time) select jobid, 'succeeded', '1 row', now() - interval '3 minutes', now() - interval '3 minutes' from cron.job where jobname = 'nhl_goalie_sync';");
  ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  T.chk('job: a call three minutes ago reads as calling (the job does not call the sync itself)', ck.last_status === 'succeeded' && ck.failed_1h === 0 && S.verdict({ cron: ck }, Date.now()).errors.length === 0, ck);
  // what the function answered: the 2026-10-26 failure, every poke refused while pg_cron's SQL "succeeded"
  db.sql("update public.nhl_goalie_pokes set queued_at = now() - interval '5 minutes';");
  db.sql(`insert into net._http_response (id, status_code, content) select request_id, 401, '{"ok":false,"error":"unauthorized"}' from public.nhl_goalie_pokes;`);
  ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  let vc = S.verdict({ cron: ck }, Date.now());
  T.chk('job: pokes the function refused (401) fail the job though pg_cron\'s SQL succeeded, and name the fix', ck.answers.length >= 1 && ck.answers[0].status === 401 && vc.errors.length === 1 && /refused \(HTTP 401: \{"ok":false,"error":"unauthorized"\}\)/.test(vc.errors[0]) && /set_cron_secret/.test(vc.errors[0]), [ck, vc]);
  pk = J(db.sql('select public.nhl_goalie_poke();'));
  db.sql("update public.nhl_goalie_pokes set queued_at = now() - interval '1 minute' where request_id = " + Number(pk.request_id) + ";");
  ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  T.chk('job: a poke with no answer yet is no verdict (the earlier refusal still stands)', ck.answers[0].status === null && /refused/.test(S.verdict({ cron: ck }, Date.now()).errors[0] || ''), ck.answers);
  db.sql(`insert into net._http_response (id, status_code, content) values (${Number(pk.request_id)}, 200, '{"build":"nhl_goalie_sync@test","status":"ok"}');`);
  ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  T.chk('job: once the function answers 200 again, the job passes', ck.answers[0].status === 200 && S.verdict({ cron: ck }, Date.now()).errors.length === 0, ck.answers);
  db.sql("insert into public.nhl_goalie_pokes (request_id, queued_at) values (999999, now() - interval '30 seconds'); insert into net._http_response (id, status_code, content) values (999999, 404, '{\"code\":\"NOT_FOUND\"}');");
  ck = J(db.sql(CHECK('nhl_goalie_cron_check.sql')));
  T.chk('job: any other answer but 200 or 500 (here 404: the function is not deployed) fails the job', /answered HTTP 404/.test(S.verdict({ cron: ck }, Date.now()).errors[0] || ''), ck.answers);
  let rk = J(db.sql(CHECK('nhl_goalie_readiness_check.sql')));
  T.chk('job: readiness carries the last check\'s alerts; a missing cron secret is EdgeDesk\'s to fix (the job fails)', rk.state === 'error' && rk.last_check_alerts.join() === 'FAILURE:no_cron_secret' && S.verdict({ readiness: rk }, Date.now()).errors.length === 1, rk);
  db.sql(`with r as (insert into public.nhl_goalie_sync_runs (status, message, started_at, finished_at, trigger) values ('error', 'no starter source could be read (Daily Faceoff)', now(), now(), 'test') returning run_id)
    insert into public.nhl_goalie_alerts (run_id, severity, code, message) select run_id, 'DEGRADED', 'daily_faceoff_unavailable', 'Daily Faceoff answered HTTP 403' from r
    union all select run_id, 'FAILURE', 'sources_down', 'no starter source could be read (Daily Faceoff)' from r;`);
  rk = J(db.sql(CHECK('nhl_goalie_readiness_check.sql')));
  let vk = S.verdict({ readiness: rk }, Date.now());
  T.chk('job: a last check that failed only because no outside source answered is a warning, not a failure', rk.state === 'error' && rk.last_check_alerts.join() === 'DEGRADED:daily_faceoff_unavailable,FAILURE:sources_down' && vk.errors.length === 0 && /outside source/.test(vk.warnings[0] || ''), [rk, vk]);
  /* the cards: each game's current version and what its headline is priced by (nhl_goalie_cards_check.sql), a day ahead at most */
  // j1: version 1 with both starters Confirmed, then version 2 priced at lineup lock; j2: the slate's headline; g9: over a day ahead
  const jboth = { sh: 'confirmed', sa: 'confirmed', gate: 'OPEN', show: false, lim: "'[]'" };
  const j1 = last(db.service(card(Object.assign({ game: 'j1', at: "now() - interval '40 minutes'" }, jboth))));
  db.service(card(Object.assign({ game: 'j1', version: 2, supersedes: j1, trigger: 'inputs_changed', reasons: ['lineup_locked', 'inputs_changed'], at: "now() - interval '10 minutes'",
    headline: { basis: 'lineup_lock', model_id: 'edgedesk_nhl_v1:xg_all_confirmed', p_home: 0.4051, before: { model_id: 'edgedesk_nhl_v1:xg_core', p_home: 0.4174 }, lineup: { skaters: { home: 18, away: 18 } } } }, jboth)));
  db.service(card({ game: 'j2' }));
  db.service(card({ game: 'g9', start: "now() + interval '30 hours'" }));
  const kc = J(db.sql(CHECK('nhl_goalie_cards_check.sql')));
  const kg = (id) => (Array.isArray(kc) ? kc.find((x) => x.game_id === id) : null) || null, kj1 = kg('j1'), kj2 = kg('j2');
  T.chk('job: the cards list each game\'s current version once: the lock at lineup lock with the slate\'s price before it, the others at the slate, nothing over a day ahead', Array.isArray(kc) && new Set(kc.map((x) => x.game_id)).size === kc.length && !kg('g9')
    && kj1 && kj1.version === 2 && kj1.basis === 'lineup_lock' && Number(kj1.p_home) === 0.4051 && Number(kj1.before_p_home) === 0.4174 && kj1.gate === 'OPEN' && kj1.matchup === 'MIN@VAN' && kj1.skaters.home === 18
    && kj2 && kj2.version === 1 && kj2.basis === 'slate' && Number(kj2.p_home) === 0.4174 && kj2.gate === 'GATED', kc);
  const smk = S.render({ cards: kc }, Date.now());
  T.chk('job: the summary lists the cards, the lock marked "lineup lock" with its price before lock, and passes', /\| MIN@VAN \| [^|\n]+ \| 2 \|[^\n]*\| OPEN \| 40\.5% \| lineup lock[^|\n]*before lock 41\.7%/.test(smk.markdown) && /\| 41\.7% \| slate/.test(smk.markdown) && smk.verdict.errors.length === 0, smk.markdown);
  // Deploy NHL goalie layer re-applies all three files over the live tables (apply_sql): nothing kept may move
  // (the registry may add its own goalie_v2_* keys; every key already there keeps its value)
  const kept = () => ['nhl_goalie_sync_runs', 'nhl_goalie_alerts', 'nhl_goalie_pokes'].map((t) => t + '=' + db.sql('select count(*) from public.' + t)).join(' ');
  const cfg = () => db.sql("select string_agg(key || '=' || value::text, ';' order by key) from public.nhl_goalie_config where key not like 'goalie\\_v2\\_%' escape '\\'");
  const before = kept(), cb = cfg();
  const reports = ['nhl_goalie_layer.sql', 'nhl_goalie_v2_registry.sql', 'nhl_goalie_cron.sql'].map((n) => db.applyFile(F(n)));
  T.chk('re-applying the layer, the registry and the cron over live rows keeps every row and every setting, and every report row is ok', kept() === before && /=[1-9]/.test(before) && cfg() === cb && /live_goalie_variant=/.test(cb)
    && reports.every((o) => !/CHECK THIS/.test(o)), [before, kept(), cb, cfg(), reports.map((o) => o.slice(-300))]);
  out = db.applyFile(F('nhl_goalie_layer_rollback.sql'));
  T.chk('rollback removes the layer, its job and the pokes', /\|ok/.test(out) && db.sql("select count(*) from cron.job where jobname = 'nhl_goalie_sync'") === '0' && db.sql("select to_regclass('public.nhl_goalie_pokes') is null") === 't');
} catch (e) { T.chk("the run completed", false, String(e.message).slice(0, 1200) + " @ " + String(e.stack).split("\n").filter((l) => /nhl_goalie_sql/.test(l)).slice(0, 2).join(" | ")); }
finally { db.stop(); }
process.exit(T.done());
