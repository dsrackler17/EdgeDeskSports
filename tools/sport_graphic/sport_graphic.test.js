#!/usr/bin/env node
/* ===========================================================================
   The matchup graphic for every other sport (lib/edgedesk_sport_graphic.js):
   men's and women's college basketball and the WNBA (basketball/slate.json),
   MLB and college baseball (mlb/engine.js), and UFC bouts (the served UFC
   Elo), offline. docs/game-research/SPORTS.md

     basketball  every committed lab-slate game builds for every league that
                 shares the schema; the fair spread, fair total, moneyline and
                 the projected score are the slate's own; the win percents add
                 to 100; Today's Games' team names, abbreviations and records
                 are used; a neutral site reads VS
     baseball    MLB: the engine's fair moneyline, expected runs and total;
                 the market strip only from a captured price with its book and
                 time; a data fault replaces the strip; a game the engine
                 could not price draws "no projection" and why. College: never
                 a price of any kind, only the board's projection
     ufc         every served bout builds; the fair price is the model's
                 probability with no margin; the guard's gap and verdict; a
                 market observed after the start is not drawn; the main event
                 is found from the card's name
     rules       no EDGE label (value claims are off for every one of these
                 models), the copy rule, the market's age, layout inside the
                 canvas in both formats, the new surfaces, football unchanged
     today       Today's Games lists women's college basketball and the WNBA;
                 the slate joins their games (and men's) to the lab model with
                 the fair spread it holds; the matchup view mounts the graphic

   Run: node tools/sport_graphic/sport_graphic.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const S = require(path.join(ROOT, 'lib', 'edgedesk_sport_graphic.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
const GAMES = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const RES = require(path.join(ROOT, 'tools', 'slate', 'research.js'));
require(path.join(ROOT, 'mlb', 'params.js'));
const E = require(path.join(ROOT, 'mlb', 'engine.js'));
const BB = JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball', 'slate.json'), 'utf8'));
const UFC = JSON.parse(fs.readFileSync(path.join(ROOT, 'model_loop', 'published', 'ufc', 'current.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const clone = (x) => JSON.parse(JSON.stringify(x));
const minus = (t) => String(t).replace(/−/g, '-');
function strings(c) { const out = []; (function walk(v) { if (v == null) return; if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k])); })(c); return out; }
function inside(c, label) {
  ['square', 'portrait'].forEach((f) => {
    const L = G.layout(c, f);
    const out = L.ops.filter((o) => o.type === 'text' && (o.y > L.height || o.y < 0 || (o.align === 'left' && o.x + Math.min(o.width, o.maxW || o.width) > L.width + 1) || (o.align === 'right' && o.x - Math.min(o.width, o.maxW || o.width) < -1)));
    chk('layout keeps every text on the canvas (' + f + '): ' + label, out.length === 0, out.map((o) => o.text));
    const bad = L.ops.filter((o) => o.type === 'text' && /undefined|NaN|null/.test(String(o.text)));
    chk('no undefined, NaN or null printed (' + f + '): ' + label, bad.length === 0, bad.map((o) => o.text));
  });
}
function common(r, label) {
  chk('builds: ' + label, r.ok, r);
  if (!r.ok) return null;
  const c = r.content;
  chk('win percents add to 100: ' + label, !c.model_available || c.win.home_pct + c.win.away_pct === 100, c.win);
  chk('never an EDGE label (value claims are off): ' + label, !c.edge && !strings(c).some((t) => /\bEDGE:/.test(t)));
  chk('the copy rule holds: ' + label, !strings(c).some((t) => S.BANNED.test(t)));
  chk('what to watch: at most four, each with a title and a line: ' + label, c.insights.length <= 4 && c.insights.every((i) => i.icon && i.title && i.text));
  chk('a key and an alt text: ' + label, !!r.key && /Research, not picks\.$/.test(c.alt));
  inside(c, label);
  return c;
}

/* ============================================================ BASKETBALL */
/* every league in the lab slate shares one schema: each game is drawn as each
   college league too, so the shapes are tested before the college season opens */
