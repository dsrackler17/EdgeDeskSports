#!/usr/bin/env node
/* ============================================================================
   THE OFF-FIELD DOOR, AND WHY IT IS THIS NARROW.

   The engine scores an off-field volatility term per side. Nothing has ever
   supplied it, so `off_field` has been UNAVAILABLE on 154 of 154 contract
   rows on every slate EdgeDesk has ever published, and the card has had to
   say so without being able to say what would change it.

   THIS IS THE ROUTE, and it refuses more than it accepts on purpose.

   A signal moves the confidence and volatility terms only if it is all four
   of these, and three of four is refused at the door:

     PUBLIC          a reader can open it
     SOURCED         a named publisher AND a resolvable URL
     DATED           a publication timestamp. The engine decays every signal
                     on a 21-day half-life; an undated signal decays at a flat
                     0.5, which describes nothing and is not a measurement
     SEVERITY-GRADED a number a person assigned deliberately, not a default

   AND IT NEVER TOUCHES THE MARGIN. The engine's off-field layer feeds
   information confidence and volatility only. A suspension makes a team less
   predictable; a model that let a headline move a spread would be reading the
   news instead of the football, and nothing recorded here can do that.

   NO "EVERYTHING IS FINE" ENTRY EXISTS, for the same reason the availability
   operator has no "everybody available" status: an absence of reports is not
   evidence of calm, and the only honest way to say "we looked and found
   nothing" is to have a registered source that something actually read —
   which is football/offfield/sources.json, not this file.

     node football/offfield/record_signal.js \
       --team "Michigan" --headline "..." --severity 0.6 --reliability 0.8 \
       --source-name "..." --source-url "https://..." \
       --published-at 2026-09-15T14:00:00Z --recorded-by "name"

     node football/offfield/record_signal.js --list
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const STORE = path.join(HERE, 'signals.json');
const SOURCES = path.join(HERE, 'sources.json');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }

/* WHAT A SIGNAL MUST CARRY. Each rule is here because the engine reads that
   exact field and does something specific with it. */
const REQUIRED = [
  ['team', 'which programme this is about'],
  ['headline', 'what happened, in a sentence a reader could check against the source'],
  ['source_name', 'who published it'],
  ['source_url', 'where a reader opens it'],
  ['published_at', 'when it was published — the engine decays on a 21-day half-life and an undated signal decays at a flat 0.5, which measures nothing'],
  ['severity', 'how much this destabilises the team, 0 to 1, assigned deliberately'],
  ['source_reliability', 'how much weight this publisher has earned, 0 to 1'],
  ['recorded_by', 'who typed it, so a wrong entry has an author'],
  ['recorded_at', 'when it was typed, which is not when it was published']
];

function validate(sig, now) {
  const bad = [];
  for (const [f, why] of REQUIRED) {
    if (sig[f] === undefined || sig[f] === null || sig[f] === '') bad.push(f + ' — ' + why);
  }
  if (bad.length) return { ok: false, why: bad };
  for (const f of ['severity', 'source_reliability']) {
    const v = +sig[f];
    if (!isFinite(v) || v < 0 || v > 1) bad.push(f + ' must be a number between 0 and 1, and a default is not a grade');
  }
  const t = Date.parse(sig.published_at);
  if (!isFinite(t)) bad.push('published_at is not a date EdgeDesk can parse');
  /* A SIGNAL PUBLISHED IN THE FUTURE IS A TYPO, and the decay would read it
     as fresher than fresh. */
  else if (t > (now || Date.now()) + 3600e3) bad.push('published_at is in the future');
  if (!/^https?:\/\/.+\..+/.test(String(sig.source_url || ''))) {
    bad.push('source_url is not a URL a reader could open');
  }
  /* A HEADLINE THAT SAYS NOTHING HAPPENED IS NOT A SIGNAL. The engine reads
     an EMPTY LIST for that, and only a registered source may produce one. */
  if (/^\s*(none|n\/?a|nothing|no news|all clear|everything.{0,4}fine|no issues)\s*\.?\s*$/i.test(String(sig.headline || ''))) {
    bad.push('"nothing happened" is not a signal — an absence of reports is not evidence of calm. '
      + 'Register a source in football/offfield/sources.json instead; a read of a registered source that '
      + 'carries nothing is what produces the empty list the engine reads as "looked, found nothing"');
  }
  return bad.length ? { ok: false, why: bad } : { ok: true };
}

/* WHAT THE ENGINE READS, and nothing else. Keys are the engine's own. */
function toEngine(sig) {
  return {
    headline: sig.headline,
    severity: +sig.severity,
    source_reliability: +sig.source_reliability,
    date: sig.published_at,
    source: sig.source_name,
    source_url: sig.source_url,
    team_key: sig.team_key,
    recorded_by: sig.recorded_by,
    recorded_at: sig.recorded_at,
    expires_at: sig.expires_at || null
  };
}

