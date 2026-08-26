/* ============================================================================
   EdgeDesk Football — ESPN roster dataset -> engine roster bundles.

   Turns the repo's ESPN roster sync output (football/rosters/
   fbs_<season>_espn.json, written by fetch_rosters.js) into the per-team
   roster measurement bundles the Power 4 engine's talent layer reads —
   the SAME bundle shape football/cfb_p4/research/features_roster.py
   defines and the app's cfbfastR path builds:

     { by_group: { QB: { n, returning_share, transfers_in, transfers_out,
                         experience }, ... },
       overall_talent: null, blue_chip_ratio: null, source, as_of }

   Feature semantics mirror the trained definitions:
     returning    — same team both seasons, diffed on ESPN athlete ids
                    (stable across seasons), exactly features_roster.py's
                    prev_team_key.eq(team_key)
     transfer_in  — on a DIFFERENT team last season (prev known, not same)
     transfer_out — on THIS team last season, on another team now,
                    attributed to the position group they played HERE
     experience   — (class_year − 1) / 3 in 0..1 from ESPN's CURRENT class
                    (Freshman/Sophomore/Junior/Senior). This is a live
                    present-season fact, unlike the cfbfastR `year` column
                    (a back-propagated eventual class, which leaks and is
                    why the cfbfastR path ships no experience). Caveat,
                    stated not hidden: a redshirt reads by class, not by
                    seasons on a roster, so this runs slightly young.

   Absent inputs stay null — the engine renders each as M.missing and
   widens uncertainty. No previous-season dataset means no continuity or
   portal numbers, never a guess. overall_talent / blue_chip_ratio stay
   null: per-player recruiting stars are not in this feed either.

   Bundles are registered under the normKey of ALL of the team's ESPN
   name variants (location, display name, short name), so a schedule-feed
   name ("App State", "UMass") resolves without an alias table. Verified
   against the trained seed keys: every 2026 FBS team resolves.

   Browser + node, ES5, no dependencies. Loaded by app.html via fbScript
   and by football/health/daily_check.js via require.
   ========================================================================== */
(function (root) {
  'use strict';

  /* raw position -> engine POS_GROUP; must mirror app.html FBP4_POS and
     features_roster.py. ESPN's 2026 vocabulary observed: OL WR LB DL DB RB
     TE S CB QB DE DT PK LS P EDGE OT G FB C NT — all covered. */
  var POS = { QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
    OL: 'OL', OT: 'OL', OG: 'OL', G: 'OL', C: 'OL',
    DL: 'DL', DT: 'DL', NT: 'DL', DE: 'DL', EDGE: 'EDGE',
    LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
    CB: 'CB', S: 'S', DB: 'DB', PK: 'K', K: 'K', P: 'P', LS: 'LS',
    PR: 'RET', KR: 'RET', ATH: 'ATH' };

  /* (class_year − 1) / 3, the trained 0..1 scale */
  var CLASS_W = { freshman: 0, sophomore: 1 / 3, junior: 2 / 3, senior: 1, graduate: 1 };

  function teamKeyOf(t, normKey) {
    return normKey(t.location || t.display_name || t.short_name || '');
  }

  /* cur/prev: parsed fbs_<season>_espn.json objects (prev may be null).
     normKey: the engine's own normaliser (EDCfbP4.normKey). Returns
     { bundles: {key -> bundle}, teams: n, with_continuity: n }. */
  function build(cur, prev, normKey) {
    var prevTeam = {}, prevPos = {}, prevKeys = {}, curTeam = {}, i, j, t, p;
    if (prev && prev.teams) {
      for (i = 0; i < prev.teams.length; i++) {
        t = prev.teams[i];
        var pk = teamKeyOf(t, normKey);
        prevKeys[pk] = true;
        for (j = 0; j < t.players.length; j++) {
          p = t.players[j];
          if (!p.espn_id) continue;
          prevTeam[p.espn_id] = pk;
          prevPos[p.espn_id] = POS[String(p.position || '').toUpperCase()] || null;
        }
      }
    }
    for (i = 0; i < cur.teams.length; i++) {
      t = cur.teams[i];
      var tk0 = teamKeyOf(t, normKey);
      for (j = 0; j < t.players.length; j++) {
        p = t.players[j];
        if (p.espn_id) curTeam[p.espn_id] = tk0;
      }
    }

    var bundles = {}, withCont = 0;
    var source = 'ESPN rosters ' + cur.requested_season
      + (prev ? (' vs ' + prev.requested_season) : '')
      + ' (repo roster sync; experience = current class mix, redshirts read young)';
    for (i = 0; i < cur.teams.length; i++) {
      t = cur.teams[i];
      var tk = teamKeyOf(t, normKey);
      /* A team ABSENT from the previous dataset (an FBS newcomer that was
         FCS last season) has UNKNOWN continuity, not zero: its players'
         absence from the prev set means the set didn't cover the team, not
         that nobody returned. transfers_in stays real — presence on another
         covered team last season is an observation either way. */
      var hasPrev = !!(prev && prevKeys[tk]);
      var acc = {};
      for (j = 0; j < t.players.length; j++) {
        p = t.players[j];
        var grp = POS[String(p.position || '').toUpperCase()];
        if (!grp) continue;
        var g = acc[grp] || (acc[grp] = { n: 0, ret: 0, tin: 0, tout: 0, expSum: 0, expN: 0 });
        g.n++;
        if (prev) {
          var was = p.espn_id ? prevTeam[p.espn_id] : undefined;
          if (was === tk) g.ret++;
          else if (was !== undefined) g.tin++;
        }
        var w = CLASS_W[String(p['class'] || '').toLowerCase()];
        if (w !== undefined) { g.expSum += w; g.expN++; }
      }
      /* outgoing portal: on this team last season, on another team now */
      if (hasPrev) {
        for (var aid in prevTeam) {
          if (prevTeam[aid] !== tk) continue;
          var nowTk = curTeam[aid];
          if (nowTk === undefined || nowTk === tk) continue;   /* gone entirely (graduated/draft) is NOT a transfer */
          var og = prevPos[aid];
          if (og && acc[og]) acc[og].tout++;
        }
      }
      var bundle = { by_group: {}, overall_talent: null, blue_chip_ratio: null,
        source: source, as_of: cur.retrieved_at || null };
      var any = false;
      for (var gn in acc) {
        var a = acc[gn];
        bundle.by_group[gn] = {
          n: a.n,
          returning_share: hasPrev ? (a.ret / a.n) : null,
          transfers_in: prev ? a.tin : null,
          transfers_out: hasPrev ? a.tout : null,
          experience: a.expN ? (a.expSum / a.expN) : null
        };
        any = true;
      }
      if (!any) continue;
      if (hasPrev) withCont++;
      var names = [t.location, t.display_name, t.short_name], k;
      for (j = 0; j < names.length; j++) {
        k = names[j] ? normKey(names[j]) : null;
        if (k && !bundles[k]) bundles[k] = bundle;
      }
    }
    return { bundles: bundles, teams: cur.teams.length, with_continuity: withCont };
  }

  var API = { build: build, POS: POS, CLASS_W: CLASS_W };
  root.EDEspnRosterBundles = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
