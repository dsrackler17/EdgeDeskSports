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
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }

/* THE RULES AND THE READER live in football/offfield/reader.js, which the
   board loads too, so the build and the board read one register one way. */
const R = require(path.join(HERE, 'reader.js'));
const REQUIRED = R.REQUIRED;
const validate = R.validate;
const toEngine = R.toEngine;
const normKey = R.normKey;

/* the reader every consumer uses. Returns a function key -> signals|null,
   where NULL MEANS NOBODY LOOKED and [] MEANS THE REGISTERED SOURCES WERE
   READ AND CARRIED NOTHING. Those are different answers and the engine
   already prices them differently. */
function load(opts) {
  opts = opts || {};
  return R.read(readJson(STORE, null), readJson(SOURCES, null), opts.now || Date.now());
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
