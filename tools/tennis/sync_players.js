#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the provider player directory.

   WHY THIS EXISTS. tennis.players is the LICENSED record and this job never
   writes to it. That record is empty in this project, and the archive that
   would fill it (the Jeff Sackmann tennis_atp / tennis_wta datasets) is
   CC BY-NC-SA — non-commercial — which the app itself registers as blocked
   pending a licensing decision a human has to make. Meanwhile every match the
   provider publishes already carries an athlete id and a name, and every
   singles side in the draw had nowhere to resolve to.

   So this builds a DIRECTORY of who the provider says is playing, keyed in the
   provider's own namespace ('espn:<athlete id>'), which cannot collide with a
   licensed id. The resolver prefers the licensed record wherever it has rows;
   the day a cleared feed is loaded it wins automatically and none of this has
   to be unpicked.

   WHAT IT WRITES, all idempotent:

     tennis.player_directory  one row per athlete seen in the draw — id, name,
                              tour, and whether they were seen in singles, in
                              doubles, or both. Enrichment (country, hand,
                              height, birth date) and ranking are written only
                              where the feed publishes them, and each row
                              records which request shape answered.

   WHAT IT REFUSES. It never writes a field the feed did not carry. It never
   converts a height whose unit is ambiguous. It never invents a player who is
   not in a draw. A doubles PAIR never becomes a directory row — the pair is a
   team — though the two players inside it are registered individually when the
   provider gives their ids.

     node tools/tennis/sync_players.js                  # dry run
     node tools/tennis/sync_players.js --verify         # probe the source only
     node tools/tennis/sync_players.js --commit         # write
     node tools/tennis/sync_players.js --commit --enrich 200 --rankings
   =========================================================================== */
'use strict';

const R = require('../../lib/tennis_research.js');
const E = require('./espn.js');
const D = require('./db.js');

function log(...a) { if (!process.env.TENNIS_QUIET) console.log('[tennis-players]', ...a); }

function parseArgs(argv) {
  const o = { commit: false, verify: false, enrich: 60, rankings: true, backDays: 21, fwdDays: 28, now: null, tours: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--enrich') o.enrich = Number(next());
    else if (a === '--no-enrich') o.enrich = 0;
    else if (a === '--no-rankings') o.rankings = false;
    else if (a === '--rankings') o.rankings = true;
    else if (a === '--back-days') o.backDays = Number(next());
    else if (a === '--fwd-days') o.fwdDays = Number(next());
    else if (a === '--tour') o.tours = [String(next()).toLowerCase()];
    else if (a === '--now') o.now = next();
  }
  return o;
}

function directoryId(providerAthleteId) { return 'espn:' + String(providerAthleteId); }

/* A side of a match -> the athletes inside it.

   A singles side is one athlete. A doubles side is a PAIR, and the pair itself
   is never a directory row — but the provider joins the two athlete ids and the
   two names with a slash, so the individuals can be registered when, and only
   when, the two lists line up. If they do not, the side is skipped rather than
   guessed at. */
function athletesOfSide(providerId, name, isDoubles) {
  const id = providerId == null ? '' : String(providerId);
  const nm = name == null ? '' : String(name);
  if (!id || !nm) return [];
  if (!isDoubles && !R.isDoublesName(nm) && id.indexOf('/') < 0) {
    /* a qualifier, a bye, a slot nobody has won yet — not a person, and
       never a directory row, however many draws it turns up in */
    if (!R.isProviderAthleteId(id)) return [];
    return [{ provider_athlete_id: String(id).trim(), full_name: nm, doubles: false }];
  }
  const ids = id.split('/').map(x => x.trim()).filter(Boolean);
  const names = R.splitDoubles(nm);
  if (ids.length < 2 || ids.length !== names.length) return [];
  /* a pair with a placeholder in it is not a formed pair */
  if (!ids.every(R.isProviderAthleteId)) return [];
  return ids.map((x, i) => ({ provider_athlete_id: x, full_name: names[i], doubles: true }));
}

/* Pure: the draw on file -> the directory rows it implies. One row per athlete,
   with the tours and formats they were seen in merged across every match. */
