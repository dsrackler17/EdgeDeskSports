#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — a synthetic ATP/WTA archive, in the real 108-column shape.

   WHY THIS EXISTS. The Tennis Lab has to be proven against data with the same
   SHAPE and the same CARDINALITY as the real archive: 361,571 matches, ~100k
   players, sixty years, four surfaces, and — crucially — the same holes. A
   fixture of twelve tidy rows proves nothing about a query plan, a shrinkage
   rule or a missing-data path.

   So this generates a tour that behaves like a tour:

     latent skill     each player has a true rating and a per-surface affinity;
                      results are SAMPLED from them, so surface specialists,
                      risers and decliners exist to be found rather than being
                      written in. A test that asserts the Lab finds a clay
                      specialist is only meaningful if nothing told it who.
     careers          players are born, peak and retire on an age curve, so the
                      record has deep veterans and thin newcomers — which is
                      what the shrinkage and uncertainty rules exist for.
     real holes       serve statistics absent before 1991, rankings absent for
                      the early years and for unranked players, environment
                      absent for most events, weather only for some. These are
                      the archive's actual gaps and the pipeline must survive
                      them WITHOUT turning any of them into a zero.

   IT IS NOT REAL DATA AND NEVER PRETENDS TO BE. Every file it writes carries
   data_source 'synthetic' and a tourney_id namespace that cannot collide with
   the archive's. Nothing generated here may be imported into a production
   database; tools/tennis/lab_sql.test.js uses it against a throwaway one.

   Usage:
     node tools/tennis/fixtures/make_archive.js --out /tmp/arch --matches 20000
     node tools/tennis/fixtures/make_archive.js --out /tmp/arch --matches 361571 --gzip
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HEADER = ['tourney_id', 'tourney_name', 'surface', 'draw_size', 'tourney_level', 'tourney_date',
  'match_num', 'winner_id', 'winner_seed', 'winner_entry', 'winner_name', 'winner_hand', 'winner_ht',
  'winner_ioc', 'winner_age', 'loser_id', 'loser_seed', 'loser_entry', 'loser_name', 'loser_hand',
  'loser_ht', 'loser_ioc', 'loser_age', 'score', 'best_of', 'round', 'minutes', 'w_ace', 'w_df',
  'w_svpt', 'w_1stIn', 'w_1stWon', 'w_2ndWon', 'w_SvGms', 'w_bpSaved', 'w_bpFaced', 'l_ace', 'l_df',
  'l_svpt', 'l_1stIn', 'l_1stWon', 'l_2ndWon', 'l_SvGms', 'l_bpSaved', 'l_bpFaced', 'winner_rank',
  'winner_rank_points', 'loser_rank', 'loser_rank_points', 'tour', 'source_year',
  'winner_elo_pre', 'winner_surface_elo_pre', 'winner_win_pct_30d_pre', 'winner_win_pct_90d_pre',
  'winner_win_pct_365d_pre', 'winner_matches_7d_pre', 'winner_matches_14d_pre', 'winner_rest_days_pre',
  'winner_career_surface_win_pct_pre', 'winner_career_surface_matches_pre',
  'loser_elo_pre', 'loser_surface_elo_pre', 'loser_win_pct_30d_pre', 'loser_win_pct_90d_pre',
  'loser_win_pct_365d_pre', 'loser_matches_7d_pre', 'loser_matches_14d_pre', 'loser_rest_days_pre',
  'loser_career_surface_win_pct_pre', 'loser_career_surface_matches_pre',
  'winner_ace_rate', 'winner_double_fault_rate', 'winner_first_serve_in_pct', 'winner_first_serve_won_pct',
  'winner_second_serve_won_pct', 'winner_break_points_saved_pct', 'loser_ace_rate', 'loser_double_fault_rate',
  'loser_first_serve_in_pct', 'loser_first_serve_won_pct', 'loser_second_serve_won_pct',
  'loser_break_points_saved_pct', 'elo_prob_winner_pre', 'surface_elo_prob_winner_pre', 'weather_query',
  'venue_name', 'venue_country', 'latitude', 'longitude', 'timezone', 'geocode_confidence', 'environment',
  'event_end_date', 'weather_temp_mean_f', 'weather_temp_max_f', 'weather_temp_min_f',
  'weather_humidity_mean_pct', 'weather_precip_week_in', 'weather_wind_mean_mph', 'weather_gust_max_mph',
  'weather_solar_week_mj_m2', 'weather_days_covered', 'weather_precision', 'match_uid', 'surface_group',
  'data_source', 'weather_source'];

