#!/usr/bin/env node
/* ===========================================================================
   Signal Center graphics (lib/edgedesk_signal_graphic.js) on the matchup
   renderer (lib/edgedesk_game_graphic.js), offline.

     node tools/signal_center/graphics.test.js

     shared      the matchup layout is byte-identical through the shared kit
                 (every committed football, NBA and NHL graphic, both formats)
     templates   all six templates build and lay out in all three formats with
                 every text op inside the canvas and its box, at 9 px or more
     numbers     every number on the picture is the payload's own display
                 string; change words carry the sign; "PERCENTAGE POINT(S)"
     edges       a long team name, missing colours (neutral, initials), a
                 negative change, an unavailable value, an Estimated outcome,
                 a fixture, an OUTDATED and a WITHDRAWN stamp
     rules       unverified, uncategorised and data-quality payloads get no
                 graphic; the copy rule; no image op (no logo); the file name
                 and the alt text; the recap ranks by score only
     identity    the content names the signal key and version hash it came from
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
const SG = require(path.join(ROOT, 'lib', 'edgedesk_signal_graphic.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const S = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = PG.kit('signal center graphics');
const chk = T.chk;
const FORMATS = Object.keys(SG.FORMATS);
const NOW = Date.parse('2026-10-23T20:30:00Z');
const iso = (t) => new Date(t).toISOString();

/* ── the shared kit leaves the matchup graphic unchanged ─────────────── */
{
  const crypto = require('crypto');
  const cur = require(path.join(ROOT, 'football', 'game_research', 'current.json'));
  const ops = [];
  cur.games.slice(0, 40).forEach((g) => { const c = G.content(S.graphicSpec(g), null, { now: Date.parse(g.generated_at) }); if (c.ok) ['square', 'portrait'].forEach((f) => ops.push(G.layout(c.content, f))); });
  chk('the matchup layout still lays out every committed snapshot', ops.length > 20);
  chk('the matchup layout never asks for the signal template', ops.every((L) => L.ops.every((o) => o.type !== 'image')));
  chk('layoutFor: a matchup content gets the matchup layout', G.layoutFor({}) === G.layout && G.layoutFor({ template: 'signal_v1' }) === SG.layout);
  chk('the matchup formats are unchanged (square and portrait only)', JSON.stringify(Object.keys(G.FORMATS)) === '["square","portrait"]');
  void crypto;
}

/* ── controlled payloads for every template ──────────────────────────── */
const GAME = { sport: 'cfb', league: 'cfb', season: 2026, event_key: 'cfb|900', event_at: iso(NOW + 2 * 86400e3),
  home: { name: 'Louisiana–Monroe Warhawks of the Very Long Name Institute', abbr: null }, away: { name: 'Texas Tech Red Raiders', abbr: 'TTU', color: '#cc0000', alt: '#000000', on: '#ffffff' },
  research_href: '#game/cfb/900', source: { id: 'fx', label: 'fixture game research', ref: 'fixture' } };
const snap = (id, mins, p, ver) => ({ snapshot_id: id, at: iso(NOW - mins * 60e3), built_at: iso(NOW - mins * 60e3), p_home: p, model_id: ver || 'm1', model_version: ver || 'm1', data_status: 'OK', consistent: true, inputs: {} });
const fs1 = E.forecastShifts([snap('a', 300, 0.30), snap('b', 120, 0.62)], GAME, { now: NOW }).signals[0];          /* home up: the long name */
const fs2 = E.forecastShifts([snap('c', 300, 0.70), snap('d', 120, 0.44)], GAME, { now: NOW }).signals[0];          /* away up */
const fsv = E.forecastShifts([snap('e', 300, 0.40), snap('f', 120, 0.55, 'm2')], GAME, { now: NOW }).signals[0];    /* version change */
const quote = { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: iso(NOW - 20 * 60e3), moneyline: { home: -250, away: 205 }, home: GAME.home, away: GAME.away };
const dv = E.marketDivergence([{ game: GAME, model: { p_home: 0.45, at: iso(NOW - 30 * 60e3), snapshot_id: 'm', model_id: 'm1', model_version: 'm1', data_status: 'OK', validation: { market_test: 'TESTED_BEHIND' } }, quote }], { now: NOW }).signals[0];
const cv = E.marketConvergence([dv], [{ game: GAME, model: { p_home: 0.68, at: iso(NOW - 10 * 60e3), snapshot_id: 'm2', model_id: 'm1', model_version: 'm1', data_status: 'OK' }, quote: Object.assign({}, quote, { captured_at: iso(NOW - 5 * 60e3) }) }], { now: NOW })[0];
const lm = E.lineMovement([{ book: 'DraftKings', captured_at: iso(NOW - 600 * 60e3), moneyline: { home: -110, away: -110 } }, { book: 'DraftKings', captured_at: iso(NOW - 300 * 60e3), moneyline: { home: -180, away: 150 } }], GAME, { now: NOW }).signals[0];
const run = (id, at, ver) => ({ run_id: id, model_version: ver || 'v1', rules_version: 'r1', engine_version: 'e1', n_sims: 100000, input_snapshot_at: at, completed_at: at, published_at: at, validation_summary: { cfb: { cfp_mode: 'proxy' } } });
const row = (p, prov) => ({ entity_id: 'TTU', entity_name: 'Texas Tech', outcome: 'cfp_field', probability: p, mcse: Math.sqrt(p * (1 - p) / 1e5), provenance: prov || 'Estimated', applicable: true });
const sm = E.simulationShifts({ sport: 'cfb', competition: 'NCAA FBS', season: '2026', previous: run('11111111-aaaa-4aaa-8aaa-111111111111', iso(NOW - 3 * 86400e3)), current: run('22222222-bbbb-4bbb-8bbb-222222222222', iso(NOW - 3600e3)) },
  { previous: [row(0.552)], current: [row(0.628)] }, { now: NOW }).signals[0];
