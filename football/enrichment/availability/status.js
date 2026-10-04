/* ============================================================================
   ONE AVAILABILITY VOCABULARY.

   Conference reports say "Out (1st half)", ESPN says INJURY_STATUS_OUT, the
   automated reader says GAME_TIME_DECISION, a beat writer says "left the
   program". Every one of them is normalized here into the ten states of
   config.js STATUS, and the raw words are kept beside the result.

   UNKNOWN is the answer whenever the words do not say. It is never read as
   AVAILABLE by anything downstream.
   ========================================================================== */
'use strict';

const C = require('../config.js');

/* designation words from structured sources (conference reports, the
   automated reader's vocabulary, operator entries, ESPN status codes) */
const WORD = {
  AVAILABLE: 'AVAILABLE', ACTIVE: 'AVAILABLE', CLEARED: 'AVAILABLE', HEALTHY: 'AVAILABLE',
  PROBABLE: 'PROBABLE', EXPECTED: 'PROBABLE', LIKELY: 'PROBABLE', LIMITED: 'PROBABLE',
  QUESTIONABLE: 'QUESTIONABLE', GAME_TIME_DECISION: 'QUESTIONABLE', GTD: 'QUESTIONABLE',
  DAY_TO_DAY: 'QUESTIONABLE', UNCERTAIN: 'QUESTIONABLE',
  /* a first-half absence is not "out": the player is back after two quarters */
  OUT_FIRST_HALF: 'QUESTIONABLE',
  DOUBTFUL: 'DOUBTFUL', UNLIKELY: 'DOUBTFUL',
  OUT: 'OUT', INACTIVE: 'OUT', 'INJURED RESERVE': 'SEASON_OUT', IR: 'SEASON_OUT',
  SEASON_OUT: 'SEASON_OUT', OUT_FOR_SEASON: 'SEASON_OUT',
  SUSPENDED: 'SUSPENDED', SUSPENSION: 'SUSPENDED', INELIGIBLE: 'SUSPENDED',
  TRANSFERRED: 'TRANSFERRED', PORTAL: 'TRANSFERRED',
  NOT_WITH_TEAM: 'NOT_WITH_TEAM', DISMISSED: 'NOT_WITH_TEAM', LEFT_TEAM: 'NOT_WITH_TEAM',
  UNKNOWN: 'UNKNOWN'
};

/* free text can sharpen a designation (OUT -> SEASON_OUT) but never soften
   one, and never invent availability */
const TEXT = [
  { re: /\b(season[- ]ending|out for (the )?(season|year)|remainder of the season|rest of the season|lost for the season)\b/i, to: 'SEASON_OUT' },
  { re: /\b(suspend(ed|ion)?|ineligible)\b/i, to: 'SUSPENDED' },
  { re: /\b(enter(ed|s)? the (transfer )?portal|transferred|in the portal)\b/i, to: 'TRANSFERRED' },
  { re: /\b(left the (team|program)|no longer (with|on) the (team|program)|dismissed|not with (the )?team|parted ways)\b/i, to: 'NOT_WITH_TEAM' }
];

function canon(w) {
  if (w == null) return null;
  return String(w).toUpperCase().replace(/^INJURY_STATUS_/, '').replace(/[\s-]+/g, '_').replace(/[^A-Z_]/g, '').replace(/^_+|_+$/g, '') || null;
}

/* normalize(designation, text) -> {status, reported_status, partial, basis} */
function normalize(designation, text) {
  const raw = designation == null ? null : String(designation);
  const k = canon(designation);
  let st = k && WORD[k] ? WORD[k] : null;
  if (!st && k === 'INJURED_RESERVE') st = 'SEASON_OUT';
  let basis = st ? 'designation' : null;
  const t = [raw, text].filter(Boolean).join(' ');
  for (const r of TEXT) {
    if (!r.re.test(t)) continue;
    /* sharpen only: a text match upgrades OUT/DOUBTFUL/unknown, it never
       turns a named PROBABLE into a season-ending absence on a stray word */
    if (!st || st === 'OUT' || st === 'DOUBTFUL' || st === 'UNKNOWN') { st = r.to; basis = st === r.to && basis ? 'designation sharpened by text' : 'text'; }
    break;
  }
  if (!st) { st = 'UNKNOWN'; basis = 'the words did not state a designation'; }
  return { status: st, reported_status: raw, partial: k === 'OUT_FIRST_HALF' ? 'FIRST_HALF' : null, basis };
}

function isAbsent(s) { return C.ABSENT.indexOf(s) >= 0; }
function isDoubt(s) { return C.DOUBT.indexOf(s) >= 0; }
function pAbsent(s) { return Object.prototype.hasOwnProperty.call(C.P_ABSENT, s) ? C.P_ABSENT[s] : null; }
/* a designation that lasts beyond one fixture, so a report filed for last
   week's game still says something true about this one */
function persists(s) { return s === 'SEASON_OUT' || s === 'TRANSFERRED' || s === 'NOT_WITH_TEAM'; }

module.exports = { normalize, isAbsent, isDoubt, pAbsent, persists, canon, WORD };
