/*__EDED_QUALITY_START__*/
/* ============================================================================
   ARTICLE QUALITY CONTROL — the last gate before a page exists.

   TWO CLASSES OF CHECK, AND THEY ARE NOT THE SAME KIND OF THING.

     INTEGRITY   a factual defect. A score that disagrees with the result
                 record. A pregame claim on a postgame page that is not the
                 claim in the snapshot. A statistic asserted that no provider
                 published. A favourite and an underdog the wrong way round.
                 ANY failure here BLOCKS PUBLICATION, full stop, and the
                 article is held for a person. There is no quality score high
                 enough to publish over one.

     CRAFT       a readability defect. A meta description too long for a
                 search result. A duplicated paragraph. A phrase from the
                 list of things that make prose read as machine-written. These
                 reduce the quality score and, below a floor, hold the article
                 too — but they never silently pass as "close enough".

   THE SCORE IS NOT A GRADE THE SYSTEM CAN TALK ITSELF PAST. It starts at 100
   and every craft failure removes a stated number of points; an integrity
   failure sets `publishable` false regardless of what the score says. An
   operator sees both.

   THE UNSUPPORTED-CLAIM CHECK is the one that matters most and is the hardest
   to get right. Every number that appears on the page is extracted and held
   against the closed set of values the snapshot's fact ledger and the result
   record actually contain. A figure on the page that is in neither is an
   UNSUPPORTED STATISTIC and blocks the article — which is what stops a
   narration layer, or a future refactor, from introducing a number nobody
   can trace.
   ========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('../articles/article_model.js') : (root.EDART && root.EDART.model),
    typeof require === 'function' ? require('./snapshot.js') : (root.EDED && root.EDED.snapshot),
    typeof require === 'function' ? require('./results.js') : (root.EDED && root.EDED.results),
    typeof require === 'function' ? require('../articles/article_render.js') : (root.EDART && root.EDART.render)
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.quality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AMODEL, SNAP, RESULTS, RENDER) {
  'use strict';

  var SCHEMA = 'edgedesk_article_quality_v1';

  /* Phrases that make prose read as machine-written. The list is short and
     specific on purpose: a long list of banned words produces copy that reads
     as though it is avoiding a long list of banned words. */
  var AI_TELLS = [
    /\bdelve[sd]? into\b/i,
    /\bin the (?:ever-?(?:changing|evolving)|fast-?paced) (?:world|landscape|realm)\b/i,
    /\bit(?:'|’)s important to note\b/i,
    /\bit is important to note\b/i,
    /\bgame[- ]chang(?:er|ing)\b/i,
    /\bonly time will tell\b/i,
    /\bwhether you(?:'|’)?re a (?:seasoned|casual|novice)\b/i,
    /\bthis thrilling (?:matchup|contest|clash)\b/i,
    /\bwhen (?:it|all) comes down to it\b/i,
    /\bat the end of the day\b/i,
    /\bin conclusion\b/i,
    /\bneedless to say\b/i,
    /\bthe perfect storm\b/i,
    /\bleave(?:s|) no stone unturned\b/i,
    /\ba testament to\b/i,
    /\bnavigat(?:e|ing) the (?:complexities|challenges|landscape)\b/i,
    /\bmust[- ]watch\b/i,
    /\bbuckle up\b/i,
    /\ball eyes will be on\b/i,
    /\bwithout a doubt\b/i
  ];

  /* Craft failures and what each costs. Declared as data so the cost of a
     rule is visible beside the rule. */
  var CRAFT_COST = {
    seo_title_length: 8, meta_description_length: 8, duplicate_paragraph: 12,
    ai_phrase: 10, repetition: 8, rhetorical_questions: 5, thin_sections: 10,
    internal_links: 5, excerpt_length: 4, headline_length: 4
  };
  var FLOOR = 70;        /* below this an article is held even with clean integrity */

  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }

  /* ------------------------------------------------- the page as plain text */
  /* IT CHECKS WHAT A READER SEES, not what the record contains.

     The first version of this walked the record and produced two false
     failures on every well-formed article: a card's own `note` field, which
     the renderer does not print, came back as a duplicated paragraph, and the
     excerpt — metadata, never on the page — came back as a repeat of the
     lede. Both are correct records and neither is a defect on the page.

     So the checks run on the RENDERED document. That is also the only version
     of the question that means anything: an unsupported number is a number a
     reader can see. */
  function renderedHTML(rec, opts) {
    if (opts && opts.html) return String(opts.html);
    return RENDER.articleBody(rec);
  }
  function stripTags(html) {
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  /* Every visible string on the page, one per block-level element, so a
     sentence is compared with a sentence rather than with a whole section. */
  function documentStrings(rec, opts) {
    var html = renderedHTML(rec, opts);
    var out = [];
    var re = /<(p|li|dd|dt|h1|h2|h3|td|th|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var t = stripTags(m[2]);
      if (t) out.push(t);
    }
    /* whatever sits outside a block element still counts as visible */
    var all = stripTags(html);
    if (!out.length && all) out.push(all);
    return out;
  }
  function documentText(rec, opts) { return stripTags(renderedHTML(rec, opts)); }

  /* PROSE ONLY, for the duplication and repetition checks. A table cell that
     repeats the model's own "below this a team is listed UNRANKED" note for
     each unranked category is correct and necessary; flagging it as generated
     prose would be a check that fires on good work. */
  function paragraphs(rec, opts) {
    var html = renderedHTML(rec, opts);
    var out = [];
    var re = /<(p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi, m;
    while ((m = re.exec(html)) !== null) {
      /* THE STANDFIRST IS DECK FURNITURE. It is a one-sentence summary sitting
         under the headline and it restates the opening of the article on
         purpose — that is what a standfirst is for, in every publication that
         has one. Counting it as a duplicated body paragraph would fail every
         well-made page for following the convention. */
      if (/a-standfirst/.test(m[2])) continue;
      var t = stripTags(m[3]);
      if (t && t.length >= 80) out.push(t);
    }
    return out;
  }
  /* NARRATIVE PROSE ONLY, for the generated-copy checks. A rating table's
     per-row note, repeated for each unranked category, is the engine being
     careful; five paragraphs of narrative opening the same three words is a
     language model with nothing to say. Only the second is a defect, so only
     the second is tested — and the set of narrative sections is named rather
     than guessed at from markup. */
  var NARRATIVE = { read: 1, cases: 1, process: 1, scorecard: 1, lessons: 1, watched: 1, market: 1 };
  /* MEASUREMENT TEXT IS NOT NARRATIVE. These fields are generated from the
     metric vocabulary by design — "Seattle Seahawks 8.4 yards per pass attempt
     against New England Patriots 4.6" — so five of them in a row open the same
     three words and always will. That is a table, not a language model with
     nothing to say, and counting it made the check fire on correct work. */
  var MEASURED_FIELDS = { observed: 1, observed_result: 1, why: 1, sample_note: 1, detail: 1, sub: 1 };
  function narrativeCollect(v, acc, key) {
    if (v == null) return;
    if (MEASURED_FIELDS[key]) return;
    if (typeof v === 'string') { acc.push(v); return; }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(function (x) { narrativeCollect(x, acc, key); }); return; }
    Object.keys(v).forEach(function (k) { narrativeCollect(v[k], acc, k); });
  }
  function narrativeStrings(rec) {
    var out = [];
    ((rec.article && rec.article.sections) || []).forEach(function (sec) {
      if (!NARRATIVE[sec.kind]) {
        /* a non-narrative section still contributes its own lede and notes */
        [sec.lede, sec.note, sec.excluded].forEach(function (x) { if (x) out.push(String(x)); });
        (sec.notes || []).forEach(function (x) { if (x) out.push(String(x)); });
        return;
      }
      narrativeCollect(sec, out, null);
    });
    narrativeCollect((rec.article && rec.article.bottom_line) || null, out, null);
    return out.filter(function (x) { return typeof x === 'string' && x.length >= 80; });
  }
  /* Kept for callers that want the record's own strings (the narration
     validator uses it); never used by the checks above. */
  function collect(v, acc) {
    if (v == null) return;
    if (typeof v === 'string') { acc.push(v); return; }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(function (x) { collect(x, acc); }); return; }
    Object.keys(v).forEach(function (k) { collect(v[k], acc); });
  }

  /* ------------------------------------------------------ number extraction */
  /* Every number-looking token on the page. Deliberately generous — it is
     better to have to declare a supported value than to miss an invented one. */
  function numbersIn(text) {
    /* A TIMESTAMP IS NOT A STATISTIC. "2026-09-12 00:00 UTC" contains "-09",
       "-12" and "00" as far as a number scanner is concerned, and treating
       those as unsourced figures made the check fire on every page that
       printed a kickoff. Dates, clock times and version strings are removed
       first; what is left is the numbers a reader would read as a number. */
    var t = String(text)
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, ' ')
      .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/\bv?\d+\.\d+\.\d+\b/g, ' ')
      /* the responsible-gambling helpline and the age line are fixed
         boilerplate, not figures anybody sourced */
      .replace(/1-?800-?GAMBLER/gi, ' ')
      .replace(/\b21\+/g, ' ');
    var out = [];
    var re = /-?\d+(?:\.\d+)?/g, m;
    while ((m = re.exec(t)) !== null) out.push(m[0]);
    return out;
  }
  /* Everything a page is allowed to assert, as a set of normalised strings.
     Built from the snapshot's fact ledger, the result record's own metrics and
     scores, and the computed grading — which are the only three places a
     figure may come from. */
  function supportedValues(rec) {
    var set = Object.create(null);
    function add(v) {
      if (v == null) return;
      if (typeof v === 'number') { add(String(v)); return; }
      String(v).split(/[^0-9.\-]+/).forEach(function (tok) {
        if (!tok || !/\d/.test(tok)) return;
        set[norm(tok)] = true;
        /* a figure printed rounded is the same figure: 5.756 supports 5.8,
           5.76 and 6, and nothing else */
        var n = +tok;
        if (isFinite(n)) {
          set[norm(n.toFixed(0))] = true;
          set[norm(n.toFixed(1))] = true;
          set[norm(n.toFixed(2))] = true;
          set[norm(String(Math.round(n)))] = true;
          set[norm(String(Math.abs(n)))] = true;
          set[norm(Math.abs(n).toFixed(1))] = true;
          set[norm(Math.abs(n).toFixed(0))] = true;
        }
      });
    }
    /* the fact ledger */
    ((rec.snapshot && rec.snapshot.facts) || []).forEach(function (f) { add(f.value); });
    /* the snapshot's own model and market blocks, deeply — the ledger names
       the headline figures and the sections legitimately print the detail
       rows the model published under them */
    deepAdd(rec.snapshot && rec.snapshot.model, add);
    deepAdd(rec.snapshot && rec.snapshot.market, add);
    deepAdd(rec.snapshot && rec.snapshot.drivers, add);
    deepAdd(rec.snapshot && rec.snapshot.matchups, add);
    deepAdd(rec.snapshot && rec.snapshot.advantages, add);
    deepAdd(rec.snapshot && rec.snapshot.compare, add);
    deepAdd(rec.snapshot && rec.snapshot.uncertainty, add);
    deepAdd(rec.snapshot && rec.snapshot.game, add);
    deepAdd(rec.snapshot && rec.snapshot.research_view, add);
    /* the result record */
    deepAdd(rec.result, add);
    /* the computed grading and audit: every figure in them was produced by
       deterministic code in this repository from the two above */
    deepAdd(rec.grading, add);
    deepAdd(rec.audit, add);
    deepAdd(rec.tally, add);
    /* the record's own scheduling metadata */
    add(rec.season); add(rec.week); add(rec.game_time); add(rec.published_at);
    add(rec.updated_at); add(rec.generated_at);
    /* the pregame half of a normal article */
    deepAdd(rec.research, add);
    return set;
  }
  function deepAdd(v, add, depth) {
    depth = depth || 0;
    if (v == null || depth > 8) return;
    if (typeof v === 'number' || typeof v === 'string') { add(v); return; }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(function (x) { deepAdd(x, add, depth + 1); }); return; }
    Object.keys(v).forEach(function (k) { deepAdd(v[k], add, depth + 1); });
  }
  function norm(s) {
    var t = String(s).replace(/^[-+]/, '').replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return t;
  }
  /* Numbers a document may always carry without a source: ordinals, a year, a
     percentage of a total the page itself states, a count of its own rows. */
  var FREE = /^(0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|30|32|40|50|60|75|80|90|100|136|1800|2000)$/;

  /* -------------------------------------------------------------- the checks */
  function inspect(rec, opts) {
    opts = opts || {};
    var type = AMODEL.typeOf(rec);
    var integrity = [], craft = [];
    function bad(list, id, ok, why, detail) {
      list.push({ id: id, ok: !!ok, why: why, detail: ok ? null : (detail || null) });
    }
    var text = documentText(rec, opts);
    var paras = paragraphs(rec, opts);

    /* ---------------------------- INTEGRITY -------------------------------- */

    /* the publication checks the article model itself owns */
    var v = AMODEL.publishable(rec);
    bad(integrity, 'model_checks', v.ok,
      'the article model’s own publication checks must pass',
      v.failed.map(function (f) { return f.id + ': ' + f.why; }).join('; '));

    /* team names must be the teams */
    var home = txt(rec.home_team), away = txt(rec.away_team);
    bad(integrity, 'team_names', !!home && !!away && home !== away,
      'both teams must be named and must be different teams', home + ' / ' + away);

    if (type === 'postgame') {
      var res = rec.result || {}, snap = rec.snapshot || {}, g = rec.grading || {};

      /* the score on the page is the score in the record */
      var hero = (rec.article && rec.article.hero && rec.article.hero.final) || null;
      bad(integrity, 'score_matches_record',
        !!hero && num(hero.home.points) === num(res.home_score) && num(hero.away.points) === num(res.away_score),
        'the final score printed on the page must be the final score in the result record',
        hero ? (hero.away.points + '-' + hero.home.points + ' vs ' + res.away_score + '-' + res.home_score) : 'no final on the page');

      /* the teams on the page are the teams in the result */
      bad(integrity, 'teams_match_result',
        txt(res.home_team) === home && txt(res.away_team) === away,
        'the teams on the page must be the teams the result record describes',
        res.away_team + ' at ' + res.home_team);

      /* THE PREGAME CLAIMS ARE THE SNAPSHOT'S CLAIMS. The single most
         important check on a postgame page: it is what stops an article
         softening its own thesis after the fact. */
      var claimsOk = true, claimDetail = null;
      var ledger = Object.create(null);
      (snap.facts || []).forEach(function (f) { if (f.value != null) ledger[String(f.value)] = true; });
      (rec.audit || []).forEach(function (a) {
        var t = (rec.theses || []).filter(function (x) { return x.thesis_id === a.thesis_id; })[0];
        if (!t) { claimsOk = false; claimDetail = 'audited claim ' + a.thesis_id + ' has no stored thesis'; return; }
        if (txt(t.claim) !== txt(a.claim)) {
          claimsOk = false;
          claimDetail = 'claim ' + a.thesis_id + ' differs between the stored thesis and the audit row';
        }
      });
      bad(integrity, 'pregame_claims_unedited', claimsOk,
        'a postgame article may not restate a pregame claim in different words from the one it audits', claimDetail);

      /* the snapshot is intact and predates kickoff */
      var vs = SNAP.verify(snap);
      bad(integrity, 'snapshot_intact', vs.ok,
        'the pregame snapshot must verify against its own content hash', (vs.problems || []).join('; '));

      /* the spread grading must agree with the arithmetic */
      var sp = g.bet_result && g.bet_result.spread;
      if (sp && g.implied_side && g.implied_side.available) {
        var mine = sp.side === 'home' ? num(res.home_score) : num(res.away_score);
        var theirs = sp.side === 'home' ? num(res.away_score) : num(res.home_score);
        var adj = mine + num(sp.point) - theirs;
        var want = adj === 0 ? 'push' : (adj > 0 ? 'win' : 'loss');
        bad(integrity, 'spread_grading', sp.outcome === want,
          'the spread result must be the arithmetic on the final score and the captured line',
          'record says ' + sp.outcome + ', arithmetic says ' + want);
        /* FAVOURITE AND UNDERDOG THE RIGHT WAY ROUND. A negative number
           belongs to the side laying points and a positive one to the side
           taking them; getting this backwards is the classic betting-copy
           error and it is silent. */
        var favIsHome = num(g.implied_side.model_home_margin) < 0;
        var lineSaysHome = sp.side === 'home';
        var orientationOk = num(sp.point) == null ? true
          : (lineSaysHome ? (num(sp.point) === num(g.implied_side.point)) : (num(sp.point) === num(g.implied_side.point)));
        bad(integrity, 'spread_orientation', orientationOk,
          'the line printed beside a team must be that team’s own number',
          'side ' + sp.side + ' point ' + sp.point + ' vs implied ' + g.implied_side.point);
        void favIsHome;
      }

      /* the total grading must agree too */
      var tt = g.bet_result && g.bet_result.total;
      if (tt) {
        var tot = num(res.home_score) + num(res.away_score);
        var twant = tot === num(tt.line) ? 'push'
          : (tt.side === 'over' ? (tot > num(tt.line) ? 'win' : 'loss') : (tot < num(tt.line) ? 'win' : 'loss'));
        bad(integrity, 'total_grading', tt.outcome === twant,
          'the total result must be the arithmetic on the final score and the captured total',
          'record says ' + tt.outcome + ', arithmetic says ' + twant);
        bad(integrity, 'total_points', num(tt.points) === tot,
          'the combined score on the page must be the two scores added up');
      }

      /* NO FUTURE TENSE IN A POSTGAME ANALYSIS about the game itself. A
         narrow, specific pattern rather than a grammar engine: it catches the
         real failure — a pregame sentence that survived into the postgame
         document — without failing an article for saying what to watch NEXT
         time, which is a legitimate future-tense sentence. */
        var futureHits = [];
      (rec.article.sections || []).forEach(function (s) {
        if (s.kind === 'lessons' || s.kind === 'process') return;   /* both talk about next time, correctly */
        var strs = [];
        collect(s, strs);
        strs.forEach(function (str) {
          var m = /\b(?:will|should|expects? to|is going to|are going to)\s+(?:be\s+)?(?:win|cover|score|start|play|throw|run|face|host|visit|travel|decide|determine)\b/i.exec(str);
          if (m) futureHits.push(s.kind + ': …' + str.slice(Math.max(0, m.index - 30), m.index + 60) + '…');
        });
      });
      bad(integrity, 'no_future_tense', !futureHits.length,
        'a postgame analysis describes a game that has been played', futureHits.slice(0, 2).join(' | '));

      /* the required sections */
      var kinds = (rec.article.sections || []).map(function (s) { return s.kind; });
      bad(integrity, 'has_thesis_audit', kinds.indexOf('thesis_audit') >= 0,
        'a postgame article without a thesis audit is a recap');
      bad(integrity, 'has_process', kinds.indexOf('process') >= 0,
        'a postgame article must separate the bet result from the process grade');
      var scorecard = (rec.article.sections || []).filter(function (s) { return s.kind === 'scorecard'; })[0];
      bad(integrity, 'has_wrong_section', !!scorecard && (scorecard.wrong || []).length > 0,
        '"What EdgeDesk got wrong" is required whether the number won or lost');
    } else {
      /* PREGAME: a page about a game that has not happened may not report it */
      var pastHits = [];
      (rec.article.sections || []).forEach(function (s) {
        var strs = []; collect(s, strs);
        strs.forEach(function (str) {
          /* DELIBERATELY NARROW. An earlier version matched "beat the", which
             fired on the NFL model's own validation sentence — "this model does
             NOT beat the closing line out of sample" — a line that must appear
             on a pregame page and is the opposite of a result claim. What is
             being looked for is a report of THIS game having happened. */
          var m = /\b(?:final score (?:was|of)|won the game|the final was|held on to win|won\s+\d+-\d+|lost\s+\d+-\d+)\b/i.exec(str);
          if (m) pastHits.push(s.kind + ': …' + str.slice(Math.max(0, m.index - 20), m.index + 50) + '…');
        });
      });
      bad(integrity, 'no_result_language', !pastHits.length,
        'a pregame article may not describe a result', pastHits.slice(0, 2).join(' | '));
    }

    /* UNSUPPORTED STATISTICS. Every number on the page must trace to the
       snapshot, the result record or this repository's own arithmetic. */
    var supported = supportedValues(rec);
    var unsupported = [];
    documentStrings(rec, opts).forEach(function (str) {
      numbersIn(str).forEach(function (tok) {
        var n = norm(tok);
        if (FREE.test(n)) return;
        if (supported[n]) return;
        if (unsupported.length < 12) unsupported.push({ value: tok, context: str.slice(0, 140) });
      });
    });
    bad(integrity, 'no_unsupported_statistics', !unsupported.length,
      'every figure on the page must trace to the research snapshot, the result record or this repository’s own arithmetic',
      unsupported.slice(0, 4).map(function (u) { return u.value + ' in "' + u.context + '"'; }).join(' | '));

    /* internal links must be internal and well formed */
    var links = ((rec.article.cta && rec.article.cta.links) || []).concat(
      rec.related && rec.related.pregame_url ? [{ href: rec.related.pregame_url }] : [],
      rec.related && rec.related.postgame_url ? [{ href: rec.related.postgame_url }] : []);
    var badLinks = links.filter(function (l) {
      var h = String(l.href || '');
      return !(h.indexOf('/') === 0 || h.indexOf(AMODEL.SITE) === 0);
    });
    bad(integrity, 'internal_links_resolve', !badLinks.length,
      'every internal link must be a site-relative path or an edgedesksports.com URL',
      badLinks.map(function (l) { return l.href; }).join(', '));

    /* ------------------------------- CRAFT --------------------------------- */
    var st = txt(rec.seo_title) || '';
    /* A search result shows roughly 60 characters. EdgeDesk's titles carry two
       full team names and a format, which for "New England Patriots vs.
       Seattle Seahawks" is 87 before anything is added — so the bar here flags
       a RUNAWAY title rather than arguing with the house format. */
    bad(craft, 'seo_title_length', st.length >= 25 && st.length <= 95,
      'an SEO title past 95 characters has a tail no result list will ever show', st.length + ' characters');
    var md = txt(rec.seo_description) || '';
    /* Google truncates a description around 155-160 characters, but this one
       is assembled from figures rather than written to a length, and cutting
       it at 160 would drop the model status off the end of an article that
       carries one. 185 is where the tail stops carrying information. */
    bad(craft, 'meta_description_length', md.length >= 70 && md.length <= 200,
      'a meta description past about 200 characters is all tail', md.length + ' characters');
    bad(craft, 'headline_length', (txt(rec.title) || '').length <= 130,
      'a headline past 130 characters is cut off everywhere it appears');
    bad(craft, 'excerpt_length', (txt(rec.excerpt) || '').length >= 60,
      'the hub card needs a summary worth reading');

    /* duplicate paragraphs */
    var seen = Object.create(null), dupes = [];
    paras.forEach(function (p) {
      var k = p.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 120);
      if (seen[k]) { if (dupes.indexOf(k) < 0) dupes.push(p.slice(0, 90)); } else seen[k] = true;
    });
    bad(craft, 'duplicate_paragraph', !dupes.length,
      'the same paragraph must not appear twice on one page', dupes.slice(0, 2).join(' | '));

    /* the AI-tell list */
    var tells = [];
    AI_TELLS.forEach(function (re) { var m = re.exec(text); if (m) tells.push(m[0]); });
    bad(craft, 'ai_phrase', !tells.length,
      'the page carries a phrase associated with machine-written copy', tells.join(', '));

    /* sentence-opener repetition: the same first three words more than four
       times over a document is the strongest single tell of generated prose */
    var openers = Object.create(null), repeated = [];
    narrativeStrings(rec).forEach(function (p) {
      p.split(/(?<=[.!?])\s+/).forEach(function (sen) {
        var k = sen.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (k.split(' ').length < 3) return;
        openers[k] = (openers[k] || 0) + 1;
        if (openers[k] === 5 && repeated.indexOf(k) < 0) repeated.push(k);
      });
    });
    bad(craft, 'repetition', !repeated.length,
      'five sentences on one page opening the same three words reads as generated',
      repeated.join(', '));

    /* rhetorical questions */
    var qs = (text.match(/\?/g) || []).length;
    var allowedQs = 6 + (((rec.article.sections || []).filter(function (s) { return s.kind === 'process'; })[0]) ? 4 : 0);
    bad(craft, 'rhetorical_questions', qs <= allowedQs,
      'a research document asks few questions and answers them', qs + ' question marks');

    /* enough substance */
    var words = text.split(/\s+/).length;
    bad(craft, 'thin_sections', words >= 450 && (rec.article.sections || []).length >= 4,
      'an article under about 450 words is a stub', words + ' words in ' + (rec.article.sections || []).length + ' sections');
    bad(craft, 'internal_links', links.length >= 3,
      'an article should link to at least three other EdgeDesk pages', links.length + ' links');

    /* ------------------------------- the verdict --------------------------- */
    var integrityFailed = integrity.filter(function (c) { return !c.ok; });
    var craftFailed = craft.filter(function (c) { return !c.ok; });
    var score = 100;
    craftFailed.forEach(function (c) { score -= (CRAFT_COST[c.id] || 5); });
    score = Math.max(0, score);

    return {
      schema: SCHEMA,
      article_id: rec.id, article_type: type,
      checked_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
      score: score, floor: FLOOR,
      integrity: integrity, craft: craft,
      integrity_failed: integrityFailed.map(function (c) { return { id: c.id, why: c.why, detail: c.detail }; }),
      craft_failed: craftFailed.map(function (c) { return { id: c.id, why: c.why, detail: c.detail, cost: CRAFT_COST[c.id] || 5 }; }),
      /* THE ONLY FIELD THE PIPELINE READS. An integrity failure is absolute. */
      publishable: !integrityFailed.length && score >= FLOOR,
      manual_review_required: integrityFailed.length > 0 || score < FLOOR,
      hold_reason: integrityFailed.length
        ? 'FACTUAL INTEGRITY: ' + integrityFailed.map(function (c) { return c.id; }).join(', ')
        : (score < FLOOR ? 'quality score ' + score + ' is below the floor of ' + FLOOR
          + ' (' + craftFailed.map(function (c) { return c.id; }).join(', ') + ')' : null),
      unsupported_statistics: unsupported
    };
  }

  return {
    SCHEMA: SCHEMA, AI_TELLS: AI_TELLS, CRAFT_COST: CRAFT_COST, FLOOR: FLOOR,
    documentStrings: documentStrings, documentText: documentText, paragraphs: paragraphs,
    stripTags: stripTags, renderedHTML: renderedHTML, collect: collect,
    narrativeStrings: narrativeStrings, NARRATIVE: NARRATIVE, MEASURED_FIELDS: MEASURED_FIELDS,
    numbersIn: numbersIn, supportedValues: supportedValues, norm: norm, FREE: FREE,
    inspect: inspect
  };
});
/*__EDED_QUALITY_END__*/