const smDown = E.simulationShifts({ sport: 'nfl', competition: 'NFL', season: '2026', previous: run('33333333-aaaa-4aaa-8aaa-111111111111', iso(NOW - 3 * 86400e3)), current: run('44444444-bbbb-4bbb-8bbb-222222222222', iso(NOW - 3600e3)) },
  { previous: [Object.assign(row(0.71, 'Research'), { entity_id: 'KC', entity_name: 'Kansas City Chiefs', outcome: 'make_playoffs' })], current: [Object.assign(row(0.58, 'Research'), { entity_id: 'KC', entity_name: 'Kansas City Chiefs', outcome: 'make_playoffs' })] }, { now: NOW }).signals[0];
/* a golfer (a person, not a team) with a long name */
const golfRow = (p) => ({ entity_id: 'pga-46046', entity_name: 'Christopher Montgomery-Alexander', outcome: 'top_10', probability: p, mcse: Math.sqrt(p * (1 - p) / 1e5), provenance: 'Research', applicable: true });
const smGolf = E.simulationShifts({ sport: 'golf', competition: 'PGA Tour Test Open', season: '2026', previous: run('55555555-aaaa-4aaa-8aaa-111111111111', iso(NOW - 86400e3)), current: run('66666666-bbbb-4bbb-8bbb-222222222222', iso(NOW - 3600e3)) },
  { previous: [golfRow(0.30)], current: [golfRow(0.44)] }, { now: NOW }).signals[0];
const inj = E.injuryChanges([{ sport: 'cfb', team: { name: 'Army' }, player: { id: 'p1', name: 'Bartholomew Montgomery-Alexander III', position: 'QB' }, status: 'QUESTIONABLE', report: { id: '1', type: 'Game Day', published_at: iso(NOW - 900 * 60e3), retrieved_at: iso(NOW), source_url: 'https://example.org/report', source: 'American availability report' }, game: { event_key: 'cfb|1', event_at: iso(NOW + 86400e3), label: 'Army at Tulsa' } },
  { sport: 'cfb', team: { name: 'Army' }, player: { id: 'p1', name: 'Bartholomew Montgomery-Alexander III', position: 'QB' }, status: 'GAME_TIME_DECISION', report: { id: '2', type: 'Game Day', published_at: iso(NOW - 60 * 60e3), retrieved_at: iso(NOW), source_url: 'https://example.org/report', source: 'American availability report' }, game: { event_key: 'cfb|1', event_at: iso(NOW + 86400e3), label: 'Army at Tulsa' } }], { now: NOW, positions: ['QB'] })[1];
const DNA = require(path.join(ROOT, 'lib', 'edgedesk_model_dna.js'));
const reg = { sports: [{ id: 'nfl', brain: { id: 'edgedesk_football' }, readiness: { markets: { moneyline: { outcome: 'VALIDATED', market: 'TESTED_BEHIND' } } } }] };
const perf = { generated_at: iso(NOW), min_n: 20, ledger: { epoch: '2026-10-16T00:00:00Z' }, tiers: {}, by_sport: { nfl: { verified: { winner: { n: 150, brier: 0.24, sample_state: 'DEVELOPING', calibration: [{ from: 0.6, to: 0.7, n: 40, mean_predicted: 0.65, observed: 0.40, wilson_low: 0.26, wilson_high: 0.55, inside_interval: false }] }, market: { moneyline: { n: 60, model_brier: 0.241, market_brier: 0.2228, sample_state: 'EARLY_SIGNAL' } } } } },
  by_model: [{ sport: 'nfl', tier: 'VERIFIED', model_version: 'v1', graded: 150, winner: {} }] };
