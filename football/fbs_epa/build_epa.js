#!/usr/bin/env node
/* ============================================================================
   THE FBS QUARTERBACK EPA INGEST — from the provider's per-game passing rows
   to two compact artifacts the browser can carry.

   WHAT THIS CORRECTS. football/starters/README.md, football/players/config.js
   and the header of football/cfb_p4/research/fit_qb_quality.js all say the
   same thing: "no feed this repository reads publishes EPA per dropback for
   college football". That was true of the feed this repository was reading.
   The successor SportsDataverse repository — sportsdataverse/cfbfastR-cfb-data
   — publishes `adv_passing`, one row per passer per game, carrying EPA, EPA
   per play, attempts, sacks, interceptions, yards and an EPA-based success
   rate, for 2014 onwards. It is real expected-points added from a published
   model, not a yards proxy and not ESPN's Total QBR.

   WHAT IT IS NOT. It is not the same measurement the engine's shipped
   `points_per_epa_db` coefficient was fitted against, and epa_contract.js
   records why in detail. So this builder produces RESEARCH artifacts. Nothing
   it writes can move a price; football/fbs_epa/epa_contract.js
   COMPATIBILITY.priced_input is the single flag, and it is false.

   ---------------------------------------------------------------- THE SHAPE

   Two committed artifacts, both small:

     teams.json          ESPN team id <-> EdgeDesk team key, with the
                         conference and division that team held IN EACH
                         SEASON. Realignment is history, not a current lookup.
     qb_epa_<season>.json every passer who matters this season: a FROZEN
                         career aggregate through the last completed season,
                         the current season's GAME LOG with kickoffs, and a
                         recent-form log that crosses the season boundary.

   The game logs are shipped instead of pre-aggregated season numbers on
   purpose. A pregame feature must not contain the game it is predicting, and
   the cheapest way to guarantee that is to ship dated rows and let the reader
   cut them at the kickoff it is asking about. football/fbs_epa/fbs_epa.js
   does exactly that and the tests assert it.

   ------------------------------------------------------------- THE SOURCES

     historical corpus   football/data/cache/fbs_epa/corpus/*.jsonl.gz — the
                         assembled 2014-onwards research tables. Large, kept
                         in the pipeline cache, never committed.
     live season         the provider's own parquet for the season in
                         progress, converted with the existing
                         football/data/tools/parquet_to_csv.py bridge.

   A failed fetch NEVER destroys an artifact. The previous qb_epa file is
   re-read, its age is measured and republished as `stale`, and the run says
   so. Stale data, partial coverage, unresolved identity and a genuine absence
   of observations are four different states and this file keeps them apart.

     node football/fbs_epa/build_epa.js [--season 2026] [--refresh]
          [--corpus DIR] [--commit SHA] [--offline] [--check] [--quiet]

   --refresh  go to the network for the season in progress (otherwise the
              corpus cache is authoritative and nothing is downloaded)
   --check    validate and report, writing nothing
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const PY_HELPER = path.join(ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
const DEFAULT_CORPUS = path.join(ROOT, 'football', 'data', 'cache', 'fbs_epa', 'corpus');

global.window = global.window || global;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const CONTRACT = require(path.join(HERE, 'epa_contract.js'));
const EPA = require(path.join(HERE, 'fbs_epa.js'));

const SCHEMA_INDEX = 'edgedesk_fbs_epa_index_v1';
const SCHEMA_TEAMS = 'edgedesk_fbs_epa_teams_v1';
const PROVIDER_REPO = 'https://github.com/sportsdataverse/cfbfastR-cfb-data';
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data';
const KINDS = ['adv_passing', 'adv_team', 'cfb_schedules', 'cfb_rosters'];
const FIRST_SEASON = 2014;

/* ------------------------------------------------------------------- args */
function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const CHECK = !!arg('check', false);
const REFRESH = !!arg('refresh', false);
const OFFLINE = !!arg('offline', false);
const CORPUS = String(arg('corpus', DEFAULT_CORPUS));
const log = (...a) => { if (!QUIET) console.log(...a); };
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));

/* ------------------------------------------------------------------ utils */
const isNum = x => typeof x === 'number' && isFinite(x);
function num(v) { if (v == null || v === '' || v === 'NA' || v === 'NULL') return null; const n = +v; return isFinite(n) ? n : null; }
function ident(v) { const n = num(v); return n == null ? null : String(Math.round(n)); }
function str(v) { return (v == null || v === '' || v === 'NA' || v === 'NULL') ? null : String(v); }
function r4(x) { return isNum(x) ? Math.round(x * 10000) / 10000 : null; }
function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }

/* Quote-aware, because one passer named "Smith, Jr." shifts every column
   after him and a silently mis-assigned column is worse than a thrown one. */
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  const lines = text.split('\n');
  let h = 0;
  while (h < lines.length && !lines[h].trim()) h++;
  const head = splitLine(lines[h].replace(/\r$/, ''));
  const ix = {}; head.forEach((k, i) => { ix[k.trim()] = i; });
  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (!l) continue;
    rows.push(splitLine(l));
  }
  return { ix, rows, columns: head };
}

/* ------------------------------------------------------- the corpus, read */
function corpusFile(name) { return path.join(CORPUS, name + '.jsonl.gz'); }
function readCorpus(name) {
  const f = corpusFile(name);
  if (!fs.existsSync(f)) return null;
  const text = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');
  const out = [];
  text.split('\n').forEach(l => { if (l) out.push(JSON.parse(l)); });
  return out;
}
function writeCorpus(name, rows) {
  fs.mkdirSync(CORPUS, { recursive: true });
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(corpusFile(name), zlib.gzipSync(Buffer.from(text, 'utf8')));
}

