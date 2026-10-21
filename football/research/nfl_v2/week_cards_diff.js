#!/usr/bin/env node
/* ===========================================================================
   A WEEK'S NFL CARDS, OLD AGAINST NEW — every game of the week as three
   committed slates priced it:

     old       the slate before any fix (git 72af3904, the audit's baseline)
     v1 fixed  the slate on the Step 1 correctness fixes alone (git e9fed776,
               the merged PR #634 head)
     v2        football/nfl/slate.json now (the served model)

   Per game: the home margin, win probability, 80% range, the change from
   old, the reference market and the disagreement flag; the old card's
   unattributed points (contributions that did not sum to its margin) and the
   new card's seven rows, which sum exactly (the old card's rows are read from
   the old game card itself, git <old>:football/game_research/current.json). Feed differences between the
   builds (an injury report, a starter) are part of each change and are named
   where the slate names them.

   Usage: node football/research/nfl_v2/week_cards_diff.js [--week 7] [--old 72af3904] [--mid e9fed776]
   Writes results/week<N>_cards.json and prints the table.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');

const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
const WEEK = +v('--week', '7'), OLD = v('--old', '72af3904'), MID = v('--mid', 'e9fed776');
const atRev = (rev) => JSON.parse(execFileSync('git', ['show', `${rev}:football/nfl/slate.json`], { cwd: ROOT, maxBuffer: 1 << 28 }).toString());
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const sgn = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(2));

const old = atRev(OLD), mid = atRev(MID), now = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
/* the OLD game card as the page showed it: its driver rows, signed toward the home side */
const oldCards = (() => {
  const j = JSON.parse(execFileSync('git', ['show', `${OLD}:football/game_research/current.json`], { cwd: ROOT, maxBuffer: 1 << 28 }).toString());
  const out = {};
  (j.games || []).filter((g) => g.league === 'nfl' && g.drivers && Array.isArray(g.drivers.rows)).forEach((g) => {
    out[g.game_id] = g.drivers.rows.reduce((s, r) => s + (r.favors === 'away' ? -1 : 1) * (+r.points || 0), 0);
  });
  return out;
})();
const byId = (s) => Object.fromEntries(s.games.filter((g) => g.week === WEEK).map((g) => [g.game_id, g]));
const O = byId(old), Mi = byId(mid), N = byId(now);
const pick = (g) => g ? { model_version: g.model_version, home_margin: r2(g.model_home_margin), win_prob: g.model_home_win_prob, range: g.outcome_range ? [g.outcome_range.p10, g.outcome_range.p50, g.outcome_range.p90] : null } : null;
const games = Object.keys(N).sort().map((id) => {
  const n = N[id], o = O[id], m = Mi[id];
  const ref = n.reference_market && n.reference_market.home_margin != null ? n.reference_market.home_margin : null;
  const oldSum = oldCards[id] != null ? oldCards[id] : null;
  const rows = n.card && n.card.rows ? n.card.rows.map((r) => ({ key: r.key, label: r.label, points: r2(r.points), prior: r2(r.prior), current: r2(r.current) })) : null;
  return {
    game_id: id, matchup: `${n.away_code} @ ${n.home_code}`,
    old: pick(o), v1_fixed: pick(m), v2: pick(n),
    change_from_old: o ? { home_margin: r2(n.model_home_margin - o.model_home_margin), win_prob: r2(n.model_home_win_prob - o.model_home_win_prob) } : null,
    reference_home_margin: ref, model_minus_market: ref == null ? null : r2(n.model_home_margin - ref),
    flag: ref != null && Math.abs(n.model_home_margin - ref) >= 3 ? `Model disagrees with market by ${Math.abs(n.model_home_margin - ref).toFixed(1)} pts` : null,
    old_card_unattributed: o && oldSum != null ? r2(o.model_home_margin - oldSum) : null,
    card: rows, card_sum: rows ? r2(rows.reduce((s, r) => s + r.points, 0)) : null, card_reconciles: n.card ? n.card.reconciles : null,
    starters: { home: n.home_starter && n.home_starter.player_name, away: n.away_starter && n.away_starter.player_name, home_status: n.home_starter && n.home_starter.status, away_status: n.away_starter && n.away_starter.status },
  };
});
const doc = { schema: 'edgedesk_nfl_week_cards_diff_v1', week: WEEK, generated_at: new Date().toISOString(),
  sources: { old: `git ${OLD} football/nfl/slate.json (${old.generated_at})`, v1_fixed: `git ${MID} football/nfl/slate.json (${mid.generated_at})`, v2: `football/nfl/slate.json (${now.generated_at}, ${now.served_model && now.served_model.model_version})` },
  games };
fs.writeFileSync(path.join(__dirname, 'results', `week${WEEK}_cards.json`), JSON.stringify(doc, null, 1) + '\n');
console.log('| game | old margin / win | v1 fixed | v2 (served) | change from old | market | v2 − market | new card rows sum to the margin | old card: points in no row (dropped context term) |');
console.log('|---|---|---|---|---|---|---|---|---|');
games.forEach((g) => console.log(`| ${g.matchup} | ${g.old ? sgn(g.old.home_margin) + ' / ' + (100 * g.old.win_prob).toFixed(1) + '%' : '—'} | ${g.v1_fixed ? sgn(g.v1_fixed.home_margin) + ' / ' + (100 * g.v1_fixed.win_prob).toFixed(1) + '%' : '—'} | ${sgn(g.v2.home_margin)} / ${(100 * g.v2.win_prob).toFixed(1)}% | ${g.change_from_old ? sgn(g.change_from_old.home_margin) : '—'} | ${sgn(g.reference_home_margin)} | ${sgn(g.model_minus_market)}${g.flag ? ' ⚑' : ''} | ${g.card_reconciles ? 'yes (' + sgn(g.card_sum) + ')' : 'NO'} | ${sgn(g.old_card_unattributed)} |`));
