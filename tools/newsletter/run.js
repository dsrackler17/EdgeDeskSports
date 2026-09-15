#!/usr/bin/env node
/* ============================================================================
   THE NEWSLETTER PIPELINE — schedule, refresh, select, draft, validate, store,
   send, record.

   ONE COMMAND, EIGHT PHASES, and each one can refuse in a way the next one
   understands. The whole point of the shape is that nothing is ever half
   done: an edition is built completely and validated completely before a
   single address is looked up, and the send phase reads a stored edition
   rather than a freshly assembled one.

     due       what is owed right now, per sport, in America/Chicago
     build     refresh inputs -> resolve the slate -> rank -> draft -> render
               -> validate -> store. Writes an edition with status
               `ready` or `held`, never anything in between.
     send      re-check every gate, resolve eligibility LIVE, seed one
               delivery row per recipient, hand batches to the provider, and
               record what came back per recipient.
     retry     the failed and the ambiguous, with the same idempotency keys.
     all       build then send, for every sport that is due.
     preview   build with no database and no send. What a person reads before
               the launch gate is opened.
     test      send one edition to the configured test addresses only.
     market    refresh the committed book-quote snapshot from the odds
               capture, and nothing else. THIS HAS TO RUN BEFORE THE RECORDS
               ARE REGENERATED: the research host injects the snapshot when it
               boots, so a quote written after generate.js has run does not
               reach a record until the run AFTER this one. The first version
               of this pipeline refreshed the market inside `build`, which is
               downstream of the records it was meant to improve — a college
               edition could therefore never carry a book number on the run
               that fetched it.
     rank      the whole slate's scores and components, for calibration.
     report    the run log, as a markdown job summary.

   THE GATES, in the order they are applied. Each one is a STATED REASON on
   the stored edition rather than an exception:

     dispatcher_disabled    the operator paused the scheduler
     sport_disabled         the operator paused this sport
     not_due                the edition's hour has not arrived
     edition_stale          the retry window closed — a late newsletter is
                            worse than none, so it holds rather than sends
     already_sent           this edition has gone out; nothing re-sends
     lease_held             another worker owns this edition right now
     awaiting_monday_result the Tuesday NFL gate, see inputs.js
     stale_inputs           the featured records have not been refreshed
     no_upcoming_games      a bye week, a season boundary, an empty slate
     no_games_qualified     nothing cleared the research bar. NOT an error.
     validation_failed      the gate in validate.js refused it
     sending_disabled       the global kill switch, checked LAST and again
                            immediately before the provider call

   NOTHING HERE COMPUTES A PROJECTION. Every number came out of the research
   terminal by way of an article record; the only arithmetic this pipeline
   does is the model-versus-market difference, under one stated convention in
   select.js, and it is recomputed and compared in validate.js before sending.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SCHEDULE = require('./schedule.js');
const SLATE = require('./slate.js');
const SELECT = require('./select.js');
const COMPOSE = require('./compose.js');
const RENDER = require('./render.js');
const VALIDATE = require('./validate.js');
const STORE = require('./store.js');
const RUNTIME = require('./runtime.js');
const PROVIDER = require('./provider.js');
const MARKET = require('./market.js');
const INPUTS = require('./inputs.js');

const ASTORE = require('../articles/store.js');
const AMODEL = require('../articles/article_model.js');
const SNAPSHOT = require('../editorial/snapshot.js');

const ROOT = path.join(__dirname, '..', '..');

/* ------------------------------------------------------------------ args */
function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
function flag(name) { return !!arg(name, false); }

function runId() { return 'nl_' + Math.random().toString(36).slice(2, 10); }
function nowIso(now) { return new Date(now).toISOString(); }
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

/* ------------------------------------------------------------- the inputs */
/* Every pregame article record, as slate candidates. THE RECORD IS THE
   RESEARCH: tools/articles/generate.js built it by calling the same
   fbBriefGame()/fbNflBriefGame() a browser calls, so reading records here is
   reading the terminal's own output rather than a second model. */
function candidates() {
  return ASTORE.loadAll()
    .filter(r => r && (r.article_type || 'pregame') === 'pregame')
    .map(SLATE.fromRecord)
    .filter(Boolean);
}
/* THE PAYLOAD THE VALIDATOR READS, PUT BACK BEFORE IT IS ASKED FOR IT.
   THIS IS WHY NO EDITION COULD EVER BE SENT.

   The build attaches `g.research` to every featured game, and validate.js
   derives the set of SUPPORTED FIGURES from it — every number the copy prints
   has to appear in the research it was built from, or the edition prints a
   statistic nobody can trace. That payload is then deliberately dropped
   before the edition is stored, so the committed file does not carry the same
   research twice.

   Nothing put it back. sendBody re-validates the stored edition before it
   hands anything to the provider, and it re-validated a body whose research
   was gone: the supported set came out empty and EVERY figure read as
   unsupported. The first real test send died on exactly that —
   `revalidation_failed (INTEGRITY: unsupported_statistic)` on 68, 47, -1.1,
   42.8, 67, 59.1, 62, 71.4 — and a production send would have died the same
   way. The launch gate would have opened onto a pipeline that refuses
   everything.

   Re-read from the record store rather than stored alongside the body,
   because re-validating against a set derived from the same build is a
   tautology. Reading the CURRENT record is what revalidation is for: if a
   figure the edition printed is no longer supported by the research behind
   it, that edition IS stale in substance and refusing it is correct. */
function attachResearch(edition) {
  const byKey = Object.create(null);
  ASTORE.loadAll().forEach(r => {
    if (!r || !r.sport || r.game_id == null) return;
    byKey[String(r.sport).toUpperCase() + ':' + r.game_id] = r;
  });
  const missing = [];
  (edition.games || []).forEach(g => {
    if (g.research) return;
    const rec = byKey[g.key]
      || byKey[String(g.sport || edition.sport || '').toUpperCase() + ':' + g.game_id];
    if (rec && rec.research) g.research = rec.research;
    else missing.push(g.key || String(g.game_id));
  });
  return missing;
}

function publishedIds() {
  const idx = ASTORE.loadIndex();
  const out = Object.create(null);
  (idx.articles || []).forEach(a => { if (a.status === 'published') out[a.id] = true; });
  return out;
}

/* The research snapshot, per featured game. The FULL capture goes to the
   database, where it is the production record; the repository keeps the
   identity, the two number blocks the email actually printed, the coverage
   report and the ledger entries the copy cited. That is enough to re-render
   the email and to argue with it, without committing a megabyte a week. */
function snapshotsFor(edition, byId, now) {
  const full = [];
  const trimmed = [];
  (edition.games || []).forEach(g => {
    const rec = byId[g.sport.toLowerCase() + '-' + g.game_id];
    if (!rec || !rec.research) return;
    const meta = AMODEL.gameMetaFrom(rec.research, g.sport, {
      game_id: g.game_id, kickoff: g.kickoff, home: g.home, away: g.away,
    });
    let snap;
    try {
      snap = SNAPSHOT.capture(rec.research, meta, {
        article_id: rec.id, now: now,
        market_source: rec.market_source || null,
        schedule_source: 'the public schedule feed the research board reads',
        generation_version: 'edgedesk_newsletter_edition_v1',
      });
    } catch (_) { return; }
    full.push(snap);
    const cited = Object.create(null);
    (g.why || []).forEach(w => { if (w.source) cited[w.source] = true; });
    trimmed.push({
      key: g.key,
      snapshot_id: snap.snapshot_id,
      captured_at: snap.captured_at,
      game: snap.game,
      model: snap.model,
      market: snap.market,
      market_source: snap.market_source,
      state: snap.state,
      coverage: snap.coverage,
      sources: snap.sources,
      missing: snap.missing,
      /* the ledger entries this edition's sentences stand on */
      facts_cited: (snap.facts || []).filter(f =>
        cited[f.id] || /^(model\.|market\.)/.test(String(f.id))),
    });
    g.research_snapshot = { snapshot_id: snap.snapshot_id };
    /* the validator reads the payload through this, and it is dropped before
       the edition is written so the committed file does not carry it twice */
    g.research = rec.research;
  });
  return { full, trimmed };
}

