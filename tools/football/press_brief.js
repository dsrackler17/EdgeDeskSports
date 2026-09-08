#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK PRESS BRIEF — a printable research kit for a newsroom.

   WHAT IT IS FOR. A writer covering college football wants, on paper, in this
   order: what EdgeDesk projects, how sure it is, whether the number is worth
   chasing, and what it could not see. This builds that as one PDF: the slate
   with a projected score per game, the national ratings including the units,
   and an honest page on what the model does not know.

   IT INVENTS NOTHING. Every number is read from an artifact this repository
   already builds:

     football/cfb_p4/export_csv.js   the game projections (run here, headless)
     football/rankings/current.json  ETSR, talent, offence, defence, SPECIAL
                                     TEAMS, the unit ratings, confidence, Δ week
     football/rankings/health.json   the pipeline run record and its coverage
     football/rankings/history.json  the weekly series behind every Δ

   THE STATUS AND THE SCORE ARE THE PAGE'S OWN RULES, COPIED.
   `statusFor()` and `projectedScore()` below reproduce `fbP4StatusFor` and
   `fbGxScore` from app.html exactly, thresholds included, so the printed brief
   and the screen cannot say different things about the same game. If the app's
   rule changes, this file has to change with it — tools/football/press_brief.test.js
   holds them together.

   A SCORE IS ONLY PUBLISHED WHERE THE MODEL PUBLISHED A TOTAL. A margin
   without a total cannot be split into a score, and the brief says so on the
   game rather than halving a number it does not have.

     node tools/football/press_brief.js [--season 2026] [--week N | --upcoming]
          [--slate PATH] [--out DIR] [--html-only] [--quiet]

     --tz ZONE      IANA zone for every kickoff time (default America/New_York).
                    The website renders in the reader's own zone; a printed page
                    has no reader, so it states one and labels it.
     --slate PATH   a slate CSV to use instead of generating one. Point this at
                    the board's own "CSV (raw)" download to get the MARKET
                    columns: the public line archive carries no 2026 rows, so a
                    headless run has model numbers only, and says so.

   Output: <out>/edgedesk_press_brief_<season>_wk<week>.pdf (+ .html)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RANK = path.join(ROOT, 'football', 'rankings');
const B = require(path.join(ROOT, 'football', 'players', 'build_players.js'));

/* ------------------------------------------------------------------ args */
function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const HTML_ONLY = !!arg('html-only', false);
function log(...a) { if (!QUIET) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));
const WEEK = arg('week', null);
const SLATE_IN = arg('slate', null);
const OUT_DIR = arg('out', path.join(ROOT, 'football', 'rankings', 'press'));

const n = v => (v == null || v === '' || v === 'NA') ? null : (isFinite(+v) ? +v : null);
const isNum = x => typeof x === 'number' && isFinite(x);
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pts(v, dp) { return isNum(v) ? ((v > 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp)) : '—'; }
function num1(v) { return isNum(v) ? v.toFixed(1) : '—'; }
function pct(v) { return isNum(v) ? Math.round(v) + '%' : '—'; }

/* ------------------------------------------------------------ the rules */
/* Copied from app.html. See the header: these two functions are the reason
   the brief and the board cannot disagree. */
const GUARD_P4_GAME = 21;      /* FB_GUARD.p4.game */
const MIN_CONFIDENCE = 35;     /* EDCfbP4Params.market.min_confidence */
const MIN_RESEARCH_GAP = 2;    /* EDCfbP4Params.market.min_research_gap */
/* the rankings board's own floor, read from the shared config rather than
   restated here, so the brief cannot quote a number the engine has changed */
const RANK_MIN_CONFIDENCE = (() => {
  try { return require(path.join(RANK, 'config.js')).RANK_MIN_CONFIDENCE; }
  catch (_) { return 0.22; }
})();

function projectedScore(margin, total) {
  if (!isNum(margin) || !isNum(total)) return null;
  const home = Math.round((total + margin) / 2);
  const away = Math.round((total - margin) / 2);
  /* a split that puts a side below zero is not a score; the model's margin
     has outrun its total and the honest answer is to publish neither */
  if (home < 0 || away < 0) return null;
  return { home, away };
}

function statusFor(g) {
  if (g.data_status !== 'PREDICTED') {
    return { key: 'AWAITING', label: 'Awaiting data', tone: 'muted', glyph: '·',
      means: 'the model has not produced a projection for this game yet' };
  }
  if (!isNum(g.confidence) || g.confidence < MIN_CONFIDENCE) {
    return { key: 'THIN', label: 'Thin data', tone: 'muted', glyph: '~',
      means: 'EdgeDesk does not have enough reliable information to price this matchup confidently'
        + (isNum(g.confidence) ? ' — its own confidence is ' + Math.round(g.confidence) + '%, below the '
          + MIN_CONFIDENCE + '% floor it requires' : '')
        + '. Read the number as provisional, not as a disagreement with anyone.' };
  }
  if (!isNum(g.spread_gap)) {
    return { key: 'NO_MARKET', label: 'No market', tone: 'muted', glyph: '·',
      means: 'no market number has joined this game, so there is nothing to agree or disagree with. The projection stands on its own until a quote lands.' };
  }
  const gap = Math.abs(g.spread_gap);
  if (gap > GUARD_P4_GAME) {
    return { key: 'FAULT', label: 'Data fault', tone: 'critical', glyph: '!',
      means: 'the model and market disagree by ' + gap.toFixed(1) + ' points, past the ' + GUARD_P4_GAME
        + '-point guard bound. Treat this as a probable data fault — a bad join, a sign flip, a missing starter — not as an edge.' };
  }
  if (gap >= 7) {
    return { key: 'INVESTIGATE', label: 'Investigate', tone: 'serious', glyph: '▲',
      means: 'the model and market disagree by ' + gap.toFixed(1) + ' points. With this model’s record a gap this size is far more often missing information than a mispriced game — find out what the model has not been told.' };
  }
  if (gap >= MIN_RESEARCH_GAP) {
    return { key: 'REVIEW', label: 'Review', tone: 'warning', glyph: '◐',
      means: 'EdgeDesk differs from the market by ' + gap.toFixed(1) + ' points — enough to justify deeper research, not validated as an edge.' };
  }
  return { key: 'AGREE', label: 'In agreement', tone: 'good', glyph: '○',
    means: 'EdgeDesk and the market are effectively in agreement, ' + gap.toFixed(1)
      + ' points apart, inside the ' + MIN_RESEARCH_GAP + '-point research threshold.' };
}

/* ------------------------------------------------------------ the slate */
function loadSlate() {
  let file = SLATE_IN && SLATE_IN !== true ? SLATE_IN : null;
  let generated = false;
  if (!file) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    file = path.join(OUT_DIR, `slate_${SEASON}.csv`);
    const args = [path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'), '--season', String(SEASON)];
    if (WEEK != null && WEEK !== true) args.push('--week', String(WEEK)); else args.push('--upcoming');
    args.push('--out', file);
    log('  generating the slate: node football/cfb_p4/export_csv.js ' + args.slice(1).join(' '));
    execFileSync(process.execPath, args, { stdio: QUIET ? 'pipe' : 'inherit' });
    generated = true;
  }
  const rows = B.parseCsvObjects(fs.readFileSync(file, 'utf8'));
  const games = rows.map(r => {
    const margin = n(r.model_home_margin);
    const total = n(r.model_fair_total);
    const refLine = n(r.ref_home_line);
    /* the export writes spread_gap_pts only when a market number joined */
    const gap = n(r.spread_gap_pts);
    const g = {
      game_id: r.game_id, season: n(r.season), week: n(r.week),
      kickoff: r.kickoff_local || '', venue: r.venue || '',
      home: r.home_team, away: r.away_team,
      home_conf: r.home_conference || '', away_conf: r.away_conference || '',
      neutral: String(r.neutral_site).toUpperCase() === 'TRUE',
      margin, total, home_line: n(r.model_home_line),
      win_prob: n(r.home_win_prob_pct),
      ref_line: refLine, ref_total: n(r.ref_total), ref_source: r.ref_source || '',
      spread_gap: gap, total_gap: n(r.total_gap_pts),
      confidence: n(r.confidence), volatility: n(r.volatility),
      sigma: n(r.sigma_margin), p10: n(r.p10_margin), p90: n(r.p90_margin),
      preseason_share: n(r.preseason_share_pct), games_played: n(r.games_played_min),
      injury_uncertainty: n(r.injury_uncertainty),
      qb_status: r.qb_status || '', data_status: r.data_status || '',
      drivers: [r.primary_driver_1, r.primary_driver_2, r.primary_driver_3].filter(Boolean),
      counter: r.counterargument_1 || '',
      unavailable: (r.unavailable_inputs || '').split(';').map(s => s.trim()).filter(Boolean),
      notes: (r.data_quality_notes || '').split(';').map(s => s.trim()).filter(Boolean),
      model_version: r.model_version, ratings_basis: r.ratings_basis
    };
    g.score = projectedScore(margin, total);
    g.status = statusFor(g);
    return g;
  });
  games.sort((a, b) => {
    const da = kickoffDate(a), db = kickoffDate(b);
    if (da && db && +da !== +db) return da - db;
    return String(a.home).localeCompare(String(b.home));
  });
  return { games, file, generated, has_market: games.some(g => isNum(g.ref_line)) };
}

