/**
 * OW Guessr — gameplay stats backend (Cloudflare Worker + D1)
 *
 * Two endpoints:
 *   POST /api/event   — the game client calls this once per completed
 *                       puzzle attempt that actually counts toward stats
 *                       (the same "first completion only" rule already
 *                       used for the player's own local stats). Public,
 *                       but loosely gated by an Origin check.
 *   GET  /api/stats    — returns the aggregated numbers for your own
 *                       dashboard. Gated by STATS_TOKEN so only you can
 *                       read it.
 *
 * Everything the client sends is anonymous — no IP, name, or player
 * identifier is stored, just which puzzle, the result, and the guess count.
 */

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

async function handleEvent(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = cors(origin, env.ALLOWED_ORIGIN);

  // Best-effort origin check — not airtight (headers can be spoofed by
  // non-browser clients) but stops casual/accidental cross-site spam.
  if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
    return json({ error: 'origin not allowed' }, 403, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400, headers);
  }

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
  // Streak is only meaningful for release-day wins — ignore it otherwise
  // so a stray/incorrect client payload can't inflate the all-time record.
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

  // Pick the highest-count guess value per day from winGuessRows (already
  // ordered so the first row seen per day is the mode; ties broken toward
  // the lower guess count).
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
    if (url.pathname === '/api/event' && request.method === 'POST') {
      return handleEvent(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }
    return json({ error: 'not found' }, 404);
  },
};
