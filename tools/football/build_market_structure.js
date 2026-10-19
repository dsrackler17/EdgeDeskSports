#!/usr/bin/env node
/* ===========================================================================
   NFL MARKET STRUCTURE — football/market_structure/nfl.json

   One committed artifact for the three Market Structure layers that are
   computed from data EdgeDesk already owns, with nothing priced and nothing
   fed to a model (docs/market-structure/README.md):

     margin_frequency  the empirical distribution of final NFL margins, both
                       absolute and signed by the closing favourite, in two
                       windows (every settled game; 2023 onward), from the
                       closing-line archive football/pricing/lines_nfl.json.
                       Loaded into public.nfl_margin_frequency by
                       tools/football/market_structure_sync.js; the SQL
                       public.half_point_value() reads it there.
     two_point         the league's two-point try share per week, from
                       nflverse play-by-play (2015 onward: the extra point
                       moved back that year, which is where the modern try
                       era starts). The Drift line. Past seasons are kept
                       from the committed artifact (that football is over);
                       the season in progress is re-read every run.
     situational       the season in progress: each game's venue (neutral
                       from the schedule's own location column) and
                       divisional flag (the seeded division table, checked
                       against the feed's div_game), and the season-to-date
                       ATS record of every bucket against the closing line.

   Usage
     node tools/football/build_market_structure.js            # fetch what is due, write
     node tools/football/build_market_structure.js --offline  # cached feeds only
     node tools/football/build_market_structure.js --check    # build, compare, write nothing
     node tools/football/build_market_structure.js --full     # re-read every play-by-play season
     node tools/football/build_market_structure.js --no-pbp   # keep the committed two-point block
   Exit 0 = written or current; 1 = the artifact differs (--check); 2 = a
   required input could not be read (reported, never a pass).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const MS = require(path.join(ROOT, 'lib', 'edgedesk_market_structure.js'));
const io = require(path.join(ROOT, 'football', 'props', 'factory', 'lib', 'io.js'));
const { writeIfChanged, strip } = require(path.join(__dirname, 'write_if_changed.js'));

const SCHEMA = 'edgedesk_nfl_market_structure_v1';
const OUT = path.join(ROOT, 'football', 'market_structure', 'nfl.json');
const LINES = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
const NFLV = process.env.EDGEDESK_NFLVERSE_RELEASES || 'https://github.com/nflverse/nflverse-data/releases/download';
const URLS = { schedule: NFLV + '/schedules/games.csv', pbp: (y) => NFLV + '/pbp/play_by_play_' + y + '.csv.gz' };
const FIRST_TRY_SEASON = 2015;
const PBP_COLS = ['game_id', 'season', 'week', 'season_type', 'play_type', 'two_point_attempt', 'two_point_conv_result', 'extra_point_attempt', 'touchdown'];

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

/* ------------------------------------------------------- two-point tries */
/** Reduce one season of play-by-play rows to per-week try counts. Pure; the
    suite hands it labelled rows. */
function reduceTries(rows) {
  const W = new Map();
  rows.forEach((p) => {
    if (p.play_type === 'no_play') return;          /* a penalty: the try is replayed on its own row */
    const s = Number(p.season), w = Number(p.week);
    if (!isFinite(s) || !isFinite(w)) return;
    const k = s + '|' + w + '|' + (p.season_type || '');
    let x = W.get(k);
    if (!x) { x = { season: s, week: w, season_type: p.season_type || null, games: new Set(), xp_att: 0, two_pt_att: 0, two_pt_made: 0, touchdowns: 0 }; W.set(k, x); }
    if (p.game_id) x.games.add(p.game_id);
    if (p.two_point_attempt === '1') { x.two_pt_att++; if (p.two_point_conv_result === 'success') x.two_pt_made++; }
    if (p.extra_point_attempt === '1') x.xp_att++;
    if (p.touchdown === '1') x.touchdowns++;
  });
  return [...W.values()].map((x) => ({ season: x.season, week: x.week, season_type: x.season_type, games: x.games.size,
    xp_att: x.xp_att, two_pt_att: x.two_pt_att, two_pt_made: x.two_pt_made, touchdowns: x.touchdowns,
    share: x.xp_att + x.two_pt_att ? Math.round(1e4 * x.two_pt_att / (x.xp_att + x.two_pt_att)) / 1e4 : null }))
    .sort((a, b) => a.season - b.season || (a.season_type === b.season_type ? 0 : (a.season_type === 'REG' ? -1 : 1)) || a.week - b.week);
}
async function triesFor(season, opts) {
  const f = await io.fetchCached(URLS.pbp(season), 'nflverse', 'play_by_play_' + season + '.csv.gz', { offline: opts.offline, currentSeason: opts.current });
  if (!f) return { season, weeks: null, error: 'play-by-play for ' + season + ' is not published' };
  const rows = [];
  await io.readCsv(f.file, (o) => rows.push(o), { columns: PBP_COLS });
  return { season, weeks: reduceTries(rows), file: path.basename(f.file), stale: !!f.stale };
}