/* the reader every consumer uses. Returns a function key -> signals|null,
   where NULL MEANS NOBODY LOOKED and [] MEANS THE REGISTERED SOURCES WERE
   READ AND CARRIED NOTHING. Those are different answers and the engine
   already prices them differently. */
function load(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const store = readJson(STORE, null);
  const reg = readJson(SOURCES, null);
  const configured = (reg && reg.teams) || {};
  const byTeam = {};
  const refused = [];
  for (const s of ((store && store.signals) || [])) {
    const v = validate(s, now);
    if (!v.ok) { refused.push({ headline: s && s.headline, why: v.why }); continue; }
    /* A SIGNAL PAST ITS OWN EXPIRY IS NOT DROPPED SILENTLY — it stops being
       current, which is different from never having happened. */
    if (s.expires_at && Date.parse(s.expires_at) < now) continue;
    const k = s.team_key || normKey(s.team);
    if (!k) { refused.push({ headline: s.headline, why: ['the team does not resolve to a key'] }); continue; }
    (byTeam[k] = byTeam[k] || []).push(toEngine(Object.assign({}, s, { team_key: k })));
  }
  const readTeams = Object.keys(configured).filter(k => {
    const e = configured[k];
    return e && (Array.isArray(e) ? e.length : (e.sources || []).length);
  });
  return {
    counts: { signals: Object.keys(byTeam).reduce((n, k) => n + byTeam[k].length, 0),
      teams_with_signals: Object.keys(byTeam).length,
      teams_with_a_registered_source: readTeams.length, refused: refused.length },
    refused,
    source_name: (reg && reg.schema) ? 'EdgeDesk off-field register' : null,
    as_of: (store && store.generated_at) || null,
    /* THE TWO ANSWERS, KEPT APART. */
    for: function (key) {
      if (!key) return null;
      if (byTeam[key]) return byTeam[key];
      if (readTeams.indexOf(key) >= 0) return [];   /* looked, found nothing */
      return null;                                   /* nobody looked */
    }
  };
}

function main() {
  const now = Date.now();
  if (arg('list', false)) {
    const L = load({ now });
    console.log('\nOff-field signals on file');
    console.log('  ' + JSON.stringify(L.counts));
    if (L.refused.length) {
      console.log('\n  REFUSED at the door:');
      L.refused.forEach(r => console.log('   - ' + (r.headline || '(no headline)') + '\n       ' + r.why.join('\n       ')));
    }
    if (!L.counts.teams_with_a_registered_source) {
      console.log('\n  No team has a registered source, so an empty result means NOBODY LOOKED and the contract');
      console.log('  reports the gap. That is the honest reading and it is why football/offfield/sources.json');
      console.log('  ships empty: no keyless public feed supplies all four of public, sourced, dated and');
      console.log('  severity-graded, and registering a source nothing reads would turn a gap into a false');
      console.log('  clean bill of health.');
    }
    return 0;
  }
  const sig = {
    team: arg('team', null), headline: arg('headline', null),
    source_name: arg('source-name', null), source_url: arg('source-url', null),
    published_at: arg('published-at', null), severity: arg('severity', null),
    source_reliability: arg('reliability', null),
    recorded_by: arg('recorded-by', null), recorded_at: new Date(now).toISOString(),
    expires_at: arg('expires-at', null) || null
  };
  if (!sig.team && !sig.headline) {
    console.error('usage: node football/offfield/record_signal.js --team T --headline H --severity 0..1 '
      + '--reliability 0..1 --source-name N --source-url U --published-at ISO --recorded-by WHO');
    console.error('       node football/offfield/record_signal.js --list');
    return 2;
  }
  sig.team_key = normKey(sig.team);
  const v = validate(sig, now);
  if (!v.ok) {
    console.error('[offfield] REFUSED — a signal that is not all four of public, sourced, dated and '
      + 'severity-graded may not move a confidence score:');
    v.why.forEach(w => console.error('   - ' + w));
    return 1;
  }
  const store = readJson(STORE, null) || { schema: 'edgedesk_offfield_signals_v1', signals: [] };
  store.signals = (store.signals || []).concat([sig]);
  store.generated_at = new Date(now).toISOString();
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1) + '\n');
  console.log('[offfield] recorded: ' + sig.headline + ' (' + sig.team + ', severity ' + sig.severity + ')');
  return 0;
}

if (require.main === module) process.exit(main() || 0);
module.exports = { load, validate, toEngine, normKey, REQUIRED };
