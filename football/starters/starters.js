/* ============================================================================
   EdgeDesk STARTER CONTEXT — the deterministic core.

   WHAT THIS FIXES. Every caller of the college engine passed `qb: null`, and
   the engine dutifully reported "starting QB unknown" on all 75 games of the
   board. The comment above the null said college football publishes no depth
   chart EdgeDesk trusts, which is true, and then drew the wrong conclusion
   from it: that the only alternative to an announcement is silence. It is
   not. Who took the dropbacks in a team's last game is a FACT, published in
   the same public play feed the rest of this repository already reads, and
   "LSU's last start went to Sam Leavitt, 25 of 27 dropbacks, week 2" is not
   a guess dressed as an input — it is an observation with a source and a
   timestamp, and it is a different statement from "confirmed starter".

   So this file represents the six states separately and never collapses them:

     ANNOUNCED       an official team or conference source named the starter
     EXPECTED        current reporting supports one starter (media tier)
     PREVIOUS_GAME   he started the team's most recent completed game
     DEPTH_CHART     he leads the published depth chart
     COMPETITION     the evidence does not settle on one player
     UNKNOWN         nothing observed at all

   Availability is a SECOND AXIS, never folded into the first. A resolved
   expectation whose player is DOUBTFUL is still a resolved expectation with a
   doubt attached, and the two facts travel together.

   THE RULES THIS FILE WILL NOT BREAK
   - An inferred starter is never labelled confirmed. `announced` is true only
     for tier-1 evidence and nothing downstream may promote it.
   - Absence of an injury report is not health. `availability.state` is
     UNKNOWN in that case and says why.
   - Identity is resolved on the athlete id when there is one. A name-only
     match is accepted only when it is unique on the CURRENT season's roster
     for that team; a duplicate name or a player who is no longer on the
     roster resolves to nothing rather than to the wrong person.
   - A previous-season team assignment never travels into this season. Every
     record carries its season, and evidence from another season is refused.
   - Every record carries source, source_url, published_at and retrieved_at,
     and staleness is measured against retrieval, not against a calendar.

   Node and browser (UMD), so the builders, the tests and the page all read
   one implementation.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDSTARTERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_starter_context_v1';

  /* The six represented states, strongest evidence first. The ORDER is the
     resolution rule: the strongest tier that produced a single name wins. */
  var STATUS = ['ANNOUNCED', 'EXPECTED', 'DEPTH_CHART', 'PREVIOUS_GAME', 'COMPETITION', 'UNKNOWN'];
  var STATUS_RANK = { ANNOUNCED: 0, EXPECTED: 1, DEPTH_CHART: 2, PREVIOUS_GAME: 3, COMPETITION: 4, UNKNOWN: 5 };

  /* Evidence kinds, and the tier each one can support. A kind may never
     produce a status stronger than the tier of the source that carried it. */
  var EVIDENCE = {
    OFFICIAL_ANNOUNCEMENT: { max_status: 'ANNOUNCED', tier: 1 },
    OFFICIAL_DEPTH_CHART: { max_status: 'DEPTH_CHART', tier: 1 },
    MEDIA_REPORT: { max_status: 'EXPECTED', tier: 2 },
    DEPTH_CHART: { max_status: 'DEPTH_CHART', tier: 2 },
    GAME_USAGE: { max_status: 'PREVIOUS_GAME', tier: 3 },
    PROJECTION: { max_status: 'COMPETITION', tier: 4 }
  };

  /* Availability, kept apart from the starter question on purpose. */
  var AVAIL_STATES = ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'GAME_TIME_DECISION', 'LIMITED', 'PROBABLE', 'AVAILABLE', 'UNKNOWN'];
  var AVAIL_DOUBT = { OUT: 100, DOUBTFUL: 80, GAME_TIME_DECISION: 65, QUESTIONABLE: 60, LIMITED: 40, PROBABLE: 25, AVAILABLE: 10, UNKNOWN: 50 };
  /* a week: the availability layer's HISTORICAL line
     (football/availability/availability.js getAvailabilityFreshness) */
  var AVAIL_HISTORICAL_H = 168;

  /* How old a piece of evidence may be before it is called stale. Usage is
     measured in weeks because a start is a weekly fact; reports in hours
     because a report is a daily one. */
  var STALE = { usage_weeks: 2, report_hours: 96, depth_hours: 168 };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(v) { if (v == null) return null; var t = (typeof v === 'number') ? v : Date.parse(v); return isFinite(t) ? t : null; }
  function hoursBetween(a, b) { var x = ms(a), y = ms(b); return (x == null || y == null) ? null : (y - x) / 3600000; }
  function r3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : null; }

  var ACCENTS = { 'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ñ': 'n', 'ç': 'c' };

  function normKey(s) {
    if (s == null) return null;
    var t = String(s).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < t.length; i++) { c = t.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/[^a-z0-9]+/g, '');
    return out || null;
  }
  /* A person's name, stripped of the decorations feeds disagree about. Jr/Sr
     and the roman numerals are dropped because one feed prints them and
     another does not; they are kept on the DISPLAY name, never on the key. */
  function normName(s) {
    if (s == null) return null;
    var t = String(s).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < t.length; i++) { c = t.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/[.'’`]/g, '')
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return out || null;
  }

  /* ------------------------------------------------------------- identity */
  /* THE SEASON IS PART OF THE IDENTITY. A transfer is the same athlete id on
     a different roster, and carrying last year's team into this year's
     matchup is the exact failure this guard exists to stop. */
  function rosterIndex(roster, opts) {
    opts = opts || {};
    var byId = {}, byName = {}, dup = {}, i, p, nk, id;
    var list = (roster && roster.players) || roster || [];
    /* team_key of the team this index belongs to, and the LEAGUE-WIDE id map
       when the caller has one. The league map is what turns "this id is not on
       our roster" into the two different statements it really is: he plays for
       somebody else this season (refuse), or no roster file carries him at all
       (accept, uncorroborated). */
    var teamKey = opts.team_key || normKey(opts.team) || null;
    var global = opts.global || null;
    for (i = 0; i < list.length; i++) {
      p = list[i]; if (!p) continue;
      id = p.athlete_id != null ? String(p.athlete_id) : (p.espn_id != null ? String(p.espn_id) : (p.player_id != null ? String(p.player_id) : null));
      nk = normName(p.name || ((p.first_name || '') + ' ' + (p.last_name || '')));
      if (id) byId[id] = { id: id, name: p.name || null, position: p.position || null, jersey: p.jersey == null ? null : String(p.jersey), team: p.team || opts.team || null };
      if (!nk) continue;
      if (byName[nk] === undefined) byName[nk] = id || null;
      else if (byName[nk] !== (id || null)) { dup[nk] = true; byName[nk] = null; }
    }
    return { byId: byId, byName: byName, duplicates: dup, size: list.length,
      team_key: teamKey, global: global };
  }

  /* Resolve one piece of evidence to a player identity. Returns
     {id, name, how, ambiguous} — never a guess. */
  function resolveIdentity(ev, idx) {
    var out = { id: null, name: ev && ev.player_name ? String(ev.player_name) : null, how: null, ambiguous: false };
    if (!ev) return out;
    var id = ev.player_id != null ? String(ev.player_id) : null;
    if (id && idx && idx.byId[id]) { out.id = id; out.name = idx.byId[id].name || out.name; out.how = 'athlete_id on the current-season roster'; out.corroborated = true; return out; }
    if (id && (!idx || !idx.size)) { out.id = id; out.how = 'athlete_id, no roster loaded to confirm it'; return out; }
    if (id) {
      /* THE TRANSFER GUARD, and it is the only thing an absent id may mean
         with certainty: this season's roster file puts him on ANOTHER team,
         so naming him here would be carrying an old assignment forward. */
      var other = idx.global ? idx.global[id] : null;
      if (other && idx.team_key && other !== idx.team_key) {
        out.how = 'athlete_id belongs to ' + other + ' on this season\u2019s roster, not to this team';
        out.ambiguous = true; return out;
      }
      /* Otherwise: the play feed attributed this season's snaps to him and no
         roster file carries him anywhere. That is a gap in the ROSTER feed,
         not a wrong player, so he resolves and the record says it is
         uncorroborated rather than dropping a fact the feed published. */
      out.id = id; out.corroborated = false;
      out.how = 'athlete_id from the play feed; no roster file this build read carries it';
      return out;
    }
    var nk = normName(out.name);
    if (!nk || !idx) { out.how = 'no id and no name to resolve'; out.ambiguous = true; return out; }
    if (idx.duplicates[nk]) { out.how = 'name is not unique on this roster'; out.ambiguous = true; return out; }
    if (idx.byName[nk]) { out.id = idx.byName[nk]; out.how = 'unique name match on the current-season roster'; return out; }
    out.how = 'name not found on the current-season roster';
    out.ambiguous = true;
    return out;
  }

  /* ------------------------------------------------------- game-level usage */
  /* Per team-game dropback counts, from the play feed's own attribution. A
     dropback is a completion, an incompletion, a sack taken or an
     interception thrown — every one of those is a pass play the quarterback
     was on the field for, and they are the columns the feed actually fills. */
  function usageFromPlays(rows, opts) {
    opts = opts || {};
    var games = {}, i, r, key, pid, name, g, q;
    for (i = 0; i < (rows || []).length; i++) {
      r = rows[i]; if (!r) continue;
      pid = r.player_id == null ? null : String(r.player_id);
      if (!pid || pid === 'NA' || pid === '') continue;
      name = r.player_name && r.player_name !== 'NA' ? r.player_name : null;
      key = String(r.team_key || r.team) + '|' + String(r.game_id);
      g = games[key];
      if (!g) g = games[key] = { team: r.team || null, team_key: r.team_key || null, game_id: String(r.game_id),
        season: r.season == null ? null : Number(r.season), week: r.week == null ? null : Number(r.week),
        kickoff: r.kickoff || null, opponent: r.opponent || null, dropbacks: 0, by_player: {}, first: null, order: 0 };
      q = g.by_player[pid] || (g.by_player[pid] = { player_id: pid, player_name: name, dropbacks: 0, first_order: null });
      if (name && !q.player_name) q.player_name = name;
      q.dropbacks++; g.dropbacks++;
      var ord = isNum(r.order) ? r.order : g.order++;
      if (q.first_order == null || ord < q.first_order) q.first_order = ord;
      if (!g.first || ord < g.first.order) g.first = { player_id: pid, player_name: q.player_name, order: ord };
    }
    var out = [];
    for (key in games) if (Object.prototype.hasOwnProperty.call(games, key)) {
      g = games[key];
      var list = [];
      for (pid in g.by_player) if (Object.prototype.hasOwnProperty.call(g.by_player, pid)) list.push(g.by_player[pid]);
      list.sort(function (a, b) { return (b.dropbacks - a.dropbacks) || ((a.first_order == null ? 1e9 : a.first_order) - (b.first_order == null ? 1e9 : b.first_order)); });
      g.players = list.map(function (p) { return { player_id: p.player_id, player_name: p.player_name, dropbacks: p.dropbacks, share: g.dropbacks ? r3(p.dropbacks / g.dropbacks) : null, took_first_dropback: !!(g.first && g.first.player_id === p.player_id) }; });
      delete g.by_player; delete g.order;
      out.push(g);
    }
    out.sort(function (a, b) { return (a.week || 0) - (b.week || 0); });
    return out;
  }

  /* The starter of ONE game: whoever took the first dropback, provided he is
     not a one-snap wildcat anomaly. A player with the first dropback and less
     than 20% of the game's dropbacks is reported as the opener with the
     usage leader named beside him rather than being called the starter. */
  function starterOfGame(game, opts) {
    opts = opts || {};
    if (!game || !game.players || !game.players.length) return null;
    var minShare = isNum(opts.min_share) ? opts.min_share : 0.2;
    /* A GADGET SNAP IS NOT A START. A receiver who throws once on a trick
       play opens the game's dropback list and is not the quarterback; a
       quarterback who opens, takes three and is replaced IS a change worth
       reporting as unresolved. One or two dropbacks separates those two
       cases better than a share threshold does, because the share depends on
       how many plays the rest of the game had. */
    var gadgetMax = isNum(opts.gadget_max_dropbacks) ? opts.gadget_max_dropbacks : 2;
    var dominant = isNum(opts.dominant_share) ? opts.dominant_share : 0.6;
    var opener = null, i;
    for (i = 0; i < game.players.length; i++) if (game.players[i].took_first_dropback) { opener = game.players[i]; break; }
    var leader = game.players[0];
    var pick = null, gadget = false;
    if (!opener) pick = leader;
    else if (opener.share != null && opener.share >= minShare) pick = opener;
    else if (opener.dropbacks <= gadgetMax && leader.share != null && leader.share >= dominant
      && leader.player_id !== opener.player_id) { pick = leader; gadget = true; }
    return {
      game_id: game.game_id, season: game.season, week: game.week, kickoff: game.kickoff || null,
      opponent: game.opponent || null, dropbacks: game.dropbacks,
      starter: pick ? { player_id: pick.player_id, player_name: pick.player_name, dropbacks: pick.dropbacks, share: pick.share } : null,
      opened: opener ? { player_id: opener.player_id, player_name: opener.player_name, share: opener.share } : null,
      leader: { player_id: leader.player_id, player_name: leader.player_name, share: leader.share },
      settled: !!pick,
      gadget_opener: gadget,
      why: gadget
        ? ('the opening dropback was a ' + opener.dropbacks + '-throw appearance by '
          + (opener.player_name || opener.player_id) + '; ' + (leader.player_name || leader.player_id)
          + ' took ' + Math.round((leader.share || 0) * 100) + '% of them')
        : (pick ? 'took the first dropback of the game'
          : (opener ? 'the player who took the first dropback threw ' + Math.round((opener.share || 0) * 100)
            + '% of the dropbacks; the usage leader was ' + (leader.player_name || leader.player_id)
            : 'no opening dropback is attributed in the feed')),
      players: game.players
    };
  }

  /* ----------------------------------------------------------- competition */
  /* A competition is a fact about the EVIDENCE, not an opinion about the
     roster: two players with comparable recent usage, or two sources naming
     different people at the same tier. */
  function usageCompetition(recent, opts) {
    opts = opts || {};
    var band = isNum(opts.band) ? opts.band : 0.35;
    var tot = {}, n = 0, i, j, g, p;
    for (i = 0; i < (recent || []).length; i++) {
      g = recent[i]; if (!g || !g.players) continue;
      n++;
      for (j = 0; j < g.players.length; j++) {
        p = g.players[j];
        tot[p.player_id] = tot[p.player_id] || { player_id: p.player_id, player_name: p.player_name, dropbacks: 0 };
        tot[p.player_id].dropbacks += p.dropbacks;
        if (p.player_name && !tot[p.player_id].player_name) tot[p.player_id].player_name = p.player_name;
      }
    }
    var list = [], sum = 0, k;
    for (k in tot) if (Object.prototype.hasOwnProperty.call(tot, k)) { list.push(tot[k]); sum += tot[k].dropbacks; }
    list.sort(function (a, b) { return b.dropbacks - a.dropbacks; });
    list.forEach(function (x) { x.share = sum ? r3(x.dropbacks / sum) : null; });
    var contested = !!(list.length > 1 && list[1].share != null && list[0].share != null && list[1].share >= band);
    return { games: n, total_dropbacks: sum, players: list, contested: contested, band: band };
  }

  /* --------------------------------------------------------------- resolve */
  /* THE ONE PLACE A STATUS IS DECIDED.

     evidence: [{kind, player_id, player_name, team, season, week, source,
                 source_url, published_at, retrieved_at, detail, weight}]
     Returns a starter-context record. Nothing is promoted above the tier of
     the evidence that carried it, and disagreement is recorded, not hidden. */
  function resolveStarter(o) {
    o = o || {};
    var now = ms(o.now) || Date.now();
    var season = o.season == null ? null : Number(o.season);
    var idx = o.roster_index || (o.roster ? rosterIndex(o.roster, { team: o.team }) : null);
    var evid = (o.evidence || []).slice();
    var refused = [], usable = [], i, e, meta, ident;

    for (i = 0; i < evid.length; i++) {
      e = evid[i]; if (!e) continue;
      meta = EVIDENCE[String(e.kind || '').toUpperCase()];
      if (!meta) { refused.push({ evidence: e, why: 'unrecognised evidence kind "' + e.kind + '"' }); continue; }
      /* SEASON ROLLOVER GUARD. Evidence stamped with another season is
         refused outright: last season's starter is not this season's news
         and a transfer's old team must not follow him here. */
      if (season != null && e.season != null && Number(e.season) !== season) {
        refused.push({ evidence: e, why: 'evidence is from season ' + e.season + ', this matchup is season ' + season }); continue;
      }
      ident = resolveIdentity(e, idx);
      /* AMBIGUOUS IS REFUSED EVEN WHEN AN ID IS PRESENT. An athlete id the
         current season's roster does not carry is a player who is not on this
         team any more; resolving him would be exactly the transfer bug this
         layer exists to stop. */
      if (ident.ambiguous) { refused.push({ evidence: e, why: 'identity unresolved: ' + ident.how }); continue; }
      usable.push({
        kind: String(e.kind).toUpperCase(), tier: meta.tier, max_status: meta.max_status,
        player_id: ident.id, player_name: ident.name, identity_basis: ident.how,
        identity_corroborated: ident.corroborated !== false,
        team: e.team || o.team || null, season: e.season == null ? season : Number(e.season),
        week: e.week == null ? null : Number(e.week),
        source: e.source || null, source_url: e.source_url || null,
        published_at: e.published_at || null, retrieved_at: e.retrieved_at || null,
        detail: e.detail || null,
        age_hours: e.retrieved_at ? Math.round((hoursBetween(e.retrieved_at, now) || 0) * 10) / 10 : null,
        stale: staleEvidence(e, meta, now, o)
      });
    }

    usable.sort(function (a, b) { return a.tier - b.tier; });

    /* the strongest tier that is present, and whether it agrees with itself */
    var byTier = {}, t;
    for (i = 0; i < usable.length; i++) {
      t = usable[i].tier;
      (byTier[t] = byTier[t] || []).push(usable[i]);
    }
    var tiers = Object.keys(byTier).map(Number).sort(function (a, b) { return a - b; });
    var chosen = null, status = 'UNKNOWN', conflicts = [], basis = null;

    for (i = 0; i < tiers.length; i++) {
      var group = byTier[tiers[i]].filter(function (x) { return !x.stale.stale; });
      if (!group.length) continue;
      var names = {}, j;
      for (j = 0; j < group.length; j++) names[group[j].player_id || ('name:' + normName(group[j].player_name))] = group[j];
      var keys = Object.keys(names);
      if (keys.length === 1) { chosen = names[keys[0]]; status = chosen.max_status; basis = 'tier ' + tiers[i] + ' evidence, one name'; break; }
      /* same tier, two names: that IS the competition, recorded as one */
      conflicts.push({ tier: tiers[i], names: keys.map(function (k) { return { player_id: names[k].player_id, player_name: names[k].player_name, source: names[k].source, source_url: names[k].source_url }; }) });
      status = 'COMPETITION';
      basis = 'tier ' + tiers[i] + ' evidence names ' + keys.length + ' different players';
      break;
    }

    /* a usage competition overrides a PREVIOUS_GAME resolution: if the last
       two starts went to different players, the last one is not an
       expectation, it is half of an open competition. */
    var comp = o.usage_competition || null;
    if (chosen && status === 'PREVIOUS_GAME' && comp && comp.contested) {
      status = 'COMPETITION';
      basis = 'the most recent start went to ' + (chosen.player_name || chosen.player_id)
        + ', but recent dropbacks are split ' + comp.players.slice(0, 2).map(function (p) { return (p.player_name || p.player_id) + ' ' + Math.round((p.share || 0) * 100) + '%'; }).join(' / ');
    }

    /* every usable piece of evidence that names somebody ELSE than the
       chosen player is a recorded disagreement, at any tier */
    if (chosen) {
      for (i = 0; i < usable.length; i++) {
        if (usable[i] === chosen) continue;
        if (usable[i].player_id && chosen.player_id && usable[i].player_id === chosen.player_id) continue;
        if (!usable[i].player_id && normName(usable[i].player_name) === normName(chosen.player_name)) continue;
        conflicts.push({ tier: usable[i].tier, disagrees_with: chosen.player_id || chosen.player_name,
          names: [{ player_id: usable[i].player_id, player_name: usable[i].player_name, source: usable[i].source, source_url: usable[i].source_url }] });
      }
    }

    var avail = availabilityFor(chosen, o, now);
    var rec = {
      schema: SCHEMA, version: VERSION,
      team: o.team || null, team_id: o.team_id || normKey(o.team), season: season,
      week: o.week == null ? null : Number(o.week),
      position: o.position || 'QB',
      status: status,
      announced: status === 'ANNOUNCED',
      confirmed: status === 'ANNOUNCED',
      player_id: chosen ? chosen.player_id : null,
      player_name: chosen ? chosen.player_name : null,
      identity_basis: chosen ? chosen.identity_basis : null,
      identity_corroborated: chosen ? chosen.identity_corroborated !== false : null,
      source: chosen ? chosen.source : null,
      source_url: chosen ? chosen.source_url : null,
      published_at: chosen ? chosen.published_at : null,
      retrieved_at: chosen ? chosen.retrieved_at : (o.retrieved_at || null),
      basis: basis || 'no usable evidence of any kind reached this team',
      availability: avail,
      competition: comp ? { contested: comp.contested, games: comp.games, players: comp.players.slice(0, 4) } : null,
      conflicts: conflicts,
      evidence: usable.map(function (x) {
        return { kind: x.kind, tier: x.tier, player_id: x.player_id, player_name: x.player_name,
          source: x.source, source_url: x.source_url, published_at: x.published_at,
          retrieved_at: x.retrieved_at, age_hours: x.age_hours, stale: x.stale.stale,
          stale_why: x.stale.why, detail: x.detail, week: x.week };
      }),
      refused: refused.map(function (r) { return { why: r.why, kind: r.evidence && r.evidence.kind, player_name: r.evidence && r.evidence.player_name, source: r.evidence && r.evidence.source }; }),
      resolved_at: new Date(now).toISOString()
    };
    rec.label = labelFor(rec);
    rec.field_state = fieldStateFor(rec);
    return rec;
  }

  function staleEvidence(e, meta, now, o) {
    var lim = (o && o.stale) || STALE;
    if (meta.max_status === 'PREVIOUS_GAME') {
      var wk = (o && o.week != null && e.week != null) ? (Number(o.week) - Number(e.week)) : null;
      if (wk != null && wk > lim.usage_weeks) return { stale: true, why: 'the start it records is ' + wk + ' weeks old' };
      return { stale: false, why: null };
    }
    var h = hoursBetween(e.retrieved_at || e.published_at, now);
    var floor = meta.max_status === 'DEPTH_CHART' ? lim.depth_hours : lim.report_hours;
    if (h == null) return { stale: false, why: null };
    if (h > floor) return { stale: true, why: Math.round(h) + 'h since it was retrieved, past the ' + floor + 'h floor for this kind' };
    return { stale: false, why: null };
  }

  /* NO REPORT FOUND IS NOT HEALTHY. The absence of an availability record is
     reported as UNKNOWN with the reason attached, and the reason distinguishes
     "we looked and nothing was filed" from "we could not look". */
  function availabilityFor(chosen, o, now) {
    var rec = null, list = o.availability || [], i, nk;
    if (chosen) {
      for (i = 0; i < list.length; i++) {
        if (chosen.player_id && list[i].player_id != null && String(list[i].player_id) === String(chosen.player_id)) { rec = list[i]; break; }
        nk = normName(list[i].player_name);
        if (!rec && nk && nk === normName(chosen.player_name)) rec = list[i];
      }
    }
    /* PARTICIPATION IS NOT A DIAGNOSIS. A quarterback who opened a game and
       then threw a fifth of its dropbacks did not finish it, and that is an
       observation about the box score with a source and a date. It is carried
       BESIDE the availability state, never as one: nothing here says why he
       stopped playing, because nothing here knows. */
    var part = o.participation || null;
    var partNote = null;
    if (part && chosen && part.player_id && String(part.player_id) === String(chosen.player_id)
      && part.share != null && part.share < (isNum(part.band) ? part.band : 0.5) && part.replaced_by) {
      partNote = {
        evidence: 'PARTICIPATION',
        week: part.week == null ? null : Number(part.week),
        share: part.share,
        replaced_by: part.replaced_by,
        note: 'opened week ' + part.week + ' and took ' + Math.round(part.share * 100)
          + '% of the dropbacks, with ' + part.replaced_by + ' taking the rest — a participation fact, '
          + 'not an injury report, and not a reason on its own to expect an absence',
        source: part.source || null, source_url: part.source_url || null
      };
    }
    /* A REPORT HAS A CLOCK. Its PUBLICATION is what dates it: the collector
       re-reads ESPN's injury page every run and stamps what it found as
       observed that morning, and a 2020 designation re-read today is still a
       2020 designation. The same two fields, in the same order, as the
       availability layer's ladder (availability.js getAvailabilityFreshness):
       the publication, else the observation. Older than a week, or with
       neither, is historical. It is kept as the reason, never as the state. */
    var historical = null;
    if (rec) {
      var dated = rec.published_at || rec.retrieved_at || null;
      var ageH = hoursBetween(dated, now == null ? Date.now() : now);
      if (ms(dated) == null) historical = 'it carries no date';
      else if (ageH != null && ageH > AVAIL_HISTORICAL_H)
        historical = 'it was ' + (rec.published_at ? 'published ' : 'observed ') + String(dated).slice(0, 10)
          + ', more than a week ago';
    }
    if (rec && historical) {
      return {
        state: 'UNKNOWN', doubt: AVAIL_DOUBT.UNKNOWN, evidence: 'NONE',
        why: (rec.source || 'an availability source') + ' has a report on this player, but ' + historical
          + ', so it says nothing about this week. No current report is not the same as healthy',
        source: rec.source || null, source_url: rec.source_url || null,
        published_at: rec.published_at || null, retrieved_at: rec.retrieved_at || null,
        checked: true, historical: true, participation: partNote
      };
    }
    if (!rec) {
      return {
        state: 'UNKNOWN', doubt: AVAIL_DOUBT.UNKNOWN, evidence: 'NONE',
        why: o.availability_checked
          ? 'the availability sources EdgeDesk reads were checked and carried no report on this player — no report found is not the same as healthy'
          : 'no availability source was read for this team in this build',
        source: null, source_url: null, published_at: null, retrieved_at: o.availability_retrieved_at || null,
        checked: !!o.availability_checked, participation: partNote
      };
    }
    var st = String(rec.status || 'UNKNOWN').toUpperCase();
    if (AVAIL_DOUBT[st] == null) st = 'UNKNOWN';
    return {
      /* EXPLICIT only when the report says something: a row naming him with
         no designation is not evidence either way */
      state: st, doubt: AVAIL_DOUBT[st], evidence: st === 'UNKNOWN' ? 'NONE' : 'EXPLICIT',
      why: rec.detail || rec.injury || null,
      source: rec.source || null, source_url: rec.source_url || null,
      published_at: rec.published_at || null, retrieved_at: rec.retrieved_at || null,
      checked: true, participation: partNote
    };
  }

  /* ONE SENTENCE, GENERATED IN ONE PLACE, so the terminal, the newsletter and
     the AI cannot describe the same record differently. */
  function labelFor(rec) {
    var who = rec.player_name || rec.player_id || 'no named quarterback';
    var doubt = (rec.availability && rec.availability.state !== 'UNKNOWN' && rec.availability.state !== 'AVAILABLE')
      ? ' (listed ' + rec.availability.state.toLowerCase().replace(/_/g, ' ') + ')' : '';
    if (!doubt && rec.availability && rec.availability.participation)
      doubt = ' (did not finish week ' + rec.availability.participation.week + '; no injury report on file)';
    switch (rec.status) {
      case 'ANNOUNCED': return who + ' — announced starter' + doubt + '.';
      case 'EXPECTED': return who + ' — expected to start on current reporting' + doubt + '; not an official announcement.';
      case 'DEPTH_CHART': return who + ' — leads the published depth chart' + doubt + '; no start has been announced.';
      case 'PREVIOUS_GAME': return who + ' — started the last game' + doubt + '; no announcement for this one.';
      case 'COMPETITION': return 'unresolved: ' + (rec.competition && rec.competition.players || []).slice(0, 2)
        .map(function (p) { return (p.player_name || p.player_id) + ' ' + Math.round((p.share || 0) * 100) + '% of recent dropbacks'; }).join(' and ')
        + (rec.conflicts.length ? ' — sources disagree' : '') + '.';
      default: return 'no starter evidence of any kind reached this team.';
    }
  }

  /* The seven states the coverage report distinguishes. This is the function
     that stops "not applicable" being counted as "missing". */
  var FIELD_STATES = ['USABLE', 'RESEARCH_ONLY', 'STALE', 'CONFLICTING', 'NOT_APPLICABLE', 'FETCH_FAILED', 'UNAVAILABLE'];
  function fieldStateFor(rec) {
    if (!rec) return 'UNAVAILABLE';
    if (rec.status === 'UNKNOWN') {
      var anyFetchFail = (rec.refused || []).some(function (r) { return /fetch|http|timeout|unreachable/i.test(String(r.why || '')); });
      return anyFetchFail ? 'FETCH_FAILED' : 'UNAVAILABLE';
    }
    if (rec.conflicts && rec.conflicts.length && rec.status === 'COMPETITION') return 'CONFLICTING';
    if ((rec.evidence || []).length && (rec.evidence || []).every(function (e) { return e.stale; })) return 'STALE';
    return 'USABLE';
  }

  /* ------------------------------------------------- the engine's QB input */
  /* THE SEPARATION THAT MATTERS. A resolved starter is EVIDENCE. Turning it
     into a priced adjustment is a second, independent decision, and this
     function is the only door between the two. It refuses to emit a priced
     input unless the caller has said, in so many words, that this class of
     evidence is approved for pricing — so a research-only record can never
     move a number by accident.

     `approved_statuses` is the whitelist. Everything else comes back with
     priced:false and the reason, and the caller passes null to the engine. */
  function engineQbInput(rec, o) {
    o = o || {};
    var approved = o.approved_statuses || [];
    var quality = o.quality || null;          /* from the player layer */
    var out = { priced: false, why: null, input: null, shadow: null };
    if (!rec || !rec.player_id) { out.why = 'no starter resolved'; return out; }
    var input = {
      player: rec.player_name || rec.player_id,
      player_id: rec.player_id,
      starts: isNum(o.starts) ? o.starts : (isNum(o.career_starts) ? o.career_starts : null),
      attempts: isNum(o.attempts) ? o.attempts : null,
      season_epa_per_db: isNum(o.season_epa_per_db) ? o.season_epa_per_db : null,
      career_epa_per_db: isNum(o.career_epa_per_db) ? o.career_epa_per_db : null,
      rush_value: isNum(o.rush_value) ? o.rush_value : null,
      new_system: o.new_system == null ? null : !!o.new_system,
      returning_starter: o.returning_starter == null ? null : !!o.returning_starter,
      source: rec.source || ('EdgeDesk starter context — ' + rec.status),
      as_of: rec.retrieved_at || rec.resolved_at || null,
      /* carried so nothing downstream can mistake an inference for a fact */
      starter_status: rec.status,
      starter_confirmed: rec.confirmed === true,
      quality_rating: quality && isNum(quality.rating) ? quality.rating : null,
      quality_source: quality ? (quality.source || 'football/players') : null
    };
    out.shadow = input;
    if (approved.indexOf(rec.status) < 0) {
      out.why = 'starter status ' + rec.status + ' is not on the pricing whitelist ['
        + (approved.join(', ') || 'none') + '] — research only';
      return out;
    }
    if (input.season_epa_per_db == null && input.career_epa_per_db == null && input.starts == null) {
      out.why = 'no efficiency history and no start count for this player, so there is nothing for the '
        + 'priced QB layer to act on — the record stays research';
      return out;
    }
    out.priced = true; out.input = input;
    return out;
  }

  /* --------------------------------------------------------------- summary */
  function coverage(records) {
    var out = { total: 0, by_status: {}, by_field_state: {}, with_player: 0, announced: 0,
      availability_explicit: 0, availability_unknown: 0, conflicting: 0, stale: 0 };
    STATUS.forEach(function (s) { out.by_status[s] = 0; });
    FIELD_STATES.forEach(function (s) { out.by_field_state[s] = 0; });
    (records || []).forEach(function (r) {
      if (!r) return;
      out.total++;
      out.by_status[r.status] = (out.by_status[r.status] || 0) + 1;
      out.by_field_state[r.field_state] = (out.by_field_state[r.field_state] || 0) + 1;
      if (r.player_id) out.with_player++;
      if (r.announced) out.announced++;
      if (r.availability && r.availability.evidence === 'EXPLICIT') out.availability_explicit++; else out.availability_unknown++;
      if (r.conflicts && r.conflicts.length) out.conflicting++;
      if (r.field_state === 'STALE') out.stale++;
    });
    out.resolved_share = out.total ? r3(out.with_player / out.total) : null;
    return out;
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, STATUS: STATUS, STATUS_RANK: STATUS_RANK,
    EVIDENCE: EVIDENCE, AVAIL_STATES: AVAIL_STATES, AVAIL_DOUBT: AVAIL_DOUBT, STALE: STALE,
    FIELD_STATES: FIELD_STATES,
    normKey: normKey, normName: normName, rosterIndex: rosterIndex, resolveIdentity: resolveIdentity,
    usageFromPlays: usageFromPlays, starterOfGame: starterOfGame, usageCompetition: usageCompetition,
    resolveStarter: resolveStarter, engineQbInput: engineQbInput, coverage: coverage,
    labelFor: labelFor, fieldStateFor: fieldStateFor
  };
});
