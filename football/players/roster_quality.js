/* ============================================================================
   THE PLAYER LAYER -> ENGINE ROSTER BUNDLE MERGE.

   WHY IT EXISTS. The college engine's talent layer asks a roster bundle for
   two things it was never given:

     r.overall_talent        a whole-roster quality composite
     r.by_group[G].talent    the same, per position group

   Both arrived null on every team on every path, and both bundle builders
   said the same thing in a comment — "per-player recruiting stars are not in
   this feed". That is TRUE and it is NOT THE SAME STATEMENT. Recruiting
   pedigree is one way to measure a roster. It is not the only one, and it is
   not the one this repository actually has.

   What this repository has is football/players/current.json: EPIR for 15,542
   players across all 138 FBS programmes, built from counted events, rolled up
   per position group and per team WITH ITS OWN MEASURED CONFIDENCE. It ships
   weekly. It was wired to the Player Explorer and to nothing else, so the
   engine's talent layer sat dark next to a committed file that answers its
   exact question, and every game on the board reported two of its ten input
   probes empty for a reason that had stopped being true.

   This module is the join. It is deliberately narrow.

   WHAT IT IS NOT. This is not recruiting talent and nothing here may be
   labelled as such. `blue_chip_ratio` stays null, the engine keeps reporting
   the blue-chip layer as unavailable, and football/players/recruiting_adapter
   remains the injection point for the day a legal keyless feed exists. The
   basis strings say "measured on-field production", because that is what the
   number is.

   WHAT IT WILL NOT OVERWRITE. Continuity, portal flow and class mix are
   measured by the ROSTER DIFF (athlete ids, consecutive seasons) and that is
   the trained definition. Where the diff produced a number, it wins. This
   merge only fills a field the diff left null, and only from a field the
   player layer actually measured. A null on both sides stays null: the engine
   renders it as missing and widens, which is the correct behaviour and the
   one thing that must not be traded away for a fuller-looking percentage.

   CONFIDENCE TRAVELS WITH THE VALUE. The player layer knows how well it knows
   each number — a group of walk-ons with no attributed event is rated at
   positional replacement and says so with a confidence near the floor. That
   confidence is carried through to the engine rather than replaced by the
   hard-coded constant the talent layer used to apply to everything, so a
   thinly-observed roster raises completeness WITHOUT claiming certainty it
   does not have.

   Browser + node, ES5, no dependencies. Loaded by app.html via fbScript and
   by football/matchup/inputs.js via require.
   ========================================================================== */
