'use strict';
const R = '/home/user/EdgeDeskSports';
const fs = require('fs');
const WF = require(R + '/basketball/walkforward.js');
const V = require(R + '/engine/validation.js');
const tuning = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_tuning.json', 'utf8'));
const { games } = WF.load('wnba');
const { rows } = WF.pass(games, tuning.chosen, tuning.elo);
const { scored } = WF.score(rows);
const agg = {};
for (const r of scored) { if (r.season < 2018) continue; const b = Math.min(r.gh, r.ga) < 5 ? 'a:<5' : Math.min(r.gh, r.ga) < 15 ? 'b:5-14' : 'c:15+'; const k = (r.season === 2026 ? '2026' : '2018-25') + ' ' + b; const a = agg[k] || (agg[k] = { n: 0, ll: 0, elo: 0, ch: 0, mae: 0 }); a.n++; a.ll += V.logLoss(r.p.points, r.y.hw); a.elo += V.logLoss(r.p.elo, r.y.hw); a.ch += V.logLoss(r.p.const_home, r.y.hw); a.mae += Math.abs(r.p.margin.mu - r.y.margin); }
for (const k of Object.keys(agg).sort()) { const a = agg[k]; console.log(k.padEnd(16), 'n', String(a.n).padStart(4), 'LL points', (a.ll / a.n).toFixed(4), 'elo', (a.elo / a.n).toFixed(4), 'home-rate', (a.ch / a.n).toFixed(4), 'margin MAE', (a.mae / a.n).toFixed(2)); }