/* ------------------------------------------------------------- the network */
async function head(url) {
  const r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-63' },
    signal: AbortSignal.timeout(60000) });
  return r.status;
}
async function grab(url, dest) {
  let last = null;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      if (r.status === 404) return { ok: false, status: 404, why: 'not published' };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.slice(0, 4).equals(Buffer.from('PAR1'))) throw new Error('not a parquet file');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { ok: true, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    } catch (e) {
      last = e;
      await new Promise(r2 => setTimeout(r2, 800 * Math.pow(2, a)));
    }
  }
  return { ok: false, status: null, why: (last && last.message) || 'unknown' };
}
function parquetToRows(file) {
  const text = execFileSync('python3', [PY_HELPER, file], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
  return parseCsv(text);
}

/* ============================================================================
   THE PROVIDER TABLES -> THE CORPUS ROWS

   Ported from the assembly the research archive documents, so a refreshed
   season is built by the same rules the historical ones were. Every rule here
   exists because breaking it produces a plausible-looking wrong number:

     * a passer row whose game is not in the schedule, or whose team is not in
       the fixture, is an error and not a row to keep;
     * two rows for one (game, team, name) are either an exact duplicate
       (dropped), a punctuation split of ONE athlete (summed, rates recomputed
       on their own denominators) or genuinely ambiguous (QUARANTINED, never
       guessed);
     * EPA per dropback exists only when EPA/(Att+Sck) reproduces the
       published rounded rate. Otherwise the rate is missing, and missing is
       never zero and never the league average.
   ========================================================================== */
function normName(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildSeasonRows(season, tables, opts) {
  opts = opts || {};
  const issues = {};
  const bump = k => { issues[k] = (issues[k] || 0) + 1; };
  const quarantine = [];

  /* ---- schedule ---- */
  const sched = {};
  const sd = tables.cfb_schedules;
  for (const r of sd.rows) {
    const hd = str(r[sd.ix.home_division]), ad = str(r[sd.ix.away_division]);
    if (hd !== 'fbs' && ad !== 'fbs') continue;
    const gid = ident(r[sd.ix.game_id]);
    const kick = str(r[sd.ix.start_date]);
    if (!gid || !kick) continue;
    const hp = num(r[sd.ix.home_points]), ap = num(r[sd.ix.away_points]);
    const completedFlag = String(r[sd.ix.completed]).toLowerCase();
    const kickMs = Date.parse(kick);
    const completed = (completedFlag === 'true' || completedFlag === '1')
      && isFinite(kickMs) && kickMs < opts.cutoff && hp != null && ap != null;
    sched[gid] = {
      game_id: gid, season, week: num(r[sd.ix.week]),
      kickoff: new Date(kickMs).toISOString(),
      home_team_id: ident(r[sd.ix.home_id]), away_team_id: ident(r[sd.ix.away_id]),
      home_team: str(r[sd.ix.home_team]), away_team: str(r[sd.ix.away_team]),
      home_division: hd, away_division: ad,
      home_conference: str(r[sd.ix.home_conference]), away_conference: str(r[sd.ix.away_conference]),
      fbs_vs_fbs: hd === 'fbs' && ad === 'fbs',
      neutral_site: String(r[sd.ix.neutral_site]).toLowerCase() === 'true',
      completed_by_cutoff: completed,
      home_points: completed ? hp : null, away_points: completed ? ap : null,
      home_margin: completed ? hp - ap : null, total_points: completed ? hp + ap : null
    };
  }

  /* ---- advanced passing ---- */
  const ap = tables.adv_passing;
  const need = ['game_id', 'pos_team_id', 'passer_player_name', 'Comp', 'Att', 'Sck', 'Yds',
    'Pass_TD', 'Int', 'EPA', 'EPA_per_Play', 'SR'];
  for (const c of need) if (ap.ix[c] === undefined) throw new Error('adv_passing no longer carries ' + c);
  const grouped = new Map();
  for (const r of ap.rows) {
    const gid = ident(r[ap.ix.game_id]), tid = ident(r[ap.ix.pos_team_id]);
    const nm = str(r[ap.ix.passer_player_name]);
    if (!gid || !tid || nm == null) continue;
    const key = gid + '|' + tid + '|' + normName(nm);
    const row = {};
    Object.keys(ap.ix).forEach(c => { row[c] = r[ap.ix[c]]; });
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const passers = [];
  const seen = new Set();
  for (const [key, group] of grouped) {
    const [gid, tid] = key.split('|');
    let rs = group;
    if (rs.length > 1) {
      const uniq = new Map();
      rs.forEach(r => uniq.set(JSON.stringify(r), r));
      if (uniq.size !== rs.length) bump('exact_duplicate_rows_removed');
      rs = Array.from(uniq.values());
    }
    let r;
    let fragments = 1, aliases = null;
    if (rs.length > 1) {
      /* the provider occasionally splits ONE athlete across two spellings of
         his own name ("Vernon Adams Jr" and "Vernon Adams Jr."). That is only
         safe to merge when the spellings genuinely differ and the identity
         resolves to exactly one athlete; otherwise it is two people and it is
         quarantined rather than added together. */
      const names = new Set(rs.map(x => String(x.passer_player_name)));
      const ids = opts.identityOf ? opts.identityOf(tid, normName(rs[0].passer_player_name)) : new Set();
      if (names.size !== rs.length || !ids || ids.size !== 1) {
        quarantine.push({ season, game_id: gid, team_id: tid, reason: 'ambiguous_name_fragments', source_rows: rs });
        bump('quarantined_fragment_groups');
        continue;
      }
      const dbs = rs.map(x => (num(x.Att) || 0) + (num(x.Sck) || 0));
      const den = dbs.reduce((a, b) => a + b, 0);
      const valid = rs.every((x, i) => dbs[i] > 0 && num(x.EPA) != null && num(x.EPA_per_Play) != null
        && Math.abs(num(x.EPA) / dbs[i] - num(x.EPA_per_Play)) <= 0.011);
      r = Object.assign({}, rs[0]);
      ['Comp', 'Att', 'Sck', 'Yds', 'Pass_TD', 'Int', 'EPA'].forEach(c => {
        r[c] = rs.every(x => num(x[c]) != null) ? rs.reduce((a, x) => a + num(x[c]), 0) : null;
      });
      r.EPA_per_Play = (valid && den) ? num(r.EPA) / den : null;
      r.SR = (den && rs.every(x => num(x.SR) != null))
        ? rs.reduce((a, x, i) => a + num(x.SR) * dbs[i], 0) / den : null;
      r.CPOE = (num(r.Att) && rs.every(x => num(x.CPOE) != null))
        ? rs.reduce((a, x) => a + num(x.CPOE) * num(x.Att), 0) / num(r.Att) : null;
      fragments = rs.length;
      aliases = Array.from(names).sort();
      issues.merged_unique_identity_name_fragments =
        (issues.merged_unique_identity_name_fragments || 0) + (rs.length - 1);
    } else {
      r = rs[0];
    }

    const g = sched[gid];
    if (!g || !g.completed_by_cutoff) continue;
    if (tid !== g.home_team_id && tid !== g.away_team_id) throw new Error('team ' + tid + ' is not in fixture ' + gid);
    const nm = String(r.passer_player_name);
    const nk = normName(nm);
    if (nk === 'team' || nk === '') { bump('team_or_unnamed_passing_rows_excluded'); continue; }
    const rowKey = gid + '|' + tid + '|' + nk;
    if (seen.has(rowKey)) throw new Error('duplicate passer game ' + rowKey);
    seen.add(rowKey);

    const at = num(r.Att), sk = num(r.Sck);
    const db = (at != null && sk != null) ? at + sk : null;
    const epa = num(r.EPA), rate = num(r.EPA_per_Play);
    const consistent = db != null && db > 0 && epa != null && rate != null
      && Math.abs(epa / db - rate) <= 0.011;
    bump(consistent ? 'epa_denominator_consistent' : 'epa_denominator_unverified');

    const ids = opts.identityOf ? opts.identityOf(tid, nk) : new Set();
    const pid = (ids && ids.size === 1) ? Array.from(ids)[0] : null;
    const match = pid ? 'unique_season_team_name' : ((ids && ids.size) ? 'ambiguous' : 'unmatched');
    bump('identity_' + match);

    passers.push({
      game_id: gid, season, week: g.week, kickoff: g.kickoff, team_id: tid,
      opponent_id: tid === g.home_team_id ? g.away_team_id : g.home_team_id,
      athlete_id: pid, passer_name: nm, identity_status: match,
      completions: num(r.Comp), attempts: at, sacks: sk, recorded_dropbacks: db,
      passing_yards: num(r.Yds), passing_tds: num(r.Pass_TD), interceptions: num(r.Int),
      provider_epa_total: epa, provider_epa_per_play: rate,
      epa_per_recorded_dropback: consistent ? epa / db : null,
      epa_denominator_consistent: consistent,
      provider_success_rate: num(r.SR), provider_cpoe: num(r.CPOE),
      historical_source_vintage: 'retrospective_reconstruction',
      source_season: season, source_fragment_count: fragments,
      source_name_variants: aliases || [nm]
    });
  }

  /* ---- advanced team ---- */
  const teamRows = [];
  const at = tables.adv_team;
  if (at) {
    for (const r of at.rows) {
      const gid = ident(r[at.ix.game_id]), tid = ident(r[at.ix.pos_team_id]);
      const g = sched[gid];
      if (!g || !g.completed_by_cutoff) continue;
      if (tid !== g.home_team_id && tid !== g.away_team_id) throw new Error('advanced team fixture mismatch ' + gid);
      teamRows.push({
        game_id: gid, season, kickoff: g.kickoff, team_id: tid,
        opponent_id: tid === g.home_team_id ? g.away_team_id : g.home_team_id,
        off_epa_per_play: num(r[at.ix.EPA_per_play]),
        pass_epa_per_play: num(r[at.ix.EPA_passing_per_play]),
        rush_epa_per_play: num(r[at.ix.EPA_rushing_per_play]),
        scrimmage_plays: num(r[at.ix.scrimmage_plays]),
        pass_rate: num(r[at.ix.passes_rate]),
        yards_per_play: num(r[at.ix.yards_per_play]),
        line_yards_per_carry: num(r[at.ix.line_yards_per_carry]),
        rushing_stuff_rate: num(r[at.ix.rushing_stuff_rate])
      });
    }
  }

  return { games: Object.values(sched), passers, teams: teamRows, quarantine, issues };
}

/* ============================================================================
   IDENTITY REPAIR — from EdgeDesk's own authoritative athlete ids.

   The provider resolves a passer to an athlete id by matching his name inside
   his own roster file, and on the season in progress that leaves a lot on the
   floor: 164 of 2026's 535 passing rows arrived with no id. EdgeDesk already
   holds two authoritative athlete-id sources for exactly these people —
   football/rosters (the ESPN roster sync, keyed on the same athlete ids) and
   football/starters (ids taken off play attribution) — so the unresolved rows
   are re-matched against those.

   THE RULES, because the failure mode here is naming the wrong quarterback:
     * the match is inside ONE team in ONE season. A name is never matched
       across teams, and a previous season's roster never resolves this one.
     * a full-name match is taken only when it is unique on that roster.
     * the provider abbreviates some names to an initial ("B.Lowry"). An
       initial-plus-surname match is taken only when it is unique on that
       roster, and never when a full name was available and ambiguous.
     * two candidates is NOT a match. It stays unresolved with the reason, and
       nothing downstream may pick the better player.
   ========================================================================== */
/* The provider's own season roster, indexed the way its assembly indexes it:
   one athlete id per (team, normalised name), over every name column the file
   carries. A name that maps to two athletes stays a set of two and therefore
   resolves to nobody. */
function providerRosterIndex(table) {
  const out = new Map();
  const cols = ['full_name', 'athlete_display_name', 'display_name'].filter(c => table.ix[c] !== undefined);
  const tCol = table.ix.team_id, aCol = table.ix.athlete_id;
  if (tCol === undefined || aCol === undefined) return out;
  for (const r of table.rows) {
    const tid = ident(r[tCol]), pid = ident(r[aCol]);
    if (!tid || !pid) continue;
    for (const c of cols) {
      const nk = normName(r[table.ix[c]]);
      if (!nk) continue;
      const k = tid + '|' + nk;
      if (!out.has(k)) out.set(k, new Set());
      out.get(k).add(pid);
    }
  }
  return out;
}

function identityIndexFor(season) {
  const byTeam = new Map();         /* espn team id -> {full:Map, ini:Map} */
  const sources = [];
  const keyFor = tid => {
    let m = byTeam.get(String(tid));
    if (!m) { m = { full: new Map(), ini: new Map() }; byTeam.set(String(tid), m); }
    return m;
  };
  function add(tid, name, id) {
    if (!tid || !name || !id) return;
    const m = keyFor(tid);
    const k = normName(name);
    if (k) { if (!m.full.has(k)) m.full.set(k, new Set()); m.full.get(k).add(String(id)); }
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.filter(p => !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(p));
      const last = tail.length ? tail[tail.length - 1] : parts[parts.length - 1];
      const ik = normName(parts[0].charAt(0) + last);
      if (ik) { if (!m.ini.has(ik)) m.ini.set(ik, new Set()); m.ini.get(ik).add(String(id)); }
    }
  }

  const roster = readJson(path.join(ROOT, 'football', 'rosters', `fbs_${season}_espn.json`), null);
  if (roster && Array.isArray(roster.teams)) {
    let n = 0;
    roster.teams.forEach(t => (t.players || []).forEach(p => {
      if (!p.espn_id) return;
      add(t.espn_id, p.name, p.espn_id); n++;
    }));
    sources.push({ source: `football/rosters/fbs_${season}_espn.json`, kind: 'ESPN roster sync',
      as_of: roster.retrieved_at || null, athletes: n });
  }
  return { byTeam, sources };
}

function repairIdentities(passers, season, index, teamKeyOf) {
  const out = { repaired: 0, ambiguous: 0, unresolved: 0, already: 0, by_method: {} };
  const unresolvedRows = [];
  passers.forEach(p => {
    if (p.season !== season) return;
    if (p.athlete_id) { out.already++; return; }
    const m = index.byTeam.get(String(p.team_id));
    const nk = normName(p.passer_name);
    if (nk === 'team' || !nk) { out.unresolved++; unresolvedRows.push({ row: p, why: 'team-charged row, not a player' }); return; }
    if (!m) {
      out.unresolved++;
      unresolvedRows.push({ row: p,
        why: 'no EdgeDesk roster covers this programme — it is not FBS this season, so its passers have no '
          + 'athlete id in any file EdgeDesk holds' });
      return;
    }
    const full = m.full.get(nk);
    if (full && full.size === 1) {
      p.athlete_id = Array.from(full)[0];
      p.identity_status = 'repaired_unique_roster_name';
      out.repaired++; out.by_method.full_name = (out.by_method.full_name || 0) + 1;
      return;
    }
    if (full && full.size > 1) {
      out.ambiguous++;
      unresolvedRows.push({ row: p, why: 'two players on this roster carry that name; an ambiguous name is never '
        + 'resolved by picking the better player' });
      return;
    }
    const parts = String(p.passer_name).trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.filter(x => !/^(jr|sr|ii|iii|iv|v)$/i.test(x));
      const last = tail.length ? tail[tail.length - 1] : parts[parts.length - 1];
      const ik = normName(parts[0].charAt(0) + last);
      const hit = m.ini.get(ik);
      if (hit && hit.size === 1) {
        p.athlete_id = Array.from(hit)[0];
        p.identity_status = 'repaired_unique_initial_surname';
        out.repaired++; out.by_method.initial_surname = (out.by_method.initial_surname || 0) + 1;
        return;
      }
      if (hit && hit.size > 1) {
        out.ambiguous++;
        unresolvedRows.push({ row: p, why: 'more than one roster name reduces to that initial and surname' });
        return;
      }
    }
    out.unresolved++;
    unresolvedRows.push({ row: p, why: 'no athlete of that name is on this team’s roster for this season' });
  });
  out.unresolved_rows = unresolvedRows;
  return out;
}

/* ============================================================================
   ONE ATHLETE, ONE ROW PER GAME.

   The provider sometimes writes the SAME passer under two spellings inside one
   game — "Cade Klubnik" on thirty-five attempts and "C.Klubnik" on one. The
   upstream assembly groups on the normalised NAME, so "cklubnik" and
   "cadeklubnik" never meet and both rows survive. Fourteen of them are in the
   corpus as shipped, and identity repair adds more, because an abbreviated
   name is exactly the kind this repository can now resolve.

   Once both rows carry the same athlete id they are, by definition, one
   athlete's game, and leaving them apart does real damage: his career game
   count is inflated, his recent-five window is filled with one-attempt
   fragments, and a per-game rate computed on a single attempt is noise
   presented as form.

   So they are merged, by the same rule the upstream fragment merge uses:
   additive fields are summed, and every rate is RECOMPUTED on its own
   denominator rather than averaged. EPA per dropback survives only if every
   fragment reconciled; if one did not, the merged row has no rate, because
   half a reconciliation is not one.
   ========================================================================== */
function mergeByAthlete(passers) {
  const groups = new Map();
  passers.forEach(p => {
    if (!p.athlete_id) return;
    const k = p.game_id + '|' + p.team_id + '|' + p.athlete_id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });
  const drop = new Set();
  const report = { groups: 0, rows_merged: 0, by_season: {} };
  groups.forEach(rs => {
    if (rs.length < 2) return;
    report.groups++;
    report.rows_merged += rs.length - 1;
    report.by_season[rs[0].season] = (report.by_season[rs[0].season] || 0) + 1;
    rs.sort((a, b) => (b.recorded_dropbacks || 0) - (a.recorded_dropbacks || 0));
    const keep = rs[0];
    const rest = rs.slice(1);
    rest.forEach(r => drop.add(r));
    const all = rs;
    const dbs = all.map(r => (r.attempts || 0) + (r.sacks || 0));
    const den = dbs.reduce((a, b) => a + b, 0);
    const att = all.reduce((a, r) => a + (r.attempts || 0), 0);
    const everyReconciled = all.every(r => r.epa_denominator_consistent === true);
    ['completions', 'attempts', 'sacks', 'passing_yards', 'passing_tds', 'interceptions']
      .forEach(c => { keep[c] = all.every(r => isNum(r[c])) ? all.reduce((a, r) => a + r[c], 0) : null; });
    keep.recorded_dropbacks = den || null;
    keep.provider_epa_total = all.every(r => isNum(r.provider_epa_total))
      ? all.reduce((a, r) => a + r.provider_epa_total, 0) : null;
    keep.epa_denominator_consistent = everyReconciled && den > 0 && isNum(keep.provider_epa_total);
    keep.epa_per_recorded_dropback = keep.epa_denominator_consistent ? keep.provider_epa_total / den : null;
    keep.provider_epa_per_play = keep.epa_per_recorded_dropback;
    keep.provider_success_rate = (den && all.every(r => isNum(r.provider_success_rate)))
      ? all.reduce((a, r, i) => a + r.provider_success_rate * dbs[i], 0) / den : null;
    keep.provider_cpoe = (att && all.every(r => isNum(r.provider_cpoe)))
      ? all.reduce((a, r) => a + r.provider_cpoe * (r.attempts || 0), 0) / att : null;
    keep.source_fragment_count = all.reduce((a, r) => a + (r.source_fragment_count || 1), 0);
    keep.source_name_variants = Array.from(new Set(all.flatMap(r => r.source_name_variants || [r.passer_name]))).sort();
    keep.merged_same_athlete_rows = all.length;
  });
  return { rows: passers.filter(p => !drop.has(p)), report };
}

/* ============================================================================
   THE TEAM CROSSWALK — ESPN numeric ids to EdgeDesk keys, per season.

   The join is on the PROVIDER'S OWN id-to-name pairs, resolved through the
   FBS module's existing normaliser. It is never a fuzzy match between two
   display strings from two different feeds, which is the join that has
   produced every board bug this project has had.
   ========================================================================== */
function buildTeams(games) {
  const teams = {};
  games.forEach(g => {
    [['home', 'away'], ['away', 'home']].forEach(([s]) => {
      const id = g[s + '_team_id'];
      const name = g[s + '_team'];
      if (!id || !name) return;
      const key = FBS.normKey(name);
      let t = teams[id];
      if (!t) { t = teams[id] = { espn_team_id: id, key, name, seasons: {} }; }
      if (t.key !== key) {
        /* the provider renamed the programme mid-window; the newest spelling
           wins for the key and both are kept so an old row still resolves */
        t.aliases = t.aliases || [];
        if (t.aliases.indexOf(t.name) < 0) t.aliases.push(t.name);
        if (g.season >= (t.name_season || 0)) { t.key = key; t.name = name; }
      }
      t.name_season = Math.max(t.name_season || 0, g.season);
      t.seasons[g.season] = { division: g[s + '_division'], conference: g[s + '_conference'] };
    });
  });
  Object.values(teams).forEach(t => { delete t.name_season; });
  return teams;
}

/* ============================================================================
   THE APP ARTIFACT
   ========================================================================== */
/* ============================================================================
   THE FROZEN CAREER SPINE.

   The 2014-onwards corpus is ~6 MB of gzipped JSONL and lives in the pipeline
   cache, which is gitignored on purpose — nobody should clone thirteen years of
   passing rows to render a card. But a weekly refresh still has to know what a
   quarterback did BEFORE this season, and a scheduled job checking out a clean
   tree has no corpus to read it from.

   So the prior seasons are frozen once into a small committed file: one row per
   athlete who has thrown recently, carrying his aggregate through the last
   completed season and a five-game tail for the recent-form window. A refresh
   then needs ONE season of source files instead of thirteen, and a corpus that
   is absent degrades the build to "this season only" rather than silently
   publishing every quarterback as if his career began in September.

   It is regenerated only when the corpus really does carry those seasons, so a
   partial corpus can never overwrite a complete spine with a worse one.
   ========================================================================== */
const SCHEMA_SPINE = 'edgedesk_fbs_epa_career_spine_v1';
const SPINE_RECENT_SEASONS = 3;

function spineFile(season) { return path.join(HERE, `career_through_${season - 1}.json`); }

function buildArtifact(o) {
  const { season, games, passers, teamGames, teams, identity, nowIso, cutoffIso } = o;
  const spineIn = o.spine || null;
  const gameById = new Map(games.map(g => [String(g.game_id), g]));
  const keyOf = tid => (teams[String(tid)] ? teams[String(tid)].key : null);

  /* --- the frozen career spine: every completed season BEFORE this one --- */
  const prior = new Map();
  const recent = new Map();
  const seasonLog = new Map();
  const leagueBySeason = {};
  const priorSeasonsSeen = new Set();

  passers.forEach(p => {
    const g = gameById.get(String(p.game_id));
    if (!g || !g.completed_by_cutoff) return;
    const db = isNum(p.recorded_dropbacks) ? p.recorded_dropbacks : null;
    const ok = p.epa_denominator_consistent === true && db > 0;
    /* the league line is EVERY passer's reconciled dropback, resolved
       identity or not. Restricting it to the passers this repository can name
       would centre the league on its starters and quietly move every
       comparison below by the gap between a starter and a backup. */
    const L = leagueBySeason[p.season] || (leagueBySeason[p.season] = { epa: 0, dropbacks: 0 });
    if (ok) { L.epa += p.provider_epa_total; L.dropbacks += db; }
    if (!p.athlete_id) return;
    const id = String(p.athlete_id);

    const row = {
      game_id: String(p.game_id), season: p.season, week: p.week, kickoff: g.kickoff,
      team_key: keyOf(p.team_id), opponent_key: keyOf(p.opponent_id),
      attempts: p.attempts, sacks: p.sacks, dropbacks: db,
      completions: p.completions, yards: p.passing_yards, tds: p.passing_tds,
      interceptions: p.interceptions,
      epa: ok ? r2(p.provider_epa_total) : null,
      epa_per_dropback: ok ? r3(p.epa_per_recorded_dropback) : null,
      epa_state: ok ? 'MEASURED' : 'DENOMINATOR_UNRECONCILED'
    };

    if (p.season < season) {
      priorSeasonsSeen.add(p.season);
      let a = prior.get(id);
      if (!a) {
        a = prior.set(id, { games: 0, epa_games: 0, dropbacks: 0, epa: 0, attempts: 0, sacks: 0,
          yards: 0, interceptions: 0, completions: 0, tds: 0, seasons: {},
          first_season: p.season, last_season: p.season }).get(id);
      }
      a.games++;
      a.attempts += p.attempts || 0; a.sacks += p.sacks || 0; a.yards += p.passing_yards || 0;
      a.interceptions += p.interceptions || 0; a.completions += p.completions || 0; a.tds += p.passing_tds || 0;
      if (ok) { a.epa_games++; a.dropbacks += db; a.epa += p.provider_epa_total; }
      a.seasons[p.season] = (a.seasons[p.season] || 0) + 1;
      a.first_season = Math.min(a.first_season, p.season);
      a.last_season = Math.max(a.last_season, p.season);
    } else if (p.season === season) {
      if (!seasonLog.has(id)) seasonLog.set(id, []);
      seasonLog.get(id).push(row);
    }
    if (p.season < season) {
      /* a SHORT tail of the previous seasons, for the recent-five window in
         the weeks before this season has five games of its own. The frozen
         career aggregate above already carries every one of these games, so
         nothing here is double counted: the tail is read for recency and the
         aggregate for the career. */
      if (!recent.has(id)) recent.set(id, []);
      recent.get(id).push(row);
    }
  });

  /* WHERE THE CAREER COMES FROM. The corpus when it carries the prior seasons;
     the frozen spine when it does not. Never a blank: a quarterback whose
     history could not be read is reported with the reason rather than as a
     quarterback whose career began this season. */
  const usingSpine = priorSeasonsSeen.size === 0 && !!(spineIn && spineIn.players);
  const priorSource = usingSpine
    ? 'football/fbs_epa/' + path.basename(spineFile(season)) + ' (frozen spine \u2014 the corpus for earlier '
      + 'seasons was not present on this run)'
    : (priorSeasonsSeen.size ? 'the 2014-onwards corpus' : 'NOTHING \u2014 neither the corpus nor a frozen spine '
      + 'carried the earlier seasons, so every career below begins this season and says so');
  if (usingSpine) {
    Object.keys(spineIn.players).forEach(id => {
      const sp = spineIn.players[id];
      if (!sp || !sp.prior) return;
      prior.set(id, Object.assign({}, sp.prior, { seasons: {} }));
      if (Array.isArray(sp.prior_log) && sp.prior_log.length) recent.set(id, sp.prior_log.slice());
      if (sp.name && !(identity.nameOf && identity.nameOf.get(id))) identity.nameOf.set(id, sp.name);
    });
  }

  /* who the artifact carries: anyone with a row in this season, plus anyone
     on this season's FBS rosters who has history (the transfers and the
     backups who become starters in week six) */
  const carry = new Set(seasonLog.keys());
  (identity.rosterAthletes || []).forEach(id => { if (prior.has(id)) carry.add(id); });

  const nameOf = new Map();
  passers.forEach(p => { if (p.athlete_id) nameOf.set(String(p.athlete_id), p.passer_name); });
  const teamOf = new Map();
  passers.forEach(p => { if (p.athlete_id && p.season === season) teamOf.set(String(p.athlete_id), keyOf(p.team_id)); });

  const players = {};
  carry.forEach(id => {
    const pr = prior.get(id) || null;
    const rec = (recent.get(id) || []).slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    players[id] = {
      athlete_id: id,
      name: (identity.nameOf && identity.nameOf.get(id)) || nameOf.get(id) || null,
      team_key: teamOf.get(id) || (identity.teamOf && identity.teamOf.get(id)) || null,
      prior: pr ? (usingSpine ? pr : {
        through_season: season - 1,
        games: pr.games, epa_games: pr.epa_games, dropbacks: pr.dropbacks,
        epa: r4(pr.epa), attempts: pr.attempts, sacks: pr.sacks, yards: pr.yards,
        completions: pr.completions, tds: pr.tds, interceptions: pr.interceptions,
        first_season: pr.first_season, last_season: pr.last_season,
        seasons_observed: Object.keys(pr.seasons).length
      }) : null,
      season_log: (seasonLog.get(id) || []).slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)),
      prior_log: rec.slice(-5)
    };
  });

  /* ------------------------------------------------- team and opponent form */
  const teamLog = {};
  teamGames.forEach(t => {
    const g = gameById.get(String(t.game_id));
    if (!g || !g.completed_by_cutoff) return;
    if (t.season !== season) return;
    const k = keyOf(t.team_id), ok2 = keyOf(t.opponent_id);
    if (!k) return;
    const row = { game_id: String(t.game_id), kickoff: g.kickoff, opponent_key: ok2,
      off_epa_per_play: r4(t.off_epa_per_play), pass_epa_per_play: r4(t.pass_epa_per_play),
      rush_epa_per_play: r4(t.rush_epa_per_play), plays: t.scrimmage_plays, pass_rate: r3(t.pass_rate) };
    (teamLog[k] = teamLog[k] || { offence: [], defence: [] }).offence.push(row);
    if (ok2) {
      (teamLog[ok2] = teamLog[ok2] || { offence: [], defence: [] }).defence.push({
        game_id: String(t.game_id), kickoff: g.kickoff, opponent_key: k,
        allowed_pass_epa_per_play: r4(t.pass_epa_per_play),
        allowed_off_epa_per_play: r4(t.off_epa_per_play), plays: t.scrimmage_plays });
    }
  });
  const teamsOut = {};
  Object.keys(teams).forEach(id => {
    const t = teams[id];
    const s = t.seasons[season];
    if (!s) return;
    const lg = teamLog[t.key] || { offence: [], defence: [] };
    teamsOut[t.key] = {
      espn_team_id: id, name: t.name, key: t.key,
      division: s.division, conference: s.conference,
      offence_log: lg.offence.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)),
      pass_defence_log: lg.defence.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))
    };
  });

  /* WHICH COMPLETED GAMES ARE NOT IN HERE. The advanced passing table is
     published on its own cadence, so a team can have played a game that no
     quarterback history contains yet. That is partial coverage and it is a
     different statement from "he did not play" and from "the artifact is
     stale". Recorded per team so the card can name the missing game. */
  const withPassing = new Set();
  passers.forEach(p => { if (p.season === season) withPassing.add(String(p.game_id)); });
  const missingByTeam = {};
  games.forEach(g => {
    if (g.season !== season || !g.completed_by_cutoff) return;
    if (withPassing.has(String(g.game_id))) return;
    [['home', 'away'], ['away', 'home']].forEach(function (pair) {
      const k = keyOf(g[pair[0] + '_team_id']);
      if (!k) return;
      (missingByTeam[k] = missingByTeam[k] || []).push({
        game_id: String(g.game_id), kickoff: g.kickoff, week: g.week,
        opponent_key: keyOf(g[pair[1] + '_team_id'])
      });
    });
  });

  const league = { by_season: {} };
  Object.keys(leagueBySeason).forEach(s => {
    const L = leagueBySeason[s];
    league.by_season[s] = { epa_per_dropback: r4(L.dropbacks ? L.epa / L.dropbacks : null), dropbacks: L.dropbacks };
  });
  league.season = league.by_season[season] || null;
  league.basis = 'every reconciled dropback in the corpus for that season, all passers, FBS-involving games only. '
    + 'The series is not stationary: see epa_contract.js finding league_drift.';

  return {
    schema: EPA.SCHEMA, version: EPA.VERSION,
    season, generated_at: nowIso, observations_through: cutoffIso,
    history: {
      first_season: FIRST_SEASON,
      career_basis: 'FBS-involving games from ' + FIRST_SEASON + ' onwards only. A transfer’s FCS snaps, his '
        + 'junior-college snaps and anything before ' + FIRST_SEASON + ' are NOT in this history and the sample '
        + 'size says so.',
      prior_frozen_through_season: season - 1,
      prior_source: priorSource,
      cut_rule: 'career and recent form are computed at read time against the kickoff being asked about; a game '
        + 'that had not finished is not in them'
    },
    contract: {
      priced_input: CONTRACT.COMPATIBILITY.priced_input,
      summary: CONTRACT.COMPATIBILITY.summary,
      provider_model_version: CONTRACT.PROVIDER_MODEL.model_version,
      ep_model_training_seasons: CONTRACT.PROVIDER_MODEL.ep_model.training_seasons
    },
    league, players, teams: teamsOut,
    /* handed back for writing, never published inside the app artifact */
    _spine: priorSeasonsSeen.size ? (() => {
      const cutoff = season - SPINE_RECENT_SEASONS;
      const out = { schema: SCHEMA_SPINE, version: 1, through_season: season - 1,
        generated_at: nowIso, from_seasons: Array.from(priorSeasonsSeen).sort(),
        basis: 'one row per athlete with a passing row in the last ' + SPINE_RECENT_SEASONS + ' seasons. The '
          + 'full corpus stays in football/data/cache; this is the part a weekly refresh cannot do without.',
        players: {} };
      prior.forEach((pr, id) => {
        if (!(pr.last_season >= cutoff)) return;
        out.players[id] = {
          name: nameOf.get(id) || null,
          prior: { through_season: season - 1,
            games: pr.games, epa_games: pr.epa_games, dropbacks: pr.dropbacks,
            epa: r4(pr.epa), attempts: pr.attempts, sacks: pr.sacks, yards: pr.yards,
            completions: pr.completions, tds: pr.tds, interceptions: pr.interceptions,
            first_season: pr.first_season, last_season: pr.last_season,
            seasons_observed: Object.keys(pr.seasons).length },
          /* the five-game tail is only useful for someone who might play this
             season, and a player last seen three years ago will not. He keeps
             his aggregate; the log would be 1.5 MB of rows nothing reads. */
          prior_log: pr.last_season === season - 1 ? (recent.get(id) || []).slice(-5) : []
        };
      });
      return out;
    })() : null,
    coverage: {
      completed_games: games.filter(g => g.season === season && g.completed_by_cutoff).length,
      completed_games_with_passing_data: withPassing.size,
      missing_passing_by_team: missingByTeam,
      why: 'a completed game with no advanced passing row is not in any quarterback\u2019s history here. It is '
        + 'reported as a gap rather than silently skipped, because a quarterback whose last game is missing '
        + 'reads as a quarterback who has not played recently.'
    }
  };
}

