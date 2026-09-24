#!/usr/bin/env node
/* ===========================================================================
   THE FOOTBALL MODEL RECORD — record, close, settle, grade. NFL and CFB.

   The research tool's own record, kept apart from the edges record on
   purpose: this grades the NUMBER the football model publishes, not a price
   the capture flagged. See tools/record/football_record_core.js for the rules.

   One run does four things, in order:

     1  RECORD every PREDICTED game on the two published slates
        (football/nfl/slate.json, football/fbs/slate.json) whose number was
        published before kickoff. --backfill first replays every committed
        version of both slates from git history, oldest first, so a number
        that was on the site before kickoff is on the record even if this
        job did not exist yet — the commit time is the proof it was pregame.
     2  QUOTE the market for every recorded game still ahead of kickoff that
        has no quote yet (NFL: the slate's own nflverse reference line from
        the same build; CFB: ESPN's line). Never after kickoff.
     3  CLOSE and SETTLE every game that has kicked off: the closing line
        and the final score, from nflverse (NFL) and ESPN + cfbfastR (CFB).
     4  GRADE and write record/football/{nfl,cfb}_<season>.json and
        record/football/summary.json — only when something actually changed.

   Usage
     node tools/record/football_record.js              # dry run: prints what it would record
     node tools/record/football_record.js --write      # write the record
     node tools/record/football_record.js --backfill   # replay the slates' git history first
     node tools/record/football_record.js --offline    # no network: record projections only
     node tools/record/football_record.js --history ../clone   # replay from another clone's history
     options: --season 2026  --now <ISO>  --out record/football
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./football_record_core.js');
const S = require('./football_record_sources.js');
const { writeIfChanged } = require(path.join(__dirname, '..', 'football', 'write_if_changed.js'));

const ROOT = path.join(__dirname, '..', '..');
const SLATES = { nfl: 'football/nfl/slate.json', cfb: 'football/fbs/slate.json' };
const DAY = 86400000;
/* how far back a kicked-off game keeps being chased for its close and final */
const CHASE_DAYS = 21;
/* how far ahead a game is quoted (the slates look 10–12 days out) */
const QUOTE_DAYS = 12;
const MAX_ESPN_DATES = 24;
const MAX_ESPN_SUMMARIES = 40;

function args(argv) {
  const a = { write: false, backfill: false, offline: false, season: null, now: null, out: 'record/football', history: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else if (k === '--backfill') a.backfill = true;
    else if (k === '--offline') a.offline = true;
    else if (k === '--history') { a.history = argv[++i]; a.backfill = true; }
    else if (k === '--season') a.season = Number(argv[++i]);
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else throw new Error('unknown option ' + k);
  }
  return a;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function cfbModelVersion() {
  try {
    const m = /"model_version"\s*:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'params.js'), 'utf8'));
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/* Every committed version of a file, oldest first. Needs the history to be
   present (fetch-depth: 0, or --history <another clone>); a shallow clone
   yields what it has. */
function gitVersions(rel, repo) {
  const cwd = repo || ROOT;
  let log = '';
  try { log = execFileSync('git', ['log', '--format=%H %cI', '--reverse', '--', rel], { cwd, maxBuffer: 64 << 20 }).toString(); } catch (_) { return []; }
  return log.trim().split('\n').filter(Boolean).map((line) => {
    const [sha, at] = line.split(' ');
    return { sha, at, read() {
      try { return JSON.parse(execFileSync('git', ['show', sha + ':' + rel], { cwd, maxBuffer: 512 << 20 }).toString()); } catch (_) { return null; }
    } };
  });
}

/* ----------------------------------------------------------- step 1 */
function ingestSlate(sport, ledger, slate, ctx, tally) {
  if (!slate || !Array.isArray(slate.games)) return;
  const meta = { season: slate.season, model_version: sport === 'cfb' ? ctx.cfbVersion : null };
  const published = slate.generated_at || ctx.commit_at || null;
  slate.games.forEach((g) => {
    const p = C.projectionFromSlate(sport, g, meta);
    if (!p) { tally.unpriced++; return; }
    if (p.season !== ledger.season) return;
    /* the NFL slate carries the nflverse line from the very build that
       produced the number: the market at the moment of publication */
    const market = p.reference_market ? Object.assign({}, p.reference_market, { at: published }) : null;
    const r = C.recordProjection(ledger, p, { published_at: published, commit_at: ctx.commit_at || null, now: ctx.now,
      market, replay: !!ctx.replay, provenance: ctx.provenance || null });
    if (r.indexOf('refused:') === 0) { const why = r.slice(8); tally.refused[why] = (tally.refused[why] || 0) + 1; }
    else tally[r]++;
  });
}

