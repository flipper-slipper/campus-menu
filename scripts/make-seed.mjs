// Generates seed.sql from data/accounts.json + data/buildings.json
import fs from 'node:fs';
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const accts = JSON.parse(fs.readFileSync(new URL('../data/accounts.json', import.meta.url)));
const { buildings } = JSON.parse(fs.readFileSync(new URL('../data/buildings.json', import.meta.url)));
const out = [];
for (const a of accts) out.push(`INSERT OR IGNORE INTO accounts (handle, school, club, last_post_at) VALUES (${q(a.handle)}, ${q(a.school)}, ${q(a.club)}, ${q(a.last_post_at)});`);
for (const b of buildings) out.push(`INSERT OR REPLACE INTO buildings (id, school, name, lat, lng, approx, aliases) VALUES (${q(b.id)}, 'Babson', ${q(b.name)}, ${q(b.lat)}, ${q(b.lng)}, ${b.approx ? 1 : 0}, ${q(JSON.stringify(b.aliases))});`);
console.log(out.join('\n'));
