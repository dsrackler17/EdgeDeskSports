#!/usr/bin/env node
/* ===========================================================================
   THE INJURY ARCHIVE — copies the official NFL injury report, every season
   nflverse carries (2009 on), into per-team-week counts by position group,
   so the pricing validation can ask what a missing tackle or a listed
   quarterback was worth against the close, and the form read can say who was
   out when a result was posted.

   Per season / week / team: out, doubtful, questionable, and the same by
   group (QB, OL, RB, WR, TE, DL, LB, DB, ST), with the names of the OL and
   QB listed Out or Doubtful. Only the final report row per player-week is
   counted (nflverse keeps one). Nothing here is a model.

   Usage
     node tools/football/build_injury_archive.js            # from the cache (fetches missing seasons)
     node tools/football/build_injury_archive.js --offline  # cache only
     node tools/football/build_injury_archive.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
const URL = (s) => 'https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_' + s + '.csv';
const FILE = (s) => path.join(CACHE, URL(s).replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const OUT = path.join(ROOT, 'football', 'pricing', 'injuries_nfl.json');
const FIRST = 2009;
const GROUP = (p) => { p = String(p || '').toUpperCase(); if (p === 'QB') return 'QB'; if (/^(T|G|C|OT|OG|OL|LT|RT|LG|RG)$/.test(p)) return 'OL'; if (/^(RB|FB|HB)$/.test(p)) return 'RB'; if (p === 'WR') return 'WR'; if (p === 'TE') return 'TE'; if (/^(DE|DT|NT|DL|EDGE)$/.test(p)) return 'DL'; if (/^(LB|ILB|MLB|OLB)$/.test(p)) return 'LB'; if (/^(CB|S|FS|SS|DB|NB)$/.test(p)) return 'DB'; if (/^(K|P|LS)$/.test(p)) return 'ST'; return 'OTHER'; };
const GROUPS = ['QB', 'OL', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'ST', 'OTHER'];

/** Build from {season: csvText}. Pure. */
function build(texts, opts) {
  opts = opts || {};
  const seasons = {}; let rows = 0;
  Object.keys(texts).sort().forEach((season) => {
    const list = R.parseCsv(texts[season], { columns: ['season', 'game_type', 'team', 'week', 'gsis_id', 'position', 'full_name', 'report_status', 'practice_status', 'date_modified'] });
    const S = (seasons[season] = { teams: {}, rows: 0 });
    list.forEach((r) => {
      const status = String(r.report_status || '').trim(); if (!status) return; /* a practice-only line with no game status is not an availability record */
      const wk = Number(r.week); if (!Number.isFinite(wk)) return;
      const T = (S.teams[r.team] = S.teams[r.team] || {});
      const W = (T[wk] = T[wk] || { out: 0, doubtful: 0, questionable: 0, groups: {}, ol_out: [], qb_out: [], as_of: null });
      const g = GROUP(r.position); const G = (W.groups[g] = W.groups[g] || { out: 0, doubtful: 0, questionable: 0 });
      const key = /^out$/i.test(status) ? 'out' : /^doubtful$/i.test(status) ? 'doubtful' : /^questionable$/i.test(status) ? 'questionable' : null;
      if (!key) return;
      W[key]++; G[key]++; S.rows++; rows++;
      if ((key === 'out' || key === 'doubtful') && g === 'OL') W.ol_out.push(r.full_name + ' (' + r.position + ', ' + status + ')');
      if ((key === 'out' || key === 'doubtful') && g === 'QB') W.qb_out.push(r.full_name + ' (' + status + ')');
      if (r.date_modified && (!W.as_of || r.date_modified > W.as_of)) W.as_of = r.date_modified;
    });
  });
  const seasonList = Object.keys(seasons).map(Number);
  return { schema: 'edgedesk_injury_archive_v1', version: 1, sport: 'americanfootball_nfl', generated_at: opts.now || new Date().toISOString(),
    source: { url_pattern: URL('<season>'), basis: 'nflverse-data injuries_<season>.csv, the official league report as published; the game-status column (Out / Doubtful / Questionable) counted once per player-week; practice-only lines are not availability records', seasons: seasonList },
    groups: GROUPS, counts: { seasons: seasonList.length, first_season: seasonList.length ? Math.min(...seasonList) : null, last_season: seasonList.length ? Math.max(...seasonList) : null, status_rows: rows },
    seasons, note: 'A copy of the report in counts. The pricing validation reads it as context for the feature intake; the analyst reads it for who was out when a result was posted. It is not a projection input.' };
}

async function ensure(offline) {
  const now = new Date().getUTCFullYear(); const texts = {};
  for (let s = FIRST; s <= now; s++) {
    let p = FILE(s);
    if (!fs.existsSync(p) && !offline) { try { const r = await fetch(URL(s), { redirect: 'follow' }); if (r.ok) { const t = await r.text(); if (t.length > 100) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(p, t); console.log('fetched injuries_' + s + '.csv'); } } } catch (e) { console.error('injuries_' + s + '.csv: ' + e.message); } }
    if (fs.existsSync(p)) texts[s] = fs.readFileSync(p, 'utf8');
  }
  return texts;
}
async function main() {
  const args = process.argv.slice(2);
  const texts = await ensure(args.includes('--offline'));
  const art = build(texts, { retrieved_at: new Date().toISOString() });
  console.log(`injury archive: seasons ${art.counts.first_season}-${art.counts.last_season} (${art.counts.seasons}), ${art.counts.status_rows} status rows`);
  if (args.includes('--check')) { if (!fs.existsSync(OUT)) { console.error('CHECK: no artifact'); process.exit(1); } const prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); const same = JSON.stringify(prev.seasons) === JSON.stringify(art.seasons); console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build'); process.exit(same ? 0 : 1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(art)); console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}
module.exports = { build, GROUP, GROUPS, OUT, FILE, URL };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(2); });
