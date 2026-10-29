#!/usr/bin/env node
/* ===========================================================================
   hockey/goalies/core.js — the NHL starting-goalie core, offline.

     sources    Daily Faceoff's __NEXT_DATA__ page and the NHL boxscore read;
                a page that changed shape is a DRIFT, never an empty slate
     identity   team names, slugs and abbreviations; goalie names matched on
                surname and initial (club first, then league), accents folded,
                ambiguous and unmatched names kept as such
     merge      sources that agree: the higher status; sources that disagree:
                both kept, the LOWER status (never Confirmed), a conflict; no
                source: the labelled usage projection
     pricing    the inputs re-price the slate's goalie scenarios exactly (the
                real 2026-10-25 MIN @ VAN inputs); the pair calibration is
                glm.js's
     the card   the range over every realistic pairing, the Known Limitations
                line, the edge gate, the change note against the first version
     change     a new version for a new starter, a new status, a conflict or
                new numbers; none for the same card
     edge gate  OPEN when both are Confirmed; otherwise only an edge that holds
                under every pairing; a line some pairing has no price for fails
     cadence    every two hours from 8 AM Eastern, every 15 minutes in the last
                three hours, the T-30 final pass, across the DST change
     copies     the edge function carries the core and the distribution verbatim

   Run: node tools/hockey/nhl_goalie_core.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'hockey', 'goalies', 'core.js'));
const DIST = require(path.join(ROOT, 'hockey', 'model', 'distribution.js'));
const GLM = require(path.join(ROOT, 'hockey', 'model', 'glm.js'));
const FX = require(path.join(__dirname, 'fixtures', 'nhl_goalie_sources.js'));
const INPUTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nhl_goalie_inputs_min_van_2026-10-25.json'), 'utf8'));
const GI = INPUTS.games[0];

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-9 : e);

/* ---------------------------------------------------------------- statuses */
chk('status: Daily Faceoff\'s three words map to Confirmed / Likely / Projected', G.nhlgStatus('Confirmed') === 'confirmed' && G.nhlgStatus('Likely') === 'likely' && G.nhlgStatus('Unconfirmed') === 'projected');
chk('status: expected and probable read as Likely; blank and unknown words as unknown', G.nhlgStatus('Expected') === 'likely' && G.nhlgStatus('probable') === 'likely' && G.nhlgStatus('') === 'unknown' && G.nhlgStatus(null) === 'unknown' && G.nhlgStatus('rumour') === 'unknown');
chk('status: the lower of two statuses', G.nhlgMinStatus('confirmed', 'likely') === 'likely' && G.nhlgMinStatus('projected', 'likely') === 'projected' && G.nhlgMinStatus('unknown', 'confirmed') === 'unknown');

/* ---------------------------------------------------------------- identity */
chk('team: full names, cities, nicknames, slugs and abbreviations', G.nhlgTeam('Vancouver Canucks') === 'VAN' && G.nhlgTeam('minnesota-wild') === 'MIN' && G.nhlgTeam('Montreal Canadiens') === 'MTL'
  && G.nhlgTeam('Montréal') === 'MTL' && G.nhlgTeam('St Louis Blues') === 'STL' && G.nhlgTeam('Utah Mammoth') === 'UTA' && G.nhlgTeam('Utah Hockey Club') === 'UTA' && G.nhlgTeam('TBL') === 'TBL' && G.nhlgTeam('Golden Knights') === 'VGK');
chk('team: an unknown team is null, not a guess', G.nhlgTeam('Quebec Nordiques') === null && G.nhlgTeam('') === null);
let m = G.nhlgMatchGoalie('Leevi Merilainen', 'VAN', INPUTS);
chk('goalie: "Leevi Merilainen" (no accent) is L. Meriläinen of Vancouver', m.goalie_id === '8482447' && m.method === 'team_initial', m);
m = G.nhlgMatchGoalie('Kevin Lankinen', 'VAN', INPUTS);
chk('goalie: "Kevin Lankinen" is K. Lankinen', m.goalie_id === '8480947', m);
m = G.nhlgMatchGoalie('Lankinen, Kevin', 'VAN', INPUTS);
chk('goalie: "Surname, First" reads too', m.goalie_id === '8480947', m);
m = G.nhlgMatchGoalie('Cam Pickard', 'VAN', INPUTS);
chk('goalie: a goalie the club\'s history does not show is matched league-wide when exactly one fits (a trade, a call-up)', m.goalie_id === '8475717' && m.method === 'league_initial', m);
m = G.nhlgMatchGoalie('Arturs Silovs', 'VAN', INPUTS);
chk('goalie: a name with no rated goalie is unmatched, never the nearest', m.goalie_id === null && m.method === 'unmatched', m);
const AMB = { goalies: { 1: { name: 'J. Smith', teams: ['BOS'] }, 2: { name: 'J. Smith', teams: ['BOS'] } } };
m = G.nhlgMatchGoalie('John Smith', 'BOS', AMB);
chk('goalie: two goalies that fit equally are ambiguous', m.goalie_id === null && m.method === 'ambiguous', m);
m = G.nhlgMatchGoalie('Kevin Lankinen', 'VAN', { goalies: { 9: { name: 'P. Lankinen', teams: ['VAN'] } } });
chk('goalie: the surname alone is not enough (the initial must agree)', m.goalie_id === null, m);