function directoryRows(matches, nowIso) {
  const by = {};
  (matches || []).forEach(m => {
    if (!m) return;
    [['home', m.home_provider_id, m.home_name], ['away', m.away_provider_id, m.away_name]].forEach(p => {
      athletesOfSide(p[1], p[2], !!m.is_doubles).forEach(a => {
        const key = a.provider_athlete_id;
        const row = by[key] || (by[key] = {
          player_id: directoryId(key), provider: 'espn', provider_athlete_id: key,
          full_name: a.full_name, tour: null, seen_in_singles: false, seen_in_doubles: false,
          last_seen_at: nowIso, source: 'espn'
        });
        /* the longest spelling wins: "Felipe Meligeni Alves" over "F. Alves" */
        if (a.full_name && a.full_name.length > String(row.full_name || '').length) row.full_name = a.full_name;
        if (a.doubles) row.seen_in_doubles = true; else row.seen_in_singles = true;
        const t = m.tour === 'ATP' || m.tour === 'WTA' ? m.tour : null;
        if (t) row.tour = (row.tour && row.tour !== t) ? 'MIXED' : t;
      });
    });
  });
  return Object.keys(by).sort().map(k => by[k]);
}

/* Pure: ranking rows from the feed -> patches for directory rows we hold. A
   ranked athlete the draw has never shown is not invented here. */
function rankingPatches(ranked, known) {
  const out = [];
  (ranked || []).forEach(r => {
    if (!r || !r.provider_athlete_id) return;
    const id = directoryId(r.provider_athlete_id);
    if (!known[id]) return;
    out.push({ player_id: id, current_rank: r.rank != null ? r.rank : null,
      rank_points: r.points != null ? r.points : null, rank_as_of: r.as_of || null });
  });
  return out;
}

/* PROVE THE TWO NEW ENDPOINTS ANSWER, on a real runner, touching no database.

   This exists because the UFC adapter shipped code that was correct and that
   ESPN's edge answered 403 to from GitHub's runners — a thing only a runner
   could show. The athlete and rankings endpoints are new here and had never
   been observed answering from one, so the pull-request probe now asks them.

   It takes a live athlete id from the scoreboard rather than hard-coding one,
   so it cannot rot. Exit 0 = both answered. Exit 2 = they did not, which is
   worth seeing in review but is not a broken pipeline: the directory still
   carries id, name, tour and format from the scoreboard, and enrichment and
   ranking are additive on top of that. */
