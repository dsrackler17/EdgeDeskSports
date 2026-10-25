#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — the reader's renderers (lib/edgedesk_foresight_ui.js)
   in Node, on engine output from the synthetic world, plus static checks of
   the page, the shell and the embed.

     node tools/foresight/ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'lib', 'edgedesk_foresight_ui.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_foresight.js'));
const S = require(path.join(__dirname, 'fixtures', 'synthetic.js'));
const PLANS = require(path.join(ROOT, 'lib', 'edgedesk_plans.js'));
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = PG.kit('Market Foresight pages');
const chk = T.chk;
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'foresight', 'methodology', 'mf-v1.json'), 'utf8'));
const R = E.rules(M);
const NOW = S.K3 + 86400000;

/* G1 with a verified Kalshi home market and a moneyline forecast, so every panel has something */
const G = JSON.parse(JSON.stringify(S.G1));
G.dk.push(S.ml('SYN_G1', S.K1, -30, -150, 130), S.ml('SYN_G1', S.K1, -20, -170, 145), S.ml('SYN_G1', S.K1, -1, -180, 150));
G.forecasts.push(S.fc('syn_p', 'SYN_G1', S.K1, -26, { moneyline: 0.66 }));
const snaps = [];
for (let h = -30, i = 0; h < 0; h += 1 / 12, i++) { const mid = h < -21 ? 0.58 : 0.61; snaps.push({ id: i, captured_at: S.at(S.K1, h), yes_bid: mid - 0.01, yes_ask: mid + 0.01, last_price: mid, yes_bid_size: 40, yes_ask_size: 40, volume: 100 + (i % 3 === 0 ? i : 0), open_interest: 9 }); }
G.kalshi = { market: { ticker: 'SYN-HOME', rules_sha256: 'x', verification: { verified: true, overtime: 'included', tie: 'push' } }, snapshots: snaps };
const ev = E.evaluateGame(G, R, NOW);
const game = ev.game, units = ev.units;

/* ---------------------------------------------------------------- panels */
const panels = U.panelsFor(game, units);
chk('three panels, one unit each: spread, total, win probability', panels.map((p) => p.market).join() === 'spread,moneyline' || panels.map((p) => p.market).join() === 'spread,total,moneyline', panels.map((p) => p.market));
const sp = panels.filter((p) => p.market === 'spread')[0], ml = panels.filter((p) => p.market === 'moneyline')[0];
chk('the spread panel carries DraftKings and the forecasts, never Kalshi (no Kalshi spread contract)', sp.series.map((s) => s.venue).join() === 'draftkings' && sp.forecasts.length >= 5);
chk('the win-probability panel carries DraftKings and Kalshi', ml.series.map((s) => s.venue).sort().join() === 'draftkings,kalshi');
const b = sp.forecasts.filter((f) => /syn_b/.test(f.key))[0];
chk('a forecast keeps its revisions, in time order, the first marked', b.marks.length === 2 && b.marks[0].first && !b.marks[1].first && Date.parse(b.marks[0].at) < Date.parse(b.marks[1].at));
chk('consensus forecasts are marked as such (hollow)', sp.forecasts.some((f) => f.consensus));
chk('a forecast published after kickoff is not drawn', !sp.forecasts.some((f) => /syn_h/.test(f.key)));

/* ---------------------------------------------------------------- the drawing */
const svg = U.timelineSVG(sp), Gm = U.geometry(sp);
const flines = [...svg.matchAll(/class="mf-fline"[^>]*x1="([\d.]+)" x2="([\d.]+)"/g)].map((m) => [+m[1], +m[2]]);
const pubX = new Set();
sp.forecasts.forEach((f) => f.marks.forEach((m) => pubX.add(Math.round(Gm.x(m.at) * 10) / 10)));
chk('every forecast line starts at a publication, never before it', flines.length > 0 && flines.every((l) => pubX.has(l[0]) && l[1] >= l[0]), flines.slice(0, 3));
chk('no forecast line starts left of the earliest publication', Math.min.apply(null, flines.map((l) => l[0])) >= Math.min.apply(null, Array.from(pubX)) - 0.05);
chk('steps are flat lines (y1 = y2): nothing is interpolated between values', [...svg.matchAll(/class="mf-step"[^>]*y1="([\d.]+)" y2="([\d.]+)"/g)].every((m) => m[1] === m[2]));
chk('a change between two values is a band, not a sloped line', /class="mf-chg"/.test(svg) && !/<polyline|<path class="mf-step/.test(svg));
chk('kickoff is marked and the crosshair is present', /class="mf-kick"/.test(svg) && /class="mf-cross"/.test(svg));
const mlsvg = U.timelineSVG(ml);
chk('Kalshi carries its bid–ask band beside the mid', /class="mf-band"/.test(mlsvg));
const svg3 = U.timelineSVG(U.panelsFor(E.evaluateGame(S.G3, R, NOW).game, E.evaluateGame(S.G3, R, NOW).units).filter((p) => p.market === 'spread')[0]);
chk('a coverage gap is a labelled grey band', /class="mf-gap mf-gap-draftkings"/.test(svg3) && /no observations for/.test(svg3));
const svgML3 = U.timelineSVG(U.panelsFor(E.evaluateGame(S.G3, R, NOW).game, []).filter((p) => p.market === 'moneyline')[0]);
chk('an observation without a comparable value (one-sided price) is marked, not drawn as a value', /class="mf-unpriced"/.test(svgML3) && /one sided price/.test(svgML3));
chk('the svg describes itself and points to the event table', /role="img" aria-label="[^"]*event table/.test(svg));