/* ---------------------------------------------------------- situational */
function scheduleIndex(rows) {
  const by = {};
  (rows || []).forEach((g) => { if (g.game_id) by[g.game_id] = { location: g.location || null, div_game: g.div_game === '1' ? true : (g.div_game === '0' ? false : null) }; });
  return by;
}
function situational(lines, sched, season) {
  const games = lines.games.filter((g) => g.season === season);
  const flags = {}, mismatches = [];
  games.forEach((g) => {
    const s = sched[g.id] || {};
    const div = MS.isDivisional(g.home, g.away);
    const feed = s.div_game != null ? s.div_game : (g.ctx ? g.ctx.divisional : null);
    if (feed != null && feed !== div) mismatches.push({ game_id: g.id, table: div, feed });
    flags[g.id] = { week: g.week, home: g.home, away: g.away, neutral: s.location === 'Neutral', divisional: div, location: s.location };
  });
  const settled = games.filter((g) => g.margin != null && g.close && g.close.home_line != null)
    .map((g) => ({ season: g.season, week: g.week, date: g.date, home: g.home, away: g.away, margin: g.margin, close: g.close, neutral: flags[g.id].neutral, divisional: flags[g.id].divisional }));
  const ats = MS.atsBuckets(settled, { season });
  return { season, ats, games: flags, division_check: { checked: games.filter((g) => (sched[g.id] || {}).div_game != null || (g.ctx && g.ctx.divisional != null)).length, mismatches },
    neutral_source: Object.keys(sched).length ? 'nflverse games.csv location' : 'unavailable (schedule feed not read): every game reads non-neutral' };
}