const NOW_BB = Date.parse(BB.generated_at) + 60000;
const labGames = [];
Object.keys(BB.leagues).forEach((lk) => (BB.leagues[lk].games || []).forEach((g) => labGames.push({ lk, g, L: BB.leagues[lk] })));
chk('the committed basketball slate has games to draw', labGames.length > 0);
labGames.forEach(({ lk, g, L }) => {
  ['ncaam', 'ncaaw', 'wnba'].forEach((league) => {
    const label = league + ' (from ' + lk + ') ' + g.game_id;
    const c = common(S.basketball(g, L, { league, now: NOW_BB, generated_at: BB.generated_at }), label);
    if (!c) return;
    const P = g.prices, M = P.spread.projected_margin, T = P.total.projected, fl = P.spread.fair_home_line;
    chk('the fair spread is the slate’s, for the team it favours: ' + label, fl === 0 ? c.spread_value === 'PK' : Number(minus(c.spread_value)) === -Math.abs(fl), [c.spread_value, fl]);
    chk('the fair total is the slate’s fair line: ' + label, Number(c.total) === P.total.fair_line, [c.total, P.total.fair_line]);
    chk('the projected score is the slate’s total and margin read back: ' + label, Math.abs(Number(c.scores.home) + Number(c.scores.away) - T) <= 0.11 && Math.abs(Number(c.scores.home) - Number(c.scores.away) - M) <= 0.11, [c.scores, T, M]);
    chk('the favourite follows the moneyline: ' + label, c.fav_side === (P.moneyline.home >= 0.5 ? 'home' : 'away'));
    chk('the model moneyline is the slate’s: ' + label, minus(c.fair_ml.home) === (P.moneyline.fair_home > 0 ? '+' : '') + P.moneyline.fair_home);
    chk('drawn on a court, a league label: ' + label, c.surface === 'court' && c.league_label === S.LEAGUES[league].label);
    chk('who is playing says availability is not in the number: ' + label, c.insights[0].title === 'WHO IS PLAYING' && /not modelled/.test(c.insights[0].text));
    chk('without a price, EdgeDesk’s own detail: ' + label, !c.market && c.detail && c.detail.cells.length >= 2);
    chk('bar colours visible and distinct: ' + label, S._lum(c.home.bar) >= 0.03 && S._lum(c.away.bar) >= 0.03 && c.home.bar !== c.away.bar, [c.home.bar, c.away.bar]);
  });
});
const B0 = (BB.leagues.wnba.games || [])[0] || labGames[0].g, L0 = BB.leagues.wnba;
const start0 = Date.parse(B0.start_utc), NOW0 = start0 - 3 * 3600e3;
const teams = { home: { name: 'Villanova Wildcats', short: 'Villanova', abbr: 'VILL', record: '3-1', rank: 18 }, away: { name: 'Notre Dame Fighting Irish', short: 'Notre Dame', abbr: 'ND', record: '0-0' } };
const named = S.basketball(B0, L0, { league: 'ncaam', now: NOW0, teams }).content;
chk('Today’s Games’ names, abbreviations and record print', named.home.abbr === 'VILL' && named.home.short === 'VILLANOVA' && named.home.record === '(3-1)' && named.home.rank === '#18' && named.away.abbr === 'ND', [named.home, named.away]);
chk('…a 0-0 record before the season is not printed', named.away.record === '');
chk('a neutral site reads VS, no home court in the number', (() => { const c = S.basketball(Object.assign(clone(B0), { neutral: true }), L0, { league: 'ncaaw', now: NOW0 }).content; return c.at_word === 'VS' && /NEUTRAL SITE/.test(c.context) && c.insights.some((i) => i.title === 'NEUTRAL SITE'); })());
chk('a home game reads AT and names home court', !named.at_word === !B0.neutral && (B0.neutral || named.insights.some((i) => i.title === 'HOME COURT')));
const mkt = (minsBeforeNow, at) => ({ book: 'Draft Kings', source: 'espn_scoreboard', captured_at: new Date((at != null ? at : NOW0) - minsBeforeNow * 60000).toISOString(), moneyline: { home: -150, away: 130 }, spread: { home: { point: -3.5, price: -110 }, away: { point: 3.5, price: -110 } }, total: { point: 158.5, over: -110, under: -110 } });
const withMk = S.basketball(B0, L0, { league: 'wnba', now: NOW0, market: mkt(20) }).content;
chk('a recent captured price: the market snapshot with its book and the gaps in words', withMk.market && withMk.market.title === 'MARKET SNAPSHOT' && /DraftKings via ESPN/.test(withMk.market.meta) && withMk.market.vs.length >= 1 && /^Spread: EdgeDesk|^Total: EdgeDesk|^Win %/.test(withMk.market.vs[0]), withMk.market);
chk('…the no-vig split adds to 100', withMk.market.no_vig && parseInt(withMk.market.no_vig.home, 10) + parseInt(withMk.market.no_vig.away, 10) === 100);
chk('…and the market gap is a thing to research', withMk.insights.some((i) => i.title === 'MODEL VS MARKET'));
chk('an older capture is the last known market', S.basketball(B0, L0, { league: 'wnba', now: NOW0, market: mkt(400) }).content.market.title === 'LAST KNOWN MARKET');
chk('a price captured after the start is never drawn', !S.basketball(B0, L0, { league: 'wnba', now: start0 + 3600e3, market: mkt(0, start0 + 600000) }).content.market);
chk('the cache key moves with the price shown, the grade and the teams', (() => { const k = (o) => S.basketball(B0, L0, Object.assign({ league: 'wnba', now: NOW0 }, o)).key; return k({}) !== k({ market: mkt(20) }) && k({}) !== k({ grade: { letter: 'B', score: 80 } }) && k({}) !== k({ teams }); })());
chk('a game with no price is refused, not drawn', S.basketball(Object.assign(clone(B0), { prices: null }), L0, { league: 'ncaam' }).ok === false);
chk('the WNBA has its colours', (() => { const c = S.basketball(B0, L0, { league: 'wnba', now: NOW0 }).content; return !/^#(1d4ed8|b91c1c|047857)/.test(c.home.color) || !!S.WNBA[B0.home]; })());
chk('a school EdgeDesk holds no colours for gets the same badge every time', S.team({ name: 'Grambling Tigers' }).color === S.team({ name: 'Grambling Tigers' }).color && S.abbrOf('Grambling Tigers') === 'GT' && S.abbrOf('Vanderbilt') === 'VAND');
chk('a basketball graphic is labelled expected points with overtime', /OT INCLUDED/.test(named.labels.center_sub));

/* the lab slate's game for a Today's Games event: ESPN's id and the same sides */
const ev = (o) => Object.assign({ id: 'ncaam:espn:' + B0.game_id, sport: 'ncaam', provider: 'espn', provider_id: String(B0.game_id), home: { id: String(B0.home_id), name: B0.home }, away: { id: String(B0.away_id), name: B0.away } }, o || {});
const slateAs = (lk) => { const s = clone(BB); s.leagues[lk] = Object.assign({}, s.leagues[lk], { games: [clone(B0)] }); return s; };
chk('labGame finds the event’s game by ESPN id', S.labGame(slateAs('ncaam'), 'ncaam', ev()).ok === true);
chk('…refuses a game listed the other way round', (() => { const r = S.labGame(slateAs('ncaam'), 'ncaam', ev({ home: { id: String(B0.away_id) }, away: { id: String(B0.home_id) } })); return r.ok === false && /other way round/.test(r.message); })());
chk('…and says when the game is not priced yet', (() => { const r = S.labGame(slateAs('ncaam'), 'ncaam', ev({ provider_id: '1' })); return r.ok === false && /not priced this game yet/.test(r.message); })());

/* ============================================================== BASEBALL */
const NOW_B = Date.parse('2026-10-26T16:00:00Z');
const card = { __key: '2026-10-26|toronto|dodgers|1', home_team_name: 'Los Angeles Dodgers', away_team_name: 'Toronto Blue Jays', home_record: '93-69', away_record: '94-68', start_time: '2026-10-27T00:08:00Z', venue: 'Dodger Stadium',
  series_game_number: 3, games_in_series: 7, home_pitcher_name: 'Yoshinobu Yamamoto', home_pitcher_throws: 'R', away_pitcher_name: 'Kevin Gausman', away_pitcher_throws: 'R', temp_f: 71, wind_mph: 9, wind_rel: 'Out to CF' };
const req = (mk) => ({ season: 2026, league: { runs_per_game: 4.4 },
  home: { name: card.home_team_name, offense: { runs_per_game: 5.1, games: 162 }, defense: { runs_allowed_per_game: 4.0, games: 162 }, starter: { name: card.home_pitcher_name, era: 3.1, fip: 3.2, ip_per_start: 5.8 } },
  away: { name: card.away_team_name, offense: { runs_per_game: 4.8, games: 162 }, defense: { runs_allowed_per_game: 4.2, games: 162 }, starter: { name: card.away_pitcher_name, era: 3.6, ip_per_start: 6 } },
  park: { run_factor: 98 }, weather: { temp_f: 71, wind_mph: 9, wind_rel: 'out' }, market: mk || {} });
const pModel = E.projectGame(req());
chk('the MLB engine prices the staged game', pModel.status === 'PREDICTED', pModel);
const row = (p, mk) => ({ sport: 'mlb', key: card.__key, g: card, p, mkt: mk || { n: 0 } });
const mlb = common(S.mlb(row(pModel), { now: NOW_B }), 'mlb model-only');
if (mlb) {
  const m = pModel.model, favH = m.home_win_prob >= 0.5;
  chk('MLB: the fair moneyline is the engine’s, for its favourite', minus(mlb.spread_value) === String((favH ? m.fair_home_ml : m.fair_away_ml) > 0 ? '+' + (favH ? m.fair_home_ml : m.fair_away_ml) : (favH ? m.fair_home_ml : m.fair_away_ml)), [mlb.spread_value, m.fair_home_ml, m.fair_away_ml]);
  chk('MLB: expected runs and the total are the engine’s', Number(mlb.scores.home) === Math.round(m.home_runs * 10) / 10 && Number(mlb.total) === m.fair_total, [mlb.scores, mlb.total, m]);
  chk('MLB: the 80% range is the engine’s quantiles', mlb.total_sub.text === m.total_p10 + '–' + m.total_p90 + ' RUNS');
  chk('MLB: drawn on a diamond, the series in the header, the clubs’ colours and records', mlb.surface === 'diamond' && mlb.week_label === 'SERIES GAME 3 OF 7' && mlb.home.abbr === 'LAD' && mlb.away.abbr === 'TOR' && mlb.home.record === '(93-69)');
  chk('MLB: the starters lead what to watch, probable and not confirmed', mlb.insights[0].title === 'STARTING PITCHERS' && /Probable, not confirmed/.test(mlb.insights[0].text) && /Gausman/.test(mlb.insights[0].text) && /Yamamoto/.test(mlb.insights[0].text));
  chk('MLB: the park and the weather', mlb.insights.some((i) => i.title === 'PARK & WEATHER' && /71°F/.test(i.text)));
  chk('MLB: no price joined, EdgeDesk’s own detail with its run line', !mlb.market && mlb.detail.cells.some((x) => x.k === 'MODEL RUN LINE'));
}
const mkB = { n: 3, total_line: 8.5, over_dec: 1.91, under_dec: 1.91, home_ml_dec: 1.66, away_ml_dec: 2.3, run_line: -1.5, run_line_dec: 2.4, book: 'draftkings', at: NOW_B - 600000, stale: false };
const pMk = E.projectGame(req({ total_line: 8.5, home_ml_dec: 1.66, away_ml_dec: 2.3, home_fair_prob: 0.585, book: 'draftkings', as_of: NOW_B - 600000 }));
const mlbMk = common(S.mlb(row(pMk, mkB), { now: NOW_B }), 'mlb with a price');
if (mlbMk) {
  chk('MLB with a price: the captured market with its book', mlbMk.market && mlbMk.market.title === 'MARKET SNAPSHOT' && /DraftKings/.test(mlbMk.market.meta) && mlbMk.market.total === '8.5' && minus(mlbMk.market.home_ml) === '-152' && minus(mlbMk.market.away_ml) === '+130', mlbMk.market);
  chk('…the run line as the book prices the home side', minus(mlbMk.market.home_spread) === '-1.5 +140' && mlbMk.market.away_spread === '+1.5');
  chk('…the total gap is the engine’s, in words', mlbMk.market.vs.some((v) => /^Total: EdgeDesk \d+\.\d\d runs (higher|lower)$/.test(v)));
  chk('…the no-vig split is the capture’s', mlbMk.market.no_vig.home === '59%' && mlbMk.market.no_vig.away === '41%');
}
chk('MLB: a stale capture is the last known market', S.mlb(row(pMk, Object.assign({}, mkB, { stale: true })), { now: NOW_B }).content.market.title === 'LAST KNOWN MARKET');
chk('MLB: a capture with no book or time is not a market', !S.mlb(row(pMk, Object.assign({}, mkB, { book: null })), { now: NOW_B }).content.market);
chk('MLB: a price captured after first pitch is not the pregame market', !S.mlb(row(pMk, Object.assign({}, mkB, { at: Date.parse(card.start_time) + 600000 })), { now: Date.parse(card.start_time) + 3600e3 }).content.market);
const fault = clone(pMk); fault.edge.total.recommendation = 'DATA_FAULT';
chk('MLB: a data fault replaces the market strip and says so', (() => { const c = S.mlb(row(fault, mkB), { now: NOW_B }).content; return /DATA FAULT/.test(c.fault) && !c.market && c.status_tone === 'fault'; })());
const lean = clone(pMk); lean.edge.total.recommendation = 'RESEARCH_LEAN';
chk('MLB: a research lean is a reason to open the game, never an edge', S.mlb(row(lean, mkB), { now: NOW_B }).content.insights.some((i) => i.title === 'MODEL VS MARKET' && /not an edge/.test(i.text)));
const blocked = common(S.mlb(row({ status: 'INSUFFICIENT_DATA', missing: ['home starter line', 'park'] }), { now: NOW_B }), 'mlb no projection');
chk('MLB: a game the engine could not price draws no projection, and why', blocked && blocked.model_available === false && /home starter line, park/.test(blocked.reason));
chk('MLB: no starter posted is said, never filled in', /No starter posted/.test(S.mlb({ sport: 'mlb', key: 'x', g: Object.assign({}, card, { home_pitcher_name: null, away_pitcher_name: null }), p: pModel, mkt: { n: 0 } }, { now: NOW_B }).content.insights[0].text));

const cp = E.projectCollegeGame({ season: 2027, league: { runs_per_game: 6.5 }, neutral_site: false,
  home: { name: 'Vanderbilt', runs_per_game: 7.4, runs_allowed_per_game: 4.6, games: 40, conference_strength: { name: 'SEC', sufficient: true, runs_per_nonconf_game: 2.1, nonconference_games: 180 } },
  away: { name: 'Middle Tennessee', runs_per_game: 6.0, runs_allowed_per_game: 6.6, games: 38 }, market: {} });
chk('the college engine prices the staged game', cp.status === 'PREDICTED', cp);
const cb = common(S.collegeBaseball({ sport: 'cbb', key: '9001', g: { home: { name: 'Vanderbilt' }, away: { name: 'Middle Tennessee' }, start_time: '2027-02-20T18:00:00Z', venue: 'Hawkins Field' }, p: cp, mkt: { n: 0 } }, { now: NOW_B }), 'college baseball');
if (cb) {
  const all = strings(cb).join(' | ');
  chk('college: no price of any kind (the brief’s rule)', !/FAIR MONEYLINE|MODEL MONEYLINE|MODEL RUN LINE|[+−]\d{3}\b/.test(all), all.match(/FAIR MONEYLINE|MODEL MONEYLINE|MODEL RUN LINE|[+−]\d{3}\b/g));
  chk('college: the left panel is the projected margin, labelled not a run line', cb.labels.left === 'PROJECTED MARGIN' && /NOT A RUN LINE/.test(cb.labels.left_sub) && cb.spread_team === 'VANDERBILT');
  chk('college: the projected runs and win probability are the engine’s', Number(cb.scores.home) === Math.round(cp.model.home_runs * 10) / 10 && cb.win.home_pct === S.split100(cp.model.home_win_prob).home);
  chk('college: starters are named as not in the number', cb.insights[0].title === 'STARTING PITCHERS' && /not posted/.test(cb.insights[0].text));
  chk('college: the conference adjustment is named', cb.insights.some((i) => i.title === 'CONFERENCE STRENGTH' && /SEC/.test(i.text)));
  chk('college: neutral names keep every word', cb.away.short === 'MIDDLE TENNESSEE');
}

/* =================================================================== UFC */
const NOW_U = Date.parse(UFC.generated_at) + 60000;
chk('the served UFC file has bouts to draw', (UFC.bouts || []).length > 0);
(UFC.bouts || []).forEach((b) => {
  const label = 'ufc ' + b.bout_id;
  const c = common(S.ufc(b, { now: NOW_U, generated_at: UFC.generated_at, version: UFC.served.version }), label);
  if (!c) return;
  const pB = 1 - b.p_a, fav = pB >= 0.5 ? pB : b.p_a, fair = Math.round(fav >= 0.5 ? -100 * fav / (1 - fav) : 100 * (1 - fav) / fav);
  chk('the fair price is the model’s probability with no margin: ' + label, minus(c.spread_value) === String(fair), [c.spread_value, fair]);
  chk('fighters are initials in neutral colours, VS, on an octagon: ' + label, c.away.abbr.length <= 2 && c.home.abbr.length <= 2 && c.at_word === 'VS' && c.surface === 'octagon' && /^#(334155|3f3f46)$/.test(c.home.color) && /^#(334155|3f3f46)$/.test(c.away.color));
  chk('the guard’s gap prints with its verdict: ' + label, b.guard && b.guard.gap_pp != null ? Number(minus(c.total)) === Math.round(b.guard.gap_pp * 10) / 10 && /AGREES|CHECK WHY/.test(c.total_sub.text) : c.total === '—');
  chk('a disagreement is a question, never an edge: ' + label, !(b.guard && b.guard.status === 'DISAGREES') || (c.total_sub.text === 'CHECK WHY' && (!c.market || /QUESTION, NOT AN EDGE/.test(c.market.note))));
  chk('what the number cannot see is always named: ' + label, c.insights.some((i) => i.title === 'NOT IN THE NUMBER'));
});
const UB = clone(UFC.bouts.find((b) => b.market) || UFC.bouts[0]);
if (UB.market) {
  UB.market.observed_at = new Date(Date.parse(UB.start) + 600000).toISOString();
  chk('a UFC price observed after the start is not drawn', !S.ufc(UB, { now: Date.parse(UB.start) + 3600e3 }).content.market);
}
chk('the main event is found from the card’s name', (() => { const m = S.mainEvent(UFC.bouts, null); return !m || (m.event.toLowerCase().indexOf(m.fighter_a.name.split(' ').slice(-1)[0].toLowerCase()) >= 0); })());
chk('…or from the headliners’ ids', (() => { const b = UFC.bouts[0]; return S.mainEvent(UFC.bouts, [b.fighter_b.id, b.fighter_a.id]) === b; })());
chk('cardBouts reads one card, and refuses a file that is not the served model', S.cardBouts(UFC, UFC.bouts[0].event_id).every((b) => String(b.event_id) === String(UFC.bouts[0].event_id)) && S.cardBouts({ schema: 'x', bouts: UFC.bouts }).length === 0);
chk('a bout with no number is refused, not drawn', S.ufc(Object.assign(clone(UFC.bouts[0]), { p_a: null }), {}).ok === false);

/* ================================================================= RULES */
chk('the copy rule refuses a graphic with a banned word', (() => { const g = clone(B0); return S.basketball(g, L0, { league: 'wnba', now: NOW0, venue: 'Lock Arena' }).ok === false; })());
chk('split100 always adds to 100', [0, 0.004, 0.335, 0.5, 0.666, 0.995, 1].every((p) => { const x = S.split100(p); return x.home + x.away === 100; }));
chk('a file name per league and matchup, by the teams’ full names', S.fileName(named, 'portrait') === 'edgedesk-ncaam-notre-dame-fighting-irish-at-villanova-wildcats-portrait.png', S.fileName(named, 'portrait'));
chk('the diamond draws its four bases; the octagon its eight sides', G.layout(mlb, 'square').ops.filter((o) => o.type === 'rect' && o.w === 10 && o.h === 10).length === 4
  && G.layout(S.ufc(UFC.bouts[0], { now: NOW_U }).content, 'square').ops.some((o) => o.type === 'poly' && o.points.length === 8 && !o.fill && o.stroke));
chk('football is unchanged: AT, yard lines, its own panel words', (() => {
  const L = G.layout(Object.assign({}, named, { labels: null, surface: null, at_word: undefined }), 'square');
  return L.ops.some((o) => o.text === 'AT') && L.ops.some((o) => o.text === 'FAIR SPREAD') && L.ops.filter((o) => o.type === 'line' && o.x0 === 0).length >= 7;
})());

/* ================================================================= TODAY */
chk('Today’s Games lists women’s college basketball and the WNBA from ESPN', GAMES.sport('ncaaw') && GAMES.sport('ncaaw').espn[0].path === 'basketball/womens-college-basketball' && GAMES.sport('ncaaw').espn[0].groups === '50' && GAMES.sport('wnba') && GAMES.sport('wnba').espn[0].path === 'basketball/wnba');
chk('…with their own market ranges', !!GAMES.RANGES.ncaaw && !!GAMES.RANGES.wnba && GAMES.cleanMarket('ncaaw', { total: { point: 140.5, over: -110, under: -110 } }).market && !GAMES.cleanMarket('wnba', { total: { point: 260.5, over: -110, under: -110 } }).market);
['ncaam', 'ncaaw', 'wnba'].forEach((lk) => {
  const s = slateAs(lk), e = [ev({ id: lk + ':espn:' + B0.game_id, sport: lk })];
  RES.join(e, { basketball: s, published: null, engine: null }, { now: NOW0 });
  const md = e[0].research.model;
  chk('the slate joins ' + lk + ' games to the lab model', md && md.source === 'basketball/slate.json' && md.fair.total === B0.prices.total.fair_line, md);
  chk('…with the fair spread the lab slate holds (fair_home_line)', md && md.fair.spread_home === B0.prices.spread.fair_home_line, md && md.fair);
  chk('…and no research page of its own: the matchup view carries the graphic', e[0].research.module === null && !!S.SPORTS_WITH_BLOCK[lk]);
});
const UI = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_games_ui.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
chk('the matchup view mounts the graphic, never on the public page', /SPORTS_WITH_BLOCK\[e\.sport\]/.test(UI) && /S\.opts\.host !== 'public' && O\('model'\) !== false && !!\(SG/.test(UI) && /SG\.mountCard\(el, \{ eventId: e\.provider_id/.test(UI));
chk('app.html loads the module after the renderer, with the renderer’s version', APP.indexOf('/lib/edgedesk_sport_graphic.js') > APP.indexOf('/lib/edgedesk_game_graphic.js') && (APP.match(/edgedesk_(sport|game)_graphic\.js\?v=(\w+)/g) || []).map((x) => x.split('?v=')[1]).every((v, i, a) => v === a[0]));
chk('the MLB and college briefs and the UFC panel draw it', /window\.mlbxGfxMount=function/.test(APP) && /mlbxGfxMount\(\$id\('briefGfx'\),'mlb'/.test(APP) && /mlbxGfxMount\(document\.getElementById\('cbbGfx'\),'cbb'/.test(APP) && /id="ufcCardGfx"/.test(APP) && /SG\.mountCard\(el,\{eventId:null/.test(APP));
chk('the college brief says what is projected and that none of it is a price', /none of that is turned into a price/.test(APP) && /no fair line, moneyline or run line/.test(APP));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'matchup graphic, every other sport — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
