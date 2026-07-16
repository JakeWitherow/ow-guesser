# OW Guessr — stats backend

A tiny Cloudflare Worker + D1 (SQLite) database that collects one row per
completed puzzle attempt and serves the aggregated numbers you asked for:
overall average guesses, most common guess count per puzzle, highest streak
ever recorded, guess distribution, and total plays — per puzzle and overall.

It's free on Cloudflare's free tier for this kind of traffic, and there's
nothing to maintain beyond deploying it once.

## What it does

- `POST /api/event` — the game calls this once per puzzle finish that
  actually counts toward stats (same "first completion only" rule the game
  already uses for your own local stats — replays don't get sent here
  either). No personal data is sent, just: day, difficulty, win/loss/gave up,
  guesses used, and — only for release-day wins — the resulting streak.
- `GET /api/stats?token=YOUR_TOKEN` — returns the aggregated JSON for your
  dashboard. Locked behind a token only you know.

## 1. Install Wrangler (Cloudflare's CLI)

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the D1 database

```bash
cd backend
npx wrangler d1 create owguessr-db
```

This prints a `database_id` — paste it into `wrangler.toml` in place of
`REPLACE_WITH_YOUR_DATABASE_ID`.

Then create the table:

```bash
npx wrangler d1 execute owguessr-db --file=./schema.sql --remote
```

## 3. Set your secrets

```bash
npx wrangler secret put STATS_TOKEN
# paste any long random string when prompted — this is your dashboard password

npx wrangler secret put ALLOWED_ORIGIN
# e.g. https://jakewitherow.github.io  (whatever origin your game is served from,
# no trailing slash)
```

`ALLOWED_ORIGIN` is a best-effort spam filter, not real security — it just
stops random browser traffic from other sites hitting your event endpoint.
Skip setting it (or leave it blank) if you'd rather not bother, and the
Worker will accept events from anywhere.

## 4. Deploy

```bash
npx wrangler deploy
```

Wrangler will print your Worker's URL, something like:

```
https://owguessr-stats.<your-subdomain>.workers.dev
```

That's the `BACKEND_URL` to paste into `index.html` (see the comment near
the top of the `<script>` block — look for `BACKEND_URL`).

## 5. View your stats

Open `stats.html` (included alongside this backend) in a browser, either
locally or hosted anywhere (it can even sit in the same GitHub repo/Pages
site). It'll ask for your Worker URL and your `STATS_TOKEN` once, and
remembers them in that browser via `sessionStorage` (cleared when you close
the tab).

## Notes / limitations

- Concurrent writes are handled by D1 itself (each INSERT is its own atomic
  statement), so there's no risk of lost data even with several players
  finishing puzzles at the same moment.
- There's no per-player identity — this only ever answers "how did everyone
  do," not "how did player X do." That matches what you asked for.
- If you ever want per-player leaderboards later, that's a bigger change
  (needs some form of player identity) — happy to help with that separately
  if you want it.
- Free tier limits (as of writing): D1 gives 5GB storage and a very high
  daily read/write allowance, and Workers gives 100,000 requests/day free —
  both are far more than a hobby daily-puzzle site will need.
