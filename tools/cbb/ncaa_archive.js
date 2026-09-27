#!/usr/bin/env node
/* ===========================================================================
   THE NCAA SEASON ARCHIVE IMPORTER

   Reads NCAA's own published season statistics for Division I, 2021-2026, from
   the ncaa_bbStats package, and imports them as cbb.ncaa_player_seasons.

   WHY THIS SOURCE EXISTS HERE AT ALL — a correction worth stating plainly.
   I reported that both open-source college baseball packages were dead ends
   from CI, because the NCAA site they wrap answers 403 to any datacenter
   address. For ncaa_bbStats that conclusion was wrong. It does not scrape at
   read time: it SHIPS the parsed data in its repository, so the 403 never
   enters the picture. My 404 against it was a guessed repository owner, and I
   took a real finding about a different package and generalised it onto this
   one without checking.

   The cost of that mistake is visible in what this source has and the box
   scores do not: doubles, triples, hit-by-pitch and sacrifice flies. This
   project documented — correctly, for ESPN box scores — that on-base and
   slugging could not be computed and had to be carried from the source's own
   figure. From here they are computed, from the definitions.

   WHICH OF THE TWO PLAYER CACHES, AND WHY IT MATTERS.
   The package ships two. `player_stats_cache` is FanGraphs-sourced; the
   package's own DATA_PROVENANCE.md marks it as passing through a third-party
   export. `player_stats_cache_ncaa` is NCAA's own published statistics with,
   in its words, "no third-party export anywhere in the chain". This importer
   reads the second one only. That is a deliberate choice about whose data this
   is, not an arbitrary path.

   PINNED BY CONTENT, NOT BY BRANCH. The files are fetched from a mutable
   branch, so the branch is not the pin — the SHA-256 of each file is, and a
   mismatch is a refusal rather than a warning. The upstream project makes this
   argument itself about citing a branch, and it applies with more force here:
   if the numbers change, this job must stop and a human must look, not import
   different numbers under the same provenance.

   Split as everywhere else: pure shaping above module.exports, network below.
   =========================================================================== */
'use strict';

const RAW = 'https://raw.githubusercontent.com/CodeMateo15/ncaa_bbStats/main/src/data';

/* The exact files this importer was written and verified against. Fetched,
   inspected and counted on 2026-09-18: 32,161 batting and 31,368 pitching
   player-seasons across 311 teams and the seasons 2021-2026. */
const SOURCES = {
  batting: {
    url: `${RAW}/player_stats_cache_ncaa/batting/batting.csv`,
    sha256: '8be313be507a00a6911f254ea8774956bf4b0276812a05082536f8955880d0d3',
    rows: 32161,
  },
  pitching: {
    url: `${RAW}/player_stats_cache_ncaa/pitching/pitching.csv`,
    sha256: 'ede6f9e4f4cfeff5561f95dad9f17bb060211ea98e66f74a633e9c441a5415f5',
    rows: 31368,
  },
};

const ATTRIBUTION = 'NCAA published season statistics via ncaa_bbStats 1.4.2 '
  + '(MIT, Copyright (c) 2025 Mateo Biggs), player_stats_cache_ncaa';

/* ── CSV ──────────────────────────────────────────────────────────────────
   These files are quoted where they need to be — a team name like
   "Texas A&M-Corpus Christi" is fine unquoted but a name with a comma is not —
   so the parser handles quotes and doubled quotes rather than splitting on
   commas and hoping. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { push(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) endRow();
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
    return o;
  });
}

/* Blank is unknown, and unknown is not zero. Number('') is 0, which is exactly
   the trap that had to be fixed in the query layer, so it is not repeated. */
