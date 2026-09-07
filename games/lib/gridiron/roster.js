/* ===========================================================================
   GRIDIRON — the roster the engine plays with.

   TWO JOBS, and it is important they stay separate:

     1  READ a franchise roster (the rows franchise_roster() returns) into the
        unit ratings the play resolver needs. The franchise layer owns the
        players; this file never invents one that exists.

     2  GENERATE a fictional roster deterministically from a seed and a team
        rating, for an opponent the franchise layer does not model down to the
        player, and so that Game Day is playable before anyone signs in.

   Nothing here is random at call time: the same seed always produces the same
   roster, so a game can be replayed exactly and a test can pin a number.

   The attribute keys are the franchise's own (arm, acc, iq, spd, pwr, elu,
   hnd, rte, blk, pbk, rbk, str, prs, rst, tkl, cov, bhk, clu, con), so a
   generated player and a real one are the same shape.
   =========================================================================== */
(function (root) {
  'use strict';

  /* ── a seeded generator, mulberry32 ───────────────────────────────────── */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* a stable 32-bit hash of a string — how a franchise id becomes a seed */
  function hash(s) {
    var h = 2166136261, i;
    s = String(s == null ? '' : s);
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  var FIRST = ['Marcus', 'Darius', 'Elijah', 'Tyrell', 'Jalen', 'Cade', 'Brayden', 'Isaiah', 'Malik',
    'Trevor', 'Damon', 'Kaleb', 'Xavier', 'Rhett', 'Jonah', 'Amari', 'Beau', 'Silas', 'Quinton',
    'Dontae', 'Weston', 'Rashad', 'Colby', 'Nico', 'Emmett', 'Zaire', 'Holden', 'Devante', 'Rowan',
    'Tobias', 'Kellen', 'Micah', 'Jaxon', 'Corbin', 'Ezra', 'Roman', 'Deion', 'Bryce', 'Kadeem', 'Landry'];
  var LAST = ['Hale', 'King', 'Vance', 'Boone', 'Merritt', 'Okafor', 'Salazar', 'Whitfield', 'Ndiaye',
    'Crowder', 'Alvarez', 'Pruitt', 'Ashby', 'Delgado', 'Fontaine', 'Guthrie', 'Mbeki', 'Rasmussen',
    'Tallent', 'Vickers', 'Winslow', 'Yates', 'Brannigan', 'Castellanos', 'Doyle', 'Eastwood',
    'Ferreira', 'Gallagher', 'Hollis', 'Ives', 'Jessup', 'Kowalski', 'Lindqvist', 'Mercado',
    'Nakamura', 'Ovalle', 'Prescott', 'Quintero', 'Radcliffe', 'Sutherland', 'Thorne', 'Ulrich',
    'Valdez', 'Wexler', 'Ximenes', 'Yarborough', 'Zamora', 'Ashford', 'Bellamy', 'Cardoza'];

  /* how many of each position a roster carries, and how many start */
  var DEPTH = { QB: 2, RB: 3, WR: 5, TE: 2, OL: 8, DL: 6, LB: 5, CB: 4, S: 3, K: 1, P: 1 };
  var STARTERS = { QB: 1, RB: 1, WR: 3, TE: 1, OL: 5, DL: 4, LB: 3, CB: 2, S: 2, K: 1, P: 1 };
  var ATTRS = {
    QB: ['arm', 'acc', 'iq', 'spd'], RB: ['spd', 'pwr', 'elu', 'hnd'], WR: ['spd', 'rte', 'hnd', 'iq'],
    TE: ['hnd', 'blk', 'rte', 'spd'], OL: ['pbk', 'rbk', 'str', 'iq'], DL: ['prs', 'rst', 'str', 'spd'],
    LB: ['tkl', 'cov', 'spd', 'iq'], CB: ['cov', 'spd', 'tkl', 'bhk'], S: ['cov', 'tkl', 'bhk', 'iq'],
    K: ['pwr', 'acc', 'clu', 'con'], P: ['pwr', 'acc', 'clu', 'con']
  };
  /* what a scheme asks of a position — a generated roster leans the way the
     team plays, which is why a Power Run team's line blocks the run */
  var SCHEME_TILT = {
    power_run:  { OL: { rbk: 10, pbk: -5 }, RB: { pwr: 9, spd: -2 }, TE: { blk: 8, rte: -4 }, QB: { arm: 2, acc: -2 } },
    option:     { QB: { spd: 9, arm: -6 }, RB: { spd: 6, elu: 3 }, OL: { rbk: 7, pbk: -5 } },
    air_raid:   { QB: { arm: 5, acc: 4, spd: -4 }, WR: { rte: 6, spd: 3 }, OL: { pbk: 5, rbk: -4 }, TE: { rte: 4, blk: -5 } },
    spread:     { QB: { spd: 5, acc: 2 }, WR: { spd: 5, rte: 1 }, OL: { pbk: 2 } },
    west_coast: { QB: { acc: 5, arm: -4 }, WR: { hnd: 4, rte: 3, spd: -3 }, RB: { hnd: 5 } },
    pro_style:  { QB: { iq: 7, arm: 4 }, TE: { blk: 6, hnd: 5 }, OL: { pbk: 6, rbk: 6 } }
  };
  var DEF_TILT = {
    four_three:      { DL: { rst: 4, prs: 2 }, LB: { tkl: 3 } },
    three_four:      { LB: { tkl: 3, cov: 2 }, DL: { str: 5, prs: -2 } },
    press_man:       { CB: { cov: 7, spd: 3, bhk: -2 }, S: { cov: 3 } },
    zone:            { S: { cov: 5, bhk: 4 }, LB: { cov: 5 }, CB: { bhk: 4, cov: -2 } },
    blitz_heavy:     { DL: { prs: 8, rst: -4 }, LB: { spd: 4, cov: -4 } },
    bend_dont_break: { S: { tkl: 4, cov: 2 }, CB: { cov: 2 }, DL: { rst: 4, prs: -4 } }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* One fictional player. `tier` is how far down the depth chart he is, which
     is the whole reason a backup is worse than a starter and fatigue matters. */
  function makePlayer(r, pos, idx, teamOverall, tilt, i) {
    var starters = STARTERS[pos] || 1;
    /* starters cluster near the team rating; the drop-off past the ones who
       play is steep, which is what makes depth a real decision */
    var below = Math.max(0, idx - (starters - 1));
    var base = teamOverall - below * (pos === 'OL' || pos === 'DL' ? 5 : 6.5)
             - (idx < starters ? idx * 1.6 : 0)
             + (r() - 0.5) * 7;
    base = clamp(base, 38, 99);
    var keys = ATTRS[pos], out = {}, k, j, spread;
    for (j = 0; j < keys.length; j++) {
      k = keys[j];
      spread = (r() - 0.5) * 16;
      out[k] = Math.round(clamp(base + spread + ((tilt && tilt[pos] && tilt[pos][k]) || 0), 30, 99));
    }
    var overall = Math.round(keys.reduce(function (s, kk) { return s + out[kk]; }, 0) / keys.length);
    return {
      id: 'g' + i,
      first_name: FIRST[Math.floor(r() * FIRST.length)],
      last_name: LAST[Math.floor(r() * LAST.length)],
      position: pos, depth: idx + 1, overall: overall, ratings: out,
      age: 18 + Math.floor(r() * 5),
      durability: Math.round(clamp(62 + r() * 36, 40, 99)),
      stamina: 100, health: 100
    };
  }

  /* A full fictional roster: deterministic in (seed, overall, scheme). */
  function generate(opts) {
    opts = opts || {};
    var seed = typeof opts.seed === 'number' ? opts.seed : hash(opts.seed || 'gridiron');
    var r = rng(seed), overall = clamp(+opts.overall || 72, 45, 95);
    var tilt = {}, o = SCHEME_TILT[opts.offense] || {}, d = DEF_TILT[opts.defense] || {}, k;
    for (k in o) if (o.hasOwnProperty(k)) tilt[k] = o[k];
    for (k in d) if (d.hasOwnProperty(k)) tilt[k] = d[k];
    var out = [], i = 0, pos, n;
    for (pos in DEPTH) {
      if (!DEPTH.hasOwnProperty(pos)) continue;
      for (n = 0; n < DEPTH[pos]; n++) out.push(makePlayer(r, pos, n, overall, tilt, i++));
    }
    return out;
  }

  /* ── READING A ROSTER INTO UNIT RATINGS ─────────────────────────────────
     The engine never touches a player row: it asks for the units. Every unit
     is the DEPTH-WEIGHTED mean of whoever is actually available, so an injury
     or a tired starter changes the football rather than a label. */
  function avail(p) {
    if (!p) return false;
    if (p.injury && p.injury.weeks > 0) return false;
    return (p.health == null ? 100 : p.health) > 0;
  }
  function ratingOf(p, key, fallback) {
    var rr = p && (p.ratings || p.attributes);
    if (rr && rr[key] != null) return +rr[key];
    return fallback == null ? (p && p.overall) || 60 : fallback;
  }
  function byPos(players) {
    var m = {}, i, p;
    for (i = 0; i < (players || []).length; i++) {
      p = players[i];
      if (!p || !p.position || !avail(p)) continue;
      (m[p.position] || (m[p.position] = [])).push(p);
    }
    Object.keys(m).forEach(function (k) {
      m[k].sort(function (a, b) {
        var da = a.depth || 99, db = b.depth || 99;
        return da === db ? (b.overall || 0) - (a.overall || 0) : da - db;
      });
    });
    return m;
  }

  /* a unit's rating on one attribute, over the players on the field, each
     scaled by how fresh he is */
  function unit(list, key, count, fatigue) {
    if (!list || !list.length) return 55;
    var n = Math.min(count || 1, list.length), s = 0, i, p, fr;
    for (i = 0; i < n; i++) {
      p = list[i];
      fr = fatigue ? (fatigue[p.id] == null ? 100 : fatigue[p.id]) : 100;
      /* a player at zero stamina is worth 88% of himself, never nothing:
         tired football is worse football, not different football */
      s += ratingOf(p, key) * (0.88 + 0.12 * (fr / 100));
    }
    /* short-handed units are penalised — five linemen is five linemen */
    if (n < (count || 1)) s += (count - n) * 45;
    return s / (count || 1);
  }

  /* THE UNITS the play resolver reads. One object, all numbers. */
  function units(players, fatigue) {
    var m = byPos(players || []);
    /* SOMEBODY HAS TO TAKE THE SNAP. Lose every quarterback on the roster and
       a back or a receiver takes it, badly — which is what actually happens,
       and which keeps the passing line attributable to a man rather than to
       nobody. A team with no quarterback used to throw attempts that belonged
       to no player, and the box score stopped adding up. */
    var qb = (m.QB || [])[0] || (m.RB || [])[0] || (m.WR || [])[0] || (m.TE || [])[0] || null;
    return {
      qb: {
        arm: qb ? ratingOf(qb, 'arm') : 55, acc: qb ? ratingOf(qb, 'acc') : 55,
        iq: qb ? ratingOf(qb, 'iq') : 55, spd: qb ? ratingOf(qb, 'spd') : 50,
        player: qb
      },
      rb:  { spd: unit(m.RB, 'spd', 1, fatigue), pwr: unit(m.RB, 'pwr', 1, fatigue),
             elu: unit(m.RB, 'elu', 1, fatigue), hnd: unit(m.RB, 'hnd', 1, fatigue),
             players: (m.RB || []).slice(0, 3) },
      wr:  { spd: unit(m.WR, 'spd', 3, fatigue), rte: unit(m.WR, 'rte', 3, fatigue),
             hnd: unit(m.WR, 'hnd', 3, fatigue), iq: unit(m.WR, 'iq', 3, fatigue),
             players: (m.WR || []).slice(0, 5) },
      te:  { hnd: unit(m.TE, 'hnd', 1, fatigue), blk: unit(m.TE, 'blk', 1, fatigue),
             rte: unit(m.TE, 'rte', 1, fatigue), spd: unit(m.TE, 'spd', 1, fatigue),
             players: (m.TE || []).slice(0, 2) },
      ol:  { pbk: unit(m.OL, 'pbk', 5, fatigue), rbk: unit(m.OL, 'rbk', 5, fatigue),
             str: unit(m.OL, 'str', 5, fatigue), iq: unit(m.OL, 'iq', 5, fatigue),
             players: (m.OL || []).slice(0, 5) },
      dl:  { prs: unit(m.DL, 'prs', 4, fatigue), rst: unit(m.DL, 'rst', 4, fatigue),
             str: unit(m.DL, 'str', 4, fatigue), spd: unit(m.DL, 'spd', 4, fatigue),
             players: (m.DL || []).slice(0, 4) },
      lb:  { tkl: unit(m.LB, 'tkl', 3, fatigue), cov: unit(m.LB, 'cov', 3, fatigue),
             spd: unit(m.LB, 'spd', 3, fatigue), iq: unit(m.LB, 'iq', 3, fatigue),
             players: (m.LB || []).slice(0, 3) },
      cb:  { cov: unit(m.CB, 'cov', 2, fatigue), spd: unit(m.CB, 'spd', 2, fatigue),
             tkl: unit(m.CB, 'tkl', 2, fatigue), bhk: unit(m.CB, 'bhk', 2, fatigue),
             players: (m.CB || []).slice(0, 4),
             /* the second corner on his own: scouting's favourite weakness */
             cb2: (m.CB || [])[1] ? ratingOf((m.CB || [])[1], 'cov') : 55 },
      s:   { cov: unit(m.S, 'cov', 2, fatigue), tkl: unit(m.S, 'tkl', 2, fatigue),
             bhk: unit(m.S, 'bhk', 2, fatigue), iq: unit(m.S, 'iq', 2, fatigue),
             players: (m.S || []).slice(0, 3) },
      k:   { pwr: unit(m.K, 'pwr', 1), acc: unit(m.K, 'acc', 1), clu: unit(m.K, 'clu', 1),
             player: (m.K || [])[0] || null },
      p:   { pwr: unit(m.P, 'pwr', 1), acc: unit(m.P, 'acc', 1), player: (m.P || [])[0] || null },
      byPos: m
    };
  }

  /* Team overall from the units, on the franchise's own weights, so a
     generated opponent and a real franchise are comparable. */
  function overallOf(u) {
    var off = 0.30 * ((u.qb.arm + u.qb.acc + u.qb.iq + u.qb.spd) / 4)
            + 0.12 * ((u.rb.spd + u.rb.pwr + u.rb.elu + u.rb.hnd) / 4)
            + 0.22 * ((u.wr.spd + u.wr.rte + u.wr.hnd + u.wr.iq) / 4)
            + 0.08 * ((u.te.hnd + u.te.blk + u.te.rte + u.te.spd) / 4)
            + 0.28 * ((u.ol.pbk + u.ol.rbk + u.ol.str + u.ol.iq) / 4);
    var def = 0.30 * ((u.dl.prs + u.dl.rst + u.dl.str + u.dl.spd) / 4)
            + 0.22 * ((u.lb.tkl + u.lb.cov + u.lb.spd + u.lb.iq) / 4)
            + 0.28 * ((u.cb.cov + u.cb.spd + u.cb.tkl + u.cb.bhk) / 4)
            + 0.20 * ((u.s.cov + u.s.tkl + u.s.bhk + u.s.iq) / 4);
    var sp = (u.k.pwr + u.k.acc + u.p.pwr + u.p.acc) / 4;
    return { offense: Math.round(off), defense: Math.round(def), special: Math.round(sp),
             overall: Math.round(0.45 * off + 0.45 * def + 0.10 * sp) };
  }

  function name(p) { return p ? (p.first_name + ' ' + p.last_name) : ''; }
  /* "D. King" — how a play-by-play says a name */
  function shortName(p) {
    if (!p) return '';
    return (p.first_name || ' ').charAt(0) + '. ' + (p.last_name || '');
  }

  var API = {
    rng: rng, hash: hash, DEPTH: DEPTH, STARTERS: STARTERS, ATTRS: ATTRS,
    generate: generate, units: units, overallOf: overallOf, byPos: byPos,
    ratingOf: ratingOf, available: avail, name: name, shortName: shortName
  };
  root.EDRoster = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