/* ============================================================ the phases */

/* ------------------------------------------------------------------ due */
function dueFor(sport, now, settings) {
  return SCHEDULE.dueFor(sport, now, {
    retry_window_minutes: settings && settings.retry_window_minutes,
    overrides: settings ? {
      hour: settings.send_hour_local, minute: settings.send_minute_local, zone: settings.send_zone,
    } : null,
  });
}

/* ---------------------------------------------------------------- build */
async function build(opts) {
  const sport = String(opts.sport).toUpperCase();
  const now = opts.now;
  const cfg = opts.resolved;
  const settings = cfg.settings;
  const log = opts.log || (() => {});
  const due = dueFor(sport, now, settings);
  const key = STORE.editionKey(sport, opts.season_hint, opts.week_hint, due.edition_date);
  const base = {
    schema: 'edgedesk_newsletter_edition_v1',
    sport, edition_date: due.edition_date,
    scheduled_at: due.scheduled_at, deadline_at: due.deadline_at,
    schedule: due,
  };

  function held(reason, detail, extra) {
    return Object.assign({}, base, extra || {}, {
      status: 'held', hold_reason: reason, hold_detail: detail || null,
      built_at: nowIso(now),
    });
  }

  /* A PREVIEW IS NOT A SEND, and the two want different answers from the same
     gates. `not_due`, `edition_stale`, `awaiting_monday_result` and
     `stale_inputs` all say "this is not the right MOMENT to send"; none of
     them says the edition would be wrong. An operator asking to see next
     Monday's newsletter is asking exactly the question those four gates
     refuse to answer, so in preview mode each is recorded as a WARNING on the
     edition instead of stopping it, and the edition is marked `preview` so
     nothing downstream can mistake it for a sendable one — send() admits
     status `ready` and nothing else.

     The gates that describe the CONTENT — an empty slate, nothing qualifying,
     a failed validation — still hold in preview, because a preview of a
     broken edition is not a preview of anything. */
  const warnings = [];
  const preview = !!opts.preview;
  function gate(reason, detail, extra) {
    if (!preview) return held(reason, detail, extra);
    warnings.push({ id: reason, detail: detail || null });
    log('  [preview] gate bypassed: ' + reason);
    return null;
  }

  /* ---- gate: the operator's switches ---------------------------------- */
  if (!cfg.sportEnabled(sport)) {
    return held('sport_disabled', 'the operator has paused the ' + sport + ' edition');
  }

  /* ---- gate: is it owed at all ---------------------------------------- */
  if (!opts.force && !due.due) {
    const g = due.stale
      ? gate('edition_stale',
        'the ' + due.edition_date + ' edition is ' + due.minutes_late + ' minutes past its '
        + due.retry_window_minutes + '-minute retry window; a newsletter this late is worse than none')
      : gate('not_due', 'the next ' + sport + ' edition is due ' + due.next_scheduled_at);
    if (g) return g;
  }

  /* ---- the slate, FIRST, so a held edition still carries its identity ---
     A hold recorded under season 0 week 0 is a row nobody can join to
     anything; the week is known from the records before any gate runs, so it
     is resolved before any of them can refuse. */
  const cands = candidates();
  const slate = SLATE.resolve({ candidates: cands, sport, now, horizon_days: opts.horizon_days });
  if (!slate.ok) {
    return held('no_upcoming_games', slate.detail || 'no upcoming game with a season and week identifier',
      { slate_summary: { excluded: (slate.excluded || []).length, horizon_days: slate.horizon_days } });
  }
  base.season = slate.season;
  base.slate_week = slate.week;
  base.edition_key = STORE.editionKey(sport, slate.season, slate.week, due.edition_date);

  /* ---- refresh the market ---------------------------------------------- */
  let marketRefresh = { ok: false, reason: 'not_attempted' };
  if (opts.offline !== true) {
    try {
      marketRefresh = await MARKET.refresh({
        games: slate.games, season: slate.season, week: slate.week,
        now, dry: !!opts.dry, fetch: opts.fetch,
      });
      /* "0 quote(s) joined" is a fact and not a diagnosis, and the
         difference cost a round trip to a live runner: a run read 410
         college signal rows, joined none, and the log could not say whether
         signals was empty or every row had been refused. It says now. */
      log('  market refresh: ' + (marketRefresh.ok
        ? (marketRefresh.quotes + ' quote(s) joined'
           + (marketRefresh.signals_read != null ? ' from ' + marketRefresh.signals_read + ' signal row(s)' : '')
           + (marketRefresh.refused_count ? ' · ' + marketRefresh.refused_count + ' refused: '
              + JSON.stringify(marketRefresh.refused_by_reason || {}) : '')
           + (marketRefresh.wrote ? ' -> ' + marketRefresh.wrote : ''))
        : marketRefresh.reason));
    } catch (e) { marketRefresh = { ok: false, reason: 'market_refresh_threw', detail: (e && e.message) || String(e) }; }
  }

  /* ---- gate: Monday Night Football, for the Tuesday NFL edition -------- */
  let mnf = { required: false, action: 'proceed' };
  let dataCutoff = nowIso(now);
  let cutoffNote = null;
  if (sport === 'NFL') {
    mnf = INPUTS.mondayNightReadiness({
      candidates: cands, now, deadline_at: due.deadline_at,
      settle_minutes: settings.mnf_settle_minutes,
    });
    log('  monday night: ' + mnf.action + ' — ' + mnf.reason);
    if (mnf.action === 'wait') {
      const g = gate('awaiting_monday_result', mnf.detail, { monday_night: mnf });
      if (g) return g;
    } else if (mnf.action === 'hold') {
      const g = gate('monday_result_never_arrived', mnf.detail, { monday_night: mnf });
      if (g) return g;
    }
    if (mnf.action === 'proceed_with_cutoff') {
      dataCutoff = (mnf.ratings && mnf.ratings.generated_at) || nowIso(now);
      cutoffNote = 'The ratings behind these numbers were last rebuilt '
        + String(dataCutoff).replace('T', ' ').slice(0, 16) + ' UTC, before Monday night’s result was absorbed. '
        + 'The data cutoff is stated rather than implied.';
    }
  }

  void key;

  /* ---- rank ------------------------------------------------------------ */
  const selection = SELECT.rank({
    games: slate.games, sport, now,
    settings: {
      thresholds: settings.thresholds, expansion_thresholds: settings.expansion_thresholds,
      target_games: settings.target_games, max_games: settings.max_games,
      quote_stale_hours: settings.quote_stale_hours, record_stale_hours: settings.record_stale_hours,
      gap_confidence_floor: settings.gap_confidence_floor,
    },
  });
  log('  ' + selection.considered + ' scored, ' + selection.chosen.length + ' chosen ('
    + selection.coverage.with_market + ' with a market number)');

  if (!selection.chosen.length) {
    return held('no_games_qualified',
      selection.considered + ' games were scored and none cleared the '
      + sport + ' research bar of ' + selection.settings.threshold
      + '. The edition is skipped rather than padded.',
      { selection_summary: { considered: selection.considered, coverage: selection.coverage,
        top: (selection.passed || []).slice(0, 8) } });
  }

  /* ---- gate: are the featured records fresh ---------------------------- */
  const featuredCandidates = selection.chosen.map(c => ({ key: c.key, record: c.evidence ? { generated_at: c.evidence.generated_at } : null }));
  const fresh = INPUTS.recordFreshness(featuredCandidates, now, settings.record_stale_hours);
  if (fresh.newest_hours != null && fresh.newest_hours > settings.record_stale_hours) {
    const g = gate('stale_inputs',
      'the freshest featured record was regenerated ' + fresh.newest_hours + ' hours ago, past the '
      + settings.record_stale_hours + '-hour threshold — the research behind this edition has not been refreshed',
      { input_freshness: fresh });
    if (g) return g;
  }

  /* ---- draft ----------------------------------------------------------- */
  const pub = publishedIds();
  const edition = COMPOSE.compose({
    sport, season: slate.season, week: slate.week,
    edition_date: due.edition_date, scheduled_at: due.scheduled_at,
    selection, slate, now, published_ids: pub, data_cutoff: dataCutoff,
  });
  if (cutoffNote) edition.disclosures = [cutoffNote].concat(edition.disclosures || []);
  if (marketRefresh && marketRefresh.ok === false && marketRefresh.reason !== 'not_attempted') {
    edition.market_refresh_note = marketRefresh.reason;
  }

  /* ---- the research snapshot ------------------------------------------ */
  const byId = Object.create(null);
  ASTORE.loadAll().forEach(r => { byId[r.id] = r; });
  const snaps = snapshotsFor(edition, byId, nowIso(now));

  /* ---- render ---------------------------------------------------------- */
  const renderOpts = {
    site: settings.site_url, mailing_address: settings.mailing_address,
  };
  const free = RENDER.render(edition, Object.assign({ variant: 'free' }, renderOpts));
  const member = RENDER.render(edition, Object.assign({ variant: 'member' }, renderOpts));

  /* ---- validate -------------------------------------------------------- */
  const validation = VALIDATE.validate(edition, {
    now, published_ids: pub, rendered: free, renderOpts,
  });
  const validationMember = VALIDATE.validate(edition, {
    now, published_ids: pub, rendered: member,
    renderOpts: Object.assign({ variant: 'member' }, renderOpts),
  });

  /* the payload was attached for the number check; it is not committed */
  (edition.games || []).forEach(g => { delete g.research; });

  const out = Object.assign({}, base, edition, {
    data_cutoff_at: dataCutoff,
    html_free: free.html, text_free: free.text,
    html_member: member.html, text_member: member.text,
    validation: {
      free: validation, member: validationMember,
      ok: validation.ok && validationMember.ok,
      hold_reason: validation.hold_reason || validationMember.hold_reason || null,
    },
    research_snapshot: { games: snaps.trimmed, market_refresh: marketRefresh,
      input_freshness: fresh, ratings: INPUTS.ratingsFreshness(now),
      monday_night: mnf.required ? mnf : null },
    built_at: nowIso(now),
  });
  out.content_hash = STORE.contentHash(out);
  out.preview = preview;
  out.gates_bypassed = warnings;
  /* PREVIEW IS ITS OWN STATUS, not a `ready` with an asterisk. send() admits
     `ready` and nothing else, so a preview file left in the store can never be
     mistaken for an edition somebody approved. */
  out.status = !out.validation.ok ? 'held' : (preview ? 'preview' : 'ready');
  out.hold_reason = out.validation.ok ? null : 'validation_failed';
  out.hold_detail = out.validation.ok ? null : out.validation.hold_reason;
  out.full_snapshots = snaps.full;
  return out;
}

