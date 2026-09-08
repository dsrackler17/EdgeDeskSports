#!/usr/bin/env node
/* ============================================================================
   GENERATE / REFRESH ARTICLE RECORDS from EdgeDesk's own research.

   THIS IS THE ONLY PLACE AN ARTICLE IS CREATED, and it creates one by ASKING
   THE RESEARCH TERMINAL. It boots the real football module (research_host.js),
   reads the upcoming slate off the boards the terminal builds, calls
   window.fbBriefGame() / window.fbNflBriefGame() for each game, and turns the
   payload that comes back into a record (article_model.js). No projection,
   probability, confidence figure or status is computed here or anywhere
   downstream of here.

   REFRESH IS A FIRST-CLASS CASE. Running it again on a game already in the
   store re-reads the research and compares: if nothing moved, the record is
   left alone and only `generated_at` advances, so a scheduled run does not
   produce a commit that says an article changed when it did not. If something
   moved, `updated_at` advances with it and the diff is printed. Once a game
   has kicked off the record FREEZES: an article is what EdgeDesk said before
   the game, and a projection edited afterwards is a record of nothing.

   AUTO-PUBLISH IS OPT-IN AND CHECKED. With --auto (or auto_publish in
   articles/data/index.json) a record is published only if every publication
   check in article_model.publishable() passes and the game is inside the
   lead-time window. Malformed, thin or incomplete research is held as `ready`
   and the failing check is named.

     node tools/articles/generate.js                    # refresh the whole slate
     node tools/articles/generate.js --network          # allow feed downloads
     node tools/articles/generate.js --game missouri-vs-kansas-2026
     node tools/articles/generate.js --sport CFB --limit 8
     node tools/articles/generate.js --auto             # publish what qualifies
     node tools/articles/generate.js --publish --game <slug>   # publish one
     node tools/articles/generate.js --dry              # write nothing
   ========================================================================== */
'use strict';
const path = require('path');
const HOST = require('./research_host.js');
const STORE = require('./store.js');
const MODEL = require('./article_model.js');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const DRY = !!arg('dry', false);
const NETWORK = !!arg('network', false);
const QUIET = !!arg('quiet', false);
const ONLY = arg('game', null);
const SPORT = arg('sport', null);
const LIMIT = +arg('limit', 0) || 0;
const AUTO = !!arg('auto', false);
const PUBLISH = !!arg('publish', false);
const NOW = arg('now', null) ? new Date(arg('now', null)).toISOString() : new Date().toISOString();

function log(...a) { if (!QUIET) console.log(...a); }

/* The NFL board keys games by team CODE; the research payload carries the
   full display names, which is what a headline and a slug are made of. The
   payload is therefore the source for names and the schedule row for
   everything else, rather than a second name table maintained here. */
function gameMetaFor(entry, research) {
  const g = research.game || {};
  return {
    sport: entry.sport,
    game_id: entry.game_id,
    home: g.home || entry.home,
    away: g.away || entry.away,
    /* the short, commonly-spoken form, used ONLY for the alias URL */
    home_short: shortName(g.home || entry.home, entry.sport),
    away_short: shortName(g.away || entry.away, entry.sport),
    kickoff: entry.kickoff,
    venue: entry.venue,
    neutral_site: !!entry.neutral_site,
    conference_line: g.conference_line || null,
    week: entry.week,
    season: entry.season
  };
}
/* "New England Patriots" -> "Patriots", and ONLY for a professional club.
   A nickname is a real second name in the NFL and people search for it; a
   college programme is named for its institution, so the same rule there
   produces "Arizona State" -> "State" and an alias URL of `state-vs-m-2026`.
   So the shortening is scoped to the league where the convention exists,
   rather than guessed from the shape of a name. */
function shortName(name, sport) {
  if (String(sport || '').toUpperCase() !== 'NFL') return null;
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return /^[A-Za-z]{4,}$/.test(last) ? last : null;
}

