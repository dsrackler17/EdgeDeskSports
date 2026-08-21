// Parses the inline scripts of the Collective's HTML pages and the standalone
// JS, so a bad edit is caught here rather than in a browser console.
//   node tools/collective/check_html_js.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const targets = [
  ["collective/index.html", "html"],
  ["collective/admin.html", "html"],
  ["collective/join.html", "html"],
  ["collective/embed.js", "js"],
  ["collective/odds.js", "js"],
];

let bad = 0;
for (const [rel, kind] of targets) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const blocks = kind === "js"
    ? [text]
    : [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) { console.log(`skip ${rel} (no inline script)`); continue; }
  blocks.forEach((code, i) => {
    try {
      new Function(code);
      console.log(`ok   ${rel}${blocks.length > 1 ? ` [block ${i + 1}]` : ""}  ${code.split("\n").length} lines`);
    } catch (e) {
      bad++;
      console.error(`FAIL ${rel} [block ${i + 1}]: ${e.message}`);
    }
  });
}
process.exit(bad ? 1 : 0);