(function (root) {
  'use strict';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* The player layer's group vocabulary is the engine's own POS_GROUPS, built
     from the same map. Listed rather than inferred so a group that quietly
     disappears from one side is visible here instead of silently dropping. */
  var GROUPS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'CB', 'S',
    'DB', 'K', 'P', 'LS', 'RET', 'ATH'];

  var OVERALL_BASIS = 'measured on-field production (EdgeDesk EPIR, opponent-adjusted where '
    + 'the attribution supports it), rolled up over the roster. NOT recruiting pedigree: '
    + 'a player with no attributed event is carried at positional replacement with a low '
    + 'confidence that says so, never at a league average';

  function groupBasis(g) {
    return 'measured on-field production for this group'
      + (isNum(g.n) ? ' over ' + g.n + ' rostered player' + (g.n === 1 ? '' : 's') : '')
      + ' — not recruiting pedigree';
  }

  /* One team's merge. `bundle` may be null: a programme the roster sync did
     not cover still gets a talent bundle, because the player layer covering it
     is a fact about that programme and withholding it would be the same bug
     this module exists to fix. */
  function mergeTeam(bundle, t, source, asOf) {
    var out = bundle || { by_group: {}, overall_talent: null, blue_chip_ratio: null,
      source: source, as_of: asOf };
    if (!out.by_group) out.by_group = {};
    var filled = { overall: false, groups: 0, experience: 0, production: 0, continuity: 0 };

    var ov = t.overall || null;
    if (!isNum(out.overall_talent) && ov && isNum(ov.r)) {
      out.overall_talent = ov.r;
      out.overall_talent_confidence = isNum(ov.c) ? ov.c : null;
      out.overall_basis = OVERALL_BASIS;
      filled.overall = true;
    }

    var groups = t.groups || {};
    var ret = (t.returning && t.returning.by_group) || {};
    for (var i = 0; i < GROUPS.length; i++) {
      var name = GROUPS[i], g = groups[name];
      if (!g) continue;
      var b = out.by_group[name] || (out.by_group[name] = { n: null, returning_share: null,
        transfers_in: null, transfers_out: null, experience: null });
      /* n is a roster count and both sides measure it; the diff's is the one
         the continuity numbers were computed against, so it is left alone. */
      if (!isNum(b.n) && isNum(g.n)) b.n = g.n;
      if (!isNum(b.talent) && isNum(g.r)) {
        b.talent = g.r;
        b.talent_confidence = isNum(g.c) ? g.c : null;
        b.talent_basis = groupBasis(g);
        filled.groups++;
      }
      /* EXPERIENCE. The roster diff reads class year, which runs young on a
         redshirt and says so. The player layer counts SEASONS OBSERVED IN THE
         PLAY FEED, which is the definition cfb_p4/README.md established as
         the non-leaking one. The diff still wins where it produced a number,
         because that is what the weights were fitted against; this only fills
         a group the diff could not measure at all. */
      if (!isNum(b.experience) && isNum(g.ex)) b.experience = g.ex, filled.experience++;
      var r = ret[name];
      if (!r) continue;
      /* RETURNING PRODUCTION was missing on every team on every path — no
         builder computed it and the engine reported "no prior-season
         production join" for all 138 programmes. The player layer computes
         exactly that: the share of last season's attributed value still on
         this roster. */
      if (!isNum(b.returning_production) && isNum(r.value_returning)) {
        b.returning_production = r.value_returning;
        filled.production++;
      }
      if (!isNum(b.returning_share) && isNum(r.count_returning)) {
        b.returning_share = r.count_returning;
        filled.continuity++;
      }
    }
    return { bundle: out, filled: filled };
  }

  /* bundles: {teamKey -> bundle} from the roster sync (may be {}).
     layer:   the parsed football/players/current.json.
     normKey: the engine's own normaliser, so both sides key a team the same
              way — passing a different one is how two artifacts end up
              disagreeing about who "Miami (OH)" is.

     Returns { bundles, teams, source, as_of, filled, note }. The input object
     is NOT mutated: a caller that merges twice must get the same answer. */
  function merge(bundles, layer, normKey) {
    var out = {}, k;
    for (k in bundles) if (Object.prototype.hasOwnProperty.call(bundles, k)) out[k] = bundles[k];
    if (!layer || !layer.teams) {
      return { bundles: out, teams: 0, source: null, as_of: null,
        filled: { overall: 0, groups: 0, experience: 0, production: 0, continuity: 0 },
        note: 'football/players/current.json was not supplied, so the talent layer stays dark '
          + 'and every roster reports no talent composite' };
    }
    var asOf = layer.generated_at || null;
    var source = 'EdgeDesk player layer ' + (layer.season == null ? '' : layer.season)
      + (layer.week == null ? '' : (' wk' + layer.week)) + ' (' + (layer.player_count || '?')
      + ' rated players, ' + (layer.rated_with_production || '?') + ' with attributed production)';
    var tot = { overall: 0, groups: 0, experience: 0, production: 0, continuity: 0 }, teams = 0;

    for (k in layer.teams) {
      if (!Object.prototype.hasOwnProperty.call(layer.teams, k)) continue;
      var t = layer.teams[k];
      /* the layer keys by its own team key; re-normalise so a caller with a
         different key spelling still resolves */
      var key = normKey ? normKey(k) : k;
      if (!key) continue;
      var existing = out[key] || out[k] || null;
      /* the bundle object is shared across a team's name variants in the
         roster builder, so it is copied before being written to */
      var copy = null;
      if (existing) {
        copy = { by_group: {}, overall_talent: existing.overall_talent,
          blue_chip_ratio: existing.blue_chip_ratio, source: existing.source, as_of: existing.as_of };
        for (var gn in existing.by_group) if (Object.prototype.hasOwnProperty.call(existing.by_group, gn)) {
          var src = existing.by_group[gn], dst = {};
          for (var f in src) if (Object.prototype.hasOwnProperty.call(src, f)) dst[f] = src[f];
          copy.by_group[gn] = dst;
        }
      }
      var m = mergeTeam(copy, t, source, asOf);
      if (!m.bundle.source) m.bundle.source = source;
      else if (m.filled.overall || m.filled.groups) m.bundle.source = m.bundle.source + ' + ' + source;
      if (!m.bundle.as_of) m.bundle.as_of = asOf;
      m.bundle.talent_as_of = asOf;
      teams++;
      tot.overall += m.filled.overall ? 1 : 0;
      tot.groups += m.filled.groups;
      tot.experience += m.filled.experience;
      tot.production += m.filled.production;
      tot.continuity += m.filled.continuity;
      /* write under every key that already pointed at this team's bundle, so
         a schedule-feed name variant resolves to the merged one rather than
         to the stale pre-merge object */
      out[key] = m.bundle;
      for (var kk in out) if (Object.prototype.hasOwnProperty.call(out, kk) && out[kk] === existing) out[kk] = m.bundle;
    }

    return { bundles: out, teams: teams, source: source, as_of: asOf, filled: tot,
      note: teams + ' programmes carry a measured roster-quality composite from the player layer; '
        + 'recruiting pedigree remains unavailable and blue_chip_ratio stays null' };
  }

  var API = { merge: merge, mergeTeam: mergeTeam, GROUPS: GROUPS, OVERALL_BASIS: OVERALL_BASIS };
  root.EDRosterQuality = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