/* --------------------------------------------------------------- build */
/** Assemble the artifact from its inputs. Pure: the suite calls it directly. */
function assemble(lines, sched, tries, prevTwo, opts) {
  opts = opts || {};
  const games = lines.games.filter((g) => typeof g.margin === 'number');
  const season = opts.season || Math.max.apply(null, lines.games.map((g) => g.season));
  const windows = MS.WINDOWS.map((w) => {
    const f = MS.marginFrequency(games, w);
    return { window_label: w.label, first_season: f.first_season, last_season: f.last_season, note: w.note, abs: f.abs, fav_signed: f.fav_signed };
  });
  const weeks = [];
  (tries || []).forEach((t) => { (t.weeks || []).forEach((w) => weeks.push(w)); });
  const series = MS.twoPointSeries(weeks.filter((w) => w.season_type === 'REG'), { current_season: season });
  const two = { definition: series.definition, first_season: FIRST_TRY_SEASON, scope: 'regular season (the drift line); postseason weeks are kept in weeks[] and excluded from the share',
    weeks, seasons: series.seasons, drift: series.drift,
    missing: (tries || []).filter((t) => !t.weeks).map((t) => ({ season: t.season, error: t.error })) };
  return {
    schema: SCHEMA, version: 1, generated_at: opts.now || new Date().toISOString(), engine: MS.VERSION,
    tier: 'T0 observations and T2 deterministic transforms; nothing here is a model, a price, a projection or a grade',
    source: { lines: { file: 'football/pricing/lines_nfl.json', schema: lines.schema, generated_at: lines.generated_at, basis: lines.source && lines.source.basis },
      schedule: Object.keys(sched).length ? { url: URLS.schedule, games: Object.keys(sched).length } : null,
      play_by_play: { url_pattern: NFLV + '/pbp/play_by_play_<season>.csv.gz', columns: PBP_COLS } },
    key_numbers: MS.KEY_NUMBERS, six_watch: MS.SIX_WATCH, config: MS.CONFIG,
    margin_frequency: { sign_convention: 'abs: |home − away|. fav_signed: the closing favourite\'s score minus the underdog\'s (negative = the favourite lost); pick\'em closes are excluded and counted.',
      includes: 'regular season and postseason, overtime included', windows },
    two_point: two,
    situational: situational(lines, sched, season),
    divisions: MS.DIVISIONS.map((d) => ({ team_code: d[0], nflverse_code: d[1], team_name: d[2], conference: d[3], division: d[4] })),
    note: 'Descriptive. The Market Structure section shows it; the registered EXPERIMENTAL studies read it; no projection, spread, probability, EV, ranking or grade does.'
  };
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline'), check = args.includes('--check'), full = args.includes('--full'), noPbp = args.includes('--no-pbp');
  const lines = readJson(LINES);
  if (!lines || !Array.isArray(lines.games)) { console.error('cannot read ' + path.relative(ROOT, LINES)); process.exit(2); }
  const season = args.includes('--season') ? Number(args[args.indexOf('--season') + 1]) : Math.max.apply(null, lines.games.map((g) => g.season));
  const prev = readJson(OUT);

  let sched = {};
  try {
    const f = await io.fetchCached(URLS.schedule, 'nflverse', 'games.csv', { offline, currentSeason: season });
    if (f) sched = scheduleIndex(await io.loadCsv(f.file, { columns: ['game_id', 'location', 'div_game'] }));
  } catch (e) { console.error('schedule feed unavailable (' + e.message + '): neutral sites cannot be marked'); }
  if (!Object.keys(sched).length && prev && prev.situational && prev.situational.games) {
    /* keep the venue the last good build read rather than call every game non-neutral */
    Object.keys(prev.situational.games).forEach((id) => { const g = prev.situational.games[id]; sched[id] = { location: g.location || null, div_game: null }; });
  }

  const tries = [];
  const prevWeeks = (prev && prev.two_point && prev.two_point.weeks) || [];
  for (let y = FIRST_TRY_SEASON; y <= season; y++) {
    const kept = prevWeeks.filter((w) => w.season === y);
    if (noPbp || (!full && y < season && kept.length)) { tries.push({ season: y, weeks: kept.length ? kept : null, error: kept.length ? null : 'not in the committed artifact' }); continue; }
    try { const t = await triesFor(y, { offline, current: season }); tries.push(t); console.log('play-by-play ' + y + ': ' + (t.weeks ? t.weeks.length + ' weeks' : t.error)); }
    catch (e) { tries.push({ season: y, weeks: kept.length ? kept : null, error: e.message }); console.error('play-by-play ' + y + ': ' + e.message + (kept.length ? ' (committed weeks kept)' : '')); }
  }

  const art = assemble(lines, sched, tries, prev && prev.two_point, { season });
  const W = art.margin_frequency.windows;
  console.log('margin frequency: ' + W.map((w) => w.window_label + ' n=' + w.abs.n_games + ' (fav-signed ' + w.fav_signed.n_games + ', ' + w.fav_signed.excluded_pickem + ' PK)').join(' · '));
  if (art.two_point.drift) console.log('two-point drift ' + art.two_point.drift.season + ': ' + (100 * art.two_point.drift.share).toFixed(1) + '% vs ' + (100 * art.two_point.drift.baseline_share).toFixed(1) + '% (z ' + art.two_point.drift.z + ', ' + art.two_point.drift.status + ')');
  console.log('situational ' + season + ': ' + art.situational.ats.n_games + ' settled games; division check ' + art.situational.division_check.mismatches.length + ' mismatches of ' + art.situational.division_check.checked);
  if (check) {
    const same = prev && JSON.stringify(strip(prev)) === JSON.stringify(strip(art));
    console.log(same ? 'current' : 'DIFFERS from the committed artifact');
    process.exit(same ? 0 : 1);
  }
  console.log(writeIfChanged(OUT, art, { pretty: true, newline: true }) + ' ' + path.relative(ROOT, OUT));
}

module.exports = { assemble, reduceTries, scheduleIndex, situational, OUT, SCHEMA, FIRST_TRY_SEASON };
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