/* ============================================================================
   VALIDATION — schema, ids, duplicates, coverage, temporal boundaries.
   A failure is reported and, on a real build, refuses to write.
   ========================================================================== */
function validate(art, corpusGames) {
  const checks = [];
  const fail = [];
  function chk(name, cond, detail) {
    checks.push({ check: name, ok: !!cond, detail: cond ? null : (detail || null) });
    if (!cond) fail.push(name + (detail ? ' — ' + detail : ''));
  }
  chk('schema and version are the ones the adapter reads',
    art.schema === EPA.SCHEMA && art.version === EPA.VERSION, art.schema + ' v' + art.version);
  chk('every player key equals its own athlete_id',
    Object.keys(art.players).every(k => art.players[k].athlete_id === k));
  chk('no duplicate game in any player’s season log', (() => {
    return Object.keys(art.players).every(k => {
      const s = new Set(); let ok = true;
      art.players[k].season_log.forEach(r => { if (s.has(r.game_id)) ok = false; s.add(r.game_id); });
      return ok;
    });
  })());
  chk('every logged game has a parseable kickoff',
    Object.keys(art.players).every(k => art.players[k].season_log.every(r => isFinite(Date.parse(r.kickoff)))
      && art.players[k].prior_log.every(r => isFinite(Date.parse(r.kickoff)))));
  chk('the previous-season tail carries no current-season game',
    Object.keys(art.players).every(k => art.players[k].prior_log.every(r => r.season < art.season)));
  chk('the frozen career spine stops before the current season',
    Object.keys(art.players).every(k => {
      const p = art.players[k].prior;
      return !p || (p.through_season === art.season - 1 && p.last_season <= art.season - 1);
    }));
  chk('no observation is dated after the stated cutoff', (() => {
    const cut = Date.parse(art.observations_through);
    return Object.keys(art.players).every(k => art.players[k].season_log.every(r => Date.parse(r.kickoff) <= cut));
  })(), 'observations_through=' + art.observations_through);
  chk('an unreconciled denominator never carries a rate',
    Object.keys(art.players).every(k => art.players[k].season_log.concat(art.players[k].prior_log).every(r =>
      r.epa_state === 'MEASURED' ? r.epa_per_dropback != null : r.epa_per_dropback == null)));
  chk('every team in the artifact carries a division and a conference',
    Object.keys(art.teams).every(k => !!art.teams[k].division && art.teams[k].conference !== undefined));
  chk('the FBS universe for this season is covered', (() => {
    const fbs = Object.keys(art.teams).filter(k => art.teams[k].division === 'fbs');
    return fbs.length >= 130;
  })(), Object.keys(art.teams).filter(k => art.teams[k].division === 'fbs').length + ' FBS teams');
  chk('no outcome field reached the artifact', (() => {
    const s = JSON.stringify(art);
    return s.indexOf('"team_margin"') < 0 && s.indexOf('"home_points"') < 0 && s.indexOf('"home_margin"') < 0;
  })());
  chk('the pricing flag is carried, and it is the contract’s',
    art.contract.priced_input === CONTRACT.COMPATIBILITY.priced_input);
  /* Only rows from seasons THIS RUN actually read can be checked against it.
     A frozen-spine row from 2024 is not in a one-season corpus, and failing the
     build for that would mean a refresh could never use the spine it exists
     to use. Its own build checked it when it was written. */
  chk('every game log row from a season this run read resolves to a fixture in it', (() => {
    const ids = new Set(corpusGames.map(g => String(g.game_id)));
    const seasons = new Set(corpusGames.map(g => g.season));
    return Object.keys(art.players).every(k =>
      art.players[k].season_log.concat(art.players[k].prior_log)
        .every(r => !seasons.has(r.season) || ids.has(r.game_id)));
  })());
  return { ok: fail.length === 0, checks, failures: fail };
}

