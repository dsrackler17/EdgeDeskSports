/* ============================================================================
   EDGEDESK NON-QB PERSONNEL AVAILABILITY — THE SCORING CORE.

   THE QUESTION. Not "is he a starter" but: how much worse is this team with
   the expected replacement playing instead of the missing player? So every
   absence is scored from seven things, and each is kept visible:

     player quality        what the missing player is, on a declared scale
     replacement quality   what the likely replacement is, and how sure we are
     usage                 how much of the game the missing player plays
     position leverage     a configurable prior on how much the slot matters
     matchup leverage      the same absence against THIS opponent, measured
     unit concentration    several absences in one unit are nonlinear
     confidence            how much of the above was actually evidenced

       replacement_gap = player_quality - replacement_quality
       raw_impact      = max(0, gap / scale_sd) x usage x position_leverage
                           x matchup_leverage x unit_concentration
       impact_if_absent = round(100 x (1 - exp(-raw / scale)))      0-100
       expected_impact  = impact_if_absent x probability_of_absence

   WHAT IT NEVER DOES.
     * Move a projection. projectionAdjustment() returns 0 and every output
       carries projection_adjustment: 0. No configuration can change that;
       the lock is a constant in this file, not a setting.
     * Invent a number. Missing quality, usage or matchup evidence stays null
       and costs confidence. The one bound used when a replacement is
       unmeasured is the rating SCALE's own replacement level (EPIR is
       anchored so 50 IS positional replacement), and the replacement's
       quality field stays null when it is used.
     * Score the quarterback. He is priced by the trained QB layer.
     * Read a clock, a file or the network. Same input, same output.

   INPUT (one team, one fixture) — built by football/personnel/adapters.js:
     { team_id, team_name, sport, side,
       coverage: { grade, graded, comprehensive, official, source, as_of },
       absences: [{ player_id, player_name, position, slot?, slot_depth?,
                    depth_group?, status, source:{name,type,tier,url,
                    published_at,freshness},
                    quality:{value,basis,confidence,sample,scale,source}|null,
                    usage:{value,basis,role,source}|null,
                    replacement:{...candidate, basis}|null }],
       depth: { <GROUP>: { basis, players:[{ player_id, player_name,
                    quality, usage, order_basis }] } },
       opponent: { team_id, team_name, metrics:{ <id>:{z,reliability,label} },
                   source, as_of } }

   Node (module.exports) and browser (window.EDPersonnelImpact).
   ========================================================================== */
