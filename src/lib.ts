// Pure logic (no I/O) so it can be unit-tested against real scraper output.

export interface RawPost {
  shortCode: string;
  ownerUsername: string;
  timestamp: string;
  caption?: string;
  type?: string; // Image | Sidecar | Video
  isPinned?: boolean;
  displayUrl?: string;
  images?: string[];
  childPosts?: { displayUrl?: string }[];
  coauthorProducers?: { username?: string }[];
  error?: string;
}

export interface CleanPost {
  shortcode: string;
  account: string; // the vetted account this post belongs to
  postedAt: string;
  caption: string;
  mediaType: string;
  imageUrls: string[];
}

export interface Building {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  approx?: boolean;
  aliases: string[];
}

/**
 * Turn one scraper run into the posts we still need to parse.
 * Handles the edge cases seen in the 2026-10-17 test run:
 *  - pinned posts come back even with skipPinnedPosts=true  -> drop isPinned
 *  - the same shortcode appears 2-3x                       -> dedupe
 *  - collab posts come back under the *other* account       -> attribute via coauthors
 *  - posts older than the lookback window                   -> drop
 *  - error rows (private / missing account)                 -> reported separately
 */
export function selectNewPosts(
  items: RawPost[],
  vetted: Set<string>,
  alreadySeen: Set<string>,
  since: Date,
  maxImages: number,
): { posts: CleanPost[]; errors: string[]; pinned: Record<string, number> } {
  const out = new Map<string, CleanPost>();
  const errors: string[] = [];
  const pinned: Record<string, number> = {};
  for (const it of items) {
    if (it.error) { errors.push(it.ownerUsername ?? it.error); continue; }
    if (!it.shortCode || !it.timestamp) continue;
    const account = attribute(it, vetted);
    if (!account) continue;
    if (it.isPinned) { pinned[account] = (pinned[account] ?? 0) + 1; continue; }
    if (new Date(it.timestamp) < since) continue;
    if (alreadySeen.has(it.shortCode) || out.has(it.shortCode)) continue;
    out.set(it.shortCode, {
      shortcode: it.shortCode,
      account,
      postedAt: it.timestamp,
      caption: (it.caption ?? '').trim(),
      mediaType: it.type ?? 'Image',
      imageUrls: imageUrls(it).slice(0, maxImages),
    });
  }
  return { posts: [...out.values()], errors, pinned };
}

export function attribute(it: RawPost, vetted: Set<string>): string | null {
  if (vetted.has(it.ownerUsername)) return it.ownerUsername;
  for (const c of it.coauthorProducers ?? []) if (c.username && vetted.has(c.username)) return c.username;
  return null;
}

function imageUrls(it: RawPost): string[] {
  const urls = [
    ...(it.images ?? []),
    ...(it.childPosts ?? []).map((c) => c.displayUrl).filter((u): u is string => !!u),
  ];
  if (!urls.length && it.displayUrl) urls.push(it.displayUrl); // videos/reels: cover frame
  return [...new Set(urls)];
}

/** Cheap pre-filter so obvious non-events never cost an LLM call. Flyer-only posts (empty caption) always go through. */
const NON_EVENT = /(make your mark|happy birthday|congrat|meet (the|our|your).{0,30}(e-?board|team|cohort)|applications? (are )?(now )?open|welcome back|recap|photo dump|thank you to everyone)/i;
const EVENT_HINT = /(join us|come|tonight|tomorrow|today|rsvp|register|sign ?up|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(oct|nov|dec|jan|feb|mar|apr|sept?)[a-z]*\.? \d|📍|🗓|📅|⏰|free food|pizza|snacks|catered|provided)/i;
export function worthParsing(caption: string): boolean {
  if (isRecap(caption)) return false;
  if (caption.length < 25) return true; // likely a flyer; the image carries the details
  if (EVENT_HINT.test(caption)) return true;
  return !NON_EVENT.test(caption);
}