const rel = E.reliabilityWarnings(DNA.build(reg, perf, { nfl: { id: 'edgedesk_nfl_v2.1.0', version: 'edgedesk_nfl_v2.1.0' } }, NOW), { now: NOW });
const dq = E.dataQuality([{ id: 'x', label: 'Football research snapshots', state: 'ok', generated_at: iso(NOW - 600 * 60e3), max_age_minutes: 180 }], { now: NOW })[0];
const ALL = { fs1, fs2, fsv, dv, cv, lm, sm, smDown, smGolf, inj, rel0: rel[0], rel1: rel[1], rel2: rel[2] };
chk('every controlled payload was built', Object.keys(ALL).every((k) => ALL[k]), Object.keys(ALL).filter((k) => !ALL[k]));
/* SC_GRAPHICS_FIXTURES_OUT=f.json writes these controlled payloads, so
   tools/signal_center/render_graphics.js --payloads f.json can draw them */
if (process.env.SC_GRAPHICS_FIXTURES_OUT) require('fs').writeFileSync(process.env.SC_GRAPHICS_FIXTURES_OUT, JSON.stringify(Object.keys(ALL).map((k) => ALL[k]).filter(Boolean)));
chk('three reliability subtypes', rel.map((r) => r.subtype).sort().join(',') === 'behind_market,calibration_band,no_live_record', rel.map((r) => r.subtype));

const expectKind = { fs1: 'probability_shift', fs2: 'probability_shift', fsv: 'probability_shift', dv: 'market_disagreement', cv: 'market_disagreement', lm: 'market_disagreement', sm: 'simulator_movement', smDown: 'simulator_movement', smGolf: 'simulator_movement', inj: 'injury_impact', rel0: 'reliability_alert', rel1: 'reliability_alert', rel2: 'reliability_alert' };
const contents = {};
Object.keys(ALL).forEach((k) => {
  const r = SG.content(ALL[k], { version: 2, payload_sha256: 'a'.repeat(64) });
  chk('content builds: ' + k, r.ok, r);
  if (!r.ok) return;
  contents[k] = r.content;
  chk('template: ' + k + ' -> ' + expectKind[k], r.content.kind === expectKind[k], r.content.kind);
  chk('identity: ' + k + ' names its signal key and version hash', r.content.signal_key === ALL[k].signal_key && r.content.version_hash === ALL[k].version_hash && r.content.version === 2);
  FORMATS.forEach((f) => {
    const L = SG.layout(r.content, f);
    const bad = SG.check(L);
    chk(k + ' ' + f + ': ' + SG.FORMATS[f].w + '×' + SG.FORMATS[f].h, L.width === SG.FORMATS[f].w && L.height === SG.FORMATS[f].h);
    chk(k + ' ' + f + ': every text inside the canvas and its box, 9 px or more', bad.length === 0, bad.slice(0, 3));
    chk(k + ' ' + f + ': no image op (no logo is ever drawn)', L.ops.every((o) => o.type !== 'image'));
    chk(k + ' ' + f + ': RESEARCH NOT PICKS. is printed', L.ops.some((o) => o.type === 'text' && o.text === 'RESEARCH NOT PICKS.'));
    chk(k + ' ' + f + ': SIGNAL CENTER is printed', L.ops.some((o) => o.type === 'text' && o.text === 'SIGNAL CENTER'));
  });
});