/* ----------------------------------------------------------- step 2–3 */
async function nflSources(ledger, now, log) {
  let rows = {};
  try { rows = S.parseNflverse(await S.fetchText(S.URL_NFL, 60000), ledger.season); log.push('nflverse: ' + Object.keys(rows).length + ' games'); }
  catch (e) { log.push('nflverse: unreachable (' + String(e.message).slice(0, 80) + ')'); }
  const t = { market: 0, close: 0, final: 0 };
  Object.keys(ledger.games).forEach((id) => {
    const e = ledger.games[id], r = rows[id];
    if (!r) return;
    if (r.market && C.fillMarket(e, r.market, now)) t.market++;
    if (r.close && C.setClose(e, r.close, now)) t.close++;
    if (r.final && C.setFinal(e, r.final, now)) t.final++;
  });
  log.push('nfl filled: ' + JSON.stringify(t));
}

function needsEspn(e, nowMs) {
  const k = Date.parse(e.kickoff);
  if (!Number.isFinite(k)) return false;
  /* ahead: until it has a quote, and every run inside the pre-close window,
     where the last line before kickoff is kept as the close's fallback */
  if (k > nowMs) return k - nowMs <= QUOTE_DAYS * DAY && (!e.market_pick || !e.entry || k - nowMs <= C.PRECLOSE_HOURS * 3600000);
  return nowMs - k <= CHASE_DAYS * DAY && (!e.final || !e.close || e.close.home_line == null);
}
function lacksClose(e) { return !e.close || e.close.home_line == null; }

async function cfbSources(ledger, now, log) {
  const nowMs = Date.parse(now);
  let sched = {};
  try { sched = S.parseCfbSchedule(await S.fetchText(S.URL_CFB_SCHED(ledger.season), 60000), ledger.season); log.push('cfbfastR: ' + Object.keys(sched).length + ' games'); }
  catch (e) { log.push('cfbfastR: unreachable (' + String(e.message).slice(0, 80) + ')'); }

  const want = Object.keys(ledger.games).filter((id) => needsEspn(ledger.games[id], nowMs));
  const dates = Array.from(new Set(want.map((id) => S.etDate(ledger.games[id].kickoff)).filter(Boolean))).sort().slice(-MAX_ESPN_DATES);
  const espn = {};
  let ok = 0, bad = 0;
  for (const d of dates) {
    try { Object.assign(espn, S.parseEspnScoreboard(JSON.parse(await S.fetchText(S.espnScoreboardUrl('cfb', d), 30000)))); ok++; }
    catch (e) { bad++; }
  }
  /* WHAT THE SCOREBOARD SAID ABOUT FINISHED GAMES, in the log on every run:
     the first live run found 160 finished games and 0 closes, and only a
     count like this says whether that is a parser or a feed with no odds. */
  const fin = want.map((id) => espn[id]).filter((g) => g && g.completed);
  log.push('espn finished games on the scoreboard: ' + fin.length + ', carrying odds ' + fin.filter((g) => g.odds_n > 0).length
    + ', with a readable line ' + fin.filter((g) => g.close && g.close.home_line != null).length);
  /* asked for by its own id: a game the day's scoreboard did not carry (the
     groups filter, a moved date), then a finished game it carried with no
     line — the summary's odds block can outlive the scoreboard's. Newest
     first, capped per run; the next run takes the rest. */
  const byKick = (a, b) => Date.parse(ledger.games[b].kickoff) - Date.parse(ledger.games[a].kickoff);
  const absent = want.filter((id) => !espn[id]);
  const bare = want.filter((id) => espn[id] && espn[id].completed && (!espn[id].close || espn[id].close.home_line == null)
    && lacksClose(ledger.games[id])).sort(byKick);
  const ask = absent.concat(bare).slice(0, MAX_ESPN_SUMMARIES);
  let sum = 0, sumLine = 0;
  for (const id of ask) {
    try {
      const g = S.parseEspnSummary(JSON.parse(await S.fetchText(S.espnSummaryUrl('cfb', id), 30000)), id);
      if (!g) continue;
      sum++;
      if (g.close && g.close.home_line != null) sumLine++;
      if (!espn[id] || (g.close && g.close.home_line != null) || (g.market && !espn[id].market)) espn[id] = g;
    } catch (_) { /* noted in the count */ }
  }
  log.push('espn: ' + ok + ' scoreboard day(s) read' + (bad ? ', ' + bad + ' failed' : '') + ', ' + sum + '/' + ask.length
    + ' summaries (' + sumLine + ' with a closing line), ' + want.length + ' game(s) wanted');

  const t = { market: 0, close: 0, final: 0, contested: 0, last_quote: 0, close_from_last_quote: 0 };
  Object.keys(ledger.games).forEach((id) => {
    const e = ledger.games[id], es = espn[id], cs = sched[id];
    if (es && es.market && C.fillMarket(e, es.market, now)) t.market++;
    if (es && es.market && C.noteQuote(e, es.market, now)) t.last_quote++;
    if (es && es.close && C.setClose(e, es.close, now)) t.close++;
    /* two finals that disagree settle nothing */
    const a = es && es.final, b = cs && cs.final;
    if (a && b && (a.home_score !== b.home_score || a.away_score !== b.away_score)) { t.contested++; return; }
    const f = a && b ? { home_score: a.home_score, away_score: a.away_score, source: 'espn+cfbfastR' } : (a || b);
    if (f && Date.parse(e.kickoff) <= nowMs && C.setFinal(e, f, now)) t.final++;
    /* the source kept no close for a finished game: its last pregame line */
    if (C.closeFromLastQuote(e, now)) t.close_from_last_quote++;
  });
  log.push('cfb filled: ' + JSON.stringify(t));
}