/* ------------------------------------------------------------- persist */
/* TWO STORES, TWO DECISIONS. The repository copy is the reproducible record
   and a preview's whole purpose is to produce one, so `--dry` is the only
   thing that stops it being written. The database copy is production state
   and a preview must never touch it. */
async function persist(edition, opts) {
  const cfg = opts.resolved;
  const c = cfg.client;
  const full = edition.full_snapshots || [];
  const committed = Object.assign({}, edition);
  delete committed.full_snapshots;
  /* the four rendered bodies are written as their own files below; carrying
     them in the record too would be the same 180 kB twice, with two places
     for them to disagree */
  ['html_free', 'text_free', 'html_member', 'text_member'].forEach(k => { delete committed[k]; });
  committed.bodies = {
    free: { html: 'previews/' + STORE.fileKey(edition.edition_key) + '.html',
      text: 'previews/' + STORE.fileKey(edition.edition_key) + '.txt' },
    member: { html: 'previews/' + STORE.fileKey(edition.edition_key) + '.member.html',
      text: 'previews/' + STORE.fileKey(edition.edition_key) + '.member.txt' },
  };
  const writeRepo = opts.writeRepo !== false;
  const writeDb = opts.writeDb !== false;
  if (writeRepo) {
    STORE.saveEdition(committed);
    STORE.savePreview(edition.edition_key, { html: edition.html_free, text: edition.text_free });
    STORE.savePreview(edition.edition_key, { html: edition.html_member, text: edition.text_member }, 'member');
    STORE.saveIndex(null, { now: opts.now });
  }
  if (writeDb && c.enabled && c.hasService) {
    try {
      await c.upsertEdition({
        edition_key: edition.edition_key, sport: edition.sport, season: edition.season,
        slate_week: edition.slate_week, edition_date: edition.edition_date,
        status: edition.status, hold_reason: edition.hold_reason, hold_detail: edition.hold_detail,
        scheduled_at: edition.scheduled_at, deadline_at: edition.deadline_at,
        data_cutoff_at: edition.data_cutoff_at || null,
        subject: edition.subject || null, preview_text: edition.preview_text || null,
        html_free: edition.html_free || null, text_free: edition.text_free || null,
        html_member: edition.html_member || null, text_member: edition.text_member || null,
        selection: edition.selection_summary || null,
        research_snapshot: { games: full, trimmed: (edition.research_snapshot || {}).games || [],
          market_refresh: (edition.research_snapshot || {}).market_refresh || null,
          monday_night: (edition.research_snapshot || {}).monday_night || null },
        validation: edition.validation || null,
        content_hash: edition.content_hash || null,
        game_count: edition.game_count == null ? 0 : edition.game_count,
      });
    } catch (e) { opts.log('  ! could not store the edition in the database: ' + (e && e.message)); }
  }
  return committed;
}

/* ----------------------------------------------------------------- send */
/* Everything is re-checked here. The build may have run four hours ago on a
   different tick, the kill switch may have been thrown since, and a recipient
   may have bounced thirty seconds ago. */
/* THE LEASE IS RELEASED ON EVERY PATH OUT, including a throw. A worker that
   dies holding one is covered by the TTL, but a worker that RETURNS holding
   one would block the next legitimate retry for half an hour for no reason. */
async function send(edition, opts) {
  const lease = { release: null };
  try {
    return await sendBody(edition, opts, lease);
  } finally {
    if (lease.release) { try { await lease.release(); } catch (_) { /* the TTL covers this */ } }
  }
}

