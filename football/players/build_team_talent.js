#!/usr/bin/env node
/* ============================================================================
   TEAM RECRUITING TALENT — the part of the pedigree question that IS public.

   WHAT WAS WRONG WITH THE OLD ANSWER. Every path in this repository reported
   `recruiting_talent` as a permanent gap with the same sentence: per-player
   recruiting ratings are subscription data and none is substituted. That
   sentence is true and it was answering a question nobody asked. The contract
   field is `recruiting_talent` — how much recruiting pedigree is on this
   roster — and the PER-TEAM composite that answers it is published, keyless,
   in the same sportsdataverse mirror this repository already reads for play
   attribution and rosters.

   So the gap is split into the two statements that were hiding inside it:

     per player   still unavailable, still subscription data, still not
                  substituted. football/players/recruiting_adapter.js remains
                  the injection point and still ships every field null.
     per team     AVAILABLE: talent_composite, talent_rank, blue_chip_ratio
                  and the recruit count behind them, for ~310 programmes.

   WHAT THE NUMBER IS, precisely, because a composite nobody defines is worth
   nothing: `talent_composite` is the sum of the industry composite ratings of
   the players on a roster, as the provider computes it — a ROSTER-LEVEL
   PEDIGREE TOTAL. It is therefore correlated with roster SIZE and with class
   retention, it is NOT a rating of how good the team is, and it is not on the
   same scale as anything EdgeDesk fits. `blue_chip_ratio` is the share of the
   roster that carried a four- or five-star rating. Both are published as
   RESEARCH until a coefficient is earned against them, exactly as the EPA
   series is, and neither moves a point of the projection.

     node football/players/build_team_talent.js [--season 2026] [--check]
          [--offline] [--out football/players/team_talent.json]

   --check writes nothing and exits non-zero if the table could not be read.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data/main/cfb/cfb_team_talent/parquet';
const PY_HELPER = path.join(ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
const SCHEMA = 'edgedesk_team_talent_v1';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };
function num(v) { if (v == null || v === '' || v === 'NA') return null; const x = +v; return isFinite(x) ? x : null; }

/* the engine's own normaliser, so a team keys the same here as everywhere */
function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}

function parseCsv(text) {
  const lines = String(text).split('\n').filter(l => l.length);
  if (!lines.length) return [];
  const head = lines[0].replace(/\r$/, '').split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].replace(/\r$/, '').split(',');
    if (f.length < head.length) continue;
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j].replace(/^"|"$/g, '')] = String(f[j]).replace(/^"|"$/g, '');
    out.push(o);
  }
  return out;
}

async function grab(url, dest) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (r.status === 404) return { ok: false, why: 'not published for this season (HTTP 404)' };
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { ok: true, bytes: buf.length };
}

/* IDENTITY IS RESOLVED ON AN ID, NOT ON A NAME.

   The first version of this matched the provider's full team name
   ("Georgia Bulldogs") against the roster's school keys by longest prefix,
   and it did two things wrong at once. It refused 154 rows including App
   State, San Jose State and FIU because their provider spellings are not
   prefixed by the roster's spelling. And it silently joined "Houston
   Christian Huskies" — an FCS programme — onto `houston`, because `houston`
   IS a prefix of it. A wrong join is worse than a refusal: it publishes a
   number under the wrong team's name and nothing downstream can tell.

   The provider's `team_id` is the ESPN athlete-data team id, the SAME id
   football/rosters/fbs_<season>_espn.json keys every programme by. So the
   join is on that id and the name is used only to CORROBORATE it: a row
   whose id resolves to a team whose name shares no token with the provider's
   is refused rather than trusted, and a row with no id is refused outright.
   Nothing is guessed onto a near match. */
