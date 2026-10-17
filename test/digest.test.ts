import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { buildDigest, type DigestEvent } from '../src/digest';

const data = JSON.parse(fs.readFileSync(new URL('../data/events.json', import.meta.url), 'utf8'));
const toRow = (e: any): DigestEvent => ({ title: e.title, date: e.date, start_at: e.start, end_at: e.end, food: e.food, free_food: e.free_food, price: e.price,
  club: e.club, building: null, location_raw: e.location_raw, room: e.room, shortcode: e.post_url?.split('/p/')[1]?.replace('/', '') ?? '', flags: null });

describe('buildDigest', () => {
  const rows = data.events.filter((e: any) => e.date === '2026-10-20' || e.date === '2026-10-21').map(toRow);
  const d = buildDigest(rows, '2026-10-20', 'https://campus-menu.example.workers.dev');
  it('puts food first and counts correctly', () => {
    expect(d.subject).toBe('Menu · Tue, Oct 20: 2 with food, 6 more events');
    expect(d.html.indexOf('Today')).toBeLessThan(d.html.indexOf('Tomorrow'));
    expect(d.html.indexOf("Chef's Selection")).toBeLessThan(d.html.indexOf('SEO Career'));
  });
  it('renames generic food and marks paid food', () => {
    expect(d.html).toContain("Chef's Selection");
    expect(d.html).toContain('Lobster night');
  });
  it('escapes post text', () => {
    const x = buildDigest([{ ...rows[0], title: '<script>x</script>' }], '2026-10-20', '#');
    expect(x.html).not.toContain('<script>x');
  });
  it('still renders on an empty day', () => {
    expect(buildDigest([], '2026-10-20', '#').subject).toContain('nothing posted yet');
  });
});