async function main() {
  const store = STORE;
  const settings = store.settings();
  const autoPublish = AUTO || !!settings.auto_publish;

  const host = await HOST.open({ network: NETWORK, quiet: QUIET });
  if (host.notes.cfb_gate) log('  NOTE (CFB): ' + host.notes.cfb_gate);
  if (host.notes.refused.length) {
    log('  ' + host.notes.refused.length + ' source(s) not reachable in this run:');
    host.notes.refused.slice(0, 6).forEach(u => log('    · ' + u));
  }

  const existing = store.loadAll();
  const byId = Object.create(null);
  existing.forEach(r => { byId[r.id] = r; });

  let slate = host.slate();
  if (SPORT) slate = slate.filter(g => g.sport === String(SPORT).toUpperCase());
  if (LIMIT) slate = slate.slice(0, LIMIT);

  const results = [];
  const written = [];
  let considered = 0;

  for (const entry of slate) {
    const id = entry.sport.toLowerCase() + '-' + entry.game_id;
    const prior = byId[id] || null;
    /* --game names an article, and an article is named by its SLUG, which is
       made of display names the schedule row does not carry for the NFL (it
       keys on team codes). So the cheap identifiers are tried first and the
       slug only after the payload — which is where the real names are — has
       been built. */
    const wanted = (ONLY && ONLY !== true) ? String(ONLY) : null;
    const cheapMatch = !wanted || wanted === id || wanted === entry.game_id
      || (prior && (prior.slug === wanted || (prior.aliases || []).indexOf(wanted) >= 0));
    if (wanted && !cheapMatch && prior) continue;
    considered++;

    let research = null;
    try {
      research = entry.sport === 'NFL'
        ? host.nfl(entry.home_name || entry.home, entry.away_name || entry.away, entry.kickoff_ms)
        : host.cfb(entry.home, entry.away, entry.kickoff_ms);
    } catch (e) { research = null; }
    if (!research) {
      results.push({ id: id, matchup: entry.away + ' at ' + entry.home, action: 'skipped',
        why: 'the research terminal returned no payload for this game' });
      continue;
    }

    /* the store owns the slug namespace; a record keeps the slug it was
       published under, forever */
    const taken = store.takenSlugs(existing);
    const meta = gameMetaFor(entry, research);
    if (wanted && !cheapMatch) {
      const provisional = MODEL.slugFor({ away: meta.away, home: meta.home, season: meta.season });
      const shortSlug = (meta.away_short && meta.home_short)
        ? MODEL.slugFor({ away: meta.away_short, home: meta.home_short, season: meta.season }) : null;
      if (wanted !== provisional && wanted !== shortSlug) { considered--; continue; }
    }

    let rec, action, why = null, diff = null;
    if (!prior) {
      rec = MODEL.build(research, meta, { now: NOW, taken: taken, status: 'draft',
        market_source: host.marketSourceFor(entry.sport, entry.game_id) });
      action = 'created';
    } else {
      const out = MODEL.refresh(prior, research, meta, { now: NOW, taken: taken,
        market_source: host.marketSourceFor(entry.sport, entry.game_id) });
      rec = out.record;
      action = out.changed ? 'updated' : (out.reason.indexOf('frozen') === 0 ? 'frozen' : 'unchanged');
      why = out.reason;
      diff = out.diff || null;
    }

    /* ---- the publication checks, every time, whatever the action ---- */
    const verdict = MODEL.publishable(rec);
    rec.checks = { ok: verdict.ok, failed: verdict.failed.map(f => ({ id: f.id, why: f.why })), at: NOW };

    if (rec.status === 'draft' && verdict.ok) rec.status = 'ready';
    if (rec.status === 'ready' && !verdict.ok) rec.status = 'draft';

    const lead = (Date.parse(rec.game_time) - Date.parse(NOW)) / 60000;
    const inWindow = isFinite(lead)
      && lead >= (settings.auto_publish_min_lead_minutes || 0)
      && lead <= (settings.auto_publish_max_lead_days || 14) * 1440;

    const wantPublish = (PUBLISH && ONLY) || (autoPublish && rec.status === 'ready' && inWindow);
    if (wantPublish) {
      if (!verdict.ok) {
        why = 'held: ' + verdict.failed.map(f => f.id).join(', ');
        action = action === 'unchanged' ? 'held' : action;
      } else {
        const before = rec.status;
        rec = MODEL.publish(rec, NOW);
        rec.checks = { ok: true, failed: [], at: NOW };
        action = before === 'published' ? action : 'published';
      }
    } else if (autoPublish && rec.status === 'ready' && !inWindow) {
      why = 'not auto-published: kickoff is ' + (lead < 0 ? 'in the past' :
        lead < (settings.auto_publish_min_lead_minutes || 0) ? 'too close' : 'too far out')
        + ' for the auto-publish window';
    }

    if (!DRY && (action !== 'unchanged' || !prior || JSON.stringify(prior.checks || null) !== JSON.stringify(rec.checks))) {
      store.save(rec);
      written.push(rec.id);
    }
    existing.push(rec);
    byId[id] = rec;
    results.push({ id: rec.id, slug: rec.slug, matchup: rec.away_team + ' at ' + rec.home_team,
      status: rec.status, action: action, why: why, diff: diff,
      spread: rec.fair_spread_text, model_status: rec.model_status,
      confidence: rec.confidence, checks_failed: rec.checks.failed.map(f => f.id) });
  }

  /* the store's own record list, not the in-memory one, so a record that was
     already there and untouched still appears in the manifest */
  if (!DRY) store.saveIndex(store.loadAll(), { now: NOW });

  log('\n' + considered + ' game(s) considered, ' + written.length + ' record(s) written'
    + (DRY ? ' (DRY RUN — nothing written)' : ''));
  results.forEach(r => {
    log('  ' + pad(r.action, 10) + pad(r.status || '', 10) + (r.slug || r.id));
    if (r.spread) log('             ' + r.spread + '  ·  ' + (r.model_status || '') + (r.confidence != null ? '  ·  ' + r.confidence + '% confidence' : ''));
    if (r.diff) log('             changed: ' + r.diff.join('; '));
    if (r.checks_failed && r.checks_failed.length) log('             checks failed: ' + r.checks_failed.join(', '));
    if (r.why) log('             ' + r.why);
  });
  return results;
}
function pad(s, n) { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(1, n - s.length)); }

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => {
    console.error('generate failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
module.exports = { main, shortName, gameMetaFor };