/** Resolve the model's free-text location to a known building (aliases are lowercase). */
export function matchBuilding(raw: string | null | undefined, buildings: Building[]): Building | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[’']/g, "'");
  let best: { b: Building; len: number } | null = null;
  for (const b of buildings) {
    for (const a of b.aliases) {
      const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`);
      if (re.test(s) && (!best || a.length > best.len)) best = { b, len: a.length }; // longest alias wins
    }
  }
  return best?.b ?? null;
}

/** Offset for America/New_York on a date, without a tz library. DST: 2nd Sun Mar -> 1st Sun Nov. */
export function nyOffset(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const t = m * 100 + d;
  const dstStart = 300 + nthSunday(3, 2);
  const dstEnd = 1100 + nthSunday(11, 1);
  return t >= dstStart && t < dstEnd ? '-04:00' : '-05:00';
}

export function toISO(date: string, time: string | null | undefined): string | null {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return null;
  return `${date}T${time}:00${nyOffset(date)}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Which accounts to scrape today. Active ones daily; quiet ones once a week on a stable weekday. */
export function accountsForToday(
  accts: { handle: string; last_post_at: string | null }[],
  now: Date,
  activeDays = 21,
): string[] {
  const cutoff = now.getTime() - activeDays * 864e5;
  const dow = now.getUTCDay();
  return accts
    .filter((a) => {
      if (a.last_post_at && new Date(a.last_post_at).getTime() >= cutoff) return true;
      let h = 0;
      for (const ch of a.handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % 7 === dow;
    })
    .map((a) => a.handle);
}

// ---------- Date scrutiny ----------
// The model is not trusted on dates. Every event must cite where its date came from, and code re-checks it.

export type DateBasis = 'explicit_date' | 'relative_day' | 'weekday_only' | 'recurring_schedule' | 'inferred';

export interface CandidateEvent {
  title: string;
  date: string;               // YYYY-MM-DD
  date_basis: DateBasis;
  date_evidence: string;      // verbatim text from caption or flyer that states the date/schedule
  evidence_source: 'caption' | 'image';
  relation?: string;
}

/** Past-tense recap language. A post like this describes something that already happened. */
const RECAP = /\b(last (week|night|weekend|month)|yesterday|this past|thank(s| you)( so much)? (to )?(everyone|all|you all)|thanks for coming|recap|photo dump|throwback|tbt|in one scroll|came out|showed up|we had (a|such)|what a (night|week|day)|was a (great|huge|blast))/i;
/** Forward-looking language that can coexist with a recap ("...see you next Thursday!"). */
const FUTURE = /\b(join us|come (out|by|to)|see you (there|on|at|this|next|tomorrow|tonight)|rsvp|register|sign ?up|tickets?|save the date|don'?t miss|this (mon|tue|wed|thu|fri|sat|sun)|tomorrow|tonight|upcoming|next (mon|tue|wed|thu|fri|sat|sun))/i;

export function isRecap(caption: string): boolean {
  return RECAP.test(caption) && !FUTURE.test(caption);
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const localDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay();

/**
 * Returns null if the event passes, otherwise the reason it was rejected.
 *  - recap posts produce nothing
 *  - 'inferred' dates are rejected outright
 *  - caption evidence must actually appear in the caption
 *  - event date must fall on/after the post date and within 120 days of it
 *  - weekday-only dates ("this Friday") must be the first such weekday within 7 days after the post
 *  - recurring schedules only expand 28 days past the post, and the weekday must match the evidence
 */
export function rejectReason(e: CandidateEvent, caption: string, postedAt: string, today: string): string | null {
  if (e.relation === 'cancel' || e.relation === 'postpone') return null;
  if (isRecap(caption)) return 'recap_post';
  if (e.date_basis === 'inferred') return 'inferred_date';
  if (!e.date_evidence || e.date_evidence.trim().length < 3) return 'no_evidence';
  if (e.evidence_source === 'caption' && !norm(caption).includes(norm(e.date_evidence))) return 'evidence_not_in_caption';
  const posted = localDate(postedAt);
  if (e.date < today) return 'past';
  if (e.date < posted) return 'before_post';
  if (e.date > addDays(posted, 120)) return 'too_far_from_post';
  const ev = norm(e.date_evidence);
  const named = DOW.findIndex((d) => new RegExp(`\\b${d}`).test(ev));
  if (e.date_basis === 'weekday_only') {
    if (named < 0) return 'weekday_missing_in_evidence';
    if (dow(e.date) !== named) return 'weekday_mismatch';
    const gap = (Date.parse(e.date) - Date.parse(posted)) / 864e5;
    const nextWeek = /\bnext\b/.test(ev);
    if (gap > (nextWeek ? 13 : 7)) return 'weekday_too_far';
  }
  if (e.date_basis === 'recurring_schedule') {
    if (!/\b(every|each|weekly|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/.test(ev)) return 'no_recurrence_statement';
    if (named >= 0 && dow(e.date) !== named) return 'weekday_mismatch';
    if (e.date > addDays(posted, 28)) return 'recurrence_too_old';
  }
  if (e.date_basis === 'explicit_date') {
    const day = Number(e.date.slice(8));
    if (!new RegExp(`\\b0?${day}(st|nd|rd|th)?\\b`).test(ev)) return 'day_not_in_evidence';
  }
  return null;
}