/* --------------------------------------------------------- the rankings */
const CATEGORIES = [
  ['overall', 'Overall (ETSR)', 'points vs an average FBS team'],
  ['talent', 'Talent', 'how much football ability is on the roster'],
  ['performance', 'Performance', 'how well it has actually played, opponent-adjusted'],
  ['offense', 'Offense', 'opponent-adjusted offensive efficiency'],
  ['defense', 'Defense', 'opponent-adjusted defensive efficiency'],
  ['special_teams', 'Special teams', 'kicking, punting, returns and coverage'],
  ['run_offense', 'Run offense', 'the run game on its own'],
  ['pass_offense', 'Pass offense', 'the pass game, sacks charged to it'],
  ['run_defense', 'Run defense', 'the run-defence power score'],
  ['pass_defense', 'Pass defense', 'the pass defence on its own'],
  ['qb', 'QB room', 'quarterback room, from the player layer'],
  ['ol', 'OL', 'offensive line'],
  ['wr', 'WR / TE', 'receivers and tight ends'],
  ['rb', 'RB', 'running backs'],
  ['dl', 'DL', 'defensive line'],
  ['lb', 'LB', 'linebackers'],
  ['secondary', 'Secondary', 'defensive backs'],
  ['depth', 'Depth', 'what happens when somebody goes down'],
  ['continuity', 'Continuity', 'returning production, QB and line continuity']
];

function catValue(t, id) {
  const r = t.ranks && t.ranks[id];
  return r ? { value: r.value, rank: r.unranked ? null : r.rank, unranked: !!r.unranked } : null;
}
function movementFor(t, id) {
  const m = t.movement;
  if (!m || !m.available) return null;
  if (id === 'overall') return m.rank ? m.rank.delta : null;
  const c = m.categories && m.categories[id];
  return c && c.rank ? c.rank.delta : null;
}

function loadRankings() {
  const cur = readJson(path.join(RANK, 'current.json'), null);
  if (!cur) return null;
  const health = readJson(path.join(RANK, 'health.json'), null);
  const hist = readJson(path.join(RANK, 'history.json'), null);
  const teams = Object.keys(cur.teams).map(k => cur.teams[k]);
  const byCategory = {};
  for (const [id] of CATEGORIES) {
    byCategory[id] = teams
      .map(t => ({ t, c: catValue(t, id) }))
      .filter(x => x.c && isNum(x.c.value) && x.c.rank != null)
      .sort((a, b) => a.c.rank - b.c.rank);
  }
  return { cur, health, hist, teams, byCategory };
}

/* ------------------------------------------------------------- the page */
const CSS = `
:root{
  --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#8a8880; --rule:#d8d6d0; --rule-2:#ebe9e4;
  --accent:#2a78d6; --paper:#fff; --wash:#f6f5f2;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
}
@page{ size:Letter; margin:13mm 11mm 14mm; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; background:var(--paper); color:var(--ink);
  font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:9pt; line-height:1.35;
  -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.mono{ font-family:"SF Mono",Menlo,Consolas,"Liberation Mono",monospace; font-variant-numeric:tabular-nums; }
h1,h2,h3,h4{ margin:0; font-weight:700; letter-spacing:-0.01em; }
.page{ page-break-after:always; }
.page:last-child{ page-break-after:auto; }
.avoid{ page-break-inside:avoid; break-inside:avoid; }

/* ---- masthead ---- */
.mast{ border-bottom:2.5pt solid var(--ink); padding-bottom:6pt; margin-bottom:10pt; }
.mast .kicker{ font-size:7.5pt; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-2); }
.mast h1{ font-size:26pt; line-height:1.02; margin:3pt 0 4pt; }
.mast .sub{ font-size:9.5pt; color:var(--ink-2); }
.mast .meta{ margin-top:5pt; font-size:7.5pt; color:var(--ink-3); }

/* ---- section headers ---- */
.sec{ border-bottom:1pt solid var(--ink); padding-bottom:3pt; margin:0 0 7pt; }
.sec h2{ font-size:12.5pt; display:inline; margin-right:7pt; }
.sec .note{ font-size:8pt; color:var(--ink-2); font-weight:400; }
.runhead{ display:flex; justify-content:space-between; font-size:7pt; letter-spacing:.12em;
  text-transform:uppercase; color:var(--ink-3); border-bottom:.5pt solid var(--rule);
  padding-bottom:3pt; margin-bottom:8pt; }

/* ---- the honesty band ---- */
.band{ border:1pt solid var(--ink); padding:7pt 9pt; margin-bottom:9pt; background:var(--wash); }
/* only the LEAD b is a block — an inline <b> inside the prose must stay inline */
.band > b:first-child{ display:block; font-size:9.5pt; margin-bottom:2pt; }
.band p{ margin:0; font-size:8pt; color:var(--ink-2); }

/* ---- KPI row ---- */
.kpis{ display:grid; grid-template-columns:repeat(5,1fr); gap:0; border:1pt solid var(--rule);
  margin-bottom:10pt; }
.kpi{ padding:6pt 8pt; border-right:1pt solid var(--rule); }
.kpi:last-child{ border-right:0; }
.kpi .n{ font-size:19pt; font-weight:700; line-height:1; letter-spacing:-.02em; }
.kpi .l{ font-size:7pt; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-3); margin-top:3pt; }
.kpi .s{ font-size:7.2pt; color:var(--ink-2); margin-top:2pt; }

/* ---- tables ---- */
table{ width:100%; border-collapse:collapse; table-layout:auto; }
/* Letter minus 11mm margins leaves ~550pt of printable width. These add up to
   it on purpose: a fixed layout whose columns overflow their share is what put
   the kickoff on top of the team name on the first proof. */
.slate{ table-layout:fixed; }
.slate th,.slate td{ overflow-wrap:normal; }
.slate .c-kick{ width:56pt; } .slate .c-game{ width:auto; }
.slate .c-score{ width:96pt; } .slate .c-line{ width:68pt; }
.slate .c-tot{ width:26pt; } .slate .c-win{ width:26pt; }
.slate .c-mkt{ width:28pt; } .slate .c-gap{ width:24pt; }
.slate .c-conf{ width:50pt; } .slate .c-stat{ width:66pt; }
.slate td{ padding:2.5pt 3pt; }
.kick{ font-size:7pt; line-height:1.15; }
.kick i{ font-style:normal; display:block; color:var(--ink-3); }
.nowrap{ white-space:nowrap; }
th{ font-size:6.8pt; text-transform:uppercase; letter-spacing:.09em; color:var(--ink-3);
  text-align:left; padding:3pt 4pt; border-bottom:1pt solid var(--ink); font-weight:600; }
td{ padding:3pt 4pt; border-bottom:.5pt solid var(--rule-2); font-size:8.2pt; vertical-align:top; }
tr:nth-child(even) td{ background:#faf9f7; }
td.num,th.num{ text-align:right; font-variant-numeric:tabular-nums; }
td.rk{ color:var(--ink-3); width:22pt; }
.miss{ color:var(--ink-3); }

/* ---- status chip: colour is never alone — glyph + word carry it ---- */
.chip{ display:inline-block; font-size:6.8pt; font-weight:700; text-transform:uppercase;
  letter-spacing:.07em; padding:1.5pt 4pt 1.5pt 3pt; border:.75pt solid currentColor;
  border-left-width:3pt; white-space:nowrap; }
.t-good{ color:var(--good); } .t-warning{ color:#a06b00; }
.t-serious{ color:#b4501f; } .t-critical{ color:var(--critical); } .t-muted{ color:var(--ink-3); }

/* ---- confidence meter ---- */
.meter{ display:inline-block; width:34pt; height:5pt; background:var(--rule-2);
  vertical-align:middle; margin-right:4pt; }
.meter i{ display:block; height:100%; background:var(--accent); }
.meter.lo i{ background:var(--ink-3); }

/* ---- game cards ---- */
.cards{ display:grid; grid-template-columns:1fr 1fr; gap:7pt; }
.card{ border:.75pt solid var(--rule); padding:7pt 8pt; }
.card .top{ display:flex; justify-content:space-between; align-items:flex-start; gap:6pt;
  border-bottom:.5pt solid var(--rule-2); padding-bottom:4pt; margin-bottom:5pt; }
.card .match{ font-size:10.5pt; font-weight:700; line-height:1.15; }
.card .when{ font-size:7pt; color:var(--ink-3); margin-top:1.5pt; }
.score{ display:flex; gap:10pt; align-items:flex-end; margin:4pt 0 5pt; }
.score .s{ display:flex; flex-direction:column; }
.score .s i{ font-style:normal; font-size:7pt; color:var(--ink-3); text-transform:uppercase; letter-spacing:.08em; }
.score .s b{ font-size:20pt; line-height:1; letter-spacing:-.02em; }
.score .none{ font-size:8pt; color:var(--ink-3); font-style:italic; }
.kv{ display:grid; grid-template-columns:auto 1fr; gap:1pt 6pt; font-size:7.6pt; margin-bottom:4pt; }
.kv dt{ color:var(--ink-3); }
.kv dd{ margin:0; }
.why{ font-size:7.4pt; color:var(--ink-2); border-top:.5pt solid var(--rule-2); padding-top:4pt; }
.why b{ color:var(--ink); }
.why ul{ margin:2pt 0 0; padding-left:10pt; }
.why li{ margin-bottom:1.5pt; }
.unk{ font-size:7pt; color:var(--ink-3); margin-top:3pt; }

/* ---- category leader grid ---- */
.leaders{ display:grid; grid-template-columns:repeat(3,1fr); gap:8pt 10pt; }
.lead h4{ font-size:8.5pt; border-bottom:.75pt solid var(--ink); padding-bottom:2pt; margin-bottom:3pt; }
.lead .d{ font-size:6.8pt; color:var(--ink-3); margin:-2pt 0 3pt; }
.lead ol{ margin:0; padding:0; list-style:none; }
.lead li{ display:flex; justify-content:space-between; gap:4pt; font-size:7.8pt;
  padding:1pt 0; border-bottom:.5pt solid var(--rule-2); }
.lead li span:first-child{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lead li b{ font-weight:600; font-variant-numeric:tabular-nums; }

/* ---- three-up full table ---- */
.tri{ display:grid; grid-template-columns:repeat(3,1fr); gap:0 9pt; }

/* ---- tail note ----
   There is deliberately no fixed-position running footer. Chromium repeats a
   fixed element on every printed page but lays it out against the FIRST page's
   box, so it lands on top of the content on every page after it. The identity
   line lives in the per-section runhead instead, where it cannot collide. */
.tail{ font-size:7.4pt; color:var(--ink-2); border-top:1pt solid var(--ink); margin-top:9pt; padding-top:6pt; }
`;