function schoolIndex(season) {
  const byId = new Map();
  const names = new Map();
  for (const y of [season, season - 1]) {
    let roster = null;
    try { roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rosters', `fbs_${y}_espn.json`), 'utf8')); }
    catch (_) { continue; }
    for (const t of (roster.teams || [])) {
      const key = normKey(t.location || t.display_name);
      if (!key) continue;
      if (t.espn_id != null && !byId.has(String(t.espn_id))) byId.set(String(t.espn_id), key);
      names.set(key, [t.location, t.display_name, t.short_name, t.nickname].filter(Boolean));
    }
    if (byId.size) break;
  }
  return { byId, names };
}

/* one token in common between the provider's spelling and any of the roster's
   spellings for that team — enough to catch an id that points somewhere else,
   without demanding the two feeds spell a school identically */
function corroborates(providerName, spellings) {
  const a = String(providerName || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(x => x.length >= 3);
  const b = (spellings || []).join(' ').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(x => x.length >= 3);
  if (!a.length || !b.length) return false;
  return a.some(x => b.indexOf(x) >= 0);
}

function resolve(row, idx) {
  const id = row && row.team_id != null ? String(row.team_id).replace(/\.0$/, '') : null;
  if (!id || !idx.byId.has(id)) return { key: null, why: id ? 'team_id ' + id + ' is not an FBS programme in the roster sync' : 'the provider row carries no team_id' };
  const key = idx.byId.get(id);
  if (!corroborates(row.team, idx.names.get(key))) {
    return { key: null, why: 'team_id ' + id + ' resolves to ' + key + ', whose roster spellings share no token with "'
      + row.team + '" — refused rather than joined on an id EdgeDesk cannot corroborate' };
  }
  return { key: key, why: null };
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const check = !!arg('check', false);
  const offline = !!arg('offline', false);
  const dest = path.join(ROOT, String(arg('out', 'football/players/team_talent.json')));
  const file = `cfb_team_talent_${season}.parquet`;
  const url = `${RAW}/${file}`;
  const tmp = path.join(ROOT, 'football', 'players', '.cache', file);

  if (offline) { log('[talent] --offline: nothing fetched'); return 0; }
  const got = await grab(url, tmp);
  if (!got.ok) {
    console.error('[talent] ' + url + ' — ' + got.why);
    console.error('[talent] nothing is written: an unavailable season stays unavailable rather than being '
      + 'filled from a different one');
    return check ? 2 : 1;
  }
  let rows;
  try { rows = parseCsv(execFileSync('python3', [PY_HELPER, tmp], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')); }
  catch (e) { console.error('[talent] the parquet could not be read: ' + ((e && e.message) || e)); return 2; }
  if (!rows.length) { console.error('[talent] the table is empty'); return 2; }

  const idx = schoolIndex(season);
  const teams = {};
  const refused = [];
  let composites = 0, blue = 0;
  for (const r of rows) {
    if (num(r.season) !== season) continue;
    const res = resolve(r, idx);
    const key = res.key;
    if (!key) { refused.push({ team: r.team, team_id: r.team_id || null, why: res.why }); continue; }
    const comp = num(r.talent_composite);
    const bc = num(r.blue_chip_ratio);
    teams[key] = {
      provider_team: r.team,
      provider_team_id: r.team_id || null,
      talent_composite: comp == null ? null : Math.round(comp * 10) / 10,
      talent_rank: num(r.talent_rank),
      blue_chip_ratio: bc == null ? null : Math.round(bc * 1000) / 1000,
      recruits: num(r.n_recruits)
    };
    if (comp != null) composites++;
    if (bc != null) blue++;
  }

  /* WHICH FBS PROGRAMMES THE PROVIDER SIMPLY DOES NOT PUBLISH. Separated
     from the refusals above on purpose: a refused row is an identity EdgeDesk
     would not guess at, and this is a team the source never carried. They are
     different problems with different fixes and one list for both hides
     whichever is smaller. */
  const notPublished = [];
  for (const [id, key] of idx.byId.entries()) {
    if (!teams[key]) notPublished.push({ team_key: key, espn_team_id: id });
  }

  const out = {
    schema: SCHEMA, version: 1, season,
    generated_at: new Date().toISOString(),
    source: 'sportsdataverse/cfbfastR-cfb-data cfb_team_talent',
    source_url: url,
    definitions: {
      talent_composite: 'the provider’s roster-level total of industry composite recruiting ratings. It is a '
        + 'PEDIGREE TOTAL, correlated with roster size and class retention, and it is not a rating of how good '
        + 'the team is.',
      talent_rank: 'the provider’s national rank on that total, 1 = highest',
      blue_chip_ratio: 'the share of the roster that carried a four- or five-star rating',
      recruits: 'how many rated recruits the composite was summed over'
    },
    scope: 'TEAM LEVEL ONLY. Per-player recruiting ratings remain subscription data and are still not '
      + 'substituted anywhere; football/players/recruiting_adapter.js ships every per-player field null.',
    pricing: 'RESEARCH ONLY. No coefficient has been fitted against this series on this corpus, so it moves no '
      + 'point of any projection. It fills the recruiting_talent contract field and nothing else.',
    teams_resolved: Object.keys(teams).length,
    with_composite: composites,
    with_blue_chip: blue,
    refused: refused.slice(0, 40),
    refused_count: refused.length,
    fbs_not_published: notPublished,
    fbs_not_published_count: notPublished.length,
    coverage_note: 'refused rows are provider rows EdgeDesk would not join on an identity it could not corroborate; '
      + 'fbs_not_published are FBS programmes the provider\u2019s table does not carry at all. The first is an '
      + 'EdgeDesk problem and the second is a source problem, and they are never counted together.',
    teams
  };

  if (check) {
    log('[talent] --check: ' + out.teams_resolved + ' teams resolved, ' + refused.length + ' provider rows refused');
    return out.teams_resolved >= 100 ? 0 : 2;
  }
  if (out.teams_resolved < 100) {
    console.error('[talent] only ' + out.teams_resolved + ' teams resolved — refusing to write a hollow artifact');
    return 2;
  }
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  log('[talent] wrote ' + path.relative(ROOT, dest) + ' — ' + out.teams_resolved + ' teams, '
    + composites + ' with a composite, ' + blue + ' with a blue-chip ratio, ' + refused.length + ' provider rows refused, '
    + notPublished.length + ' FBS programme(s) the provider does not publish'
    + (notPublished.length ? ' (' + notPublished.map(x => x.team_key).join(', ') + ')' : ''));
  return 0;
}

module.exports = { resolve, schoolIndex, normKey, SCHEMA };
if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[talent] ' + ((e && e.stack) || e)); process.exit(2); });