/* A seeded PRNG, so a failing test can be reproduced exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function gauss(r, mu, sd) {
  const u = Math.max(1e-9, r()), v = Math.max(1e-9, r());
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const SURFACES = ['hard', 'clay', 'grass', 'carpet'];
const SURF_W = [0.50, 0.32, 0.10, 0.08];
const LEVELS = ['G', 'M', 'A', 'D', 'C'];
const LEVEL_W = [0.10, 0.18, 0.46, 0.06, 0.20];
const ROUNDS = ['R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
const IOC = ['ESP', 'FRA', 'USA', 'ARG', 'GER', 'ITA', 'SRB', 'GBR', 'AUS', 'RUS', 'SUI', 'CZE', 'JPN', 'CAN'];

/* How strongly an event's draw favours the stronger player. A smaller number
   is a sharper tilt: a Grand Slam field is far more top-heavy than a
   Challenger's, which is mostly the tail. */
function f_levelTilt(level) {
  return level === 'G' ? 90 : level === 'M' ? 110 : level === 'A' ? 160 : level === 'D' ? 200 : 400;
}

function pick(r, arr, weights) {
  const x = r(); let acc = 0;
  for (let i = 0; i < arr.length; i++) { acc += weights[i]; if (x <= acc) return arr[i]; }
  return arr[arr.length - 1];
}

