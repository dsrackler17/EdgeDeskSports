#!/usr/bin/env node
/* ===========================================================================
   NBA role shifts (NBA-ROLE-SHIFT v0.1, EXPERIMENTAL) on a constructed team
   (tools/sharp_lag/fixtures/role_shift_fixture.js), worked out by hand:
     splits     games WITH and WITHOUT the absent player while both were on
                the team (a DNP and a game he is missing from the box both
                count as without; a newcomer's games for another club never
                count)
     shrink     (n_without x without + 10 x with) / (n_without + 10)
     regime     the props model's minutes + the shrunk minutes delta, its
                per-minute rates x shrunk / with, 3PM = the regime's 3PA x his
                3P% shrunk toward the league with 100 attempts; the default
                prediction is never changed
     stints     the cross-check: court-time shares with him on and off, the
                minutes that implies, FGA / 3PA / assists per 36 either way
     scenario   the 3-4 teammates with the largest minutes or usage change
                are priced; a player who missed the last game is skipped (the
                default already prices the team without him)
     flags      the first book posting a two-way half-point line, the
                regime's P(side) - 1 / decimal >= 2.5 pp; never the absent
                player's under, never a past price
     grades     the same book and line closing <= 90 min before the start,
                Shin CLV, the actual stat from ESPN's box (void if he sat)
     page       "Who absorbs the minutes": switched on by OUT or DOUBTFUL on
                the current report only
     rules      the registration's numbers are the code's
   Run: node tools/sharp_lag/role_shift.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FX = require('./fixtures/role_shift_fixture.js');
const RS = require(path.join(ROOT, 'nba', 'props', 'role_shift.js'));
const PM = require(path.join(ROOT, 'nba', 'props', 'model.js'));
const L = require(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'));
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 1e-6 : e);

/* ── splits ────────────────────────────────────────────────────────────── */
const rows = FX.rows(), T = RS.teamIndex(rows, FX.games, '10');
const s1 = RS.splits(T, '1', '2', true);
chk('splits: 20 games with him, 10 without (5 listed DNPs and 5 missing from the box)', s1.with.g === 20 && s1.without.g === 10, [s1.with.g, s1.without.g]);
chk('splits: per game with / without: 24 / 32 minutes, 6 / 8 rebounds, 2 / 4 assists', s1.with.min / 20 === 24 && s1.without.min / 10 === 32 && s1.with.reb / 20 === 6 && s1.without.reb / 10 === 8 && s1.without.ast / 10 === 4);
chk('splits: usage = FGA + 0.44 FTA + TOV', near(s1.with.usage / 20, 10 + 0.44 * 2 + 1) && near(s1.without.usage / 10, 14 + 0.44 * 3 + 2));
const s4 = RS.splits(T, '1', '5', true);
chk('splits: a newcomer counts only his games for this club (5 without, 10 with)', s4.with.g === 10 && s4.without.g === 5, [s4.with.g, s4.without.g]);
chk('splits: a player who never shared the floor with him has no WITH games', RS.splits(T, '1', '7', true).with.g === 0);
chk('splits: before the absent player\'s first game for the club nothing counts', RS.splits(RS.teamIndex(rows.filter((r) => !(r.p === '1' && Number(r.g.slice(1)) <= 10)), FX.games, '10'), '1', '2', true).with.g === 10);

/* ── shrink ────────────────────────────────────────────────────────────── */
chk('shrink: (n x without + 10 x with) / (n + 10)', near(RS.shrink(24, 32, 10, 10), 28) && near(RS.shrink(10, 20, 5, 10), 40 / 3) && RS.shrink(24, null, 0, 10) === 24);
chk('3P%: shrunk toward the league with 100 attempts', near(RS.threePct({ fg3m: 70, fg3a: 180 }, 0.35, 100), (70 + 35) / 280));

