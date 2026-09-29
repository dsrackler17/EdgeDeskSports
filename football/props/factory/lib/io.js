/* ===========================================================================
   EdgeDesk player props — raw-file access: the cached downloader and a fast,
   UTF-8-safe CSV reader.

   RAW FILES LIVE OUTSIDE THE REPOSITORY AND OUTSIDE EVERY BROWSER-FACING
   TABLE: .cache/props/raw/<source>/<file> (gitignored), with a manifest of
   every download (url, bytes, sha256, fetched_at). A completed season is
   permanent once fetched; the season in progress is refetched after the
   shared 30-minute window (football/data/feed_cache.js — the one rule every
   fetcher in this repository follows).

   The CSV reader is RFC 4180 (quoted commas, doubled quotes, quoted newlines)
   with a fast path for lines that carry no quote at all, which is most of a
   play-by-play file. Bytes are decoded with a StringDecoder so a multi-byte
   character split across two network chunks ("José") is never mangled.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const feedCache = require('../../../data/feed_cache.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CACHE = process.env.EDGEDESK_PROPS_CACHE || path.join(ROOT, '.cache', 'props');
const RAW = path.join(CACHE, 'raw');

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function manifestPath() { return path.join(RAW, 'manifest.json'); }
function readManifest() { try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch (_) { return { files: {} }; } }
function writeManifest(m) { fs.mkdirSync(RAW, { recursive: true }); fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 1)); }

/* Download `url` to .cache/props/raw/<source>/<name> unless a usable copy is
   cached. Returns {file, cached, bytes, sha256}. A 404 resolves to null (the
   provider has no such season) so a caller can report coverage rather than
   crash; every other failure throws after the retries. */
async function fetchCached(url, source, name, opts) {
  opts = opts || {};
  const dir = path.join(RAW, source);
  const file = path.join(dir, name);
  const season = opts.currentSeason || currentSeason();
  if (!opts.force && feedCache.usable(file, name, season, opts.minBytes || 64)) {
    return { file, cached: true, bytes: fs.statSync(file).size, sha256: null };
  }
  if (opts.offline) {
    if (fs.existsSync(file)) return { file, cached: true, stale: true, bytes: fs.statSync(file).size, sha256: null };
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  let lastErr = null;
  for (let attempt = 0; attempt < (opts.retries || 3); attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'edgedesk-props/1 (+https://edgedesksports.com)' } });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' for ' + url), { status: res.status });
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = file + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);                     /* never leave a half file under the real name */
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const m = readManifest();
      m.files[source + '/' + name] = { url, bytes: buf.length, sha256: sha, fetched_at: new Date().toISOString() };
      writeManifest(m);
      return { file, cached: false, bytes: buf.length, sha256: sha };
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (fs.existsSync(file) && opts.allowStale !== false) return { file, cached: true, stale: true, bytes: fs.statSync(file).size, sha256: null, error: lastErr && lastErr.message };
  throw lastErr || new Error('download failed: ' + url);
}

/* The football season a date belongs to: January–July belong to the season
   that started the previous August (bowls, playoffs, offseason). */
function currentSeason(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getUTCMonth() <= 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

/* ---------------------------------------------------------------- CSV */
function splitLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (inQ) {
      if (ch === 34) { if (line.charCodeAt(i + 1) === 34) { field += '"'; i++; } else inQ = false; }
      else field += line[i];
    } else if (ch === 34) inQ = true;
    else if (ch === 44) { out.push(field); field = ''; }
    else field += line[i];
  }
  out.push(field);
  return out;
}
function quotesBalanced(s) { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 34) n++; return n % 2 === 0; }

/* Stream a CSV (plain or .gz) and call onRow(obj, index) for every data row.
   `columns` (optional) limits the object to those keys, which keeps a
   370-column play-by-play row cheap. Returns {header, rows}. */
function readCsv(file, onRow, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const raw = fs.createReadStream(file);
    const stream = /\.gz$/i.test(file) ? raw.pipe(zlib.createGunzip()) : raw;
    const dec = new StringDecoder('utf8');
    let pending = '', header = null, idx = null, keys = null, n = 0, carry = '';
    const want = opts.columns ? new Set(opts.columns) : null;
    function handle(line) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (carry) { line = carry + '\n' + line; carry = ''; }
      if (!quotesBalanced(line)) { carry = line; return; }
      if (header === null) {
        header = splitLine(line).map((h) => h.trim().replace(/^﻿/, ''));
        idx = []; keys = [];
        header.forEach((h, i) => { if (!want || want.has(h)) { idx.push(i); keys.push(h); } });
        return;
      }
      if (!line) return;
      const v = splitLine(line);
      const o = {};
      for (let j = 0; j < idx.length; j++) { const x = v[idx[j]]; o[keys[j]] = x === undefined ? '' : x; }
      n++;
      onRow(o, n);
    }
    stream.on('data', (buf) => {
      pending += dec.write(buf);
      let cut;
      while ((cut = pending.indexOf('\n')) >= 0) { handle(pending.slice(0, cut)); pending = pending.slice(cut + 1); }
    });
    stream.on('end', () => { pending += dec.end(); if (pending) handle(pending); if (carry) handle(''); resolve({ header, rows: n }); });
    stream.on('error', reject);
    raw.on('error', reject);
  });
}
/* whole file into memory (small files only) */
async function loadCsv(file, opts) { const rows = []; await readCsv(file, (o) => rows.push(o), opts); return rows; }

/* ---------------------------------------------------------- values */
/* A missing value is never a zero: '', 'NA', 'NaN', 'None', 'null', '-' are absent. */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === 'NA' || s === 'NaN' || s === 'nan' || s === 'None' || s === 'null' || s === '-' || s === '--') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function int(v) { const n = num(v); return n === null ? null : Math.round(n); }
function bool(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'true' || s === '1' || s === 't' ? true : (s === 'false' || s === '0' || s === 'f' ? false : null); }
function str(v) { const s = v == null ? '' : String(v).trim(); return s === '' || s === 'NA' ? null : s; }

function writeJson(file, obj, pretty) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, pretty ? JSON.stringify(obj, null, 1) + '\n' : JSON.stringify(obj)); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback === undefined ? null : fallback; } }
function writeJsonl(file, rows) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
function readJsonl(file) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }

module.exports = { ROOT, CACHE, RAW, fetchCached, currentSeason, readCsv, loadCsv, splitLine, num, int, bool, str, sha256File,
  writeJson, readJson, writeJsonl, readJsonl, readManifest };
