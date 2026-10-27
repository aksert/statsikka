'use strict';
// Prints the summary JSON of a match folder or a single .rec file (read-only).
// Usage: node scripts/r6-parse.js <matchFolder|file.rec> [--full] [--pretty]
//   --full    print the full parse (rounds + stats + summary) instead of the summary only
//   --compact one-line JSON (default is indented)

const fs = require('fs');
const { parseRound, parseMatchFolder, summarizeMatch } = require('../src/main/r6');

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: node scripts/r6-parse.js <matchFolder|file.rec> [--full] [--compact]');
    process.exit(2);
  }
  const full = args.includes('--full');
  const t0 = process.hrtime.bigint();
  let out;
  if (fs.statSync(target).isDirectory()) {
    const m = await parseMatchFolder(target);
    out = full ? m : { ...m.summary, errors: m.errors };
  } else {
    const r = await parseRound(target);
    out = full ? r : { ...summarizeMatch([r]), errors: r.errors };
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify(out, null, args.includes('--compact') ? 0 : 2));
  console.error(`parsed in ${ms.toFixed(0)} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