/* ---------------------------------------------------------------- Daily Faceoff */
let df = G.nhlgParseDailyFaceoff(FX.minVanPage('afternoon'), { url: 'https://www.dailyfaceoff.com/starting-goalies/2026-10-25', fetched_at: '2026-10-25T18:00:00Z' });
const dh = df.rows.find((r) => r.side === 'home'), da = df.rows.find((r) => r.side === 'away');
chk('Daily Faceoff: one game, two rows, teams read from the names', df.ok && df.games === 1 && df.rows.length === 2 && dh.team === 'VAN' && da.team === 'MIN' && dh.home === 'VAN' && dh.away === 'MIN', df);
chk('Daily Faceoff: name, the source\'s own word, its status and its news time', dh.goalie_name === 'Leevi Merilainen' && dh.source_status === 'Likely' && dh.status === 'likely' && dh.source_updated_at === '2026-10-25T17:42:00.000Z' && dh.start_utc === '2026-10-26T02:00:00.000Z', dh);
df = G.nhlgParseDailyFaceoff(FX.minVanPage('morning'));
chk('Daily Faceoff: a game listed with no goalie yet is unknown, with no name', df.ok && df.rows.every((r) => r.status === 'unknown' && r.goalie_name === null), df.rows);
chk('Daily Faceoff: a page without __NEXT_DATA__ is a DRIFT', G.nhlgParseDailyFaceoff('<html><body>new layout</body></html>').drift === 'the page has no __NEXT_DATA__ block');
chk('Daily Faceoff: unreadable JSON is a DRIFT', /not JSON/.test(G.nhlgParseDailyFaceoff('<script id="__NEXT_DATA__" type="application/json">{oops</script>').drift));
chk('Daily Faceoff: JSON with no game object is a DRIFT, never an empty slate', /no game object/.test(G.nhlgParseDailyFaceoff('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"games":[]}}}</script>').drift));
df = G.nhlgParseDailyFaceoff(FX.dfPage([Object.assign({}, FX.MIN_VAN, { homeTeamName: 'Hamilton Tigers', home: { name: 'X Y', strength: 'Likely' } })]));
chk('Daily Faceoff: a game whose teams do not read is kept as unread', df.ok && df.rows.length === 0 && df.unread.length === 1, df);