function int(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}
function bool(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

/* ── INNINGS ──────────────────────────────────────────────────────────────
   NCAA writes thirds as tenths: 83.2 is eighty-three innings and two outs,
   which is 251 outs. It is NOT 83.2 innings, and 83.2 + 89.1 is 173 innings
   rather than 172.3. The upstream package documents the same convention in its
   own source, and a sample of 4,000 rows shows only .0, .1 and .2 after the
   point, which is what that convention predicts. Anything else is a payload
   this code does not understand, and it refuses rather than guesses. */
function ipToOuts(ip) {
  if (ip === null || ip === undefined || ip === '') return null;
  const m = /^(\d+)(?:\.(\d))?$/.exec(String(ip).trim());
  if (!m) return null;
  const frac = m[2] === undefined ? 0 : Number(m[2]);
  if (frac > 2) return null;
  return Number(m[1]) * 3 + frac;
}

const keyOf = (r) => `${r.year}|${r.player_id}`;

/* ── NAMES THAT ARRIVE INSIDE OUT ─────────────────────────────────────────
   A handful of rows read "Jr., Guy Garibay" — the generational suffix has been
   split off and pushed to the front, which is what happens when a name
   containing a comma meets a parser that splits on commas. It is almost
   certainly why these same rows lost their identity upstream.

   Putting it back is not cosmetic: a name is how a reader finds a player, and
   nobody searches for "Jr., Guy Garibay". Only the known suffixes are moved,
   so a genuine "Last, First" ordering is left alone rather than guessed at. */
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);
function fixName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const m = /^([^,]+),\s*(.+)$/.exec(name);
  if (!m) return name;
  const head = m[1].trim();
  if (!SUFFIXES.has(head.toLowerCase())) return name;   /* not a suffix: leave it */
  return `${m[2].trim()} ${head}`;
}

/* ── IDENTITY FOR THE ROWS THAT HAVE NONE ─────────────────────────────────
   269 rows across the two files carry no player_id and no person_id: real
   names, real teams, real seasons, real statistics, with the upstream identity
   resolution having failed on them. They are 0.4% of the archive.

   Dropping them is the easy thing and the wrong one. They are real
   player-seasons, and a leaderboard quietly missing 269 of them is worse than
   one that includes them under a key it made itself — PROVIDED it says so,
   which is what identity_resolved is for. The key is deterministic, derived
   from season, club and name, and prefixed so it can never be mistaken for or
   collide with one of the package's own ids.

   What this costs is honest and bounded: such a player cannot be followed
   across a transfer, because his key contains his club. Nothing else about him
   is affected, and no row is invented. */
function syntheticId(season, teamCode, name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `unresolved:${season}:${String(teamCode || 'none').toLowerCase()}:${slug}`;
}

function shapeBatting(r) {
  const season = int(r.year);
  const name = fixName(r.name);
  if (!season || !name) return null;
  const rawId = String(r.player_id || '').trim();
  const teamCode = String(r.team || '').trim() || null;
  const pid = rawId || syntheticId(season, teamCode, name);
  return {
    season, player_id: pid,
    identity_resolved: !!rawId,
    person_id: String(r.person_id || '').trim() || null,
    name,
    team_code: String(r.team || '').trim() || null,
    team_name: String(r['team name'] || '').trim() || null,
    division: int(r.division),
    class_year: String(r.class || '').trim() || null,
    bats: true,
    /* NULLABLE ON PURPOSE. 145 rows in this source carry real at-bats with no
       games figure at all. Writing 0 there would make every per-game rate a
       division by zero dressed up as a number. */
    b_games: int(r.g),
    pa: int(r.pa), ab: int(r.ab), h: int(r.h),
    doubles: int(r['2b']), triples: int(r['3b']), hr: int(r.hr),
    r: int(r.r), rbi: int(r.rbi), bb: int(r.bb), so: int(r.so),
    hbp: int(r.hbp), sf: int(r.sf), sh: int(r.sh), gdp: int(r.gdp),
    sb: int(r.sb), cs: int(r.cs),
    qualified_batting: bool(r.qualified),
  };
}

