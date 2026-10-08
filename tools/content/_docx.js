/* ===========================================================================
   A .docx reader for the tests, with no dependency: it walks the ZIP's
   central directory, checks every entry's CRC with Node's own zlib.crc32
   (not the library's), and checks each XML part is well formed (every tag
   closed, in order). Enough to prove what an editor's Word or Google Docs
   will open, without shipping a parser.
   =========================================================================== */
'use strict';
const zlib = require('zlib');

function unzip(bytes) {
  const b = Buffer.from(bytes);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const n = b.readUInt16LE(eocd + 10), cdOff = b.readUInt32LE(eocd + 16);
  const files = {};
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry ' + i);
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    if (b.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const data = method === 0 ? b.subarray(start, start + size) : zlib.inflateRawSync(b.subarray(start, start + b.readUInt32LE(p + 20)));
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error('CRC mismatch for ' + name);
    files[name] = data;
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

/* every element closed, in order; nothing but a declaration outside the root */
function wellFormed(xml) {
  const stack = [];
  const body = String(xml).replace(/^<\?xml[^?]*\?>\s*/, '');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0] === '<' || m[0][0] === '&') return false;
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}

/* the document's text, paragraph by paragraph, with each paragraph's style */
function paragraphs(documentXml) {
  return (String(documentXml).match(/<w:p>[\s\S]*?<\/w:p>/g) || []).map((p) => ({
    style: (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || 'Normal',
    text: (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  }));
}

module.exports = { unzip, wellFormed, paragraphs };
