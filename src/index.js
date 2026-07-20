/**
 * OW Guessr — backend (Cloudflare Worker + D1)
 *
 * This Worker is now the ONLY place the puzzle answers live. The game
 * client never receives a future (or even today's) answer directly — it
 * only gets back correct/incorrect per field, and the real answer is only
 * revealed once a puzzle is actually finished. This closes the "read the
 * page source to see every future day's answer" issue, since there's
 * simply nothing answer-bearing in the client bundle to read anymore.
 *
 * Endpoints:
 *   GET  /api/puzzle?tz=<IANA tz>&day=<N optional>
 *        Metadata only (day, difficulty, image, revealImage, isArchive) —
 *        no answer fields. Omit `day` to get "today" for that timezone.
 *        Requesting a day that hasn't unlocked yet returns 403.
 *
 *   GET  /api/days?tz=<IANA tz>
 *        Metadata for every day that HAS unlocked (for the archive list).
 *
 *   POST /api/guess   { day, tz, team1, team2, year, tournament }
 *        Checks a guess against the real answer server-side and returns
 *        only booleans per field — never the answer itself. Rate-limited
 *        per IP to make brute-forcing impractical.
 *
 *   GET  /api/answer?day=<N>&tz=<IANA tz>
 *        The real answer for a day, but ONLY if that day has unlocked.
 *        Used once a puzzle is finished, to show the result banner/share
 *        text and swap in the reveal image.
 *
 *   POST /api/event   — unchanged: records a completed attempt for the
 *                       stats dashboard (see /api/stats).
 *   GET  /api/stats    — unchanged: your token-gated stats dashboard feed.
 *
 * No player identity is ever stored anywhere.
 */

/* =========================================================================
   PUZZLE DATABASE — the only copy of the answers now lives here. To add a
   new day, append an entry with the next sequential day number; it goes
   live automatically on its corresponding calendar date (see DAY SCHEDULE
   below) and is completely invisible to clients — even via dev tools —
   until then.
   - `tournament` can be a single string, or an array of strings if more
     than one answer should count as correct (e.g. a Stage that also
     counted as that Stage's Title Matches). The first entry is used as
     the display string.
   ========================================================================= */
const ROUNDS = [
  {
    day: 1, difficulty: "Silver",
    team1: "London Spitfire", team2: "Philadelphia Fusion",
    year: 2018, tournament: "Playoffs",
    image: "images/Day 1.png",
    revealImage: "images/Day 1 Answer.png"
  },
  {
    day: 2, difficulty: "Gold",
    team1: "London Spitfire", team2: "Los Angeles Gladiators",
    year: 2018, tournament: "Playoffs",
    image: "images/Day 2.png",
    revealImage: "images/Day 2 Answer.png"
  },
  {
    day: 3, difficulty: "Masters",
    team1: "Toronto Ultra", team2: "ZETA DIVISION",
    year: 2024, tournament: "Esports World Cup",
    image: "images/Day 3.png",
    revealImage: "images/Day 3 Answer.png"
  },
  {
    day: 4, difficulty: "Bronze",
    team1: "Shanghai Dragons", team2: "Boston Uprising",
    year: 2019, tournament: "Stage 1",
    image: "images/Day 4.png",
    revealImage: "images/Day 4 Answer.png"
  },
  {
    day: 5, difficulty: "Grandmaster",
    team1: "London Spitfire", team2: "Atlanta Reign",
    year: 2023, tournament: "Playoffs",
    image: "images/Day 5.png",
    revealImage: "images/Day 5 Answer.png"
  },
  {
    day: 6, difficulty: "Champion",
    team1: "Toronto Defiant", team2: "Washington Justice",
    year: 2021, tournament: ["Countdown Cup Qualifiers", "Stage 4"],
    image: "images/Day 6.png",
    revealImage: "images/Day 6 Answer.png"
  },
  {
    day: 7, difficulty: "Diamond",
    team1: "Crazy Raccoont", team2: "Team Falcons",
    year: 2024, tournament: ["World Finals", "Playoffs"],
    image: "images/Day 7.png",
    revealImage: "images/Day 7 Answer.png"
  }
];