/* ── regime ────────────────────────────────────────────────────────────── */
const M = FX.model(), up = FX.upcoming(), fT1 = up.find((u) => u.p === '2').f;
const pred0 = PM.predict(M, fT1), frozen = JSON.stringify(pred0);
const lgRows = rows.filter((r) => r.pl), lg3 = lgRows.reduce((a, r) => a + r.f3m, 0) / lgRows.reduce((a, r) => a + r.f3a, 0);
const own = lgRows.filter((r) => r.p === '2'), p3 = RS.threePct({ fg3m: own.reduce((a, r) => a + r.f3m, 0), fg3a: own.reduce((a, r) => a + r.f3a, 0) }, lg3, 100);
const rp = RS.regimePredict(M, pred0, s1, p3);
chk('regime: expected minutes = the model\'s 24 + the shrunk delta 4 = 28', near(pred0.min.mu, 24) && near(rp.minutes_delta, 4) && near(rp.min.mu, 28), [pred0.min.mu, rp.minutes_delta, rp.min.mu]);
chk('regime: the minutes nodes are the model\'s own residual quantiles around 28', rp.min.nodes.length === 11 && near(rp.min.nodes[0], 22) && near(rp.min.nodes[10], 34));
chk('regime: a per-minute rate moves by shrunk / with (assists x 1.25, rebounds x 1)', near(rp.stat.ast.lam, pred0.stat.ast.lam * 1.25) && near(rp.stat.reb.lam, pred0.stat.reb.lam), [rp.stat.ast.lam / pred0.stat.ast.lam]);
chk('regime: 3PM = the regime\'s 3PA x his shrunk 3P%', near(rp.stat.fg3m.lam, rp.stat.fg3a.lam * p3) && near(rp.stat.fg3a.lam, pred0.stat.fg3a.lam * 1.1, 1e-9), [rp.stat.fg3a.lam / pred0.stat.fg3a.lam]);
chk('regime: the model\'s variance function and correlations are kept', rp.stat.reb.a === pred0.stat.reb.a && rp.stat.reb.b === pred0.stat.reb.b);
chk('regime: the default prediction is not touched', JSON.stringify(pred0) === frozen);

/* ── stints ────────────────────────────────────────────────────────────── */
const G = RS.stintIndex(FX.stints(), FX.shots(), FX.games);
const st = RS.stintCheck(G, '10', '1', '2', s1.with_games);
chk('stints: his court share with A on (1980 / 2280) and off (600 / 600)', near(st.share_with, 0.8684, 1e-4) && st.share_without === 1, st);
chk('stints: the minutes that implies: 48 x (1 - 2580 / 2880) = 5.0', near(st.minutes_delta, 5), st.minutes_delta);
chk('stints: one stint a game without him, ten games', st.sample === 10 && st.games === 20);
chk('stints: FGA, 3PA and assists per 36, with A on and off (shots placed by game time)', st.per36.fga[0] === 1.09 && st.per36.fga[1] === 3.6 && st.per36.fg3a[0] === 0 && st.per36.fg3a[1] === 3.6 && st.per36.ast[1] === 3.6, st.per36);

/* ── scenario and file ─────────────────────────────────────────────────── */
const FILE = FX.file();
const g1 = FILE.games[0], scA = g1.scenarios.find((s) => s.absent.id === '1');
chk('file: one scenario per top-8 rotation player of each club', FILE.schema === 'edgedesk_nba_role_shift_v1' && g1.scenarios.length === 7 && g1.scenarios.every((s) => s.regime === 'injury_conditioned'));
chk('file: the model is NBA-ROLE-SHIFT v0.1, EXPERIMENTAL, regime injury_conditioned beside the default (projected)',
  FILE.model.key === 'NBA-ROLE-SHIFT' && FILE.model.version === '0.1' && FILE.model.status === 'EXPERIMENTAL' && FILE.model.default_regime === 'projected');