(function (root, factory) {
  var cfg = (typeof module === 'object' && module && module.exports)
    ? require('./config.js') : root.EDPersonnelConfig;
  var api = factory(cfg);
  root.EDPersonnelImpact = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (DEFAULT_CFG) {
  'use strict';

  /* THE LOCK. Not configuration: a constant. The injury coefficient is
     untrained, so the projection adjustment is exactly zero. */
  var PROJECTION_ADJUSTMENT = 0;
  function projectionAdjustment() { return PROJECTION_ADJUSTMENT; }

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function rd(x, d) {
    if (!num(x)) return null;
    var m = Math.pow(10, d), v = Math.round(x * m) / m;
    return v === 0 ? 0 : v;
  }
  function key(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function nameKey(s) {
    if (s == null) return null;
    var v = String(s).trim().toLowerCase();
    try { v = v.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return v.replace(/[^a-z0-9]+/g, '') || null;
  }
  /* "Alabama's", "Texas'" */
  function poss(n) { return /s$/i.test(String(n)) ? n + '\u2019' : n + '\u2019s'; }
  function idOf(p) {
    if (!p) return null;
    if (p.player_id != null && p.player_id !== '') return 'id:' + String(p.player_id);
    var n = nameKey(p.player_name);
    return n ? 'name:' + n : null;
  }

  /* ------------------------------------------------------------------ */
  function makeCore(CFG) {
    if (!CFG) throw new Error('EDPersonnelImpact: no configuration loaded (football/personnel/config.js)');

    function classify(score) {
      if (!num(score)) return null;
      for (var i = 0; i < CFG.CLASSIFICATION.length; i++) {
        if (score >= CFG.CLASSIFICATION[i].min) return CFG.CLASSIFICATION[i].label;
      }
      return CFG.CLASSIFICATION[CFG.CLASSIFICATION.length - 1].label;
    }

    function normalize(raw, which) {
      if (!num(raw)) return null;
      var sc = CFG.NORMALIZATION[which || 'player'].scale;
      return Math.round(100 * (1 - Math.exp(-Math.max(0, raw) / sc)));
    }

    function normalizeStatus(raw) {
      var k = key(raw);
      var s = CFG.STATUS_ALIASES[k];
      if (!s) {
        if (/OUTFIRSTHALF|OUT1STHALF/.test(k)) s = 'OUT_FIRST_HALF';
        else if (/^OUT|SUSPEND|INJUREDRESERVE|FORSEASON/.test(k)) s = 'OUT';
        else if (/DOUBT/.test(k)) s = 'DOUBTFUL';
        else if (/GAMETIME|GTD/.test(k)) s = 'GAME_TIME_DECISION';
        else if (/QUESTION|DAYTODAY/.test(k)) s = 'QUESTIONABLE';
        else if (/LIMITED|SNAPCOUNT/.test(k)) s = 'LIMITED';
        else if (/PROBABLE|LIKELY/.test(k)) s = 'PROBABLE';
        else if (/EXPECTED/.test(k)) s = 'EXPECTED';
        else if (/AVAILABLE|ACTIVE|CLEARED/.test(k)) s = 'AVAILABLE';
        else s = 'UNKNOWN';
      }
      var d = CFG.STATUS[s];
      return { status: s, p: d.p, clarity: d.clarity, label: d.label, basis: d.basis || null };
    }

    /* the base slot a spelling names, before WR1/CB1 is resolved */
    function baseSlot(raw) {
      var k = key(raw);
      return k ? (CFG.POSITION_ALIASES[k] || null) : null;
    }

    function usageBand(u) {
      if (!num(u)) return null;
      for (var i = 0; i < CFG.USAGE.bands.length; i++) if (u >= CFG.USAGE.bands[i].min) return CFG.USAGE.bands[i].label;
      return null;
    }

    function qualityOf(q) {
      if (!q || !num(q.value)) return { value: null, basis: q && q.basis ? q.basis : null, confidence: null, accepted: false };
      var b = CFG.QUALITY_BASES[q.basis];
      var accepted = !!(b && b.accepted);
      return { value: accepted ? q.value : null, basis: q.basis || null,
        confidence: accepted && num(q.confidence) ? clamp(q.confidence, 0, 1) : null,
        accepted: accepted, scale: q.scale || null, sample: num(q.sample) ? q.sample : null,
        source: q.source || null, rating_on_file: accepted ? null : q.value };
    }

    function usageOf(u) {
      if (!u || !num(u.value)) return { value: null, basis: u && u.basis ? u.basis : null, confidence: 0 };
      var b = CFG.USAGE.bases[u.basis];
      return { value: clamp(u.value, 0, 1), basis: u.basis || null, confidence: b ? b.confidence : 0,
        role: u.role || null, source: u.source || null };
    }

    function matchupLeverage(slotCfg, opponent) {
      var drivers = (slotCfg && slotCfg.matchup) || [];
      if (!drivers.length) {
        return { value: null, applicable: false, drivers: [], missing: [],
          basis: slotCfg ? slotCfg.matchup_basis : null };
      }
      var mets = (opponent && opponent.metrics) || {};
      var M = CFG.MATCHUP, s = 0, sw = 0, tot = 0, rel = 0, used = [], missing = [];
      drivers.forEach(function (d) {
        tot += d.w;
        var m = mets[d.metric];
        var z = m && num(m.z) ? m.z : null;
        if (z == null) { missing.push(d.metric); return; }
        var zc = clamp(z, -M.z_cap, M.z_cap);
        var r = num(m.reliability) ? clamp(m.reliability, 0, 1) : 1;
        s += d.w * d.sign * zc; sw += d.w; rel += d.w * r;
        used.push({ metric: d.metric, label: m.label || null, z: rd(z, 3), z_used: rd(zc, 3),
          sign: d.sign, w: d.w, reliability: rd(r, 3) });
      });
      if (!sw) {
        return { value: null, applicable: true, drivers: used, missing: missing,
          basis: 'the opponent’s ' + missing.join(', ') + ' is not measured; no matchup multiplier applied' };
      }
      var v = clamp(1 + M.slope_per_sd * s / sw, M.range[0], M.range[1]);
      return { value: rd(v, 3), applicable: true, drivers: used, missing: missing,
        coverage: rd(sw / tot, 3), reliability: rd(rel / sw, 3), basis: slotCfg.matchup_basis };
    }

    function concentrationMultiplier(count) {
      var t = CFG.CONCENTRATION.table;
      if (!num(count) || count <= t[0].count) return t[0].multiplier;
      for (var i = 1; i < t.length; i++) {
        if (count <= t[i].count) {
          var a = t[i - 1], b = t[i];
          return a.multiplier + (b.multiplier - a.multiplier) * (count - a.count) / (b.count - a.count);
        }
      }
      return t[t.length - 1].multiplier;
    }

    function sourceScore(src) {
      var C = CFG.CONFIDENCE;
      var tier = src && src.tier != null ? C.source_tier[src.tier] : null;
      var t = num(tier) ? tier : C.source_tier_unknown;
      var f = src && src.freshness && num(C.freshness[String(src.freshness).toUpperCase()])
        ? C.freshness[String(src.freshness).toUpperCase()] : 1;
      return t * f;
    }

    /* ---------------------------------------------------------------- */
    function locate(team, row) {
      var depth = team.depth || {};
      var want = idOf(row);
      var groups = row.depth_group ? [row.depth_group] : Object.keys(depth).sort();
      for (var g = 0; g < groups.length; g++) {
        var grp = depth[groups[g]];
        if (!grp || !grp.players) continue;
        for (var i = 0; i < grp.players.length; i++) {
          if (want && idOf(grp.players[i]) === want) return { group: groups[g], rank: i + 1, entry: grp.players[i] };
        }
      }
      return { group: row.depth_group || null, rank: num(row.depth_rank) ? row.depth_rank : null, entry: null };
    }

    function resolveSlot(row, loc) {
      var base = baseSlot(row.slot) || baseSlot(row.position) || baseSlot(loc.group);
      if (!base) return { base: null, slot: null, cfg: null };
      if (base === 'QB') return { base: 'QB', slot: 'QB', cfg: null };
      var slot = base;
      if (CFG.PRIMARY_SLOT[base] && loc.rank === 1) slot = CFG.PRIMARY_SLOT[base];
      return { base: base, slot: slot, cfg: CFG.POSITIONS[slot] || null };
    }

    function labelOf(row, sl, loc) {
      var explicit = row.slot ? key(row.slot) : null;
      if (explicit && CFG.POSITION_ALIASES[explicit]) {
        return explicit + (num(row.slot_depth) ? row.slot_depth : '');
      }
      var pk = key(row.position);
      var base = pk && CFG.POSITION_ALIASES[pk] ? pk : (sl.cfg ? sl.cfg.label : (pk || '?'));
      return base + (num(loc.rank) ? loc.rank : '');
    }

    /* ---------------------------------------------------------------- */
    function assessTeam(team, ctx) {
      team = team || {};
      ctx = ctx || {};
      var C = CFG.CONFIDENCE, R = CFG.REPLACEMENT;
      var cov = team.coverage || {};
      var out = {
        team_id: team.team_id == null ? null : String(team.team_id),
        team_name: team.team_name || null,
        side: team.side || null,
        opponent_id: team.opponent && team.opponent.team_id != null ? String(team.opponent.team_id) : null,
        opponent_name: team.opponent ? team.opponent.team_name || null : null,
        coverage: { grade: cov.grade || 'NONE', graded: cov.graded === true, official: cov.official === true,
          comprehensive: cov.comprehensive === true, source: cov.source || null, as_of: cov.as_of || null },
        status: null, impact: null, impact_if_all_absent: null, classification: null, confidence: null,
        absences: [], unrated: [], excluded: [], cleared: [], duplicates: [], units: [],
        unit_concern: null, key_losses: [],
        notes: (team.notes || []).slice(),
        inputs: team.inputs || null,
        projection_adjustment: PROJECTION_ADJUSTMENT
      };

      /* ---- 1. normalise, de-duplicate, exclude ---- */
      var rows = (team.absences || []).map(function (r, i) {
        var st = normalizeStatus(r.status);
        return { row: r, st: st, i: i, id: idOf(r),
          tier: r.source && num(r.source.tier) ? r.source.tier : 9,
          at: Date.parse((r.source && (r.source.published_at || r.source.observed_at)) || '') || 0 };
      });
      /* one athlete, one effect: highest tier, then newest, then input order */
      rows.sort(function (a, b) { return a.tier - b.tier || b.at - a.at || a.i - b.i; });
      var seen = {}, live = [];
      rows.forEach(function (x) {
        if (x.id && seen[x.id]) {
          out.duplicates.push({ player_id: x.row.player_id || null, player_name: x.row.player_name || null,
            status: x.st.status, note: 'duplicate report for the same athlete; the higher-tier/newer report was kept' });
          return;
        }
        if (x.id) seen[x.id] = true;
        var b = baseSlot(x.row.slot) || baseSlot(x.row.position);
        if (b && CFG.EXCLUDED_POSITIONS[b]) {
          out.excluded.push({ player_id: x.row.player_id || null, player_name: x.row.player_name || null,
            position: x.row.position || null, status: x.st.status, reason: CFG.EXCLUDED_POSITIONS[b] });
          return;
        }
        if (x.st.p === 0) {
          out.cleared.push({ player_id: x.row.player_id || null, player_name: x.row.player_name || null,
            position: x.row.position || null, status: x.st.status });
          return;
        }
        live.push(x);
      });

      /* probability map for blocking replacements and concentration */
      var pOf = {};
      live.forEach(function (x) { if (x.id) pOf[x.id] = x.st.p; });

      /* ---- 2. locate, resolve slot and unit ---- */
      live.forEach(function (x) {
        x.loc = locate(team, x.row);
        x.sl = resolveSlot(x.row, x.loc);
        x.unit = x.sl.cfg ? x.sl.cfg.unit : null;
      });

      /* ---- 3. replacement chain: starters pick first, nobody is used twice ---- */
      var order = live.slice().sort(function (a, b) {
        var ga = String(a.loc.group || ''), gb = String(b.loc.group || '');
        if (ga !== gb) return ga < gb ? -1 : 1;
        var ra = num(a.loc.rank) ? a.loc.rank : 1e9, rb = num(b.loc.rank) ? b.loc.rank : 1e9;
        return ra - rb || a.i - b.i;
      });
      var assigned = {};
      order.forEach(function (x) {
        if (x.row.replacement) {
          x.rep = { entry: x.row.replacement, basis: x.row.replacement.basis || 'SUPPLIED' };
          var sid = idOf(x.row.replacement); if (sid) assigned[sid] = true;
          return;
        }
        var grp = x.loc.group && team.depth ? team.depth[x.loc.group] : null;
        if (!grp || !grp.players || !grp.players.length) { x.rep = null; return; }
        var slots = R.starter_slots[key(x.loc.group)] || R.starter_slots[x.sl.base] || 1;
        var start = num(x.loc.rank) ? Math.max(slots, x.loc.rank) : slots;
        x.rep = null;
        for (var i = start; i < grp.players.length; i++) {
          var c = grp.players[i], cid = idOf(c);
          if (!cid || cid === x.id || assigned[cid]) continue;
          if (num(pOf[cid]) && pOf[cid] >= R.blocking_probability) continue;
          x.rep = { entry: c, basis: c.order_basis || grp.basis || 'ROSTER_RATING_RANK', depth_rank: i + 1 };
          assigned[cid] = true;
          break;
        }
      });

      /* ---- 4. score each absence ---- */
      live.forEach(function (x) {
        var r = x.row, st = x.st, sl = x.sl;
        var missing = [], notes = [];
        var q = qualityOf(r.quality || (x.loc.entry && x.loc.entry.quality));
        var u = usageOf(r.usage || (x.loc.entry && x.loc.entry.usage));
        var scaleName = (r.quality && r.quality.scale) || (x.loc.entry && x.loc.entry.quality && x.loc.entry.quality.scale) || null;
        var scale = scaleName ? CFG.RATING_SCALES[scaleName] : null;

        /* replacement */
        var repEntry = x.rep ? x.rep.entry : null;
        var rq = repEntry ? qualityOf(repEntry.quality) : { value: null, accepted: false, confidence: null };
        var ru = repEntry ? usageOf(repEntry.usage) : null;
        var repConf = 0;
        if (repEntry) {
          repConf = (R.basis_confidence[x.rep.basis] != null ? R.basis_confidence[x.rep.basis] : R.basis_confidence.ROSTER_RATING_RANK)
            * (ru && num(ru.value) ? 1 : R.unmeasured_candidate_factor);
        }

        /* the gap */
        var gap = null, gapBasis = null;
        if (q.value == null) {
          missing.push('player_quality');
        } else if (rq.value != null) {
          gap = q.value - rq.value; gapBasis = 'MEASURED_REPLACEMENT';
        } else if (R.unknown_gap_policy === 'SCALE_REPLACEMENT_LEVEL' && scale && num(scale.replacement_level)) {
          gap = q.value - scale.replacement_level;
          gapBasis = 'SCALE_REPLACEMENT_LEVEL';
          notes.push(repEntry
            ? 'the replacement’s own quality is unmeasured, so the gap is taken to the '
              + scaleName + ' scale’s replacement level (' + scale.replacement_level + ')'
            : 'no replacement could be identified, so the gap is taken to the ' + scaleName
              + ' scale’s replacement level (' + scale.replacement_level + ')');
        } else {
          missing.push('replacement_quality');
        }
        if (!repEntry) missing.push('replacement');
        var gapSd = gap != null && scale && num(scale.sd) ? gap / scale.sd : null;
        if (gap != null && gapSd == null) missing.push('rating_scale');
        if (gap != null && gap < 0) notes.push('the replacement rates above the missing player; the absence costs nothing on quality');

        if (u.value == null) missing.push('usage');
        var lev = sl.cfg ? sl.cfg.leverage.prior : null;
        if (lev == null) missing.push('position');
        var mu = sl.cfg ? matchupLeverage(sl.cfg, team.opponent) : { value: null, applicable: false, drivers: [], missing: [] };
        if (mu.applicable && mu.value == null) missing.push('matchup');

        /* concentration: 1 + the OTHER same-unit absences' probabilities */
        var cnt = 1, unknownOthers = 0;
        live.forEach(function (y) {
          if (y === x || !x.unit || y.unit !== x.unit) return;
          if (num(y.st.p)) cnt += y.st.p; else unknownOthers++;
        });
        var conc = x.unit ? concentrationMultiplier(cnt) : 1;
        if (unknownOthers) notes.push(unknownOthers + ' other ' + (CFG.UNITS[x.unit] || {}).label
          + ' listing(s) have no designation and are not counted toward concentration');

        var rated = gapSd != null && u.value != null && lev != null;
        var raw = rated ? Math.max(0, gapSd) * u.value * lev * (mu.value != null ? mu.value : 1) * conc : null;
        var impact = rated ? normalize(raw, 'player') : null;
        var expected = impact != null && num(st.p) ? Math.round(impact * st.p) : null;

        /* confidence */
        var W = C.weights, dims = {}, wsum = 0, csum = 0;
        dims.status = st.clarity * sourceScore(r.source);
        dims.player_quality = q.value != null ? (num(q.confidence) ? q.confidence : 0.5) : 0;
        dims.replacement = repEntry
          ? repConf * (rq.value != null ? (num(rq.confidence) ? rq.confidence : 0.5) : C.replacement_unmeasured)
          : 0;
        dims.usage = u.value != null ? u.confidence : 0;
        if (mu.applicable) dims.matchup = mu.value != null ? (mu.coverage || 0) * (mu.reliability || 0) : 0;
        dims.position = sl.cfg ? (sl.cfg.resolved === false ? C.unresolved_position : 1) : 0;
        Object.keys(dims).forEach(function (d) { wsum += W[d]; csum += W[d] * dims[d]; });
        var conf = wsum ? Math.round(100 * csum / wsum) : 0;
        Object.keys(dims).forEach(function (d) { dims[d] = rd(dims[d], 3); });

        var a = {
          player_id: r.player_id == null ? null : String(r.player_id),
          player_name: r.player_name || null,
          label: labelOf(r, sl, x.loc),
          position: r.position || null,
          slot: sl.slot,
          unit: x.unit,
          unit_label: x.unit ? CFG.UNITS[x.unit].label : null,
          depth_group: x.loc.group,
          depth_rank: x.loc.rank,
          injury_status: st.status,
          status_label: st.label,
          reported_status: r.status == null ? null : String(r.status),
          practice_status: r.practice_status || null,
          identity: r.identity || null,
          probability_of_absence: st.p,
          player_quality: q.value == null ? null : rd(q.value, 1),
          player_quality_basis: q.basis,
          player_quality_confidence: q.confidence,
          player_quality_scale: q.value == null ? null : scaleName,
          rating_on_file_unmeasured: num(q.rating_on_file) ? rd(q.rating_on_file, 1) : null,
          replacement_player_id: repEntry && repEntry.player_id != null ? String(repEntry.player_id) : null,
          replacement_player_name: repEntry ? repEntry.player_name || null : null,
          replacement_quality: rq.value == null ? null : rd(rq.value, 1),
          replacement_quality_basis: repEntry ? rq.basis : null,
          replacement_confidence: rd(repConf, 3),
          replacement_basis: x.rep ? x.rep.basis : null,
          replacement_depth_rank: x.rep && num(x.rep.depth_rank) ? x.rep.depth_rank : null,
          replacement_gap: rd(gap, 1),
          gap_basis: gapBasis,
          gap_sd: rd(gapSd, 3),
          usage_factor: u.value == null ? null : rd(u.value, 3),
          usage_basis: u.basis,
          usage_band: usageBand(u.value),
          position_leverage: lev,
          position_slot_resolved: sl.cfg ? sl.cfg.resolved !== false : false,
          matchup_leverage: mu.value,
          matchup_applicable: mu.applicable,
          matchup_drivers: mu.drivers,
          matchup_missing: mu.missing,
          unit_concentration_multiplier: rd(conc, 3),
          unit_absence_count: rd(cnt, 2),
          raw_injury_impact: rd(raw, 3),
          impact_if_absent: impact,
          classification: classify(impact),
          expected_impact: expected,
          raw_expected_impact: raw != null && num(st.p) ? rd(raw * st.p, 3) : null,
          confidence: conf,
          confidence_components: dims,
          rated: rated,
          missing: missing,
          notes: notes,
          source: r.source ? {
            name: r.source.name || null, type: r.source.type || null, tier: num(r.source.tier) ? r.source.tier : null,
            url: r.source.url || null, published_at: r.source.published_at || null,
            freshness: r.source.freshness || null } : null,
          projection_adjustment: PROJECTION_ADJUSTMENT
        };
        a.drivers_text = driversText(a, out.opponent_name);
        x.a = a;
      });

      /* ---- 5. order: expected impact, then impact, then id ---- */
      var scored = live.map(function (x) { return x.a; });
      scored.sort(function (a, b) {
        var ea = num(a.expected_impact) ? a.expected_impact : -1, eb = num(b.expected_impact) ? b.expected_impact : -1;
        var ia = num(a.impact_if_absent) ? a.impact_if_absent : -1, ib = num(b.impact_if_absent) ? b.impact_if_absent : -1;
        return eb - ea || ib - ia || String(a.player_id || a.player_name).localeCompare(String(b.player_id || b.player_name));
      });
      out.absences = scored.filter(function (a) { return a.rated; });
      out.unrated = scored.filter(function (a) { return !a.rated; });

      /* ---- 6. team aggregation ---- */
      var rawExp = 0, rawAll = 0, ratedWithP = 0;
      out.absences.forEach(function (a) {
        rawAll += a.raw_injury_impact;
        if (num(a.probability_of_absence)) { rawExp += a.raw_injury_impact * a.probability_of_absence; ratedWithP++; }
      });
      var total = out.absences.length + out.unrated.length;
      var covFactor = C.team.coverage_grade[out.coverage.grade] != null ? C.team.coverage_grade[out.coverage.grade] : C.team.coverage_grade.NONE;

      if (!out.coverage.graded) {
        out.status = 'NOT_ASSESSABLE';
        out.confidence = Math.round(100 * covFactor * 0.5);
        out.status_note = 'no graded availability read reached this team for this fixture; unknown is not healthy';
      } else if (!total) {
        out.status = out.coverage.comprehensive ? 'NO_REPORTED_ABSENCES' : 'NO_ABSENCES_ON_FILE';
        out.impact = 0; out.impact_if_all_absent = 0;
        out.classification = classify(0);
        out.confidence = Math.round(100 * covFactor
          * (out.coverage.comprehensive ? C.team.no_absences_comprehensive : C.team.no_absences_partial));
        out.status_note = out.coverage.comprehensive
          ? 'a comprehensive official report listed no non-quarterback absence'
          : 'the read on file lists no non-quarterback absence, but it is not a comprehensive report';
      } else if (!out.absences.length) {
        out.status = 'UNRATED_ABSENCES';
        out.confidence = Math.round(100 * covFactor * 0.25);
        out.status_note = total + ' non-quarterback absence(s) on file and none could be rated: '
          + summariseMissing(out.unrated);
      } else {
        out.status = 'ASSESSED';
        out.impact = ratedWithP ? normalize(rawExp, 'team') : null;
        out.impact_if_all_absent = normalize(rawAll, 'team');
        out.classification = classify(out.impact);
        var wc = 0, ws = 0;
        out.absences.forEach(function (a) {
          var w = Math.max(a.raw_injury_impact || 0, 0.05);
          wc += w * a.confidence; ws += w;
        });
        var unratedShare = out.unrated.length / total;
        out.confidence = Math.round(covFactor * (ws ? wc / ws : 0) * (1 - C.team.unrated_penalty * unratedShare));
        if (!ratedWithP) out.status_note = 'every rated absence has an unknown designation, so no expected impact is stated';
        else if (out.unrated.length) out.status_note = out.unrated.length + ' further absence(s) could not be rated and are not in the score';
      }

      /* ---- 7. units ---- */
      var units = {};
      scored.forEach(function (a) {
        var u = a.unit || 'UNRESOLVED';
        var rec = units[u] || (units[u] = { unit: u, label: a.unit_label || 'Unresolved position', absences: 0,
          expected_count: 0, raw_expected: 0, rated: 0 });
        rec.absences++;
        if (num(a.probability_of_absence)) rec.expected_count += a.probability_of_absence;
        if (a.rated && num(a.raw_expected_impact)) { rec.raw_expected += a.raw_expected_impact; rec.rated++; }
      });
      var TU = CFG.TEAM.unit_concern;
      out.units = Object.keys(units).map(function (k) {
        var u = units[k];
        var imp = u.rated ? normalize(u.raw_expected, 'unit') : null;
        var ec = rd(u.expected_count, 2);
        var concern = (ec >= TU.high.expected_count || (num(imp) && imp >= TU.high.impact)) ? 'HIGH'
          : (ec >= TU.moderate.expected_count || (num(imp) && imp >= TU.moderate.impact)) ? 'MODERATE' : 'LOW';
        return { unit: u.unit, label: u.label, absences: u.absences, expected_count: ec,
          impact: imp, classification: classify(imp), concern: concern,
          concern_label: concern === 'HIGH' ? 'High concern' : concern === 'MODERATE' ? 'Moderate concern' : 'Low concern' };
      }).sort(function (a, b) {
        var o = { HIGH: 0, MODERATE: 1, LOW: 2 };
        return o[a.concern] - o[b.concern] || (b.impact || 0) - (a.impact || 0) || b.expected_count - a.expected_count
          || String(a.unit).localeCompare(String(b.unit));
      });
      out.unit_concern = out.units.length && out.units[0].concern !== 'LOW' ? out.units[0] : null;
      out.key_losses = out.absences.slice(0, CFG.TEAM.key_losses).map(function (a) {
        return { label: a.label, player_name: a.player_name, injury_status: a.injury_status,
          impact_if_absent: a.impact_if_absent, classification: a.classification, confidence: a.confidence };
      });
      out.summary_text = teamText(out);
      return out;
    }

    function summariseMissing(list) {
      var c = {};
      list.forEach(function (a) { (a.missing || []).forEach(function (m) { c[m] = (c[m] || 0) + 1; }); });
      var names = { player_quality: 'no measured player quality', usage: 'no usage evidence',
        position: 'unresolved position', replacement_quality: 'no replacement bound', rating_scale: 'no rating scale' };
      var keys = Object.keys(c).filter(function (k) { return names[k]; }).sort(function (a, b) { return c[b] - c[a] || (a < b ? -1 : 1); });
      return keys.length ? keys.map(function (k) { return names[k] + ' (' + c[k] + ')'; }).join(', ') : 'insufficient evidence';
    }

    /* ---------------------------------------------------------------- */
    function driversText(a, oppName) {
      var who = a.label + (a.player_name ? ' ' + a.player_name : '');
      var st = a.status_label ? a.status_label.toLowerCase() : 'unknown status';
      if (!a.rated) {
        return who + ' (' + st + ') is not rated: ' + (a.missing || []).map(function (m) {
          return { player_quality: 'no measured player quality', usage: 'no usage evidence',
            position: 'unresolved position', replacement_quality: 'no replacement bound',
            rating_scale: 'no rating scale', replacement: 'no identified replacement',
            matchup: 'no opponent metric' }[m] || m;
        }).join(', ') + '.';
      }
      var parts = [];
      if (a.gap_basis === 'MEASURED_REPLACEMENT') {
        parts.push('the drop from his ' + a.player_quality + ' rating to '
          + poss(a.replacement_player_name || 'the replacement') + ' ' + a.replacement_quality
          + ' (' + rd(a.gap_sd, 1) + ' SD)');
      } else {
        parts.push('his ' + a.player_quality + ' rating against a replacement-level backup ('
          + (a.replacement_player_name ? a.replacement_player_name + ', unmeasured' : 'replacement unknown') + ')');
      }
      if (num(a.matchup_leverage) && Math.abs(a.matchup_leverage - 1) >= 0.03 && a.matchup_drivers.length) {
        var d = a.matchup_drivers[0];
        var better = d.z * d.sign > 0;
        parts.push((oppName ? poss(oppName) + ' ' : 'the opponent’s ') + (d.label || d.metric.replace(/_/g, ' '))
          + ' (' + (d.z > 0 ? '+' : '') + rd(d.z, 1) + ' SD, matchup x' + rd(a.matchup_leverage, 2)
          + (better ? ', raises it' : ', lowers it') + ')');
      }
      if (a.unit_concentration_multiplier > 1.001) {
        parts.push('other ' + (a.unit_label || 'unit').toLowerCase() + ' absences (concentration x' + a.unit_concentration_multiplier + ')');
      }
      if (num(a.usage_factor) && a.usage_factor < 0.5) parts.push('a limited role (' + Math.round(a.usage_factor * 100) + '% usage) holds it down');
      return who + ' (' + st + ') grades ' + a.impact_if_absent + '/100 ' + a.classification
        + ', driven by ' + parts.join('; ') + '. Confidence ' + a.confidence + '%.';
    }

    function teamText(t) {
      var name = t.team_name || 'This team';
      if (t.status === 'NOT_ASSESSABLE') return name + ': not assessable — ' + t.status_note + '.';
      if (t.status === 'NO_REPORTED_ABSENCES' || t.status === 'NO_ABSENCES_ON_FILE') {
        return name + ': ' + t.impact + '/100 ' + t.classification + ' — ' + t.status_note + '.';
      }
      if (t.status === 'UNRATED_ABSENCES') return name + ': not rated — ' + t.status_note + '.';
      var s = name + ': personnel availability impact ' + (num(t.impact) ? t.impact + '/100 ' + t.classification : 'not stated')
        + ' (confidence ' + t.confidence + '%)';
      if (t.key_losses.length) s += '. Key losses: ' + t.key_losses.map(function (k) {
        return k.label + ' ' + k.classification;
      }).join(', ');
      if (t.unit_concern) s += '. Unit concern: ' + t.unit_concern.label + ' — ' + t.unit_concern.concern_label.toLowerCase();
      return s + '.';
    }

    /* ---------------------------------------------------------------- */
    function compare(home, away) {
      var P = CFG.COMPARISON;
      var hOk = home && num(home.impact), aOk = away && num(away.impact);
      var out = { home_impact: hOk ? home.impact : null, away_impact: aOk ? away.impact : null,
        difference: null, more_affected: null, material: false, statement: null };
      if (!hOk || !aOk) {
        var blind = [];
        if (!hOk) blind.push((home && home.team_name) || 'the home team');
        if (!aOk) blind.push((away && away.team_name) || 'the away team');
        out.statement = 'Cannot compare: ' + blind.join(' and ') + (blind.length > 1 ? ' have' : ' has')
          + ' no assessable personnel read.';
        return out;
      }
      out.difference = away.impact - home.impact;
      var confident = home.confidence >= P.min_confidence && away.confidence >= P.min_confidence;
      if (Math.abs(out.difference) >= P.material_difference && confident) {
        var more = out.difference > 0 ? away : home;
        out.more_affected = out.difference > 0 ? 'away' : 'home';
        out.material = true;
        out.statement = (more.team_name || 'One side') + ' has materially greater personnel-loss exposure.';
      } else if (Math.abs(out.difference) >= P.material_difference) {
        out.more_affected = out.difference > 0 ? 'away' : 'home';
        out.statement = ((out.difference > 0 ? away : home).team_name || 'One side')
          + ' shows greater personnel-loss exposure, but confidence is too low to call it material.';
      } else {
        out.statement = 'Neither team has materially greater personnel-loss exposure.';
      }
      return out;
    }

    function assessGame(game) {
      game = game || {};
      var home = assessTeam(game.home, { side: 'home' });
      var away = assessTeam(game.away, { side: 'away' });
      return {
        game_id: game.game_id == null ? null : String(game.game_id),
        sport: game.sport || null,
        season: game.season == null ? null : game.season,
        week: game.week == null ? null : game.week,
        kickoff: game.kickoff || null,
        as_of: game.as_of || null,
        config_version: CFG.VERSION,
        home: home,
        away: away,
        comparison: compare(home, away),
        projection_adjustment: PROJECTION_ADJUSTMENT,
        projection_effect: { adjustment_points: PROJECTION_ADJUSTMENT, status: 'NOT_ENABLED',
          statement: CFG.PROJECTION.statement }
      };
    }

    return {
      config: CFG,
      version: CFG.VERSION,
      projectionAdjustment: projectionAdjustment,
      classify: classify,
      normalize: normalize,
      normalizeStatus: normalizeStatus,
      baseSlot: baseSlot,
      usageBand: usageBand,
      matchupLeverage: matchupLeverage,
      concentrationMultiplier: concentrationMultiplier,
      assessTeam: assessTeam,
      assessGame: assessGame,
      compare: compare,
      driversText: driversText,
      teamText: teamText
    };
  }

  var core = DEFAULT_CFG ? makeCore(DEFAULT_CFG) : null;
  var api = core || {};
  /* A core built on another configuration (tests, calibration). It carries
     the same lock: the projection adjustment is a constant of this file. */
  api.withConfig = function (cfg) { return makeCore(cfg); };
  api.PROJECTION_ADJUSTMENT = PROJECTION_ADJUSTMENT;
  if (!core) api.projectionAdjustment = projectionAdjustment;
  return api;
});
