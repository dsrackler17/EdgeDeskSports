'use strict';
/* ===========================================================================
   The football evidence, onto EdgeDesk's own game pages.

   The first-party pipelines (tools/articles/generate.js and
   tools/editorial/run.js) call attach() on every pregame record they build or
   refresh. It looks the game up in the week's evidence packets (built once per
   process by tools/content/evidence.js, from committed artifacts only — no
   API), stores lib/football_evidence.js articleSummary() on the record as
   `football_evidence`, and rebuilds the record's article so the page gets its
   "The football behind the number" section. A game with no packet gets no
   section; publishing it is then held by the preflight (requireEvidence).

   The summary carries no build time, only the packet's content hash, so a
   record changes only when the football evidence does.
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FE = require(path.join(ROOT, 'lib', 'football_evidence.js'));
const MODEL = require(path.join(__dirname, 'article_model.js'));

let SET = null, SET_AT = null;
function evidenceSet(nowIso) {
  if (SET && SET_AT === nowIso) return SET;
  const EV = require(path.join(ROOT, 'tools', 'content', 'evidence.js'));
  SET = EV.build({ now: nowIso ? Date.parse(nowIso) : Date.now() });
  SET_AT = nowIso;
  return SET;
}
function packetFor(rec, set) {
  if (!rec || rec.game_id == null) return null;
  const league = rec.sport === 'NFL' ? 'nfl' : 'cfb';
  return (set && set[league] && set[league].packets && set[league].packets[String(rec.game_id)]) || null;
}
/* rec → the same record with football_evidence and a rebuilt article. opts.set
   lets a caller (or a test) supply the packets. */
function attach(rec, nowIso, opts) {
  opts = opts || {};
  if (!rec || MODEL.typeOf(rec) !== 'pregame') return rec;
  const set = opts.set || evidenceSet(nowIso);
  const summary = FE.articleSummary(packetFor(rec, set));
  const before = JSON.stringify(rec.football_evidence || null);
  if (before === JSON.stringify(summary || null) && rec.article) return rec;
  const next = Object.assign({}, rec, { football_evidence: summary || null });
  next.article = MODEL.articleFor(next);
  return next;
}
module.exports = { attach, packetFor, evidenceSet };