/* ── numbers are the payload's own ───────────────────────────────────── */
{
  const c = contents.fs1, p = fs1;
  chk('forecast: previous and updated are the payload display strings', c.numbers.left.value === p.values.previous.display && c.numbers.right.value === p.values.current.display);
  chk('forecast: the change says percentage points with its sign', /^\+\d+\.\d PERCENTAGE POINTS$/.test(c.numbers.change.text) && c.numbers.change.text.indexOf(Math.abs(p.values.change_pp).toFixed(1)) >= 0, c.numbers.change.text);
  chk('forecast: the evidence class is printed', c.why.chip === up(p.evidence.label));
  chk('forecast version change: says so', /MODEL VERSION CHANGE/.test(contents.fsv.subject.sub) && /was m1/.test(contents.fsv.meta[0]));
  chk('one percentage point is singular', SG._ppWords(1) === '+1.0 PERCENTAGE POINT' && SG._ppWords(-1.04) === '−1.0 PERCENTAGE POINT');
  chk('a negative change keeps its minus sign and tone', /^−/.test(contents.smDown.numbers.change.text) && contents.smDown.numbers.change.tone === 'down', contents.smDown.numbers.change);
  chk('zero is unsigned', SG._ppWords(0) === '0.0 PERCENTAGE POINTS');
  chk('an unavailable value prints a dash, never a guess', SG._ppWords(null) === '—');
  const d = contents.dv;
  chk('divergence: EdgeDesk vs the named book, no-vig', d.numbers.left.label === 'EDGEDESK MODEL' && /DRAFTKINGS · NO-VIG/.test(d.numbers.right.label) && d.numbers.left.value === dv.values.current.display && d.numbers.right.value === dv.values.previous.display);
  chk('divergence: the book, the source and the capture time are printed', /DraftKings via the ESPN scoreboard · captured/.test(d.meta[0]), d.meta[0]);
  chk('divergence: never a betting claim', /NOT A BETTING RECOMMENDATION/.test(d.meta.join(' ')) && /question to research/.test(d.why.text));
  chk('divergence: the market test is printed', /TESTED_BEHIND/.test(d.meta[1]));
  const s = contents.sm;
  chk('simulator: ESTIMATED is flagged for a committee-proxy outcome', s.flag && s.flag.text === 'ESTIMATED' && /not the committee/.test(s.why.text));
  chk('simulator: Monte Carlo error is labelled sampling-only', s.meta.some((m) => /SAMPLING ONLY/.test(m)));
  chk('simulator: run snapshot dates are printed', /inputs /.test(s.numbers.left.sub) && /inputs /.test(s.numbers.right.sub));
  /* a golfer: initials in neutral colours (no photo, no logo), no playing surface */
  const gc = SG.content(smGolf, { version: 1, payload_sha256: 'f'.repeat(64) });
  chk('golf: a player graphic, initials in neutral colours, never the entity id', gc.ok && gc.content.subject.kind === 'player' && gc.content.subject.team.abbr === 'CM' && /neutral/.test(gc.content.subject.team.colors_source), gc.ok ? gc.content.subject : gc);
  chk('golf: no playing surface is drawn', gc.ok && gc.content.surface === 'none');
  chk('golf: every format lays out inside its boxes', gc.ok && FORMATS.every((f) => SG.check(SG.layout(gc.content, f)).length === 0));
  const i = contents.inj;
  chk('injury: facts and the estimate are apart; no effect is claimed', /NOT CALCULATED/.test(i.numbers.change.text) && /ESTIMATE none/.test(i.meta[1]) && i.why.title === 'THE FACTS');
  chk('injury: the current designation and its source time', i.numbers.right.value === 'GAME-TIME DECISION' && /published/.test(i.numbers.right.sub));
  const r0 = contents[Object.keys(contents).find((k) => contents[k].kind === 'reliability_alert' && /band/.test(contents[k].numbers.left.sub || ''))];
  chk('reliability: the model said / observed / sample / interval are printed', r0 && r0.numbers.left.label === 'MODEL SAID' && /95% interval/.test(r0.numbers.right.sub) && /40 GRADED GAMES/.test(r0.numbers.change.text));
}
function up(x) { return String(x).toUpperCase(); }

/* ── edges ───────────────────────────────────────────────────────────── */
{
  const c = contents.fs1;
  chk('a team with no colours on file is drawn in neutral colours with initials', c.subject.team.colors_source === 'neutral (no colours on file)' && c.subject.team.abbr.length <= 5 && c.subject.team.color === '#3b4a6b', c.subject.team);
  chk('a team with colours keeps them', contents.fs2.subject.team.color === '#cc0000');
  FORMATS.forEach((f) => {
    const L = SG.layout(c, f);
    const parts = L.ops.filter((o) => o.type === 'text' && o.size >= 18 && c.subject.name.indexOf(o.text.replace(/…$/, '')) >= 0 && o.text.length > 3);
    const shown = parts.map((o) => o.text).join(' ');
    chk('the very long name is fitted or wrapped, never clipped (' + f + ')', parts.length >= 1 && parts.every((o) => o.width <= o.maxW + 1 && o.size >= 18) && shown.replace(/…$/, '').length >= Math.min(30, c.subject.name.length), { shown, sizes: parts.map((o) => o.size) });
  });
  ['OUTDATED', 'WITHDRAWN'].forEach((st) => FORMATS.forEach((f) => {
    const Ls = SG.layout(Object.assign({}, c, { stamp: st }), f);
    chk(st + ' ' + f + ': the band is drawn and says so', Ls.ops.some((o) => o.type === 'text' && o.text === SG.STAMPS[st]) && SG.check(Ls).length === 0);
  }));
  const fx = JSON.parse(JSON.stringify(fs1)); fx.fixture = true; fx.version_hash = E.versionHash(fx);
  const fc = SG.content(fx, {}).content;
  chk('a fixture always says it is a controlled test input', SG.layout(fc, 'square').ops.some((o) => o.type === 'text' && o.text === SG.STAMPS.FIXTURE));
  chk('a real signal carries no fixture band', !SG.layout(c, 'square').ops.some((o) => o.type === 'text' && o.text === SG.STAMPS.FIXTURE));
}

