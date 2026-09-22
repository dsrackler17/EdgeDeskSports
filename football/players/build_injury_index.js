#!/usr/bin/env node
'use strict';

/* Compact browser index for joining college availability names to the same
   athlete identity/usage facts the Node matchup path reads from the per-team
   player files. This fits no coefficient and changes no model weight. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'football', 'players', 'teams');
const OUT = path.join(ROOT, 'football', 'players', 'injury_index.json');

function normName(s) {
  if (s == null) return null;
  let v = String(s).trim().toLowerCase();
  try { v = v.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return v.replace(/[^a-z0-9]+/g, '') || null;
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function build() {
  const teams = {};
  let season = null, playerCount = 0, indexed = 0, ambiguous = 0;
  if (!fs.existsSync(DIR)) throw new Error('football/players/teams is missing');

  for (const f of fs.readdirSync(DIR).filter(x => /\.json$/.test(x)).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (!d || !Array.isArray(d.players)) continue;
    if (season == null && d.season != null) season = d.season;
    const tk = String(d.key || f.replace(/\.json$/, ''));
    const names = {}, groups = {};

    for (const p of d.players) {
      if (!p || !p.n) continue;
      playerCount++;
      const nk = normName(p.n);
      if (nk) {
        if (!Object.prototype.hasOwnProperty.call(names, nk)) names[nk] = p;
        else names[nk] = null;
      }
      const g = String(p.g || p.p || '').toUpperCase();
      if (g) (groups[g] = groups[g] || []).push(p);
    }
    Object.keys(groups).forEach(g => groups[g].sort((a, b) =>
      (num(b.e) == null ? -Infinity : b.e) - (num(a.e) == null ? -Infinity : a.e)
      || (num(b.share) == null ? -1 : b.share) - (num(a.share) == null ? -1 : a.share)));

    const byName = {};
    for (const nk of Object.keys(names).sort()) {
      const p = names[nk];
      if (!p) { ambiguous++; continue; }
      const g = String(p.g || p.p || '').toUpperCase();
      let repl = null;
      for (const q of groups[g] || []) {
        if (!q || String(q.id || '') === String(p.id || '') || num(q.e) == null) continue;
        repl = q; break;
      }
      byName[nk] = {
        id: p.id == null ? null : String(p.id),
        n: p.n,
        p: p.p || null,
        g: p.g || p.p || null,
        e: num(p.e),
        cf: num(p.cf),
        role: p.role || null,
        share: num(p.share),
        replacement: repl ? {
          id: repl.id == null ? null : String(repl.id),
          n: repl.n || null,
          e: num(repl.e)
        } : null
      };
      indexed++;
    }
    teams[tk] = { team: d.team || null, generated_at: d.generated_at || null, by_name: byName };
  }

  return {
    schema: 'edgedesk_cfb_injury_identity_v1',
    season,
    generated_at: new Date().toISOString(),
    team_count: Object.keys(teams).length,
    player_rows_read: playerCount,
    unique_names_indexed: indexed,
    ambiguous_names_refused: ambiguous,
    contract: {
      priced: ['athlete identity', 'starter role', 'snap share where measured'],
      research_only: ['player rating', 'replacement player', 'replacement rating'],
      note: 'replacement quality is intentionally not mapped into the priced engine field until separately validated'
    },
    teams
  };
}

const out = build();
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('[injury-index] ' + out.team_count + ' teams · ' + out.unique_names_indexed
  + ' unique player names · ' + out.ambiguous_names_refused + ' ambiguous refused · wrote '
  + path.relative(ROOT, OUT));

module.exports = { build, normName };
