#!/usr/bin/env node
/* ===========================================================================
   THE 2026-10-15 REGRESSION FIXTURE — every artifact the multi-sport quant
   desk reads, exactly as committed at the replay time, trimmed to the events
   around that day so the test runs in CI without git history.

   Source: git, `git log -1 --before=2026-10-15T13:00:00Z -- <path>` per file
   (tools/quant/multisport_run.js fromGit, which refuses any artifact whose own
   generated_at is after the replay time). Nothing is edited: games outside
   2026-10-15 12:00Z .. 2026-10-17 12:00Z are dropped and the per-file
   provenance (commit, generated_at) is kept in `meta`.

   The capture signals for the legacy captured-price board are not in git;
   the fixture derives them from the SAME committed scoreboard snapshot (the
   DraftKings lines captured 11:20Z) for the sports capture covers (NFL, CFB),
   labelled `derived_from` so no one mistakes them for a database export.

   Run: node tools/quant/build_oct15_fixture.js   → tools/intelligence/fixtures/quant_oct15_2026.json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const RUN = require('./multisport_run.js');
const ROOT = path.join(__dirname, '..', '..');
const AT = '2026-10-15T13:00:00Z';
const FROM = Date.parse('2026-10-15T12:00:00Z'), TO = Date.parse('2026-10-17T12:00:00Z');
const OUT = path.join(ROOT, 'tools', 'intelligence', 'fixtures', 'quant_oct15_2026.json');

function inRange(t) { const x = Date.parse(t || ''); return Number.isFinite(x) && x >= FROM && x < TO; }
function build() {
  const src = RUN.fromGit(AT, RUN.PATHS);
  const A = src.artifacts, out = {};
  /* hockey: the window's games only */
  if (A['hockey/slate.json']) out['hockey/slate.json'] = Object.assign({}, A['hockey/slate.json'], { games: A['hockey/slate.json'].games.filter((g) => inRange(g.start_utc)), quotes_by_game: {}, lab: null, attribution: null, challenger_records: null, distribution: null });
  /* NBA: the regular season opens after the window; two games keep the season start visible to discovery */
  if (A['nba/slate.json']) out['nba/slate.json'] = Object.assign({}, A['nba/slate.json'], { games: A['nba/slate.json'].games.slice(0, 2), rosters: A['nba/slate.json'].rosters });
  if (A['nba/validation/summary.json']) { const s = A['nba/validation/summary.json']; out['nba/validation/summary.json'] = { schema: s.schema, generated_at: s.generated_at, choice: s.choice, markets: { P: s.markets.P }, windows: { test: { G_stack_P: s.windows.test.G_stack_P, home_only: s.windows.test.home_only } } }; }
  out['basketball/slate.json'] = A['basketball/slate.json'];
  if (A['soccer/slate.json']) { const s = A['soccer/slate.json']; const lg = {}; Object.keys(s.leagues).forEach((k) => { lg[k] = Object.assign({}, s.leagues[k], { games: (s.leagues[k].games || []).slice(0, 2) }); }); out['soccer/slate.json'] = Object.assign({}, s, { leagues: lg }); }
  if (A['football/nfl/slate.json']) { const s = A['football/nfl/slate.json']; out['football/nfl/slate.json'] = { schema: s.schema, version: s.version, season: s.season, generated_at: s.generated_at, source: s.source, engine: { model_version: s.engine.model_version, feature_version: s.engine.feature_version, trained_through: s.engine.trained_through, built_at: s.engine.built_at, validation: s.engine.validation }, window: s.window, games: s.games.filter((g) => inRange(g.kickoff)) }; }
  if (A['football/fbs/slate.json']) { const s = A['football/fbs/slate.json']; const KEEP = ['game_id', 'season', 'week', 'kickoff', 'game_date', 'neutral_site', 'venue', 'home_team', 'away_team', 'home_team_id', 'away_team_id', 'home_conference', 'away_conference', 'model_status', 'model_home_margin', 'model_home_line', 'model_fair_total', 'model_home_win_prob', 'data_completeness', 'home_starter', 'away_starter', 'shadow_model_version', 'market_status', 'reliability_score', 'reliability_grade'];
    const qb = (x) => x && typeof x === 'object' ? { schema: x.schema, state: x.state, side: x.side, source: x.source, identity: x.identity ? { player: x.identity.player, status: x.identity.status, confirmed: x.identity.confirmed } : null, season: x.season } : x;
    out['football/fbs/slate.json'] = { schema: s.schema, version: s.version, season: s.season, generated_at: s.generated_at, source: s.source, games: s.games.filter((g) => inRange(g.kickoff)).map((g) => { const o = {}; KEEP.forEach((k) => { if (g[k] !== undefined) o[k] = g[k]; }); o.home_qb_epa = qb(g.home_qb_epa); o.away_qb_epa = qb(g.away_qb_epa); return o; }) }; }
  if (A['football/starters/nfl_2026.json']) { const s = A['football/starters/nfl_2026.json']; const keep = {}; ['sea', 'den'].forEach((k) => { if (s.teams[k]) keep[k] = s.teams[k]; }); out['football/starters/nfl_2026.json'] = { schema: s.schema, season: s.season, week: s.week, generated_at: s.generated_at, teams: keep }; }
  out['engine/registry.json'] = A['engine/registry.json'];
  if (A['today/slate.json']) {
    const t = A['today/slate.json'];
    const ev = (t.events || []).filter((e) => inRange(e.start_utc));
    const ids = new Set(ev.map((e) => e.id));
    const mk = {}; Object.keys(t.markets || {}).forEach((k) => { if (ids.has(k)) mk[k] = t.markets[k]; });
    out['today/slate.json'] = { schema: t.schema, generated_at: t.generated_at, builder: t.builder, note: t.note, window: t.window, sources: t.sources, events: ev, upcoming: [], markets: mk };
  }
  /* the legacy board's capture signals, DERIVED from the same committed scoreboard snapshot (NFL and CFB only, as capture's allowlist) */
  const signals = [];
  const t = out['today/slate.json'];
  if (t) (t.events || []).forEach((e) => {
    const m = t.markets[e.id]; if (!m || (e.sport !== 'nfl' && e.sport !== 'cfb')) return;
    const key = e.sport === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';
    const dec = (a) => a > 0 ? 1 + a / 100 : 1 + 100 / -a;
    const add = (market, sel, point, am, opp) => { if (am == null) return; const d = dec(am), od = opp != null ? dec(opp) : null; const fair = od ? (1 / d) / (1 / d + 1 / od) : null;
      signals.push({ sig_key: 'fx-' + e.provider_id + '|' + market + '|' + sel + '|' + (point == null ? '' : point), event_id: 'fx-' + e.provider_id, sport_key: key, market, selection: sel, point,
        best_dec: Math.round(d * 1000) / 1000, first_best_dec: Math.round(d * 1000) / 1000, best_book: m.book, sharp_fair: null, sharp_book_fair: null, consensus_fair: fair ? Math.round(fair * 10000) / 10000 : null, reference_type: 'consensus', reference_book: null,
        edge: null, first_edge: null, n_books: 1, n_books_eff: 1, has_sharp: false, corrob_n: 0, home_team: e.home.name, away_team: e.away.name, commence_time: e.start_utc, first_seen_at: m.captured_at, last_seen_at: m.captured_at, flagged_at: null }); };
    if (m.moneyline) { add('h2h', e.home.name, null, m.moneyline.home, m.moneyline.away); add('h2h', e.away.name, null, m.moneyline.away, m.moneyline.home); }
    if (m.spread && m.spread.home) { add('spreads', e.home.name, m.spread.home.point, m.spread.home.price, m.spread.away && m.spread.away.price); add('spreads', e.away.name, m.spread.away.point, m.spread.away.price, m.spread.home.price); }
  });
  return { schema: 'edgedesk_quant_oct15_fixture_v1', replay_at: AT, built_by: 'tools/quant/build_oct15_fixture.js', window: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() },
    note: 'Committed artifacts as of the replay time, trimmed to the window. signals are derived from the committed scoreboard snapshot (derived_from), not a database export.',
    meta: src.meta, errors: src.errors, artifacts: out, signals: { derived_from: 'today/slate.json markets (the ESPN scoreboard\'s DraftKings lines, captured ' + (t ? t.generated_at : '?') + ')', rows: signals } };
}
if (require.main === module) {
  const f = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(f) + '\n');
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB): ' + Object.keys(f.artifacts).length + ' artifacts, ' + f.signals.rows.length + ' derived signals; errors: ' + JSON.stringify(f.errors));
}
module.exports = { build, AT };