function chip(st) {
  return `<span class="chip t-${st.tone}">${esc(st.glyph)} ${esc(st.label)}</span>`;
}
function meter(v) {
  if (!isNum(v)) return '<span class="miss">—</span>';
  const w = Math.max(2, Math.min(100, v));
  return `<span class="meter${v < MIN_CONFIDENCE ? ' lo' : ''}"><i style="width:${w}%"></i></span>`
    + `<span class="mono">${Math.round(v)}%</span>`;
}
function teamLine(g) {
  return esc(g.away) + (g.neutral ? ' vs ' : ' @ ') + esc(g.home);
}
/* The export writes kickoff in UTC (`kickoff_tz`). A college-football desk
   reads Eastern, so the brief converts and LABELS the zone rather than
   printing a UTC time that looks like a local one — the difference is a day
   boundary on every night game. */
/* THE PRINTED BRIEF HAS NO VIEWER, so it cannot do what the website does and
   render in the reader's own zone. It states one zone and labels it. Eastern is
   the convention for a national college-football listing; --tz takes any IANA
   zone for a desk that runs on another one. */
const TZ = (() => { const v = arg('tz', null); return (v && v !== true) ? v : 'America/New_York'; })();
const TZ_LABEL = (() => {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
      .formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    return p ? p.value : TZ;
  } catch (_) { return TZ; }
})();
function kickoffDate(g) {
  const s = String(g.kickoff || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
function kickoffParts(g) {
  const d = kickoffDate(g);
  if (!d) return { date: String(g.kickoff || '—'), time: '' };
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    const parts = {};
    for (const p of f.formatToParts(d)) parts[p.type] = p.value;
    return { date: `${parts.weekday} ${parts.month} ${parts.day}`,
      time: `${parts.hour}:${parts.minute}${(parts.dayPeriod || '').toLowerCase()}` };
  } catch (_) {
    return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) + ' UTC' };
  }
}
function kickoff(g) {
  const k = kickoffParts(g);
  return k.time ? `${k.date} · ${k.time}` : k.date;
}