/* ---------------------------------------------------------------- the NHL boxscore */
let bx = G.nhlgParseNhlBoxscore(FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN' }));
chk('NHL boxscore: before lineups post it reads, and names no starter (not a failure)', bx.ok && bx.rows.length === 0 && bx.game_id === '2026020184');
bx = G.nhlgParseNhlBoxscore(FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN', homeGoalies: [{ id: 8482447, name: 'L. Meriläinen', starter: true }, { id: 8480947, name: 'K. Lankinen' }], awayGoalies: [{ id: 8475717, name: 'C. Pickard', starter: true }] }));
chk('NHL boxscore: the goalie flagged starter is Confirmed, by id', bx.rows.length === 2 && bx.rows[0].goalie_id === '8482447' && bx.rows[0].status === 'confirmed' && bx.rows[1].team === 'MIN', bx.rows);
bx = G.nhlgParseNhlBoxscore(FX.boxscore({ id: 1, home: 'VAN', away: 'MIN', homeGoalies: [{ id: 1, name: 'A', starter: true }, { id: 2, name: 'B', starter: true }] }));
chk('NHL boxscore: two goalies flagged on one side confirm nobody', bx.rows.length === 0);
chk('NHL boxscore: anything else is a DRIFT', G.nhlgParseNhlBoxscore({ message: 'not found' }).drift != null);

/* ---------------------------------------------------------------- the merge */
const o = (source, id, name, status, extra) => Object.assign({ source, goalie_id: id, goalie_name: name, status, fetched_at: '2026-10-25T18:00:00Z' }, extra || {});
const PROJ = { goalie_id: '8480947', goalie_name: 'K. Lankinen', p: 0.5154, as_of: '2026-10-25T12:41:00Z' };
let mg = G.nhlgMergeSide([], PROJ);
chk('merge: no source names anyone → EdgeDesk\'s usage projection, labelled Projected', mg.goalie_id === '8480947' && mg.status === 'projected' && mg.source === 'edgedesk_projection' && mg.basis === 'projection' && mg.p_start === 0.5154 && !mg.conflict, mg);
mg = G.nhlgMergeSide([], null);
chk('merge: no source and no projection → unknown, nobody named', mg.status === 'unknown' && mg.goalie_name === null && mg.basis === 'none');
mg = G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'unknown')], PROJ);
chk('merge: a source row with no readable status does not displace the projection', mg.source === 'edgedesk_projection');
mg = G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'likely')], PROJ);
chk('merge: one source → its goalie and status (the projection is only a fallback)', mg.goalie_id === '8482447' && mg.status === 'likely' && mg.source === 'daily_faceoff' && mg.basis === 'one_source', mg);
mg = G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'likely'), o('nhl_api_boxscore', '8482447', 'L. Meriläinen', 'confirmed')], PROJ);
chk('merge: sources that agree → the higher status, from the source that gave it', mg.status === 'confirmed' && mg.source === 'nhl_api_boxscore' && !mg.conflict && mg.basis === 'sources_agree' && mg.sources.length === 2, mg);
mg = G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'confirmed'), o('nhl_api_boxscore', '8480947', 'K. Lankinen', 'confirmed')], PROJ);
chk('conflict: two sources, two goalies → conflict flagged, both kept', mg.conflict && mg.conflict_detail.length === 2 && mg.basis === 'sources_disagree' && mg.alternates.length === 1, mg);
chk('conflict: the lead source\'s goalie (the NHL over Daily Faceoff) ...', mg.goalie_id === '8480947' && mg.source === 'nhl_api_boxscore');
chk('conflict: ... and never Confirmed, even when both sources say confirmed', mg.status === 'likely', mg.status);
mg = G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'projected'), o('nhl_api_boxscore', '8480947', 'K. Lankinen', 'confirmed')], PROJ);
chk('conflict: the LOWER of the two statuses', mg.conflict && mg.status === 'projected', mg);
mg = G.nhlgMergeSide([o('daily_faceoff', null, 'Arturs Silovs', 'likely')], PROJ);
chk('merge: an unmatched name is kept by name (no id is invented)', mg.goalie_id === null && mg.goalie_name === 'Arturs Silovs' && mg.status === 'likely');
const disp = G.nhlgDisplay(G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'likely')], PROJ), INPUTS);
chk('display: a matched goalie is named as EdgeDesk\'s registry names him, the source\'s spelling kept', disp.goalie_name === 'L. Meriläinen' && disp.reported_name === 'Leevi Merilainen', disp);

/* ---------------------------------------------------------------- pricing */
const scen = GI.slate_goalies.scenarios;
const repriced = scen.map((x) => G.nhlgPrice(GI, INPUTS, x.home_goalie, x.away_goalie, DIST));
chk('pricing: the inputs re-price every slate scenario of MIN @ VAN exactly (λ and the home probability, four decimals)',
  scen.every((x, i) => repriced[i].p_home === x.p_home && repriced[i].lambda.home === x.lambda.home && repriced[i].lambda.away === x.lambda.away && repriced[i].exp_total === x.exp_total), { scen, repriced: repriced.map((r) => [r.p_home, r.lambda, r.exp_total]) });
const pl = repriced[2];
chk('pricing: Meriläinen / Pickard gives VAN 42.4%, Lankinen / Pickard 41.2% (the goalie-aware variant)', pl.p_home === 0.4243 && repriced[0].p_home === 0.4117);
chk('pricing: the headline (xg_core) is copied, not re-priced: it carries no goalie term', GI.headline.p_home === 0.4174 && GI.headline.goalie_free === true && GI.headline.model_id === 'edgedesk_nhl_v1:xg_core');
const cal = INPUTS.model.pair_calibration;
chk('pricing: the pair calibration is hockey/model/glm.js\'s', [[2.1, 3.3], [3.4, 2.2], [2.9, 2.9]].every(([a, b]) => { const x = G.nhlgCalibrate(a, b, cal), y = GLM.applyPairCalibration(a, b, cal); return near(x.lh, y.lh) && near(x.la, y.la); }));
const un = G.nhlgPrice(GI, INPUTS, '999', '8475717', DIST);
chk('pricing: an unrated goalie is priced at the replacement-level prior and flagged', un.rated.home === false && un.rated.away === true && near(G.nhlgRate(INPUTS, '999', GI).rate, INPUTS.goalie_prior_rate));
chk('pricing: each pairing carries the puck lines and totals the gate asks', pl.puck_line['-1.5'] && pl.puck_line['1.5'] && pl.total['5.5'] && pl.total['6'] && near(pl.puck_line['-1.5'][1], 0) && pl.total['6'][1] > 0);