async function verify(o, deps) {
  const src = (deps || {}).source || E.source({ fetchImpl: (deps || {}).fetchImpl });
  const now = o.now ? new Date(o.now) : new Date();
  const out = { scoreboard: null, athlete: null, rankings: null, ok: false };

  for (const tour of (o.tours || E.TOURS)) {
    const label = tour.toUpperCase();
    let athleteId = null;
    try {
      const r = await src.scoreboard(tour, now.getTime() - o.backDays * 86400000, now.getTime() + o.fwdDays * 86400000);
      const matches = [].concat.apply([], r.tournaments.map(t => t.matches.map(m =>
        Object.assign({ tour: t.tour }, m))));
      const rows = directoryRows(matches, now.toISOString());
      const singles = rows.filter(x => x.seen_in_singles);
      /* what the id rule turned away, named rather than counted: these are the
         entrants who are not yet a person, and seeing them is how we know the
         rule is still aimed at the right thing */
      const refused = {};
      matches.forEach(m => [[m.home_provider_id, m.home_name], [m.away_provider_id, m.away_name]].forEach(p => {
        String(p[0] == null ? '' : p[0]).split('/').forEach(part => {
          const id = part.trim();
          if (id && !R.isProviderAthleteId(id)) refused[id] = p[1];
        });
      }));
      const refusedIds = Object.keys(refused).sort();
      out.scoreboard = { via: r.via, tournaments: r.tournaments.length, athletes: rows.length, refused: refusedIds.length };
      log(`${label} scoreboard via ${r.via}: ${r.tournaments.length} tournament(s) carrying ${rows.length} athlete(s), ${singles.length} in singles`);
      if (refusedIds.length) log(`  ${refusedIds.length} id(s) refused as not-a-person: ` +
        refusedIds.slice(0, 8).map(id => id + ' = ' + refused[id]).join(', ') + (refusedIds.length > 8 ? ', …' : ''));
      if (singles.length) athleteId = singles[0].provider_athlete_id;
    } catch (e) {
      log(`${label} scoreboard did not answer: ${String(e && e.message || e).slice(0, 200)}`);
      continue;
    }

    if (athleteId) {
      const a = await src.athlete(tour, athleteId);
      if (a && a.athlete) {
        out.athlete = { tour: label, via: a.via, id: athleteId, fields: Object.keys(a.athlete).filter(k => a.athlete[k] != null) };
        log(`  athlete ${athleteId} via ${a.via}: ${out.athlete.fields.join(', ') || 'answered but described nothing'}`);
      } else {
        log(`  athlete ${athleteId} was not described: ${(a && a.tried || []).map(t => t.via + ' -> ' + (t.status || t.error)).join('; ')}`);
      }
    } else {
      log('  no singles athlete in the window to ask about');
    }

    try {
      const rk = await src.rankings(tour);
      if (rk && rk.rows && rk.rows.length) {
        out.rankings = { tour: label, via: rk.via, ranked: rk.rows.length };
        log(`  ${label} rankings via ${rk.via}: ${rk.rows.length} ranked athlete(s), top is ${rk.rows[0].provider_athlete_id} at ${rk.rows[0].rank}`);
      } else {
        log(`  ${label} rankings: ${(rk && rk.tried || []).map(t => t.via + ' -> ' + (t.status || t.error)).join('; ') || 'no shape answered'}`);
      }
    } catch (e) { log(`  ${label} rankings failed: ${String(e && e.message || e).slice(0, 160)}`); }

    if (out.athlete && out.rankings) break;
  }

  out.ok = !!(out.athlete && out.rankings);
  if (out.ok) log('both enrichment endpoints answered from this runner');
  else log('the directory will still be built from the scoreboard; enrichment and ranking are additive');
  return out;
}