/* =========================================================================
   DAY SCHEDULE — same rule as before, just evaluated here instead of in
   the browser. Day 1 is live until DAY2_DATE; Day 2 goes live on that date;
   every day after is exactly one calendar day later. Each visitor still
   gets their new puzzle at THEIR OWN local midnight — the client tells us
   its IANA timezone (e.g. "Europe/London"), which is just a place name,
   not a manipulable clock value, and we compute "what date is it there"
   using the Worker's own trusted system clock. Changing your device clock
   has no effect at all now, since the Worker's clock is never influenced
   by the client in any way.

   (One inherent, minor edge case with ANY per-timezone daily rollover: a
   visitor could set their device's timezone — not clock — to somewhere
   like UTC+14 to see each new day up to ~a day early. That's a universal
   quirk of "local midnight" daily puzzles, not something specific to this
   implementation, and it only ever grants early access to a day that was
   going to unlock soon anyway — never a peek at truly future content.)
   ========================================================================= */
const DAY2_DATE = { year: 2026, month: 7, day: 18 }; // July 18, 2026

function getDayNumberForTz(tz) {
  const safeTz = isValidTimeZone(tz) ? tz : 'UTC';
  const now = new Date(); // the Worker's own system clock — not client-influenced
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);

  const localAsUTC = Date.UTC(y, m - 1, d);
  const day2AsUTC = Date.UTC(DAY2_DATE.year, DAY2_DATE.month - 1, DAY2_DATE.day);

  let day = localAsUTC < day2AsUTC ? 1 : 2 + Math.round((localAsUTC - day2AsUTC) / 86400000);
  const maxDefined = Math.max(...ROUNDS.map(r => r.day));
  return Math.min(day, maxDefined);
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function findRoundByDay(day) { return ROUNDS.find(r => r.day === day); }

function publicMeta(round, isArchive) {
  return {
    day: round.day,
    difficulty: round.difficulty || null,
    image: round.image,
    revealImage: round.revealImage || null,
    isArchive: !!isArchive,
  };
}

/* ---------------- answer-matching (ported from the old client code, byte
   for byte the same rules, just run here instead) ---------------- */
function norm(s) { return (s || '').toString().trim().toLowerCase(); }

function tournamentAnswers(r) { return Array.isArray(r.tournament) ? r.tournament : [r.tournament]; }
function tournamentDisplay(r) { return tournamentAnswers(r).join(' / '); }

function scoreTeamGuesses(guess1, guess2, answer1, answer2) {
  const g1 = norm(guess1), g2 = norm(guess2);
  const pool = [norm(answer1), norm(answer2)];
  let box1Ok = false, box2Ok = false;

  if (g1 === pool[0]) { box1Ok = true; pool[0] = null; }
  if (g2 === pool[1]) { box2Ok = true; pool[1] = null; }
  if (!box1Ok && pool.includes(g1)) { box1Ok = true; pool[pool.indexOf(g1)] = null; }
  if (!box2Ok && pool.includes(g2)) { box2Ok = true; pool[pool.indexOf(g2)] = null; }

  return { box1Ok, box2Ok };
}

/* ---------------- shared helpers ---------------- */
function cors(origin, allowedOrigin) {
  const allowOrigin = allowedOrigin && origin === allowedOrigin ? origin : (allowedOrigin ? 'null' : '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function originCheck(request, env, headers) {
  const origin = request.headers.get('Origin') || '';
  if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
    return json({ error: 'origin not allowed' }, 403, headers);
  }
  return null;
}

/* ---------------- simple per-IP rate limiting (D1-backed) ----------------
   Not perfect (D1 read-then-write isn't atomic under heavy concurrency),
   but more than enough to make scripted brute-forcing of /api/guess
   impractical without adding any new infrastructure. */
async function checkRateLimit(env, ip, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, count FROM rate_limit WHERE ip = ?').bind(ip).first();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare(
      `INSERT INTO rate_limit (ip, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET window_start = excluded.window_start, count = 1`
    ).bind(ip, now).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare('UPDATE rate_limit SET count = count + 1 WHERE ip = ?').bind(ip).run();
  return true;
}

/* ---------------- route handlers ---------------- */

