import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { accountsForToday, matchBuilding, nyOffset, selectNewPosts, toISO, worthParsing, type RawPost } from '../src/lib';

const items: RawPost[] = JSON.parse(fs.readFileSync(new URL('./fixtures/run-2026-10-17.json', import.meta.url), 'utf8'));
const accounts: { handle: string }[] = JSON.parse(fs.readFileSync(new URL('../data/accounts.json', import.meta.url), 'utf8'));
const vetted = new Set(accounts.map((a) => a.handle));
const { buildings } = JSON.parse(fs.readFileSync(new URL('../data/buildings.json', import.meta.url), 'utf8'));

describe('selectNewPosts on the real 2026-10-17 scrape', () => {
  const since = new Date('2026-08-01T00:00:00Z');
  const r = selectNewPosts(items, vetted, new Set(), since, 4);

  it('drops every pinned post', () => {
    const pinnedCodes = new Set(items.filter((i) => i.isPinned).map((i) => i.shortCode));
    expect(pinnedCodes.size).toBeGreaterThan(0);
    expect(r.posts.some((p) => pinnedCodes.has(p.shortcode))).toBe(false);
  });
  it('dedupes repeated shortcodes', () => {
    const codes = r.posts.map((p) => p.shortcode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(items.length).toBeGreaterThan(codes.length);
  });
  it('only returns vetted accounts', () => {
    expect(r.posts.every((p) => vetted.has(p.account))).toBe(true);
  });
  it('skips already-seen posts', () => {
    const seen = new Set(r.posts.slice(0, 10).map((p) => p.shortcode));
    const again = selectNewPosts(items, vetted, seen, since, 4);
    expect(again.posts.length).toBe(r.posts.length - 10);
  });
  it('respects the lookback window', () => {
    const narrow = selectNewPosts(items, vetted, new Set(), new Date('2026-10-15T00:00:00Z'), 4);
    expect(narrow.posts.every((p) => p.postedAt >= '2026-10-15')).toBe(true);
    expect(narrow.posts.length).toBeLessThan(r.posts.length);
  });
  it('attributes collab posts to the vetted coauthor', () => {
    const fake: RawPost = { shortCode: 'X1', ownerUsername: 'someone_else', timestamp: '2026-10-16T00:00:00Z', coauthorProducers: [{ username: 'babsoncab' }] };
    expect(selectNewPosts([fake], vetted, new Set(), since, 4).posts[0].account).toBe('babsoncab');
  });
});

describe('worthParsing', () => {
  it('keeps event announcements', () => {
    expect(worthParsing('Join us this Thursday! Van Winkle A1 @ 7:00 PM.')).toBe(true);
    expect(worthParsing('Ever heard of Taco THURSDAY??!! Come by the Weissman Foundry on October 15th')).toBe(true);
  });
  it('keeps flyer-only posts (short captions)', () => {
    expect(worthParsing('See you all there!')).toBe(true);
  });
  it('skips fundraising / e-board / recap posts', () => {
    expect(worthParsing('MAKE YOUR MARK WITH BSU! Your support helps us create more opportunities, build community, and make a lasting impact here at Babson!')).toBe(false);
    expect(worthParsing('Thank you to everyone that showed up for our event yesterday, we loved the energy and the hot takes all night long')).toBe(false);
  });
});

describe('matchBuilding', () => {
  it.each([
    ['Olin Classroom 101', 'olin-hall'],
    ['eTower, Van Winkle C2', 'van-winkle'],
    ['Foundry Workroom', 'weissman-foundry'],
    ['Reynolds Global Lounge', 'reynolds'],
    ["Roger's Pub", 'rogers-pub'],
    ['Babson Commons 101', 'commons'],
    ['The Globe at Babson College', 'globe'],
    ['Sandra L. Sorenson Rehearsal Studio', 'sorenson'],
  ])('%s -> %s', (raw, id) => expect(matchBuilding(raw, buildings)?.id).toBe(id));
  it('returns null for off-campus venues', () => {
    expect(matchBuilding('Empire, Seaport Boston', buildings)).toBeNull();
  });
});

describe('time handling', () => {
  it('uses EDT before and EST after Nov 1 2026', () => {
    expect(nyOffset('2026-10-31')).toBe('-04:00');
    expect(nyOffset('2026-11-01')).toBe('-05:00');
    expect(nyOffset('2027-03-14')).toBe('-04:00');
    expect(toISO('2026-11-06', '12:00')).toBe('2026-11-06T12:00:00-05:00');
    expect(toISO('2026-10-20', null)).toBeNull();
  });
});

describe('accountsForToday', () => {
  it('polls active accounts daily and quiet ones once a week', () => {
    const now = new Date('2026-10-17T10:40:00Z');
    const accts = [
      { handle: 'active', last_post_at: '2026-10-10T00:00:00Z' },
      ...Array.from({ length: 70 }, (_, i) => ({ handle: `quiet${i}`, last_post_at: '2026-01-01T00:00:00Z' })),
    ];
    const week = new Set<string>();
    for (let d = 0; d < 7; d++) accountsForToday(accts, new Date(now.getTime() + d * 864e5)).forEach((h) => week.add(h));
    expect(accountsForToday(accts, now)).toContain('active');
    expect(week.size).toBe(71);
    expect(accountsForToday(accts, now).length).toBeLessThan(30);
  });
});