/* ---------------------------------------------------------------- the card */
const side = (src, id, name, status, extra) => G.nhlgDisplay(G.nhlgMergeSide(src ? [o(src, id, name, status, extra)] : [], src ? null : { goalie_id: id, goalie_name: name, p: 0.5154, as_of: '2026-10-25T12:41:00Z' }), INPUTS);
const projAway = { goalie_id: '8475717', goalie_name: 'C. Pickard', p: 0.7683, as_of: '2026-10-25T12:41:00Z' };
const m1 = { home: side(null, '8480947', 'K. Lankinen'), away: G.nhlgDisplay(G.nhlgMergeSide([], projAway), INPUTS) };
const c1 = G.nhlgBuildCard(GI, INPUTS, m1, DIST, { now: '2026-10-25T12:05:00Z' });
chk('card v1 (8 AM ET): Lankinen and Pickard, both Projected from the usage projection', c1.goalie_pairing_used.home.goalie_name === 'K. Lankinen' && c1.goalie_status.home === 'projected' && c1.goalie_status.away === 'projected' && c1.goalie_pairing_used.home.source === 'edgedesk_projection', c1.goalie_pairing_used);
chk('card v1: the generation time and the pairing used are recorded', c1.generated_at === '2026-10-25T12:05:00.000Z' && c1.pairing_price.home_goalie_id === '8480947' && c1.pairing_price.away_goalie_id === '8475717' && c1.pairing_price.p_home === 0.4117);
chk('card v1: not Confirmed → the full range over every realistic pairing (Lankinen / Meriläinen × Pickard / Wallstedt)', c1.show_range && c1.pairing_range.length === 4 && c1.range.p_home[0] === 0.3935 && c1.range.p_home[1] === 0.4243, c1.range);
chk('card v1: Known Limitations says "Starter not confirmed. Numbers may change." and names the projection', c1.known_limitations[0] === 'Starter not confirmed. Numbers may change.' && c1.known_limitations.some((l) => /usage projection \(52% to start\)/.test(l)), c1.known_limitations);
chk('card v1: the edge gate is GATED', c1.edge_gate.state === 'GATED' && c1.edge_gate.basis === 'EVERY_PAIRING');
chk('card v1: the headline is the slate\'s production number, unchanged', c1.headline.p_home === 0.4174 && c1.notes.some((n) => /carries no goalie term/.test(n)));
chk('card: no change note on the first version', c1.change_note === null);
const first = Object.assign({ id: 11, version: 1 }, c1);
const m2 = { home: side('daily_faceoff', '8482447', 'Leevi Merilainen', 'likely', { source_updated_at: '2026-10-25T17:42:00Z' }), away: side('daily_faceoff', '8475717', 'Cam Pickard', 'likely') };
const c2 = G.nhlgBuildCard(GI, INPUTS, m2, DIST, { now: '2026-10-25T18:05:00Z', first });
chk('card v2: Meriläinen Likely (Daily Faceoff, as of its news time)', c2.goalie_pairing_used.home.goalie_name === 'L. Meriläinen' && c2.goalie_pairing_used.home.badge === 'Likely' && c2.goalie_pairing_used.home.source_label === 'Daily Faceoff' && c2.goalie_pairing_used.home.as_of === '2026-10-25T17:42:00.000Z', c2.goalie_pairing_used.home);
chk('card v2: "Updated: starter changed from K. Lankinen to L. Meriläinen", with both versions\' win %', c2.change_note && c2.change_note.text === 'Updated: starter changed from K. Lankinen to L. Meriläinen' && c2.change_note.first_p_home === 0.4117 && c2.change_note.current_p_home === 0.4243 && c2.change_note.sides[0].team === 'VAN', c2.change_note);
chk('card v2: a Likely starter still keeps the projection\'s alternate in the range', c2.pairing_range.some((p) => p.home_goalie_id === '8480947') && c2.edge_gate.state === 'GATED');
const m3 = { home: side('daily_faceoff', '8482447', 'Leevi Merilainen', 'confirmed'), away: side('daily_faceoff', '8475717', 'Cam Pickard', 'confirmed') };
const c3 = G.nhlgBuildCard(GI, INPUTS, m3, DIST, { now: '2026-10-26T01:31:00Z', first });
chk('card: both Confirmed → one pairing, the gate OPEN, no "not confirmed" line', c3.pairing_range.length === 1 && c3.edge_gate.state === 'OPEN' && !c3.show_range && !c3.known_limitations.some((l) => /not confirmed/.test(l)), c3);
const mc = { home: G.nhlgDisplay(G.nhlgMergeSide([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'confirmed'), o('nhl_api_boxscore', '8480947', 'K. Lankinen', 'confirmed')], null), INPUTS), away: m3.away };
const cc = G.nhlgBuildCard(GI, INPUTS, mc, DIST, { now: '2026-10-26T01:31:00Z', first });
chk('card: a conflict is never shown as fact: the range, the gate GATED, a line naming both sources', cc.conflict && cc.show_range && cc.edge_gate.state === 'GATED' && cc.pairing_range.length === 2 && cc.known_limitations.some((l) => /Sources disagree on the VAN starter \(K\. Lankinen per NHL\.com game boxscore, L\. Meriläinen per Daily Faceoff\)/.test(l)), cc.known_limitations);