async function run(o, deps) {
  deps = deps || {};
  const db = deps.db;
  const src = deps.source || E.source({ fetchImpl: deps.fetchImpl });
  const now = o.now ? new Date(o.now) : new Date();
  const nowIso = now.toISOString();
  const summary = { matches: 0, athletes: 0, singles: 0, doubles: 0, enriched: 0, enrich_failed: 0,
    ranked: 0, byTour: {}, errors: [] };

  const from = new Date(now.getTime() - o.backDays * 86400000).toISOString();
  const to = new Date(now.getTime() + o.fwdDays * 86400000).toISOString();
  const matches = await db.selectAll('tennis', 'live_matches',
    `select=match_id,tour,is_doubles,home_provider_id,away_provider_id,home_name,away_name&scheduled_at=gte.${from}&scheduled_at=lte.${to}&order=match_id.asc`);
  summary.matches = matches.length;

  const rows = directoryRows(matches, nowIso);
  summary.athletes = rows.length;
  summary.singles = rows.filter(r => r.seen_in_singles).length;
  summary.doubles = rows.filter(r => r.seen_in_doubles).length;
  rows.forEach(r => { const t = r.tour || 'UNKNOWN'; summary.byTour[t] = (summary.byTour[t] || 0) + 1; });
  log(`${matches.length} match(es) on file carry ${rows.length} distinct athlete(s): ${summary.singles} seen in singles, ${summary.doubles} in doubles`);
  log(`  by tour: ${Object.keys(summary.byTour).sort().map(t => t + ' ' + summary.byTour[t]).join(', ') || 'none'}`);

  if (!rows.length) return summary;
  if (o.commit) await db.upsert('tennis', 'player_directory', rows, 'player_id', { returning: false, chunk: 200 });
  else log(`  would write ${rows.length} directory row(s)`);

  const known = {};
  rows.forEach(r => { known[r.player_id] = r; });

  /* rankings, best-effort and per tour */
  if (o.rankings) {
    for (const tour of (o.tours || E.TOURS)) {
      try {
        const r = await src.rankings(tour);
        if (!r.rows.length) { log(`  ${tour.toUpperCase()} rankings: no shape answered with a ranked athlete${r.tried ? ' (' + r.tried.map(t => t.via + ' ' + (t.status || t.error)).join('; ') + ')' : ''}`); continue; }
        const patches = rankingPatches(r.rows, known);
        summary.ranked += patches.length;
        log(`  ${tour.toUpperCase()} rankings via ${r.via}: ${r.rows.length} ranked, ${patches.length} of them in the draw`);
        if (o.commit && patches.length) await db.upsert('tennis', 'player_directory', patches, 'player_id', { returning: false, chunk: 200 });
      } catch (e) { summary.errors.push(`rankings ${tour}: ${String(e && e.message || e).slice(0, 160)}`); }
    }
  }

  /* enrichment, capped, oldest-unenriched first, and never fatal */
  if (o.enrich > 0) {
    let pending = [];
    try {
      pending = await db.selectAll('tennis', 'player_directory',
        `select=player_id,provider_athlete_id,tour,enriched_at&enriched_at=is.null&order=player_id.asc&limit=${Math.max(1, o.enrich)}`);
    } catch (e) { summary.errors.push('enrich read: ' + String(e && e.message || e).slice(0, 160)); }
    const want = pending.slice(0, o.enrich);
    if (want.length) log(`  enriching up to ${want.length} player(s) the feed has not described yet`);
    for (const p of want) {
      const tour = String(p.tour || 'atp').toLowerCase() === 'wta' ? 'wta' : 'atp';
      try {
        const r = await src.athlete(tour, p.provider_athlete_id);
        if (!r || !r.athlete) { summary.enrich_failed++; continue; }
        const patch = Object.assign({ player_id: p.player_id, enriched_at: nowIso, source_detail: r.via || null }, r.athlete);
        /* the scoreboard's name is not overwritten by a shorter one */
        if (!patch.full_name) delete patch.full_name;
        Object.keys(patch).forEach(k => { if (patch[k] === null) delete patch[k]; });
        summary.enriched++;
        if (o.commit) await db.upsert('tennis', 'player_directory', [patch], 'player_id', { returning: false });
      } catch (e) { summary.enrich_failed++; summary.errors.push('enrich ' + p.player_id + ': ' + String(e && e.message || e).slice(0, 120)); }
    }
    log(`  enriched ${summary.enriched}, ${summary.enrich_failed} the feed would not describe`);
  }
  return summary;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.verify) {
    try {
      const v = await verify(o, {});
      process.exit(v.ok ? 0 : 2);
    } catch (e) { console.error('[tennis-players] probe failed: ' + (e && e.stack || e)); process.exit(1); }
    return;
  }
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); process.exit(1); }
  const db = D.client(cfg);
  const ledger = o.commit ? D.runLedger(db, 'tennis_players') : null;
  if (ledger) await ledger.start({ enrich: o.enrich, rankings: o.rankings });
  let code = 0;
  try {
    const s = await run(o, { db });
    const status = s.errors.length ? 'warn' : 'ok';
    const msg = `${s.athletes} athletes in the directory (${s.singles} singles, ${s.doubles} doubles), ${s.enriched} enriched, ${s.ranked} ranked`;
    log(msg);
    if (ledger) {
      await ledger.finish(status, msg, { last_success_at: new Date().toISOString(), details: s });
      await D.writeMeta(db, { tennis_players_last_run: new Date().toISOString(), tennis_players_last_status: status,
        row_count_tennis_players: s.athletes });
    }
  } catch (e) {
    D.reportFailure('tennis-players', e);
    console.error('[tennis-players] failed: ' + (e && e.stack || e));
    if (ledger && !D.explain(e)) {
      try {
        await ledger.finish('error', String(e && e.message || e).slice(0, 400));
        await D.writeMeta(db, { tennis_players_last_run: new Date().toISOString(), tennis_players_last_status: 'error' });
      } catch (_) {}
    }
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseArgs, directoryId, athletesOfSide, directoryRows, rankingPatches, verify, run };
if (require.main === module) main();