const byId = (sc, id) => sc.teammates.find((t) => t.id === id);
chk('scenario: the absorber: 24 -> 28 minutes, 10 games without, 20 with', byId(scA, '2').minutes_default === 24 && byId(scA, '2').minutes_regime === 28 && byId(scA, '2').minutes_delta === 4 && byId(scA, '2').games_without === 10);
chk('scenario: the stints agree with the game-level split', byId(scA, '2').stints_agree === true && byId(scA, '2').stints.minutes_delta === 5);
chk('scenario: the 3 teammates with the largest minutes or usage change are priced, largest first', JSON.stringify(scA.priced) === JSON.stringify(['2', '5', '4']) && scA.short_of_three === false, scA.priced);
chk('scenario: no change, not priced; never with him, skipped with the reason', !byId(scA, '3').priced && /no game with him/.test(byId(scA, '7').skipped));
chk('scenario: a player who missed the last game is skipped: the default already prices the team without him', /did not play his team's last game/.test(g1.scenarios.find((s) => s.absent.id === '6').skipped));
const mk = byId(scA, '2').markets;
chk('scenario: the four volume markets the pull buys', JSON.stringify(Object.keys(mk).map((k) => mk[k].market)) === JSON.stringify(['player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists']));
chk('scenario: rebounds: default mean 6.0, regime 7.0 (the same rate over 28 minutes)', near(mk.reb.default_mean, 6, 0.05) && near(mk.reb.mean, 7, 0.05), [mk.reb.default_mean, mk.reb.mean]);
const lines = Object.keys(mk.reb.over).map(Number);
chk('scenario: P(over) at every half-point line within 5 of the mean, falling as the line rises', lines.every((x) => x % 1 === 0.5) && lines.length === 11
  && lines.every((x, i) => i === 0 || mk.reb.over[x.toFixed(1)] <= mk.reb.over[lines[i - 1].toFixed(1)]));
chk('scenario: the fair line is the one nearest 50%', Object.keys(mk.reb.over).every((k) => Math.abs(mk.reb.over[k] - 0.5) >= Math.abs(mk.reb.over[mk.reb.fair_line.toFixed(1)] - 0.5)));
chk('scenario: 3PM beside the regime is made the same way for the default (its 3PA x the same shrunk 3P%), so the change is the absence\'s alone',
  near(mk.fg3m.default_mean, pred0.stat.fg3a.lam * p3 * 24, 0.02) && near(mk.fg3m.mean, rp.stat.fg3a.lam * p3 * 28, 0.02), [mk.fg3m.default_mean, mk.fg3m.mean]);
chk('scenario: P+R+A comes from the correlated combination (PM.comboDist), not a sum of marginals', near(mk.pra.mean, rp.stat.pts.mu + rp.stat.reb.mu + rp.stat.ast.mu, 0.1), [mk.pra.mean]);

/* ── flags ─────────────────────────────────────────────────────────────── */
const NOW = '2026-11-01T22:00:00Z', at = (m) => new Date(Date.parse(NOW) + m * 60000).toISOString();
const change = { player_id: '1', player_name: 'Absent Star', from: 'QUESTIONABLE', to: 'OUT' };
const detail = L.roleShiftDetail(FILE, scA, change, { id: 51, previous_id: 50, captured_at: at(-20) });
chk('trigger: the regime switch, the absent player and his move, the priced teammates and the whole table', detail.regime_switch.from === 'projected' && detail.regime_switch.to === 'injury_conditioned'
  && detail.absent.to === 'OUT' && detail.teammates.length === 3 && detail.table.length === 6 && !detail.table.some((t) => t.markets));
const ev = { event_id: 'evG1', sport_key: 'basketball_nba', home_team: 'Home Club', away_team: 'Away Club', commence_time: '2026-11-02T00:00:00Z' };
const pr = (book, participant, market, side, point, dec, extra) => Object.assign({ book, participant, market, side, point, price_dec: dec, captured_at: at(-5) }, extra || {});
const pOver65 = mk.reb.over['6.5'];
const props = [pr('draftkings', 'Absorber', 'player_rebounds', 'Over', 6.5, 2.05), pr('draftkings', 'Absorber', 'player_rebounds', 'Under', 6.5, 1.8),
  pr('fanduel', 'Absorber', 'player_rebounds', 'Over', 7.5, 2.2), pr('fanduel', 'Absorber', 'player_rebounds', 'Under', 7.5, 1.7),
  pr('draftkings', 'Absorber', 'player_assists', 'Over', 2.5, 1.9), /* one side only at DraftKings: FanDuel's pair is the first two-way line */
  pr('fanduel', 'Absorber', 'player_assists', 'Over', 2.5, 2.1), pr('fanduel', 'Absorber', 'player_assists', 'Under', 2.5, 1.75),
  pr('draftkings', 'Absorber', 'player_threes', 'Over', 2, 1.9), pr('draftkings', 'Absorber', 'player_threes', 'Under', 2, 1.9)];
const E = L.evaluateRoleShift({ now: NOW, event: ev, trigger: { id: 9, detail }, rows: props, observed_at: at(-5), request_id: 777, resolution_s: 900 });
const reb = E.flags.find((f) => f.market === 'player_rebounds');
chk('flags: rebounds Over 6.5 at DraftKings (the first book in order), the regime\'s P(over) minus 1 / 2.05', reb && reb.side === 'Over' && reb.target_venue === 'draftkings' && reb.posted_line === 6.5
  && near(reb.gap_pp, Math.round((pOver65 - 1 / 2.05) * 1e4) / 100, 0.011) && reb.gap_pp >= 2.5, reb && [reb.gap_pp, pOver65]);
chk('flags: the row names the absent player, the minutes delta, both samples, both lines and both prices', reb && reb.absent_player_id === '1' && reb.absent_player_name === 'Absent Star' && reb.minutes_delta === 4
  && reb.sample_games === 10 && reb.sample_stints === 10 && reb.fair_line === mk.reb.fair_line && reb.posted_line === 6.5 && reb.target_price_american === 105 && reb.fair_price_american === L.decToAm(1 / pOver65), reb);
chk('flags: research model NBA-ROLE-SHIFT at the registered 2.5 pp, the build as its reference, no fee', reb && reb.model_key === 'NBA-ROLE-SHIFT' && reb.reference_kind === 'role_shift_model' && reb.threshold_pp === 2.5
  && reb.fee_basis === 'none' && reb.trigger_type === 'role_shift' && reb.trigger_id === 9 && reb.snapshot_resolution_s === 900 && reb.episode_key === 'role_shift|evG1|absorber|player_rebounds|Over');
chk('flags: a side under the threshold is not flagged (rebounds Under)', !E.flags.some((f) => f.market === 'player_rebounds' && f.side === 'Under'));
const ast = E.flags.filter((f) => f.market === 'player_assists');
chk('flags: a book posting one side only is passed over for the next book\'s two-way line', ast.every((f) => f.target_venue === 'fanduel') && E.flags.every((f) => f.target_venue !== 'draftkings' || f.market !== 'player_assists'));
chk('flags: a whole-number line is not evaluated (a push is possible)', E.skipped.whole_number_line >= 1 && !E.flags.some((f) => f.market === 'player_threes'), E.skipped);
const E2 = L.evaluateRoleShift({ now: NOW, event: ev, trigger: { id: 9, detail }, rows: props, observed_at: at(-95), request_id: 777 });
chk('flags: a price older than 90 minutes is a past price, never flagged', E2.flags.length === 0 && E2.skipped.past_price === 1);
const E3 = L.evaluateRoleShift({ now: NOW, event: ev, trigger: { id: 9, detail }, rows: props, observed_at: at(-5), request_id: 777, open: (k) => /player_rebounds/.test(k) });
chk('flags: one flag per player, market and side (an episode already written is not repeated)', !E3.flags.some((f) => f.market === 'player_rebounds') && E3.skipped.episode_open >= 1);
const selfUnder = Object.assign({}, detail, { teammates: [Object.assign({}, detail.teammates[0], { id: '1', name: 'Absent Star' })] });
const E4 = L.evaluateRoleShift({ now: NOW, event: ev, trigger: { id: 9, detail: selfUnder }, observed_at: at(-5),
  rows: [pr('draftkings', 'Absent Star', 'player_rebounds', 'Over', 9.5, 3.5), pr('draftkings', 'Absent Star', 'player_rebounds', 'Under', 9.5, 2.6)] });
chk('flags: the absent player\'s own under is never flagged', !E4.flags.some((f) => f.side === 'Under') && E4.skipped.absent_players_under === 1, E4.skipped);
chk('flags: never after the start', L.evaluateRoleShift({ now: '2026-11-02T00:05:00Z', event: ev, trigger: { id: 9, detail }, rows: props, observed_at: '2026-11-02T00:00:00Z' }).skipped.not_pregame === 1);

/* ── grades ────────────────────────────────────────────────────────────── */
const flag = Object.assign({ flag_id: 31, flag_detail: reb.detail }, reb, { flagged_at: NOW });
const obs = (min, over, under, book) => ({ observed_at: new Date(Date.parse(ev.commence_time) + min * 60000).toISOString(), request_id: 900 + min,
  rows: [{ book: book || 'draftkings', participant: 'Absorber', market: 'player_rebounds', side: 'Over', point: 6.5, price_dec: over }, { book: book || 'draftkings', participant: 'Absorber', market: 'player_rebounds', side: 'Under', point: 6.5, price_dec: under }] });
const BOX = { header: { competitions: [{ status: { type: { completed: true } } }] }, boxscore: { players: [{ team: { id: '10' }, statistics: [{
  keys: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'rebounds', 'assists', 'points'], labels: ['MIN', 'FG', '3PT', 'REB', 'AST', 'PTS'],
  athletes: [{ athlete: { id: '2', displayName: 'Absorber' }, stats: ['31', '6-13', '3-7', '9', '3', '17'] }, { athlete: { id: '1', displayName: 'Absent Star' }, didNotPlay: true, stats: [] }] }] }] } };