async function handlePuzzle(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);
  const blocked = originCheck(request, env, headers);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const tz = url.searchParams.get('tz') || 'UTC';
  const currentDay = getDayNumberForTz(tz);
  const dayParam = url.searchParams.get('day');
  const targetDay = dayParam ? Number(dayParam) : currentDay;

  if (!Number.isInteger(targetDay) || targetDay < 1) {
    return json({ error: 'invalid day' }, 400, headers);
  }
  if (targetDay > currentDay) {
    return json({ error: 'not released yet' }, 403, headers);
  }
  const round = findRoundByDay(targetDay);
  if (!round) return json({ error: 'not found' }, 404, headers);

  return json({ ...publicMeta(round, targetDay < currentDay), currentDay }, 200, headers);
}

async function handleDays(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);
  const blocked = originCheck(request, env, headers);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const tz = url.searchParams.get('tz') || 'UTC';
  const currentDay = getDayNumberForTz(tz);

  const days = ROUNDS
    .filter(r => r.day < currentDay)
    .map(r => ({ day: r.day, difficulty: r.difficulty || null }))
    .sort((a, b) => b.day - a.day);

  return json({ currentDay, days }, 200, headers);
}

async function handleGuess(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);
  const blocked = originCheck(request, env, headers);
  if (blocked) return blocked;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await checkRateLimit(env, ip, 60, 60 * 60 * 1000); // 60 guesses/hour/IP
  if (!allowed) return json({ error: 'rate limited, try again later' }, 429, headers);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400, headers); }

  const tz = typeof body.tz === 'string' ? body.tz : 'UTC';
  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 1) return json({ error: 'invalid day' }, 400, headers);

  const currentDay = getDayNumberForTz(tz);
  if (day > currentDay) return json({ error: 'not released yet' }, 403, headers);

  const round = findRoundByDay(day);
  if (!round) return json({ error: 'not found' }, 404, headers);

  const { box1Ok: team1Ok, box2Ok: team2Ok } = scoreTeamGuesses(body.team1, body.team2, round.team1, round.team2);
  const yearOk = norm(body.year) === norm(String(round.year));
  const tournamentOk = tournamentAnswers(round).some(t => norm(body.tournament) === norm(t));
  const allCorrect = team1Ok && team2Ok && yearOk && tournamentOk;

  return json({ team1Ok, team2Ok, yearOk, tournamentOk, allCorrect }, 200, headers);
}

async function handleAnswer(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);
  const blocked = originCheck(request, env, headers);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const tz = url.searchParams.get('tz') || 'UTC';
  const day = Number(url.searchParams.get('day'));
  if (!Number.isInteger(day) || day < 1) return json({ error: 'invalid day' }, 400, headers);

  const currentDay = getDayNumberForTz(tz);
  if (day > currentDay) return json({ error: 'not released yet' }, 403, headers);

  const round = findRoundByDay(day);
  if (!round) return json({ error: 'not found' }, 404, headers);

  return json({
    day: round.day,
    team1: round.team1,
    team2: round.team2,
    year: round.year,
    tournament: tournamentDisplay(round),
    revealImage: round.revealImage || round.image,
  }, 200, headers);
}

