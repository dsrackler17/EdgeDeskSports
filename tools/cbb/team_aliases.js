#!/usr/bin/env node
/* ===========================================================================
   THE 35 CLUBS WHOSE NAMES DO NOT MATCH

   Measured, not guessed. tools/cbb/probe_team_join.js matched 276 of 311
   archive clubs to ESPN clubs on name — 88.7% — and listed the 35 that failed.
   That list was short enough to finish by hand, which is the only reason this
   file exists: a join worth building is one whose exceptions a person can read.

   EACH ENTRY MAPS AN NCAA CLUB CODE TO THE SCHOOL NAME ESPN USES. Nothing here
   is fuzzy. The resolver below looks each one up exactly and REFUSES when an
   alias finds no club or more than one, because a mapping that guesses is worse
   than a mapping with a hole in it — a hole shows up as a missing archive panel,
   and a guess shows up as another club's batting line on this club's game.

   ONE OF THESE IS A TRAP AND IS THE REASON FUZZY MATCHING IS NOT USED HERE.
   In the archive, `USC` is Southern California and `UPST` is USC Upstate. Any
   similarity scorer worth its name will happily map "USC" onto "USC Upstate",
   and the result is a Trojans brief carrying a Spartanburg batting line with
   nothing anywhere to indicate it. Both are spelled out below and neither is
   inferred.
   =========================================================================== */
'use strict';

/* NCAA code → the school as ESPN writes it. */
/* NCAA code → the school as ESPN writes it. EVERY VALUE BELOW WAS READ OFF
   ESPN'S OWN CLUB LIST, not recalled. The first version of this table was
   written from memory and seven of its entries named clubs ESPN does not call
   that; the resolver refused them, printed the real candidates, and these are
   those. A comment gives the ESPN id so the next person can check without
   re-running anything. */
/* NCAA code → the school as ESPN writes it.

   HOW THIS TABLE WAS ARRIVED AT, because the history is the justification:
     - 35 clubs failed a name match in the measurement, and were aliased by hand.
     - Fixing a normaliser regression recovered 25 of them by name; their aliases
       are now redundant but harmless, and are KEPT because an alias that
       resolves is a statement that has been checked, and removing 28 entries on
       the assumption they are unnecessary is exactly the kind of tidying that
       silently breaks a club.
     - 7 aliases named clubs ESPN does not call that. I wrote them from memory,
       which was the whole mistake this table exists to avoid. The resolver
       refused them and printed the real candidates; 5 are corrected below from
       that output, with ESPN's id in a comment so the next person can check
       without re-running anything.
     - 2 remain unresolved on purpose: SELA and ULM. ESPN's list shares no
       distinguishing word with either NCAA name, so guessing again is the one
       thing not to do. They are absent, the resolver reports them, and their
       clubs simply show no season archive until somebody reads the dump. */
const ALIASES = {
  /* ── resolved, and left alone ───────────────────────────────────────────── */
  ALCN: 'Alcorn State',
  AMCC: 'Texas A&M-Corpus Christi',
  ARMY: 'Army',
  CCSU: 'Central Connecticut',
  COFC: 'Charleston',
  CSUB: 'Cal State Bakersfield',
  CSUN: 'Cal State Northridge',
  DBU: 'Dallas Baptist',
  HAW: "Hawai'i",
  LAM: 'Lamar',
  LIU: 'Long Island University',
  LMU: 'Loyola Marymount',
  MVSU: 'Mississippi Valley State',
  NCAT: 'North Carolina A&T',
  NCCU: 'North Carolina Central',
  NIU: 'Northern Illinois',
  QUC: 'Queens University',
  RGV: 'UT Rio Grande Valley',
  SEMO: 'Southeast Missouri State',
  SFA: 'Stephen F. Austin',
  SJSU: 'San José State',
  SJU: "St. John's",
  SMC: "Saint Mary's",
  SOU: 'Southern',
  UIW: 'Incarnate Word',
  UMES: 'Maryland Eastern Shore',
  UNA: 'North Alabama',
  UNCW: 'UNC Wilmington',

  /* ── corrected from ESPN's own published names ─────────────────────────── */
  MIA: 'Miami Hurricanes',                 /* id=176. NCAA writes "Miami (FL)";
                                              ESPN's plain "Miami" is the
                                              Hurricanes and it tags Miami (OH). */
  STMN: 'St. Thomas Tommies',              /* id=850. NCAA writes "St. Thomas (MN)";
                                              ESPN tags the Florida one instead. */
  UNO: 'LSU New Orleans Privateers',       /* id=184. ESPN prefixes it LSU. */

  /* ── THE PAIR THAT MUST NEVER COLLAPSE, and the live proof it matters ────
     ESPN calls Upstate "South Carolina Upstate" and calls Southern California
     "USC". So the token "USC" belongs to the TROJANS, and the club whose NCAA
     name contains "USC Upstate" is the one ESPN does not call USC.

     The resolver's candidate list for UPST offered id=68 USC Trojans as a
     suggestion. A shared-token scorer really does hand Upstate's season to
     Southern California; that is no longer a hypothetical, it is a printed line
     in a CI log. */
  USC: 'USC Trojans',                      /* id=68  — Southern California */
  UPST: 'South Carolina Upstate Spartans', /* id=453 — a different school */

  /* SELA (Southeastern La.) and ULM are deliberately absent. See the header. */
};