async function sendBody(edition, opts, lease) {
  const cfg = opts.resolved;
  const c = cfg.client;
  const settings = cfg.settings;
  const log = opts.log;
  const now = opts.now;
  const outcomeBase = { edition_key: edition.edition_key, sport: edition.sport };


  /* WHICH EDITIONS MAY BE HANDED TO THE PROVIDER. `ready` is the normal case.
     `sending` is admitted ONLY for a retry, because that is precisely the
     state a partially delivered edition is left in and the whole point of a
     retry is to finish it. Everything else — held, sent, skipped, and in
     particular `preview`, which is what an operator's rebuild writes — is
     refused, so a previewed edition can never be mistaken for an approved
     one. */
  const sendable = opts.retry ? ['ready', 'sending'] : ['ready'];
  if (sendable.indexOf(edition.status) < 0) {
    return Object.assign({ sent: false, reason: 'not_sendable',
      detail: 'status ' + edition.status + (edition.hold_reason ? ' (' + edition.hold_reason + ')' : '') }, outcomeBase);
  }
  if (!cfg.sportEnabled(edition.sport)) {
    return Object.assign({ sent: false, reason: 'sport_disabled' }, outcomeBase);
  }
  /* THE SECOND KILL-SWITCH CHECK, and it is deliberately not the same read as
     the first: `resolve()` re-reads the database, so a switch thrown while the
     edition was being built is honoured. */
  if (!opts.test && cfg.sending_enabled !== true) {
    return Object.assign({ sent: false, reason: 'sending_disabled',
      detail: 'newsletter_settings.sending_enabled is false — this is the launch gate' }, outcomeBase);
  }
  /* THE RETRY WINDOW IS A SCHEDULING GUARD, NOT THE LAUNCH GATE.
     It exists so a late edition never reaches subscribers — Monday's research
     landing on Thursday is worse than not landing. It has nothing to say about
     a message going to an operator's own inbox, and applying it there made the
     launch checklist impossible: a test could only be sent inside a four-hour
     window, twice a week. The very first real test of this pipeline was
     refused for exactly that and sent nothing.

     So a test send is exempt, the same way it is exempt from
     sending_enabled — and it SAYS SO in the result, so a test of an edition
     whose window has closed is never mistaken for a timely one. Nothing about
     the subscriber path changes: test mode resolves only the configured test
     addresses and never a subscriber, and sending_enabled still gates every
     real send. */
  const deadline = Date.parse(edition.deadline_at);
  const pastWindow = Number.isFinite(deadline) && now > deadline;
  if (!opts.force && !opts.test && pastWindow) {
    return Object.assign({ sent: false, reason: 'edition_stale',
      detail: 'the retry window closed at ' + edition.deadline_at }, outcomeBase);
  }
  if (opts.test && pastWindow) {
    log('  note: this edition\u2019s retry window closed at ' + edition.deadline_at
      + ' — a real send would be refused as edition_stale; a test is not');
  }
  /* A GAME THAT KICKED OFF WHILE THE EDITION WAITED invalidates the edition.
     Re-validating here rather than trusting the build is the difference
     between a late send and a wrong one. The research the validator reads is
     put back first — storage drops it, and without it every figure in the
     copy reads as unsupported. */
  const researchMissing = attachResearch(edition);
  if (researchMissing.length) {
    return Object.assign({ sent: false, reason: 'research_unavailable',
      detail: 'the record store no longer holds the research behind '
        + researchMissing.length + ' featured game(s) (' + researchMissing.slice(0, 4).join(', ')
        + '), so this edition\u2019s figures cannot be verified' }, outcomeBase);
  }
  const revalidate = VALIDATE.validate(edition, {
    now, published_ids: publishedIds(),
    rendered: { html: edition.html_free, text: edition.text_free },
    renderOpts: { site: settings.site_url, mailing_address: settings.mailing_address },
  });
  if (!revalidate.ok) {
    return Object.assign({ sent: false, reason: 'revalidation_failed',
      detail: revalidate.hold_reason, validation: revalidate }, outcomeBase);
  }

  /* THE SAME NEWSLETTER, TWICE, UNDER TWO KEYS.
     The identity index stops one edition being stored twice. It does not stop
     two editions, on two dates, carrying the same ten games — which is what
     happens when the upcoming slate has not advanced between them, and the
     content hash says so plainly. The provider's idempotency key is built
     from the edition key, so it would accept both and a subscriber would read
     the same week twice.

     A retry excludes the edition's own row, because finishing a partial send
     is the one case where the identical content SHOULD go out again. --force
     overrides, because an operator re-sending knowingly is not this mistake. */
  if (!opts.test && !opts.force && edition.content_hash && c && c.sentWithHash) {
    let twin = null;
    try { twin = await c.sentWithHash(edition.sport, edition.content_hash, edition.edition_key); }
    catch (e) { log('  ! could not check for an identical sent edition: ' + (e && e.message)); }
    if (twin) {
      return Object.assign({ sent: false, reason: 'already_sent_as',
        detail: 'the identical edition went out as ' + twin.edition_key
          + (twin.sent_at ? ' at ' + twin.sent_at : '') + ' — same content hash, different date' }, outcomeBase);
    }
  }

  /* ---- the recipients, resolved LIVE ---------------------------------- */
  let recipients = [];
  if (opts.test) {
    const list = (settings.test_recipients || []).concat(opts.to ? [opts.to] : []);
    /* A TEST MESSAGE WHOSE UNSUBSCRIBE LINK DOES NOTHING IS NOT A TEST OF THE
       EMAIL. The launch checklist asks an operator to click that link, and a
       synthetic token answers "this link is not valid" — which tells them
       nothing about whether the real one works. So when the test address is
       itself a confirmed subscriber, the message carries ITS OWN token and
       the link genuinely unsubscribes. For an address that is not subscribed
       there is nothing to unsubscribe from and the synthetic token is
       honest; the log says which it was. */
    let realTokens = Object.create(null);
    if (c.enabled && c.hasService) {
      try {
        const all = (await c.eligible(edition.sport)) || [];
        all.forEach(r => { realTokens[String(r.email).toLowerCase()] = r.manage_token; });
      } catch (_) { realTokens = Object.create(null); }
    }
    recipients = list.filter(Boolean).map(e => {
      const email = String(e).toLowerCase();
      return {
        subscriber_id: null, email, is_member: false,
        manage_token: realTokens[email] || ('test-' + PROVIDER.sha256(email).slice(0, 24)),
        live_token: !!realTokens[email],
      };
    });
    const live = recipients.filter(r => r.live_token).length;
    log('  test send: ' + recipients.length + ' address(es), ' + live
      + ' with a working unsubscribe link'
      + (live < recipients.length ? ' (the rest are not subscribers, so their link has nothing to unsubscribe)' : ''));
    if (!recipients.length) {
      return Object.assign({ sent: false, reason: 'no_test_recipients',
        detail: 'set newsletter_settings.test_recipients or pass --to' }, outcomeBase);
    }
  } else {
    if (!c.enabled || !c.hasService) {
      return Object.assign({ sent: false, reason: 'no_service_credential',
        detail: 'sending needs SB_SERVICE_ROLE to resolve recipients' }, outcomeBase);
    }
    recipients = (await c.eligible(edition.sport)) || [];
  }
  log('  ' + recipients.length + ' eligible recipient(s)');
  if (!recipients.length) {
    return Object.assign({ sent: false, reason: 'no_eligible_recipients' }, outcomeBase);
  }

  /* ---- the delivery roster -------------------------------------------- */
  let editionRow = null;
  if (!opts.test && c.enabled && c.hasService) {
    editionRow = await c.findEdition(edition.edition_key);
    if (editionRow && editionRow.status === 'sent' && !opts.force && !opts.retry) {
      return Object.assign({ sent: false, reason: 'already_sent',
        detail: 'this edition was sent at ' + editionRow.sent_at }, outcomeBase);
    }
    if (!editionRow) {
      return Object.assign({ sent: false, reason: 'edition_not_stored' }, outcomeBase);
    }
    /* THE LEASE, TAKEN HERE AND NOWHERE ELSE. The schema has provided
       newsletter_claim_edition() since day one and this code did not call it:
       two dispatchers that both decided an edition was due would both pass
       every gate, both read the same pending set and both hand the same batch
       to the provider. The deterministic idempotency key meant the provider
       would have deduplicated it — which is a good backstop and a bad primary
       defence, because it makes correctness depend on a third party honouring
       a header. One worker at a time, decided in one statement, in our own
       database. */
    /* WHO HOLDS IT, identifiably. The GitHub run id when there is one, so an
       operator reading a stuck lease can find the job that took it; a fresh
       id otherwise. `rid` belongs to main() and is not in scope here — the
       first version of this line reached for it and threw on the first real
       lease claim, which is exactly the kind of thing only a test that
       actually calls send() finds. */
    const owner = 'run:' + (opts.run_id || process.env.GITHUB_RUN_ID || runId()) + ':' + (process.pid || 0);
    let leased = false;
    try { leased = await c.claimEdition(edition.edition_key, owner, 1800); }
    catch (e) { log('  ! could not reach the lease: ' + (e && e.message)); }
    if (!leased) {
      return Object.assign({ sent: false, reason: 'lease_held',
        detail: 'another worker holds the lease on this edition; it will finish or the lease will expire' }, outcomeBase);
    }
    lease.release = () => c.releaseEdition(edition.edition_key, owner);

    /* THE TRANSITION THE DATABASE POLICES. newsletter_editions_sent_body_uk is
       a partial unique index over (sport, content_hash) for the sending and
       sent states, so this statement is where a second edition carrying the
       same games is stopped — atomically, before a single message reaches the
       provider, and without depending on the read-then-act check above having
       won a race. Answered by name rather than as a stack trace. */
    try {
      await c.patchEdition(edition.edition_key, {
        status: 'sending', eligible_recipients: recipients.length,
      });
    } catch (e) {
      const why = String((e && e.message) || e);
      if (/23505|duplicate key|newsletter_editions_sent_body_uk/i.test(why)) {
        return Object.assign({ sent: false, reason: 'already_sent_as',
          detail: 'the database refused this edition into `sending`: another edition of this sport '
            + 'is already in flight or sent with the same content hash (' + edition.content_hash + ')' }, outcomeBase);
      }
      throw e;
    }
    await c.seedDeliveries(recipients.map(r => ({
      edition_id: editionRow.id, subscriber_id: r.subscriber_id, email: r.email,
      variant: r.is_member ? 'member' : 'free', status: 'queued',
      idempotency_key: PROVIDER.idempotencyKeyFor(edition.edition_key, edition.content_hash, [r.email]),
    })));
    /* ONLY WHAT IS STILL OWED. A row already `accepted` is never handed to the
       provider again — that is the whole reason the roster is a table. */
    const pending = await c.pendingDeliveries(editionRow.id);
    const byEmail = Object.create(null);
    recipients.forEach(r => { byEmail[r.email] = r; });
    /* SUPPRESSION APPLIED AT THE LAST POSSIBLE MOMENT. `eligible()` recomputes
       consent, sport preference and the suppression list live, so an address
       that unsubscribed or bounced since this edition was seeded is simply not
       in `byEmail` — and its row is closed as `skipped` rather than left
       `queued`, which would hold the edition in `sending` forever. */
    const dropped = (pending || []).filter(p => !byEmail[p.email]).map(p => p.email);
    if (dropped.length) {
      await c.skipDeliveries(editionRow.id, dropped,
        'not eligible at send time: unsubscribed, suppressed or no longer wants this sport');
      log('  ' + dropped.length + ' seeded recipient(s) are no longer eligible and were skipped');
    }
    recipients = (pending || []).map(p => byEmail[p.email]).filter(Boolean);
    log('  ' + recipients.length + ' still owed a send');
    if (!recipients.length) {
      const counts = await c.deliveryCounts(editionRow.id);
      await c.patchEdition(edition.edition_key, { status: 'sent', counts });
      return Object.assign({ sent: true, reason: 'already_delivered_to_everyone', counts }, outcomeBase);
    }
  }

  /* ---- per-recipient URLs --------------------------------------------- */
  const site = settings.site_url || 'https://edgedesksports.com';
  const fnBase = (settings.functions_url || (site.replace(/^https:\/\/[^/]+$/, '') || ''));
  const endpoint = settings.public_endpoint
    || (RUNTIME.SB_URL + '/functions/v1/newsletter');
  const payload = recipients.map(r => ({
    email: r.email,
    variant: r.is_member ? 'member' : 'free',
    urls: {
      unsubscribe: endpoint + '/unsubscribe?t=' + encodeURIComponent(r.manage_token)
        + '&sport=' + encodeURIComponent(edition.sport),
      preferences: endpoint + '/preferences?t=' + encodeURIComponent(r.manage_token),
      webview: site + '/newsletter/',
    },
  }));
  void fnBase;

  /* ---- hand it to the provider ---------------------------------------- */
  const result = await PROVIDER.send({
    edition, recipients: payload, settings, env: opts.env,
    fetch: opts.fetch, dry: !!opts.dry, driver: opts.driver,
  });
  log('  provider: ' + result.driver + ' — ' + JSON.stringify(result.counts));

  /* ---- record, per recipient ------------------------------------------ */
  if (!opts.test && !opts.dry && c.enabled && c.hasService && editionRow) {
    for (const o of result.outcomes) {
      try { await c.recordOutcome(editionRow.id, o); }
      catch (e) { log('  ! could not record ' + o.email + ': ' + (e && e.message)); }
    }
    const counts = await c.deliveryCounts(editionRow.id);
    const anyOwed = (counts.queued || 0) + (counts.failed || 0);
    await c.patchEdition(edition.edition_key, {
      counts,
      status: anyOwed ? 'sending' : 'sent',
      hold_reason: anyOwed ? 'partial_send' : null,
      hold_detail: anyOwed ? anyOwed + ' recipient(s) still owed a send; a retry will use the same idempotency keys' : null,
    });
    return Object.assign({ sent: true, counts, provider: result.counts,
      partial: !!anyOwed }, outcomeBase);
  }
  /* WHAT WENT INTO THE TEST MESSAGE, returned rather than described. The
     launch checklist asks an operator to click the unsubscribe link; handing
     them the exact URL that was embedded — and saying whether it is a live
     token or a synthetic one — is the difference between checking that and
     assuming it. Never returned for a real send: those URLs are per
     subscriber and belong in the email and nowhere else. */
  const testWindowNote = (opts.test && pastWindow)
    ? 'the edition\u2019s retry window closed at ' + edition.deadline_at
      + '; a real send would have been refused as edition_stale'
    : null;
  const testLinks = opts.test ? payload.map(r => ({
    email: r.email,
    unsubscribe: r.urls.unsubscribe,
    preferences: r.urls.preferences,
    live_token: !!(recipients.filter(x => x.email === r.email)[0] || {}).live_token,
  })) : undefined;
  return Object.assign({ sent: true, provider: result.counts, dry: !!opts.dry, test: !!opts.test,
    past_window: testWindowNote,
    console_log: result.console_log, test_links: testLinks }, outcomeBase);
}