const box = L.espnBox(BOX);
chk('ESPN box: final, minutes, rebounds, assists, points and 3PM from "made-attempted"', box.final && box.players['2'].reb === 9 && box.players['2'].fg3m === 3 && box.players['2'].pts === 17 && box.players['2'].played && !box.players['1'].played, box.players);
let gr = L.gradeRoleShift(flag, { observations: [obs(-200, 1.8, 2.0), obs(-20, 1.7, 2.2), obs(-20, 1.5, 2.6, 'fanduel')], box });
const close = L.devigShin([1.7, 2.2]).probs[0];
chk('grades: the close is DraftKings\' last pair at 6.5, 20 minutes before the start; CLV = its Shin P(over) - the cost', gr.close_status === 'graded' && gr.close_lead_min === 20
  && near(gr.clv_pp, Math.round((close - reb.target_cost_prob) * 1e4) / 100, 0.011) && gr.hit === (gr.clv_pp > 0) && gr.closing_target_price === 1.7, gr);
chk('grades: the actual stat beside CLV: 9 rebounds, over 6.5', gr.actual_stat === 9 && gr.actual_outcome === 'over');
chk('grades: converged when the close is within 1.0 pp of the regime\'s probability, else censored', gr.converged === (Math.abs(close - reb.reference_prob) * 100 <= 1) && gr.lag_censored === !gr.converged);
gr = L.gradeRoleShift(Object.assign({}, flag, { target_observed_at: obs(-20, 0, 0).observed_at }), { observations: [obs(-200, 1.8, 2.0), obs(-20, 1.7, 2.2)], box });
chk('grades: the price the flag was taken from is never its close: no later price before the start is no close', gr.close_status === 'no_close' && /after the flag/.test(gr.no_close_reason) && gr.clv_pp === null, gr);
gr = L.gradeRoleShift(Object.assign({}, flag, { target_observed_at: obs(-300, 0, 0).observed_at }), { observations: [obs(-200, 1.8, 2.0)], box });
chk('grades: a last price 200 minutes before the start is no close: counted, with its reason, no CLV', gr.close_status === 'no_close' && /200 minutes/.test(gr.no_close_reason) && gr.clv_pp === null && gr.actual_stat === 9);
gr = L.gradeRoleShift(Object.assign({}, flag, { flag_detail: { participant_id: '1' }, participant: 'Absent Star' }), { observations: [obs(-20, 1.7, 2.2)], box });
chk('grades: a player who did not play: void, no stat', gr.actual_outcome === 'void' && gr.actual_stat === null);
gr = L.gradeRoleShift(flag, { observations: [obs(-20, 1.7, 2.2)], box: null });
chk('grades: no final box: CLV is graded and the missing stat is said, never guessed', gr.close_status === 'graded' && gr.actual_outcome === null && /no final box/.test(gr.detail.actual_missing));

