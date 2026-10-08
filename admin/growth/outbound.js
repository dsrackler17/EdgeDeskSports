/* ===========================================================================
   /admin/growth/ — the OUTBOUND tab (supabase/growth_outbound.sql).

   Shown only to an outbound OWNER. The page asks one question first —
   growth_outbound_is_owner() — and calls no other outbound door unless the
   answer is exactly true. That is a courtesy, not the security: every door
   checks the owner again in the database, and an affiliate admin who is not
   an owner is refused there whatever this page does.

   Nothing here sends anything. The tab shows the mode (TEST MODE / LIVE)
   everywhere it matters, what is blocking a send, today's counts, the
   prospects (with their emails — owner only), suppressions, the settings
   and the activity log. Raising the daily cap and leaving test mode each
   ask for a deliberate confirmation, and the database refuses either without
   the confirmation flag.

   RESEARCH (Phase 3). One prospect opens into what is known about them and
   how sure: every number beside its bar, the gates still unmet, each fact
   with its sources, and the full history of every observation ("previously
   … currently …"). The owner adds a prospect or evidence, retires a wrong
   observation, and releases an address or profile attached to the wrong
   person. The page computes nothing: names, confidences, scores and status
   all come back from the database, which derives them from the evidence.
   Everything shown here was found on the open web, so all of it is escaped,
   and only an https: address ever becomes a link.

   THE REVIEW QUEUE (Phase 4). Every draft waiting for the owner, as a card:
   who it is for and how sure, each thing it says about them with the
   evidence behind it, the content rules, and the message exactly as it
   would be sent (in test mode, to the test inbox). Approve one (asked
   first), or several: the count is TYPED and sent to the database, which
   approves exactly that many or none. Approving sends nothing.

   SENDING (Phase 5). Only an approved draft, only when the owner presses
   Send (asked first; several at once need the count typed). The page asks
   the growth_outbound_send Edge Function, which checks the owner itself,
   claims the send in the database, hands Resend exactly what the database
   composed with one key per draft (a retry can never send twice), and
   records the answer. The Sends table shows every one, and how it went.

   THE MORNING (Phase 12). "This morning" says what the overnight run found
   and qualified against the daily target, what waits for review, what may go
   out today (the warm-up cap), the sending domain's SPF/DKIM/DMARC check and
   the partner leads kept apart from the subscriber queue. Each card and each
   prospect shows the 0–100 qualification score in its five parts, why they
   fit, their address and whether anyone verified it, and where to read up on
   them. Providers (Brave, Apollo, Hunter, Clay) are switched on and off here;
   Clay's enrichment goes out by its table's webhook or a CSV, and comes back
   as a CSV the database weighs as Clay's word. The page still computes
   nothing: every number comes from the database.
   =========================================================================== */
