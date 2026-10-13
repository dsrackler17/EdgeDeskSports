#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk soccer — openfootball season files in, a committed match table out.

     node soccer/ingest.js [--league epl|...|all] [--season 2011-2027|current|all] [--offline]

   soccer/data/<league>/<season>.csv (schema edgedesk_soccer_matches_v1):
     match_id (league:date:home:away), season, date (local match day),
     time_local (no zone in the source), home, away (normalised club keys;
     display names in teams.json), hg, ag, ht_hg, ht_ag,
     status: FINAL | SCHEDULED | RESULT_MISSING (date passed, no score in the
     source — kept and counted, never guessed),
     known_at (blank), assumed_available_at (the match day's 23:59 UTC: every
     European kick-off has ended by then), pit (RETRO)

   Club names vary across seasons ("Arsenal" / "Arsenal FC"); clubKey()
   normalises them, and the manifest lists every display name per key so a
   merge is visible.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { fetchFile } = require('../engine/lab/fetch');
const { toCsv, readCsv } = require('../engine/csv');

const COLS = ['match_id', 'season', 'date', 'time_local', 'home', 'away', 'hg', 'ag', 'ht_hg', 'ht_ag', 'status', 'known_at', 'assumed_available_at', 'pit'];
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }

const DROP = new Set(['fc', 'afc', 'cf', 'ac', 'sc', 'ssc', 'as', 'ud', 'cd', 'rcd', 'sd', 'us', 'ss', 'acf', 'ogc', 'og', 'stade', 'rc', 'losc', 'tsg', 'vfl', 'vfb', 'fsv', 'sv', 'bsc', 'sport', 'club', 'calcio', 'de', 'del', 'the', 'and', 'hotspur', 'albion', 'city', 'united', 'town', 'wanderers', 'athletic', 'balompie']);
const ALIAS = { 'manchestercity': 'mancity', 'manchesterunited': 'manutd', 'mancity': 'mancity', 'manutd': 'manutd', 'internazionale': 'inter', 'intermilano': 'inter', 'milan': 'milan', 'parissaintgermain': 'psg', 'psg': 'psg', 'bayernmunchen': 'bayern', 'fcbayernmunchen': 'bayern', 'borussiamonchengladbach': 'gladbach', 'borussiadortmund': 'dortmund', 'atleticomadrid': 'atletico', 'atleticodemadrid': 'atletico', 'clubatleticodemadrid': 'atletico',
  /* the same club under two names in different seasons (checked against the manifest's display names) */
  bormonchengladbach: 'gladbach', deportivoalaves: 'alaves', celtavigo: 'celta', rayovallecanomadrid: 'rayovallecano', realsociedadfutbol: 'realsociedad',
  atalantabc: 'atalanta', internazionalemilano: 'inter', ucsampdoria: 'sampdoria', lazioroma: 'lazio', estactroyes: 'estroyes', racinglens: 'lens', strasbourgalsace: 'strasbourg' };
/* deliberately NOT merged: Paris FC / Paris Saint-Germain, AC Ajaccio / Gazélec Ajaccio, Sheffield United / Wednesday (different clubs) */
/** a stable club key from a display name */
function clubKey(name) {
  const base = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  const full = base.replace(/\s+/g, '');
  if (ALIAS[full]) return ALIAS[full];
  /* "Manchester City" and "Manchester United" share a city: keep the distinguishing word before dropping */
  if (/^manchester (city|united)/.test(base)) return base.indexOf('city') > 0 ? 'mancity' : 'manutd';
  const toks = base.split(/\s+/).filter((t) => t && !DROP.has(t) && !/^\d+$/.test(t));
  const k = (toks.length ? toks : base.split(/\s+/)).join('');
  return ALIAS[k] || k;
}

