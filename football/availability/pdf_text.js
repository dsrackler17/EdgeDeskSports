/* ============================================================================
   TEXT OUT OF A PDF, WITH NO DEPENDENCIES.

   WHY THIS IS HERE. Conference availability reports and team game notes are
   published as PDFs at least as often as HTML, and this repository runs on a
   bare Node install by design. Without a reader, every PDF source is a source
   EdgeDesk cannot ingest, and "we could not read the format" quietly becomes
   "no report exists" — the exact substitution the availability layer is built
   to refuse.

   WHAT IT DOES AND DOES NOT DO. It walks the file's content streams, inflates
   the ones that are Flate-encoded (zlib is in Node core), and pulls the string
   operands of the text-showing operators — Tj, TJ, ' and " — decoding the
   PDF's own escapes and its hex-string form. Text positioning operators are
   used only to decide where a line break goes.

   IT DOES NOT RENDER. A PDF that stores its text as vector outlines or as a
   scanned image carries no extractable string, and this returns nothing for
   it and SAYS SO through `ok:false` with a reason. Nothing here guesses at
   glyph codes through a custom font encoding either: a stream that decodes to
   text a human would not recognise is text this cannot vouch for, so the
   caller is told how much was extracted and can refuse it. A caller that
   cannot read a report must record a failed read, never an empty one.

   Node only (it needs zlib). The HTML path lives in collectors.js.
   ========================================================================== */
'use strict';
const zlib = require('zlib');

/* Every `stream ... endstream` in the file, with the dictionary that precedes
   it, as raw bytes. Buffers rather than strings, because a PDF is binary and
   decoding it as UTF-8 first corrupts the very streams this needs. */
function streams(buf) {
  const out = [];
  const MARK = Buffer.from('stream');
  const END = Buffer.from('endstream');
  let i = 0;
  while (i < buf.length) {
    const s = buf.indexOf(MARK, i);
    if (s < 0) break;
    /* the dictionary is whatever preceded it back to the nearest `<<` */
    const dictStart = buf.lastIndexOf(Buffer.from('<<'), s);
    const dict = dictStart >= 0 ? buf.slice(dictStart, s).toString('latin1') : '';
    let p = s + MARK.length;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    const e = buf.indexOf(END, p);
    if (e < 0) break;
    out.push({ dict, body: buf.slice(p, e) });
    i = e + END.length;
  }
  return out;
}

function inflate(s) {
  if (/\/Filter\s*\/FlateDecode/.test(s.dict) || /\/Filter\s*\[\s*\/FlateDecode/.test(s.dict)) {
    try { return zlib.inflateSync(s.body); } catch (_) {
      try { return zlib.inflateRawSync(s.body); } catch (_2) { return null; }
    }
  }
  /* an unfiltered stream is already its own content */
  if (!/\/Filter/.test(s.dict)) return s.body;
  /* any other filter (DCT, CCITT, JBIG2 ...) is an image, not text */
  return null;
}

/* A PDF literal string: `(...)` with backslash escapes and balanced parens. */
function readLiteral(t, i) {
  let depth = 1, out = '';
  i++;
  while (i < t.length && depth > 0) {
    const c = t[i];
    if (c === '\\') {
      const n = t[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b' || n === 'f') out += ' ';
      else if (n >= '0' && n <= '7') {
        let oct = '';
        let j = i + 1;
        while (j < t.length && oct.length < 3 && t[j] >= '0' && t[j] <= '7') { oct += t[j]; j++; }
        out += String.fromCharCode(parseInt(oct, 8));
        i = j; continue;
      } else out += n;
      i += 2; continue;
    }
    if (c === '(') { depth++; out += c; i++; continue; }
    if (c === ')') { depth--; if (depth > 0) out += c; i++; continue; }
    out += c; i++;
  }
  return { text: out, next: i };
}

function readHex(t, i) {
  const end = t.indexOf('>', i);
  if (end < 0) return { text: '', next: t.length };
  const hex = t.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let j = 0; j + 1 < hex.length; j += 2) out += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1] + '0', 16));
  return { text: out, next: end + 1 };
}