/* ------------------------------------------------------------------ build */
function buildHtml(slate, R) {
  const { games } = slate;
  const cur = R ? R.cur : null;
  const health = R ? R.health : null;
  const built = health && health.last_rankings_build ? String(health.last_rankings_build).slice(0, 16).replace('T', ' ')
    : (cur ? String(cur.generated_at).slice(0, 16).replace('T', ' ') : '—');
  const wk = games.length ? games[0].week : (cur ? cur.week : '—');
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const withScore = games.filter(g => g.score).length;
  const flagged = games.filter(g => ['INVESTIGATE', 'FAULT'].indexOf(g.status.key) >= 0);
  const thin = games.filter(g => g.status.key === 'THIN');
  const H = [];

  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>EdgeDesk press brief — ${SEASON} week ${wk}</title><style>${CSS}</style></head><body>`);

  /* ===================== PAGE 1 — the newsroom summary ===================== */
  H.push(`<section class="page">
  <div class="mast">
    <div class="kicker">EdgeDesk Research · College Football · Experimental</div>
    <h1>Week ${wk} research brief</h1>
    <div class="sub">Model projections, national ratings, and what the model could not see.</div>
    <div class="meta">${SEASON} season · ${games.length} games on the board · ratings built ${esc(built)} UTC · generated ${esc(generatedAt)} UTC</div>
  </div>

  <div class="band">
    <b>Research, not picks.</b>
    <p>Every number here is a model output with its own uncertainty attached, published so a
    reader can argue with it. EdgeDesk's college model is <b>UNPROVEN</b>: on a held-out
    2022–2025 walk-forward it does <b>not</b> beat the closing line (spread MAE 12.77 vs the
    market's 12.02). Nothing in this document is advice, a tip or a prediction anyone should
    act on financially. Where the model and a market number disagree by a lot, the likelier
    explanation is that the model is missing information — an injury, a starter, a suspension —
    not that the market is wrong.</p>
  </div>`);

  H.push(`<div class="kpis">
    <div class="kpi"><div class="n">${games.length}</div><div class="l">Games</div><div class="s">on the board this week</div></div>
    <div class="kpi"><div class="n">${withScore}</div><div class="l">Score projections</div><div class="s">${games.length - withScore} have no published total</div></div>
    <div class="kpi"><div class="n">${cur ? cur.team_count : '—'}</div><div class="l">FBS teams rated</div><div class="s">${health ? health.ratings.special_teams : '—'} with a special-teams rating</div></div>
    <div class="kpi"><div class="n">${flagged.length}</div><div class="l">Flagged</div><div class="s">model–market gap worth chasing</div></div>
    <div class="kpi"><div class="n">${thin.length}</div><div class="l">Thin data</div><div class="s">below the ${MIN_CONFIDENCE}% confidence floor</div></div>
  </div>`);

  /* what to write about */
  H.push(`<div class="sec"><h2>What to write about</h2><span class="note">selected by the size of the disagreement and the thinness of the evidence — no editorial judgement is applied</span></div>`);
  /* `t` is HTML: team names arrive already escaped from teamLine(), and every
     other interpolation below is either a number or escaped at the call site.
     Escaping the whole string again is what turned "Florida A&M" into
     "Florida A&amp;M" on the first proof. */
  const leads = [];
  const byGap = games.filter(g => isNum(g.spread_gap)).sort((a, b) => Math.abs(b.spread_gap) - Math.abs(a.spread_gap));
  if (byGap.length) {
    const g = byGap[0];
    leads.push({ h: 'Widest disagreement with the market', g,
      t: `EdgeDesk and the market are ${Math.abs(g.spread_gap).toFixed(1)} points apart on ${teamLine(g)}. ${esc(g.status.means)}` });
  }
  const byConf = games.filter(g => isNum(g.confidence)).sort((a, b) => a.confidence - b.confidence);
  if (byConf.length) {
    const g = byConf[0];
    leads.push({ h: 'The number the model trusts least', g,
      t: `${teamLine(g)} carries ${pct(g.confidence)} confidence${isNum(g.preseason_share) ? `, and ${g.preseason_share}% of the rating behind it is still last season carried forward` : ''}. ${esc(g.status.means)}` });
  }
  const byVol = games.filter(g => isNum(g.sigma)).sort((a, b) => b.sigma - a.sigma);
  if (byVol.length) {
    const g = byVol[0];
    leads.push({ h: 'The widest range of outcomes', g,
      t: `${teamLine(g)} has the widest projected outcome range on the board — one standard deviation is ${num1(g.sigma)} points, with a 10th-to-90th percentile margin of ${pts(g.p10)} to ${pts(g.p90)}. A single projected number hides how open this game is.` });
  }
  if (R) {
    /* THE SELECTION RULE IS STATED, not applied silently: the biggest move
       among teams the board actually ranks inside its top 40. Without the
       bound the "biggest mover" is always a low-confidence team crossing the
       ranking floor for the first time, which is an artifact of the floor
       rather than a story about football. */
    const MOVER_RANK_BOUND = 40;
    const movers = R.teams.filter(t => t.movement && t.movement.available && t.movement.rank
        && isNum(t.movement.rank.delta) && t.movement.rank.delta !== 0
        && isNum(t.rank) && t.rank <= MOVER_RANK_BOUND)
      .sort((a, b) => Math.abs(b.movement.rank.delta) - Math.abs(a.movement.rank.delta));
    if (movers.length) {
      const t = movers[0];
      const d = t.movement.rank.delta;
      leads.push({ h: `Biggest move inside the top ${MOVER_RANK_BOUND}`, g: null,
        t: `${esc(t.team)} moved ${Math.abs(d)} place${Math.abs(d) === 1 ? '' : 's'} ${d > 0 ? 'up' : 'down'} to #${t.rank} on ETSR (${pts(t.etsr)} against an average FBS team), against ${esc(t.movement.compared_against ? t.movement.compared_against.week_label : 'the previous board')}.` });
    }
  }
  H.push('<table><tbody>');
  for (const l of leads) {
    H.push(`<tr class="avoid"><td style="width:118pt"><b>${esc(l.h)}</b>${l.g ? `<div class="when" style="margin-top:2pt">${esc(kickoff(l.g))} ${esc(TZ_LABEL)}</div>` : ''}</td>
      <td>${l.t}</td>
      <td class="num nowrap" style="width:70pt">${l.g ? chip(l.g.status) : ''}</td></tr>`);
  }
  H.push('</tbody></table>');

  /* how to read it */
  H.push(`<div class="sec" style="margin-top:11pt"><h2>How to read a status</h2><span class="note">operational reads on the evidence, never a recommendation</span></div>
  <table><thead><tr><th style="width:78pt">Status</th><th>What it means for a story</th></tr></thead><tbody>
  <tr><td>${chip({ tone: 'good', glyph: '○', label: 'In agreement' })}</td><td>Model and market are within ${MIN_RESEARCH_GAP} points. There is no disagreement here to write about.</td></tr>
  <tr><td>${chip({ tone: 'warning', glyph: '◐', label: 'Review' })}</td><td>They differ by ${MIN_RESEARCH_GAP}+ points — enough to look at, not validated as anything.</td></tr>
  <tr><td>${chip({ tone: 'serious', glyph: '▲', label: 'Investigate' })}</td><td>They differ by 7+ points. <b>Worth reporting out:</b> find what the model has not been told.</td></tr>
  <tr><td>${chip({ tone: 'critical', glyph: '!', label: 'Data fault' })}</td><td>Past the ${GUARD_P4_GAME}-point guard bound. Treated as a probable data error, never as an edge.</td></tr>
  <tr><td>${chip({ tone: 'muted', glyph: '~', label: 'Thin data' })}</td><td>Confidence below the ${MIN_CONFIDENCE}% floor. The model says it does not know enough — quote the uncertainty, not the number.</td></tr>
  <tr><td>${chip({ tone: 'muted', glyph: '·', label: 'No market' })}</td><td>No book number joined this game, so there is nothing to compare the projection with.</td></tr>
  </tbody></table>`);

  if (!slate.has_market) {
    H.push(`<div class="band" style="margin-top:10pt"><b>No market numbers in this run.</b>
    <p>The public closing-line archive carries no ${SEASON} rows yet, so a headless build has the
    model's own numbers and nothing to compare them against — every game reads
    <b>no market</b> or <b>thin data</b>. To print the brief with the market column and the
    disagreement flags, download <b>CSV (raw)</b> from the Football board (its quotes are
    captured live) and pass it: <span class="mono">--slate that-file.csv</span>.</p></div>`);
  }
  H.push('</section>');

  /* ===================== THE SLATE TABLE ===================== */
  /* two columns of em-dashes is not information: when nothing joined a market
     number, the market and gap columns are dropped and the reason is stated */
  const mkt = slate.has_market;
  H.push(`<section class="page">
  <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>The slate at a glance</span></div>
  <div class="sec"><h2>Every game, projected</h2><span class="note">${games.length} games · projected score is split from the model's own spread and total, and is omitted where it published no total${mkt ? '' : ' · no market number joined any game in this run, so the market and gap columns are not printed'}</span></div>
  <table class="slate"><thead><tr>
    <th class="c-kick">${esc(TZ_LABEL)}</th><th class="c-game">Game</th>
    <th class="c-score">Projected score</th><th class="c-line num">Model line</th>
    <th class="c-tot num">Tot</th><th class="c-win num">Win</th>
    ${mkt ? '<th class="c-mkt num">Mkt</th><th class="c-gap num">Gap</th>' : ''}
    <th class="c-conf num">Conf</th><th class="c-stat">Status</th></tr></thead><tbody>`);
  for (const g of games) {
    /* the score reads in the SAME order as the game name — away first — so a
       writer never has to work out which number belongs to which team */
    const sc = g.score
      ? `${esc(g.away)} <b>${g.score.away}</b> – <b>${g.score.home}</b> ${esc(g.home)}`
      : '<span class="miss">no total published</span>';
    const k = kickoffParts(g);
    H.push(`<tr class="avoid">
      <td class="kick mono">${esc(k.date)}<i>${esc(k.time)}</i></td>
      <td style="font-size:7.9pt"><b>${teamLine(g)}</b></td>
      <td style="font-size:7.6pt">${sc}</td>
      <td class="num mono" style="font-size:7.4pt">${isNum(g.home_line) ? esc(g.home) + ' ' + pts(g.home_line) : '<span class="miss">—</span>'}</td>
      <td class="num mono nowrap">${num1(g.total)}</td>
      <td class="num mono nowrap">${isNum(g.win_prob) ? Math.round(g.win_prob) + '%' : '—'}</td>
      ${mkt ? `<td class="num mono nowrap">${isNum(g.ref_line) ? pts(g.ref_line) : '<span class="miss">—</span>'}</td>
      <td class="num mono nowrap">${isNum(g.spread_gap) ? Math.abs(g.spread_gap).toFixed(1) : '<span class="miss">—</span>'}</td>` : ''}
      <td class="num nowrap">${meter(g.confidence)}</td>
      <td class="nowrap">${chip(g.status)}</td></tr>`);
  }
  H.push(`</tbody></table>
  <div class="tail">All kickoff times are ${esc(TZ_LABEL)} (${esc(TZ)}); the feed publishes them in UTC and this brief converts once, here.
  Win % is the model's own probability that the home team wins outright, before any market number.
  A projected score is the model's fair total split by its fair spread and rounded — it is the centre of a wide
  distribution, not a forecast of a scoreboard. Confidence is the model's own read of how much of its input
  contract reached it; below ${MIN_CONFIDENCE}% it refuses to grade the game at all.</div>
  </section>`);

  /* ===================== GAME CARDS ===================== */
  /* ONE section, and the cards paginate themselves. Chunking into fixed-size
     pages guessed at a card height that varies with how many drivers and
     unknowns each game has, and left a third of every page blank. */
  {
    const chunk = games;
    H.push(`<section class="page">
      <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>Game notes · all ${games.length} games</span></div>
      <div class="cards">`);
    for (const g of chunk) {
      H.push(`<div class="card avoid">
        <div class="top">
          <div><div class="match">${teamLine(g)}</div>
            <div class="when">${esc(kickoff(g))} ${esc(TZ_LABEL)} · ${esc(g.venue || 'venue not published')}${g.neutral ? ' · neutral site' : ''}</div>
            <div class="when">${esc(g.away_conf || '—')} at ${esc(g.home_conf || '—')}</div></div>
          <div>${chip(g.status)}</div>
        </div>
        <div class="score">`);
      if (g.score) {
        H.push(`<div class="s"><i>${esc(g.home)}</i><b>${g.score.home}</b></div>
                <div class="s"><i>${esc(g.away)}</i><b>${g.score.away}</b></div>`);
      } else {
        H.push(`<div class="none">No projected score — the model published no total for this game, and a score line cannot be split without one.</div>`);
      }
      H.push(`</div>
        <dl class="kv">
          <dt>Model line</dt><dd class="mono">${isNum(g.home_line) ? esc(g.home) + ' ' + pts(g.home_line) : '—'}${isNum(g.total) ? ` · total ${num1(g.total)}` : ''}</dd>
          <dt>Market</dt><dd class="mono">${isNum(g.ref_line) ? pts(g.ref_line) + (isNum(g.spread_gap) ? ` · ${Math.abs(g.spread_gap).toFixed(1)} pts apart` : '') : '<span class="miss">none joined</span>'}</dd>
          <dt>Win probability</dt><dd class="mono">${isNum(g.win_prob) ? `${esc(g.home)} ${Math.round(g.win_prob)}% · ${esc(g.away)} ${100 - Math.round(g.win_prob)}%` : '—'}</dd>
          <dt>Outcome range</dt><dd class="mono">${isNum(g.p10) && isNum(g.p90) ? `${pts(g.p10)} to ${pts(g.p90)} · σ ${num1(g.sigma)}` : '—'}</dd>
          <dt>Confidence</dt><dd>${meter(g.confidence)}${isNum(g.preseason_share) ? ` <span class="miss">· ${g.preseason_share}% still preseason belief</span>` : ''}</dd>
        </dl>
        <div class="why"><b>Why the model prices it here.</b><ul>`);
      for (const d of g.drivers.slice(0, 2)) H.push(`<li>${esc(d)}</li>`);
      if (!g.drivers.length) H.push('<li class="miss">no driver breakdown published for this game</li>');
      H.push(`</ul></div>`);
      if (g.counter) H.push(`<div class="why" style="border-top:0;padding-top:3pt"><b>Why it could be wrong.</b> ${esc(g.counter)}</div>`);
      H.push(`<div class="unk"><b>Not measured at all:</b> ${g.unavailable.length ? esc(g.unavailable.slice(0, 4).join('; ')) : 'nothing declared missing'}.
        ${g.qb_status ? esc(g.qb_status) + '.' : ''} These are unknown, which is not the same as absent — none is scored zero.</div>
      </div>`);
    }
    H.push('</div></section>');
  }

  /* ===================== RANKINGS ===================== */
  if (R) {
    const top = R.byCategory.overall.slice(0, 25);
    H.push(`<section class="page">
      <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>National ratings</span></div>
      <div class="sec"><h2>EdgeDesk Team Strength Rating — top 25</h2><span class="note">points against an average FBS team on a neutral field · ${esc(cur.week_label)} · built ${esc(built)} UTC</span></div>
      <table><thead><tr><th class="num">#</th><th>Team</th><th>Conference</th><th class="num">ETSR</th><th class="num">Δ wk</th>
      <th class="num">Talent</th><th class="num">Offense</th><th class="num">Defense</th><th class="num">Special teams</th><th class="num">Confidence</th></tr></thead><tbody>`);
    for (const { t, c } of top) {
      const d = movementFor(t, 'overall');
      H.push(`<tr class="avoid"><td class="num mono">${c.rank}</td><td><b>${esc(t.team)}</b></td>
        <td class="miss">${esc(t.conference || '—')}</td>
        <td class="num mono"><b>${pts(t.etsr)}</b></td>
        <td class="num mono">${isNum(d) && d !== 0 ? (d > 0 ? '▲ ' + d : '▼ ' + Math.abs(d)) : '<span class="miss">—</span>'}</td>
        <td class="num mono">${num1(t.talent.rating)}</td>
        <td class="num mono">${num1(t.performance.offense)}</td>
        <td class="num mono">${num1(t.performance.defense)}</td>
        <td class="num mono">${t.special_teams && isNum(t.special_teams.rating) ? num1(t.special_teams.rating) : '<span class="miss">—</span>'}</td>
        <td class="num mono">${pct(t.confidence.value * 100)}</td></tr>`);
    }
    H.push(`</tbody></table>
    <div class="tail">ETSR is a neutral-field number: home field, travel, rest, injuries and the scheme matchup are
    <b>not</b> in it — the matchup layer applies those to make a game line. Talent and performance are rated and
    ranked separately on purpose, and the gap between them is one of the more useful things on this board.
    Unit ratings are on a 0–100 scale where 50 is replacement level and 12 points is one standard deviation.
    A team below the ${Math.round(RANK_MIN_CONFIDENCE * 100)}% confidence floor keeps its rating and loses its rank rather than being ranked last.</div>
    </section>`);

    /* category leaders */
    H.push(`<section class="page">
      <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>National ratings by category</span></div>
      <div class="sec"><h2>Who leads what</h2><span class="note">top five in every ranked category · a team absent from a list has no rating in it, and the reason is on the last page</span></div>
      <div class="leaders">`);
    for (const [id, label, desc] of CATEGORIES) {
      const list = R.byCategory[id].slice(0, 5);
      H.push(`<div class="lead avoid"><h4>${esc(label)}</h4><div class="d">${esc(desc)}</div><ol>`);
      if (!list.length) H.push('<li><span class="miss">no team holds a rating in this category yet</span></li>');
      for (const { t, c } of list) {
        H.push(`<li><span>${c.rank}. ${esc(t.team)}</span><b>${id === 'overall' ? pts(c.value) : num1(c.value)}</b></li>`);
      }
      H.push('</ol></div>');
    }
    H.push(`</div>
    <div class="tail">Every category is ranked from the same committed dataset the website reads — nothing on this
    page was computed for the brief. Special teams is a measured team unit: field goals over expectation by
    distance, net punting, kickoff coverage, returns, punts inside the 20, extra points and blocked kicks.
    It is ranked but is deliberately <b>not</b> an input to ETSR.</div>
    </section>`);

    /* full table, three-up */
    const all = R.byCategory.overall;
    const unranked = R.teams.filter(t => !(t.ranks && t.ranks.overall && t.ranks.overall.rank != null))
      .sort((a, b) => (b.etsr || -99) - (a.etsr || -99));
    const per = Math.ceil(all.length / 3);
    H.push(`<section class="page">
      <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>Every rated team</span></div>
      <div class="sec"><h2>All ${all.length} ranked FBS teams</h2><span class="note">ETSR · offense · defense · special teams</span></div>
      <div class="tri">`);
    for (let c = 0; c < 3; c++) {
      H.push('<table><thead><tr><th class="num">#</th><th>Team</th><th class="num">ETSR</th><th class="num">Off</th><th class="num">Def</th><th class="num">ST</th></tr></thead><tbody>');
      for (const { t, c: cv } of all.slice(c * per, (c + 1) * per)) {
        H.push(`<tr><td class="num mono rk">${cv.rank}</td><td>${esc(t.team)}</td>
          <td class="num mono">${pts(t.etsr)}</td>
          <td class="num mono">${num1(t.performance.offense)}</td>
          <td class="num mono">${num1(t.performance.defense)}</td>
          <td class="num mono">${t.special_teams && isNum(t.special_teams.rating) ? num1(t.special_teams.rating) : '<span class="miss">—</span>'}</td></tr>`);
      }
      H.push('</tbody></table>');
    }
    H.push('</div>');
    if (unranked.length) {
      H.push(`<div class="tail"><b>${unranked.length} teams are listed unranked rather than ranked last.</b>
      Each holds a rating but sits below the confidence floor, which in week ${cur.week} usually means one game
      of evidence: ${esc(unranked.slice(0, 12).map(t => t.team).join(', '))}${unranked.length > 12 ? ' and ' + (unranked.length - 12) + ' more' : ''}.</div>`);
    }
    H.push('</section>');
  }

  /* ===================== METHODOLOGY / LIMITS ===================== */
  H.push(`<section class="page">
    <div class="runhead"><span>EdgeDesk research brief · ${SEASON} week ${wk}</span><span>Methodology and limits</span></div>
    <div class="sec"><h2>What produced these numbers, and what they cannot see</h2><span class="note">the same disclosures the website carries</span></div>`);

  H.push(`<div class="band"><b>The record, stated plainly.</b>
    <p>The Power 4 game model is <b>experimental and unproven</b>. Held out on 2022–2025 it produced a spread
    mean absolute error of 12.77 points against the closing market's 12.02 — it <b>loses</b> to the closing
    line, and its best against-the-spread result at any disagreement threshold was 49.94% (n=2,599, p=0.53),
    which is a coin flip. No number in this brief is counted as validated anywhere in EdgeDesk until its own
    graded closing-line performance supports it. Model version
    ${esc(games.length ? games[0].model_version : 'edgedesk_cfb_p4_v1.0.0')}, trained through 2025.</p></div>`);

  if (health) {
    H.push(`<div class="sec" style="margin-top:10pt"><h2 style="font-size:10pt">Rating coverage</h2><span class="note">${health.season} ${esc(health.week_label)} · ${health.teams_processed} of ${health.fbs_teams_expected} FBS teams processed</span></div>
    <table><thead><tr><th>Category</th><th class="num">Teams rated</th><th class="num">Ranked</th><th class="num">Unranked (low confidence)</th><th class="num">No rating</th></tr></thead><tbody>`);
    for (const [id, label] of CATEGORIES) {
      const c = health.by_category && health.by_category[id];
      if (!c) continue;
      H.push(`<tr><td>${esc(label)}</td><td class="num mono">${c.rated}</td><td class="num mono">${c.ranked}</td>
        <td class="num mono">${c.unranked_low_confidence}</td><td class="num mono">${c.no_rating}</td></tr>`);
    }
    H.push('</tbody></table>');

    const gaps = (health.genuinely_unavailable || []);
    if (gaps.length) {
      const shown = gaps.slice(0, 10);
      H.push(`<div class="sec" style="margin-top:10pt"><h2 style="font-size:10pt">Teams with a category the data genuinely cannot fill</h2><span class="note">${gaps.length} teams · named, with the reason each was given</span></div>
      <table><thead><tr><th>Team</th><th class="num">Games played</th><th>Missing</th><th>Why</th></tr></thead><tbody>`);
      for (const g of shown) {
        H.push(`<tr class="avoid"><td><b>${esc(g.team)}</b></td><td class="num mono">${g.games_played != null ? g.games_played : '—'}</td>
          <td>${esc((g.missing || []).join(', '))}</td>
          <td style="font-size:7.4pt">${esc(String(g.reason || '').slice(0, 220))}${String(g.reason || '').length > 220 ? '…' : ''}</td></tr>`);
      }
      H.push('</tbody></table>');
      if (gaps.length > shown.length) {
        H.push(`<div class="unk">${gaps.length - shown.length} further teams carry a missing category, each with its own recorded reason in football/rankings/health.json.</div>`);
      }
    }
    const fd = health.special_teams_feed_density;
    if (fd && fd.available && fd.mean_ratio != null) {
      H.push(`<div class="unk" style="margin-top:7pt"><b>Kicking feed density.</b> This season's per-team-game
      kicking, punting and return volumes are running at ${Math.round(fd.mean_ratio * 100)}% of ${fd.reference_season}'s.
      A season in progress publishes in pieces — a game lands, then the punter's line lands — so a ratio below one
      is the feed still filling in, not football that did not happen. It moves no rating; it is why some teams have
      no special-teams number yet.</div>`);
    }
  }

  H.push(`<div class="sec" style="margin-top:10pt"><h2 style="font-size:10pt">What no public feed carries</h2><span class="note">contracted for, absent, and never estimated</span></div>
  <table><tbody>
  <tr><td style="width:120pt"><b>Starting quarterback</b></td><td>For many games the feed has not published a starter. The quarterback layer carries the last known value and declares it unknown — it never guesses, and unknown is not treated as healthy.</td></tr>
  <tr><td><b>Injuries and availability</b></td><td>No public keyless feed carries a reliable college availability report. The uncertainty layer widens the outcome range; it does not move the projection.</td></tr>
  <tr><td><b>Recruiting stars / NIL</b></td><td>No legal public recruiting feed is wired in, and no public feed carries NIL spending. Both are declared missing rather than approximated.</td></tr>
  <tr><td><b>Coaching continuity</b></td><td>No public feed carries coordinator hires, so the staff half of the continuity score stays absent.</td></tr>
  <tr><td><b>Kickoff placement, hang time, blocked punts</b></td><td>Absent from every public feed, so the special-teams rating covers what is measurable and says what it cannot see.</td></tr>
  <tr><td><b>College snap counts</b></td><td>No public feed publishes one. Player role is touch share and box-score appearances, and is labelled as such — never called a snap count.</td></tr>
  </tbody></table>

  <div class="tail">
  <b>No language model produced, ranked, adjusted or explained any rating in this document.</b> The national
  ratings are rebuilt by a deterministic job in continuous integration and committed as artifacts; the game
  projections come from a versioned engine with published parameters. Movement is differenced between weekly
  snapshots and "why" is assembled from component ranks — the arithmetic is available, so nothing is narrated.
  <br><br>
  <b>Research tool only — not betting advice. Signals can be wrong. 21+. 1-800-GAMBLER.</b>
  </div>
  </section>`);

  H.push('</body></html>');
  return H.join('\n');
}