/* ---------------------------------------------------------------- change detection */
chk('change: no previous card → version 1 (initial)', G.nhlgCardChange(null, c1).trigger === 'initial');
const c1b = G.nhlgBuildCard(GI, INPUTS, m1, DIST, { now: '2026-10-25T14:05:00Z' });
chk('change: the same starters, statuses and numbers two hours later → no new version', !G.nhlgCardChange(c1, c1b).changed);
let ch = G.nhlgCardChange(c1, c2);
chk('change: a new starter is starter_changed (home), and the away status change is listed', ch.changed && ch.trigger === 'starter_changed' && ch.reasons.indexOf('starter_changed:home') >= 0 && ch.reasons.indexOf('status_changed:away') >= 0, ch);
const m2c = { home: side('daily_faceoff', '8482447', 'Leevi Merilainen', 'confirmed'), away: m2.away };
ch = G.nhlgCardChange(c2, G.nhlgBuildCard(GI, INPUTS, m2c, DIST, { now: '2026-10-25T23:30:00Z', first }));
chk('change: the same goalie, Likely → Confirmed, is status_changed', ch.changed && ch.trigger === 'status_changed' && ch.reasons.join() === 'status_changed:home', ch);
ch = G.nhlgCardChange(c3, cc);
chk('change: a conflict opening is a new version', ch.changed && ch.reasons.some((r) => /^(starter_changed|conflict_changed):home$/.test(r)), ch);
const GI2 = Object.assign({}, GI, { headline: Object.assign({}, GI.headline, { p_home: 0.43 }) });
ch = G.nhlgCardChange(c1, G.nhlgBuildCard(GI2, INPUTS, m1, DIST, { now: '2026-10-25T15:45:00Z' }));
chk('change: a new slate that moves the numbers is inputs_changed', ch.changed && ch.trigger === 'inputs_changed', ch);
chk('change: the source\'s spelling alone is not a new starter (identity is the goalie id)', !G.nhlgCardChange(c3, G.nhlgBuildCard(GI, INPUTS, { home: side('nhl_api_boxscore', '8482447', 'L. Merilainen', 'confirmed'), away: m3.away }, DIST, { now: '2026-10-26T01:40:00Z', first })).changed);

/* ---------------------------------------------------------------- the edge gate */
let g1 = G.nhlgEdgeGate(c1, { market: 'moneyline', side: 'home', american: 150 });
chk('gate: VAN +150 on v1 — the edge fails under Lankinen / Wallstedt, so it is GATED', !g1.flag_allowed && g1.basis === 'GATED' && g1.ev_by_pairing.length === 4 && g1.ev_min < 0.02, g1);
g1 = G.nhlgEdgeGate(c1, { market: 'moneyline', side: 'home', american: 175 });
chk('gate: VAN +175 holds under every pairing → allowed though not Confirmed (HOLDS_EVERY_PAIRING)', g1.flag_allowed && g1.basis === 'HOLDS_EVERY_PAIRING' && g1.ev_min >= 0.02, g1);
g1 = G.nhlgEdgeGate(G.nhlgBuildCard(GI, INPUTS, m2c, DIST, { now: '2026-10-25T23:30:00Z', first }), { market: 'moneyline', side: 'home', american: 150 });
chk('gate: VAN Confirmed but MIN only Likely → still GATED at +150 (Meriläinen / Wallstedt fails)', !g1.flag_allowed && g1.ev_by_pairing.length === 2, g1);
g1 = G.nhlgEdgeGate(c3, { market: 'moneyline', side: 'home', american: 150 });
chk('gate: both Confirmed → OPEN (the edge is judged as before)', g1.flag_allowed && g1.basis === 'BOTH_CONFIRMED');
g1 = G.nhlgEdgeGate(c1, { market: 'total', side: 'over', line: 5.5, american: 200 });
chk('gate: totals follow the same rule (an over at +200 holds under every pairing)', g1.flag_allowed && g1.ev_by_pairing.length === 4, g1);
g1 = G.nhlgEdgeGate(c1, { market: 'total', side: 'under', line: 7.5, american: 500 });
chk('gate: a line some pairing has no price for cannot pass', !g1.flag_allowed && g1.basis === 'GATED' && /not priced under every/.test(g1.reason), g1);
g1 = G.nhlgEdgeGate(c1, { market: 'puck_line', side: 'away', line: -1.5, american: 400 });
chk('gate: the puck line reads each pairing\'s own line (away −1.5 is home +1.5)', g1.ev_by_pairing.length === 4 && g1.ev_by_pairing.every((v) => v != null), g1);
const plAway = G.nhlgSideProb(c3.pairing_price, 'puck_line', 'away', -1.5);
chk('gate: away −1.5 = 1 − P(home covers +1.5)', near(plAway.p, 1 - c3.pairing_price.puck_line['1.5'][0] - c3.pairing_price.puck_line['1.5'][1], 1e-9));