/* ----------------------------------------------------------- step 4 */
function compactRow(e) {
  const g = e.grade || {};
  return {
    game_id: e.game_id, week: e.week, kickoff: e.kickoff, home: e.home, away: e.away,
    home_code: e.home_code, away_code: e.away_code, group: e.group,
    model_line: e.pick && e.pick.home_line, model_total: e.pick && e.pick.total,
    entry_line: e.entry && e.entry.market && e.entry.market.home_line, close_line: e.close && e.close.home_line,
    close_total: e.close && e.close.total,
    final: e.final ? [e.final.away_score, e.final.home_score] : null,
    status: g.status, ats: g.spread && g.spread.result, ats_side: g.spread && g.spread.side,
    ou: g.total && g.total.result, ou_side: g.total && g.total.side,
    clv: g.clv_entry && g.clv_entry.spread ? g.clv_entry.spread.pts : null,
  };
}

function buildSummary(ledgers, sums, now) {
  const out = {
    schema: C.SUMMARY_SCHEMA, generated_at: now, season: ledgers.nfl.season,
    what: 'The football model’s own record: the number it published before kickoff, graded against the closing line and the final. Separate from the edges record, which grades flagged prices.',
    rules: [
      'Only numbers published before kickoff are recorded; the pick is the last pregame number and the first is kept beside it.',
      'Against the spread and the total, the model’s side is set by its number against the CLOSE and graded on the final.',
      'CLV is in points: how far the market moved toward the side the model leaned, from the quote recorded with the number to the close, from the same source.',
      'No close, no final, no total: nothing is estimated. A final two feeds disagree on settles nothing.',
    ],
    sources: {
      nfl: { projection: SLATES.nfl, market: 'nflverse consensus (the slate’s own reference line)', close: 'nflverse consensus at the final', final: 'nflverse' },
      cfb: { projection: SLATES.cfb, market: 'ESPN scoreboard line (named book)', close: 'ESPN line frozen at kickoff; where ESPN keeps none for a finished game, the last ESPN line this record captured before kickoff', final: 'ESPN and cfbfastR, which must agree' },
    },
    sports: { nfl: sums.nfl, cfb: sums.cfb },
    cfb_groups: {},
    recent: {},
  };
  ['p4', 'other_fbs', 'fbs_fcs'].forEach((grp) => {
    const sub = Object.assign({}, ledgers.cfb, { games: {} });
    Object.keys(ledgers.cfb.games).forEach((k) => { if (ledgers.cfb.games[k].group === grp) sub.games[k] = ledgers.cfb.games[k]; });
    const grades = {}; Object.keys(sub.games).forEach((k) => { grades[k] = sub.games[k].grade; });
    const s = C.summarize(sub, grades);
    out.cfb_groups[grp] = { counts: s.counts, ats: s.ats, ou: s.ou, su: s.su, clv: { spread_entry: s.clv.spread_entry }, error: s.error };
  });
  ['nfl', 'cfb'].forEach((sp) => {
    const done = Object.values(ledgers[sp].games).filter((e) => e.grade && (e.grade.status === 'GRADED' || e.grade.status === 'FINAL_NO_CLOSE'));
    done.sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
    out.recent[sp] = done.slice(0, 12).map(compactRow);
  });
  return out;
}