/* ============================================================== the CLI */
async function main() {
  const phase = (process.argv[2] || 'due').toLowerCase();
  const nowArg = arg('now', null);
  const now = nowArg && nowArg !== true ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(now)) { console.error('--now is not a date'); process.exit(2); }
  const QUIET = flag('quiet');
  const log = (...a) => { if (!QUIET) console.log(...a); };
  const DRY = flag('dry');
  const OFFLINE = flag('offline');
  const FORCE = flag('force');
  const SPORTS = (() => {
    const s = arg('sport', null);
    if (!s || s === true) return SCHEDULE.sports();
    return [String(s).toUpperCase()];
  })();
  const rid = runId();
  const opts_fetch = undefined;

  if (flag('refresh')) {
    log('refreshing the article records from the research terminal…');
    try {
      cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'articles', 'generate.js'), '--network', '--quiet'],
        { stdio: 'inherit', cwd: ROOT });
    } catch (e) { log('  ! the record refresh failed: ' + (e && e.message)); }
  }

  const resolved = await RUNTIME.resolve({ offline: OFFLINE });
  log('EdgeDesk newsletter · ' + phase + ' · ' + nowIso(now));
  log('  settings from ' + (resolved.database_reachable ? 'the database' : 'the committed defaults')
    + (resolved.database_error ? ' (database: ' + resolved.database_error + ')' : '')
    + ' · sending ' + (resolved.sending_enabled ? 'ENABLED' : 'disabled (launch gate)')
    + ' · service credential ' + (resolved.has_service_credential ? 'present' : 'absent'));

  const runRows = [];
  function record(row) {
    runRows.push(Object.assign({ run_id: rid, at: nowIso(now) }, row));
  }

  /* ------------------------------------------------------------- due --- */
  if (phase === 'due') {
    SPORTS.forEach(s => {
      const d = dueFor(s, now, resolved.settings);
      log('\n' + s + '  ' + d.title);
      log('  edition date   ' + d.edition_date + ' (' + d.weekday + ' ' + d.local_time + ' ' + d.zone + ')');
      log('  scheduled at   ' + d.scheduled_at + (d.zone_exact ? '' : '  [zone database unavailable — approximated]'));
      log('  window closes  ' + d.deadline_at);
      log('  state          ' + (d.due ? 'DUE (' + d.minutes_late + ' minutes in)' : d.stale ? 'STALE' : 'not due'));
      log('  next edition   ' + d.next_edition_date + ' at ' + d.next_scheduled_at);
      log('  sport switch   ' + (resolved.sportEnabled(s) ? 'on' : 'PAUSED'));
    });
    return;
  }

  /* ------------------------------------------------------------ rank --- */
  if (phase === 'rank') {
    for (const s of SPORTS) {
      const cands = candidates();
      const slate = SLATE.resolve({ candidates: cands, sport: s, now });
      if (!slate.ok) { log('\n' + s + ': ' + slate.detail); continue; }
      const sel = SELECT.rank({ games: slate.games, sport: s, now, settings: resolved.settings });
      log('\n' + s + ' — season ' + slate.season + ' week ' + slate.week + ', ' + sel.considered + ' scored, '
        + sel.chosen.length + ' chosen (threshold ' + sel.settings.threshold
        + ', expansion ' + sel.settings.expansion_threshold + ')');
      log('  market coverage: ' + sel.coverage.with_market + '/' + sel.considered);
      sel.chosen.forEach(g => log('  #' + g.rank + '  ' + String(g.score).padStart(5) + '  '
        + (g.away + ' at ' + g.home).padEnd(46) + ' conf ' + g.confidence
        + '  gap ' + (g.spread.gap_points == null ? '—' : g.spread.gap_points)));
      if (flag('explain')) {
        sel.chosen.forEach(g => {
          log('\n  ' + g.away + ' at ' + g.home);
          g.components.forEach(c => log('    ' + String(c.points).padStart(6) + '  ' + c.key + ' — ' + (c.detail || c.label)));
        });
        (sel.refused || []).slice(0, 10).forEach(r => log('    REFUSED ' + r.matchup + ': '
          + r.reasons.map(x => x.id + ' (' + x.why + ')').join('; ')));
      }
    }
    return;
  }

  /* ---------------------------------------------------------- market --- */
  if (phase === 'market') {
    for (const s of SPORTS) {
      const cands = candidates();
      const slate = SLATE.resolve({ candidates: cands, sport: s, now });
      if (!slate.ok) { log('\n' + s + ': ' + slate.detail); record({ sport: s, phase: 'market', ok: false, reason: slate.reason }); continue; }
      const out = await MARKET.refresh({
        games: slate.games, season: slate.season, week: slate.week,
        now, dry: DRY, fetch: opts_fetch,
      });
      log('\n' + s + ' — season ' + slate.season + ' week ' + slate.week + ', ' + slate.games.length + ' games on the slate');
      if (!out.ok) {
        log('  refused: ' + out.reason + (out.detail ? ' — ' + out.detail : ''));
      } else {
        log('  ' + out.quotes + ' quote(s) joined from ' + (out.signals_read || 0) + ' signal row(s)'
          + ' via ' + (out.resolver || '?')
          + (out.wrote ? ' -> ' + out.wrote : ' (nothing written)'));
        if (out.refused_count) log('  ' + out.refused_count + ' refused: ' + JSON.stringify(out.refused_by_reason || {}));
        (out.refused || []).slice(0, 6).forEach(r => log('    · ' + r.why + ' — ' + r.detail));
        if ((out.unresolved_slate || []).length) {
          log('  ' + out.unresolved_slate.length + ' slate game(s) whose own names did not resolve:');
          out.unresolved_slate.forEach(g => log('    · ' + g.away + ' at ' + g.home));
        }
        if (out.books && out.books.length) log('  books: ' + out.books.join(', '));
      }
      record({ sport: s, phase: 'market', ok: !!out.ok && out.quotes > 0, reason: out.reason || null,
        detail: { quotes: out.quotes, signals_read: out.signals_read || 0,
          refused: out.refused_by_reason || {}, wrote: out.wrote || null } });
    }
    STORE.appendRuns(runRows, { now });
    return;
  }

  /* ---------------------------------------------------------- report --- */
  if (phase === 'report') {
    const idx = STORE.loadIndex();
    const runs = STORE.loadRuns();
    console.log('## EdgeDesk newsletter\n');
    console.log('| edition | status | games | recipients | reason |');
    console.log('| --- | --- | --- | --- | --- |');
    (idx.editions || []).slice(0, 10).forEach(e => console.log('| ' + e.edition_key + ' | ' + e.status
      + ' | ' + (e.game_count == null ? '—' : e.game_count)
      + ' | ' + (e.eligible_recipients == null ? '—' : e.eligible_recipients)
      + ' | ' + (e.hold_reason || '') + ' |'));
    console.log('\n### recent runs\n');
    (runs.runs || []).slice(-20).reverse().forEach(r => console.log('- `' + r.at + '` **' + (r.sport || '—')
      + '** ' + r.phase + ' — ' + (r.ok ? 'ok' : 'HELD') + (r.reason ? ': ' + r.reason : '')));
    return;
  }

  /* ------------------------------------------------------------ gate --- */
  /* THE ONE-TIME LAUNCH GATE, AND THE ONE PRECONDITION IT WILL NOT SKIP.

     Opening this means the next valid edition goes to every confirmed
     subscriber with no further approval, so the only thing this refuses is
     the thing that would make that unsafe: an unsubscribe link that does not
     work.

     Every email carries a link to /functions/v1/newsletter/unsubscribe. If
     that function is not deployed the link 404s, and an edition sent in that
     state is one a reader cannot get out of — which is both the protection
     an operator asks to preserve when they say "preserve unsubscribe" and,
     in the United States, a legal requirement rather than a preference. It
     is also the same function that serves /subscribe and /confirm and
     receives the provider's bounce and complaint webhooks, so without it
     nobody can join, nobody can leave, and no bounce is ever suppressed.

     So the precondition is checked against the live deployment, not asserted
     in a comment: --on probes the function and refuses if it is not there.
     --force opens the gate anyway, because an operator who knows all of that
     and has a reason is not this mistake. Closing it is never gated: a kill
     switch that could be blocked is not a kill switch. */
  if (phase === 'gate') {
    const wantOn = flag('on');
    const wantOff = flag('off');
    const line = (k, v) => log('  ' + String(k).padEnd(24) + ' ' + v);
    if (wantOn && wantOff) { console.error('--on and --off are the same switch'); process.exit(2); }
    const c = RUNTIME.client({});
    if (!c.enabled || !c.hasService) {
      console.error('the launch gate lives in the database; this needs the service role');
      process.exit(2);
    }
    const before = await c.readSettings();
    if (!before) { console.error('could not read newsletter_settings'); process.exit(2); }

    let counts = null;
    try { counts = await c.subscriberCounts(); } catch (e) { log('  ! could not count subscribers: ' + (e && e.message)); }

    log('\n=== the launch gate ===');
    line('sending_enabled', before.sending_enabled ? 'OPEN' : 'closed');
    line('cfb / nfl', (before.cfb_enabled ? 'on' : 'PAUSED') + ' / ' + (before.nfl_enabled ? 'on' : 'PAUSED'));
    line('dispatcher', before.dispatcher_enabled ? 'on' : 'PAUSED');
    if (counts) {
      line('confirmed subscribers', counts.confirmed + ' (' + counts.cfb + ' CFB, ' + counts.nfl + ' NFL)');
      line('pending / unsubscribed', counts.pending + ' / ' + counts.unsubscribed);
    }
    if (!wantOn && !wantOff) { log('\n  read-only; pass --on or --off to move it\n'); return; }

    if (wantOn) {
      const base = (RUNTIME.SB_URL || '').replace(/\/$/, '');
      let reachable = false, detail = 'no project URL';
      try {
        const res = await fetch(base + '/functions/v1/newsletter/health', {
          method: 'GET',
          headers: { authorization: 'Bearer ' + (process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || RUNTIME.SB_ANON || '') },
        });
        reachable = res.status !== 404;
        detail = 'HTTP ' + res.status;
      } catch (e) { detail = String((e && e.message) || e).slice(0, 120); }
      line('unsubscribe endpoint', reachable ? 'reachable (' + detail + ')' : 'NOT DEPLOYED (' + detail + ')');
      if (!reachable && !FORCE) {
        log('\n  REFUSED. The `newsletter` edge function is not deployed, so every email\n'
          + '  this would send carries an unsubscribe link that answers 404 — and the\n'
          + '  same function serves signup, confirmation and the bounce/complaint\n'
          + '  webhook, so nobody could join, leave, or be suppressed.\n\n'
          + '  From a workstation with the CLI:\n\n'
          + '    supabase functions deploy newsletter --no-verify-jwt\n\n'
          + '  Or with no CLI at all. The file imports nothing, so it pastes\n'
          + '  whole into the dashboard editor:\n\n'
          + '    Supabase dashboard -> Edge Functions -> deploy a new function\n'
          + '    -> name it exactly `newsletter`\n'
          + '    -> paste supabase/functions/newsletter/index.ts\n'
          + '    -> turn OFF "Verify JWT" before deploying\n\n'
          + '  Verify JWT has to be off: /unsubscribe, /confirm and /webhook are\n'
          + '  opened by mail clients and by Resend, and neither carries a Supabase\n'
          + '  token. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected for\n'
          + '  you, so the unsubscribe link needs nothing further. Signup mail also\n'
          + '  wants RESEND_API_KEY, and the webhook NEWSLETTER_WEBHOOK_SECRET, as\n'
          + '  function secrets.\n\n'
          + '  Then run this again. --force opens it anyway.\n');
        record({ phase: 'gate', ok: false, reason: 'unsubscribe_endpoint_missing' });
        STORE.appendRuns(runRows, { now });
        process.exitCode = 1;
        return;
      }
    }

    const after = await c.patchSettings({ sending_enabled: !!wantOn });
    log('\n  sending_enabled ' + (before.sending_enabled ? 'OPEN' : 'closed')
      + ' -> ' + (after && after.sending_enabled ? 'OPEN' : 'closed')
      + (wantOn && FORCE ? '  [forced past the unsubscribe check]' : ''));
    if (wantOn) {
      log('  From here a valid edition sends automatically at 10:00 America/Chicago:');
      SCHEDULE.sports().forEach(sp => {
        const d = dueFor(sp, now, resolved.settings);
        log('    ' + sp + '  next ' + d.next_edition_date + ' at ' + d.next_scheduled_at);
      });
      log('  To pause: this phase with --off, or the Launch card at /admin/newsletter.');
    }
    log('');
    record({ phase: 'gate', ok: true, detail: { sending_enabled: !!wantOn, forced: !!(wantOn && FORCE) } });
    STORE.appendRuns(runRows, { now });
    return;
  }

  /* ---------------------------------------------------------- doctor --- */
  /* WHAT IS ACTUALLY CONFIGURED, READ-ONLY, WITHOUT PRINTING A SECRET.

     A launch checklist ticked off from memory is a launch checklist that is
     wrong. This asks the database, the two edge functions and the mail
     provider what state they are in and prints the answer, so the remaining
     steps are the ones that are genuinely remaining.

     Every credential is reported as present / absent. The Resend DNS records
     are read from the ACCOUNT, because the records are account-specific and
     the only correct source for them is the account itself. */
  if (phase === 'doctor') {
    const blank = (label) => log('  ' + label);
    const line = (k, v) => log('  ' + String(k).padEnd(26) + ' ' + v);
    const mark = (b) => (b ? 'yes' : 'NO');
    const todo = [];

    log('\n=== the database ===');
    if (!resolved.has_service_credential) {
      line('service credential', 'ABSENT — set SB_SERVICE_ROLE (or SUPABASE_SERVICE_ROLE_KEY) to inspect the database');
      todo.push('give this job the service role so it can read the install state');
    } else {
      const c = RUNTIME.client({});
      let st = null, stErr = null;
      try { st = await c.installStatus(); } catch (e) { stErr = e; }
      if (!st) {
        const why = String((stErr && stErr.message) || 'no answer');
        line('install report', 'UNAVAILABLE — ' + why.slice(0, 160));
        if (/PGRST202|does not exist|not find the function/i.test(why)) {
          todo.push('run supabase/newsletter.sql once in the SQL editor (it is idempotent) so newsletter_install_status() exists');
        }
      } else {
        const tables = st.tables || {}, fns = st.functions || {};
        const missingT = Object.keys(tables).filter(k => !tables[k]);
        const missingF = Object.keys(fns).filter(k => !fns[k]);
        line('contract tables', (Object.keys(tables).length - missingT.length) + '/' + Object.keys(tables).length
          + (missingT.length ? ' — MISSING ' + missingT.join(', ') : ''));
        line('contract functions', (Object.keys(fns).length - missingF.length) + '/' + Object.keys(fns).length
          + (missingF.length ? ' — MISSING ' + missingF.join(', ') : ''));
        if (missingT.length || missingF.length) todo.push('run supabase/newsletter.sql once in the SQL editor');
        const ex = st.extensions || {};
        line('pg_cron / pg_net', mark(ex.pg_cron) + ' / ' + mark(ex.pg_net));
        const cron = st.cron || {};
        line('cron job', cron.present ? (cron.schedule + ' (UTC)' + (cron.active === false ? ' — INACTIVE' : ''))
          : ('NOT SCHEDULED — ' + (cron.why || '')));
        if (!cron.present) todo.push('enable pg_cron and pg_net, then run supabase/newsletter_cron.sql');
        const ds = st.db_settings || {};
        line('edgedesk.project_url', ds['edgedesk.project_url'] || 'not set');
        line('edgedesk.service_key', ds['edgedesk.service_key'] || 'not set');
        if (ds['edgedesk.project_url'] !== 'set' || ds['edgedesk.service_key'] !== 'set') {
          todo.push('set edgedesk.project_url and edgedesk.service_key with alter database (see supabase/newsletter_cron.sql)');
        }
        const g = st.gate || {};
        log('');
        line('sending_enabled', g.sending_enabled ? 'TRUE — editions will send' : 'false — the launch gate is closed');
        line('cfb / nfl enabled', mark(g.cfb_enabled) + ' / ' + mark(g.nfl_enabled));
        line('dispatcher_enabled', mark(g.dispatcher_enabled));
        line('from', (g.from_name || '?') + ' <' + (g.from_email || '?') + '>');
        line('reply-to', g.reply_to_email || 'not set');
        line('mailing address', g.mailing_address || 'NOT SET — CAN-SPAM requires one');
        line('test recipients', (g.test_recipients || 0) + ' configured');
        if (!g.test_recipients) todo.push('add a test address to newsletter_settings.test_recipients before any send');
        const n = st.counts || {};
        log('');
        line('subscribers', n.subscribers_confirmed + ' confirmed, ' + n.subscribers_pending + ' pending, '
          + n.subscribers_unsubscribed + ' unsubscribed');
        line('suppressions', String(n.suppressions));
        line('editions', n.editions + ' stored, ' + n.editions_sent + ' sent');
        line('deliveries / events', n.deliveries + ' / ' + n.provider_events);
      }
    }

    log('\n=== the edge functions ===');
    const base = (RUNTIME.SB_URL || '').replace(/\/$/, '');
    if (!base) { blank('no project URL — set SB_URL'); } else {
      for (const fn of ['newsletter', 'newsletter_cron']) {
        let verdict;
        try {
          const res = await fetch(base + '/functions/v1/' + fn + '/health', {
            method: 'GET',
            headers: { authorization: 'Bearer ' + (process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || RUNTIME.SB_ANON || '') },
          });
          const body = (await res.text()).slice(0, 200);
          verdict = res.status === 404 ? 'NOT DEPLOYED (404)' : res.status + ' ' + body;
          if (res.status === 404) {
            todo.push('supabase functions deploy ' + fn + ' --no-verify-jwt'
              + '  (no CLI? paste supabase/functions/' + fn + '/index.ts into the'
              + ' dashboard editor as `' + fn + '`, Verify JWT OFF)');
          }
        } catch (e) {
          verdict = 'unreachable — ' + String((e && e.message) || e).slice(0, 120);
        }
        line(fn, verdict);
      }
    }

    log('\n=== the mail provider ===');
    const pcfg = PROVIDER.config(process.env);
    line('RESEND_API_KEY', pcfg.apiKey ? 'present' : 'ABSENT');
    if (!pcfg.apiKey) {
      todo.push('add the RESEND_API_KEY repository secret (Settings -> Secrets and variables -> Actions)');
      blank('  (domain and DNS state cannot be read without it — Resend\u2019s records are account-specific)');
    } else {
      try {
        const res = await fetch(pcfg.endpoint + '/domains', {
          headers: { authorization: 'Bearer ' + pcfg.apiKey, 'content-type': 'application/json' },
        });
        const body = await res.text();
        /* A SEND-ONLY KEY IS THE RIGHT KEY, and it cannot read this.
           Resend answers a sending-restricted key with 401 restricted_api_key
           on /domains. That is least privilege working, not a fault, and the
           fix is NOT a broader key sitting in CI — it is to read the domain's
           DNS state in the dashboard. Reported as a note rather than as work
           to do, so this check never argues for a wider credential. */
        if (res.status === 401 && /restricted_api_key/.test(body)) {
          line('domains', 'not readable with a send-only key — this is the right key for sending; '
            + 'check the domain\u2019s DNS state in the Resend dashboard');
        } else if (!res.ok) {
          line('domains', res.status + ' ' + body.slice(0, 200));
          todo.push('the Resend API rejected the domain read (' + res.status + ') — check the key and the account');
        } else {
          const data = JSON.parse(body);
          const domains = data.data || data.domains || [];
          if (!domains.length) { line('domains', 'NONE — add the sending domain in the Resend dashboard'); todo.push('add and verify the sending domain in Resend'); }
          domains.forEach(d => {
            line('domain', d.name + ' — ' + d.status + (d.region ? ' (' + d.region + ')' : ''));
            (d.records || []).forEach(r => log('      ' + String(r.record || r.type).padEnd(6) + ' '
              + String(r.name || '').padEnd(32) + ' ' + String(r.type).padEnd(6) + ' '
              + String(r.value || '').slice(0, 110) + '   [' + (r.status || '?') + ']'));
            if (String(d.status).toLowerCase() !== 'verified') todo.push('finish DNS verification for ' + d.name + ' (records above, from the Resend account)');
          });
        }
      } catch (e) {
        line('domains', 'unreachable — ' + String((e && e.message) || e).slice(0, 140));
      }
    }

    log('\n=== what is left ===');
    if (!todo.length) log('  nothing this check can see. The launch gate is the operator\u2019s to open.');
    todo.forEach((t, i) => log('  ' + (i + 1) + '. ' + t));
    log('');
    return;
  }

  /* -------------------------------------- build / send / all / preview -- */
  const doBuild = ['build', 'all', 'preview', 'test'].indexOf(phase) >= 0;
  const doSend = ['send', 'all', 'test', 'retry'].indexOf(phase) >= 0;
  if (!doBuild && !doSend) {
    console.error('unknown phase: ' + phase
      + '\nphases: due, doctor, gate, market, build, send, retry, all, preview, test, rank, report');
    process.exit(2);
  }

  if (resolved.settings.dispatcher_enabled === false && !FORCE) {
    log('\nthe dispatcher is paused (newsletter_settings.dispatcher_enabled = false)');
    record({ phase: phase, ok: false, reason: 'dispatcher_disabled' });
    STORE.appendRuns(runRows, { now });
    return;
  }

  for (const sport of SPORTS) {
    log('\n=== ' + sport + ' ===');
    let edition = null;

    if (doBuild) {
      edition = await build({
        sport, now, resolved, log, dry: DRY || phase === 'preview',
        offline: OFFLINE, preview: phase === 'preview',
        force: FORCE || phase === 'test',
        season_hint: null, week_hint: null,
      });
      if (!edition.edition_key) {
        edition.edition_key = STORE.editionKey(sport, edition.season || 0, edition.slate_week || 0, edition.edition_date);
      }
      log('  ' + edition.edition_key + ' -> ' + edition.status
        + (edition.hold_reason ? ' (' + edition.hold_reason + ')' : '')
        + (edition.game_count ? ' · ' + edition.game_count + ' games' : ''));
      if (edition.hold_detail) log('    ' + edition.hold_detail);
      if (edition.status === 'ready' || edition.status === 'preview') {
        log('    subject: ' + edition.subject);
        log('    preview: ' + edition.preview_text);
      }
      if (edition.season != null) {
        await persist(edition, { resolved, now, log,
          writeRepo: !DRY, writeDb: !DRY && phase !== 'preview' });
      }
      record({ sport, phase: phase === 'preview' ? 'preview' : 'build', edition_key: edition.edition_key,
        ok: edition.status === 'ready' || edition.status === 'preview', reason: edition.hold_reason || null,
        detail: { games: edition.game_count || 0, content_hash: edition.content_hash || null } });
      if (phase === 'preview' || phase === 'build') continue;
      if (edition.status !== 'ready') continue;
    }

    if (doSend) {
      if (!edition) {
        const d = dueFor(sport, now, resolved.settings);
        /* find the stored edition for this date, whatever week it turned out
           to be — the date is the half of the identity the clock knows */
        const stored = STORE.allEditions().filter(e => e.sport === sport && e.edition_date === d.edition_date)[0];
        if (!stored) {
          log('  no stored edition for ' + sport + ' ' + d.edition_date + ' — run `build` first');
          record({ sport, phase: 'send', ok: false, reason: 'no_stored_edition' });
          continue;
        }
        edition = STORE.hydrate(stored);
      }
      const res = await send(edition, {
        resolved, now, log, dry: DRY, force: FORCE, retry: phase === 'retry', run_id: rid,
        test: phase === 'test', to: arg('to', null) === true ? null : arg('to', null),
        env: process.env, driver: arg('driver', null) === true ? null : arg('driver', null),
      });
      log('  send: ' + (res.sent ? 'SENT' : 'not sent') + (res.reason ? ' — ' + res.reason : '')
        + (res.detail ? ' (' + res.detail + ')' : ''));
      if (res.console_log) res.console_log.forEach(b => log('    would send to ' + b.emails.join(', ')));
      (res.test_links || []).forEach(l => log('    ' + l.email + ' unsubscribe: ' + l.unsubscribe
        + (l.live_token ? '  [live token — this link really unsubscribes]'
          : '  [synthetic token — this address is not a subscriber, so the link has nothing to act on]')));
      record({ sport, phase: phase === 'test' ? 'test_send' : 'send',
        edition_key: edition.edition_key, ok: !!res.sent, reason: res.reason || null,
        detail: { counts: res.counts || res.provider || null } });
    }
  }

  STORE.appendRuns(runRows, { now });
  if (resolved.client.enabled && resolved.client.hasService && !DRY) {
    try { await resolved.client.logRun(runRows.map(r => ({
      run_id: r.run_id, sport: r.sport || null, phase: r.phase,
      edition_key: r.edition_key || null, ok: r.ok, reason: r.reason || null, detail: r.detail || null,
    }))); } catch (_) { /* a run-log write failure must never fail a send */ }
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = { build, send, persist, candidates, publishedIds, attachResearch, dueFor, snapshotsFor };
