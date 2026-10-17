import { accountsForToday, matchBuilding, rejectReason, selectNewPosts, slug, toISO, worthParsing, type Building, type RawPost } from './lib';
import { parsePost } from './parse';
import { buildDigest, sendDigest } from './digest';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  APIFY_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  APIFY_ACTOR: string;
  CLAUDE_MODEL: string;
  LOOKBACK_HOURS: string;
  MAX_POSTS_PER_ACCOUNT: string;
  APIFY_MAX_USD_PER_RUN: string;
  MAX_IMAGES_PER_POST: string;
  PUBLIC_URL: string;
  RESEND_API_KEY?: string; // optional: digest is skipped when unset
  DIGEST_TO?: string;      // secret, so the address never lands in the public repo
  DIGEST_FROM: string;
}

const POSTS_PER_TICK = 8; // keeps each invocation well under the Workers subrequest limit

export default {
  // Three crons (UTC): 10:40 daily scrape, every 10 min parse drain, 11:30 email digest (7:30 AM EDT / 6:30 AM EST).
  async scheduled(ctl: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (ctl.cron === '40 10 * * *') ctx.waitUntil(startDailyRuns(env, new Date(ctl.scheduledTime)));
    else if (ctl.cron === '30 11 * * *') ctx.waitUntil(emailDigest(env));
    else ctx.waitUntil(drainPending(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/apify-webhook' && req.method === 'POST') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const body = (await req.json()) as { resource?: { id: string; defaultDatasetId: string; status: string; usageTotalUsd?: number } };
      if (!body.resource) return new Response('bad payload', { status: 400 });
      ctx.waitUntil(ingestRun(env, body.resource));
      return new Response('ok');
    }

    if (url.pathname === '/api/events') return eventsJSON(env, url);
    if (url.pathname === '/api/accounts') return accountsJSON(env);

    if (url.pathname.startsWith('/img/')) {
      const obj = await env.IMAGES.get(decodeURIComponent(url.pathname.slice(5)));
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': 'public, max-age=604800' } });
    }

    // Manual controls for testing: /api/admin/run, /api/admin/drain
    if (url.pathname.startsWith('/api/admin/')) {
      if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('forbidden', { status: 403 });
      if (url.pathname.endsWith('/run')) return Response.json(await startDailyRuns(env, new Date()));
      if (url.pathname.endsWith('/drain')) return Response.json(await drainPending(env));
      if (url.pathname.endsWith('/digest')) return Response.json(await emailDigest(env, url.searchParams.has('dry')));
    }

    return env.ASSETS.fetch(req);
  },
};

// ---------- 1. Start scraper runs ----------

async function startDailyRuns(env: Env, now: Date) {
  const { results } = await env.DB.prepare('SELECT handle, last_post_at FROM accounts WHERE active = 1').all<{ handle: string; last_post_at: string | null }>();
  const today = new Set(accountsForToday(results, now));
  const activeCut = now.getTime() - 21 * 864e5;
  const active = [...today].filter((h) => { const a = results.find((r) => r.handle === h)!; return a.last_post_at && new Date(a.last_post_at).getTime() >= activeCut; });
  const quiet = [...today].filter((h) => !active.includes(h));

  const started = [];
  // Active accounts: short lookback. Quiet accounts (polled weekly): 8-day lookback so nothing falls in the gap.
  if (active.length) started.push(await startRun(env, active, `${env.LOOKBACK_HOURS} hours`));
  if (quiet.length) started.push(await startRun(env, quiet, '8 days'));
  return { active: active.length, quiet: quiet.length, started };
}

async function startRun(env: Env, handles: string[], newerThan: string) {
  const self = env.PUBLIC_URL;
  const hooks = btoa(JSON.stringify([
    { eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.TIMED_OUT', 'ACTOR.RUN.ABORTED'], requestUrl: `${self}/apify-webhook?secret=${env.WEBHOOK_SECRET}` },
  ]));
  const input = {
    username: handles,
    resultsLimit: Number(env.MAX_POSTS_PER_ACCOUNT) + 3, // +3: pinned posts still count toward the limit
    skipPinnedPosts: true,                               // not reliable (see lib.ts), we filter again
    onlyPostsNewerThan: newerThan,
    dataDetailLevel: 'detailedData',                     // needed for carousel images[]
  };
  const qs = new URLSearchParams({ token: env.APIFY_TOKEN, webhooks: hooks, maxTotalChargeUsd: env.APIFY_MAX_USD_PER_RUN });
  const res = await fetch(`https://api.apify.com/v2/acts/${env.APIFY_ACTOR}/runs?${qs}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`apify start ${res.status}: ${await res.text()}`);
  const run = ((await res.json()) as { data: { id: string } }).data;
  await env.DB.prepare('INSERT INTO runs (run_id, started_at, handles, status) VALUES (?, ?, ?, ?)').bind(run.id, new Date().toISOString(), handles.length, 'RUNNING').run();
  return run.id;
}

// ---------- 2. Webhook: store new posts as pending ----------

async function ingestRun(env: Env, run: { id: string; defaultDatasetId: string; status: string; usageTotalUsd?: number }) {
  const items: RawPost[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=1000&offset=${offset}&token=${env.APIFY_TOKEN}`);
    const page = (await r.json()) as RawPost[];
    items.push(...page);
    if (page.length < 1000) break;
  }
  const vetted = new Set((await env.DB.prepare('SELECT handle FROM accounts WHERE active = 1').all<{ handle: string }>()).results.map((r) => r.handle));
  const codes = [...new Set(items.map((i) => i.shortCode).filter(Boolean))];
  const seen = new Set<string>();
  for (let i = 0; i < codes.length; i += 90) {
    const chunk = codes.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT shortcode FROM posts WHERE shortcode IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ shortcode: string }>();
    results.forEach((r) => seen.add(r.shortcode));
  }
  const since = new Date(Date.now() - 8 * 864e5); // widest window used by any run
  const { posts, errors, pinned } = selectNewPosts(items, vetted, seen, since, Number(env.MAX_IMAGES_PER_POST));

  const stmts = posts.map((p) =>
    env.DB.prepare('INSERT OR IGNORE INTO posts (shortcode, account, posted_at, caption, media_type, image_keys, llm_status) VALUES (?,?,?,?,?,?,?)')
      .bind(p.shortcode, p.account, p.postedAt, p.caption, p.mediaType, JSON.stringify(p.imageUrls), worthParsing(p.caption) ? 'pending' : 'skipped'));
  for (const p of posts) stmts.push(env.DB.prepare('UPDATE accounts SET last_post_at = MAX(COALESCE(last_post_at, ""), ?) WHERE handle = ?').bind(p.postedAt, p.account));
  for (const [h, n] of Object.entries(pinned)) stmts.push(env.DB.prepare('UPDATE accounts SET pinned_count = ? WHERE handle = ?').bind(n, h));
  for (const h of errors) stmts.push(env.DB.prepare('UPDATE accounts SET fail_count = fail_count + 1, active = CASE WHEN fail_count >= 4 THEN 0 ELSE active END WHERE handle = ?').bind(h));
  stmts.push(env.DB.prepare('UPDATE runs SET status = ?, items = ?, new_posts = ?, usd = ? WHERE run_id = ?').bind(run.status, items.length, posts.length, run.usageTotalUsd ?? null, run.id));
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------- 3. Drain: copy images to R2, parse with Claude, write events ----------

async function drainPending(env: Env) {
  const { results: pending } = await env.DB.prepare(
    `SELECT p.shortcode, p.account, p.posted_at, p.caption, p.image_keys, a.club, a.school
       FROM posts p JOIN accounts a ON a.handle = p.account
      WHERE p.llm_status = 'pending' ORDER BY p.posted_at DESC LIMIT ?`).bind(POSTS_PER_TICK)
    .all<{ shortcode: string; account: string; posted_at: string; caption: string; image_keys: string; club: string | null; school: string }>();
  if (!pending.length) return { processed: 0 };

  const buildings = (await env.DB.prepare('SELECT * FROM buildings').all<Building & { aliases: string }>()).results
    .map((b) => ({ ...b, aliases: JSON.parse(b.aliases as unknown as string) as string[] }));
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  let events = 0;
  for (const p of pending) {
    try {
      // Copy images first: Instagram CDN URLs expire within days.
      const urls = JSON.parse(p.image_keys) as string[];
      const keys: string[] = [];
      const images: { mediaType: string; data: string }[] = [];
      for (let i = 0; i < urls.length; i++) {
        if (!urls[i].startsWith('http')) { keys.push(urls[i]); continue; }
        const r = await fetch(urls[i]);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const key = `posts/${p.shortcode}/${i}.jpg`;
        await env.IMAGES.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
        keys.push(key);
        images.push({ mediaType: 'image/jpeg', data: b64(buf) });
      }

      const { result, raw } = await parsePost(env, { account: p.account, club: p.club, postedAt: p.posted_at, caption: p.caption, images }, todayLocal);
      const stmts: D1PreparedStatement[] = [];
      const rejected: { title: string; date: string; reason: string }[] = [];
      for (const e of result.is_event_post ? result.events : []) {
        const why = rejectReason(e, p.caption, p.posted_at, todayLocal);
        if (why) { rejected.push({ title: e.title, date: e.date, reason: why }); continue; }
        if (e.relation === 'cancel' || e.relation === 'postpone') {
          stmts.push(env.DB.prepare(`UPDATE events SET status = ? WHERE account = ? AND date = ? AND status = 'active'`)
            .bind(e.relation === 'cancel' ? 'cancelled' : 'postponed', p.account, e.date));
          continue;
        }
        const b = matchBuilding(e.location, buildings);
        const flags = [
          !e.start_time && 'time_missing', !e.location && 'location_missing',
          e.location && !b && 'building_unmatched', b?.approx && 'approx_location',
          e.open_to === 'grad' && 'grad_only', e.open_to === 'members' && 'members_only',
          e.confidence < 0.6 && 'low_confidence',
        ].filter(Boolean);
        const id = `${p.account}-${e.date}-${slug(e.title)}${e.start_time ? '-' + e.start_time.replace(':', '') : ''}`;
        stmts.push(env.DB.prepare(
          `INSERT INTO events (id, shortcode, school, account, title, description, date, start_at, end_at, building_id, location_raw, room, food, free_food, price, category, flags, confidence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET description=excluded.description, start_at=excluded.start_at, end_at=excluded.end_at, building_id=excluded.building_id,
             location_raw=excluded.location_raw, room=excluded.room, food=excluded.food, free_food=excluded.free_food, flags=excluded.flags, status='active'`)
          .bind(id, p.shortcode, p.school, p.account, e.title, e.description, e.date, toISO(e.date, e.start_time), toISO(e.date, e.end_time),
            b?.id ?? null, e.location, e.room, e.food, e.food && e.food_is_free ? 1 : 0, e.price, e.category, JSON.stringify(flags), e.confidence));
        events++;
      }
      stmts.push(env.DB.prepare('UPDATE posts SET llm_status = ?, llm_raw = ?, image_keys = ? WHERE shortcode = ?')
        .bind(result.is_event_post ? 'done' : 'not_event', JSON.stringify({ raw, rejected }), JSON.stringify(keys), p.shortcode));
      await env.DB.batch(stmts);
    } catch (err) {
      await env.DB.prepare(`UPDATE posts SET llm_status = 'error', llm_raw = ? WHERE shortcode = ?`).bind(String(err), p.shortcode).run();
    }
  }
  return { processed: pending.length, events };
}

// ---------- 4. Public API ----------

async function eventsJSON(env: Env, url: URL) {
  const cache = caches.default;
  const hit = await cache.match(url.toString());
  if (hit) return hit;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { results } = await env.DB.prepare(
    `SELECT e.*, a.club, p.image_keys FROM events e
       JOIN accounts a ON a.handle = e.account JOIN posts p ON p.shortcode = e.shortcode
      WHERE e.date >= ? AND e.status = 'active' ORDER BY e.date, e.start_at`).bind(today).all<Record<string, unknown>>();
  const buildings = (await env.DB.prepare('SELECT id, name, lat, lng, approx FROM buildings').all()).results;
  const events = results.map((r) => ({
    ...r,
    start: r.start_at, end: r.end_at,
    flags: JSON.parse((r.flags as string) || '[]'),
    free_food: !!r.free_food,
    tab: r.food ? 'menu' : 'activity',
    post_url: `https://www.instagram.com/p/${r.shortcode}/`,
    image: (JSON.parse((r.image_keys as string) || '[]') as string[])[0] ? `/img/${(JSON.parse(r.image_keys as string) as string[])[0]}` : null,
  }));
  const res = Response.json({ generated_at: new Date().toISOString(), buildings, events }, { headers: { 'cache-control': 'public, max-age=900' } });
  await cache.put(url.toString(), res.clone());
  return res;
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- 5. Sources + daily digest ----------

async function accountsJSON(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT a.handle, a.club, a.school, a.active, a.last_post_at, a.fail_count,
            (SELECT COUNT(*) FROM posts p WHERE p.account = a.handle) AS posts_seen,
            (SELECT COUNT(*) FROM events e WHERE e.account = a.handle AND e.status = 'active'
               AND e.date >= date('now', '-4 hours')) AS upcoming
       FROM accounts a ORDER BY a.club COLLATE NOCASE`).all();
  return Response.json({ generated_at: new Date().toISOString(), accounts: results }, { headers: { 'cache-control': 'public, max-age=900' } });
}

async function emailDigest(env: Env, dry = false) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT e.*, a.club, b.name AS building FROM events e
       JOIN accounts a ON a.handle = e.account LEFT JOIN buildings b ON b.id = e.building_id
      WHERE e.status = 'active' AND e.date IN (?, ?) ORDER BY e.date, e.start_at`).bind(today, tomorrow).all<Record<string, unknown>>();
  const digest = buildDigest(results as never, today, env.PUBLIC_URL);
  if (dry || !env.RESEND_API_KEY || !env.DIGEST_TO) return { sent: false, reason: dry ? 'dry run' : 'RESEND_API_KEY or DIGEST_TO not set', ...digest };
  await sendDigest(env.RESEND_API_KEY, env.DIGEST_FROM, env.DIGEST_TO, digest);
  return { sent: true, subject: digest.subject };
}