/* ============================================================================
   MAIN
   ========================================================================== */
async function main() {
  const now = new Date();
  const nowIso = now.toISOString();
  const outArtifact = path.join(HERE, `qb_epa_${SEASON}.json`);
  const outTeams = path.join(HERE, 'teams.json');
  const outIndex = path.join(HERE, 'index.json');

  let games = readCorpus('games');
  let passers = readCorpus('passer_games');
  let teamGames = readCorpus('team_games');
  const haveCorpus = !!(games && passers && teamGames);
  if (!haveCorpus) {
    log('no historical corpus at ' + CORPUS);
    if (!REFRESH) {
      log('  nothing to build from. Run with --refresh to fetch, or restore the corpus cache.');
      process.exitCode = 2;
      return;
    }
    games = []; passers = []; teamGames = [];
  }

  const source = {
    repository: PROVIDER_REPO,
    corpus: { path: path.relative(ROOT, CORPUS), present: haveCorpus,
      rows: haveCorpus ? { games: games.length, passer_games: passers.length, team_games: teamGames.length } : null },
    manifest: readJson(path.join(CORPUS, '..', 'sources.json'), null),
    refreshed: null
  };
  if (source.manifest) {
    source.commit = source.manifest.source_commit;
    const times = (source.manifest.files || []).map(f => f.retrieved_at).filter(Boolean).sort();
    source.corpus_retrieved_at = times.length ? times[times.length - 1] : null;
    source.files = (source.manifest.files || []).length;
    delete source.manifest;
  }

  /* ------------------------------------------------- the season in progress */
  let refreshReport = { attempted: false, ok: false, why: 'not requested', files: [] };
  if (REFRESH && !OFFLINE) {
    refreshReport = { attempted: true, ok: false, why: null, files: [] };
    let sha = String(arg('commit', '') || '') || 'main';
    const dl = path.join(CORPUS, '..', 'raw');
    const tables = {};
    for (const kind of KINDS) {
      const file = `${kind}_${SEASON}.parquet`;
      const url = `${RAW}/${sha}/cfb/${kind}/parquet/${file}`;
      const dest = path.join(dl, file);
      const got = await grab(url, dest);
      refreshReport.files.push({ file, url, ok: got.ok, bytes: got.bytes || null,
        sha256: got.sha256 || null, why: got.why || null, retrieved_at: got.ok ? nowIso : null });
      if (!got.ok) continue;
      try { tables[kind] = parquetToRows(dest); }
      catch (e) {
        refreshReport.files[refreshReport.files.length - 1].ok = false;
        refreshReport.files[refreshReport.files.length - 1].why = 'parquet could not be read: ' + e.message;
      }
    }
    if (tables.adv_passing && tables.cfb_schedules) {
      /* THE PROVIDER'S OWN ROSTER RESOLVES FIRST, exactly as the assembled
         corpus did, so a refreshed season is built by the same rule the
         historical ones were and a refresh cannot quietly re-identify twelve
         years of history differently from one week of it. EdgeDesk's own
         roster is then layered on top by repairIdentities() below, which is
         an ADDITION to that rule and never a replacement for it. */
      const provRoster = tables.cfb_rosters ? providerRosterIndex(tables.cfb_rosters) : new Map();
      const ident0 = identityIndexFor(SEASON);
      if (!tables.cfb_rosters) {
        refreshReport.roster_note = 'the provider roster file for this season could not be read, so provider-side '
          + 'identity was resolved from EdgeDesk\u2019s roster alone. Coverage will be lower, not wrong.';
      }
      const built = buildSeasonRows(SEASON, tables, {
        cutoff: now.getTime(),
        identityOf: (tid, nk) => {
          const a = provRoster.get(String(tid) + '|' + nk);
          if (a && a.size) return a;
          const m = ident0.byTeam.get(String(tid));
          return (m && m.full.get(nk)) || new Set();
        }
      });
      games = games.filter(g => g.season !== SEASON).concat(built.games);
      passers = passers.filter(p => p.season !== SEASON).concat(built.passers);
      teamGames = teamGames.filter(t => t.season !== SEASON).concat(built.teams);
      refreshReport.ok = true;
      refreshReport.built = { games: built.games.length, passer_games: built.passers.length,
        team_games: built.teams.length, quarantined: built.quarantine.length, issues: built.issues };
      if (!CHECK) {
        writeCorpus('games', games);
        writeCorpus('passer_games', passers);
        writeCorpus('team_games', teamGames);
      }
      source.refreshed = { at: nowIso, commit: sha, season: SEASON };
    } else {
      refreshReport.why = 'the season in progress could not be fetched or read; the corpus was left as it was';
      log('  refresh failed: ' + refreshReport.why);
    }
  } else if (REFRESH && OFFLINE) {
    refreshReport = { attempted: false, ok: false, why: '--offline was set', files: [] };
  }

  /* ------------------------------------------------------- identity repair */
  const identity = identityIndexFor(SEASON);
  const roster = readJson(path.join(ROOT, 'football', 'rosters', `fbs_${SEASON}_espn.json`), null);
  identity.rosterAthletes = [];
  identity.nameOf = new Map();
  identity.teamOf = new Map();
  const teams = buildTeams(games);
  const keyByEspn = {}; Object.keys(teams).forEach(id => { keyByEspn[id] = teams[id].key; });
  if (roster && Array.isArray(roster.teams)) {
    roster.teams.forEach(t => (t.players || []).forEach(p => {
      if (!p.espn_id) return;
      if (String(p.position || '').toUpperCase() !== 'QB') return;
      identity.rosterAthletes.push(String(p.espn_id));
      identity.nameOf.set(String(p.espn_id), p.name || null);
      identity.teamOf.set(String(p.espn_id), keyByEspn[String(t.espn_id)] || FBS.normKey(t.location || t.short_name));
    }));
  }
  const repair = repairIdentities(passers, SEASON, identity, keyByEspn);
  repair.resolved_at_assembly = repair.already;
  delete repair.already;
  const merged = mergeByAthlete(passers);
  passers = merged.rows;
  repair.same_athlete_rows_merged = merged.report;
  const unresolvedSummary = {};
  (repair.unresolved_rows || []).forEach(r => {
    unresolvedSummary[r.why] = (unresolvedSummary[r.why] || 0) + 1;
  });
  delete repair.unresolved_rows;
  repair.unresolved_reasons = unresolvedSummary;

  /* --------------------------------------------------------- the artifacts */
  const completed = games.filter(g => g.completed_by_cutoff && g.season === SEASON);
  /* OBSERVED THROUGH is the last game that actually carries passing rows, not
     the last game that finished. The provider publishes the advanced passing
     table on its own cadence, and a season whose schedule is up to date while
     its passing table is a week behind is PARTIAL COVERAGE — a different
     state from stale, and a different state again from a team that genuinely
     has not played. Reporting the schedule's clock here would hide it. */
  const withPassing = new Set(passers.filter(p => p.season === SEASON).map(p => String(p.game_id)));
  const observedKicks = completed.filter(g => withPassing.has(String(g.game_id)))
    .map(g => Date.parse(g.kickoff)).filter(isFinite).sort((a, b) => a - b);
  const completedKicks = completed.map(g => Date.parse(g.kickoff)).filter(isFinite).sort((a, b) => a - b);
  const cutoffIso = observedKicks.length ? new Date(observedKicks[observedKicks.length - 1]).toISOString() : nowIso;
  const lastCompletedIso = completedKicks.length
    ? new Date(completedKicks[completedKicks.length - 1]).toISOString() : null;

  const spine = readJson(spineFile(SEASON), null);
  const art = buildArtifact({ season: SEASON, games, passers, teamGames, teams, identity, nowIso, cutoffIso, spine });
  const spineOut = art._spine || null;
  delete art._spine;
  const val = validate(art, games);

  /* ---------------------------------------------------------- the coverage */
  const seasonPassers = passers.filter(p => p.season === SEASON);
  const coverage = {
    season: SEASON,
    scheduled_fbs_involving_games: games.filter(g => g.season === SEASON).length,
    completed_by_cutoff: completed.length,
    completed_games_with_passing_data: withPassing.size,
    passer_rows: seasonPassers.length,
    passer_rows_with_athlete_id: seasonPassers.filter(p => p.athlete_id).length,
    identity: repair,
    players_in_artifact: Object.keys(art.players).length,
    players_with_frozen_career: Object.keys(art.players).filter(k => art.players[k].prior).length,
    players_with_current_season_games: Object.keys(art.players).filter(k => art.players[k].season_log.length).length,
    teams_in_artifact: Object.keys(art.teams).length,
    fbs_teams: Object.keys(art.teams).filter(k => art.teams[k].division === 'fbs').length,
    by_season: {}
  };
  const seasons = Array.from(new Set(games.map(g => g.season))).sort();
  seasons.forEach(s => {
    const gs = games.filter(g => g.season === s);
    const ps = passers.filter(p => p.season === s);
    coverage.by_season[s] = {
      games: gs.length, completed: gs.filter(g => g.completed_by_cutoff).length,
      fbs_teams: new Set(gs.flatMap(g => [g.home_division === 'fbs' ? g.home_team_id : null,
        g.away_division === 'fbs' ? g.away_team_id : null]).filter(Boolean)).size,
      passer_rows: ps.length,
      passer_rows_with_athlete_id: ps.filter(p => p.athlete_id).length,
      epa_reconciled_rows: ps.filter(p => p.epa_denominator_consistent).length
    };
  });

  /* starter-layer coverage: the question the product actually asks */
  const starters = readJson(path.join(ROOT, 'football', 'starters', `cfb_${SEASON}.json`), null);
  if (starters && starters.teams) {
    const fbsKeys = new Set(Object.keys(art.teams).filter(k => art.teams[k].division === 'fbs'));
    const recs = Object.values(starters.teams).filter(r => fbsKeys.has(r.team_id));
    const joined = recs.filter(r => r.player_id && art.players[String(r.player_id)]);
    const withHistory = joined.filter(r => {
      const p = art.players[String(r.player_id)];
      return (p.prior && p.prior.epa_games) || p.season_log.some(g => g.epa_state === 'MEASURED');
    });
    coverage.starters = {
      fbs_teams_with_a_starter_record: recs.length,
      with_a_resolved_player: recs.filter(r => r.player_id).length,
      joined_to_this_artifact: joined.length,
      with_measured_epa_history: withHistory.length,
      no_epa_history: joined.length - withHistory.length,
      unjoined: recs.filter(r => r.player_id && !art.players[String(r.player_id)])
        .map(r => ({ team: r.team, player: r.player_name, player_id: r.player_id,
          why: 'no FBS passing row in ' + FIRST_SEASON + '–' + SEASON + ' carries this athlete id — a '
            + 'true freshman, an FCS transfer or a passer who has not yet thrown' })),
      note: 'a starter with no measured history is NOT a starter with average history. He is reported with an '
        + 'empty sample and the reason.'
    };
  }

  /* ----------------------------------------------------- freshness and age */
  const prevArt = readJson(outArtifact, null);
  const missingGames = completed.length - withPassing.size;
  const freshness = {
    generated_at: nowIso,
    observations_through: cutoffIso,
    last_completed_game: lastCompletedIso,
    observation_age_hours: r3((now.getTime() - Date.parse(cutoffIso)) / 3600000),
    completed_games_without_passing_data: missingGames,
    coverage: missingGames === 0 ? 'COMPLETE' : 'PARTIAL',
    coverage_why: missingGames === 0 ? null
      : missingGames + ' completed ' + (missingGames === 1 ? 'game has' : 'games have')
        + ' no advanced passing row yet. The provider publishes that table on its own cadence, so those games '
        + 'are NOT in any quarterback\u2019s history here \u2014 partial coverage, not an absence of football.',
    source_commit: source.commit || null,
    source_retrieved_at: source.refreshed ? source.refreshed.at : (source.corpus_retrieved_at || null),
    source_age_hours: null,
    state: 'FRESH',
    why: null
  };
  if (freshness.source_retrieved_at) {
    freshness.source_age_hours = r3((now.getTime() - Date.parse(freshness.source_retrieved_at)) / 3600000);
  }
  if (REFRESH && !refreshReport.ok) {
    freshness.state = 'STALE';
    freshness.why = 'the upstream fetch did not succeed on this run, so the previous observations were kept. '
      + (refreshReport.why || '') + ' They are ' + (freshness.source_age_hours == null ? 'of unknown age'
        : Math.round(freshness.source_age_hours) + ' hours old') + '.';
  } else if (freshness.source_age_hours != null && freshness.source_age_hours > 24 * 8) {
    freshness.state = 'STALE';
    freshness.why = 'the source has not been re-read in over eight days';
  }

  const index = {
    schema: SCHEMA_INDEX, version: 1,
    generated_at: nowIso, season: SEASON,
    source, refresh: refreshReport, freshness,
    coverage,
    validation: { ok: val.ok, checks: val.checks, failures: val.failures },
    contract: {
      priced_input: CONTRACT.COMPATIBILITY.priced_input,
      summary: CONTRACT.COMPATIBILITY.summary,
      blocking_findings: CONTRACT.COMPATIBILITY.blocking_findings,
      what_would_settle_it: CONTRACT.COMPATIBILITY.what_would_settle_it,
      provider_model: CONTRACT.PROVIDER_MODEL.model_version,
      ep_model_training_seasons: CONTRACT.PROVIDER_MODEL.ep_model.training_seasons
    },
    artifacts: {
      quarterbacks: path.posix.join('football', 'fbs_epa', `qb_epa_${SEASON}.json`),
      teams: 'football/fbs_epa/teams.json',
      career_spine: path.posix.join('football', 'fbs_epa', `career_through_${SEASON - 1}.json`)
    },
    career_history: { source: art.history.prior_source,
      frozen_through_season: SEASON - 1,
      spine_rewritten_this_run: !!spineOut },
    note: 'source coverage, information coverage and PRICED coverage are three different numbers. This file '
      + 'reports the first two. Nothing here changes the third: every measurement it describes is research, and '
      + 'football/fbs_epa/epa_contract.js says why in detail.'
  };

  /* ------------------------------------------------------------- reporting */
  log(`FBS EPA — season ${SEASON}`);
  log(`  corpus            ${games.length} games / ${passers.length} passer rows / ${teamGames.length} team rows`);
  log(`  this season       ${coverage.completed_by_cutoff} completed of ${coverage.scheduled_fbs_involving_games} scheduled, ${coverage.passer_rows} passer rows`);
  log(`  identity          ${coverage.passer_rows_with_athlete_id}/${coverage.passer_rows} resolved `
    + `(${repair.resolved_at_assembly} at assembly, ${repair.repaired} repaired against EdgeDesk\u2019s roster, `
    + `${repair.ambiguous} left ambiguous, ${repair.unresolved} unresolved)`);
  if (coverage.starters) {
    log(`  starters          ${coverage.starters.with_measured_epa_history}/${coverage.starters.fbs_teams_with_a_starter_record} FBS starters carry measured EPA history`);
  }
  log(`  artifact          ${coverage.players_in_artifact} passers, ${coverage.teams_in_artifact} teams (${coverage.fbs_teams} FBS)`);
  log(`  career history    ${art.history.prior_source}`);
  log(`  freshness         ${freshness.state}${freshness.why ? ' — ' + freshness.why : ''}`);
  log(`  validation        ${val.ok ? 'PASS' : 'FAIL'} (${val.checks.filter(c => c.ok).length}/${val.checks.length})`);
  val.failures.forEach(f => log('    ! ' + f));
  log(`  pricing           points_applied=false — ${CONTRACT.COMPATIBILITY.blocking_findings.join(', ')}`);

  if (CHECK) { process.exitCode = val.ok ? 0 : 1; return; }
  if (!val.ok) {
    log('  refusing to write an artifact that fails its own validation');
    if (prevArt) log('  the previous artifact is left in place');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(outArtifact, JSON.stringify(art) + '\n');
  /* The spine is rewritten ONLY when this run really read the earlier seasons.
     A refresh that had no corpus leaves the committed spine exactly as it was
     rather than replacing thirteen years of history with nothing. */
  if (spineOut) {
    fs.writeFileSync(spineFile(SEASON), JSON.stringify(spineOut) + '\n');
    log('  wrote ' + path.relative(ROOT, spineFile(SEASON)) + ' ('
      + Object.keys(spineOut.players).length + ' athletes, '
      + Math.round(fs.statSync(spineFile(SEASON)).size / 1024) + ' KB)');
  } else if (spine) {
    log('  kept the committed career spine (this run read no earlier season)');
  }
  /* A REFRESH THAT READ ONE SEASON MUST NOT REWRITE THIRTEEN YEARS OF
     MEMBERSHIP. The crosswalk is merged into the committed one rather than
     replacing it: this season's rows are updated, every earlier season the
     corpus did not carry is kept exactly as it was. */
  const prevTeams = readJson(outTeams, null);
  let mergedTeams = teams;
  const seasonsInCorpus = new Set(games.map(g => g.season));
  if (prevTeams && prevTeams.teams && seasonsInCorpus.size < 3) {
    mergedTeams = JSON.parse(JSON.stringify(prevTeams.teams));
    Object.keys(teams).forEach(id => {
      if (!mergedTeams[id]) { mergedTeams[id] = teams[id]; return; }
      mergedTeams[id].key = teams[id].key;
      mergedTeams[id].name = teams[id].name;
      Object.keys(teams[id].seasons).forEach(y => { mergedTeams[id].seasons[y] = teams[id].seasons[y]; });
    });
    log('  merged the team crosswalk into the committed one (this run read '
      + seasonsInCorpus.size + ' season(s))');
  }
  fs.writeFileSync(outTeams, JSON.stringify({ schema: SCHEMA_TEAMS, version: 1, generated_at: nowIso,
    first_season: FIRST_SEASON, teams: mergedTeams }) + '\n');
  fs.writeFileSync(outIndex, JSON.stringify(index, null, 1) + '\n');
  log('  wrote ' + path.relative(ROOT, outArtifact) + ' ('
    + Math.round(fs.statSync(outArtifact).size / 1024) + ' KB), teams.json, index.json');
}

if (require.main === module) {
  main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { buildSeasonRows, buildTeams, buildArtifact, validate, repairIdentities, mergeByAthlete,
  spineFile, SCHEMA_SPINE,
  providerRosterIndex,
  identityIndexFor, normName, splitLine, parseCsv, readCorpus, FIRST_SEASON };
