# campus-menu

**Menu** collects free food and student events at Babson College from club Instagram posts, refreshes them every morning, and lays them out like a restaurant menu.

- **Menu** tab: events with food, grouped by day, with filters by school and date, sorted by date or walking distance.
- **Activities** tab: everything else on the calendar.
- **Sources** tab: every Instagram account being read, when it last posted, and whether it's checked daily or weekly.
- **Daily email digest** (optional): today's and tomorrow's food and events at 7:30 AM Eastern.

Stack: Cloudflare Workers (site, API, crons), D1, R2, [Apify](https://apify.com/apify/instagram-post-scraper) for scraping, Claude Haiku 5.5 for reading flyers, [Resend](https://resend.com) for email.

## How a day runs

1. **10:40 UTC cron** picks today's accounts: anyone who posted in the last 21 days, plus 1/7 of quiet accounts (weekly rotation). It starts up to two Apify runs (`40 hours` lookback for active, `8 days` for quiet) with a hard `maxTotalChargeUsd` cap and an ad-hoc webhook.
2. **Webhook** (`/apify-webhook`) pulls the dataset and drops pinned posts, duplicate shortcodes, posts already in D1 and posts outside the window. Collab posts are attributed to the vetted coauthor. Obvious non-events (fundraising, e-board intros, recaps) are marked `skipped`; everything else is `pending`.
3. **Every 10 min cron** takes 8 pending posts. It copies their images to R2 (Instagram CDN links expire), then sends images + caption to Claude with a forced `record_events` tool. Locations are matched to `buildings`; cancellations/postponements update earlier events.
4. **11:30 UTC cron** emails the digest (skipped when `RESEND_API_KEY` or `DIGEST_TO` is unset).
5. **`/api/events`** and **`/api/accounts`** feed the page (15-min edge cache).

## Date scrutiny

The model never decides on its own that an event is in the future. `rejectReason()` in `src/lib.ts` checks every extracted event in code:

- **Recap posts are dropped before the model sees them.** Past-tense wording ("last week", "thank you to everyone who came", "photo dump") with no forward-looking line marks the post as a recap.
- **Every event must quote its date.** The model returns `date_basis` and the exact `date_evidence` words. Caption evidence must actually appear in the caption, and `inferred` dates are rejected.
- **Dates are checked against the post date.** The event can't predate the post, can't be more than 120 days out, and must have an explicit day number that matches the evidence. "This Friday" must land on a Friday within 7 days of the post (13 days for "next Friday").
- **Recurring events need a stated schedule.** They require words like "every Wednesday" and expand only 28 days past the post.

Rejected events are stored with their reason in `posts.llm_raw` for review. Regression tests: `test/dates.test.ts`, including the GSC coffee recap that slipped through on 2026-10-17.

## Deploy (GitHub Actions → Cloudflare)

Every push to `main` runs the tests, applies `schema.sql` + `seed.sql` to D1, deploys the Worker with its three crons, and syncs secrets. The crons live in `wrangler.toml`, so deploying is all it takes to schedule them.

One-time setup:

1. In Cloudflare, create the D1 database `campus-menu` and the R2 bucket `campus-menu-images` (already done for this repo; the D1 id is in `wrangler.toml`).
2. Create a Cloudflare API token with **Workers Scripts: Edit**, **D1: Edit**, **Workers R2 Storage: Edit** and **Account Settings: Read**.
3. Add GitHub repo secrets (Settings → Secrets and variables → Actions):

| Secret | Required | What |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Cloudflare dashboard → Workers & Pages → Account ID |
| `APIFY_TOKEN` | yes | Apify → Settings → API & Integrations |
| `ANTHROPIC_API_KEY` | yes | console.anthropic.com |
| `WEBHOOK_SECRET` | yes | any long random string |
| `ADMIN_TOKEN` | yes | any long random string |
| `RESEND_API_KEY` | for email | resend.com → API Keys |
| `DIGEST_TO` | for email | where the digest goes. With the default `onboarding@resend.dev` sender this must be your Resend account's email; verify a domain in Resend to send anywhere else. |

4. Run the **deploy** workflow (Actions tab → deploy → Run workflow). The run summary prints the site URL.
5. Kick off the first scrape instead of waiting for tomorrow:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://campus-menu.<you>.workers.dev/api/admin/run
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://campus-menu.<you>.workers.dev/api/admin/digest?dry"   # preview the email
```

## Cost (Babson only)

- Apify `instagram-post-scraper`, free tier: $0.0017/post + $0.001 for detailed data (needed for carousel images). About 30–60 posts/day → roughly $3–5/month. Capped per run by `APIFY_MAX_USD_PER_RUN`.
- Claude Haiku 5.5: $0.10 / $0.50 per MTok. A post with up to 4 images is a few thousand tokens, so well under $1/month.
- Cloudflare: free tier covers this.

## Maintenance

- **Accounts:** edit `data/accounts.json`, then `npm run seed` and re-run the seed SQL. Accounts with 5 failed scrapes switch off automatically.
- **Buildings:** `data/buildings.json`. Entries with `approx: true` are not in OpenStreetMap. Pin them by hand (Weissman Foundry, Babson Commons, Winn, Gerber, Kriebel, Luksic, Johnson House, LGRAC). Until then the page shows no distance for them.
- **Tests:** `npm test` (or `bun test`) runs the filtering, building matching, DST and polling logic against the real 2026-10-17 scrape in `test/fixtures`.

## A note on scraping

This reads public posts from public Instagram accounts through Apify. Instagram's terms restrict automated collection, so keep it small and non-commercial. Clubs can ask to be removed: delete the handle from `data/accounts.json`, or set `active = 0` in D1. The test fixture keeps post IDs and timestamps but no captions.
