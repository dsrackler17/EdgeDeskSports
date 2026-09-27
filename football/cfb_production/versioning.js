/* ============================================================================
   CFB production — model version semantics and "no unversioned hotfix"
   (docs/cfb-production/VERSIONING.md §2).

     edgedesk_cfb_v<MAJOR>.<MINOR>.<PATCH>
       MAJOR  predictive architecture changes (new submodel family, new stack,
              new target, new feature schema)
       MINOR  a validated model-component change (retrain, recalibration, new
              decision policy or calibration artifact the model runs with)
       PATCH  a bug fix with the intended prediction logic unchanged (a crash,
              a guard, a label) — outputs on the golden inputs must not move

   unversionedChanges(manifest, facts): the committed manifest pins every file
   that decides a number. If any of them changed while production_model_version
   did not, that is an unversioned hotfix: the release check FAILS it. A real
   fix bumps the version (at least PATCH), regenerates compatibility.json and
   the manifest, and the MANIFEST_RECORDED audit row records it.
   ========================================================================== */
'use strict';

const RE = /^(?:edgedesk_cfb_)?v?(\d+)\.(\d+)\.(\d+)$/;
const KINDS = {
  architecture: 'MAJOR', feature_schema: 'MAJOR', target: 'MAJOR', submodel_family: 'MAJOR',
  retrain: 'MINOR', calibration: 'MINOR', decision_policy: 'MINOR', ensemble_weights: 'MINOR', decision_calibration: 'MINOR',
  bug_fix: 'PATCH', guard: 'PATCH', label: 'PATCH',
};
const ORDER = { NONE: 0, PATCH: 1, MINOR: 2, MAJOR: 3 };

function parse(v) {
  const m = RE.exec(String(v || '').replace(/^edgedesk_cfb_p4_/, ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
function bumpOf(from, to) {
  const a = parse(from), b = parse(to);
  if (!a || !b) return null;
  if (b.major !== a.major) return b.major > a.major ? 'MAJOR' : 'DOWNGRADE';
  if (b.minor !== a.minor) return b.minor > a.minor ? 'MINOR' : 'DOWNGRADE';
  if (b.patch !== a.patch) return b.patch > a.patch ? 'PATCH' : 'DOWNGRADE';
  return 'NONE';
}
/* the smallest bump a set of change kinds requires */
function requiredBump(kinds) {
  let need = 'NONE';
  (kinds || []).forEach((k) => { const b = KINDS[k]; if (!b) throw new Error('unknown change kind ' + k); if (ORDER[b] > ORDER[need]) need = b; });
  return need;
}
function sufficient(from, to, kinds) {
  const got = bumpOf(from, to), need = requiredBump(kinds);
  return { ok: got !== null && got !== 'DOWNGRADE' && ORDER[got] >= ORDER[need], got, need };
}

/* files that decide a number and whose change needs a new version (manifest key -> facts key) */
const PINNED = ['football/cfb_v2/params.js', 'football/cfb_v2/engine.js'];
function unversionedChanges(man, facts, shaFile) {
  const out = [];
  if (!man || !facts) return out;
  if (man.production_model_version !== facts.production_model_version) return out;   // a new version: a different question
  for (const [p, e] of Object.entries(man.artifact_hashes || {})) {
    const isModel = PINNED.includes(p) || p.startsWith(facts.artifact.dir + '/');
    if (!isModel) continue;
    const now = shaFile(p);
    if (now !== e.sha256) out.push({ file: p, manifest: e.sha256, disk: now });
  }
  return out;
}

module.exports = { parse, bumpOf, requiredBump, sufficient, unversionedChanges, KINDS, PINNED };