function args(argv) {
  const o = { out: null, matches: 20000, seed: 20260919, gzip: false, startYear: 1968, endYear: 2026 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--out') o.out = next();
    else if (a === '--matches') o.matches = Math.max(10, Number(next()) || 20000);
    else if (a === '--seed') o.seed = Number(next()) || 1;
    else if (a === '--gzip') o.gzip = true;
    else if (a === '--start-year') o.startYear = Number(next());
    else if (a === '--end-year') o.endYear = Number(next());
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function build(o) {
  const r = rng(o.seed);
  const years = [];
  for (let y = o.startYear; y <= o.endYear; y++) years.push(y);
  /* Matches per year grows the way the real archive does — far more coverage in
     the early years of this particular source, thinning toward the present. */
  const weightOf = (y) => (y < 1990 ? 3.2 : y < 2000 ? 2.0 : y < 2010 ? 1.3 : y < 2016 ? 0.9 : 0.7);
  const totalW = years.reduce((a, y) => a + weightOf(y), 0);

  const out = { ATP: [], WTA: [] };
  const players = { ATP: [], WTA: [] };
  const NP = Math.max(40, Math.round(Math.sqrt(o.matches) * 4));

  ['ATP', 'WTA'].forEach((tour) => {
    for (let i = 0; i < NP; i++) {
      const born = o.startYear - 24 + Math.floor(r() * (years.length + 20));
      players[tour].push({
        id: String(1000 + i),
        name: `${tour} Player ${i}`,
        hand: r() < 0.14 ? 'L' : 'R',
        ht: r() < 0.22 ? null : Math.round(gauss(r, tour === 'ATP' ? 185 : 173, 7)),
        ioc: IOC[Math.floor(r() * IOC.length)],
        born: born,
        peak: born + 24 + Math.round(gauss(r, 0, 2)),
        skill: gauss(r, 1500, 220),
        /* Per-surface affinity is the thing the Surface Translator must find.
           Nothing downstream is told these numbers. */
        aff: { hard: gauss(r, 0, 55), clay: gauss(r, 0, 75), grass: gauss(r, 0, 65), carpet: gauss(r, 0, 60) },
        serve: Math.min(0.95, Math.max(0.4, gauss(r, 0.62, 0.07))),
        ret: Math.min(0.8, Math.max(0.2, gauss(r, 0.40, 0.05)))
      });
    }
  });

  /* Rating at a date: latent skill on an age curve. A player is weakest as a
     teenager and after 32, peaks around 24-28. */
  function ratingAt(p, year, surface) {
    const age = year - p.born;
    if (age < 16 || age > 39) return null;
    const curve = -0.9 * Math.pow(age - (p.peak - p.born), 2);
    return p.skill + curve + (surface ? p.aff[surface] : 0);
  }

  /* ════════════════════════════════════════════════════════════════════════
     TWO PHASES, because point-in-time data cannot be generated out of order.

     The archive's value is its `*_pre` columns: the Elo, form, rest and
     surface experience each player carried INTO each match. Those are a
     running state, so they can only be written by walking the record forward
     in date order. Phase 1 lays out the calendar; phase 2 walks it.

     Winners are decided in phase 2 from the RUNNING Elo, not from the latent
     skill, so the record is internally consistent: a player who has been
     losing carries a lower Elo into the next match and is duly less likely to
     win it. That is what makes the generated archive a fair test of a rating
     system rather than a lookup of the answer.
     ════════════════════════════════════════════════════════════════════════ */
  let matchNum = 0;
  const perTour = Math.round(o.matches / 2);

  /* A CUMULATIVE target per year, not an independent per-year quota.
     A draw produces matches in batches of up to sixteen, so a year routinely
     overshoots its own quota by a few. Independent quotas let those overshoots
     accumulate, and after fifty years the budget was spent before the loop
     reached the recent seasons — which produced an archive that stopped in
     2022, with every form window and every "active player" empty. Filling to a
     running total absorbs each overshoot into the next year instead. */
  const cum = {};
  { let acc = 0;
    years.forEach((y) => { acc += weightOf(y) / totalW; cum[y] = Math.round(perTour * acc); }); }

  const K = 32;
  const DAY = 86400000;

  ['ATP', 'WTA'].forEach((tour) => {
    const pool = players[tour];

    /* ── phase 1: the calendar ─────────────────────────────────────────── */
    const fixtures = [];
    let made = 0;
    for (const y of years) {
      const target = cum[y];
      let tourneySeq = 0, guard = 0;
      while (made < target && guard++ < 400) {
        tourneySeq++;
        const surface = pick(r, SURFACES, SURF_W);
        const level = pick(r, LEVELS, LEVEL_W);
        const bestOf = (tour === 'ATP' && level === 'G') ? 5 : 3;
        /* The final season is PARTIAL, exactly as the real archive's 2026 is:
           nothing may be dated in the future, so the last year's months stop at
           the month this fixture is generated in. A record containing matches
           that have not happened would make every freshness and form window
           meaningless. */
        const maxMonth = (y === o.endYear) ? (new Date().getUTCMonth() + 1) : 12;
        const month = 1 + Math.floor(r() * maxMonth);
        const day = 1 + Math.floor(r() * 26);
        const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const endDate = `${y}-${String(month).padStart(2, '0')}-${String(Math.min(28, day + 6)).padStart(2, '0')}`;
        const tourneyId = `${y}-S${tourneySeq}`;
        /* environment is on file for only some events — exactly the archive's
           own behaviour, and the reason the Lab reports an indoor split only
           where one exists. */
        const env = r() < 0.34 ? (r() < 0.3 ? 'Indoor' : 'Outdoor') : '';
        const haveWeather = env === 'Outdoor' && r() < 0.45;
        const size = [8, 16, 32][Math.floor(r() * 3)];
        const drawn = [], seen = new Set();
        /* THE DRAW IS NOT UNIFORM, because a tour is not uniform. A top-twenty
           player enters forty events a year and a journeyman enters six, so
           picking uniformly from the eligible pool produced an archive where
           every player had a handful of matches spread over decades — every
           form window empty, every rest figure in the hundreds of days, and
           nothing for the Lab to describe. Sampling by strength reproduces the
           real shape: a dense core that the product actually shows, and a long
           tail of thin records that the shrinkage and uncertainty rules exist
           to handle. Level scales it — a Grand Slam draws the strongest field,
           a Challenger the weakest. */
        const elig = pool.filter((p) => ratingAt(p, y, surface) != null);
        if (elig.length < 2) continue;
        const tilt = f_levelTilt(level);
        const weights = elig.map((p) => Math.exp((ratingAt(p, y, surface) - 1500) / tilt));
        let wsum = 0; weights.forEach((x) => { wsum += x; });
        for (let k = 0; k < size; k++) {
          let chosen = null, g2 = 0;
          while (chosen == null && g2++ < 60) {
            let x = r() * wsum, acc = 0, idx = elig.length - 1;
            for (let i = 0; i < elig.length; i++) { acc += weights[i]; if (x <= acc) { idx = i; break; } }
            if (!seen.has(elig[idx].id)) chosen = elig[idx];
          }
          if (!chosen) continue;
          seen.add(chosen.id); drawn.push(chosen);
        }
        for (let k = 0; k + 1 < drawn.length; k += 2) {
          fixtures.push({ y, date, endDate, tourneyId, tourneySeq, surface, level, bestOf,
                          env, haveWeather, size, a: drawn[k], b: drawn[k + 1],
                          round: ROUNDS[Math.min(ROUNDS.length - 1, Math.floor(r() * ROUNDS.length))] });
          made++;
        }
      }
    }
    /* Date order. Ties broken by the order drawn, so the walk is deterministic
       for a given seed. */
    fixtures.forEach((f, i) => { f.seq = i; });
    fixtures.sort((x, z) => (x.date < z.date ? -1 : x.date > z.date ? 1 : x.seq - z.seq));

    /* ── phase 2: walk it forward ──────────────────────────────────────── */
    const st = new Map();
    function state(p) {
      if (!st.has(p.id)) {
        st.set(p.id, { elo: 1500, surf: { hard: 1500, clay: 1500, grass: 1500, carpet: 1500 },
                       surfN: { hard: 0, clay: 0, grass: 0, carpet: 0 },
                       surfW: { hard: 0, clay: 0, grass: 0, carpet: 0 },
                       n: 0, hist: [], last: null, svpt: 0, svwon: 0, rtpt: 0, rtwon: 0 });
      }
      return st.get(p.id);
    }
    /* Win rate over a window, from matches strictly BEFORE this date. */
    function formPct(s, now, days) {
      const cut = now - days * DAY;
      let w = 0, n = 0;
      for (let i = s.hist.length - 1; i >= 0; i--) {
        if (s.hist[i].t < cut) break;
        n++; if (s.hist[i].won) w++;
      }
      return n === 0 ? null : { pct: w / n, n: n };
    }
    function countIn(s, now, days) {
      const cut = now - days * DAY;
      let n = 0;
      for (let i = s.hist.length - 1; i >= 0; i--) { if (s.hist[i].t < cut) break; n++; }
      return n;
    }

    for (const f of fixtures) {
      const sa = state(f.a), sb = state(f.b);
      const now = Date.parse(f.date + 'T00:00:00Z');
      /* Surface-adjusted running strength decides the result. */
      const ea = sa.surf[f.surface], eb = sb.surf[f.surface];
      const pa = 1 / (1 + Math.pow(10, (eb - ea) / 400));
      const aWon = r() < pa;
      const w = aWon ? f.a : f.b, l = aWon ? f.b : f.a;
      const sw = aWon ? sa : sb, sl = aWon ? sb : sa;
      matchNum++;

      /* Snapshot BEFORE updating: this is what goes in the _pre columns. */
      const pre = (p, s) => {
        const f30 = formPct(s, now, 30), f90 = formPct(s, now, 90), f365 = formPct(s, now, 365);
        const svRate = s.svpt >= 150 ? s.svwon / s.svpt : null;
        const rtRate = s.rtpt >= 150 ? s.rtwon / s.rtpt : null;
        return {
          elo: s.n > 0 ? Math.round(s.elo * 1000) / 1000 : '',
          selo: s.surfN[f.surface] > 0 ? Math.round(s.surf[f.surface] * 1000) / 1000 : '',
          f30: f30 ? Math.round(f30.pct * 10000) / 10000 : '',
          f90: f90 ? Math.round(f90.pct * 10000) / 10000 : '',
          f365: f365 ? Math.round(f365.pct * 10000) / 10000 : '',
          m7: countIn(s, now, 7), m14: countIn(s, now, 14),
          rest: s.last == null ? '' : Math.round((now - s.last) / DAY),
          swp: s.surfN[f.surface] > 0 ? Math.round((s.surfW[f.surface] / s.surfN[f.surface]) * 10000) / 10000 : '',
          sn: s.surfN[f.surface],
          sv: svRate == null ? '' : Math.round(svRate * 10000) / 10000,
          rt: rtRate == null ? '' : Math.round(rtRate * 10000) / 10000
        };
      };
      const pw = pre(w, sw), pl = pre(l, sl);

      /* Serve statistics exist only from 1991, like the real source. */
      const stats = f.y >= 1991 && r() < 0.88;
      const svpt = stats ? Math.max(30, Math.round(gauss(r, 70, 12))) : null;
      const rank = (s) => (f.y >= 1973 && s.n >= 3 && r() < 0.86
        ? Math.max(1, Math.round(2000 * Math.exp(-(s.elo - 1100) / 260))) : '');
      const rankPts = (rk) => (rk === '' ? '' : Math.max(1, Math.round(9000 / Math.sqrt(rk))));
      const wRank = rank(sw), lRank = rank(sl);

      const row = {};
      HEADER.forEach((h) => { row[h] = ''; });
      Object.assign(row, {
        tourney_id: f.tourneyId, tourney_name: `Synthetic ${f.surface} ${f.tourneySeq}`,
        surface: f.surface.charAt(0).toUpperCase() + f.surface.slice(1),
        draw_size: String(f.size), tourney_level: f.level, tourney_date: f.date,
        match_num: String(matchNum),
        winner_id: w.id, winner_name: w.name, winner_hand: w.hand,
        winner_ht: w.ht == null ? '' : String(w.ht), winner_ioc: w.ioc,
        winner_age: String(Math.round((f.y - w.born) * 10) / 10),
        loser_id: l.id, loser_name: l.name, loser_hand: l.hand,
        loser_ht: l.ht == null ? '' : String(l.ht), loser_ioc: l.ioc,
        loser_age: String(Math.round((f.y - l.born) * 10) / 10),
        score: f.bestOf === 5 ? '6-4 3-6 6-3 7-5' : '6-4 6-3',
        best_of: String(f.bestOf), round: f.round,
        minutes: String(Math.max(20, Math.round(gauss(r, f.bestOf === 5 ? 168 : 98, 22)))),
        tour: tour, source_year: String(f.y),
        winner_rank: String(wRank), loser_rank: String(lRank),
        winner_rank_points: String(rankPts(wRank)), loser_rank_points: String(rankPts(lRank)),
        environment: f.env, event_end_date: f.endDate,
        surface_group: f.surface === 'clay' ? 'Clay' : f.surface === 'grass' ? 'Grass' : 'Hard',
        data_source: 'synthetic',
        match_uid: `${tour}_${f.tourneyId}_${matchNum}_${w.id}_${l.id}`,
        winner_elo_pre: String(pw.elo), winner_surface_elo_pre: String(pw.selo),
        winner_win_pct_30d_pre: String(pw.f30), winner_win_pct_90d_pre: String(pw.f90),
        winner_win_pct_365d_pre: String(pw.f365),
        winner_matches_7d_pre: String(pw.m7), winner_matches_14d_pre: String(pw.m14),
        winner_rest_days_pre: String(pw.rest),
        winner_career_surface_win_pct_pre: String(pw.swp),
        winner_career_surface_matches_pre: String(pw.sn),
        loser_elo_pre: String(pl.elo), loser_surface_elo_pre: String(pl.selo),
        loser_win_pct_30d_pre: String(pl.f30), loser_win_pct_90d_pre: String(pl.f90),
        loser_win_pct_365d_pre: String(pl.f365),
        loser_matches_7d_pre: String(pl.m7), loser_matches_14d_pre: String(pl.m14),
        loser_rest_days_pre: String(pl.rest),
        loser_career_surface_win_pct_pre: String(pl.swp),
        loser_career_surface_matches_pre: String(pl.sn)
      });
      if (stats) {
        const wIn = Math.round(svpt * Math.min(0.85, Math.max(0.4, gauss(r, 0.61, 0.06))));
        const w1w = Math.round(wIn * Math.min(0.95, w.serve + 0.12));
        const w2w = Math.round((svpt - wIn) * Math.max(0.2, w.serve - 0.12));
        const lsv = Math.round(svpt * 1.02);
        const lIn = Math.round(lsv * 0.58);
        const l1w = Math.round(lIn * Math.min(0.95, l.serve));
        const l2w = Math.round((lsv - lIn) * Math.max(0.2, l.serve - 0.16));
        Object.assign(row, {
          w_ace: String(Math.max(0, Math.round(gauss(r, w.serve * 14, 4)))),
          w_df: String(Math.max(0, Math.round(gauss(r, 3, 2)))),
          w_svpt: String(svpt), w_1stIn: String(wIn), w_1stWon: String(w1w), w_2ndWon: String(w2w),
          w_SvGms: String(Math.max(1, Math.round(svpt / 6.2))),
          w_bpSaved: String(Math.max(0, Math.round(gauss(r, 3, 2)))),
          w_bpFaced: String(Math.max(0, Math.round(gauss(r, 5, 3)))),
          l_ace: String(Math.max(0, Math.round(gauss(r, l.serve * 12, 4)))),
          l_df: String(Math.max(0, Math.round(gauss(r, 4, 2)))),
          l_svpt: String(lsv), l_1stIn: String(lIn), l_1stWon: String(l1w), l_2ndWon: String(l2w),
          l_SvGms: String(Math.max(1, Math.round(lsv / 6.4))),
          l_bpSaved: String(Math.max(0, Math.round(gauss(r, 2, 2)))),
          l_bpFaced: String(Math.max(0, Math.round(gauss(r, 6, 3))))
        });
        /* Feed the running serve/return accumulators from the same numbers the
           row publishes, so a rolling rate computed downstream reconciles with
           the match statistics rather than drifting from them. */
        sw.svpt += svpt; sw.svwon += w1w + w2w;
        sw.rtpt += lsv;  sw.rtwon += lsv - (l1w + l2w);
        sl.svpt += lsv;  sl.svwon += l1w + l2w;
        sl.rtpt += svpt; sl.rtwon += svpt - (w1w + w2w);
      }
      if (f.haveWeather) {
        Object.assign(row, {
          venue_name: `Court ${f.tourneySeq}`, venue_country: 'Synthetica',
          latitude: String(Math.round(gauss(r, 40, 12) * 100) / 100),
          longitude: String(Math.round(gauss(r, 5, 40) * 100) / 100),
          timezone: 'UTC', geocode_confidence: 'name_inferred',
          weather_temp_mean_f: String(Math.round(gauss(r, 72, 9))),
          weather_days_covered: '7', weather_precision: 'week', weather_source: 'synthetic'
        });
      }
      out[tour].push(HEADER.map((h) => row[h]).join(','));

      /* ── update the running state AFTER the row is written ──────────── */
      const expW = 1 / (1 + Math.pow(10, (sl.elo - sw.elo) / 400));
      sw.elo += K * (1 - expW); sl.elo -= K * (1 - expW);
      const sExpW = 1 / (1 + Math.pow(10, (sl.surf[f.surface] - sw.surf[f.surface]) / 400));
      sw.surf[f.surface] += K * (1 - sExpW); sl.surf[f.surface] -= K * (1 - sExpW);
      sw.surfN[f.surface]++; sl.surfN[f.surface]++;
      sw.surfW[f.surface]++;
      sw.n++; sl.n++;
      sw.hist.push({ t: now, won: true }); sl.hist.push({ t: now, won: false });
      sw.last = now; sl.last = now;
      /* The history only ever needs a year; trimming it keeps the walk linear
         rather than quadratic in a long career. */
      const keep = now - 366 * DAY;
      while (sw.hist.length && sw.hist[0].t < keep) sw.hist.shift();
      while (sl.hist.length && sl.hist[0].t < keep) sl.hist.shift();
    }
  });
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.out) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return o.help ? 0 : 2;
  }
  fs.mkdirSync(o.out, { recursive: true });
  const t0 = Date.now();
  const data = build(o);
  const files = [];
  let total = 0;
  ['ATP', 'WTA'].forEach((tour, i) => {
    const rows = data[tour];
    total += rows.length;
    const body = HEADER.join(',') + '\n' + rows.join('\n') + '\n';
    const name = `${String(i + 1).padStart(2, '0')}_Synthetic_${tour}.csv` + (o.gzip ? '.gz' : '');
    const f = path.join(o.out, name);
    fs.writeFileSync(f, o.gzip ? zlib.gzipSync(Buffer.from(body), { level: 6 }) : body);
    files.push({ file: name, tour: tour, rows: rows.length, bytes: fs.statSync(f).size });
  });
  console.log(`synthetic archive: ${total.toLocaleString()} matches in ${files.length} files `
            + `(${((Date.now() - t0) / 1000).toFixed(1)}s) -> ${o.out}`);
  files.forEach((f) => console.log(`  ${f.file.padEnd(34)} ${String(f.rows).padStart(8)} rows  ${(f.bytes / 1048576).toFixed(1)} MB`));
  console.log('  data_source=synthetic on every row. Never import this into a production database.');
  return 0;
}
if (require.main === module) process.exit(main());
module.exports = { HEADER, build, rng };