/* One decoded content stream -> its visible text, one line per text line. */
function textOf(content) {
  const t = content.toString('latin1');
  const lines = [];
  let cur = '';
  let i = 0;
  let pending = [];
  function flush() { if (cur.trim()) lines.push(cur.trim()); cur = ''; }
  while (i < t.length) {
    const c = t[i];
    if (c === '(') {
      const r = readLiteral(t, i);
      pending.push(r.text); i = r.next; continue;
    }
    if (c === '<' && t[i + 1] !== '<') {
      const r = readHex(t, i);
      pending.push(r.text); i = r.next; continue;
    }
    /* the text-showing operators consume whatever strings preceded them */
    if (c === 'T' && (t[i + 1] === 'j' || t[i + 1] === 'J')) {
      cur += pending.join(''); pending = []; i += 2; continue;
    }
    if ((c === "'" || c === '"') && pending.length) {
      flush(); cur += pending.join(''); pending = []; i++; continue;
    }
    /* TD, Td, T* and ET all end a visual line */
    if (c === 'T' && (t[i + 1] === 'd' || t[i + 1] === 'D' || t[i + 1] === '*')) {
      cur += pending.join(''); pending = []; flush(); i += 2; continue;
    }
    if (c === 'E' && t[i + 1] === 'T') { cur += pending.join(''); pending = []; flush(); i += 2; continue; }
    i++;
  }
  cur += pending.join('');
  flush();
  return lines;
}

/* buf: the PDF file's bytes. Returns
   { ok, text, lines, streams_read, streams_unreadable, why }.

   `ok` is false whenever nothing legible came out, and `why` says which of
   the two reasons it was — a document with no text objects (a scan) or one
   whose streams this could not inflate. A caller must treat either as a FAILED
   READ and never as a report that named nobody. */
function extract(buf) {
  if (!buf || !buf.length) return { ok: false, text: '', lines: [], streams_read: 0, streams_unreadable: 0,
    why: 'empty file' };
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, text: '', lines: [], streams_read: 0, streams_unreadable: 0,
      why: 'this is not a PDF (no %PDF- header) — the source may have served an error page' };
  }
  const all = streams(buf);
  let read = 0, bad = 0;
  let lines = [];
  for (const s of all) {
    const body = inflate(s);
    if (!body) { bad++; continue; }
    /* an image stream that inflated is still not text */
    if (/\/Subtype\s*\/Image/.test(s.dict)) { bad++; continue; }
    read++;
    lines = lines.concat(textOf(body));
  }
  /* PRINTABLE SHARE. A custom font encoding decodes to control characters,
     and a page of those is not a report EdgeDesk may quote. */
  const joined = lines.join('\n');
  const printable = joined.replace(/[^\x20-\x7e\n]/g, '').length;
  const share = joined.length ? printable / joined.length : 0;
  if (!joined.trim()) {
    return { ok: false, text: '', lines: [], streams_read: read, streams_unreadable: bad,
      why: read
        ? 'the document’s streams decoded but carry no text objects — it is very likely a scan or an image, '
          + 'and nothing can be read from it without OCR'
        : 'no content stream could be inflated (' + bad + ' unreadable)' };
  }
  if (share < 0.8) {
    return { ok: false, text: '', lines: [], streams_read: read, streams_unreadable: bad,
      why: 'only ' + Math.round(share * 100) + '% of the extracted characters are printable, which means the '
        + 'document uses a font encoding this reader cannot map. Refused rather than quoted' };
  }
  return { ok: true, text: joined, lines: lines, streams_read: read, streams_unreadable: bad, why: null };
}

module.exports = { extract, textOf, streams, inflate };
