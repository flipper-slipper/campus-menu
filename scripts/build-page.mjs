// Builds public/index.html (served by the Worker) from src/page.html.
// The embedded seed is a fallback snapshot; the page swaps in /api/events when it loads.
import fs from 'node:fs';
const page = fs.readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
const seedPath = process.argv[2];
const seed = seedPath ? fs.readFileSync(seedPath, 'utf8') : '{"generated_at":null,"buildings":[],"events":[]}';
const body = page.replace('__SEED__', seed.replace(/</g, '\\u003c'));
const out = process.argv[3] === '--fragment' ? body
  : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${body.split('<main')[0]}</head>\n<body><main${body.split('<main').slice(1).join('<main')}</body></html>\n`;
process.stdout.write(out);