/* ---------------------------------------------------------------- the readout */
const g3 = E.evaluateGame(S.G3, R, NOW), p3 = U.panelsFor(g3.game, g3.units).filter((p) => p.market === 'spread')[0];
const at = (h) => S.K3 + h * S.H;
let st = U.stateAt(p3, at(-30));
chk('readout inside an outage: no observations, unknown', st.venues[0].state.kind === 'gap' && /no observations \(coverage gap/.test(U.stateLines(p3, st).join('\n')) && /unknown/.test(U.stateLines(p3, st).join('\n')));
st = U.stateAt(p3, at(-20));
chk('readout on an observation: the value', st.venues[0].state.kind === 'observed' && /−7\.5/.test(U.stateLines(p3, st).join('\n')));
st = U.stateAt(p3, at(-45));
chk('readout before the first observation: not observed yet', st.venues[0].state.kind === 'before_first');
const p1 = sp;
st = U.stateAt(p1, S.K1 - 21 * S.H);
chk('readout inside a change interval: changed somewhere in between, value unknown', st.venues[0].state.kind === 'changing' && /somewhere between/.test(U.stateLines(p1, st).join('\n')));
st = U.stateAt(p1, S.K1 - 27 * S.H);
chk('readout between two agreeing readings: the value, with both readings named', st.venues[0].state.kind === 'observed' && /−3 · prices/.test(U.stateLines(p1, st).join('\n')) && /2 readings/.test(U.stateLines(p1, st).join('\n')));
st = U.stateAt(p1, S.K1 - 23 * S.H);
chk('readout one hour after the last −3 reading and before the −3.5 reading: changing, unknown', st.venues[0].state.kind === 'changing');
chk('the readout shows only forecasts already published at that instant', U.stateAt(p1, S.K1 - 27 * S.H).forecasts.filter((f) => f.mark).length === 0 + U.stateAt(p1, S.K1 - 27 * S.H).forecasts.filter((f) => f.mark && Date.parse(f.mark.at) <= S.K1 - 27 * S.H).length
  && U.stateAt(p1, S.K1 - 27 * S.H).forecasts.every((f) => !f.mark || Date.parse(f.mark.at) <= S.K1 - 27 * S.H));
const stK = U.stateAt(ml, S.K1 - 10 * S.H);
const kl = U.stateLines(ml, stK).join('\n');
chk('the Kalshi readout separates bid, ask, last trade (with its freshness) and depth', /bid 60¢ \/ ask 62¢/.test(kl) && /last 61¢ \((fresh|stale|unknown)\)/.test(kl) && /size 40 × 40/.test(kl));
chk('every readout names the timestamp type', /collector observation times/.test(kl));

/* ---------------------------------------------------------------- tables and text */
const evt = U.eventTableHTML(game, panels);
const nSeg = panels.reduce((a, p) => a + p.series.reduce((b2, s) => b2 + s.segments.length + (s.gaps || []).length, 0) + p.forecasts.reduce((c, f) => c + f.marks.length, 0), 0);
chk('the event table lists every segment, gap and forecast mark', (evt.match(/<tr><th scope="row">/g) || []).length === nSeg, [(evt.match(/<tr><th scope="row">/g) || []).length, nSeg]);
const evil = JSON.parse(JSON.stringify(units[0])); evil.model_label = '<img src=x onerror=alert(1)>';
chk('untrusted labels are escaped in a finding', !/<img src=x/.test(U.unitHTML(evil)) && /&lt;img/.test(U.unitHTML(evil)));
chk('untrusted labels are escaped in the legend', !/<img/.test(U.legendHTML({ series: [], forecasts: [{ label: '<img>', version: 'v', marks: [] }] })));
const ex = units.filter((u) => u.status === 'excluded')[0];
chk('an excluded unit says why, from the methodology’s own words', U.unitHTML(ex, M.selection.exclusion_reasons).indexOf(M.selection.exclusion_reasons[ex.exclusion_reason]) >= 0);
const meas = units.filter((u) => u.status === 'measured' && u.metrics.move && u.metrics.move.precedence === 'PRECEDED')[0];
const mh = U.unitHTML(meas);
chk('a measured unit shows F, M0, C, the definitions and the plain-language finding', /Forecast F/.test(mh) && /Market at publication M0/.test(mh) && /\|M0 − F\| − \|C − F\|/.test(mh) && /published before the first observed sustained move/.test(mh) && /data-lo=/.test(mh));
const sums = E.summarize(units, R);
const tbl = U.summaryTableHTML(sums.filter((s) => s.horizon_bucket === 'all'));
chk('the summary table shows misses and evidence, and no combined score', /no move/.test(tbl) && /reversed/.test(tbl) && /Insufficient evidence/.test(tbl) && !/score|grade/i.test(tbl.replace(/data-[a-z-]+="[^"]*"/g, '')));
chk('an empty summary table says so', /No measured forecasts/.test(U.summaryTableHTML([])));
chk('lead-lag: blocked games are reported with their reason', /not compared — settlement unverified \(3\)/.test(U.leadLagHTML([{ sport: 'nfl', bucket: 'all', blocked: 3, blocked_reasons: { settlement_unverified: 3 }, pairs: 0, leaders: {}, moves: {} }])));
chk('lead-lag: the precedence caveat is always printed', /third source or to public news/.test(U.leadLagHTML([{ sport: 'nfl', bucket: 'all', blocked: 0, blocked_reasons: {}, pairs: 1, leaders: {}, unresolved: 1, ties: 0, moves: { kalshi: 1 }, unmatched: {}, insufficient_coverage: {}, label: null, label_status: 'INSUFFICIENT_RESOLVED_PAIRS' }])));
const shtml = U.statusHTML({ mode: 'shadow', methodology: { version: 'mf-v1', sha256: 'abcdef0123456789' }, last_run: { finished_at: new Date(NOW - 3600000).toISOString(), status: 'ok', sources: { draftkings: { status: 'connected' }, kalshi: { status: 'not_configured', reason: 'no credentials' } } } }, NOW);
chk('the status strip: in review, the methodology digest, the age, each source', /In review/.test(shtml) && /mf-v1 · abcdef0123/.test(shtml) && /1 h ago/.test(shtml) && /Kalshi: not connected/.test(shtml) && /DraftKings: connected/.test(shtml));
const cov = E.evaluate({ games: S.GAMES }, M, new Date(NOW).toISOString()).coverage;
chk('coverage shows the observed cadence beside the intended one', /intended: polled hourly/.test(U.coverageHTML(cov)) && /90th pct/.test(U.coverageHTML(cov)));
chk('the embed snippet is escaped', !/"<script>"/.test(U.embedSnippet('edgedesk', '"><script>')) && /&quot;&gt;&lt;script&gt;/.test(U.embedSnippet('edgedesk', '"><script>')));
chk('values: a home line, a total, a probability, a difference', U.line(-3.5) === '−3.5' && U.line(2) === '+2' && U.line(0) === 'PK' && U.pct(0.5812) === '58.1%' && U.delta('moneyline', 0.021) === '+2.1 pp' && U.delta('spread', -0.5) === '−0.5 pts');

/* ---------------------------------------------------------------- the page, the shell, the embed */
const HTML = fs.readFileSync(path.join(ROOT, 'foresight', 'index.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'foresight', 'foresight.js'), 'utf8');
const EMBED = fs.readFileSync(path.join(ROOT, 'foresight', 'embed.js'), 'utf8');
chk('the page loads the renderers before the shell', HTML.indexOf('edgedesk_foresight_ui.js') > 0 && HTML.indexOf('edgedesk_foresight_ui.js') < HTML.indexOf('foresight/foresight.js'));
chk('the page is noindex while in review, with a CSP and no inline script', /name="robots" content="noindex,follow"/.test(HTML) && /Content-Security-Policy/.test(HTML) && !/<script>(?!\s*<\/script>)/.test(HTML));
chk('the page states the claims it never makes', /never says that a model caused a move/.test(HTML) && /only the tracked venues are observed/.test(HTML) && /not a profitable or executable trade/.test(HTML));
const doors = [...SHELL.matchAll(/rpc\('([a-z_0-9]+)'/g)].map((m) => m[1]).concat([...EMBED.matchAll(/rpc\/([a-z_0-9]+)/g)].map((m) => m[1]));
chk('the shell and the embed call only Market Foresight reader doors', doors.length >= 5 && doors.every((d) => /^mf_(status|overview|games_list|game|model|embed)$/.test(d)), doors);
chk('every door the page calls is an anonymous door in the plans map', doors.every((d) => PLANS.isAnonDoor('rpc', d)), doors.filter((d) => !PLANS.isAnonDoor('rpc', d)));
chk('the shell never calls a job or operator door, and never reads a table', !/mf_job_|mf_admin_|\/rest\/v1\/(?!rpc)/.test(SHELL + EMBED));
chk('the shell sends the reader\'s token only when it is current, and falls back to anonymous on 401', /expires_at \* 1000 > Date\.now\(\)/.test(SHELL) && /e\.status === 401/.test(SHELL));
chk('the embed renders text only (no innerHTML of server data)', !/innerHTML/.test(EMBED) && /textContent/.test(EMBED));
chk('the embed\'s code is ASCII (it runs on hosts that may not serve it as UTF-8)', ![...EMBED.slice(EMBED.indexOf('(function () {'))].some((c) => c.charCodeAt(0) > 127));
chk('the shell writes server strings into tooltips as text', /tip\.textContent = ''/.test(SHELL) && /d\.textContent = l/.test(SHELL));

process.exit(T.done());
