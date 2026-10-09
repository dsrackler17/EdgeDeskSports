#!/usr/bin/env node
/* ===========================================================================
   THE FACTS LEDGER — outside reporting, recorded with a receipt.

     node tools/content/add_fact.js --file fact.json      add one fact (validated)
     node tools/content/add_fact.js --list [--game ID]    what is on file, and its status
     node tools/content/add_fact.js --verify ID --by NAME an editor opened the source and
                                                          confirmed it: REPORTED → VERIFIED
     node tools/content/add_fact.js --expire              drop facts past their expiry
     node tools/content/add_fact.js --check               every fact passes validation (CI)

   A fact needs the outlet, the https URL, the date the SOURCE published it,
   who recorded it and a verification status. It is REPORTED until a named
   person confirms it at the source; an article citing a REPORTED fact is held
   for review (lib/football_evidence.js gate → HOLD_FOR_REVIEW). Availability
   facts expire at kickoff or after 72 hours. The ledger is the cache: a fact
   that is on file and current is never researched again.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FE = require(path.join(ROOT, 'lib', 'football_evidence.js'));
const FILE = path.join(ROOT, 'football', 'evidence', 'facts.json');

function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { schema: 'edgedesk_football_facts_v1', facts: [] }; } }
function save(j) { j.generated_at = new Date().toISOString(); fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(j, null, 1) + '\n'); }

/* defaults a recorder should not have to type */
function normalise(f, nowMs) {
  const o = Object.assign({}, f);
  if (!o.recorded_at) o.recorded_at = new Date(nowMs).toISOString();
  if (o.expires_at === undefined) {
    const ttl = FE.FACT_TTL_HOURS[o.kind];
    const pub = Date.parse(o.source && o.source.published_at || '');
    o.expires_at = ttl && isFinite(pub) ? new Date(pub + ttl * 3600000).toISOString() : null;
  }
  return o;
}

function main() {
  const now = Date.now();
  const j = load();
  if (flag('check')) {
    const bad = [];
    const ids = {};
    j.facts.forEach((f) => { const v = FE.validateFact(f, now); if (!v.ok) bad.push(f.id + ': ' + v.reasons.join('; ')); if (ids[f.id]) bad.push(f.id + ': duplicate id'); ids[f.id] = 1; });
    if (bad.length) { console.error('FACTS LEDGER INVALID\n  ' + bad.join('\n  ')); process.exit(1); }
    console.log('ok      ' + path.relative(ROOT, FILE) + ' (' + j.facts.length + ' facts)');
    return;
  }
  if (flag('list')) {
    const game = arg('game');
    j.facts.filter((f) => !game || f.game_id === game).forEach((f) => {
      const exp = Date.parse(f.expires_at || '');
      console.log((f.verification + (isFinite(exp) && exp <= now ? ' EXPIRED' : '')).padEnd(18) + f.id.padEnd(40) + f.source.publisher + ' (' + f.source.published_at + ') — ' + f.text.slice(0, 110));
    });
    console.log(j.facts.length + ' fact(s)');
    return;
  }
  if (flag('expire')) {
    const before = j.facts.length;
    j.facts = j.facts.filter((f) => !f.expires_at || Date.parse(f.expires_at) > now);
    save(j); console.log('expired ' + (before - j.facts.length) + '; ' + j.facts.length + ' remain');
    return;
  }
  if (arg('verify')) {
    const id = arg('verify'), by = arg('by');
    if (!by) { console.error('REFUSED: --by NAME (the person who opened the source and confirmed it)'); process.exit(1); }
    const f = j.facts.find((x) => x.id === id);
    if (!f) { console.error('no fact ' + id); process.exit(1); }
    f.verification = 'VERIFIED'; f.verified_by = by; f.verified_at = new Date(now).toISOString();
    save(j); console.log('verified ' + id + ' by ' + by);
    return;
  }
  if (arg('file')) {
    const f = normalise(JSON.parse(fs.readFileSync(arg('file'), 'utf8')), now);
    const v = FE.validateFact(f, now);
    if (!v.ok) { console.error('REFUSED: ' + v.reasons.join('; ')); process.exit(1); }
    if (j.facts.some((x) => x.id === f.id)) { console.error('REFUSED: a fact with id ' + f.id + ' is already on file'); process.exit(1); }
    j.facts.push(f); save(j); console.log('recorded ' + f.id + ' (' + f.verification + ')' + (f.expires_at ? ', expires ' + f.expires_at : ''));
    return;
  }
  console.log('usage: node tools/content/add_fact.js --file fact.json | --list [--game ID] | --verify ID --by NAME | --expire | --check');
  process.exit(2);
}
if (require.main === module) main();
module.exports = { load, normalise, FILE };