/* Spellings ESPN and NCAA disagree about in ways punctuation hides. Applied to
   BOTH sides, so the comparison is symmetric and an accent or an apostrophe
   cannot decide whether a club has a season archive. */
const FOLD = [
  [/[''`]/g, ''], [/[éèê]/g, 'e'], [/[áàâ]/g, 'a'], [/[íìî]/g, 'i'],
  [/[óòô]/g, 'o'], [/[úùû]/g, 'u'], [/[ñ]/g, 'n'],
];

/* ── ONE EXPANSION LIST, AND THE REASON IT IS HERE AND NOWHERE ELSE ───────
   This started as two lists: one in probe_team_join.js and a shorter copy here.
   The copy silently dropped six expansions — ark, mich, ky, ill, ind, colo — and
   twelve clubs that had matched perfectly well in the measurement stopped
   matching in the mapping. A duplicated normaliser is a normaliser that will
   diverge, and the divergence showed up as "no match" on Central Michigan,
   which reads like a data problem and was a refactoring problem.

   probe_team_join.js now imports this function. There is one list. */
const EXPAND = [
  /* Two abbreviations in one name is why "Central Conn. St." missed: a single
     pass that only knew "St." left "conn" behind. */
  [/\bconn\.?\b/gi, 'connecticut'], [/\bmo\.?\b/gi, 'missouri'],
  [/\bala\.?\b/gi, 'alabama'], [/\bval\.?\b/gi, 'valley'],
  [/\bark\.?\b/gi, 'arkansas'], [/\bmich\.?\b/gi, 'michigan'],
  [/\bky\.?\b/gi, 'kentucky'], [/\bill\.?\b/gi, 'illinois'],
  [/\bind\.?\b/gi, 'indiana'], [/\bcolo\.?\b/gi, 'colorado'],
  [/\bariz\.?\b/gi, 'arizona'], [/\bokla\.?\b/gi, 'oklahoma'],
  [/\bore\.?\b/gi, 'oregon'], [/\bwash\.?\b/gi, 'washington'],
  [/\bwis\.?\b/gi, 'wisconsin'], [/\bneb\.?\b/gi, 'nebraska'],
  [/\bmass\.?\b/gi, 'massachusetts'], [/\bmd\.?\b/gi, 'maryland'],
  [/\bpa\.?\b/gi, 'pennsylvania'], [/\bnev\.?\b/gi, 'nevada'],
  [/\bcol\.? of\b/gi, 'college of'], [/\buniv\.?\b/gi, 'university'],
  [/\bso\.?\b/gi, 'southern'], [/\bno\.?\b/gi, 'northern'],
  [/\bmiss\.?\b/gi, 'mississippi'], [/\bla\.?\b/gi, 'louisiana'],
  [/\bcaro\.?\b/gi, 'carolina'], [/\bn\.?c\.?\b/gi, 'north carolina'],
  [/\bs\.?c\.?\b/gi, 'south carolina'], [/\bfla\.?\b/gi, 'florida'],
  [/\bcalif\.?\b/gi, 'california'], [/\btenn\.?\b/gi, 'tennessee'],
  [/\btex\.?\b/gi, 'texas'], [/\bga\.?\b/gi, 'georgia'],
  [/\bva\.?\b/gi, 'virginia'], [/\bcent\.?\b/gi, 'central'],
  [/\bintl\.?\b/gi, 'international'], [/\bdet\.?\b/gi, 'detroit'],
  /* "St." IS TWO DIFFERENT WORDS AND POSITION IS THE ONLY TELL. Trailing, it
     is State: "Alabama St.", "Southeast Mo. St.". Leading, it is Saint:
     "St. John's", "St. Thomas". The first version of this expanded both and
     turned St. John's into "state johns" — which happened to still match only
     because the same mangling was applied to ESPN's spelling too. A rule that
     is wrong on both sides is not a rule that works; it is one waiting to meet
     a club actually called "State" something. Leading St. is left alone. */
  [/\bst\.?$/i, 'state'],
  [/(?!^)\bst\.? /gi, function (m, off) { return off === 0 ? m : 'state '; }],
];

function norm(s) {
  let t = String(s || '').toLowerCase().trim();
  for (const [re, to] of FOLD) t = t.replace(re, to);
  /* THE PARENTHETICAL STAYS. It looked like noise — "(CA)", "(NY)", "(OH)" —
     and stripping it MANUFACTURED the ambiguities that then had to be guarded
     against: ESPN carries both "Cornell" and "Cornell (IA)", and both
     "Northwestern" and "Northwestern (IA)", so folding the tag away made each
     pair collide and the guard dropped both keys. Two clubs that ESPN
     distinguishes were made indistinguishable by my own normaliser.

     Keeping it resolves three clubs by name that previously needed aliases:
     Miami (OH) matches Miami (OH), Cornell matches Cornell, Northwestern
     matches Northwestern. Where the two sources genuinely disagree about which
     club gets the tag — NCAA writes "Miami (FL)" where ESPN writes plain
     "Miami" — that is what the alias list is for. */
  t = t.replace(/[()]/g, ' ');
  for (const [re, to] of EXPAND) t = t.replace(re, to);
  return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Build a lookup over ESPN clubs keyed on every name they publish. A key that
   two different clubs both claim is DROPPED rather than given to whichever came
   first, because an ambiguous key is how the wrong club's numbers get attached. */
function indexEspn(teams) {
  const byName = new Map();
  const ambiguous = new Set();
  const add = (raw, t) => {
    const k = norm(raw);
    if (!k) return;
    const prev = byName.get(k);
    if (prev && String(prev.id) !== String(t.id)) { ambiguous.add(k); return; }
    byName.set(k, t);
  };
  for (const t of teams || []) {
    add(t.location, t); add(t.name, t); add(t.shortDisplayName, t);
    add(t.displayName, t); add(t.nickname, t);
  }
  for (const k of ambiguous) byName.delete(k);
  return { byName, ambiguous };
}

/* Resolve every archive club to an ESPN club. Returns the mapping AND the
   unresolved list, because the caller has to be able to see the holes. */
function resolveClubs(archiveClubs, espnTeams) {
  const { byName, ambiguous } = indexEspn(espnTeams);
  const mapped = [];
  const unresolved = [];
  const aliasFailed = [];
  for (const c of archiveClubs) {
    const code = String(c.code || '').trim();
    const alias = ALIASES[code];
    /* An alias is a deliberate statement, so if it fails to resolve that is a
       fact about this file being out of date and it is reported as one — never
       quietly fallen back to the fuzzy path that the alias exists to avoid. */
    if (alias) {
      const t = byName.get(norm(alias));
      if (t) { mapped.push({ code, name: c.name, espn_id: String(t.id), espn_name: t.displayName, via: 'alias' }); continue; }
      aliasFailed.push(`${code} → "${alias}" is not an ESPN club name any more`);
      unresolved.push({ code, name: c.name, why: 'alias did not resolve' });
      continue;
    }
    const t = byName.get(norm(c.name));
    if (t) { mapped.push({ code, name: c.name, espn_id: String(t.id), espn_name: t.displayName, via: 'name' }); continue; }
    unresolved.push({ code, name: c.name, why: ambiguous.has(norm(c.name)) ? 'ambiguous' : 'no match' });
  }
  /* A club mapped to the same ESPN id twice means two archive codes point at
     one club, which cannot be right and would double a club's roster. */
  const seen = new Map();
  const collisions = [];
  for (const m of mapped) {
    if (seen.has(m.espn_id)) collisions.push(`${seen.get(m.espn_id)} and ${m.code} both map to ${m.espn_name}`);
    else seen.set(m.espn_id, m.code);
  }
  return { mapped, unresolved, aliasFailed, collisions,
    rate: archiveClubs.length ? mapped.length / archiveClubs.length : 0 };
}

module.exports = { ALIASES, norm, indexEspn, resolveClubs };