function shapePitching(r) {
  const season = int(r.year);
  const name = fixName(r.name);
  if (!season || !name) return null;
  const rawId = String(r.player_id || '').trim();
  const teamCode = String(r.team || '').trim() || null;
  const pid = rawId || syntheticId(season, teamCode, name);
  return {
    season, player_id: pid,
    identity_resolved: !!rawId,
    person_id: String(r.person_id || '').trim() || null,
    name,
    team_code: String(r.team || '').trim() || null,
    team_name: String(r['team name'] || '').trim() || null,
    division: int(r.division),
    class_year: String(r.class || '').trim() || null,
    pitches: true,
    p_games: int(r.g), gs: int(r.gs), w: int(r.w), l: int(r.l),
    cg: int(r.cg), sho: int(r.sho), sv: int(r.sv),
    outs: ipToOuts(r.ip),
    tbf: int(r.tbf), p_h: int(r.h), p_r: int(r.r), er: int(r.er),
    p_hr: int(r.hr), p_bb: int(r.bb), p_hbp: int(r.hbp),
    wp: int(r.wp), bk: int(r.bk), p_so: int(r.so),
    qualified_pitching: bool(r.qualified),
  };
}

/* ── the merge ─────────────────────────────────────────────────────────────
   One row per (season, player). A two-way player appears in both files under
   the same id, and his two halves belong on one row — which is why this merges
   rather than producing two rows and asking the reader to add them up.

   Identity comes from whichever file has it; the two agree, and where they do
   not the batting file wins, because it is the larger of the two and a hitter's
   club is the one a reader is more likely to be looking for. */
function mergeSeasons(battingRows, pitchingRows) {
  const byKey = new Map();
  const blank = {
    identity_resolved: true, bats: false, pitches: false,
    b_games: null, pa: null, ab: null, h: null, doubles: null, triples: null,
    hr: null, r: null, rbi: null, bb: null, so: null, hbp: null, sf: null,
    sh: null, gdp: null, sb: null, cs: null, qualified_batting: null,
    p_games: null, gs: null, w: null, l: null, cg: null, sho: null, sv: null,
    outs: null, tbf: null, p_h: null, p_r: null, er: null, p_hr: null,
    p_bb: null, p_hbp: null, wp: null, bk: null, p_so: null,
    qualified_pitching: null,
  };
  for (const b of battingRows) {
    if (!b) continue;
    byKey.set(`${b.season}|${b.player_id}`, Object.assign({}, blank, b));
  }
  for (const p of pitchingRows) {
    if (!p) continue;
    const k = `${p.season}|${p.player_id}`;
    const existing = byKey.get(k);
    if (existing) {
      /* keep the batting identity, add the pitching half */
      Object.assign(existing, {
        pitches: true,
        p_games: p.p_games, gs: p.gs, w: p.w, l: p.l, cg: p.cg, sho: p.sho,
        sv: p.sv, outs: p.outs, tbf: p.tbf, p_h: p.p_h, p_r: p.p_r, er: p.er,
        p_hr: p.p_hr, p_bb: p.p_bb, p_hbp: p.p_hbp, wp: p.wp, bk: p.bk,
        p_so: p.p_so, qualified_pitching: p.qualified_pitching,
      });
    } else {
      byKey.set(k, Object.assign({}, blank, p));
    }
  }
  const out = Array.from(byKey.values());
  out.sort((a, b) => (a.season - b.season) || String(a.player_id).localeCompare(String(b.player_id)));
  return out;
}

/* A row that cannot be true. The gate refuses these too; naming them here says
   WHICH row, which a count cannot. 400 at-bats is the Roberto Pena rule: the
   highest real total in this source among rows that also record games is 296,
   and the one row above it carries 450 with no games at all. */
function implausible(r) {
  if (r.ab !== null && r.ab > 400) return `${r.ab} at-bats in one season`;
  if (r.ab !== null && r.h !== null && r.h > r.ab) return `${r.h} hits in ${r.ab} at-bats`;
  if (r.outs !== null && r.outs < 0) return 'negative outs';
  if (r.season < 2002 || r.season > 2100) return `season ${r.season}`;
  return null;
}

module.exports = {
  SOURCES, ATTRIBUTION, RAW,
  parseCsv, int, bool, ipToOuts, shapeBatting, shapePitching, mergeSeasons,
  implausible, keyOf, fixName, syntheticId,
};