/* ── record ────────────────────────────────────────────────────────────── */
const recRows = [Object.assign({}, flag, { close_status: 'graded', clv_pp: 1, actual_outcome: 'over', event_id: 'a' }), Object.assign({}, flag, { flag_id: 32, close_status: 'graded', clv_pp: -1, actual_outcome: 'void', event_id: 'b' })];
const rec = L.record(recRows, { model_key: 'NBA-ROLE-SHIFT' });
chk('record: the actual results are counted beside CLV and shown as not the criterion', rec.outcomes.over === 1 && rec.outcomes.void === 1
  && /1 over, 0 under, 0 push, 1 void/.test(L.recordSection({ title: 'x', record: rec })) && /CLV, not these, is the registered criterion/.test(L.recordSection({ title: 'x', record: rec })));

/* ── the page ──────────────────────────────────────────────────────────── */
const sec = (statuses, live) => L.roleShiftSection({ file: FILE, gameId: 'G1', statuses, live });
const on = sec([{ player_id: '1', player_name: 'Absent Star', status: 'OUT' }], true);
chk('page: OUT on the current report switches the table on, tagged Experimental', /Who absorbs the minutes/.test(on) && /Experimental/.test(on) && /Absent Star \(HOM\) is out/.test(on) && /Absorber/.test(on) && /24\.0 → 28\.0/.test(on) && /\+4\.0/.test(on), on.slice(0, 900));
chk('page: each row: minutes, usage, games without / with, the stint cross-check, the volume default -> regime', /10 \/ 20/.test(on) && /\+5\.0 min/.test(on) && /Rebounds 6\.0 → 7\.0/.test(on) && /priced/.test(on));
chk('page: QUESTIONABLE switches nothing; the default projections stand', /default projections stand/.test(sec([{ player_id: '1', status: 'QUESTIONABLE' }], true)) && !/<table/.test(sec([{ player_id: '1', status: 'QUESTIONABLE' }], true)));
chk('page: no current report, no regime switch', /No current injury report/.test(sec([], false)));
chk('page: a skipped scenario says why', /No regime switch: did not play/.test(sec([{ player_id: '6', player_name: 'Bench Out', status: 'DOUBTFUL' }], true)));
chk('page: research language only', !/\b(bet|bets|betting|pick|picks|lock|wager|hammer|best bet|units?)\b/i.test(on.replace(/not advice/g, '')));

