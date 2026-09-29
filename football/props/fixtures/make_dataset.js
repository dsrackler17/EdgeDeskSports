#!/usr/bin/env node
/* Builds football/props/fixtures/dataset_nfl.json.gz — a SMALL slice of the
   real nflverse dataset (sources/nfl.js) for offline tests: every team's game
   rows (league and defence context), the Falcons', Saints' and Packers'
   skill players and kickers with their game logs, the schedule, the per-play
   shapes. Public data, cut down; test-only (see README.md). Regenerate with:
     node football/props/fixtures/make_dataset.js [--season 2026] */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const L = require('../sources/nfl.js');
const TEAMS = ['ATL', 'NO', 'GB'];
(async () => {
  const a = process.argv.slice(2), season = a.indexOf('--season') >= 0 ? Number(a[a.indexOf('--season') + 1]) : 2026;
  const ds = await L.load({ season, offline: a.indexOf('--offline') >= 0 });
  if (!ds.ok) { console.error(ds.error); process.exit(1); }
  const round = (v) => typeof v === 'number' && isFinite(v) && Math.round(v) !== v ? Math.round(v * 10000) / 10000 : v;
  const deep = (o) => Array.isArray(o) ? o.map(deep) : (o && typeof o === 'object' ? Object.keys(o).reduce((m, k) => { m[k] = deep(o[k]); return m; }, {}) : round(o));
  const players = {};
  Object.values(ds.players).forEach((p) => {
    if (TEAMS.indexOf(p.team) < 0 || ['QB', 'RB', 'WR', 'TE', 'K'].indexOf(p.pg) < 0) return;
    if (!p.logs.some((l) => l.s === season)) return;
    players[p.id] = Object.assign({}, p, { headshot: null, logs: p.logs.slice(-20) });
  });
  const teams = {}; Object.keys(ds.teams).forEach((t) => { teams[t] = ds.teams[t].slice(-20); });
  const out = deep({ ok: true, league: 'nfl', season, built_at: ds.built_at, fixture: 'test-only slice of the nflverse dataset (football/props/fixtures/README.md)',
    schedule: ds.schedule, players, teams, depth: TEAMS.reduce((m, t) => { if (ds.depth[t]) m[t] = ds.depth[t]; return m; }, {}),
    injuries: { published: true, retrieved_at: '2026-10-02T12:00:00Z', latest_week: 4, by_player: {}, teams: [] },
    slate: null, event_fits: ds.event_fits, feeds: { fixture: true }, team_names: ds.team_names });
  const file = path.join(__dirname, 'dataset_nfl.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
  console.log('wrote ' + path.relative(process.cwd(), file) + ' (' + Object.keys(players).length + ' players, ' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
})();
