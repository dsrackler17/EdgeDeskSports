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
      log('  market refresh: ' + (marketRefresh.ok
        ? (marketRefresh.quotes + ' quote(s) joined' + (marketRefresh.wrote ? ' -> ' + marketRefresh.wrote : ''))
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
async function send(edition, opts) {
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
  const deadline = Date.parse(edition.deadline_at);
  if (!opts.force && Number.isFinite(deadline) && now > deadline) {
    return Object.assign({ sent: false, reason: 'edition_stale',
      detail: 'the retry window closed at ' + edition.deadline_at }, outcomeBase);
  }
  /* A GAME THAT KICKED OFF WHILE THE EDITION WAITED invalidates the edition.
     Re-validating here rather than trusting the build is the difference
     between a late send and a wrong one. */
  const revalidate = VALIDATE.validate(edition, {
    now, published_ids: publishedIds(),
    rendered: { html: edition.html_free, text: edition.text_free },
    renderOpts: { site: settings.site_url, mailing_address: settings.mailing_address },
  });
  if (!revalidate.ok) {
    return Object.assign({ sent: false, reason: 'revalidation_failed',
      detail: revalidate.hold_reason, validation: revalidate }, outcomeBase);
  }

  /* ---- the recipients, resolved LIVE ---------------------------------- */
  let recipients = [];
  if (opts.test) {
    const list = (settings.test_recipients || []).concat(opts.to ? [opts.to] : []);
    recipients = list.filter(Boolean).map(e => ({
      subscriber_id: null, email: String(e).toLowerCase(), is_member: false,
      manage_token: 'test-' + PROVIDER.sha256(String(e)).slice(0, 24),
    }));
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
    await c.patchEdition(edition.edition_key, {
      status: 'sending', eligible_recipients: recipients.length,
    });
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
  return Object.assign({ sent: true, provider: result.counts, dry: !!opts.dry, test: !!opts.test,
    console_log: result.console_log }, outcomeBase);
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

  /* -------------------------------------- build / send / all / preview -- */
  const doBuild = ['build', 'all', 'preview', 'test'].indexOf(phase) >= 0;
  const doSend = ['send', 'all', 'test', 'retry'].indexOf(phase) >= 0;
  if (!doBuild && !doSend) {
    console.error('unknown phase: ' + phase
      + '\nphases: due, build, send, retry, all, preview, test, rank, report');
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
        resolved, now, log, dry: DRY, force: FORCE, retry: phase === 'retry',
        test: phase === 'test', to: arg('to', null) === true ? null : arg('to', null),
        env: process.env, driver: arg('driver', null) === true ? null : arg('driver', null),
      });
      log('  send: ' + (res.sent ? 'SENT' : 'not sent') + (res.reason ? ' — ' + res.reason : '')
        + (res.detail ? ' (' + res.detail + ')' : ''));
      if (res.console_log) res.console_log.forEach(b => log('    would send to ' + b.emails.join(', ')));
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

module.exports = { build, send, persist, candidates, publishedIds, dueFor, snapshotsFor };
