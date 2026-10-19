/*__EDDESK_START__*/
/* ============================================================================
   THE DESK — data-first articles, written in my voice, traceable to the row.

   WHAT THIS FILE IS. The one module every half of the desk shares: the
   generators (tools/desk/generators.js) build drafts with it, the static
   build renders them with it, the owner's admin page previews and traces
   them with it, and the distribution kit is cut from it. Loads in Node and in
   a browser from one file, so the admin preview cannot differ from the page.

   THE RULE IT EXISTS TO KEEP. If my pipeline does not own a number, an
   article does not print it. Every figure in a draft is written through
   `Builder.n()`, which runs a QUERY against a named source file and records
   the query, the raw value and the exact text printed. The verifier
   (`verifyDraft`) re-runs every query, re-formats every value, and then reads
   the body back and refuses any number that did not come through n(). A
   number a template typed by hand fails the build.

   IT COMPUTES NOTHING ABOUT THE MODEL. A query can select, filter, count,
   sum, average and subtract owned values: reporting arithmetic. It never
   produces a projection, a probability, an EV, a grade or a ranking the
   pipeline did not already publish. Research protocol is frozen; the desk
   reads it.

   THE VOICE. First person singular, no em dashes, no hype, no third-person
   "EdgeDesk thinks". `voiceCheck` holds a generated draft to it. A person's
   own "My take" is theirs and is never rewritten; it is only required.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SITE = 'https://edgedesksports.com';
  var VERSION = 'edgedesk_desk_v1';

  /* ------------------------------------------------------------- author */
  /* One person, stated once. The photo is optional on purpose: the file is
     the owner's to supply (assets/author/), and until it exists the page
     draws initials and the structured data carries no image rather than a
     placeholder pretending to be a face. */
  var AUTHOR = {
    name: 'Davis Rackler',
    initials: 'DR',
    url: SITE + '/articles/author/davis-rackler/',
    path: '/articles/author/davis-rackler/',
    photo: '/assets/author/davis-rackler.jpg',
    job: 'Founder, EdgeDesk',
    bio: 'I am a Navy submarine veteran, and I am building EdgeDesk. Every number I publish is graded against the closing line in public, misses included.',
    short: 'Navy submarine veteran, building EdgeDesk.',
    record_url: SITE + '/record.html',
    record_label: 'My live CLV record',
    sameAs: []
  };

  /* --------------------------------------------------------------- types */
  /* The five data-first types, plus the two game types the editorial
     pipeline already writes, so Article Performance can compare them. */
  var TYPES = {
    weekly_clv:     { label: 'Weekly CLV Report', short: 'CLV report', slug: 'clv-report' },
    disagreement:   { label: 'Where My Number Disagrees', short: 'Disagreements', slug: 'where-my-number-disagrees' },
    line_movement:  { label: 'Line Movement Recap', short: 'Line moves', slug: 'line-movement' },
    got_wrong:      { label: 'What I Got Wrong', short: 'Misses', slug: 'what-i-got-wrong' },
    research_notes: { label: 'Research Notes', short: 'Research note', slug: 'research-note' }
  };
  var GAME_TYPES = { pregame: 'Pregame research', postgame: 'Postgame analysis' };
  function typeLabel(t) { return (TYPES[t] && TYPES[t].label) || GAME_TYPES[t] || t || 'Article'; }

  /* THE TAKE. The one section a machine never writes. Publishing is refused
     below this length in the database (desk_settings.min_take_chars), in the
     admin page and in the build; this is the default all three start from. */
  var MIN_TAKE_CHARS = 240;

  /* ---------------------------------------------------------- the query */
  /* A query names a source and a path through it. Steps:
       'key'            obj[key]
       3                arr[3]
       '*'              the values of an object (a map of games by id)
       {find: conds}    the first element matching every condition
       {filter: conds}  every element matching
     then optionally
       agg: {fn: count|sum|avg|min|max, field: 'a.b'}   over the array
     or a derived query
       {op: 'sub'|'add', args: [q1, q2]}
     A condition is [field, op, value]; value may be {field: 'x.y'} to compare
     two fields of the same element. Every query is plain JSON, so it is
     stored beside the number it produced and can be re-run years later. */
  function dig(o, dotted) {
    if (dotted == null || dotted === '') return o;
    var parts = String(dotted).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (o == null) return undefined;
      o = o[parts[i]];
    }
    return o;
  }
  function condOk(el, c) {
    var a = dig(el, c[0]), op = c[1], b = c[2];
    if (b && typeof b === 'object' && !Array.isArray(b) && b.field) b = dig(el, b.field);
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '>': return a != null && b != null && a > b;
      case '>=': return a != null && b != null && a >= b;
      case '<': return a != null && b != null && a < b;
      case '<=': return a != null && b != null && a <= b;
      case 'in': return Array.isArray(b) && b.indexOf(a) >= 0;
      case 'notnull': return a != null;
      case 'null': return a == null;
      default: throw new Error('query: unknown operator ' + op);
    }
  }
  function matchAll(el, conds) {
    for (var i = 0; i < (conds || []).length; i++) if (!condOk(el, conds[i])) return false;
    return true;
  }
  function listOf(o) {
    if (Array.isArray(o)) return o;
    if (o && typeof o === 'object') return Object.keys(o).sort().map(function (k) { return o[k]; });
    return [];
  }
  function walk(doc, path) {
    var o = doc;
    for (var i = 0; i < (path || []).length; i++) {
      var s = path[i];
      if (o == null) return undefined;
      if (s === '*') { o = listOf(o); continue; }
      if (typeof s === 'string' || typeof s === 'number') { o = o[s]; continue; }
      if (s && s.find) { o = listOf(o).filter(function (el) { return matchAll(el, s.find); })[0]; continue; }
      if (s && s.filter) { o = listOf(o).filter(function (el) { return matchAll(el, s.filter); }); continue; }
      throw new Error('query: bad step ' + JSON.stringify(s));
    }
    return o;
  }
  function aggregate(arr, agg) {
    if (!Array.isArray(arr)) throw new Error('query: aggregate over a non-list');
    if (agg.fn === 'count') return arr.length;
    var vals = arr.map(function (el) { return dig(el, agg.field); }).filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (agg.fn === 'sum') return vals.reduce(function (s, v) { return s + v; }, 0);
    if (!vals.length) return null;
    if (agg.fn === 'avg') return vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    if (agg.fn === 'min') return Math.min.apply(null, vals);
    if (agg.fn === 'max') return Math.max.apply(null, vals);
    throw new Error('query: unknown aggregate ' + agg.fn);
  }
  /* sources: { id: { doc, file, sha256, generated_at } } */
  function evalQuery(sources, q) {
    if (q.op) {
      var a = evalQuery(sources, q.args[0]), b = evalQuery(sources, q.args[1]);
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      var r = q.op === 'sub' ? a - b : q.op === 'add' ? a + b : q.op === 'abs_sub' ? Math.abs(a - b) : NaN;
      if (!isFinite(r)) throw new Error('query: unknown op ' + q.op);
      return Math.round(r * 1e9) / 1e9;
    }
    var src = sources[q.src];
    if (!src) throw new Error('query: no source "' + q.src + '"');
    var v = walk(src.doc, q.path);
    if (q.agg) v = aggregate(v, q.agg);
    return v;
  }
  function describeQuery(q, sources) {
    if (q.op) {
      var w = { sub: ') minus (', add: ') plus (', abs_sub: ') distance from (' }[q.op] || ') ? (';
      return '(' + describeQuery(q.args[0], sources) + w + describeQuery(q.args[1], sources) + ')';
    }
    var file = (sources && sources[q.src] && sources[q.src].file) || q.src;
    var p = (q.path || []).map(function (s) {
      if (s === '*') return '*';
      if (typeof s === 'string' || typeof s === 'number') return String(s);
      var conds = (s.find || s.filter).map(function (c) {
        var v = c[2] && typeof c[2] === 'object' && !Array.isArray(c[2]) ? c[2].field : JSON.stringify(c[2]);
        return c[0] + ' ' + c[1] + (c[1] === 'notnull' || c[1] === 'null' ? '' : ' ' + v);
      }).join(' and ');
      return (s.find ? 'first[' : 'all[') + conds + ']';
    }).join(' > ');
    var agg = q.agg ? ' | ' + q.agg.fn + (q.agg.field ? '(' + q.agg.field + ')' : '') : '';
    return file + ' :: ' + p + agg;
  }

  /* ------------------------------------------------------------ formats */
  /* The ONLY ways a number becomes text. The verifier re-formats each stored
     value through the same function and the result must equal what was
     printed, so a display can never drift from its value. ASCII "-" for
     minus throughout: it survives Reddit, Discord and a plain-text email. */
  function trim(n, dp) {
    var s = Number(n).toFixed(dp);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function signed(n, dp, keepZeros) {
    var s = keepZeros ? Number(n).toFixed(dp) : trim(n, dp);
    if (Number(s) === 0) return keepZeros ? Number(0).toFixed(dp) : '0';
    return (n > 0 ? '+' : '') + s;
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function fmt(v, f) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return null;
    switch (f) {
      case 'int': return String(Math.round(v));
      case 'num1': return trim(v, 1);
      case 'num2': return trim(v, 2);
      case 'fix2': return Number(v).toFixed(2);
      case 'fix3': return Number(v).toFixed(3);
      case 'fix4': return Number(v).toFixed(4);
      case 'pts': return signed(v, 1);                         /* +5.5, -2, 0 */
      case 'pts2': return signed(v, 2, true);                  /* +0.51, -0.07, 0.00 */
      case 'pts3': return signed(v, 3, true);                  /* +0.095 */
      case 'line': return v === 0 ? 'PK' : (v > 0 ? '+' : '') + trim(v, 2);
      case 'odds': return (v > 0 ? '+' : '') + String(Math.round(v));
      case 'units': return signed(v, 2, true) + 'u';
      case 'pct1': return Number(v).toFixed(1) + '%';
      case 'pct0': return String(Math.round(v)) + '%';
      case 'prob1': return (Number(v) * 100).toFixed(1) + '%';
      case 'prob0': return String(Math.round(Number(v) * 100)) + '%';
      case 'date': { var d = new Date(Date.parse(v)); return isFinite(d) ? MON[d.getUTCMonth()] + ' ' + d.getUTCDate() : null; }
      case 'month': { var m = /^(\d{4})-(\d{2})/.exec(String(v)); return m ? MONTH[Number(m[2]) - 1] + ' ' + m[1] : null; }
      case 'text': return String(v);
      default: throw new Error('format: unknown ' + f);
    }
  }

  /* ------------------------------------------------------------ builder */
  /* A draft is written through one of these. n() prints a number, t() prints
     a fact (a team, a book, a label), v() reads a value for a decision and
     prints nothing. Only n() and t() can put data on the page. */
  function Builder(sources) {
    this.sources = sources;
    this.numbers = [];
    this.facts = [];
    this.blocks = [];
    this._keys = Object.create(null);
  }
  Builder.prototype._key = function (k) {
    var key = k, i = 2;
    while (this._keys[key]) key = k + '#' + (i++);
    this._keys[key] = true;
    return key;
  };
  Builder.prototype.v = function (q) { return evalQuery(this.sources, q); };
  Builder.prototype.n = function (key, q, f) {
    var val = evalQuery(this.sources, q);
    var disp = fmt(val, f);
    if (disp == null) throw new Error('desk: "' + key + '" has no value at ' + describeQuery(q, this.sources));
    this.numbers.push({ key: this._key(key), value: val, display: disp, format: f, query: q });
    return disp;
  };
  Builder.prototype.t = function (key, q) {
    var val = evalQuery(this.sources, q);
    if (val == null || val === '') throw new Error('desk: fact "' + key + '" is empty at ' + describeQuery(q, this.sources));
    var s = String(val);
    this.facts.push({ key: this._key(key), value: s, query: q });
    return s;
  };
  Builder.prototype.h = function (s) { this.blocks.push('## ' + s); return this; };
  Builder.prototype.h3 = function (s) { this.blocks.push('### ' + s); return this; };
  Builder.prototype.p = function (s) { if (s) this.blocks.push(String(s)); return this; };
  Builder.prototype.ul = function (items) {
    items = (items || []).filter(Boolean);
    if (items.length) this.blocks.push(items.map(function (x) { return '- ' + x; }).join('\n'));
    return this;
  };
  Builder.prototype.note = function (s) { if (s) this.blocks.push('> ' + s); return this; };
  Builder.prototype.table = function (head, rows) {
    if (!rows || !rows.length) return this;
    var cell = function (c) { return String(c == null ? '' : c).replace(/\|/g, '/').replace(/\n/g, ' '); };
    var lines = ['| ' + head.map(cell).join(' | ') + ' |', '|' + head.map(function () { return '---'; }).join('|') + '|'];
    rows.forEach(function (r) { lines.push('| ' + r.map(cell).join(' | ') + ' |'); });
    this.blocks.push(lines.join('\n'));
    return this;
  };
  Builder.prototype.md = function () { return this.blocks.join('\n\n') + '\n'; };

  /* ---------------------------------------------------------- the voice */
  var VOICE_RULES = [
    { id: 'em_dash', re: /[—–]/, why: 'no em or en dashes' },
    { id: 'plural', re: /\b(we|We|WE|our|Our|ours|Ours|us)\b/, why: 'first person singular: "I", never "we"' },
    { id: 'third_person', re: /\bEdgeDesk(’s|'s)?\s+(thinks|believes|prices|projects|sees|says|makes|leans|model|number|numbers|line|projection|projected|published)\b/, why: 'it is "my model" and "my number", not EdgeDesk’s' },
    { id: 'hype', re: /\b(lock|locks|lock of|sharp|sharps|hammer|slam|smash|guaranteed|can'?t lose|free money|sure thing|max bet|best bet|whale|bomb|banger)\b/i, why: 'no hype and no sharp talk' },
    { id: 'advice', re: /\b(you should (bet|take|play)|bet (it|this|now)|take the (over|under|points)|play of the (day|week)|tail (me|this))\b/i, why: 'research, never a recommendation' }
  ];
  /* Strip what is not prose before checking: URLs and link targets. */
  function prose(text) {
    return String(text || '').replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
  }
  function voiceCheck(text) {
    var t = prose(text), issues = [];
    VOICE_RULES.forEach(function (r) {
      var m = r.re.exec(t);
      if (m) issues.push({ id: r.id, why: r.why, found: m[0], at: t.slice(Math.max(0, m.index - 40), m.index + 40) });
    });
    if (!/\b(I|my|My|me|I'm|I've)\b/.test(t)) issues.push({ id: 'first_person', why: 'a draft is written as me', found: '', at: '' });
    return { ok: !issues.length, issues: issues };
  }

  /* ------------------------------------------------------- the verifier */
  /* Every numeric token in the text must be one some n() or t() printed. */
  var NUM_RE = /[+\-]?\d+(?:\.\d+)?/g;
  /* "4-9" is a record and "2024-25" a span: a hyphen between two digits
     separates them, it is not a minus sign */
  function numberTokens(text) {
    return (prose(text).replace(/(\d)-(?=\d)/g, '$1 ').match(NUM_RE) || []).map(function (s) { return s.replace(/^\+/, ''); });
  }
  function verifyDraft(draft, sources) {
    var problems = [], checked = 0;
    (draft.numbers || []).forEach(function (n) {
      var v;
      try { v = evalQuery(sources, n.query); } catch (e) { problems.push({ key: n.key, why: 'query failed: ' + e.message }); return; }
      if (typeof v === 'number' && typeof n.value === 'number' ? Math.abs(v - n.value) > 1e-9 : v !== n.value) {
        problems.push({ key: n.key, why: 'source now says ' + JSON.stringify(v) + ', draft says ' + JSON.stringify(n.value) });
      }
      if (fmt(n.value, n.format) !== n.display) problems.push({ key: n.key, why: 'display "' + n.display + '" is not the formatted value' });
      checked++;
    });
    (draft.facts || []).forEach(function (f) {
      var v;
      try { v = evalQuery(sources, f.query); } catch (e) { problems.push({ key: f.key, why: 'query failed: ' + e.message }); return; }
      if (String(v) !== f.value) problems.push({ key: f.key, why: 'source now says ' + JSON.stringify(v) });
      checked++;
    });
    var allowed = Object.create(null);
    (draft.numbers || []).forEach(function (n) { numberTokens(n.display).forEach(function (t) { allowed[t] = true; }); });
    (draft.facts || []).forEach(function (f) { numberTokens(f.value).forEach(function (t) { allowed[t] = true; }); });
    var text = [draft.title, draft.lead, (draft.highlights || []).join('\n'), draft.description, draft.body_md].join('\n');
    var stray = numberTokens(text).filter(function (t) { return !allowed[t]; });
    if (stray.length) problems.push({ key: '(text)', why: 'numbers printed without a source: ' + stray.slice(0, 12).join(', ') });
    return { ok: !problems.length, checked: checked, problems: problems };
  }

  /* -------------------------------------------------------- the take */
  function takeCheck(take, min) {
    min = min || MIN_TAKE_CHARS;
    var s = String(take || '').replace(/\s+/g, ' ').trim();
    var notes = [];
    if (/[—–]/.test(s)) notes.push('It has an em dash. Your voice rules say no em dashes; it is your call.');
    if (/\b(we|our)\b/i.test(s)) notes.push('It says "we" or "our". Your voice rules say "I".');
    return { ok: s.length >= min, chars: s.length, min: min, short_by: Math.max(0, min - s.length), notes: notes };
  }

  /* ------------------------------------------------------- the renderer */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* Only my own site is linked from a body, and only over https or a path. */
  function safeHref(u) {
    u = String(u || '').trim();
    if (/^\/[^/\\]/.test(u) || u === '/') return u;
    if (/^https:\/\/edgedesksports\.com(\/|$)/.test(u)) return u;
    return null;
  }
  function inline(s) {
    var out = '', re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g, last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[1] != null) out += '<b>' + esc(m[1]) + '</b>';
      else {
        var href = safeHref(m[3]);
        out += href ? '<a href="' + esc(href) + '">' + esc(m[2]) + '</a>' : esc(m[2]);
      }
      last = re.lastIndex;
    }
    return out + esc(s.slice(last));
  }
  /* A deliberately small Markdown: headings, paragraphs, lists, tables,
     callouts, bold and links to this site. Everything is escaped first; there
     is no HTML passthrough. */
  function mdToHtml(md) {
    var blocks = String(md || '').replace(/\r/g, '').split(/\n{2,}/);
    return blocks.map(function (b) {
      b = b.replace(/^\n+|\n+$/g, '');
      if (!b) return '';
      if (/^### /.test(b)) return '<h3 class="d-h3">' + inline(b.slice(4)) + '</h3>';
      if (/^## /.test(b)) return '<h2 class="d-h2" id="' + esc(anchor(b.slice(3))) + '">' + inline(b.slice(3)) + '</h2>';
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^- /.test(l); })) {
        return '<ul class="d-ul">' + lines.map(function (l) { return '<li>' + inline(l.slice(2)) + '</li>'; }).join('') + '</ul>';
      }
      if (lines.length >= 2 && /^\|/.test(lines[0]) && /^\|(-+\|)+$/.test(lines[1].replace(/\s/g, ''))) {
        var cells = function (l) { return l.replace(/^\|\s?|\s?\|$/g, '').split(' | '); };
        var head = cells(lines[0]);
        return '<div class="d-tw"><table class="d-table"><thead><tr>' + head.map(function (c) { return '<th scope="col">' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
          + lines.slice(2).map(function (l) {
            return '<tr>' + cells(l).map(function (c, i) { return '<td data-l="' + esc(head[i] || '') + '">' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
      }
      if (lines.every(function (l) { return /^> /.test(l); })) {
        return '<p class="d-note">' + inline(lines.map(function (l) { return l.slice(2); }).join(' ')) + '</p>';
      }
      return '<p>' + inline(lines.join(' ')) + '</p>';
    }).join('\n');
  }
  function anchor(s) { return 'd-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  /* A take is the owner's own text: paragraphs, escaped, nothing else. */
  function takeHtml(take) {
    return String(take || '').replace(/\r/g, '').split(/\n{2,}/).map(function (p) { return p.trim(); })
      .filter(Boolean).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  /* Plain text of a body, for Reddit and the kit: tables become lines. */
  function mdToText(md) {
    return String(md || '').split(/\n{2,}/).map(function (b) {
      var lines = b.split('\n');
      if (lines.length >= 2 && /^\|/.test(lines[0]) && /^\|(-+\|)+$/.test(lines[1].replace(/\s/g, ''))) {
        var head = lines[0].replace(/^\|\s?|\s?\|$/g, '').split(' | ');
        return lines.slice(2).map(function (l) {
          var c = l.replace(/^\|\s?|\s?\|$/g, '').split(' | ');
          return '- ' + c.map(function (x, i) { return i === 0 ? x : head[i] + ': ' + x; }).join(', ');
        }).join('\n');
      }
      return b.replace(/^#+ /, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^> /gm, '');
    }).join('\n\n');
  }

  /* --------------------------------------------------------------- UTM */
  var CHANNELS = {
    x:        { source: 'x', medium: 'social', label: 'X' },
    linkedin: { source: 'linkedin', medium: 'social', label: 'LinkedIn' },
    discord:  { source: 'discord', medium: 'community', label: 'Discord' },
    reddit:   { source: 'reddit', medium: 'community', label: 'Reddit' },
    newsletter: { source: 'newsletter', medium: 'email', label: 'Newsletter' }
  };
  function campaignOf(slug) { return ('desk_' + String(slug || '').replace(/[^a-z0-9-]/g, '')).slice(0, 64); }
  function utm(url, channel, article) {
    var c = CHANNELS[channel];
    if (!c) throw new Error('utm: unknown channel ' + channel);
    if (!/^https:\/\/edgedesksports\.com(\/|$)/.test(String(url))) return url;
    var hash = '', u = String(url), i = u.indexOf('#');
    if (i >= 0) { hash = u.slice(i); u = u.slice(0, i); }
    var q = 'utm_source=' + c.source + '&utm_medium=' + c.medium + '&utm_campaign=' + encodeURIComponent(campaignOf(article.slug))
      + '&utm_content=' + encodeURIComponent(article.type || 'article');
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + q + hash;
  }

  /* ------------------------------------------------- the distribution kit */
  /* One post per channel, generated, never posted. Each leads with the
     article's single most interesting number (its `lead`), and each is held
     to the rule the old auto-posts never met: it links to a PUBLISHED
     article and it carries a number that article printed. Reddit is the
     exception on links: the value is delivered in the post, plain text, and
     the link waits for a comment where the subreddit allows one. */
  var X_URL_LEN = 23;   /* X counts every link as 23 characters */
  function clip(s, n) { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '...'; }
  function firstSentences(s, n) {
    var parts = String(s || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(\s|$)/g) || [String(s || '').trim()];
    return parts.slice(0, n).join('').trim();
  }
  function kit(article) {
    var a = article, url = a.url;
    var lead = String(a.lead || '').trim(), hi = (a.highlights || []).filter(Boolean);
    var take = firstSentences(a.take, 2);
    var xUrl = utm(url, 'x', a), liUrl = utm(url, 'linkedin', a), dUrl = utm(url, 'discord', a), rUrl = utm(url, 'reddit', a);

    var room = 280 - X_URL_LEN - 2;
    var x = lead;
    if (hi[0] && (x + ' ' + hi[0]).length <= room) x += ' ' + hi[0];
    if ((x + ' Misses included.').length <= room) x += ' Misses included.';
    x = clip(x, room) + '\n' + xUrl;

    var li = [lead].concat(hi.slice(0, 3)).join('\n\n')
      + (take ? '\n\nMy take: ' + take : '')
      + '\n\nEvery number links to the row it came from, and every miss stays on the record.\n' + liUrl;

    var dc = '**' + lead + '**\n' + hi.slice(0, 3).map(function (h) { return '- ' + h; }).join('\n')
      + (take ? '\n> ' + take : '') + '\n' + dUrl;

    var rTitle = clip(a.reddit_title || lead, 290);
    var rBody = [lead, ''].concat(hi.map(function (h) { return '- ' + h; })).join('\n')
      + '\n\n' + clip(mdToText(a.body_md), 6000)
      + (a.take ? '\n\nMy take:\n\n' + String(a.take).trim() : '')
      + '\n\nHow I grade this: every number above comes from my own logged data, graded against the close, losses included. Happy to answer questions on method.';
    var rComment = 'The full write-up, with the table and the sources for every number: ' + rUrl;

    var out = {
      x: { channel: 'x', text: x, chars: x.length - xUrl.length + X_URL_LEN, url: xUrl },
      linkedin: { channel: 'linkedin', text: li, url: liUrl },
      discord: { channel: 'discord', text: dc, url: dUrl },
      reddit: { channel: 'reddit', title: rTitle, text: rBody, comment: rComment, url: rUrl }
    };
    Object.keys(out).forEach(function (k) { out[k].check = snippetCheck(out[k], a); });
    return out;
  }
  /* A snippet must quote a number the article printed, link to the
     published article (Reddit: in the comment, never in the body), and keep
     the voice. Returns the reasons it fails, never a silent pass. */
  function snippetCheck(snip, article) {
    var why = [];
    /* the article's own lead number, read from the post's prose: a digit in
       a link does not count as quoting anything */
    var said = numberTokens(snip.text);
    var hasNumber = numberTokens(article.lead || '').some(function (t) { return said.indexOf(t) >= 0; });
    if (!hasNumber) why.push('it quotes no number from the article\u2019s lead');
    if (!article.published) why.push('the article is not published, so there is nothing to link to');
    var base = String(article.url || '').split('?')[0];
    if (snip.channel === 'reddit') {
      if (/https?:\/\//.test(snip.text) || /edgedesksports\.com/.test(snip.text)) why.push('a Reddit body carries no link');
      if (String(snip.comment || '').indexOf(base) < 0) why.push('the Reddit comment does not link the article');
    } else if (String(snip.text).indexOf(base) < 0) {
      why.push('it does not link the article');
    }
    var v = voiceCheck(String(snip.text).replace(/My take:[\s\S]*$/, ''));
    v.issues.filter(function (i) { return i.id !== 'first_person'; }).forEach(function (i) { why.push(i.why + ' ("' + i.found + '")'); });
    return { ok: !why.length, why: why };
  }

  return {
    SITE: SITE, VERSION: VERSION, AUTHOR: AUTHOR, TYPES: TYPES, GAME_TYPES: GAME_TYPES, typeLabel: typeLabel,
    MIN_TAKE_CHARS: MIN_TAKE_CHARS, CHANNELS: CHANNELS,
    evalQuery: evalQuery, describeQuery: describeQuery, walk: walk, fmt: fmt,
    Builder: Builder, voiceCheck: voiceCheck, verifyDraft: verifyDraft, numberTokens: numberTokens,
    takeCheck: takeCheck, mdToHtml: mdToHtml, mdToText: mdToText, takeHtml: takeHtml, esc: esc, anchor: anchor,
    utm: utm, campaignOf: campaignOf, kit: kit, snippetCheck: snippetCheck
  };
});
/*__EDDESK_END__*/