async function run(opts) {
  const now = opts.now || new Date().toISOString();
  const slates = { nfl: readJson(path.join(ROOT, SLATES.nfl)), cfb: readJson(path.join(ROOT, SLATES.cfb)) };
  const season = opts.season || (slates.nfl && slates.nfl.season) || (slates.cfb && slates.cfb.season);
  if (!season) throw new Error('no season: neither slate could be read');
  const outDir = path.isAbsolute(opts.out) ? opts.out : path.join(ROOT, opts.out);
  const file = (sp) => path.join(outDir, sp + '_' + season + '.json');
  const ledgers = {
    nfl: readJson(file('nfl')) || C.emptyLedger('nfl', season),
    cfb: readJson(file('cfb')) || C.emptyLedger('cfb', season),
  };
  const cfbVersion = cfbModelVersion();
  const log = [];
  const tallies = {};

  for (const sp of ['nfl', 'cfb']) {
    const t = (tallies[sp] = { new: 0, revised: 0, unchanged: 0, unpriced: 0, refused: {} });
    if (opts.backfill) {
      const vs = gitVersions(SLATES[sp], opts.history && path.resolve(opts.history));
      vs.forEach((v) => ingestSlate(sp, ledgers[sp], v.read(), { now, commit_at: v.at, replay: true, provenance: 'git ' + v.sha.slice(0, 10), cfbVersion }, t));
      log.push(sp + ' backfill: replayed ' + vs.length + ' committed version(s) of ' + SLATES[sp]);
    }
    ingestSlate(sp, ledgers[sp], slates[sp], { now, cfbVersion }, t);
  }

  if (!opts.offline) {
    await nflSources(ledgers.nfl, now, log);
    await cfbSources(ledgers.cfb, now, log);
  } else log.push('offline: no market, close or final was read');

  const sums = {};
  const written = {};
  for (const sp of ['nfl', 'cfb']) {
    sums[sp] = C.gradeLedger(ledgers[sp], now);
    ledgers[sp].updated_at = now;
    if (opts.write) written[sp] = writeIfChanged(file(sp), ledgers[sp], { pretty: true, newline: true });
  }
  const summary = buildSummary(ledgers, sums, now);
  if (opts.write) written.summary = writeIfChanged(path.join(outDir, 'summary.json'), summary, { pretty: true, newline: true });
  return { season, tallies, log, summary, ledgers, written };
}

function line(s) {
  const a = s.ats.all, c = s.clv.spread_entry;
  return s.counts.recorded + ' recorded · ' + s.counts.graded + ' graded · ATS ' + a.w + '-' + a.l + '-' + a.p
    + ' · O/U ' + s.ou.all.w + '-' + s.ou.all.l + '-' + s.ou.all.p + ' · SU ' + s.su.w + '-' + s.su.l
    + ' · CLV ' + (c.n ? ((c.avg > 0 ? '+' : '') + c.avg + ' pts avg, beat the close ' + c.beat_pct + '% (n=' + c.n + ')') : 'n=0');
}

if (require.main === module) {
  let opts;
  try { opts = args(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  run(opts).then((r) => {
    ['nfl', 'cfb'].forEach((sp) => {
      console.log(sp.toUpperCase() + ' ' + r.season + ' — this run: ' + JSON.stringify(r.tallies[sp]));
      console.log('  ' + line(r.summary.sports[sp]));
    });
    r.log.forEach((l) => console.log('  · ' + l));
    if (opts.write) console.log('written: ' + JSON.stringify(r.written));
    else console.log('dry run: nothing written (pass --write)');
  }).catch((e) => { console.error('football record failed: ' + (e && e.stack || e)); process.exit(1); });
}

module.exports = { run, ingestSlate, needsEspn, buildSummary, gitVersions };