(function (root) {
  'use strict';

  var S = null, OWNER = false, LOADED = false, SETTINGS = null, DETAIL = null, CATALOG = null;
  var QUEUE = 'pending_review', QROWS = [], PICKED = {};
  var CSTATUS = 'new', BUSY = false, WRITING = false;
  var BLOCKERS = {
    postal_address_missing: 'no postal address is configured (required in every commercial email)',
    unsubscribe_endpoint_missing: 'the opt-out endpoint is not configured yet',
    test_inbox_missing: 'test mode is on but no test inbox is set',
    no_outbound_owner: 'no outbound owner is configured',
    webhook_secret_missing: 'Resend\'s webhook signing secret is not set, so bounces and spam complaints could not reach EdgeDesk (in the Supabase SQL editor: select growth_outbound.set_webhook_secret(\'whsec_…\'))',
    domain_auth_failed: 'the sending domain is missing SPF, DKIM or DMARC (System check → Check the sending domain)'
  };
  var SEGMENTS = [['customer', 'Potential subscriber'], ['media_partner', 'Media partner'], ['affiliate', 'Affiliate'],
    ['business_partner', 'Business partner'], ['partnership', 'Partnership (other)']];
  var PARTS = [['relevance', 'Product relevance'], ['analytics', 'Analytics interest'], ['purchase', 'Purchase signals'],
    ['contact', 'Contact quality'], ['personalization', 'Personalization']];
  var PROVIDERS = [['brave', 'Brave', 'search'], ['apollo_search', 'Apollo people search', 'search'], ['hunter', 'Hunter', 'email lookup and verification'],
    ['apollo', 'Apollo email match', 'email lookup'], ['clay', 'Clay', 'enrichment']];
  var SEND_WHY = {
    resend_unreachable: 'Resend did not answer; press Send again (the same draft can never be sent twice)',
    resend_key_refused: 'Resend refused the API key: check RESEND_API_KEY in the Edge Function secrets',
    message_check_failed: 'not sent: the message failed the last check',
    resend_rejected: 'Resend refused it',
    not_an_owner: 'this account is not an outbound owner',
    database_unreachable: 'the database did not answer; try again',
    claim_failed: 'the database did not answer; try again',
    not_approved: 'it is no longer approved'
  };
  var STATUS = { discovered: 'Discovered', needs_research: 'Needs research', qualified: 'Qualified', ready_for_review: 'Ready for review',
    contacted: 'Contacted', replied: 'Replied', converted: 'Converted', rejected: 'Rejected', suppressed: 'Suppressed' };
  var EV_FIELDS = [['full_name', 'Name'], ['organization', 'Organization'], ['job_title', 'Title or role'], ['email', 'Email address'],
    ['project', 'Project'], ['article', 'Article'], ['podcast', 'Podcast'], ['newsletter', 'Newsletter'], ['model', 'Model'],
    ['topic', 'Topic'], ['sports_focus', 'Sport covered'], ['audience_size', 'Audience size'], ['fit_signal', 'Fit signal']];
  var EV_KINDS = [['own_site', 'Their own site'], ['own_profile', 'Their own profile'], ['publication', 'A publication about them'],
    ['interview', 'An interview'], ['directory', 'A directory or list'], ['owner_verified', 'I checked it myself'],
    ['pattern_guess', 'A guessed address (email only)'], ['provider_verified', 'Verification provider'], ['provider_found', 'Provider lookup']];
  var REASONS = { conflicting_sources: 'sources disagree', single_source: 'only one independent source', stale_role: 'over a year old',
    stale_audience: 'over a year old', old_content: 'over 18 months old — never call it recent' };
  var WARN = { first_name_withheld: 'first name withheld — identity not certain, or no plain first name',
    role_unconfirmed: 'role below its confidence bar', email_unsourced: 'the email address has no source',
    draft_cites_no_evidence: 'a draft cites no evidence', unsupported_claim: 'a draft makes a claim no current evidence supports',
    duplicate: 'duplicates another prospect', possible_duplicate: 'may be the same person as another prospect' };
  var FIELDS = [
    ['Mode', [['test_mode', 'bool', 'Test mode — every send goes only to the test inbox'],
              ['automation_enabled', 'bool', 'Automation — discover, research and draft on schedule (never approve, never send)'],
              ['test_inbox', 'email', 'Test inbox']]],
    ['Morning run', [['automation_timezone', 'text', 'Your time zone (e.g. America/New_York)'], ['automation_start_hour', 'int', 'Starts at (hour, 0–23)', 0, 23],
                     ['automation_hours', 'int', 'For how many hours', 1, 12],
                     ['digest_enabled', 'bool', 'Email me once the morning run is done, if drafts are waiting for review (to my own address only; never to a prospect)']]],
    ['Limits', [['max_sends_per_day', 'int', 'Daily send cap (live)', 1, 200], ['max_test_sends_per_day', 'int', 'Daily test-send cap', 1, 100],
                ['daily_prospect_target', 'int', 'Candidates to read per day (at most)', 1, 100],
                ['daily_qualified_target', 'int', 'New qualified subscribers to aim for per day', 1, 50]]],
    ['Warm-up', [['warmup_enabled', 'bool', 'Warm up the sending domain: the live cap grows week by week up to the daily cap'],
                 ['warmup_start_per_day', 'int', 'Live emails a day in the first week', 1, 200], ['warmup_step_per_week', 'int', 'Added each week', 0, 100]]],
    ['Gates', [['min_qualification_score', 'int', 'Minimum qualification score (0–100)', 0, 100],
               ['min_fit_score', 'int', 'Minimum fit score', 0, 100], ['min_identity_confidence', 'num', 'Minimum identity confidence'],
               ['min_role_confidence', 'num', 'Minimum role confidence'], ['min_research_confidence', 'num', 'Minimum research confidence'],
               ['min_email_confidence', 'num', 'Minimum email confidence']]],
    ['Follow-ups', [['followup_enabled', 'bool', 'Follow-up 1 (still needs your approval)'], ['followup_delay_days', 'int', 'Days before follow-up 1', 2, 30],
                    ['final_followup_enabled', 'bool', 'Final follow-up'], ['final_followup_delay_days', 'int', 'Days after follow-up 1 before the final one', 3, 60],
                    ['reply_detection', 'bool', 'Detect replies from Resend: a reply ends that person\'s sequence (a request to stop is always honoured)']]],
    ['Sender and compliance', [['sender_name', 'text', 'Sender name'], ['sender_email', 'email', 'Sender email (@edgedesksports.com)'],
                               ['reply_to_email', 'email', 'Reply-to (@edgedesksports.com, optional)'], ['cta_url', 'text', 'Call-to-action URL (edgedesksports.com)'],
                               ['business_name', 'text', 'Business name in the footer'], ['postal_address', 'text', 'Postal address in the footer (required to send)'],
                               ['unsubscribe_url_base', 'text', 'Opt-out endpoint base URL']]],
    ['Results', [['attribution_links', 'bool', 'Tag EdgeDesk links in live emails with the prospect\'s campaign code (utm_campaign=ob_…), so a visit or signup can be matched']]]
  ];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function say(id, kind, t) { var el = $(id); if (!el) return; el.className = 'msg ' + (kind || ''); el.textContent = t || ''; }
  function when(v) { return v ? String(v).replace('T', ' ').slice(0, 16) + 'Z' : '—'; }
  function num(x, d) { return x == null ? '—' : Number(x).toFixed(d == null ? 2 : d); }
  function label(list, k) { for (var i = 0; i < list.length; i++) if (list[i][0] === k) return list[i][1]; return k; }
  function warnText(w) {
    w = String(w);
    if (WARN[w]) return WARN[w];
    var m = /^(conflict|stale|unsupported_fit_factor|unknown_fit_factor):(.+)$/.exec(w);
    if (!m) return w;
    return m[1] === 'conflict' ? 'sources disagree about the ' + label(EV_FIELDS, m[2]).toLowerCase()
      : m[1] === 'stale' ? 'the ' + label(EV_FIELDS, m[2]).toLowerCase() + ' is old'
      : m[1] === 'unsupported_fit_factor' ? 'fit reason "' + m[2] + '" has no current evidence, so it does not count'
      : 'unknown fit reason "' + m[2] + '"';
  }
  /* A source address came from the web: it is a link only if it is plainly https. */
  function link(u, text) {
    u = String(u || '');
    var t = esc(text == null ? u : text);
    return /^https:\/\/[^\s"'<>`\\]+$/.test(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + t + '</a>' : t;
  }
  function hostOf(u) { var m = /^https?:\/\/([^/?#]+)/.exec(String(u || '')); return m ? m[1] : String(u || ''); }
  function clip(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…' : t; }
  function options(list, sel) { return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === sel ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join(''); }
  function kpi(label, v, sub) { return '<div class="kpi"><i>' + esc(label) + '</i><b>' + esc(v) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>'; }
  function fail(id, e) {
    if (e && e.kind === 'signed_out') { if (typeof root.showGate === 'function') root.showGate(e.message, false); return; }
    if (e && e.kind === 'forbidden') { reset(); say('appMsg', 'err', 'This account is no longer an outbound owner.'); $('appMsg').classList.remove('hide'); return; }
    say(id, 'err', S ? S.message(e) : String(e && e.message || e));
    var el = $(id); if (el) el.classList.remove('hide');
  }

  /* ── visibility ─────────────────────────────────────────────────────── */
  function reset() {
    OWNER = false; LOADED = false; SETTINGS = null;
    if ($('tabs')) $('tabs').classList.add('hide');
    if ($('obModeTag')) $('obModeTag').classList.add('hide');
    show('growth');
    DETAIL = null; CATALOG = null; QROWS = []; PICKED = {}; RES = null;
    ['obKpis', 'obProspects', 'obSupp', 'obSettings', 'obActivity', 'obChips', 'obDetail', 'obLookOut', 'rqCards', 'obSends', 'obReplyChips', 'obReplies', 'dvProviders', 'dvCands', 'dvRuns',
     'mnChips', 'mnKpis', 'mnPartners', 'dvSwitches', 'dvWaiting', 'hcDomainOut',
     'rsChips', 'rsPeople', 'rsSends', 'rsSignals', 'rsSteps', 'rsGroups', 'rsDaily', 'rsLatest', 'hcTop', 'hcSummary', 'hcAttention', 'hcChecks'].forEach(function (id) { if ($(id)) $(id).innerHTML = ''; });
    if ($('obDetailWrap')) $('obDetailWrap').classList.add('hide');
  }
  function show(which) {
    var out = which === 'outbound' && OWNER;
    $('tabGrowth').classList.toggle('hide', out);
    $('tabOutbound').classList.toggle('hide', !out);
    $('tabBtnGrowth').classList.toggle('on', !out); $('tabBtnGrowth').setAttribute('aria-selected', String(!out));
    $('tabBtnOutbound').classList.toggle('on', out); $('tabBtnOutbound').setAttribute('aria-selected', String(out));
    if (out && !LOADED) load();
  }

  /* Ask the one question. Anything but exactly `true` hides the tab. */
  function start(session) {
    S = session; reset();
    return S.rpc('growth_outbound_is_owner', {}).then(function (v) {
      OWNER = v === true;
      $('tabs').classList.toggle('hide', !OWNER);
      if (OWNER) return S.rpc('growth_outbound_settings', {}).then(paintMode, function () {});
    }, function () { OWNER = false; $('tabs').classList.add('hide'); });
  }

  /* ── mode: TEST MODE / LIVE, everywhere ─────────────────────────────── */
  function paintMode(st) {
    SETTINGS = st || SETTINGS || {};
    var s = SETTINGS, t = s.today || {};
    var tag = $('obModeTag');
    tag.classList.remove('hide');
    tag.className = 'tag ' + (s.test_mode ? 'test' : 'live');
    tag.textContent = s.test_mode ? 'outbound · test mode' : 'outbound · LIVE';
    $('obChips').innerHTML =
      (s.test_mode ? '<span class="chip test" data-mode="test">TEST MODE — sends go only to ' + esc(s.test_inbox || '(no test inbox set)') + '</span>'
                   : '<span class="chip live" data-mode="live">LIVE — approved drafts reach real prospects</span>')
      + '<span class="chip ' + (s.automation_enabled ? 'ok' : 'off') + '">automation ' + (s.automation_enabled ? 'on' : 'off') + ' · never approves or sends</span>'
      + '<span class="chip">live sends today ' + esc(t.live_sends || 0) + ' / ' + esc(t.live_cap && t.live_cap.cap != null ? t.live_cap.cap : s.max_sends_per_day)
      + (t.live_cap && t.live_cap.warming ? ' (warming up, week ' + esc(t.live_cap.week) + ')' : '') + '</span>'
      + '<span class="chip">test sends today ' + esc(t.test_sends || 0) + ' / ' + esc(s.max_test_sends_per_day) + '</span>'
      + webhookChip(s.webhook);
    var b = s.send_blockers || [];
    $('obBlock').classList.toggle('hide', !b.length);
    $('obBlock').innerHTML = b.length ? '<b>Sending is blocked</b> until this is fixed: ' + b.map(function (x) { return esc(BLOCKERS[x] || x); }).join(' · ') : '';
    var lb = s.test_mode ? (s.live_send_blockers || []) : [];
    $('obLiveNote').classList.toggle('hide', !lb.length);
    $('obLiveNote').textContent = lb.length ? 'Before going live, sending to real people also needs: ' + lb.map(function (x) { return BLOCKERS[x] || x; }).join(' · ') + '.' : '';
  }

  /* what Resend has told us: the bounces and complaints that stop sending */
  function webhookChip(w) {
    if (!w) return '';
    if (!w.secret_set) return '<span class="chip off" data-webhook="unset">Resend events: signing secret not set</span>';
    return '<span class="chip ' + (w.last_event_at ? 'ok' : 'off') + '" data-webhook="set">Resend events: '
      + (w.last_event_at ? esc(w.events_24h || 0) + ' in 24 h · last ' + esc(when(w.last_event_at)) : 'none received yet') + '</span>';
  }

  /* ── loading ────────────────────────────────────────────────────────── */
  function load() {
    if (!OWNER) return Promise.resolve();
    LOADED = true;
    $('obMsg').classList.add('hide');
    return Promise.all([loadMorning(), loadOverview(), loadHealth(), loadAutomation(), loadQueue(), loadDrafting(), loadSends(), loadReplies(), loadResults(), loadResearch(), loadProspects(), loadSupp(), loadActivity()]).catch(function (e) { fail('obMsg', e); });
  }
  /* ── the 0–100 qualification score, in its parts (Phase 12) ─────────── */
  // the Phase 12 SQL is installed: the database reports its settings (and only then are they shown or sent)
  function p12() { return !!SETTINGS && 'min_qualification_score' in SETTINGS; }
  function qualBlock(q, min) {
    if (q === undefined) return '';   /* the SQL is older than the score */
    if (!q || q.score == null) return '<div class="note" data-qual="none">No qualification score yet: nothing is known about them.</div>';
    var parts = q.parts || {};
    var h = '<div class="qual" data-qual="' + esc(q.score) + '">' + PARTS.map(function (x) {
      var pt = parts[x[0]] || {}, mx = pt.max || 0, v = pt.points || 0;
      return '<div data-part="' + esc(x[0]) + '"><b>' + esc(v) + ' / ' + esc(mx) + '</b>' + esc(x[1])
        + '<div class="meter"><span style="width:' + (mx ? Math.max(0, Math.min(100, Math.round(100 * v / mx))) : 0) + '%"></span></div></div>';
    }).join('') + (parts.penalties && parts.penalties.points ? '<div data-part="penalties"><b>' + esc(parts.penalties.points) + '</b>Penalties</div>' : '') + '</div>';
    if (q.why) h += '<div class="sub" data-why="1">Why they fit: ' + esc(q.why) + '.</div>';
    if (q.against) h += '<div class="sub" data-against="1">Against: ' + esc(q.against) + '.</div>';
    var c = parts.contact || {};
    if (c.email_status) h += '<div class="sub">Contact: address ' + esc(c.email_status) + ' (' + esc(c.email || 0) + '), identity ' + esc(c.identity || 0) + ', own site or profile ' + esc(c.own_site_or_profile || 0) + '; '
      + esc((parts.personalization || {}).citeable_facts || 0) + ' fact(s) an email may cite.' + (min != null ? ' The bar is ' + esc(min) + '.' : '') + '</div>';
    return h;
  }
  function segName(k) { return label(SEGMENTS, k || 'customer'); }

  /* ── this morning (Phase 12) ──────────────────────────────────────────── */
  function loadMorning() {
    if (!OWNER) return Promise.resolve();
    return Promise.all([S.rpc('growth_outbound_morning', {}), S.rpc('growth_outbound_partner_leads', { p_limit: 50 })]).then(function (r) {
      paintMorning(r[0] || {}, r[1] || []);
    }, function (e) {
      if (e && e.kind === 'not_installed') {
        $('mnChips').innerHTML = '<span class="chip off">The morning summary arrives with the Phase 12 SQL: run supabase/growth_outbound.sql again.</span>';
        $('mnKpis').innerHTML = ''; $('mnPartners').innerHTML = '';
        return;
      }
      throw e;
    });
  }
  function domainChip(da, at) {
    if (!da) return '<span class="chip off" data-domain="unchecked">Sending domain: not checked yet (System check → Check the sending domain)</span>';
    var bad = ['spf', 'dkim', 'dmarc'].filter(function (k) { return da[k] && da[k].ok === false; }).map(function (k) { return k.toUpperCase(); });
    if (da.ok === true) return '<span class="chip ok" data-domain="ok">' + esc(da.domain) + ': SPF, DKIM and DMARC in place' + (da.dmarc && da.dmarc.policy ? ' (DMARC p=' + esc(da.dmarc.policy) + ')' : '') + ' · ' + esc(when(at)) + '</span>';
    if (da.ok === false) return '<span class="chip warn" data-domain="failed">' + esc(da.domain) + ': ' + esc(bad.join(', ') || 'a record') + ' missing — live sending blocked</span>';
    return '<span class="chip off" data-domain="unknown">' + esc(da.domain) + ': DNS could not be read · ' + esc(when(at)) + '</span>';
  }
  function paintMorning(m, partners) {
    var cap = m.live_cap || {};
    var on = PROVIDERS.filter(function (x) { return (m.providers || {})[x[0]] === true; }).map(function (x) { return x[1]; });
    $('mnChips').innerHTML = '<span class="chip" data-mn="day">' + esc(m.day) + ' · ' + esc(m.timezone) + '</span>'
      + domainChip(m.domain_auth, m.domain_auth_checked_at)
      + '<span class="chip ' + (cap.warming ? 'warn' : '') + '" data-mn="cap">Today\'s live cap ' + esc(cap.cap) + (cap.warming ? ' (warming up, week ' + esc(cap.week) + ' of the ramp to ' + esc(cap.max) + ')' : '') + '</span>'
      + (on.length ? '<span class="chip ok" data-mn="paid">Paid providers on: ' + esc(on.join(', ')) + '</span>' : '');
    $('mnKpis').innerHTML = kpi('Qualified today', (m.qualified_today || 0) + ' of ' + (m.qualified_target || 0), 'new potential subscribers at ' + (m.min_qualification_score != null ? m.min_qualification_score + '+' : 'the bar'))
      + kpi('Waiting for review', m.review || 0, 'drafts for you') + kpi('Approved, not sent', m.approved_unsent || 0)
      + kpi('Sent today', (m.sent_today || 0) + ' / ' + (cap.cap != null ? cap.cap : '—'), m.test_mode ? 'test mode: only to your inbox' : 'live')
      + kpi('Researched today', m.researched_today || 0) + kpi('Addresses to verify', m.verification_waiting || 0)
      + kpi('Waiting for enrichment', m.enrichment_waiting || 0, 'only an address is missing') + kpi('Partner leads, 7 days', m.partner_leads_7d || 0);
    $('mnPartnersSum').textContent = 'Partner leads (' + partners.length + ')';
    $('mnPartners').innerHTML = '<tr><th>Lead</th><th>Kind</th><th>Organization</th><th class="r">Score</th><th>Address</th><th>Status</th></tr>'
      + (partners.length ? partners.map(function (x) {
        return '<tr><td><button type="button" class="lnk" data-open="' + esc(x.id) + '">' + esc(x.full_name || '(name not established)') + '</button></td>'
          + '<td><span class="pill seg">' + esc(segName(x.campaign_type)) + '</span></td><td>' + esc(x.organization || '—') + '</td>'
          + '<td class="r">' + (x.qualification_score == null ? '—' : esc(x.qualification_score)) + '</td>'
          + '<td class="mono">' + esc(x.email || '—') + (x.email ? ' <span class="pill">' + esc(x.email_status) + '</span>' : '') + '</td><td>' + esc(STATUS[x.status] || x.status) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="dim">No partner leads.</td></tr>');
  }

  function loadOverview() {
    return S.rpc('growth_outbound_overview', {}).then(function (o) {
      paintMode(o.settings); paintSettings(o.settings);
      var p = o.prospects_by_status || {};
      $('obKpis').innerHTML = kpi('Discovered today', o.discovered_today || 0)
        + kpi('Needs research', p.needs_research || 0) + kpi('Ready for review', p.ready_for_review || 0, (o.drafts_pending_review || 0) + ' draft(s) waiting')
        + kpi('Approved, not sent', o.drafts_approved_unsent || 0) + kpi('Contacted', p.contacted || 0)
        + kpi('Replied', p.replied || 0) + kpi('Suppressed', o.suppressions || 0, 'addresses and domains')
        + kpi('Sent automatically', 0, 'always zero: sending needs you');
    });
  }
  function loadProspects() {
    var st = $('obStatus').value || null, q = $('obSearch').value.trim() || null;
    return S.rpc('growth_outbound_prospects', { p_status: st, p_search: q, p_limit: 100, p_offset: 0 }).then(function (r) {
      var rows = (r && r.rows) || [];
      $('obProspects').innerHTML = '<tr><th>Prospect</th><th>Organization</th><th>Type · focus</th><th class="r">Score</th><th class="r">Fit</th><th>Confidence (id · role · email · research)</th><th>Email</th><th>Status</th><th>Updated</th></tr>'
        + (rows.length ? rows.map(function (x) {
          return '<tr><td><button type="button" class="lnk" data-open="' + esc(x.id) + '">' + esc(x.full_name || '(name not established)') + '</button>'
            + (x.is_test ? ' <span class="pill test">TEST</span>' : '') + (x.suppressed ? ' <span class="pill bad">suppressed</span>' : '')
            + (x.duplicate_of ? ' <span class="pill bad">duplicate</span>' : '')
            + (x.campaign_type && x.campaign_type !== 'customer' ? ' <span class="pill seg">' + esc(segName(x.campaign_type)) + '</span>' : '') + '</td>'
            + '<td>' + esc(x.organization || '—') + '</td><td>' + esc(x.prospect_type) + (x.sports_focus && x.sports_focus.length ? ' · ' + esc(x.sports_focus.join(', ')) : '') + '</td>'
            + '<td class="r"><b>' + (x.qualification_score == null ? '—' : esc(x.qualification_score)) + '</b></td>'
            + '<td class="r">' + (x.fit_score == null ? '—' : esc(x.fit_score)) + '</td>'
            + '<td class="conf"><b>' + num(x.identity_confidence) + '</b> · ' + num(x.role_confidence) + ' · <b>' + num(x.email_confidence) + '</b> · ' + num(x.research_confidence) + '</td>'
            + '<td class="mono">' + esc(x.email || '—') + ' <span class="pill">' + esc(x.email_status) + '</span></td>'
            + '<td>' + esc(STATUS[x.status] || x.status) + (x.gates && x.gates.length ? '<div class="sub">' + esc(clip(x.gates.join('; '), 120)) + '</div>' : '') + '</td><td>' + when(x.updated_at) + '</td></tr>';
        }).join('') : '<tr><td colspan="9">No prospects ' + (st ? 'in "' + esc(STATUS[st] || st) + '"' : 'yet') + '. Search under Discover and research, or add one below; nothing is invented to fill this table.</td></tr>');
    });
  }
  function loadSupp() {
    return S.rpc('growth_outbound_suppressions', { p_limit: 200 }).then(function (rows) {
      rows = rows || [];
      $('obSupp').innerHTML = '<tr><th>When</th><th>Scope</th><th>Address or domain</th><th>Kind</th><th>Source</th><th>Reason</th></tr>'
        + (rows.length ? rows.map(function (x) {
          return '<tr><td>' + when(x.created_at) + '</td><td>' + esc(x.scope) + '</td><td class="mono">' + esc(x.target) + '</td><td>' + esc(x.kind) + '</td><td>' + esc(x.source) + '</td><td class="wrap">' + esc(x.reason || '') + '</td></tr>';
        }).join('') : '<tr><td colspan="6">No suppressions yet.</td></tr>');
    });
  }
  function loadActivity() {
    return S.rpc('growth_outbound_activity', { p_limit: 100, p_prospect: null }).then(function (rows) {
      rows = rows || [];
      $('obActivity').innerHTML = '<tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr>'
        + (rows.length ? rows.map(function (a) {
          return '<tr><td>' + when(a.at) + '</td><td>' + esc(a.actor_kind) + '</td><td>' + esc(a.action) + '</td><td class="mono">' + esc((a.entity || '') + (a.entity_id ? ' ' + String(a.entity_id).slice(0, 8) : '')) + '</td>'
            + '<td class="mono wrap">' + esc(JSON.stringify(a.detail || {}).slice(0, 400)) + '</td></tr>';
        }).join('') : '<tr><td colspan="5">Nothing recorded yet.</td></tr>');
    });
  }

  /* ── settings ───────────────────────────────────────────────────────── */
  function paintSettings(s) {
    s = s || {};
    $('obSettings').innerHTML = FIELDS.map(function (g) {
      return '<fieldset><legend>' + esc(g[0]) + '</legend><div class="row">' + g[1].map(function (f) {
        var id = 'obf_' + f[0], v = s[f[0]];
        if (f[1] === 'bool') return '<div class="f" style="min-width:260px"><label class="chk"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> ' + esc(f[2]) + '</label>'
          /* the daily email's address is the database's: the signed-in owner's own, shown, never typed */
          + (f[0] === 'digest_enabled' ? '<div class="sub" id="obDigestTo">' + esc(!s.digest_enabled ? 'Off. When on, it goes to the address of the owner who turns it on.'
              : s.digest_to ? 'Goes to ' + s.digest_to + ' (your account\'s own address).' : 'On, but there is nobody to send it to: turn it off and on again.') + '</div>' : '')
          + '</div>';
        var type = f[1] === 'int' || f[1] === 'num' ? 'number' : f[1] === 'email' ? 'email' : 'text';
        var extra = f[1] === 'num' ? ' step="0.01" min="0" max="1"' : f[1] === 'int' ? ' step="1"' + (f[3] != null ? ' min="' + f[3] + '"' : '') + (f[4] != null ? ' max="' + f[4] + '"' : '') : '';
        return '<div class="f"><label for="' + id + '">' + esc(f[2]) + '</label><input id="' + id + '" type="' + type + '"' + extra + ' value="' + esc(v == null ? '' : v) + '"></div>';
      }).join('') + '</div></fieldset>';
    }).join('');
  }
  function readSettings() {
    var out = {};
    FIELDS.forEach(function (g) {
      g[1].forEach(function (f) {
        var el = $('obf_' + f[0]); if (!el) return;
        // a setting the database did not report is one its SQL does not have yet: never sent
        if (SETTINGS && !(f[0] in SETTINGS)) return;
        var cur = SETTINGS ? SETTINGS[f[0]] : undefined, v;
        if (f[1] === 'bool') v = el.checked;
        else if (f[1] === 'int') v = el.value === '' ? null : parseInt(el.value, 10);
        else if (f[1] === 'num') v = el.value === '' ? null : parseFloat(el.value);
        else v = el.value.trim() === '' ? null : el.value.trim();
        if (v === null && (f[1] === 'int' || f[1] === 'num')) return;
        if (String(v) !== String(cur == null ? null : cur)) out[f[0]] = v;
      });
    });
    return out;
  }
  function save() {
    var p = readSettings(), keys = Object.keys(p);
    if (!keys.length) { say('obSetMsg', '', 'Nothing changed.'); return Promise.resolve(); }
    var s = SETTINGS || {};
    /* RAISING THE CAP IS DELIBERATE: said in numbers, confirmed, and the flag
       goes to the database, which refuses the increase without it. */
    if (p.max_sends_per_day != null && p.max_sends_per_day > s.max_sends_per_day) {
      if (!root.confirm('You are about to RAISE the daily live send cap from ' + s.max_sends_per_day + ' to ' + p.max_sends_per_day + '.\n\nScaling should be deliberate. Continue?')) {
        say('obSetMsg', '', 'Not saved: the cap increase was not confirmed.'); return Promise.resolve();
      }
      p.confirm_cap_increase = true;
    }
    /* LOOSENING THE WARM-UP raises today's cap too: said, confirmed, flagged. */
    if ((p.warmup_enabled === false && s.warmup_enabled) || (p.warmup_start_per_day != null && p.warmup_start_per_day > s.warmup_start_per_day)
        || (p.warmup_step_per_week != null && p.warmup_step_per_week > s.warmup_step_per_week)) {
      if (!root.confirm('This raises how many live emails may go out a day while the sending domain warms up.\n\nA new domain that sends too much too soon lands in spam. Continue?')) {
        say('obSetMsg', '', 'Not saved: the warm-up change was not confirmed.'); return Promise.resolve();
      }
      p.confirm_cap_increase = true;
    }
    /* LEAVING TEST MODE: typed, not clicked. */
    if (p.test_mode === false && s.test_mode) {
      var typed = root.prompt('Leaving TEST MODE lets approved drafts reach REAL prospects.\n\nType LIVE to confirm.');
      if (typed !== 'LIVE') { say('obSetMsg', '', 'Not saved: still in test mode.'); return Promise.resolve(); }
      p.confirm_live = true;
    }
    /* THE MORNING RUN works on its own: said plainly before it is turned on. */
    if (p.automation_enabled === true && !s.automation_enabled) {
      if (!root.confirm('Turn on the morning run?\n\nEvery morning, in your window, it searches your saved searches, researches new candidates and writes drafts, spending your daily provider budget.\n\nIt never approves and never sends: every draft waits for you.')) {
        say('obSetMsg', '', 'Not saved: the morning run stays off.'); return Promise.resolve();
      }
    }
    $('obSave').disabled = true;
    return S.rpc('growth_outbound_settings_update', { p: p }).then(function (r) {
      if (!r || r.ok === false) { say('obSetMsg', 'err', 'Not saved: ' + ((r && (r.detail || r.reason)) || 'refused')); return; }
      var changed = Object.keys(r.changed || {});
      say('obSetMsg', 'ok', changed.length ? 'Saved: ' + changed.join(', ') + '.' : 'Saved (no change).');
      paintMode(r.settings); paintSettings(r.settings);
      return Promise.all([loadActivity(), loadAutomation(), loadResults(), loadQueue(), loadReplies()]);
    }, function (e) { fail('obSetMsg', e); }).then(function () { $('obSave').disabled = false; });
  }

  /* ── one prospect: what is known, and how sure ─────────────────────── */
  function catalog() {
    if (CATALOG) return Promise.resolve(CATALOG);
    return S.rpc('growth_outbound_fit_catalog', {}).then(function (c) { CATALOG = c || []; return CATALOG; },
      function (e) { if (e && e.kind === 'not_installed') return []; throw e; });
  }
  function openProspect(id) {
    if (!OWNER || !id) return Promise.resolve();
    $('obDetailWrap').classList.remove('hide');
    say('obDetailMsg', '', 'Loading…');
    return Promise.all([S.rpc('growth_outbound_prospect', { p_id: id }), catalog()]).then(function (r) {
      var d = r[0];
      if (!d || d.ok === false) { say('obDetailMsg', 'err', 'That prospect could not be loaded' + (d && d.reason ? ' (' + d.reason + ')' : '') + '.'); return; }
      DETAIL = d; say('obDetailMsg', '', ''); paintDetail(d);
      /* below the sticky header, whatever height it wraps to on this screen */
      var hd = document.querySelector('header'), top = $('obDetailWrap').getBoundingClientRect().top + (root.pageYOffset || 0) - (hd ? hd.offsetHeight : 0) - 8;
      if (root.scrollTo) root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, function (e) { fail('obDetailMsg', e); });
  }
  function bar(name, v, min, extra, advisory) {
    var ok = v != null && min != null && Number(v) >= Number(min);
    return '<div class="kpi ' + (v == null ? '' : ok ? 'pass' : 'short') + '"><i>' + esc(name) + '</i><b>' + (v == null ? '—' : esc(typeof v === 'number' && v <= 1 ? num(v) : v)) + '</b>'
      + '<small>' + (min != null ? (advisory ? 'aim ' : 'needs ') + esc(min) : '') + (extra ? (min != null ? ' · ' : '') + esc(extra) : '') + '</small></div>';
  }
  function paintDetail(d) {
    var p = d.prospect || {}, a = p.assessment || {}, th = a.thresholds || {}, f = a.fields || {}, gates = a.gates || [];
    var current = (d.evidence || []).filter(function (e) { return e.current; });
    var h = '<div class="row" style="align-items:center"><div><div class="pname">' + esc(p.full_name || '(name not established)')
      + (p.is_test ? ' <span class="pill test">TEST</span>' : '') + (p.suppressed ? ' <span class="pill bad">suppressed</span>' : '') + '</div>'
      + '<div class="sub">' + esc([p.job_title, p.organization].filter(Boolean).join(' · ') || 'role not established') + ' · ' + esc(p.prospect_type) + '</div></div>'
      + '<span class="sp"></span><span class="pill ' + (p.campaign_type && p.campaign_type !== 'customer' ? 'seg' : '') + '" data-seg="' + esc(p.campaign_type || 'customer') + '">' + esc(segName(p.campaign_type)) + '</span>'
      + '<span class="pill st">' + esc(STATUS[p.status] || p.status) + '</span></div>';
    if (!a.evaluated_at) h += '<div class="block">Not assessed yet: run supabase/growth_outbound.sql again so the database can evaluate this prospect. Nothing here counts as ready until it has.</div>';
    else if (p.status === 'suppressed' || p.status === 'rejected') h += '<div class="block">' + esc(STATUS[p.status]) + (p.status_reason ? ': ' + esc(p.status_reason) : '') + '</div>';
    else if (gates.length) h += '<div class="block"><b>Not ready to contact.</b> ' + gates.map(esc).join(' · ') + '</div>';
    else if (p.status === 'needs_research') h += '<div class="block">' + esc(p.status_reason || 'More research requested') + '</div>';
    else if (p.status === 'discovered') h += '<div class="block">Nothing is known about this prospect yet: add evidence below.</div>';
    else h += '<div class="okb">Every gate clears' + (p.is_test ? ' (a test prospect skips the gates)' : '') + '.</div>';
    h += '<div class="kpis" style="margin-top:10px">'
      + bar('Identity', p.identity_confidence, th.identity) + bar('Role', p.role_confidence, th.role, 'a gate only when a draft cites it', true)
      + bar('Email', p.email_confidence, th.email, p.email ? p.email_status : 'no address')
      + bar('Research', p.research_confidence, th.research, a.research && a.research.from === 'draft_claims' ? 'weakest claim a draft cites' : 'best fact found')
      + bar('Fit', p.fit_score, th.fit) + bar('Qualification', p.qualification_score, th.qualification) + '</div>';
    if (p.qualification !== undefined) h += '<h3>Qualification</h3>' + qualBlock(p.qualification, th.qualification)
      + '<div class="row" style="margin-top:8px"><div class="f" style="max-width:240px"><label for="pdSeg">Who they are to EdgeDesk</label><select id="pdSeg">' + options(SEGMENTS, p.campaign_type || 'customer') + '</select></div>'
      + '<button type="button" class="g" id="pdSegSave">Change</button></div><div class="msg" id="pdSegMsg"></div>'
      + '<div class="note">Only potential subscribers are drafted by the engine. A partner lead is kept apart; moving someone away from "Potential subscriber" cancels a subscriber email waiting for them.</div>';
    if ((p.warnings || []).length) h += '<div class="chips">' + p.warnings.map(function (w) { return '<span class="chip warn">' + esc(warnText(w)) + '</span>'; }).join('') + '</div>';
    if ((d.related || []).length) h += '<div class="note">' + d.related.map(function (r) {
      return (r.relation === 'duplicate_of' ? 'Duplicate of ' : 'Possibly the same person as ') + '<button type="button" class="lnk" data-open="' + esc(r.id) + '">'
        + esc(r.full_name || r.email || r.id) + '</button>' + (r.organization ? ' (' + esc(r.organization) + ')' : '');
    }).join(' · ') + '</div>';

    h += '<h3>What is established</h3><div class="tw"><table><tr><th>Fact</th><th>Currently</th><th class="r">Confidence</th><th class="r">Sources</th><th>Why not higher</th><th>Other claims</th></tr>'
      + ['full_name', 'organization', 'job_title', 'audience_size'].map(function (k) {
        var x = f[k];
        if (!x) return '<tr><td>' + esc(label(EV_FIELDS, k)) + '</td><td colspan="5" class="dim">no evidence</td></tr>';
        return '<tr><td>' + esc(label(EV_FIELDS, k)) + '</td><td class="wrap">' + esc(x.claim) + '</td><td class="r conf">' + num(x.confidence) + '</td><td class="r">' + esc(x.sources) + '</td>'
          + '<td class="wrap">' + esc((x.reasons || []).map(function (r) { return REASONS[r] || r; }).join('; ')) + '</td>'
          + '<td class="wrap">' + esc((x.alternatives || []).map(function (o) { return o.claim + ' (' + num(o.confidence) + ')'; }).join('; ')) + '</td></tr>';
      }).join('')
      + '<tr><td>Email</td><td class="mono">' + esc(p.email || '—') + '</td><td class="r conf">' + num(p.email_confidence) + '</td><td class="r">' + esc(a.email && a.email.kinds ? a.email.kinds.length : 0) + '</td>'
      + '<td class="wrap">' + esc(p.email ? p.email_status + (p.email_status === 'verified' ? '' : ' — verified means you, or a verification provider, checked it') : '') + '</td><td></td></tr></table></div>';

    var fit = (a.fit && a.fit.factors) || [];
    h += '<h3>Fit</h3><div class="tw"><table><tr><th>Reason</th><th class="r">Points</th><th>Rests on evidence</th><th class="r">Confidence</th></tr>'
      + (fit.length ? fit.map(function (x) {
        return '<tr><td>' + esc(x.label) + '</td><td class="r">' + esc((x.points > 0 ? '+' : '') + x.points) + '</td><td class="mono">' + esc((x.evidence || []).map(function (i) { return '#' + i; }).join(' ') || '— (a penalty needs none)') + '</td><td class="r conf">' + num(x.confidence) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="dim">No fit reason counts yet.</td></tr>') + '</table></div>';

    h += '<h3>Evidence — currently and previously</h3><div class="tw"><table><tr><th>#</th><th>Fact</th><th>Claim</th><th>Source</th><th>The words on the page</th><th>Published</th><th>Seen</th><th class="r">Now</th><th>State</th></tr>'
      + ((d.evidence || []).length ? d.evidence.map(function (e) {
        return '<tr class="' + (e.current ? '' : 'old') + '"><td class="mono">' + esc(e.id) + '</td><td>' + esc(label(EV_FIELDS, e.field_name)) + '</td><td class="wrap">' + esc(clip(e.claim, 200)) + '</td>'
          + '<td>' + esc(label(EV_KINDS, e.source_kind)) + '<div class="sub">' + link(e.source_url, hostOf(e.source_url)) + '</div></td>'
          + '<td class="wrap quote">' + esc(clip(e.source_excerpt, 280)) + '</td><td>' + (e.source_published_at ? esc(String(e.source_published_at).slice(0, 10)) : '—') + '</td><td>' + esc(String(e.observed_at || '').slice(0, 10)) + '</td>'
          + '<td class="r conf">' + (e.current ? num(e.claim_confidence) : '—') + '</td>'
          + '<td class="wrap">' + (e.current ? 'current <button type="button" class="g sm" data-supersede="' + esc(e.id) + '">Supersede</button>'
            : 'previously — superseded ' + esc(String(e.superseded_at || '').slice(0, 10)) + (e.superseded_reason ? ': ' + esc(clip(e.superseded_reason, 160)) : '')) + '</td></tr>';
      }).join('') : '<tr><td colspan="9" class="dim">No evidence yet.</td></tr>') + '</table></div>';

    h += '<h3>Add evidence</h3><div class="row">'
      + '<div class="f" style="max-width:170px"><label for="evField">Fact</label><select id="evField">' + options(EV_FIELDS, 'project') + '</select></div>'
      + '<div class="f"><label for="evClaim">Claim</label><input id="evClaim" maxlength="500"></div>'
      + '<div class="f"><label for="evUrl">Source page (https://…)</label><input id="evUrl" maxlength="2000" class="mono"></div>'
      + '<div class="f" style="max-width:210px"><label for="evKind">Kind of source</label><select id="evKind">' + options(EV_KINDS.slice(0, 7), 'own_site') + '</select></div></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label for="evQuote">The words on the page that say it</label><input id="evQuote" maxlength="2000"></div>'
      + '<div class="f" style="max-width:170px"><label for="evDate">Published (optional)</label><input id="evDate" type="date"></div>'
      + '<button type="button" id="evAdd">Add evidence</button></div><div class="msg" id="evMsg"></div>'
      + '<div class="note">Confidence is the database\'s, not yours: one site counts once however often it repeats a claim, a rival claim halves it, and old roles and old content weigh less.</div>';

    h += '<h3>Fit reasons</h3><div class="row">'
      + '<div class="f"><label for="fitCode">Reason</label><select id="fitCode">' + (CATALOG || []).map(function (c) {
        return '<option value="' + esc(c.code) + '">' + esc(c.label + ' (' + (c.points > 0 ? '+' : '') + c.points + ')') + '</option>';
      }).join('') + '</select></div>'
      + '<div class="f"><label for="fitEv">Rests on (current evidence)</label><select id="fitEv"><option value="">— none (only a penalty may) —</option>' + current.filter(function (e) { return e.field_name !== 'email'; }).map(function (e) {
        return '<option value="' + esc(e.id) + '">#' + esc(e.id) + ' ' + esc(label(EV_FIELDS, e.field_name)) + ': ' + esc(clip(e.claim, 60)) + '</option>';
      }).join('') + '</select></div><button type="button" class="g" id="fitAdd">Add reason</button>'
      + '<button type="button" class="g" id="fitDrop">Remove reason</button></div><div class="msg" id="fitMsg"></div>';

    h += '<h3>Who this is</h3><div class="tw"><table><tr><th>Key</th><th>Value</th><th>Strength</th><th>First seen</th><th>State</th><th></th></tr>'
      + ((d.identifiers || []).length ? d.identifiers.map(function (i) {
        return '<tr class="' + (i.released_at ? 'old' : '') + '"><td>' + esc(i.kind) + '</td><td class="mono wrap">' + esc(clip(i.value, 120)) + '</td><td>' + esc(i.strength) + '</td><td>' + esc(String(i.first_seen || '').slice(0, 10)) + '</td>'
          + '<td class="wrap">' + (i.released_at ? 'released' + (i.released_reason ? ': ' + esc(clip(i.released_reason, 120)) : '') : 'current') + '</td>'
          + '<td>' + (i.released_at || i.kind === 'name_org' ? '' : '<button type="button" class="g sm" data-release="' + esc(i.id) + '">Not theirs</button>') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="dim">No identifiers.</td></tr>') + '</table></div>'
      + '<div class="note">An email address or a profile names one prospect. "Not theirs" releases it from this person (kept on the record) so it can belong to someone else.</div>';

    if (d.replies !== undefined) h += '<h3>Replies</h3><div class="tw"><table id="pdReplies"><tr><th>When</th><th>What</th><th>Subject</th></tr>'
      + (d.replies.length ? d.replies.map(function (x) {
        return '<tr><td>' + when(x.received_at) + '</td><td>' + esc(REPLY_KIND[x.kind] || x.kind) + (x.sequence_number > 1 ? ' <span class="sub">to step ' + esc(x.sequence_number) + '</span>' : '') + '</td>'
          + '<td class="wrap">' + esc(clip(x.subject || '', 150)) + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="dim">No reply received from Resend. (A reply you read yourself: "They replied".)</td></tr>') + '</table></div>';
    h += '<h3>Results</h3><div class="tw"><table id="pdResults"><tr><th>When</th><th>What</th><th>Matched by</th></tr>'
      + ((d.conversions || []).length ? d.conversions.map(function (x) {
        return '<tr><td>' + when(x.occurred_at) + '</td><td>' + esc(STAGE[x.stage] || x.stage) + '</td><td>' + esc(MATCHED[x.matched_by] || x.matched_by) + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="dim">Nothing yet: no visit or account has been matched to an email to them.</td></tr>') + '</table></div>';
    h += '<h3>Drafts</h3><div class="tw"><table><tr><th>Step</th><th>Subject</th><th>By</th><th>Status</th><th class="r">Claims cited</th></tr>'
      + ((d.drafts || []).length ? d.drafts.map(function (x) {
        return '<tr><td>' + esc(x.sequence_number) + '</td><td class="wrap">' + esc(clip(x.subject, 150)) + '</td><td>' + esc(writer(x)) + '</td><td>' + esc(x.status) + '</td><td class="r">' + esc((x.claims || []).length) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="dim">No drafts yet.</td></tr>') + '</table></div>';

    var citeable = current.filter(function (e) { return e.field_name !== 'email'; });
    h += '<h3>Write a draft</h3><div class="row">'
      + '<div class="f" style="max-width:110px"><label for="wdSeq">Step</label><select id="wdSeq"><option value="1">1 · first</option><option value="2">2 · follow-up</option><option value="3">3 · final</option></select></div>'
      + '<div class="f"><label for="wdSubject">Subject</label><input id="wdSubject" maxlength="150"></div></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label for="wdBody">The email (the footer with the postal address and opt-out is added for you)</label><textarea id="wdBody" rows="7" maxlength="5000"></textarea></div></div>'
      + [1, 2, 3].map(function (i) {
        return '<div class="row" style="margin-top:8px"><div class="f"><label for="wdEv' + i + '">' + (i === 1 ? 'What it says about them rests on' : 'And on') + '</label><select id="wdEv' + i + '"><option value="">—</option>'
          + citeable.map(function (e) { return '<option value="' + esc(e.id) + '">#' + esc(e.id) + ' ' + esc(label(EV_FIELDS, e.field_name)) + ': ' + esc(clip(e.claim, 60)) + '</option>'; }).join('')
          + '</select></div><div class="f"><label for="wdTxt' + i + '">…in the email\'s exact words</label><input id="wdTxt' + i + '" maxlength="300"></div></div>';
      }).join('')
      + '<div class="row" style="margin-top:8px"><span class="sp"></span>'
      + (p.status === 'suppressed' || p.status === 'rejected' ? '' : '<button type="button" class="g" id="wdEngine" title="The drafting engine writes this step from what can be cited; it waits in the review queue for you">Let the engine write it</button>')
      + '<button type="button" id="wdCreate">Put it in the review queue</button></div><div class="msg" id="wdMsg"></div>'
      + '<div class="note">Each thing the email says about them must be in its words and rest on current evidence; a real prospect\'s email says at least one. No promised winnings or locks, $49.99/month, a 7-day free trial, links to edgedesksports.com only.'
      + ' The engine is held to more: only facts sure enough on their own, nothing specific it cannot cite, and their first name only when the evidence establishes it.</div>';

    h += '<div class="row" style="margin-top:12px"><span class="sp"></span>'
      + (p.status === 'suppressed' || p.status === 'rejected' ? '' : '<button type="button" class="g" id="pdResearchAgain" title="Read their pages again and record what can be quoted">Research again</button>')
      + '<button type="button" class="g" id="pdEval">Re-evaluate</button>'
      + '<button type="button" class="g" id="pdResearch">Needs more research</button><button type="button" class="g" id="pdReject">Reject</button></div>';
    if (p.status === 'contacted' || p.status === 'replied') {
      h += '<div class="row" style="margin-top:8px"><span class="sp"></span>'
        + (p.status === 'contacted' ? '<button type="button" class="g" id="pdReplied">They replied</button>' : '')
        + (p.suppressed ? '' : '<button type="button" class="g" id="pdReplyStop">They replied: stop emailing them</button>') + '</div>'
        + '<div class="note">A reply reaches davis@ and is read by a person. Marking it stops every follow-up still waiting; "stop emailing them" also suppresses the address for good.</div>';
    }
    $('obDetail').innerHTML = h;
  }
  function refreshAfter(id) {
    return Promise.all([openProspect(id), loadQueue(), loadProspects(), loadOverview(), loadActivity()]).catch(function (e) { fail('obDetailMsg', e); });
  }
  function writeDraft() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, claims = [];
    [1, 2, 3].forEach(function (i) {
      var ev = $('wdEv' + i).value, t = $('wdTxt' + i).value.trim();
      if (ev || t) claims.push({ text: t, evidence_id: Number(ev) || null });
    });
    var p = { sequence_number: Number($('wdSeq').value), subject: $('wdSubject').value.trim(), body_text: $('wdBody').value.trim(), claims: claims };
    if (!p.subject || !p.body_text) { say('wdMsg', 'err', 'A subject and the email are both needed.'); return Promise.resolve(); }
    $('wdCreate').disabled = true;
    return S.rpc('growth_outbound_draft_create', { p_prospect: id, p: p }).then(function (r) {
      $('wdCreate').disabled = false;
      if (!r || r.ok === false) {
        say('wdMsg', 'err', 'Not queued: ' + (r && r.problems ? r.problems.join('; ') : why(r)));
        return;
      }
      return refreshAfter(id).then(function () { say('rqMsg', 'ok', 'Your draft is in the review queue.'); });
    }, function (e) { $('wdCreate').disabled = false; fail('wdMsg', e); });
  }
  function why(r) { return (r && (r.detail || r.reason)) || 'refused'; }
  function addEvidence() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, url = $('evUrl').value.trim(), claim = $('evClaim').value.trim();
    if (!claim || !url) { say('evMsg', 'err', 'A claim and the page it is on are both needed.'); return Promise.resolve(); }
    var item = { field_name: $('evField').value, claim: claim, source_url: url, source_kind: $('evKind').value,
      source_excerpt: $('evQuote').value.trim() || null };
    if ($('evDate').value) item.source_published_at = $('evDate').value + 'T00:00:00Z';
    $('evAdd').disabled = true;
    return S.rpc('growth_outbound_evidence_add', { p_prospect: id, p: { evidence: [item] } }).then(function (r) {
      if (!r || r.ok === false) { say('evMsg', 'err', 'Not added: ' + why(r)); $('evAdd').disabled = false; return; }
      return refreshAfter(id);
    }, function (e) { $('evAdd').disabled = false; fail('evMsg', e); });
  }
  function fitChange(remove) {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, code = $('fitCode').value, ev = $('fitEv').value;
    var f = { code: code };
    if (remove) f.remove = true; else if (ev) f.evidence = [Number(ev)];
    return S.rpc('growth_outbound_evidence_add', { p_prospect: id, p: { fit_factors: [f] } }).then(function (r) {
      if (!r || r.ok === false) { say('fitMsg', 'err', 'Not changed: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('fitMsg', e); });
  }
  function supersede(evId) {
    var reason = root.prompt('Supersede evidence #' + evId + '?\n\nIt stays on the record as "previously", and stops counting. Why?');
    if (reason == null || !String(reason).trim()) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_evidence_supersede', { p_evidence_id: Number(evId), p_reason: String(reason).trim() }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not superseded: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function release(keyId) {
    var reason = root.prompt('This address or profile does not belong to this person?\n\nIt is released from them (kept on the record) and cleared from the prospect. Why?');
    if (reason == null || !String(reason).trim()) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_identifier_release', { p_identifier_id: Number(keyId), p_reason: String(reason).trim() }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not released: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function setStatus(st) {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id;
    var reason = root.prompt(st === 'rejected' ? 'Reject this prospect? Any draft still waiting is cancelled. Reason:' : 'What needs more research? (Any draft still waiting is cancelled.)');
    if (reason == null) return Promise.resolve();
    return S.rpc('growth_outbound_prospect_set_status', { p_id: id, p_status: st, p_reason: String(reason).trim() || null }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', 'Not changed: ' + why(r)); return; }
      return refreshAfter(id);
    }, function (e) { fail('obDetailMsg', e); });
  }
  function replied(stop) {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id;
    var note = root.prompt(stop ? 'They asked to stop. Every follow-up is cancelled and ' + (DETAIL.prospect.email || 'the address') + ' is suppressed for good. A note (optional):'
                                : 'They replied. Every follow-up still waiting is cancelled. A note (optional):');
    if (note == null) return Promise.resolve();
    return S.rpc('growth_outbound_prospect_replied', { p_id: id, p_note: String(note).trim() || null, p_stop: !!stop }).then(function (r) {
      if (!r || r.ok === false) { say('obDetailMsg', 'err', r && r.reason === 'not_contacted' ? 'Only a prospect who was emailed can have replied.' : 'Not changed: ' + why(r)); return; }
      var done = 'Marked replied' + (r.drafts_cancelled ? '; ' + r.drafts_cancelled + ' follow-up(s) cancelled' : '') + (r.suppressed ? '; the address is suppressed' : '') + '.';
      return refreshAfter(id).then(loadSupp).then(function () { say('obDetailMsg', 'ok', done); });
    }, function (e) {
      if (e && e.kind === 'not_installed') { say('obDetailMsg', 'err', 'Replies arrive with the Phase 6 SQL: run supabase/growth_outbound.sql again.'); return; }
      fail('obDetailMsg', e);
    });
  }
  function reevaluate() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id;
    return S.rpc('growth_outbound_prospect_evaluate', { p_id: id }).then(function () { return refreshAfter(id); }, function (e) { fail('obDetailMsg', e); });
  }

  /* ── discover and research (Phase 7) ─────────────────────────────── */
  var RESEARCH_WHY = {
    search_not_configured: 'Discovery needs a Brave Search API key: set BRAVE_SEARCH_API_KEY in Supabase → Edge Functions → Secrets.',
    no_queries: 'Type a search, or save some searches below.',
    search_failed: 'The search provider refused or did not answer.',
    too_many_running: 'Three research runs are already going; wait for one to finish.',
    queue_empty: 'No new candidates are waiting.',
    nothing_read: 'none of their pages could be read',
    nothing_verifiable: 'nothing on their pages could be quoted, so nothing was recorded',
    no_page: 'there is no website or profile the engine can read (X and LinkedIn do not let robots in)',
    suppressed: 'that address or domain asked not to be contacted',
    not_installed: 'Research arrives with the Phase 7 SQL: run supabase/growth_outbound.sql again.',
    no_identifier: 'nothing found identifies them again (no address, profile or own site), so no prospect was made',
    identity_conflict: 'what was found belongs to two different prospects; open them to sort it out',
    not_found: 'it is no longer there'
  };
  function researchWhy(r) { return RESEARCH_WHY[r && (r.reason || r.code)] || (r && (r.detail || r.reason)) || 'it could not be done'; }
  var BUDGET_KEYS = ['search', 'fetch', 'llm', 'email_finder', 'email_verifier', 'enrichment'];
  function used(b) { return b ? esc(b.used) + ' / ' + esc(b.cap) : '—'; }
  function provChip(on, what, name, env, b, b2) {
    return on ? '<span class="chip ok" data-prov="' + esc(what) + '">' + esc(what) + ': ' + esc(name) + ' · ' + used(b) + (b2 ? ' · checks ' + used(b2) : '') + ' today</span>'
              : '<span class="chip off" data-prov="' + esc(what) + '">' + esc(what) + ': not set up (' + esc(env) + ')</span>';
  }
  function paintResearch(prov, ov) {
    ov = ov || {};
    var b = ov.budget || {};
    var det = prov && prov.detail ? prov.detail : null;
    var named = function (role) {
      var on = det ? PROVIDERS.filter(function (x) { return x[2].indexOf(role) >= 0 && det[x[0]] && det[x[0]].on; }).map(function (x) { return x[1]; }) : [];
      return on.length ? on.join(' + ') : null;
    };
    $('dvProviders').innerHTML = prov
      ? provChip(prov.search, 'Search', named('search') || 'Brave', 'BRAVE_SEARCH_API_KEY', b.search) + provChip(prov.llm, 'Reading', 'Claude', 'ANTHROPIC_API_KEY', b.llm)
        + provChip(prov.email, 'Email', named('email') || 'Hunter', 'HUNTER_API_KEY', b.email_finder, b.email_verifier)
        + (det && det.clay && det.clay.on ? '<span class="chip ok" data-prov="Enrichment">Enrichment: Clay · ' + used(b.enrichment) + ' today</span>' : '')
        + '<span class="chip">pages read today ' + used(b.fetch) + '</span>'
      : '';
    /* each provider: its key set or not, and the owner's switch */
    var sw = ov.providers || {};
    $('dvSwitches').innerHTML = PROVIDERS.map(function (x) {
      var d = det ? det[x[0]] : null, paid = x[0] === 'apollo' || x[0] === 'apollo_search' || x[0] === 'clay';
      var checked = paid ? sw[x[0]] === true : sw[x[0]] !== false;
      return '<div class="f" style="min-width:230px"><label class="chk"><input type="checkbox" data-sw="' + esc(x[0]) + '"' + (checked ? ' checked' : '') + '> ' + esc(x[1])
        + ' <span class="sub">(' + esc(x[2]) + ')</span></label><div class="sub" data-swkey="' + esc(x[0]) + '">'
        + (d ? (d.configured ? (d.on ? 'on' : 'key set, switched off') : 'not set up: ' + esc(d.key)) : (paid ? 'off until switched on' : '')) + '</div></div>';
    }).join('');
    $('dvWaiting').textContent = (ov.verification_waiting || 0) + ' address(es) waiting for a verifier · ' + (ov.enrichment_waiting || 0) + ' prospect(s) waiting for enrichment (only an address is missing)'
      + (ov.daily_qualified_target ? ' · daily target: ' + ov.daily_qualified_target + ' qualified' : '');
    if (document.activeElement !== $('dvQueries')) $('dvQueries').value = (ov.queries || []).join('\n');
    BUDGET_KEYS.forEach(function (k) { var el = $('dvB_' + k); if (el && document.activeElement !== el) el.value = b[k] ? b[k].cap : ''; });
    var counts = ov.candidates || {};
    Array.prototype.forEach.call($('dvSeg').querySelectorAll('button'), function (x) {
      var k = x.getAttribute('data-c'), base = x.getAttribute('data-label') || x.textContent.replace(/ \(\d+\)$/, '');
      x.setAttribute('data-label', base);
      x.textContent = base + (counts[k] ? ' (' + counts[k] + ')' : '');
      x.classList.toggle('on', k === CSTATUS);
    });
    var runs = ov.runs || [];
    $('dvRuns').innerHTML = '<tr><th>When</th><th>What</th><th>Status</th><th>Found / read</th><th>Spent</th><th>Note</th></tr>'
      + (runs.length ? runs.map(function (r) {
        var c = r.counts || {}, sp = c.spent || {};
        var did = r.kind === 'discover' ? (c.new != null ? c.new + ' new of ' + (c.results || 0) : '')
          : r.kind === 'draft' ? (c.drafted != null ? c.drafted + ' drafted' + (c.not_drafted ? ', ' + c.not_drafted + ' not' : '') : '')
          : (c.pages != null ? c.pages + ' page(s), ' + (c.evidence || 0) + ' fact(s)' + (c.dropped ? ', ' + c.dropped + ' dropped' : '') : '');
        return '<tr><td>' + when(r.started_at) + '</td><td>' + esc(r.kind === 'discover' ? 'search' : r.kind === 'draft' ? 'drafting' : 'research') + (r.started_by === 'schedule' ? ' <span class="sub">(morning run)</span>' : '') + (r.input && r.input.query ? ' <span class="sub">' + esc(clip(r.input.query, 60)) + '</span>' : '') + '</td>'
          + '<td><span class="pill ' + (r.status === 'failed' ? 'bad' : r.status === 'running' ? 'test' : 'on') + '">' + esc(r.status) + '</span></td><td>' + esc(did) + '</td>'
          + '<td>' + esc(Object.keys(sp).map(function (k) { return k + ' ' + sp[k]; }).join(', ')) + '</td><td class="wrap">' + esc(clip(r.error || '', 160)) + '</td></tr>';
      }).join('') : '<tr><td colspan="6">No research has run yet.</td></tr>');
  }
  function loadResearch() {
    if (!OWNER) return Promise.resolve();
    return S.invoke('growth_outbound_research', { action: 'status' }).then(function (r) { paintResearch(r.providers, r.overview); }, function (e) {
      // the function is not deployed (or failing): the database can still show the queue
      return S.rpc('growth_outbound_research_overview', {}).then(function (ov) {
        paintResearch(null, ov);
        $('dvProviders').innerHTML = '<span class="chip off">The research function is not deployed: deploy supabase/functions/growth_outbound_research (docs/growth-outbound.md, Phase 7)</span>';
      }, function (e2) {
        if (e2 && e2.kind === 'not_installed') { $('dvCands').innerHTML = '<tr><td>Discovery arrives with the Phase 7 SQL: run supabase/growth_outbound.sql again.</td></tr>'; return 'none'; }
        throw e2;
      });
    }).then(function (x) { if (x !== 'none') return loadCandidates(); });
  }
  function loadCandidates() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_candidates', { p_status: CSTATUS, p_limit: 50 }).then(function (rows) {
      rows = rows || [];
      $('dvCands').innerHTML = '<tr><th>Found</th><th>Page</th><th>Search</th><th class="r">Seen</th><th>Status</th><th></th></tr>'
        + (rows.length ? rows.map(function (c) {
          var act = '';
          if (c.status !== 'suppressed' && c.status !== 'researched' && c.status !== 'duplicate') act += '<button type="button" class="g sm" data-research="' + esc(c.id) + '">Research</button> ';
          if (c.status === 'new') act += '<button type="button" class="g sm" data-cdismiss="' + esc(c.id) + '">Dismiss</button>';
          if (c.status === 'dismissed' || c.status === 'not_a_fit' || c.status === 'failed') act += '<button type="button" class="g sm" data-crequeue="' + esc(c.id) + '">Put back</button>';
          return '<tr><td>' + when(c.last_seen_at) + '</td><td class="wrap">' + link(c.url, clip(c.title || c.url, 90)) + (c.snippet ? '<div class="sub">' + esc(clip(c.snippet, 200)) + '</div>' : '') + '<div class="sub mono">' + esc(clip(c.url, 90)) + '</div></td>'
            + '<td class="wrap">' + esc(clip(c.query || '', 80)) + '</td><td class="r">' + esc(c.times_seen) + '</td>'
            + '<td><span class="pill ' + (c.status === 'failed' || c.status === 'suppressed' ? 'bad' : c.status === 'new' ? 'test' : 'on') + '">' + esc(c.status.replace(/_/g, ' ')) + '</span>'
            + (c.status_reason ? '<div class="sub">' + esc(clip(c.status_reason, 160)) + '</div>' : '')
            + (c.prospect_id ? '<div><button type="button" class="lnk" data-open="' + esc(c.prospect_id) + '">' + esc(c.full_name || 'open prospect') + '</button></div>' : '') + '</td>'
            + '<td>' + act + '</td></tr>';
        }).join('') : '<tr><td colspan="6">' + (CSTATUS === 'new' ? 'No new candidates. Search the web above.' : 'Nothing here.') + '</td></tr>');
      setBusy(BUSY);
    }, function (e) {
      if (e && e.kind === 'not_installed') { $('dvCands').innerHTML = '<tr><td>Discovery arrives with the Phase 7 SQL: run supabase/growth_outbound.sql again.</td></tr>'; return; }
      throw e;
    });
  }
  function setBusy(on) {
    BUSY = !!on;
    ['dvSearch', 'dvSaved', 'dvNext', 'dvVerify', 'dvClayPush'].forEach(function (id) { if ($(id)) $(id).disabled = BUSY; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-research],#pdResearchAgain'), function (x) { x.disabled = BUSY; });
  }
  function researchFail(id, e) {
    if (e && e.kind === 'not_installed') { say(id, 'err', 'The research function is not deployed yet: deploy supabase/functions/growth_outbound_research (docs/growth-outbound.md, Phase 7).'); return; }
    if (e && e.code && RESEARCH_WHY[e.code]) { say(id, 'err', RESEARCH_WHY[e.code]); return; }
    fail(id, e);
  }
  function discover(saved) {
    if (BUSY) return Promise.resolve();
    var q = saved ? '' : $('dvQuery').value.replace(/\s+/g, ' ').trim();
    if (!saved && q.length < 3) { say('dvMsg', 'err', 'Type a search of at least 3 characters.'); return Promise.resolve(); }
    setBusy(true);
    say('dvMsg', '', saved ? 'Running the saved searches…' : 'Searching…');
    return S.invoke('growth_outbound_research', saved ? { action: 'discover' } : { action: 'discover', query: q }, { timeoutMs: 120000 }).then(function (r) {
      if (!r || r.ok === false) { say('dvMsg', 'err', 'Nothing found: ' + researchWhy(r) + (r && r.per_query ? ' ' + r.per_query.filter(function (p) { return p.error; }).map(function (p) { return p.error; }).join('; ') : '')); }
      else {
        say('dvMsg', 'ok', 'Searched ' + r.queries + (r.queries === 1 ? ' time' : ' times') + ': ' + r.results + ' results, ' + r.new + ' new candidate' + (r.new === 1 ? '' : 's')
          + (r.seen_again ? ', ' + r.seen_again + ' seen before' : '') + (r.duplicates ? ', ' + r.duplicates + ' already prospects' : '')
          + (r.suppressed ? ', ' + r.suppressed + ' asked not to be contacted' : '') + '.' + (r.notes && r.notes.length ? ' ' + r.notes.join('; ') + '.' : ''));
        CSTATUS = 'new';
      }
    }, function (e) { researchFail('dvMsg', e); }).then(function () { setBusy(false); return loadResearch(); });
  }
  function research(t) {
    if (BUSY) return Promise.resolve();
    var msg = t.prospect_id ? 'obDetailMsg' : 'dvMsg';
    setBusy(true);
    say(msg, '', 'Reading their pages and checking every quote — this can take a minute…');
    var said = null;
    return S.invoke('growth_outbound_research', Object.assign({ action: 'research' }, t), { timeoutMs: 150000 }).then(function (r) {
      if (r && r.ok && r.outcome === 'not_a_fit') say(msg, '', 'Not a fit: ' + (r.reason || 'not relevant') + '. Nothing was recorded about them.');
      else if (r && r.ok) {
        say(msg, 'ok', (r.outcome === 'created' ? 'New prospect' : 'Added to the prospect') + ': ' + r.evidence + ' fact' + (r.evidence === 1 ? '' : 's') + ' recorded from ' + r.pages + ' page' + (r.pages === 1 ? '' : 's')
          + (r.dropped && r.dropped.length ? '; ' + r.dropped.length + ' dropped because they could not be quoted' : '')
          + (r.email ? '; address ' + r.email.address + ' (' + r.email.from + (r.email.verdict ? ', verifier: ' + r.email.verdict : '') + ')' : '; no business address found')
          + (r.urls_left_out && r.urls_left_out.length ? '; left out, as somebody else\'s: ' + r.urls_left_out.join(', ') : '')
          + '. Status: ' + (STATUS[r.status] || r.status) + '.' + (r.llm ? ' (' + r.llm + ')' : '') + (r.notes && r.notes.length ? ' ' + r.notes.join('; ') + '.' : ''));
        if (r.prospect_id && !t.prospect_id) { var b = document.createElement('button'); b.type = 'button'; b.className = 'lnk'; b.setAttribute('data-open', r.prospect_id); b.textContent = ' Open them'; $(msg).appendChild(b); }
      } else say(msg, 'err', (r && r.reason === 'queue_empty') ? RESEARCH_WHY.queue_empty : 'Nothing recorded: ' + researchWhy(r) + '.');
      said = { cls: $(msg).className, text: $(msg).textContent };
    }, function (e) { researchFail(msg, e); said = { cls: $(msg).className, text: $(msg).textContent }; }).then(function () {
      setBusy(false);
      if (!t.prospect_id) return Promise.all([loadResearch(), loadProspects(), loadOverview(), loadActivity()]);
      // the prospect is shown again with what was found; the answer stays above it
      return Promise.all([loadResearch(), loadProspects(), loadOverview(), loadActivity(), openProspect(t.prospect_id)]).then(function () {
        setBusy(false);
        if (said) { $(msg).className = said.cls; $(msg).textContent = said.text; }
      });
    });
  }
  function candidateSet(id, st) {
    var reason = st === 'dismissed' ? root.prompt('Dismiss this candidate? (It stays on the record; you can put it back.) Reason, optional:') : null;
    if (st === 'dismissed' && reason == null) return Promise.resolve();
    return S.rpc('growth_outbound_candidate_set', { p_id: Number(id), p_status: st, p_reason: reason ? String(reason).trim() || null : null }).then(function (r) {
      if (!r || r.ok === false) { say('dvMsg', 'err', 'Not changed: ' + researchWhy(r)); return; }
      return loadResearch();
    }, function (e) { fail('dvMsg', e); });
  }
  function saveDiscovery() {
    var qs = $('dvQueries').value.split('\n').map(function (x) { return x.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var budget = {};
    BUDGET_KEYS.forEach(function (k) { var v = String($('dvB_' + k).value || '').trim(); if (v !== '') budget[k] = /^\d+$/.test(v) ? Number(v) : v; });
    var switches = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-sw]'), function (el) { switches[el.getAttribute('data-sw')] = !!el.checked; });
    var cfg = Object.assign({}, (SETTINGS && SETTINGS.discovery_config) || {}, { queries: qs, budget: budget });
    // the switches (and the enrichment budget) only to a database that has them
    if (Object.keys(switches).length && p12()) cfg.providers = switches;
    if (!p12()) delete budget.enrichment;
    return S.rpc('growth_outbound_settings_update', { p: { discovery_config: cfg } }).then(function (r) {
      if (!r || r.ok === false) { say('dvMsg', 'err', 'Not saved: ' + ((r && (r.detail || r.reason)) || 'refused') + '.'); return; }
      SETTINGS = r.settings || SETTINGS;
      say('dvMsg', 'ok', 'Saved: ' + qs.length + ' search' + (qs.length === 1 ? '' : 'es') + ', the daily budget and the providers.');
      return loadResearch();
    }, function (e) { fail('dvMsg', e); });
  }

  /* ── addresses and enrichment (Phase 12) ─────────────────────────────── */
  var ENRICH_WHY = {
    verifier_not_configured: 'No verifier is set up: HUNTER_API_KEY in Supabase → Edge Functions → Secrets, with Hunter switched on.',
    enrichment_not_configured: 'Clay is not set up: CLAY_WEBHOOK_URL (your Clay table\'s webhook) in the Edge Function secrets, and Clay switched on above.',
    too_many_running: 'Three research runs are already going; wait for one to finish.'
  };
  function enrichWhy(r) { return ENRICH_WHY[r && (r.reason || r.code)] || (r && (r.detail || r.reason)) || 'it could not be done'; }
  function enrichFail(e) {
    if (e && e.kind === 'not_installed') { say('dvEnrichMsg', 'err', 'The research function is not deployed yet: deploy supabase/functions/growth_outbound_research.'); return; }
    if (e && e.code && ENRICH_WHY[e.code]) { say('dvEnrichMsg', 'err', ENRICH_WHY[e.code]); return; }
    fail('dvEnrichMsg', e);
  }
  function verifyWaiting() {
    if (BUSY) return Promise.resolve();
    setBusy(true); say('dvEnrichMsg', '', 'Asking the verifier…');
    return S.invoke('growth_outbound_research', { action: 'verify', limit: 10 }, { timeoutMs: 120000 }).then(function (r) {
      if (!r || r.ok === false) { say('dvEnrichMsg', 'err', 'Nothing verified: ' + enrichWhy(r) + '.'); return; }
      say('dvEnrichMsg', 'ok', r.asked ? 'Asked about ' + r.asked + ' address' + (r.asked === 1 ? '' : 'es') + ': ' + r.valid + ' verified.' : 'No address is waiting for a verifier.');
    }, enrichFail).then(function () { setBusy(false); return Promise.all([loadResearch(), loadMorning(), loadProspects()]); });
  }
  function clayPush() {
    if (BUSY) return Promise.resolve();
    if (!root.confirm('Send the prospects waiting for enrichment to your Clay table?\n\nClay is told who they are and where they are (name, organization, site, profiles) and nothing else. Each costs Clay credits; each prospect is sent at most once in 14 days.')) return Promise.resolve();
    setBusy(true); say('dvEnrichMsg', '', 'Sending to Clay…');
    return S.invoke('growth_outbound_research', { action: 'enrich', limit: 10 }, { timeoutMs: 120000 }).then(function (r) {
      if (!r || r.ok === false) { say('dvEnrichMsg', 'err', 'Not sent to Clay: ' + enrichWhy(r) + (r && r.failed && r.failed.length ? ' (' + r.failed[0].why + ')' : '') + '.'); return; }
      say('dvEnrichMsg', 'ok', r.pushed ? 'Sent ' + r.pushed + ' to Clay. When Clay has enriched them, export the table as CSV and import it here.' : 'Nobody is waiting for enrichment.');
    }, enrichFail).then(function () { setBusy(false); return loadResearch(); });
  }
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var EXPORT_COLS = ['edgedesk_ref', 'full_name', 'first_name', 'last_name', 'organization', 'job_title', 'domain', 'website_url', 'linkedin_url', 'x_url', 'newsletter_url'];
  function clayExport() {
    return S.rpc('growth_outbound_enrichment_export', { p_limit: 100 }).then(function (r) {
      var rows = (r && r.rows) || [];
      if (!rows.length) { say('dvEnrichMsg', '', 'Nobody is waiting for enrichment.'); return; }
      var csv = EXPORT_COLS.join(',') + '\n' + rows.map(function (x) { return EXPORT_COLS.map(function (k) { return csvCell(x[k]); }).join(','); }).join('\n') + '\n';
      if (typeof Blob === 'function' && root.URL && root.URL.createObjectURL) {
        var a = document.createElement('a');
        a.href = root.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'edgedesk-for-clay-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
      }
      say('dvEnrichMsg', 'ok', 'Exported ' + rows.length + ' prospect' + (rows.length === 1 ? '' : 's') + ' for Clay (marked as sent: not again for 14 days). Keep the edgedesk_ref column in Clay so the results come back to the right person.');
      return loadResearch();
    }, function (e) { fail('dvEnrichMsg', e); });
  }
  /* a CSV, quotes and all; the database decides what any of it is worth */
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, i, ch;
    text = String(text || '').replace(/^\uFEFF/, '');
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }
  var CLAY_COLS = { edgedesk_ref: 'ref', ref: 'ref', prospect_id: 'ref', full_name: 'full_name', name: 'full_name', 'full name': 'full_name',
    job_title: 'job_title', title: 'job_title', 'job title': 'job_title', organization: 'organization', company: 'organization', 'company name': 'organization',
    company_name: 'organization', email: 'email', 'work email': 'email', work_email: 'email', 'email address': 'email', linkedin_url: 'linkedin_url',
    linkedin: 'linkedin_url', 'linkedin profile': 'linkedin_url', 'linkedin url': 'linkedin_url', x_url: 'x_url', twitter: 'x_url', twitter_url: 'x_url',
    website_url: 'website_url', website: 'website_url', newsletter_url: 'newsletter_url', newsletter: 'newsletter_url', source_url: 'source_url', source: 'source_url' };
  function clayRows(text) {
    var t = parseCsv(text);
    if (t.length < 2) return [];
    var head = t[0].map(function (h) { return CLAY_COLS[String(h).trim().toLowerCase()] || null; });
    return t.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (k, i) { var v = String(r[i] == null ? '' : r[i]).trim(); if (k && v && !o[k]) o[k] = v.slice(0, 500); });
      return o;
    }).filter(function (o) { return Object.keys(o).length; });
  }
  function clayImport(file) {
    if (!file) return Promise.resolve();
    return new Promise(function (ok, no) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.onerror = no; fr.readAsText(file); }).then(function (text) {
      var rows = clayRows(text);
      if (!rows.length) { say('dvEnrichMsg', 'err', 'Nothing to import: the CSV needs a header row with columns such as edgedesk_ref, full_name, email, linkedin_url.'); return; }
      if (rows.length > 200) { say('dvEnrichMsg', 'err', 'At most 200 rows at a time; this file has ' + rows.length + '.'); return; }
      return S.rpc('growth_outbound_provider_import', { p_provider: 'clay', p_rows: rows }).then(function (r) {
        if (!r || r.ok === false) { say('dvEnrichMsg', 'err', 'Not imported: ' + why(r) + '.'); return; }
        say('dvEnrichMsg', r.imported ? 'ok' : 'err', 'Imported ' + r.imported + ' of ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' as Clay\'s word'
          + (r.unmatched ? '; ' + r.unmatched + ' named nobody we know (Clay adds to prospects; it never creates them)' : '')
          + (r.refused ? '; ' + r.refused + ' refused' : '') + '. Addresses from Clay stay unverified until the verifier or you confirm them.');
        return Promise.all([loadResearch(), loadMorning(), loadProspects(), loadActivity()]);
      });
    }, function (e) { fail('dvEnrichMsg', e); }).then(function () { if ($('dvClayFile')) $('dvClayFile').value = ''; });
  }
  function setSegment() {
    if (!DETAIL) return Promise.resolve();
    var id = DETAIL.prospect.id, seg = $('pdSeg').value;
    if (seg === (DETAIL.prospect.campaign_type || 'customer')) { say('pdSegMsg', '', 'No change.'); return Promise.resolve(); }
    var reason = root.prompt('Mark them as "' + segName(seg) + '"?' + (seg !== 'customer' ? ' A subscriber email waiting for them is cancelled.' : '') + ' Why (optional)?');
    if (reason == null) return Promise.resolve();
    return S.rpc('growth_outbound_prospect_set_segment', { p_id: id, p_segment: seg, p_reason: String(reason).trim() || null }).then(function (r) {
      if (!r || r.ok === false) { say('pdSegMsg', 'err', 'Not changed: ' + why(r)); return; }
      return Promise.all([refreshAfter(id), loadMorning()]);
    }, function (e) { fail('pdSegMsg', e); });
  }

  /* ── the system check (Phase 11) ─────────────────────────────────────── */
  var SEVERITY = { 1: ['Now', 'bad'], 2: ['Soon', 'test'], 3: ['When you can', ''], 4: ['Note', ''] };
  function paintHealth(h) {
    var att = h.attention || [], bad = (h.checks || []).filter(function (c) { return !c.ok; });
    var urgent = att.filter(function (a) { return a.severity <= 2; }).length;
    $('hcTop').innerHTML = bad.length || urgent
      ? '<a class="chip warn" href="#hcHead" data-hc="warn">System check: ' + (bad.length ? bad.length + ' check' + (bad.length > 1 ? 's' : '') + ' failing' : '') + (bad.length && urgent ? ' · ' : '')
        + (urgent ? urgent + ' thing' + (urgent > 1 ? 's' : '') + ' to look at' : '') + '</a>'
      : '<span class="chip ok" data-hc="ok">System check: all ' + esc(h.total) + ' pass</span>';
    $('hcSummary').textContent = h.passing + ' of ' + h.total + ' checks pass · checked ' + when(h.checked_at);
    $('hcAttention').innerHTML = att.length ? '<ul class="claims">' + att.map(function (a) {
      var sv = SEVERITY[a.severity] || ['Note', ''];
      return '<li data-att="' + esc(a.code) + '"><span class="pill ' + sv[1] + '">' + esc(sv[0]) + '</span> ' + esc(a.text) + '</li>';
    }).join('') + '</ul>' : '<div class="okb" data-att="none">Nothing needs your attention.</div>';
    $('hcChecks').innerHTML = '<tr><th>#</th><th>Check</th><th>Result</th></tr>' + (h.checks || []).map(function (c) {
      return '<tr' + (c.ok ? '' : ' data-failing="1"') + '><td>' + esc(c.step) + '</td><td class="wrap">' + esc(c.item) + '</td><td class="wrap">'
        + '<span class="pill ' + (c.ok ? 'on' : 'bad') + '">' + (c.ok ? 'ok' : 'CHECK') + '</span> ' + (c.ok && c.outcome === 'ok' ? '' : esc(c.outcome)) + '</td></tr>';
    }).join('');
  }
  function checkDomain() {
    say('hcMsg', '', 'Reading SPF, DKIM and DMARC for the sending domain…');
    $('hcDomain').disabled = true;
    return S.invoke('growth_outbound_send', { action: 'domain_check' }, { timeoutMs: 60000 }).then(function (r) {
      var c = (r && r.check) || null;
      if (!r || r.ok === false || !c) { say('hcMsg', 'err', 'Not checked: ' + why(r) + '.'); return; }
      say('hcMsg', c.ok === true ? 'ok' : 'err', c.ok === true ? c.domain + ': SPF, DKIM and DMARC are in place.' : c.ok === false ? c.domain + ': a record is missing — live sending is blocked until it is fixed and checked again.' : c.domain + ': DNS could not be read; nothing was decided.');
      $('hcDomainOut').innerHTML = '<div class="tw"><table data-domaincheck="1"><tr><th>Record</th><th>Result</th><th>Detail</th></tr>' + ['spf', 'dkim', 'dmarc', 'provider'].filter(function (k) { return c[k]; }).map(function (k) {
        var x = c[k];
        return '<tr><td>' + esc(k === 'provider' ? 'Resend' : k.toUpperCase()) + '</td><td><span class="pill ' + (x.ok === true ? 'on' : x.ok === false ? 'bad' : '') + '">' + (x.ok === true ? 'ok' : x.ok === false ? 'missing' : 'unknown') + '</span></td><td class="wrap mono">' + esc(clip(x.detail || '', 240)) + '</td></tr>';
      }).join('') + '</table></div>';
      return Promise.all([loadHealth(), loadMorning(), loadOverview()]);
    }, function (e) {
      if (e && e.kind === 'not_installed') { say('hcMsg', 'err', 'The send function is not deployed yet: deploy supabase/functions/growth_outbound_send.'); return; }
      fail('hcMsg', e);
    }).then(function () { $('hcDomain').disabled = false; });
  }
  function loadHealth() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_health', {}).then(paintHealth, function (e) {
      if (e && e.kind === 'not_installed') {
        $('hcSummary').textContent = 'The system check arrives with the Phase 11 SQL: run supabase/growth_outbound.sql again.';
        $('hcTop').innerHTML = ''; $('hcAttention').innerHTML = ''; $('hcChecks').innerHTML = '';
        return;
      }
      throw e;
    });
  }

  /* ── results (Phase 10) ─────────────────────────────────────────────── */
  var STAGE = { visited: 'Visited EdgeDesk from the email', signed_up: 'Made an account', trial: 'Started the free trial', paid: 'Paid' };
  var MATCHED = { link: 'the email\'s link (its campaign code)', address: 'the address we wrote to' };
  var DIMS = [['prospect_type', 'Prospect type'], ['query', 'Search that found them'], ['writer', 'Who wrote the first email'], ['fit_band', 'Fit score']];
  var RDAYS = 90, RDIM = 'prospect_type', RES = null;
  function pct(x) { return x == null ? '—' : (Math.round(Number(x) * 1000) / 10) + '%'; }
  function range(iv) { return iv ? pct(iv[0]) + '–' + pct(iv[1]) : '—'; }
  function ofWritten(n, p, rate) { return n == null ? '' : pct(rate) + ' of ' + p.contacted + ' written to'; }
  function groupName(dim, g) { return dim === 'prospect_type' ? String(g).replace(/_/g, ' ') : g; }
  function paintResults(r) {
    RES = r;
    var p = r.people || {}, x = r.sends || {}, pl = r.pipeline || {};
    Array.prototype.forEach.call($('rsDays').querySelectorAll('button'), function (b) { b.classList.toggle('on', Number(b.getAttribute('data-rdays')) === r.days); });
    Array.prototype.forEach.call($('rsDim').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-rdim') === RDIM); });
    var h = r.attribution_links ? '<span class="chip ok" data-rs="tagged">Links tagged: a visit or signup from an email is matched by its link</span>'
      : '<span class="chip warn" data-rs="untagged">Link tagging is off (Outbound settings → Results): only the address written to can be matched</span>';
    h += r.sync_error ? '<span class="chip warn" data-rs="error">Matching failed: ' + esc(clip(r.sync_error, 160)) + '</span>'
      : '<span class="chip" data-rs="synced">Matched ' + esc(when(r.synced_at)) + '</span>';
    var pv = r.providers || {};
    h += '<span class="chip off" data-rs="providers">Provider calls: ' + (Object.keys(pv).length ? Object.keys(pv).sort().map(function (k) { return esc(k) + ' ' + esc(pv[k]); }).join(' · ') : 'none') + '</span>';
    $('rsChips').innerHTML = h;
    $('rsPeople').innerHTML = kpi('Written to', p.contacted || 0, 'first email in the last ' + r.days + ' days')
      + kpi('Replied', p.replied || 0, ofWritten(p.replied, p, p.reply_rate)) + kpi('Opted out', p.opted_out || 0, ofWritten(p.opted_out, p, p.opt_out_rate))
      + kpi('Visited', p.visited || 0, ofWritten(p.visited, p, p.visit_rate)) + kpi('Made an account', p.signed_up || 0, ofWritten(p.signed_up, p, p.signup_rate))
      + kpi('Started a trial', p.trial || 0, ofWritten(p.trial, p, p.trial_rate)) + kpi('Paid', p.paid || 0, ofWritten(p.paid, p, p.paid_rate));
    $('rsSends').innerHTML = kpi('Emails sent', x.sent || 0, (pl.approved || 0) + ' approved · ' + (pl.drafted || 0) + ' drafted · ' + (pl.prospects || 0) + ' new prospects')
      + kpi('Delivered', x.delivered || 0, pct(x.delivery_rate)) + kpi('Bounced', x.bounced || 0, pct(x.bounce_rate))
      + kpi('Spam complaints', x.complained || 0, pct(x.complaint_rate)) + kpi('Opened', x.opened || 0, 'a hint only: many clients hide opens')
      + kpi('Clicked', x.clicked || 0, 'as Resend saw it');
    var sig = r.signals || [];
    $('rsSignals').innerHTML = sig.length ? '<ul class="claims">' + sig.map(function (g) {
      return '<li data-signal="' + esc(g.dimension + ':' + g.group + ':' + g.metric) + '"><b>' + esc(label(DIMS, g.dimension)) + ': ' + esc(groupName(g.dimension, g.group)) + '</b> '
        + (g.metric === 'reply' ? 'replies' : 'signs up') + ' ' + (g.direction === 'higher' ? 'more' : 'less') + ' often than everyone: '
        + esc(g.k) + ' of ' + esc(g.n) + ' (' + pct(g.rate) + ') against ' + pct(g.overall) + ' overall.</li>';
    }).join('') + '</ul>'
      : '<div class="note" data-signal="none">Nothing stands out yet. A group is compared only once it has ' + esc(r.min_sample) + ' people, and called out only when the whole of its 95% range is above or below everyone\'s rate — so a lucky few never look like a pattern.</div>';
    var steps = r.by_step || [];
    $('rsSteps').innerHTML = '<tr><th>Step</th><th class="r">Sent</th><th class="r">Delivered</th><th class="r">Bounced</th><th class="r">Opened</th><th class="r">Clicked</th><th class="r">Replies after it</th><th class="r">Signups after it</th></tr>'
      + (steps.length ? steps.map(function (s) {
        return '<tr><td>' + esc(s.step === 1 ? 'First email' : s.step === 2 ? 'Follow-up' : 'Final follow-up') + '</td><td class="r">' + esc(s.sent) + '</td><td class="r">' + esc(s.delivered)
          + '</td><td class="r">' + esc(s.bounced) + '</td><td class="r">' + esc(s.opened) + '</td><td class="r">' + esc(s.clicked) + '</td><td class="r">' + esc(s.replies_after)
          + '</td><td class="r">' + esc(s.signups_after) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="dim">No live email in this window.</td></tr>');
    paintGroups();
    var days = (r.daily || []).filter(function (d) { return d.sent || d.replied || d.visited || d.signed_up; }).reverse();
    $('rsDaily').innerHTML = '<tr><th>Day</th><th class="r">Sent</th><th class="r">Replies</th><th class="r">Visits</th><th class="r">Accounts</th></tr>'
      + (days.length ? days.map(function (d) {
        return '<tr><td>' + esc(d.day) + '</td><td class="r">' + esc(d.sent) + '</td><td class="r">' + esc(d.replied) + '</td><td class="r">' + esc(d.visited) + '</td><td class="r">' + esc(d.signed_up) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="dim">Nothing happened in this window.</td></tr>');
    var latest = r.latest || [];
    $('rsLatest').innerHTML = '<tr><th>When</th><th>Prospect</th><th>What</th><th>Matched by</th></tr>'
      + (latest.length ? latest.map(function (c) {
        return '<tr><td>' + when(c.occurred_at) + '</td><td><button type="button" class="lnk" data-open="' + esc(c.prospect_id) + '">' + esc(c.full_name || '(name not established)') + '</button>'
          + (c.organization ? '<div class="sub">' + esc(c.organization) + '</div>' : '') + '</td><td>' + esc(STAGE[c.stage] || c.stage) + '</td><td>' + esc(MATCHED[c.matched_by] || c.matched_by) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="dim">No result yet.</td></tr>');
  }
  function paintGroups() {
    var rows = ((RES && RES.groups) || {})[RDIM] || [];
    $('rsGroups').innerHTML = '<tr><th>' + esc(label(DIMS, RDIM)) + '</th><th class="r">Written to</th><th class="r">Replied</th><th>Reply rate (95% range)</th>'
      + '<th class="r">Accounts</th><th>Signup rate (95% range)</th><th class="r">Paid</th><th class="r">Opted out</th></tr>'
      + (rows.length ? rows.map(function (g) {
        return '<tr data-group="' + esc(g.group) + '"><td class="wrap">' + esc(groupName(RDIM, g.group)) + (g.enough ? '' : ' <span class="pill" title="Fewer than ' + esc(RES.min_sample) + ' people: too few to compare">few</span>')
          + '</td><td class="r">' + esc(g.contacted) + '</td><td class="r">' + esc(g.replied) + '</td><td class="conf"><b>' + pct(g.reply_rate) + '</b> ' + range(g.reply_interval)
          + '</td><td class="r">' + esc(g.signed_up) + '</td><td class="conf"><b>' + pct(g.signup_rate) + '</b> ' + range(g.signup_interval)
          + '</td><td class="r">' + esc(g.paid) + '</td><td class="r">' + esc(g.opted_out) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="dim">No one written to in this window.</td></tr>');
  }
  function loadResults() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_analytics', { p_days: RDAYS }).then(paintResults, function (e) {
      if (e && e.kind === 'not_installed') {
        $('rsChips').innerHTML = '<span class="chip off">Results arrive with the Phase 10 SQL: run supabase/growth_outbound.sql again.</span>';
        ['rsPeople', 'rsSends', 'rsSignals', 'rsSteps', 'rsGroups', 'rsDaily', 'rsLatest'].forEach(function (id) { $(id).innerHTML = ''; });
        return;
      }
      throw e;
    });
  }

  /* ── the morning run (Phase 9) ───────────────────────────────────────── */
  var STEP = { discover: 'search the saved searches', research: 'research the next new candidate', draft: 'write drafts for whoever is due',
    verify: 'ask the verifier about waiting addresses' };
  function stepName(st) { return st && st.kind === 'research' && st.input && st.input.verify ? STEP.verify : STEP[st && st.kind] || (st && st.kind); }
  function hh(n) { return (n < 10 ? '0' : '') + n + ':00'; }
  function paintAutomation(a) {
    var p = a.plan || {}, t = p.today || {}, sc = a.scheduler || {};
    var end = (a.start_hour + a.hours) % 24;
    var h = a.enabled
      ? '<span class="chip ok" data-am="on">Morning run: on · ' + esc(hh(a.start_hour)) + '–' + esc(hh(end)) + ' ' + esc(a.timezone) + '</span>'
      : '<span class="chip off" data-am="off">Morning run: off (turn on Automation under Outbound settings)</span>';
    if (!a.pg_net) h += '<span class="chip off" data-am="nonet">pg_net is not installed: enable it under Database → Extensions</span>';
    if (sc.ticking) h += '<span class="chip ok" data-am="ticking">Clock: last tick ' + esc(when(sc.last_tick_at)) + '</span>';
    else h += '<span class="chip off" data-am="noclock">The clock is not running' + (sc.last_tick_at ? ' (last tick ' + esc(when(sc.last_tick_at)) + ')' : '')
      + ': run supabase/growth_outbound_cron.sql in the SQL editor</span>';
    h += '<span class="chip" data-am="next">' + (p.step ? 'Next: ' + esc(stepName(p.step)) : 'Now: ' + esc(p.reason || 'nothing to do')) + '</span>';
    h += digestChip(a.digest);
    $('amChips').innerHTML = h;
    $('amToday').innerHTML = kpi('Searched today', t.searched ? 'yes' : 'not yet')
      + (t.qualified_target != null ? kpi('Qualified today', (t.qualified || 0) + ' of ' + t.qualified_target, 'new potential subscribers') : '')
      + kpi('Researched today', (t.researched || 0) + ' of ' + (t.research_target || 0), t.qualified_target != null ? 'at most' : '')
      + kpi('Drafted today', (t.drafted || 0) + ' of ' + (t.draft_cap || 0), 'today\'s send cap') + kpi('New candidates', t.new_candidates || 0) + kpi('Due a draft', t.due || 0);
    var runs = a.runs || [];
    $('amRuns').innerHTML = '<tr><th>When</th><th>Step</th><th>Status</th><th>Result</th><th>Note</th></tr>'
      + (runs.length ? runs.map(function (r) {
        var c = r.counts || {};
        var res = r.kind === 'discover' ? (c.new != null ? c.new + ' new of ' + (c.results || 0) : '') : r.kind === 'draft' ? (c.drafted != null ? c.drafted + ' drafted' : '')
          : (c.outcome ? String(c.outcome).replace(/_/g, ' ') + (c.evidence ? ', ' + c.evidence + ' fact(s)' : '') : '');
        return '<tr><td>' + when(r.started_at) + '</td><td>' + esc(stepName(r)) + '</td>'
          + '<td><span class="pill ' + (r.status === 'failed' ? 'bad' : r.status === 'running' ? 'test' : 'on') + '">' + esc(r.status) + '</span></td>'
          + '<td>' + esc(res) + '</td><td class="wrap">' + esc(clip(r.error || '', 160)) + '</td></tr>';
      }).join('') : '<tr><td colspan="5">The morning run has not run yet.</td></tr>');
  }
  /* the owner's daily email ("N drafts are waiting for your review"): on or
     off, to whom, and what became of this morning's */
  function digestChip(dg) {
    if (!dg) return '';
    if (!dg.enabled) return '<span class="chip off" data-am="digest">Daily email: off (turn it on under Outbound settings → Morning run)</span>';
    var pl = dg.plan || {}, last = (dg.recent || [])[0], now;
    if (last && last.day === pl.day) {
      now = last.status === 'sent' ? 'sent ' + when(last.sent_at) + ' (' + last.waiting + ' waiting)'
        : last.status === 'skipped' ? 'nothing waited for review this morning'
        : last.status === 'sending' ? 'on its way'
        : 'not sent: ' + clip(last.reason || 'no reason recorded', 120) + (last.retryable && last.attempts < 3 ? ' (it tries again)' : '');
    } else now = pl.reason || '';
    return '<span class="chip ' + (!dg.to || (last && last.day === pl.day && last.status === 'failed') ? 'warn' : 'ok') + '" data-am="digest">Daily email: on, to '
      + esc(dg.to || 'nobody (turn it off and on again)') + (now ? ' · ' + esc(now) : '') + '</span>';
  }
  function loadAutomation() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_automation_overview', {}).then(paintAutomation, function (e) {
      if (e && e.kind === 'not_installed') {
        $('amChips').innerHTML = '<span class="chip off">The morning run arrives with the Phase 9 SQL: run supabase/growth_outbound.sql again.</span>';
        $('amToday').innerHTML = ''; $('amRuns').innerHTML = '';
        return;
      }
      throw e;
    });
  }

  /* ── the drafting engine (Phase 8) ────────────────────────────────── */
  var DRAFT_WHY = {
    not_installed: 'The drafting function is not deployed yet: deploy supabase/functions/growth_outbound_draft (docs/growth-outbound.md, Phase 8).',
    too_many_running: 'Three engine runs are already going; wait for one to finish.',
    nothing_due: 'Nobody is due a draft right now.',
    no_citeable_fact: 'no fact about them is sure enough to cite on its own; research them further',
    not_drafted: 'neither Claude nor the template wrote a draft the database accepts (it is left alone for a week, unless new evidence arrives)',
    not_found: 'that prospect is no longer there'
  };
  function draftWhy(r) { return (r && r.reason === 'not_due' && r.detail) ? 'not due: ' + r.detail : DRAFT_WHY[r && (r.reason || r.code)] || (r && (r.detail || r.reason)) || 'it could not be done'; }
  function paintDrafting(prov, ov) {
    ov = ov || {};
    var dc = ov.due_counts || {}, st = (ov.stats || {}).engine, tp = (ov.stats || {}).template, b = ov.llm_budget;
    var due = (dc.first || 0) + (dc.followup || 0) + (dc.final || 0);
    var chips = prov
      ? (prov.llm ? '<span class="chip ok" data-prov="writing">Writing: Claude · ' + used(b) + ' today</span>'
                  : '<span class="chip off" data-prov="writing">Writing: the template only (ANTHROPIC_API_KEY not set)</span>')
      : '<span class="chip off" data-prov="writing">The drafting function is not deployed: deploy supabase/functions/growth_outbound_draft (docs/growth-outbound.md, Phase 8)</span>';
    chips += '<span class="chip" data-due="' + due + '">Due: ' + esc(dc.first || 0) + ' first email' + (dc.first === 1 ? '' : 's') + ', ' + esc((dc.followup || 0) + (dc.final || 0)) + ' follow-up' + ((dc.followup || 0) + (dc.final || 0) === 1 ? '' : 's') + '</span>';
    var all = function (x) { return x ? x.drafts || 0 : 0; }, sum = function (k) { return (st ? st[k] || 0 : 0) + (tp ? tp[k] || 0 : 0); };
    if (all(st) + all(tp)) {
      chips += '<span class="chip" data-stats="engine">Engine drafts, 90 days: ' + esc(all(st) + all(tp)) + ' written · ' + esc(sum('approved_as_written')) + ' approved as written · '
        + esc(sum('approved_after_edit')) + ' after your edit · ' + esc(sum('rejected')) + ' rejected</span>';
    }
    $('rqDrafting').innerHTML = chips;
    var n = Math.min(due, 5);
    $('rqWrite').textContent = due ? 'Write the next ' + (n === 1 ? 'draft' : n + ' drafts') : 'Write drafts';
    $('rqWrite').disabled = WRITING || !prov || !due;
    $('rqWrite').setAttribute('data-n', String(n));
  }
  function loadDrafting() {
    if (!OWNER) return Promise.resolve();
    return S.invoke('growth_outbound_draft', { action: 'status' }).then(function (r) {
      if (!r || !r.providers) throw new Error('no status from the drafting function');
      return r;
    }).then(function (r) { paintDrafting(r.providers, r.overview); }, function () {
      // the function is not deployed (or failing): the database can still say who is due
      return S.rpc('growth_outbound_drafting_overview', {}).then(function (ov) { paintDrafting(null, ov); }, function (e2) {
        if (e2 && e2.kind === 'not_installed') { $('rqDrafting').innerHTML = '<span class="chip off">The drafting engine arrives with the Phase 8 SQL: run supabase/growth_outbound.sql again.</span>'; $('rqWrite').disabled = true; return; }
        throw e2;
      });
    });
  }
  function drafted(r) {
    return 'by ' + (r.writer === 'claude' ? 'Claude' : 'the template') + (r.writer === 'template' && r.attempts && r.attempts.length
      ? ' (' + r.attempts.filter(function (a) { return a.writer === 'claude'; }).map(function (a) { return a.error || 'Claude\'s draft was refused: ' + clip((a.problems || []).join('; '), 160); }).join('; ') + ')' : '');
  }
  function writeDrafts(t) {
    if (WRITING) return Promise.resolve();
    var msg = t.prospect_id ? 'wdMsg' : 'rqMsg';
    WRITING = true;
    if ($('rqWrite')) $('rqWrite').disabled = true;
    if ($('wdEngine')) $('wdEngine').disabled = true;
    say(msg, '', 'Writing from what can be cited, and having the database check every word — this can take a minute…');
    return S.invoke('growth_outbound_draft', Object.assign({ action: 'draft' }, t), { timeoutMs: 150000 }).then(function (r) {
      if (t.prospect_id) {
        if (r && r.ok) say(msg, 'ok', 'Drafted ' + drafted(r) + '. It is in the review queue: nothing is sent until you approve it and press Send.');
        else say(msg, 'err', 'Not drafted: ' + draftWhy(r) + (r && r.attempts && r.attempts.length ? ' — ' + clip(r.attempts.map(function (a) { return a.error || (a.problems || []).join('; '); }).join(' | '), 400) : '') + '.');
        return;
      }
      if (!r || r.ok === false) { say(msg, 'err', 'Nothing was drafted: ' + draftWhy(r) + '.'); return; }
      if (!r.results || !r.results.length) { say(msg, '', DRAFT_WHY.nothing_due); return; }
      var not = r.results.filter(function (x) { return !x.ok; });
      say(msg, r.drafted ? 'ok' : 'err', 'Drafted ' + r.drafted + ' of ' + r.tried + (r.by_claude || r.by_template ? ' (' + [r.by_claude ? r.by_claude + ' by Claude' : '', r.by_template ? r.by_template + ' by the template' : ''].filter(Boolean).join(', ') + ')' : '')
        + '. ' + (r.drafted ? 'They wait below for your review; nothing is sent until you approve and press Send.' : '')
        + (not.length ? ' Not drafted: ' + not.map(function (x) { return draftWhy(x); }).join('; ') + '.' : '') + (r.notes && r.notes.length ? ' ' + r.notes.join('; ') + '.' : ''));
    }, function (e) {
      if (e && e.kind === 'not_installed') say(msg, 'err', DRAFT_WHY.not_installed);
      else if (e && e.code && DRAFT_WHY[e.code]) say(msg, 'err', DRAFT_WHY[e.code]);
      else fail(msg, e);
    }).then(function () {
      WRITING = false;
      var said = { cls: $(msg).className, text: $(msg).textContent };
      var again = [loadQueue(), loadDrafting(), loadOverview(), loadActivity(), loadProspects()];
      if (t.prospect_id) again.push(openProspect(t.prospect_id));
      return Promise.all(again).then(function () { $(msg).className = said.cls; $(msg).textContent = said.text; });
    });
  }

  /* ── the review queue ─────────────────────────────────────────────── */
  function loadQueue() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_review_queue', { p_status: QUEUE, p_limit: 50 }).then(function (r) {
      QROWS = (r && r.rows) || []; PICKED = {}; paintQueue(r || {});
    }, function (e) {
      if (e && e.kind === 'not_installed') {
        QROWS = []; PICKED = {};
        $('rqCards').innerHTML = '<div class="note">The review queue arrives with the Phase 4 SQL: run supabase/growth_outbound.sql again.</div>';
        pickCount(); return;
      }
      throw e;
    });
  }
  /* Approvable as far as the page can tell; the database decides. */
  function approvable(c) {
    var p = c.prospect || {};
    if (c.draft.status !== 'pending_review' || (c.lint || []).length) return false;
    if (p.is_test) return true;
    if (c.greeting_problem || c.existing_account) return false;
    return !(p.gates || []).length && !(c.claims_missing || []).length && (c.draft.sequence_number > 1 ? p.status === 'contacted' : p.status === 'ready_for_review');
  }
  function paintQueue(r) {
    $('rqSeg').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-q') === QUEUE); });
    $('rqTotal').textContent = QUEUE === 'approved' ? (r.total || 0) + ' approved, not sent' : (r.total || 0) + ' waiting for review';
    $('rqCards').innerHTML = QROWS.length ? QROWS.map(card).join('')
      : '<div class="note">' + (QUEUE === 'approved' ? 'Nothing approved is waiting to be sent.' : 'Nothing is waiting for review. Write a draft from a prospect, or make a test one for your own inbox.') + '</div>';
    pickCount();
  }
  function card(c) {
    var d = c.draft, p = c.prospect || {}, pv = c.preview || {}, gates = p.is_test ? [] : (p.gates || []), lint = c.lint || [], miss = p.is_test ? [] : (c.claims_missing || []);
    var ok = approvable(c), id = esc(d.id);
    var h = '<div class="rq" data-draft="' + id + '"><div class="row rqh">'
      + (d.status === 'pending_review' ? '<label class="chk" title="' + (ok ? 'Select for a batch' : 'Not approvable yet') + '"><input type="checkbox" data-pick="' + id + '"' + (ok ? '' : ' disabled') + '></label>' : '')
      + '<span class="pill ' + (pv.test ? 'test' : 'bad') + '">' + (pv.test ? 'TEST' : 'LIVE') + '</span>'
      + '<button type="button" class="lnk" data-open="' + esc(p.id) + '">' + esc(p.full_name || '(name not established)') + '</button>'
      + '<span class="sub">' + esc([p.organization, 'step ' + d.sequence_number, p.qualification_score == null ? 'score —' : 'score ' + p.qualification_score,
        p.fit_score == null ? 'fit —' : 'fit ' + p.fit_score].filter(Boolean).join(' · ')) + '</span>'
      + (p.campaign_type && p.campaign_type !== 'customer' ? '<span class="pill seg">' + esc(segName(p.campaign_type)) + '</span>' : '')
      + '<span class="sp"></span><span class="pill by" data-by="' + esc(writerKey(d)) + '">' + esc(writer(d)) + '</span><span class="pill st">' + esc(STATUS[p.status] || p.status) + '</span></div>';
    if (c.greeting_problem) h += '<div class="block"><b>The greeting:</b> ' + esc(c.greeting_problem) + '. Edit it (your words are yours) or reject it.</div>';
    if (c.existing_account) h += '<div class="block" data-customer="1"><b>This address already has an EdgeDesk account.</b> A customer is never cold-emailed: it cannot be approved or sent. Reject it.</div>';
    if (gates.length || miss.length) h += '<div class="block"><b>Not approvable yet.</b> ' + gates.concat(miss.map(function (m) { return 'the email no longer says "' + m + '"'; })).map(esc).join(' · ') + '</div>';
    if (lint.length) h += '<div class="block"><b>Breaks the content rules:</b> ' + lint.map(esc).join(' · ') + '</div>';
    if ((c.advice || []).length) h += '<div class="note" data-advice="1"><b>Worth fixing before you approve:</b> ' + c.advice.map(esc).join(' · ') + '</div>';
    /* who they are, why they fit, how to reach them, where to read up */
    h += '<div class="row" style="align-items:flex-start;margin-top:8px"><div style="flex:1;min-width:240px">' + qualBlock(p.qualification, (p.thresholds || {}).qualification) + '</div>'
      + '<div style="flex:1;min-width:220px" class="sub" data-contact="1">Address: <span class="mono">' + esc(p.email || '—') + '</span> <span class="pill ' + (p.email_status === 'verified' ? 'on' : 'test') + '">' + esc(p.email_status || 'none') + '</span>'
      + (p.email_source_kind ? ' <span class="sub">(' + esc(label(EV_KINDS, p.email_source_kind)) + ')</span>' : '')
      + ((c.links || []).length ? '<div>Read up: ' + c.links.map(function (u) { return link(u, hostOf(u)); }).join(' · ') + '</div>' : '')
      + (c.words != null ? '<div>' + esc(c.words) + ' words</div>' : '') + '</div></div>';
    h += '<div class="mail"><div class="mh"><i>From</i>' + esc(pv.from || '') + '</div>'
      + '<div class="mh"><i>To</i>' + (pv.to ? '<span class="mono">' + esc(pv.to) + '</span>' : '<span class="dim">no test inbox set</span>')
      + (pv.test && pv.intended_recipient && pv.intended_recipient !== pv.to ? ' <span class="dim">(test: not ' + esc(pv.intended_recipient) + ')</span>' : '') + '</div>'
      + '<div class="mh"><i>Subject</i><b>' + esc(d.subject) + '</b></div>'
      + '<div class="mb">' + esc(pv.body != null ? pv.body : d.body_text) + '</div><div class="mf">' + esc(pv.footer || '') + '</div></div>'
      + (pv.links_tagged && pv.body !== d.body_text ? '<div class="sub" data-tagged="1">Its EdgeDesk links carry ' + (pv.test ? 'the test code (ob_test), so your own clicks count for nobody' : 'this prospect\'s campaign code, so a visit or signup from it can be matched') + '.</div>' : '');
    h += '<h3>What it says about them, and why we believe it</h3>' + ((c.claims || []).length ? '<ul class="claims">' + c.claims.map(function (k) {
      var e = k.evidence || null, bad = !e || !e.current || !e.own || Number(k.confidence) === 0;
      return '<li class="' + (bad ? 'badc' : '') + '"><b>“' + esc(k.text) + '”</b> '
        + (e ? '<span class="sub">rests on #' + esc(e.id) + ' · ' + esc(label(EV_FIELDS, e.field_name)) + ' · ' + esc(label(EV_KINDS, e.source_kind)) + ' · ' + link(e.source_url, hostOf(e.source_url))
          + ' · confidence <span class="mono">' + num(k.confidence) + '</span>' + (e.current ? '' : ' · <b>superseded</b>') + (e.own ? '' : ' · <b>not this person\'s evidence</b>') + '</span>'
          + (e.source_excerpt ? '<div class="quote">' + esc(clip(e.source_excerpt, 240)) + '</div>' : '')
          : '<span class="sub"><b>cites no evidence</b></span>') + '</li>';
    }).join('') + '</ul>' : '<div class="note">' + (p.is_test ? 'A test message: it says nothing about a real person.' : '<b>It says nothing about them, backed by evidence.</b> It cannot be approved.') + '</div>');
    h += '<div class="row" style="margin-top:10px">';
    if (d.status === 'pending_review') {
      h += '<button type="button" data-approve="' + id + '"' + (ok ? '' : ' disabled') + '>Approve</button>'
        + '<button type="button" class="g" data-edit="' + id + '">Edit</button><button type="button" class="g" data-reject="' + id + '">Reject</button>';
    } else {
      h += '<button type="button" data-send="' + id + '">' + (pv.test ? 'Send test' : 'Send now') + '</button>'
        + '<span class="note" style="margin:0">Approved ' + esc(when(d.approved_at)) + '. Not sent yet.</span>'
        + '<span class="sp"></span><button type="button" class="g" data-unapprove="' + id + '">Withdraw approval</button>';
    }
    h += '</div><div class="hide rqedit" id="rqe_' + id + '"><div class="f"><label>Subject</label><input data-esubj="' + id + '" maxlength="150" value="' + esc(d.subject) + '"></div>'
      + '<div class="f" style="margin-top:8px"><label>The email</label><textarea data-ebody="' + id + '" rows="8" maxlength="5000">' + esc(d.body_text) + '</textarea></div>'
      + '<div class="row" style="margin-top:8px"><span class="sp"></span><button type="button" class="g" data-ecancel="' + id + '">Cancel</button><button type="button" data-esave="' + id + '">Save — back to review</button></div></div>'
      + '<div class="msg" id="rqm_' + id + '"></div></div>';
    return h;
  }
  function byId(id) { for (var i = 0; i < QROWS.length; i++) if (QROWS[i].draft.id === id) return QROWS[i]; return null; }
  /* who wrote a draft: you, the engine (Claude), or its template — and whether you edited the engine's words */
  function writerKey(d) {
    var g = String(d.generator_version || '');
    return /^engine:template:/.test(g) ? 'template' : /^engine:/.test(g) ? 'engine' : 'owner';
  }
  function writer(d) {
    var k = writerKey(d);
    return k === 'owner' ? 'by you' : (k === 'template' ? 'by the template' : 'by the engine') + (d.edited_by_owner ? ', edited by you' : '');
  }
  function pickCount() {
    var n = Object.keys(PICKED).length;
    $('rqBatch').textContent = 'Approve selected (' + n + ')';
    $('rqBatch').disabled = n === 0;
    $('rqBatch').classList.toggle('hide', QUEUE !== 'pending_review');
    var m = QUEUE === 'approved' ? Math.min(QROWS.length, 25) : 0;
    $('rqSendAll').classList.toggle('hide', !m);
    $('rqSendAll').textContent = 'Send all shown (' + m + ')';
  }
  function approveOne(id) {
    var c = byId(id); if (!c) return Promise.resolve();
    var pv = c.preview || {};
    if (!root.confirm('Approve this message to ' + (pv.to || 'the test inbox') + '?\n\n"' + c.draft.subject + '"\n\nApproving sends nothing. ' + (pv.test ? 'It is a TEST: it can only ever reach your test inbox.' : 'Once sending is built, it will go to this real person.'))) return Promise.resolve();
    return S.rpc('growth_outbound_draft_approve', { p_draft_id: id, p_content_hash: c.draft.content_hash }).then(function (r) {
      if (!r || r.ok === false) { say('rqm_' + id, 'err', 'Not approved: ' + (r && r.gates ? r.gates.join('; ') : why(r))); return; }
      say('rqMsg', 'ok', 'Approved. Nothing was sent.');
      return Promise.all([loadQueue(), loadOverview(), loadActivity()]);
    }, function (e) { fail('rqMsg', e); });
  }
  /* THE BATCH: the count is typed, and the database approves exactly that many or none. */
  function approveBatch() {
    var ids = Object.keys(PICKED), n = ids.length;
    if (!n) return Promise.resolve();
    var typed = root.prompt('You are approving ' + n + ' draft' + (n === 1 ? '' : 's') + '.\n\nApproving sends nothing. If any one of them cannot be approved, none is.\n\nType the number ' + n + ' to confirm.');
    if (typed == null) return Promise.resolve();
    if (String(typed).trim() !== String(n)) { say('rqMsg', 'err', 'Not approved: you typed "' + String(typed).trim() + '" for ' + n + ' selected.'); return Promise.resolve(); }
    var items = ids.map(function (id) { return { draft_id: id, content_hash: byId(id).draft.content_hash }; });
    $('rqBatch').disabled = true;
    return S.rpc('growth_outbound_drafts_approve_batch', { p_items: items, p_confirm_count: Number(String(typed).trim()) }).then(function (r) {
      if (!r || r.ok === false) {
        say('rqMsg', 'err', 'Nothing was approved: ' + (r && r.refused ? r.refused.map(function (x) {
          var c = byId(x.draft_id); return ((c && c.prospect.full_name) || 'a draft') + ' — ' + (x.gates ? x.gates.join('; ') : x.reason);
        }).join(' · ') : why(r)));
        pickCount(); return;
      }
      say('rqMsg', 'ok', 'Approved ' + r.approved + ' draft' + (r.approved === 1 ? '' : 's') + '. Nothing was sent.');
      return Promise.all([loadQueue(), loadOverview(), loadActivity()]);
    }, function (e) { pickCount(); fail('rqMsg', e); });
  }
  function rejectOne(id) {
    var c = byId(id), eng = c && writerKey(c.draft) !== 'owner';
    var reason = root.prompt('Reject this draft? Why (optional)?' + (eng ? '\n\nThe drafting engine reads your reason before it writes the next ones.' : ''));
    if (reason == null) return Promise.resolve();
    return S.rpc('growth_outbound_draft_reject', { p_draft_id: id, p_reason: String(reason).trim() || null }).then(function (r) {
      if (!r || r.ok === false) { say('rqm_' + id, 'err', 'Not rejected: ' + why(r)); return; }
      return Promise.all([loadQueue(), loadOverview(), loadActivity()]);
    }, function (e) { fail('rqMsg', e); });
  }
  function unapprove(id) {
    if (!root.confirm('Withdraw this approval? The draft goes back to review.')) return Promise.resolve();
    return S.rpc('growth_outbound_draft_unapprove', { p_draft_id: id, p_reason: null }).then(function (r) {
      if (!r || r.ok === false) { say('rqm_' + id, 'err', 'Not withdrawn: ' + why(r)); return; }
      return Promise.all([loadQueue(), loadOverview(), loadActivity()]);
    }, function (e) { fail('rqMsg', e); });
  }
  function saveEdit(id) {
    var c = byId(id); if (!c) return Promise.resolve();
    var subj = document.querySelector('[data-esubj="' + id + '"]').value.trim(), body = document.querySelector('[data-ebody="' + id + '"]').value.trim();
    return S.rpc('growth_outbound_draft_edit', { p_draft_id: id, p_subject: subj, p_body_text: body, p_expected_hash: c.draft.content_hash }).then(function (r) {
      if (!r || r.ok === false) { say('rqm_' + id, 'err', 'Not saved: ' + why(r)); return; }
      say('rqMsg', 'ok', 'Saved. It is back in review.');
      return Promise.all([loadQueue(), loadActivity()]);
    }, function (e) { fail('rqMsg', e); });
  }
  /* ── sending ─────────────────────────────────────────────────────────── */
  function nameOf(draftId) { var c = byId(draftId); return (c && c.prospect && c.prospect.full_name) || 'a draft'; }
  function sendWhy(x) {
    if (x.reason === 'refused' || x.reason === 'stale_claim' || x.reason === 'approval_withdrawn' || x.reason === 'prospect_converted') return x.detail || x.reason;
    if (x.reason === 'content') return 'breaks the content rules: ' + (x.problems || []).join('; ');
    if (/^resend_\d+$/.test(x.reason || '')) return 'Resend answered ' + x.reason.slice(7) + '; press Send again (the same draft can never be sent twice)';
    return (SEND_WHY[x.reason] || x.reason || 'not sent') + (x.reason === 'resend_rejected' && x.detail ? ': ' + x.detail : '');
  }
  function sendDrafts(ids) {
    if (!ids.length) return Promise.resolve();
    return S.invoke('growth_outbound_send', { draft_ids: ids }).then(function (r) {
      var res = (r && r.results) || [];
      var sent = res.filter(function (x) { return x.state === 'sent' && !x.already; });
      var bad = res.filter(function (x) { return x.state !== 'sent'; });
      var warn = res.filter(function (x) { return x.warning; });
      say('rqMsg', bad.length || warn.length ? 'err' : 'ok',
        (sent.length ? 'Sent ' + sent.length + (sent.length === 1 ? ' email' : ' emails') + (sent.every(function (x) { return x.test; }) ? ' to your test inbox' : '') + '.' : 'Nothing was sent.')
        + (bad.length ? ' ' + bad.map(function (x) { return nameOf(x.draft_id) + ' — ' + sendWhy(x); }).join(' · ') : '')
        + (warn.length ? ' ' + warn.map(function (x) { return x.warning; }).join(' · ') : ''));
      return Promise.all([loadQueue(), loadSends(), loadOverview(), loadActivity()]);
    }, function (e) {
      if (e && e.kind === 'not_installed') { say('rqMsg', 'err', 'The send function is not deployed yet: deploy supabase/functions/growth_outbound_send (docs/growth-outbound.md, Phase 5).'); return; }
      if (e && e.code === 'resend_not_configured') { say('rqMsg', 'err', 'Nothing was sent: RESEND_API_KEY is not set in the Edge Function secrets.'); return; }
      fail('rqMsg', e);
    });
  }
  function sendOne(id) {
    var c = byId(id); if (!c) return Promise.resolve();
    var pv = c.preview || {};
    var ask = pv.test
      ? 'Send this TEST email to your test inbox, ' + (pv.to || '(no test inbox set)') + '?\n\n"' + c.draft.subject + '"'
      : 'Send this email to ' + pv.to + ' — a real person?\n\n"' + c.draft.subject + '"\n\nIt cannot be unsent.';
    if (!root.confirm(ask)) return Promise.resolve();
    return sendDrafts([id]);
  }
  function sendAll() {
    var rows = QROWS.slice(0, 25), ids = rows.map(function (c) { return c.draft.id; }), n = ids.length;
    if (!n) return Promise.resolve();
    var live = rows.filter(function (c) { return !(c.preview || {}).test; }).length;
    var typed = root.prompt('You are sending ' + n + ' approved email' + (n === 1 ? '' : 's') + (live ? ', ' + live + ' of them to REAL people' : ', all to your test inbox') + '.\n\nType the number ' + n + ' to send.');
    if (typed == null) return Promise.resolve();
    if (String(typed).trim() !== String(n)) { say('rqMsg', 'err', 'Nothing was sent: you typed "' + String(typed).trim() + '" for ' + n + '.'); return Promise.resolve(); }
    return sendDrafts(ids);
  }
  function loadSends() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_sends', { p_limit: 100 }).then(function (rows) {
      rows = rows || [];
      $('obSends').innerHTML = '<tr><th>When</th><th></th><th>To</th><th>Prospect</th><th>Subject</th><th>Status</th><th>Detail</th><th class="r">Tries</th><th></th></tr>'
        + (rows.length ? rows.map(function (x) {
          var bad = x.delivery_status === 'failed' || x.delivery_status === 'bounced' || x.delivery_status === 'complained';
          var seen = [x.opened_at ? 'opened ' + when(x.opened_at) : '', x.clicked_at ? 'clicked ' + when(x.clicked_at) : ''].filter(Boolean).join(' · ');
          return '<tr><td>' + when(x.sent_at || x.claimed_at) + '</td><td><span class="pill ' + (x.is_test ? 'test' : 'bad') + '">' + (x.is_test ? 'TEST' : 'LIVE') + '</span></td>'
            + '<td class="mono">' + esc(x.recipient) + (x.is_test && x.intended_recipient && x.intended_recipient !== x.recipient ? '<div class="sub">for ' + esc(x.intended_recipient) + '</div>' : '') + '</td>'
            + '<td><button type="button" class="lnk" data-open="' + esc(x.prospect_id) + '">' + esc(x.full_name || '(no name)') + '</button>' + (x.sequence_number > 1 ? ' <span class="sub">step ' + esc(x.sequence_number) + '</span>' : '') + '</td>'
            + '<td class="wrap">' + esc(clip(x.subject, 90)) + '</td><td><span class="pill ' + (bad ? 'bad' : x.delivery_status === 'claimed' ? 'test' : 'on') + '">' + esc(x.delivery_status) + '</span></td>'
            + '<td class="wrap">' + esc(clip(x.failure_reason || x.last_error || '', 160)) + (seen ? '<div class="sub" data-seen="' + esc(x.id) + '">' + esc(seen) + '</div>' : '') + '</td><td class="r">' + esc(x.attempts) + '</td>'
            + '<td>' + (x.delivery_status === 'claimed' ? '<button type="button" class="g sm" data-resend="' + esc(x.draft_id) + '">Try again</button>' : '') + '</td></tr>';
        }).join('') : '<tr><td colspan="9">Nothing has been sent.</td></tr>');
    }, function (e) {
      if (e && e.kind === 'not_installed') { $('obSends').innerHTML = '<tr><td>Sending arrives with the Phase 5 SQL: run supabase/growth_outbound.sql again.</td></tr>'; return; }
      throw e;
    });
  }
  /* ── replies, read from Resend (2026-10) ─────────────────────────── */
  var REPLY_KIND = { reply: 'replied', auto_reply: 'automatic answer', opt_out: 'asked to stop', test: 'answer to a test email', unmatched: 'from nobody you wrote to' };
  function loadReplies() {
    if (!OWNER) return Promise.resolve();
    return S.rpc('growth_outbound_replies', { p_limit: 50 }).then(function (r) {
      r = r || {};
      var c = r.counts_30d || {}, rows = r.rows || [];
      $('obReplyChips').innerHTML = '<span class="chip ' + (r.detection ? 'ok' : 'warn') + '" data-rp="detection">Reply detection: '
          + (r.detection ? 'on' : 'off (replies are listed; only a request to stop acts)') + '</span>'
        + '<span class="chip" data-rp="counts">30 days: ' + (c.reply || 0) + ' replied · ' + (c.auto_reply || 0) + ' automatic · ' + (c.opt_out || 0) + ' asked to stop · '
          + (c.unmatched || 0) + ' from nobody you wrote to</span>'
        + (r.last_at ? '' : '<span class="chip off" data-rp="none">Nothing received yet: set up receiving in Resend (docs/growth-outbound.md, "Replies")</span>');
      $('obReplies').innerHTML = '<tr><th>When</th><th>From</th><th>What</th><th>Subject</th><th>Changed</th></tr>'
        + (rows.length ? rows.map(function (x) {
          var who = x.prospect_id ? '<button type="button" class="lnk" data-open="' + esc(x.prospect_id) + '">' + esc(x.full_name || '(no name)') + '</button>'
              + (x.sequence_number > 1 ? ' <span class="sub">step ' + esc(x.sequence_number) + '</span>' : '')
            : '<span class="mono">' + esc(x.from_masked || '') + '</span>';
          var changed = x.kind === 'opt_out' ? (x.applied ? 'suppressed' : 'already suppressed')
            : x.kind === 'reply' ? (x.applied ? 'sequence ended' : x.detail && x.detail.detection === 'off' ? 'nothing (detection off)' : 'nothing more')
            : '—';
          return '<tr><td>' + when(x.received_at) + '</td><td>' + who + '</td>'
            + '<td><span class="pill ' + (x.kind === 'reply' ? 'on' : x.kind === 'opt_out' ? 'bad' : x.kind === 'test' ? 'test' : '') + '" data-kind="' + esc(x.kind) + '">' + esc(REPLY_KIND[x.kind] || x.kind) + '</span></td>'
            + '<td class="wrap">' + esc(clip(x.subject || '', 120)) + '</td><td>' + esc(changed) + '</td></tr>';
        }).join('') : '<tr><td colspan="5">No email has been received.</td></tr>');
    }, function (e) {
      if (e && e.kind === 'not_installed') {
        $('obReplyChips').innerHTML = '<span class="chip off">Replies arrive with the 2026-10 SQL: run supabase/growth_outbound.sql again.</span>';
        $('obReplies').innerHTML = '';
        return;
      }
      throw e;
    });
  }
  function fixture() {
    return S.rpc('growth_outbound_test_fixture', {}).then(function (r) {
      if (!r || r.ok === false) {
        say('rqMsg', 'err', r && r.reason === 'test_inbox_missing' ? 'Set a test inbox in the outbound settings first.' : 'No test prospect: ' + why(r)); return;
      }
      say('rqMsg', 'ok', r.created ? 'A test draft for your own inbox is in the queue.' : 'Your test draft is already in the queue.');
      QUEUE = 'pending_review';
      return Promise.all([loadQueue(), loadProspects(), loadOverview()]);
    }, function (e) { fail('rqMsg', e); });
  }

  /* ── have we seen them? and: add a prospect ─────────────────────────── */
  function lookup() {
    var q = $('obLook').value.trim();
    if (!q) return Promise.resolve();
    return S.rpc('growth_outbound_identity_lookup', { p_text: q }).then(function (r) {
      if (!r || r.ok === false) { $('obLookOut').innerHTML = '<div class="msg err">That is not an email address or a web address.</div>'; return; }
      var hits = [];
      (r.keys || []).forEach(function (k) { (k.matches || []).forEach(function (m) { if (!m.released) hits.push({ k: k, m: m }); }); });
      $('obLookOut').innerHTML = '<div class="note">Recognised as <span class="mono">' + esc(r.canonical) + '</span> · keys: '
        + esc((r.keys || []).map(function (k) { return k.kind + ' ' + k.value + ' (' + k.strength + ')'; }).join(', ')) + '</div>'
        + (r.suppressed ? '<div class="block">This address is suppressed: it will not be added or contacted.</div>' : '')
        + (hits.length ? '<div class="note">Already known: ' + hits.map(function (x) {
          return '<button type="button" class="lnk" data-open="' + esc(x.m.prospect_id) + '">' + esc(x.m.full_name || '(name not established)') + '</button> (' + esc(STATUS[x.m.status] || x.m.status) + ', by ' + esc(x.k.kind) + ')';
        }).join(' · ') + '</div>' : '<div class="note">Not seen before.</div>');
    }, function (e) { fail('obLookMsg', e); });
  }
  function addProspect() {
    var p = {}, email = $('apEmail').value.trim(), urls = $('apUrls').value.split(/\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (email) p.email = email;
    if (urls.length) p.urls = urls;
    if (!email && !urls.length) { say('apMsg', 'err', 'Give an email address or a profile or website: a prospect must be someone we can recognise again.'); return Promise.resolve(); }
    p.prospect_type = $('apType').value; p.campaign_type = $('apCampaign').value;
    var sports = $('apSports').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (sports.length) p.sports_focus = sports;
    if ($('apTest').checked) p.is_test = true;
    var claim = $('apClaim').value.trim(), src = $('apSrc').value.trim();
    if (claim || src) {
      if (!claim || !src) { say('apMsg', 'err', 'Evidence needs both the claim and the page it is on.'); return Promise.resolve(); }
      p.evidence = [{ field_name: $('apField').value, claim: claim, source_url: src, source_kind: $('apKind').value, source_excerpt: $('apQuote').value.trim() || null }];
    }
    $('apAdd').disabled = true;
    return S.rpc('growth_outbound_prospect_upsert', { p: p }).then(function (r) {
      $('apAdd').disabled = false;
      if (!r || r.ok === false) {
        say('apMsg', 'err', r && r.reason === 'suppressed' ? 'Not added: that address, its domain or that person is suppressed.'
          : r && r.reason === 'identity_conflict' ? 'Not added: those details belong to different prospects. Open them and release the wrong one first.'
          : 'Not added: ' + why(r));
        return;
      }
      say('apMsg', 'ok', (r.created ? 'Added' : 'Already known — added to their record') + '. Status: ' + (STATUS[r.status] || r.status) + '.'
        + (r.possible_duplicates && r.possible_duplicates.length ? ' Possibly the same person as ' + r.possible_duplicates.length + ' other prospect(s).' : ''));
      ['apEmail', 'apUrls', 'apSports', 'apClaim', 'apSrc', 'apQuote'].forEach(function (k) { $(k).value = ''; });
      return refreshAfter(r.prospect_id);
    }, function (e) { $('apAdd').disabled = false; fail('apMsg', e); });
  }

  /* ── suppress ───────────────────────────────────────────────────────── */
  function suppress() {
    var t = $('supTarget').value.trim(), scope = $('supScope').value, kind = $('supKind').value, why = $('supReason').value.trim() || null;
    if (!t) { say('supMsg', 'err', 'Enter an address or a domain.'); return Promise.resolve(); }
    if (!root.confirm('Suppress ' + (scope === 'domain' ? 'every address at ' : '') + t + ' permanently?\n\nEvery unsent draft for it is cancelled. This cannot be undone from the console.')) return Promise.resolve();
    return S.rpc('growth_outbound_suppress', { p_target: t, p_kind: kind, p_reason: why, p_scope: scope }).then(function (r) {
      if (!r || r.ok === false) { say('supMsg', 'err', 'Not suppressed: ' + (r && r.reason === 'invalid_target_or_kind' ? 'that is not a valid ' + (scope === 'domain' ? 'domain' : 'address') : (r && r.reason) || 'refused')); return; }
      say('supMsg', 'ok', 'Suppressed. ' + r.prospects_suppressed + ' prospect(s) marked, ' + r.drafts_cancelled + ' draft(s) cancelled.');
      $('supTarget').value = ''; $('supReason').value = '';
      return Promise.all([loadSupp(), loadOverview(), loadProspects(), loadActivity()]);
    }, function (e) { fail('supMsg', e); });
  }

  function wire() {
    $('tabBtnGrowth').onclick = function () { show('growth'); };
    $('tabBtnOutbound').onclick = function () { show('outbound'); };
    $('obReload').onclick = function () { LOADED = false; load(); };
    $('obFind').onclick = function () { loadProspects().catch(function (e) { fail('obMsg', e); }); };
    $('obStatus').onchange = $('obFind').onclick;
    $('obSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('obFind').onclick(); });
    $('obSave').onclick = save;
    $('supAdd').onclick = suppress;
    $('obLookBtn').onclick = lookup;
    $('dvSearch').onclick = function () { discover(false); };
    $('dvSaved').onclick = function () { discover(true); };
    $('dvNext').onclick = function () { research({ next: true }); };
    $('dvSave').onclick = saveDiscovery;
    $('dvQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') discover(false); });
    $('obLook').addEventListener('keydown', function (e) { if (e.key === 'Enter') lookup(); });
    $('apAdd').onclick = addProspect;
    $('apField').innerHTML = options(EV_FIELDS, 'full_name');
    $('apKind').innerHTML = options(EV_KINDS.slice(0, 7), 'own_site');
    $('obDetailClose').onclick = function () { DETAIL = null; $('obDetailWrap').classList.add('hide'); $('obDetail').innerHTML = ''; };
    /* one listener for every button drawn from data */
    $('tabOutbound').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !OWNER) return;
      if (b.getAttribute('data-open')) openProspect(b.getAttribute('data-open'));
      else if (b.getAttribute('data-supersede')) supersede(b.getAttribute('data-supersede'));
      else if (b.getAttribute('data-release')) release(b.getAttribute('data-release'));
      else if (b.id === 'evAdd') addEvidence();
      else if (b.id === 'fitAdd') fitChange(false);
      else if (b.id === 'fitDrop') fitChange(true);
      else if (b.id === 'pdEval') reevaluate();
      else if (b.id === 'pdResearchAgain') { if (DETAIL) research({ prospect_id: DETAIL.prospect.id }); }
      else if (b.getAttribute('data-research')) research({ candidate_id: Number(b.getAttribute('data-research')) });
      else if (b.getAttribute('data-cdismiss')) candidateSet(b.getAttribute('data-cdismiss'), 'dismissed');
      else if (b.getAttribute('data-crequeue')) candidateSet(b.getAttribute('data-crequeue'), 'new');
      else if (b.getAttribute('data-c')) { CSTATUS = b.getAttribute('data-c'); loadResearch().catch(function (er) { fail('dvMsg', er); }); }
      else if (b.id === 'pdResearch') setStatus('needs_research');
      else if (b.id === 'pdReject') setStatus('rejected');
      else if (b.id === 'pdReplied') replied(false);
      else if (b.id === 'pdReplyStop') replied(true);
      else if (b.id === 'wdCreate') writeDraft();
      else if (b.id === 'wdEngine') { if (DETAIL) writeDrafts({ prospect_id: DETAIL.prospect.id, sequence_number: Number($('wdSeq').value) }); }
      else if (b.id === 'rqWrite') writeDrafts({ next: Number(b.getAttribute('data-n')) || 5 });
      else if (b.getAttribute('data-approve')) approveOne(b.getAttribute('data-approve'));
      else if (b.getAttribute('data-reject')) rejectOne(b.getAttribute('data-reject'));
      else if (b.getAttribute('data-unapprove')) unapprove(b.getAttribute('data-unapprove'));
      else if (b.getAttribute('data-esave')) saveEdit(b.getAttribute('data-esave'));
      else if (b.getAttribute('data-edit') || b.getAttribute('data-ecancel')) {
        var eid = b.getAttribute('data-edit') || b.getAttribute('data-ecancel'), box = $('rqe_' + eid);
        if (box) box.classList.toggle('hide', !b.getAttribute('data-edit'));
      }
      else if (b.getAttribute('data-q')) { QUEUE = b.getAttribute('data-q'); loadQueue().catch(function (er) { fail('rqMsg', er); }); }
      else if (b.id === 'rqBatch') approveBatch();
      else if (b.id === 'rqSendAll') sendAll();
      else if (b.getAttribute('data-send')) sendOne(b.getAttribute('data-send'));
      else if (b.getAttribute('data-resend')) {
        if (root.confirm('Try this send again? It reuses the same key, so it can never go out twice.')) sendDrafts([b.getAttribute('data-resend')]);
      }
      else if (b.id === 'rqFixture') fixture();
      else if (b.id === 'hcRun') { b.disabled = true; loadHealth().catch(function (er) { fail('obMsg', er); }).then(function () { b.disabled = false; }); }
      else if (b.id === 'hcDomain') checkDomain();
      else if (b.id === 'dvVerify') verifyWaiting();
      else if (b.id === 'dvClayPush') clayPush();
      else if (b.id === 'dvClayExport') clayExport();
      else if (b.id === 'pdSegSave') setSegment();
      else if (b.getAttribute('data-rdays')) { RDAYS = Number(b.getAttribute('data-rdays')); loadResults().catch(function (er) { fail('rsMsg', er); }); }
      else if (b.getAttribute('data-rdim')) { RDIM = b.getAttribute('data-rdim'); if (RES) paintResults(RES); }
    });
    $('dvClayFile').addEventListener('change', function () { if (OWNER && this.files && this.files[0]) clayImport(this.files[0]); });
    $('tabOutbound').addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || !t.getAttribute('data-pick') || !OWNER) return;
      var id = t.getAttribute('data-pick');
      if (t.checked && byId(id) && approvable(byId(id))) PICKED[id] = true; else { delete PICKED[id]; t.checked = false; }
      pickCount();
    });
  }

  var API = { start: start, reset: reset, show: show, open: openProspect, _readSettings: readSettings, _clayRows: clayRows };
  root.EDOutbound = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  }
})(typeof window !== 'undefined' ? window : globalThis);