/* ── rules ───────────────────────────────────────────────────────────── */
{
  const un = JSON.parse(JSON.stringify(fs1)); un.verification = { state: 'UNVERIFIED', checks: [], failed: ['x'] };
  chk('an UNVERIFIED signal gets no graphic', SG.content(un).ok === false && /VERIFIED/.test(SG.content(un).reason));
  chk('a data-quality warning gets no graphic', SG.content(dq).ok === false);
  chk('a non-payload gets no graphic', SG.content({ hello: 1 }).ok === false);
  const bad = JSON.parse(JSON.stringify(fs1)); bad.evidence.summary = 'This is the lock of the week';
  chk('the copy rule refuses a graphic, it does not soften it', SG.content(bad).ok === false && SG.content(bad).reason === 'copy_rule');
  chk('file name: the signal key and version, the format', G.fileName(contents.fs1, 'landscape') === 'edgedesk-signal-' + fs1.signal_key.slice(4) + '-v2-landscape.png', G.fileName(contents.fs1, 'landscape'));
  chk('alt text describes the graphic and ends research, not picks', /Signal Center graphic/.test(contents.fs1.alt) && /Research, not picks\.$/.test(contents.fs1.alt));
  const rc = SG.recap([fs1, fs2, dv, sm, inj, dq, Object.assign({}, fsv, { fixture: true })], { from: iso(NOW - 7 * 86400e3), to: iso(NOW), now: iso(NOW) });
  chk('the recap builds', rc.ok, rc);
  const order = rc.content.numbers.rows.map((r) => r.text);
  const want = [fs1, fs2, dv, sm, inj].sort((a, b) => b.score.total - a.score.total || a.signal_key.localeCompare(b.signal_key)).slice(0, 5).map((p) => p.headline);
  chk('the recap ranks by the importance score only, and excludes data-quality warnings and fixtures', JSON.stringify(order) === JSON.stringify(want), { order, want });
  chk('the recap names every signal version it shows', rc.content.version_hashes.length === order.length);
  FORMATS.forEach((f) => chk('recap ' + f + ': lays out inside the canvas', SG.check(SG.layout(rc.content, f)).length === 0, SG.check(SG.layout(rc.content, f)).slice(0, 2)));
  chk('the recap needs at least one verified signal', SG.recap([dq]).ok === false);
}

/* ── real signals: every committed-source signal draws ───────────────── */
{
  const Src = require('./sources.js');
  const { evaluate } = require('./evaluate.js');
  const football = Src.footballGames(), au = Src.audits();
  const r = evaluate({ football, footballCurrent: Src.footballCurrent(), perfGames: Src.perfForecastGames(), perfLastCapture: au.perf && au.perf.ledger ? au.perf.ledger.last_capture_at : null,
    quotes: Src.perfQuotes(), slateTeams: Src.slateTeams(), audits: au, cfbAvailability: Src.cfbAvailability(null, football), sourceStates: Src.sourceStates(null), now: NOW });
  let n = 0, problems = 0, refused = 0;
  r.signals.forEach((p) => {
    const c = SG.content(p, { version: 1 });
    if (!c.ok) { if (SG.eligible(p).ok) refused++; return; }
    FORMATS.forEach((f) => { n++; if (SG.check(SG.layout(c.content, f)).length) problems++; });
  });
  chk('every eligible real signal builds a graphic (none refused by the copy rule)', refused === 0, refused);
  chk('every real signal lays out cleanly in all three formats (' + n + ' layouts)', n > 100 && problems === 0, { n, problems });
}

process.exit(T.done());