/* ---------------------------------------------------------------- cadence */
const MV = [{ game_id: '2026020184', start_utc: '2026-10-26T02:00:00Z' }];
const due = G.nhlgDueTimes(MV);
const kinds = (k) => due.filter((x) => x.kind === k).map((x) => new Date(x.at).toISOString().slice(11, 16));
chk('cadence: every two hours from 8 AM Eastern until puck drop (8:00 ... 20:00 ET = 12:00 ... 00:00 UTC)', kinds('two_hour').join(',') === '12:00,14:00,16:00,18:00,20:00,22:00,00:00', kinds('two_hour'));
chk('cadence: every 15 minutes in the final three hours (23:00 ... 01:45 UTC)', kinds('pre_game').length === 11 && kinds('pre_game')[0] === '23:00' && kinds('pre_game')[10] === '01:45', kinds('pre_game'));
chk('cadence: the final pass at T-30 (01:30 UTC for a 10 PM ET puck drop)', kinds('final_pass').join() === '01:30');
let d = G.nhlgIsDue(Date.parse('2026-10-25T12:00:30Z'), null, MV);
chk('due: the 8 AM slot runs', d.due && d.kinds.join() === 'two_hour' && d.next_due_at === '2026-10-25T14:00:00.000Z', d);
d = G.nhlgIsDue(Date.parse('2026-10-25T12:05:00Z'), '2026-10-25T12:00:30Z', MV);
chk('due: five minutes later, nothing (the slot already ran)', !d.due);
d = G.nhlgIsDue(Date.parse('2026-10-26T01:30:10Z'), '2026-10-26T01:15:05Z', MV);
chk('due: the T-30 poke is the final pass for the game', d.due && d.kinds.join() === 'final_pass' && d.final_pass_games.join() === '2026020184', d);
d = G.nhlgIsDue(Date.parse('2026-10-25T20:00:00Z'), '2026-10-25T14:00:00Z', MV);
chk('due: a missed slot within 90 minutes is run once; older ones are not chased', d.due && d.kinds.join() === 'two_hour' && !G.nhlgIsDue(Date.parse('2026-10-25T21:45:00Z'), '2026-10-25T14:00:00Z', MV).due);
chk('cadence: an afternoon game adds its own 15-minute window', G.nhlgDueTimes([{ game_id: 'x', start_utc: '2026-10-25T17:00:00Z' }]).filter((x) => x.kind === 'pre_game' || x.kind === 'final_pass').length === 12);
{
  const s = Date.parse('2026-10-25T17:00:00Z'), lock = G.nhlgDueTimes([{ game_id: 'x', start_utc: '2026-10-25T17:00:00Z' }]).filter((x) => x.kind === 'lineup_lock').map((x) => (s - x.at) / 60000);
  chk('cadence: after the T-30 final pass, a lineup-lock check every 5 minutes until puck drop (T-25 ... T-5)', lock.join() === '25,20,15,10,5', lock);
}
chk('Eastern time: 8 AM on 2026-11-01 (standard time) is 13:00 UTC; on 2026-10-25 (daylight) 12:00 UTC', new Date(G.nhlgEtToUtc('2026-11-01', 8, 0)).toISOString() === '2026-11-01T13:00:00.000Z' && new Date(G.nhlgEtToUtc('2026-10-25', 8, 0)).toISOString() === '2026-10-25T12:00:00.000Z');
chk('Eastern date: a 10 PM ET puck drop belongs to its Eastern day', G.nhlgEtDate(Date.parse('2026-10-26T02:00:00Z')) === '2026-10-25');
chk('due: no games, nothing is due', !G.nhlgIsDue(Date.now(), null, []).due && G.nhlgIsDue(Date.now(), null, []).next_due_at === null);

