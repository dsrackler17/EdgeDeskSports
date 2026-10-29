/* ============================================================================
   FSIE — the adapter existing models call. One function per question:

     mode(target)                       OFF | SHADOW | ACTIVE (fail-closed)
     shadowBlock(sport, target, gameId, existing)
                                        the block a consumer appends to its row,
                                        or null in OFF / when nothing is on file
     applied(block)                     the points a consumer may add: 0 unless
                                        every lock is open (never, today)

   THE CANDIDATE (what ACTIVE would do, published so a change is attributable
   before anyone allows it): the existing total's pace input replaced by the
   situational expected plays, priced at the existing model's OWN pace
   coefficient — a substitution, not an addition, so pace is not counted
   twice. NFL publishes its pace term per game (contributions.total
   pace_sum: input and points). The CFB caller passes the engine's own 'pace'
   total term. Where a consumer cannot supply its pace term, the candidate is
   null and says why — never an added-on pace effect that might double count.

   Spread and win probability are never touched: the layer has no margin model
   of its own (it reads the market's), so feeding a margin back would be
   circular.

   THREE LOCKS for anything but 0 points (football/altitude precedent):
     validated      research/promotion.json has an APPROVED study for the target
     points_applied config/integration.json says true for the target
     mode           ACTIVE for the target
   The adapter re-checks the locks itself; a caller cannot assert them.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config', 'integration.json');
const PROMOTION_FILE = path.join(DIR, 'research', 'promotion.json');
/* FSIE_SHADOW_DIR lets the parity tests stage a shadow artifact without
   touching the committed one */
const SHADOW_DIR = process.env.FSIE_SHADOW_DIR || path.join(DIR, 'data', 'shadow');
const MODES = { OFF: 1, SHADOW: 1, ACTIVE: 1 };

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }

/* an environment override exists for one purpose: proving OFF parity in tests
   and rolling back a run without a commit. It can only LOWER the mode. */
function mode(target, opts) {
  const cfg = (opts && opts.config) || readJson(CONFIG_FILE);
  const t = cfg && cfg.targets && cfg.targets[target];
  let m = t && MODES[t.mode] ? t.mode : 'OFF';
  const env = process.env.FSIE_MODE;
  if (env === 'OFF') m = 'OFF';
  else if (env === 'SHADOW' && m === 'ACTIVE') m = 'SHADOW';
  return m;
}
function locks(target, opts) {
  const cfg = (opts && opts.config) || readJson(CONFIG_FILE);
  const promo = (opts && opts.promotion !== undefined) ? opts.promotion : readJson(PROMOTION_FILE);
  const t = (cfg && cfg.targets && cfg.targets[target]) || {};
  const study = promo && promo.targets && promo.targets[target];
  return {
    validated: !!(study && study.status === 'APPROVED' && study.approved_by && study.evidence),
    points_applied: t.points_applied === true,
    mode_active: mode(target, opts) === 'ACTIVE'
  };
}

let cache = {};
function shadowFile(sport) { return path.join(process.env.FSIE_SHADOW_DIR || SHADOW_DIR, sport + '.json'); }
function load(sport, opts) {
  if (opts && opts.shadow) return opts.shadow;
  if (!cache[sport]) cache[sport] = readJson(shadowFile(sport)) || { games: {} };
  return cache[sport];
}

/* existing: { fair_total, pace: { input, points } | null } */
function shadowBlock(sport, target, gameId, existing, opts) {
  const m = mode(target, opts);
  if (m === 'OFF') return null;
  const S = load(sport, opts);
  const g = S && S.games ? S.games[String(gameId)] : null;
  if (!g) return null;
  const lk = locks(target, opts);
  const all = lk.validated && lk.points_applied && lk.mode_active;
  let candidate = null, why = null;
  const pace = existing && existing.pace;
  if (pace && isNum(pace.input) && isNum(pace.points) && Math.abs(pace.input) > 1e-9 && isNum(g.game_plays_dev)) {
    const coef = pace.points / pace.input;
    candidate = { total_points_delta: r2(coef * (g.game_plays_dev - pace.input)), coefficient: Math.round(coef * 1e5) / 1e5,
      existing_pace_input: r2(pace.input), situational_pace_input: r2(g.game_plays_dev),
      basis: 'the existing total\'s pace input replaced by the situational expected game plays (deviation from league), at the existing model\'s own pace coefficient' };
  } else why = 'the existing model\'s pace term for this game was not supplied, so no non-double-counting candidate exists';
  const applied = all && candidate ? candidate.total_points_delta : 0;
  return {
    schema: 'edgedesk_fsie_shadow_v1', mode: m, target, model_version: S.model_version || null, as_of: g.as_of || S.built_at || null,
    affects_projection: applied !== 0, applied_points: applied, locks: lk,
    situational: { home: g.home, away: g.away, game_plays: g.game_plays, game_drives: g.game_drives, script: g.script || null },
    existing: existing ? { fair_total: r2(existing.fair_total) } : null,
    candidate, candidate_note: why,
    label: m === 'ACTIVE' && !all ? 'ACTIVE REFUSED — a lock is closed; 0 points applied' : 'SHADOW — situational play volume beside the model; 0 points applied'
  };
}
function applied(block) { return block && isNum(block.applied_points) ? block.applied_points : 0; }
function reset() { cache = {}; }

module.exports = { mode, locks, shadowBlock, applied, reset, shadowFile, CONFIG_FILE, PROMOTION_FILE };