/* ── rules ─────────────────────────────────────────────────────────────── */
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'sharp_lag', 'registration_role_shift.json'), 'utf8'));
const spec = JSON.stringify(reg.spec), cand = reg.forking_paths.candidates_tried[0];
chk('rules: the registration\'s numbers are the code\'s (k = 10 games, 100 attempts, top 8, 2.5 pp)', cand.shrinkage_games === RS.RULES.k_games && cand.three_pct_prior_attempts === RS.RULES.p3_prior_attempts
  && cand.gap_pp === L.RULES.role_shift_gap_pp && /top-8/.test(cand.trigger) && RS.RULES.top_n === 8 && L.ROLE_SHIFT.rotation === 8 && /k = 10 games/.test(spec) && /100 attempts/.test(spec));
chk('rules: the registration\'s book order is the code\'s', reg.spec.flag.indexOf(L.PROP_BOOKS.join(', ')) >= 0);
chk('rules: OUT and DOUBTFUL, never QUESTIONABLE', JSON.stringify(RS.RULES.statuses) === '["OUT","DOUBTFUL"]' && JSON.stringify(L.ROLE_SHIFT.statuses) === '["OUT","DOUBTFUL"]');
const fnSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'sharp_lag', 'index.ts'), 'utf8');
const fnProps = JSON.parse((/const PROPS = (\[[^\]]+\]);/.exec(fnSrc) || [])[1] || '[]');
chk('rules: the markets the build prices are the markets the pull stores and the flags read', JSON.stringify(fnProps) === JSON.stringify(Object.values(RS.MARKETS)) && JSON.stringify(Object.keys(L.ROLE_SHIFT.markets)) === JSON.stringify(Object.values(RS.MARKETS)));
const bp = fs.readFileSync(path.join(ROOT, 'nba', 'props', 'build_props.js'), 'utf8');
chk('build: the default slate is computed first and only points at the scenarios; a failure there never stops it', bp.indexOf('out.regimes = ') > bp.indexOf('const games = slate.games.map') && /function roleShift\([^)]*\) \{\s*try \{/.test(bp) && /catch \(e\) \{\s*console\.error/.test(bp));
chk('build: role_shift.js writes no file at all (build_props.js writes its output beside the slate)', !/writeFileSync|require\('fs'\)/.test(fs.readFileSync(path.join(ROOT, 'nba', 'props', 'role_shift.js'), 'utf8')));
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'nba-build.yml'), 'utf8');
chk('build: the scheduled NBA build commits nba/role_shift.json', /push_generated\.sh main[^\n]*\n[^\n]*nba\/role_shift\.json/.test(wf));

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' nba role shift: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
process.exit(fail ? 1 : 0);