/* ---------------------------------------------------------------- hashing and the copies */
chk('hash: the same content hashes the same whatever the key order', G.nhlgHash({ a: 1, b: [1, { c: 2, d: 3 }] }) === G.nhlgHash({ b: [1, { d: 3, c: 2 }], a: 1 }) && G.nhlgHash({ a: 1 }) !== G.nhlgHash({ a: 2 }));
try {
  const INL = require(path.join(ROOT, 'tools', 'hockey', 'inline_goalie_core.js'));
  chk('the edge function carries hockey/goalies/core.js and hockey/model/distribution.js verbatim (node tools/hockey/inline_goalie_core.js)', INL.current());
} catch (e) { chk('the inline check loads', false, e.message); }
/* ---------------------------------------------------------------- the lineup lock */
{
  const IN = FX.withLineups(INPUTS), gi = IN.games[0];
  const starters = { homeGoalies: [{ id: 8482447, name: 'L. Meriläinen', starter: true }], awayGoalies: [{ id: 8475717, name: 'C. Pickard', starter: true }] };
  const bx = G.nhlgParseNhlBoxscore(FX.boxscore(Object.assign({ id: 2026020184, home: 'VAN', away: 'MIN', homeSkaters: FX.skaterIds('VAN'), awaySkaters: FX.skaterIds('MIN') }, starters)), {});
  chk('lock: the boxscore\'s dressed skaters are read, forwards and defence, never the goalies', bx.lineups.home.length === 18 && bx.lineups.away.length === 18 && bx.lineups.home.indexOf('8482447') < 0 && bx.rows.length === 2, bx.lineups);
  chk('lock: before lineups post the boxscore lists no lineup', G.nhlgParseNhlBoxscore(FX.boxscore({ id: 2026020184, home: 'VAN', away: 'MIN' }), {}).lineups.home === null);
  const side = (id, name) => ({ goalie_id: id, goalie_name: name, status: 'confirmed', source: 'nhl_api_boxscore', conflict: false });
  const mC = { home: side('8482447', 'L. Meriläinen'), away: side('8475717', 'C. Pickard') };
  const full = { home: FX.skaterIds('VAN'), away: FX.skaterIds('MIN') };
  const lk = G.nhlgLockPrice(gi, IN, mC, full, DIST);
  const Bt = IN.model.all_beta, rH = G.nhlgRate(IN, '8482447', gi).rate, rA = G.nhlgRate(IN, '8475717', gi).rate;
  const lam = G.nhlgCalibrate(Math.exp(gi.lineup.eta.home + Bt.goalie * rA), Math.exp(gi.lineup.eta.away + Bt.goalie * rH), IN.model.all_pair_calibration);
  const D0 = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: IN.distribution.effects, ot: IN.distribution.ot });
  chk('lock: with both typical lineups the price is the formula (both deltas 0), named and labelled', lk && near(lk.p_home, D0.p_home, 1e-4) && lk.lineup.delta.home === 0 && lk.lineup.delta.away === 0 && lk.basis === 'lineup_lock' && lk.model_id === 'edgedesk_nhl_v1:xg_all_confirmed', lk);
  const miss = { home: full.home.slice(1).concat(['9100099']), away: full.away };
  const lk2 = G.nhlgLockPrice(gi, IN, mC, miss, DIST);
  chk('lock: a regular out for a call-up with no history (the 10-minute prior) lowers the club\'s own price', lk2 && near(lk2.lineup.delta.home, Math.log((17 * 1000 + 600) / 18000), 1e-4) && lk2.p_home < lk.p_home, lk2 && lk2.lineup);
  chk('lock: fewer than 12 listed skaters a side is not a lineup yet', G.nhlgLockPrice(gi, IN, mC, { home: full.home.slice(0, 11), away: full.away }, DIST) === null);
  const mL = JSON.parse(JSON.stringify(mC)); mL.away.status = 'likely';
  chk('lock: a starter not Confirmed is not a lock', G.nhlgLockPrice(gi, IN, mL, full, DIST) === null);
  const mX = JSON.parse(JSON.stringify(mC)); mX.home.conflict = true;
  chk('lock: sources disagreeing on a starter is not a lock', G.nhlgLockPrice(gi, IN, mX, full, DIST) === null);
  chk('lock: inputs built before this change (no lineup block) never lock', G.nhlgLockPrice(GI, INPUTS, mC, full, DIST) === null);
  const cU = G.nhlgBuildCard(gi, IN, mC, DIST, { now: '2026-10-26T01:31:00Z' });
  const cL = G.nhlgBuildCard(gi, IN, mC, DIST, { now: '2026-10-26T01:50:00Z', lineups: miss });
  chk('lock: before lock the headline is the slate\'s, unchanged', !cU.lineup_locked && cU.headline.p_home === GI.headline.p_home && !cU.headline.basis && /until lineup lock/.test(cU.notes[0]));
  chk('lock: at lock the headline is the lock price, with the slate\'s price before it, and the gate open', cL.lineup_locked && cL.headline.basis === 'lineup_lock' && cL.headline.p_home === lk2.p_home && cL.headline.before.p_home === GI.headline.p_home && cL.edge_gate.state === 'OPEN' && /^Priced at lineup lock/.test(cL.notes[0]), cL.headline);
  chk('lock: the headline carries every line the card prices, from one distribution', cL.headline.markets.puck_line['-1.5'][0] === cL.headline.puck_line.home_minus_1_5 && Object.keys(cL.headline.markets.total).length === 5 && near(cL.headline.p_home + cL.headline.p_away, 1, 1e-4) && cL.headline.fair_home === DIST.probToAmerican(cL.headline.p_home));
  const chL = G.nhlgCardChange(cU, cL);
  chk('lock: a new version, reason lineup_locked, under the table\'s inputs_changed trigger', chL.changed && chL.reasons.indexOf('lineup_locked') >= 0 && chL.trigger === 'inputs_changed', chL);
  chk('lock: the same lock five minutes later is not a new version', !G.nhlgCardChange(cL, G.nhlgBuildCard(gi, IN, mC, DIST, { now: '2026-10-26T01:55:00Z', lineups: miss })).changed);
  const mS = { home: Object.assign({}, mC.home, { status: 'likely' }), away: mC.away };
  const chS = G.nhlgCardChange(G.nhlgBuildCard(gi, IN, mS, DIST, { now: '2026-10-26T01:31:00Z' }), cL);
  chk('lock: a lock in the same run as a confirmation keeps the status_changed trigger and records both', chS.trigger === 'status_changed' && chS.reasons.indexOf('lineup_locked') >= 0, chS);
  const gate = G.nhlgEdgeGate(cL, { market: 'moneyline', side: 'home', american: 150 });
  chk('lock: an edge at lock is judged with both starters Confirmed (OPEN)', gate.flag_allowed && gate.basis === 'BOTH_CONFIRMED');
}