/* ── the network half ───────────────────────────────────────────────────── */
if (require.main === module) {
  const crypto = require('crypto');
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const has = (n) => argv.indexOf(n) >= 0;
  const log = (...a) => console.log('[cbb-ncaa]', ...a);

  async function fetchPinned(name) {
    const spec = SOURCES[name];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90000);
    const r = await fetch(spec.url, { signal: ctl.signal, headers: { accept: 'text/csv' } });
    const body = await r.text();
    clearTimeout(t);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} from ${spec.url}`);
    const got = crypto.createHash('sha256').update(body).digest('hex');
    return { body, sha256: got, expected: spec.sha256, url: spec.url, rows: spec.rows };
  }

  (async function main() {
    if (!has('--check') && !has('--commit')) {
      console.log('Nothing to do. Pass --check (fetch and validate, write nothing) or --commit.');
      process.exit(0);
    }
    const onlySeason = arg('--season', null) ? Number(arg('--season', null)) : null;
    const allowDrift = has('--allow-source-drift');

    const got = {};
    let drifted = false;
    for (const name of ['batting', 'pitching']) {
      const f = await fetchPinned(name);
      const same = f.sha256 === f.expected;
      log(`${name}: ${f.body.length}B, sha256 ${f.sha256.slice(0, 16)}… `
        + (same ? 'matches the pin' : `DOES NOT MATCH the pin ${f.expected.slice(0, 16)}…`));
      if (!same) drifted = true;
      got[name] = f;
    }

    /* SOURCE_CHANGED. The upstream file is not the same one this importer was
       written against. That is not necessarily wrong — the package is under
       active development and a correction upstream is a good thing — but it
       means the column meanings, the row count and the validation thresholds
       have not been checked against THIS content. Importing anyway would put
       unverified numbers behind the same provenance string. */
    if (drifted && !allowDrift) {
      console.log('FAIL | cbb ncaa archive | SOURCE_CHANGED: the upstream files differ from the '
        + 'pinned hashes. Nothing was written. Re-verify the row counts, the column set and the '
        + 'at-bat ceiling against the new content, update SOURCES in this file, and only then '
        + 'pass --allow-source-drift.');
      process.exit(1);
    }
    if (drifted) log('WARNING: importing content that does not match the pin, because a human asked.');

    /* A DROP MUST BE COUNTED, NOT FILTERED AWAY. An earlier run of this
       importer reported 32,013 batting rows against a file holding 32,161 and
       said nothing about the 148 missing — they were swallowed by
       .filter(Boolean), and the shortfall was 0.46%, just inside the 1%
       tripwire below. The count is now explicit on both sides. */
    const bParsed = parseCsv(got.batting.body);
    const pParsed = parseCsv(got.pitching.body);
    const bRows = bParsed.map(shapeBatting).filter(Boolean);
    const pRows = pParsed.map(shapePitching).filter(Boolean);
    log(`batting: ${bParsed.length} in file, ${bRows.length} shaped, `
      + `${bParsed.length - bRows.length} unusable`);
    log(`pitching: ${pParsed.length} in file, ${pRows.length} shaped, `
      + `${pParsed.length - pRows.length} unusable`);
    const unresolved = bRows.concat(pRows).filter((r) => !r.identity_resolved).length;
    if (unresolved) {
      log(`${unresolved} row(s) carry no upstream player id and are keyed on `
        + `season, club and name instead; identity_resolved is false on those.`);
    }

    /* A row count well below the pin means a truncated download that still
       answered 200 — the failure mode this project has already been bitten by. */
    if (!drifted) {
      for (const [name, n] of [['batting', bRows.length], ['pitching', pRows.length]]) {
        if (n < SOURCES[name].rows * 0.99) {
          console.log(`FAIL | cbb ncaa archive | ${name} parsed ${n} rows against ${SOURCES[name].rows} `
            + 'expected. A short read that returned 200 is still a short read.');
          process.exit(1);
        }
      }
    }

    let rows = mergeSeasons(bRows, pRows);
    if (onlySeason) rows = rows.filter((r) => r.season === onlySeason);
    const bad = [];
    rows = rows.filter((r) => {
      const why = implausible(r);
      if (why) { bad.push(`${r.season} ${r.name} (${r.team_code}): ${why}`); return false; }
      return true;
    });

    const seasons = Array.from(new Set(rows.map((r) => r.season))).sort();
    const teams = new Set(rows.map((r) => r.team_code).filter(Boolean));
    log(`${rows.length} player-seasons, ${teams.size} teams, seasons ${seasons.join(' ')}`);
    log(`${rows.filter((r) => r.bats).length} with a batting line, `
      + `${rows.filter((r) => r.pitches).length} with a pitching line, `
      + `${rows.filter((r) => r.bats && r.pitches).length} two-way`);
    if (bad.length) {
      log(`${bad.length} row(s) refused as impossible, and dropped by name:`);
      for (const b of bad.slice(0, 10)) log(`  - ${b}`);
    }

    if (!rows.length) {
      console.log('FAIL | cbb ncaa archive | nothing to import after validation');
      process.exit(1);
    }

    if (!has('--commit')) {
      /* Show a real row, because a count says the code ran and nothing about
         whether the columns landed where they belong. */
      const ex = rows.find((r) => r.bats && r.ab > 150) || rows[0];
      log(`a batting row as shaped: ${ex.name} (${ex.team_name}, ${ex.season}) `
        + `${ex.h}-for-${ex.ab}, ${ex.doubles} 2B, ${ex.triples} 3B, ${ex.hr} HR, `
        + `${ex.bb} BB, ${ex.hbp} HBP, ${ex.sf} SF`);
      const px = rows.find((r) => r.pitches && r.outs > 150) || null;
      if (px) {
        log(`a pitching row as shaped: ${px.name} (${px.team_name}, ${px.season}) `
          + `${Math.floor(px.outs / 3)}.${px.outs % 3} IP (${px.outs} outs), `
          + `${px.er} ER, ${px.p_so} K, ${px.tbf} batters faced`);
      }
      console.log(`PASS | cbb ncaa archive | --check only, nothing written `
        + `(${rows.length} player-seasons over ${seasons.length} seasons)`);
      process.exit(0);
    }

    const DB = require('./db.js');
    const db = DB.createDb();
    const importId = `cbb-ncaa-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const COLS = Object.keys(rows[0]).filter((k) => k !== 'source' && k !== 'source_sha256');
    await db.startRun({
      import_id: importId, dataset: 'ncaa_seasons', status: 'staging',
      first_season: seasons[0], last_season: seasons[seasons.length - 1],
      seasons, source: ATTRIBUTION,
      source_note: `batting sha256 ${got.batting.sha256}; pitching sha256 ${got.pitching.sha256}`
        + (drifted ? '; IMPORTED WITH --allow-source-drift, hashes did not match the pin' : ''),
    });
    try {
      const withSrc = rows.map((r) => Object.assign({}, r, {
        source: 'ncaa_bbStats', source_sha256: got.batting.sha256,
      }));
      const n = await db.stageRows('stg_ncaa_player_seasons',
        COLS.concat(['source', 'source_sha256']), withSrc, importId);
      log(`staged ${n} rows`);
    } catch (e) {
      await db.abandon(importId, 'staging failed: ' + e.message);
      throw e;
    }
    const verdict = await db.gate('promote_ncaa_seasons',
      ['p_import_id', 'p_allow_shrink', 'p_season'],
      { p_import_id: importId, p_allow_shrink: has('--allow-shrink'), p_season: onlySeason });
    if (!verdict || verdict.ok !== true) {
      console.log('REFUSED | cbb ncaa archive | the gate declined and kept the previous archive:');
      for (const r of (verdict && verdict.refusals) || []) console.log(`  - ${r.refusal}: ${r.detail}`);
      process.exit(1);
    }
    console.log(`PASS | cbb ncaa archive | promoted ${verdict.rows} player-seasons `
      + `(${verdict.live} live)`);
  })().catch((e) => {
    console.log('FAIL | cbb ncaa archive | ' + ((e && e.stack) || e));
    process.exit(1);
  });
}