/* ==========================================================================
   THE RANKINGS BRIEF — the publisher-facing document.

   The slate brief above answers "what happens on Saturday". This one answers
   "who is good, and why does your board disagree with the poll" — the thing an
   editor runs on a Tuesday. It mirrors the information architecture EdgeDesk
   already uses on its rankings card: the top 25, how the ranking is built, a
   spotlight on a team, the notable omissions, and what moved.

   EVERY SPOTLIGHT IS SELECTED BY A STATED RULE, not by editorial taste, and the
   rule is printed next to the section. "The first team out" is rank 26. "The
   most talent outside the top 25" is the largest (overall rank − talent rank)
   gap. "Biggest movers" are bounded to the teams the board actually ranks
   highly, because without a bound the biggest mover is always a low-confidence
   team crossing the ranking floor for the first time — an artifact of the
   floor, not a story about football.
   ========================================================================== */
function rankingsBrief(R, opts) {
  opts = opts || {};
  const cur = R.cur, health = R.health;
  /* THE WEEK ON THE MASTHEAD IS THE WEEK THIS BOARD IS FOR, not the week it was
     built from. A publisher runs "week 2 rankings" on the Tuesday before week 2,
     built on every result through week 1 — so both numbers are printed, and
     neither is left for the reader to infer. */
  const forWeek = isNum(opts.upcoming_week) ? opts.upcoming_week
    : (isNum(cur.week) ? cur.week + 1 : null);
  const rankOf = (t, id) => { const r = t.ranks && t.ranks[id]; return r && r.rank != null ? r.rank : null; };
  const ranked = R.byCategory.overall.map(x => x.t);
  const built = health && health.last_rankings_build
    ? String(health.last_rankings_build).slice(0, 16).replace('T', ' ')
    : String(cur.generated_at).slice(0, 16).replace('T', ' ');
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const unranked = R.teams.length - ranked.length;
  const top25 = ranked.slice(0, 25);
  const firstOut = ranked[25] || null;
  const MOVER_BOUND = 40;

  /* the biggest gap between the roster and the results, outside the top 25 */
  const talentGap = ranked
    .filter(t => rankOf(t, 'overall') > 25 && rankOf(t, 'talent') != null)
    .map(t => ({ t, gap: rankOf(t, 'overall') - rankOf(t, 'talent') }))
    .filter(x => x.gap > 0)
    .sort((a, b) => b.gap - a.gap);

  const movers = ranked
    .filter(t => t.movement && t.movement.available && t.movement.rank
      && isNum(t.movement.rank.delta) && t.movement.rank.delta !== 0
      && rankOf(t, 'overall') <= MOVER_BOUND)
    .sort((a, b) => b.movement.rank.delta - a.movement.rank.delta);
  const risers = movers.filter(t => t.movement.rank.delta > 0).slice(0, 5);
  const fallers = movers.filter(t => t.movement.rank.delta < 0).reverse().slice(0, 5);

  /* the spotlight: the highest-ranked team whose unit profile is most evenly
     strong — stated as the rule it is */
  function unitLine(t) {
    const picks = [['qb', 'QB'], ['ol', 'OL'], ['wr', 'WR/TE'], ['rb', 'RB'],
      ['dl', 'DL'], ['lb', 'LB'], ['secondary', 'Secondary']]
      .map(([id, lab]) => ({ lab, r: rankOf(t, id), v: (t.ranks[id] || {}).value }))
      .filter(x => x.r != null && isNum(x.v))
      .sort((a, b) => a.r - b.r).slice(0, 3);
    return picks.map(p => `${p.lab} ${num1(p.v)} (#${p.r})`).join(' · ');
  }
  const spotlight = top25[0] || null;

  const mv = t => (t.movement && t.movement.available && t.movement.rank) ? t.movement.rank.delta : null;
  function delta(d) {
    if (!isNum(d) || d === 0) return '<span class="miss">—</span>';
    return d > 0 ? `<b class="up">▲ ${d}</b>` : `<b class="dn">▼ ${Math.abs(d)}</b>`;
  }

  const H = [];
  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>EdgeDesk college football top 25 — ${cur.season}${forWeek != null ? ' week ' + forWeek : ''}</title>
<style>${CSS}
.rk-hero{ border-bottom:2.5pt solid var(--ink); padding-bottom:6pt; margin-bottom:9pt; }
.rk-hero .kicker{ font-size:7.5pt; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-2); }
.rk-hero h1{ font-size:27pt; line-height:.95; margin:2pt 0 2pt; text-transform:uppercase; letter-spacing:-.02em; }
.rk-hero .sub{ font-size:10pt; font-weight:600; color:var(--ink-2); }
.rk-hero .meta{ margin-top:4pt; font-size:7.5pt; color:var(--ink-3); }
.two{ display:grid; grid-template-columns:1.35fr 1fr; gap:12pt; align-items:start; }
.up{ color:var(--good); } .dn{ color:var(--critical); }
.how li{ margin-bottom:2.5pt; font-size:7.6pt; }
.how b{ display:block; font-size:8.2pt; }
.box{ border:1pt solid var(--ink); padding:6pt 7pt; margin-bottom:6pt; }
.box h3{ font-size:9.5pt; text-transform:uppercase; letter-spacing:.05em; margin-bottom:1pt; }
.box .rule{ font-size:6.8pt; color:var(--ink-3); text-transform:uppercase; letter-spacing:.07em; margin-bottom:4pt; }
.box ul{ margin:0; padding-left:10pt; font-size:7.6pt; }
.box li{ margin-bottom:1.5pt; }
.facts{ display:grid; grid-template-columns:repeat(3,1fr); gap:0; border:1pt solid var(--rule); }
.facts div{ padding:5pt 7pt; border-right:1pt solid var(--rule); font-size:7.4pt; color:var(--ink-2); }
.facts div:last-child{ border-right:0; }
.facts b{ display:block; font-size:13pt; color:var(--ink); }
</style></head><body>`);

  /* ---------------- page 1: the 25 and the method ---------------- */
  H.push(`<section class="page">
  <div class="rk-hero">
    <div class="kicker">EdgeDesk Research · Research not picks</div>
    <h1>College football top 25</h1>
    <div class="sub">${cur.season}${forWeek != null ? ` · Week ${forWeek} rankings` : ''} · power ratings, not polls</div>
    <div class="meta">Built on every completed result through ${esc(cur.week_label)}.
      ETSR = projected points against an average FBS team on a neutral field ·
      ${cur.team_count} FBS teams processed · built ${esc(built)} UTC · brief generated ${esc(generatedAt)} UTC</div>
  </div>
  <div class="two"><div>
  <table><thead><tr><th class="num">#</th><th>Team</th><th>Conf</th><th class="num">ETSR</th><th class="num">Δ wk</th>
    <th class="num">Off</th><th class="num">Def</th><th class="num">ST</th></tr></thead><tbody>`);
  for (const t of top25) {
    H.push(`<tr class="avoid"><td class="num mono"><b>${rankOf(t, 'overall')}</b></td>
      <td><b>${esc(t.team)}</b></td><td class="miss" style="font-size:7.4pt">${esc(t.conference || '—')}</td>
      <td class="num mono"><b>${pts(t.etsr)}</b></td>
      <td class="num mono">${delta(mv(t))}</td>
      <td class="num mono">${num1(t.performance.offense)}</td>
      <td class="num mono">${num1(t.performance.defense)}</td>
      <td class="num mono">${t.special_teams && isNum(t.special_teams.rating) ? num1(t.special_teams.rating) : '<span class="miss">—</span>'}</td></tr>`);
  }
  H.push(`</tbody></table>
  <div class="facts" style="margin-top:7pt">
    <div><b>${cur.team_count}</b>FBS teams processed every build</div>
    <div><b>${unranked}</b>unranked — a rating is kept, a rank is lost, below the ${Math.round(RANK_MIN_CONFIDENCE * 100)}% confidence floor</div>
    <div><b>0</b>votes, polls or human overrides anywhere in the number</div>
  </div>
  <div class="tail" style="margin-top:7pt">Rankings are independent of the AP and coaches polls and are not derived from them.
  Research, not picks.</div>
  </div><div>`);

  H.push(`<div class="box"><h3>How EdgeDesk ranks teams</h3>
    <ul class="how">
      <li><b>Sorted by overall ETSR.</b> Projected points against an average FBS team on a neutral field.</li>
      <li><b>Built from measured football.</b> Player quality, offense, defense, special teams, position groups, depth, continuity and opponent-adjusted performance.</li>
      <li><b>Not a poll.</b> No AP or coaches vote, no brand, no recruiting stars — no public feed carries recruiting, and the layer that would use it ships empty.</li>
      <li><b>Home field is not in the number.</b> Travel, rest, injuries and the matchup are applied by the game layer, not baked into a team rating.</li>
      <li><b>Missing data is labelled, never invented.</b> A team below the ${Math.round(RANK_MIN_CONFIDENCE * 100)}% confidence floor keeps its rating and loses its rank rather than being ranked last.</li>
    </ul></div>`);

  if (spotlight) {
    H.push(`<div class="box"><h3>Why ${esc(spotlight.team)} is #${rankOf(spotlight, 'overall')}</h3>
      <div class="rule">rule: the team the board ranks first</div>
      <ul>
        <li>ETSR ${pts(spotlight.etsr)} — ${isNum(spotlight.etsr) && isNum(top25[1] && top25[1].etsr) ? num1(spotlight.etsr - top25[1].etsr) + ' clear of #2' : 'top of the board'}.</li>
        <li>Offense ${num1(spotlight.performance.offense)}${rankOf(spotlight, 'offense') ? ` (#${rankOf(spotlight, 'offense')})` : ''}, defense ${num1(spotlight.performance.defense)}${rankOf(spotlight, 'defense') ? ` (#${rankOf(spotlight, 'defense')})` : ''}${spotlight.special_teams && isNum(spotlight.special_teams.rating) ? `, special teams ${num1(spotlight.special_teams.rating)}${rankOf(spotlight, 'special_teams') ? ` (#${rankOf(spotlight, 'special_teams')})` : ''}` : ''}.</li>
        ${unitLine(spotlight) ? `<li>Best position groups: ${unitLine(spotlight)}.</li>` : ''}
        <li>Talent ${num1(spotlight.talent.rating)}${rankOf(spotlight, 'talent') ? ` (#${rankOf(spotlight, 'talent')})` : ''} — the board rates the roster and the results separately, and both are here.</li>
        <li>Model confidence ${pct(spotlight.confidence.value * 100)}.</li>
      </ul></div>`);
  }

  if (firstOut) {
    H.push(`<div class="box"><h3>Why ${esc(firstOut.team)} is not in the top 25</h3>
      <div class="rule">rule: the team ranked 26th — the first one out</div>
      <ul>
        <li>${esc(firstOut.team)} is #${rankOf(firstOut, 'overall')} at ETSR ${pts(firstOut.etsr)} — first one out.</li>
        ${rankOf(firstOut, 'talent') ? `<li>The talent profile is strong (#${rankOf(firstOut, 'talent')} at ${num1(firstOut.talent.rating)}), but the overall rating still trails the cut-off.</li>` : ''}
        <li>EdgeDesk ranks how good a team can be shown to be right now, not where a preseason expectation put it.</li>
      </ul></div>`);
  }

  if (talentGap.length) {
    const { t, gap } = talentGap[0];
    H.push(`<div class="box"><h3>The most talent outside the top 25</h3>
      <div class="rule">rule: largest gap between talent rank and overall rank, outside the 25</div>
      <ul>
        <li>${esc(t.team)} is #${rankOf(t, 'talent')} on talent and #${rankOf(t, 'overall')} overall — a ${gap}-place gap, the widest on the board.</li>
        <li>ETSR ${pts(t.etsr)}. The roster grades out; the results have not followed it yet.</li>
        <li>Talent and performance are ranked separately on purpose. The gap between them is the interesting number, and averaging it away would hide exactly this case.</li>
      </ul></div>`);
  }
  H.push(`</div></div></section>`);

  /* ---------------- page 2: what moved and who leads what ---------------- */
  H.push(`<section class="page">
    <div class="runhead"><span>EdgeDesk college football top 25 · ${cur.season}${forWeek != null ? ' week ' + forWeek : ''}</span><span>What moved, and who leads what</span></div>
    <div class="sec"><h2>What happened</h2><span class="note">movement against ${esc(cur.teams && top25[0] && top25[0].movement && top25[0].movement.compared_against ? top25[0].movement.compared_against.week_label : 'the previous board')}, among teams ranked inside the top ${MOVER_BOUND}</span></div>
    <div class="two" style="grid-template-columns:1fr 1fr">
      <div><h4 style="font-size:9pt;margin-bottom:3pt">Risers</h4><table><tbody>`);
  if (!risers.length) H.push('<tr><td class="miss">nothing inside the top ' + MOVER_BOUND + ' moved up</td></tr>');
  for (const t of risers) {
    H.push(`<tr><td><b>${esc(t.team)}</b> <span class="miss">${esc(t.conference || '')}</span></td>
      <td class="num mono">#${rankOf(t, 'overall')}</td><td class="num mono">${delta(mv(t))}</td>
      <td class="num mono">${pts(t.etsr)}</td></tr>`);
  }
  H.push(`</tbody></table></div>
      <div><h4 style="font-size:9pt;margin-bottom:3pt">Fallers</h4><table><tbody>`);
  if (!fallers.length) H.push('<tr><td class="miss">nothing inside the top ' + MOVER_BOUND + ' moved down</td></tr>');
  for (const t of fallers) {
    H.push(`<tr><td><b>${esc(t.team)}</b> <span class="miss">${esc(t.conference || '')}</span></td>
      <td class="num mono">#${rankOf(t, 'overall')}</td><td class="num mono">${delta(mv(t))}</td>
      <td class="num mono">${pts(t.etsr)}</td></tr>`);
  }
  H.push(`</tbody></table></div></div>
    <div class="unk" style="margin-top:5pt">Movement is differenced between two immutable weekly snapshots — no model is asked why a
    rating changed, because the answer is arithmetic. Teams outside the top ${MOVER_BOUND} are excluded here because a
    low-confidence team crossing the ranking floor for the first time produces the largest raw move on any given week,
    and that is an artifact of the floor rather than a result.</div>`);

  H.push(`<div class="sec" style="margin-top:11pt"><h2>Who leads what</h2><span class="note">top five in each category the board ranks · same committed dataset, nothing recomputed for this page</span></div>
    <div class="leaders">`);
  for (const [id, label, desc] of CATEGORIES) {
    const list = R.byCategory[id].slice(0, 5);
    H.push(`<div class="lead avoid"><h4>${esc(label)}</h4><div class="d">${esc(desc)}</div><ol>`);
    if (!list.length) H.push('<li><span class="miss">no team holds a rating in this category yet</span></li>');
    for (const { t, c } of list) {
      H.push(`<li><span>${c.rank}. ${esc(t.team)}</span><b>${id === 'overall' ? pts(c.value) : num1(c.value)}</b></li>`);
    }
    H.push('</ol></div>');
  }
  H.push(`</div>
  <div class="tail"><b>Special teams is a measured team unit here, not a depth-chart read.</b> It is built from field goals over
  expectation by distance, net punting, kickoff coverage taken from the opponent's own box line, punt and kick returns,
  punts inside the 20, extra points and blocked kicks. It is ranked, and it is deliberately not an input to ETSR.
  <br><br>
  <b>No language model produced, ranked, adjusted or explained any rating in this document.</b>
  Research tool only — not betting advice. 21+. 1-800-GAMBLER.</div>
  </section>`);

  H.push('</body></html>');
  return H.join('\n');
}

/* ------------------------------------------------------------------- pdf */
function findChrome() {
  const envBin = process.env.CHROME_BIN || process.env.CHROMIUM_BIN;
  const candidates = [envBin,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch (_) {} }
  try {
    const found = execFileSync('sh', ['-c',
      'ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1']).toString().trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) {}
  return null;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`EdgeDesk press brief — season ${SEASON}`);
  const slate = loadSlate();
  log(`  slate: ${slate.games.length} games from ${path.relative(ROOT, slate.file)}`
    + (slate.has_market ? ' (market numbers joined)' : ' (no market numbers — model only)'));
  const R = loadRankings();
  log(R ? `  rankings: ${R.cur.team_count} teams, ${R.cur.season} ${R.cur.week_label}`
        : '  rankings: football/rankings/current.json not found — the brief will carry the slate only');

  const wk = slate.games.length ? slate.games[0].week : (R ? R.cur.week : 0);
  const suffix = `${SEASON}_wk${String(wk).padStart(2, '0')}`;

  /* TWO DOCUMENTS, because they are read by two different people on two
     different days: the slate brief is what a writer covering Saturday needs,
     the rankings brief is what an editor runs on a Tuesday. */
  const docs = [{ base: `edgedesk_press_brief_${suffix}`, html: buildHtml(slate, R),
    what: 'the slate: every game, projected' }];
  if (R) {
    docs.push({ base: `edgedesk_rankings_brief_${suffix}`, html: rankingsBrief(R, { upcoming_week: wk }),
      what: 'the rankings: top 25, method, movement, category leaders' });
  } else {
    log('  no rankings artifact — the rankings brief is skipped rather than built from nothing');
  }

  const chrome = HTML_ONLY ? null : findChrome();
  if (!HTML_ONLY && !chrome) {
    console.error('  no Chrome/Chromium found — writing HTML only. Set CHROME_BIN, or open the HTML and print to PDF.');
  }
  for (const d of docs) {
    const htmlPath = path.join(OUT_DIR, d.base + '.html');
    fs.writeFileSync(htmlPath, d.html);
    log(`  ${d.what}`);
    log(`    ${path.relative(ROOT, htmlPath)}`);
    if (!chrome) continue;
    const pdfPath = path.join(OUT_DIR, d.base + '.pdf');
    execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--no-pdf-header-footer', '--print-to-pdf=' + pdfPath, htmlPath], { stdio: 'pipe' });
    log(`    ${path.relative(ROOT, pdfPath)} (${Math.round(fs.statSync(pdfPath).size / 1024)} KB)`);
  }
  return 0;
}

module.exports = { statusFor, projectedScore, CATEGORIES, buildHtml, rankingsBrief, loadSlate, loadRankings,
  GUARD_P4_GAME, MIN_CONFIDENCE, MIN_RESEARCH_GAP, kickoff };
if (require.main === module) {
  try { process.exit(main()); }
  catch (e) { console.error('PRESS BRIEF FAILED:', e && e.stack || e); process.exit(1); }
}