try {
  const B = require(path.join(ROOT, 'hockey', 'build_slate.js'));
  chk('the slate build exports the inputs writer and its check', typeof B.goalieInputsFile === 'function' && typeof B.checkGoalieInputs === 'function');
  const fakeSlate = { generated_at: INPUTS.slate_generated_at, games: [{ game_id: 2026020184, prices: { moneyline: { home: GI.headline.p_home } }, goalies: { scenarios: GI.slate_goalies.scenarios } }] };
  chk('build_slate --check: the fixture inputs re-price the slate scenarios', B.checkGoalieInputs(fakeSlate, INPUTS).length === 0, B.checkGoalieInputs(fakeSlate, INPUTS));
  const bad = JSON.parse(JSON.stringify(INPUTS)); bad.games[0].eta.home += 0.01;
  chk('build_slate --check: inputs that no longer re-price the scenarios fail', B.checkGoalieInputs(fakeSlate, bad).length > 0);
  /* the lineup lock's own check: each club's previous lineup with the likeliest starters re-prices to the build's number */
  const IL = FX.withLineups(INPUTS), L = IL.games[0].lineup;
  const both = { home: { status: 'confirmed', goalie_id: L.check.home_goalie_id, goalie_name: 'x' }, away: { status: 'confirmed', goalie_id: L.check.away_goalie_id, goalie_name: 'x' } };
  L.check.p_home = G.nhlgLockPrice(IL.games[0], IL, both, L.last, DIST).p_home;
  chk('build_slate --check: lineup-lock inputs that re-price the build\'s number pass', B.checkGoalieInputs(fakeSlate, IL).length === 0, B.checkGoalieInputs(fakeSlate, IL));
  const IL2 = JSON.parse(JSON.stringify(IL)); IL2.games[0].lineup.typical.home *= 1.05;
  chk('build_slate --check: lineup-lock inputs that no longer re-price it fail', B.checkGoalieInputs(fakeSlate, IL2).some((f) => /lineup lock re-prices/.test(f)), B.checkGoalieInputs(fakeSlate, IL2));
  const IL3 = JSON.parse(JSON.stringify(IL)); IL3.games[0].lineup.last.home = IL3.games[0].lineup.last.home.slice(0, 5);
  chk('build_slate --check: a lineup block that cannot price at all fails', B.checkGoalieInputs(fakeSlate, IL3).some((f) => /do not price/.test(f)));
} catch (e) { chk('the slate build loads', false, e.message); }

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL goalie core — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