async function handleEvent(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);
  const blocked = originCheck(request, env, headers);
  if (blocked) return blocked;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400, headers); }

  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 1 || day > 100000) {
    return json({ error: 'invalid day' }, 400, headers);
  }
  const difficulty = typeof body.difficulty === 'string' ? body.difficulty.slice(0, 40) : null;
  const isArchive = body.isArchive ? 1 : 0;
  const win = body.win ? 1 : 0;
  const gaveUp = body.gaveUp ? 1 : 0;
  let guessCount = Number.isInteger(body.guessCount) ? body.guessCount : null;
  if (guessCount !== null && (guessCount < 1 || guessCount > 6)) guessCount = null;
  let streak = Number.isInteger(body.streak) ? body.streak : null;
  if (isArchive || !win) streak = null;

  await env.DB.prepare(
    `INSERT INTO plays (day, difficulty, is_archive, win, gave_up, guess_count, streak)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(day, difficulty, isArchive, win, gaveUp, guessCount, streak).run();

  return json({ ok: true }, 200, headers);
}

async function handleStats(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, null); // stats reads are token-gated, so CORS can stay open

  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get('token');
  const authHeader = request.headers.get('Authorization') || '';
  const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = tokenFromQuery || tokenFromHeader;

  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return json({ error: 'unauthorized' }, 401, headers);
  }

  const db = env.DB;

  const [{ results: overallRows }, { results: distRows }, { results: perDayRows }, { results: winGuessRows }, { results: streakRow }] =
    await Promise.all([
      db.prepare(
        `SELECT
           COUNT(*)                                   AS total_plays,
           SUM(win)                                    AS total_wins,
           SUM(gave_up)                                AS total_gave_up,
           SUM(CASE WHEN win = 0 AND gave_up = 0 THEN 1 ELSE 0 END) AS total_ran_out,
           AVG(CASE WHEN win = 1 THEN guess_count END) AS overall_avg_guesses
         FROM plays`
      ).all(),
      db.prepare(
        `SELECT guess_count, COUNT(*) AS cnt
         FROM plays WHERE win = 1 AND guess_count IS NOT NULL
         GROUP BY guess_count ORDER BY guess_count`
      ).all(),
      db.prepare(
        `SELECT day,
           COUNT(*)                                    AS plays,
           SUM(win)                                    AS wins,
           AVG(CASE WHEN win = 1 THEN guess_count END)  AS avg_guesses,
           MAX(difficulty)                             AS difficulty
         FROM plays GROUP BY day ORDER BY day`
      ).all(),
      db.prepare(
        `SELECT day, guess_count, COUNT(*) AS cnt
         FROM plays WHERE win = 1 AND guess_count IS NOT NULL
         GROUP BY day, guess_count ORDER BY day, cnt DESC, guess_count ASC`
      ).all(),
      db.prepare(`SELECT MAX(streak) AS max_streak FROM plays WHERE is_archive = 0 AND win = 1`).all(),
    ]);

  const modeByDay = {};
  for (const row of winGuessRows) {
    if (!(row.day in modeByDay)) modeByDay[row.day] = row.guess_count;
  }

  const distByDay = {};
  for (const row of winGuessRows) {
    if (!distByDay[row.day]) distByDay[row.day] = [0, 0, 0, 0, 0, 0];
    distByDay[row.day][row.guess_count - 1] += row.cnt;
  }

  const overall = overallRows[0] || {};
  const totalPlays = overall.total_plays || 0;
  const totalWins = overall.total_wins || 0;

  const guessDistribution = [0, 0, 0, 0, 0, 0];
  for (const row of distRows) guessDistribution[row.guess_count - 1] = row.cnt;

  const perDay = perDayRows.map(row => ({
    day: row.day,
    difficulty: row.difficulty,
    plays: row.plays,
    wins: row.wins,
    winRatePct: row.plays ? Math.round((row.wins / row.plays) * 1000) / 10 : 0,
    avgGuesses: row.avg_guesses !== null ? Math.round(row.avg_guesses * 100) / 100 : null,
    mostCommonGuessCount: modeByDay[row.day] ?? null,
    guessDistribution: distByDay[row.day] || [0, 0, 0, 0, 0, 0],
  }));

  return json({
    generatedAt: new Date().toISOString(),
    overall: {
      totalPlays,
      totalWins,
      totalLosses: totalPlays - totalWins,
      overallWinRatePct: totalPlays ? Math.round((totalWins / totalPlays) * 1000) / 10 : 0,
      overallAvgGuesses: overall.overall_avg_guesses !== null ? Math.round(overall.overall_avg_guesses * 100) / 100 : null,
      highestStreakEver: (streakRow[0] && streakRow[0].max_streak) || 0,
      gaveUpCount: overall.total_gave_up || 0,
      ranOutOfGuessesCount: overall.total_ran_out || 0,
      guessDistribution,
    },
    perDay,
  }, 200, headers);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(request.headers.get('Origin') || '', env.ALLOWED_ORIGIN) });
    }
    if (url.pathname === '/api/puzzle' && request.method === 'GET') return handlePuzzle(request, env);
    if (url.pathname === '/api/days' && request.method === 'GET') return handleDays(request, env);
    if (url.pathname === '/api/guess' && request.method === 'POST') return handleGuess(request, env);
    if (url.pathname === '/api/answer' && request.method === 'GET') return handleAnswer(request, env);
    if (url.pathname === '/api/event' && request.method === 'POST') return handleEvent(request, env);
    if (url.pathname === '/api/stats' && request.method === 'GET') return handleStats(request, env);
    return json({ error: 'not found' }, 404);
  },
};