/** football.json -> rows; pure (tested offline) */
function normalise(json, league, season, today) {
  const stats = { matches: 0, final: 0, scheduled: 0, result_missing: 0, duplicates: 0 };
  const names = {}; const byId = new Map();
  for (const m of json.matches || []) {
    stats.matches++;
    const h = clubKey(m.team1), a = clubKey(m.team2);
    (names[h] = names[h] || new Set()).add(m.team1); (names[a] = names[a] || new Set()).add(m.team2);
    const ft = m.score && !Array.isArray(m.score) && Array.isArray(m.score.ft) && m.score.ft.length === 2 ? m.score.ft : null;
    const ht = m.score && !Array.isArray(m.score) && Array.isArray(m.score.ht) && m.score.ht.length === 2 ? m.score.ht : null;
    const status = ft ? 'FINAL' : m.date < today ? 'RESULT_MISSING' : 'SCHEDULED';
    const id = league + ':' + m.date + ':' + h + ':' + a;
    if (byId.has(id)) stats.duplicates++;
    byId.set(id, { match_id: id, season, date: m.date, time_local: m.time || '', home: h, away: a, hg: ft ? ft[0] : '', ag: ft ? ft[1] : '', ht_hg: ht ? ht[0] : '', ht_ag: ht ? ht[1] : '', status, known_at: '', assumed_available_at: ft ? m.date + 'T23:59:00Z' : '', pit: 'RETRO' });
  }
  const rows = [...byId.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.match_id < y.match_id ? -1 : 1));
  for (const r of rows) stats[r.status.toLowerCase()]++;
  return { rows, stats, names: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, [...v].sort()])) };
}

async function ingest(league, season, o) {
  const src = await fetchFile(C.url(league, season), { offline: o && o.offline, ttlMs: season >= C.currentSeason() - 1 ? 6 * 3600e3 : 30 * 86400e3 });
  if (!src.ok) return { league, season, not_published: !!src.not_found, error: src.not_found ? null : src.error };
  const json = JSON.parse(fs.readFileSync(src.file, 'utf8'));
  const today = new Date((o && o.now) || Date.now()).toISOString().slice(0, 10);
  const { rows, stats, names } = normalise(json, league, season, today);
  const dir = C.PATHS.data(league); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, season + '.csv');
  const text = toCsv(COLS, rows);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old !== text) fs.writeFileSync(file, text);
  return { league, season, stats, names, changed: old !== text, source: { url: src.url, sha256: src.sha256, fetched_at: src.fetched_at } };
}

function updateManifest(league, results) {
  const p = path.join(C.PATHS.data(league), 'manifest.json');
  let man = {}; try { man = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  man.schema = 'edgedesk_soccer_matches_v1'; man.league = league; man.columns = COLS; man.license = C.LICENSE; man.seasons = man.seasons || {};
  man.temporal = { known_at: 'blank (never backdated)', assumed_available_at: 'the match day 23:59 UTC', pit: 'RETRO' };
  const teams = process.argv.includes('--keep-names') ? (man.teams || {}) : {};
  for (const r of results) {
    if (r.error || r.not_published) continue;
    man.seasons[r.season] = Object.assign({}, r.stats, { source: r.source });
    for (const [k, v] of Object.entries(r.names)) teams[k] = [...new Set((teams[k] || []).concat(v))].sort();
  }
  man.teams = Object.fromEntries(Object.keys(teams).sort().map((k) => [k, teams[k]]));
  fs.writeFileSync(p, JSON.stringify(man, null, 1) + '\n');
}

function loadMatches(league, seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(C.PATHS.data(league), s + '.csv');
    if (!fs.existsSync(f)) continue;
    for (const r of readCsv(f).rows) out.push(Object.assign(r, { season: Number(r.season), hg: r.hg === '' ? null : Number(r.hg), ag: r.ag === '' ? null : Number(r.ag) }));
  }
  return out;
}

module.exports = { clubKey, normalise, ingest, loadMatches, COLS };

if (require.main === module) {
  const lg = arg('league', 'all'); const leagues = lg === 'all' ? Object.keys(C.LEAGUES) : lg.split(',');
  const cur = C.currentSeason();
  const spec = arg('season', 'all').replace(/^current$/, String(cur)).replace(/^all$/, C.FIRST + '-' + cur);
  const seasons = spec.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  (async () => {
    for (const league of leagues) {
      const results = [];
      for (const s of seasons) {
        const r = await ingest(league, s, { offline: process.argv.includes('--offline') });
        results.push(r);
        if (r.not_published) console.log('[soccer ingest] ' + league + ' ' + s + ': not published');
        else if (r.error) { console.log('[soccer ingest] ' + league + ' ' + s + ': unavailable — ' + JSON.stringify(r.error)); process.exitCode = 1; }
        else console.log('[soccer ingest] ' + league + ' ' + s + ': ' + r.stats.final + ' final, ' + r.stats.scheduled + ' scheduled, ' + r.stats.result_missing + ' RESULT MISSING' + ', ' + Object.keys(r.names).length + ' clubs');
      }
      updateManifest(league, results);
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
