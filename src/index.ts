import { ApiError, type ErrorCode, type Failure, STATUS } from './errors.js';
import { CHANNELS, type Game, RUNTIMES, boardKey, registry } from './games.js';
import {
  type BoardFilter,
  MAX_RANK,
  PAGE_SIZE,
  leaderboardPage,
  playerRank,
  pruneResults,
  rebuildBests,
} from './leaderboard.js';
import { log } from './log.js';
import type { InputChunk, PlayerSession } from './session.js';
import { int, optionalInt, readJson, str } from './validate.js';

export { PlayerSession } from './session.js';

const JSON_LIMIT = 2048;
const INPUT_LIMIT = 16 * 1024;
const RESULT_RETENTION_MS = 90 * 24 * 3_600_000;
const BOARD_CACHE_SECONDS = 30;
const RUN_ID = /^[0-9a-f-]{36}$/;
const BUILD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type Route = { method: string; pattern: RegExp; handler: Handler };
type Handler = (ctx: RequestContext, params: string[]) => Promise<Response>;
type RequestContext = {
  request: Request;
  env: Env;
  url: URL;
  exec: ExecutionContext;
  receivedAt: number;
};

const routes: Route[] = [];
const route = (method: string, pattern: RegExp, handler: Handler) =>
  routes.push({ method, pattern, handler });

export default {
  async fetch(request, env, exec): Promise<Response> {
    const receivedAt = Date.now();
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response: Response;
    try {
      response = await dispatch({ request, env, url, exec, receivedAt });
    } catch (error) {
      if (error instanceof ApiError) response = errorResponse(error.failure);
      else {
        log('internal_error', { path: url.pathname, error: String(error) });
        response = errorResponse({ ok: false, code: 'internal', message: 'internal error' });
      }
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(_controller, env): Promise<void> {
    let removed = 0;
    for (let batch = 0; batch < 20; batch++) {
      const n = await pruneResults(env.DB, Date.now() - RESULT_RETENTION_MS);
      removed += n;
      if (n < 500) break;
    }
    log('results_pruned', { removed });
  },
} satisfies ExportedHandler<Env>;

async function dispatch(ctx: RequestContext): Promise<Response> {
  if (ctx.url.pathname !== '/v1/health') {
    await limit(ctx.env.IP_LIMITER, `ip:${addressKey(ctx.request)}`);
  }
  for (const r of routes) {
    const match = r.pattern.exec(ctx.url.pathname);
    if (match && r.method === ctx.request.method) return r.handler(ctx, match.slice(1));
  }
  throw new ApiError('not_found', 'no such route');
}

// --- public ------------------------------------------------------------------

route('GET', /^\/v1\/health$/, async () => json({ ok: true, games: [...registry.keys()] }));

route('GET', /^\/v1\/games\/([a-z0-9_]+)$/, async (_ctx, [gameId = '']) => {
  const game = getGame(gameId);
  return json({
    id: game.id,
    name: game.name,
    boards: [...game.boards],
    modes: game.modes,
    runtimes: RUNTIMES,
    channels: CHANNELS,
    achievements: game.achievements.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
    })),
  });
});

route('POST', /^\/v1\/guests$/, async ({ request, env }) => {
  await limit(env.GUEST_LIMITER, `guest:${addressKey(request)}`);
  const body = await readJson(request, JSON_LIMIT);
  const game = getGame(str(body, 'game_id', /^[a-z0-9_]{1,32}$/));
  const buildId = str(body, 'build_id', BUILD_ID);
  if (!game.builds.has(buildId))
    throw new ApiError('unsupported_build', 'this build is not registered');
  const playerId = hex(crypto.getRandomValues(new Uint8Array(16)));
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const displayName = `Guest-${playerId.slice(0, 6).toUpperCase()}`;
  await env.DB.prepare(
    'INSERT INTO players (game_id, player_id, display_name, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(game.id, playerId, displayName, Date.now())
    .run();
  const registered = await session(env, game.id, playerId).register(
    game.id,
    playerId,
    await sha256(secret),
  );
  if (!registered) throw new ApiError('internal', 'player id collision');
  log('guest_created', { game: game.id });
  return json(
    { player_id: playerId, token: `${playerId}.${secret}`, display_name: displayName },
    201,
  );
});

route(
  'GET',
  /^\/v1\/games\/([a-z0-9_]+)\/leaderboards$/,
  async ({ request, env, url, exec }, [gameId = '']) => {
    const game = getGame(gameId);
    const q = url.searchParams;
    const board = q.get('board') ?? game.defaultBoard;
    if (!game.boards.has(board)) throw new ApiError('bad_request', 'unknown board');
    // A moded game ranks each mode separately; the first mode is the default.
    const mode = game.modes.length ? (q.get('mode') ?? game.modes[0] ?? null) : null;
    if (mode !== null && !game.modes.includes(mode))
      throw new ApiError('bad_request', 'unknown mode');
    // country=auto is the caller's own country; such responses vary per caller.
    const auto = q.get('country') === 'auto';
    const visibility = auto ? 'private' : 'public';
    const filter: BoardFilter = {
      game: game.id,
      board: boardKey(board, mode),
      country: auto
        ? normalizeCountry((request.cf as { country?: string } | undefined)?.country)
        : optionalParam(q, 'country', /^[A-Z]{2}$/),
      runtime: optionalParam(q, 'runtime', new RegExp(`^(${RUNTIMES.join('|')})$`)),
      channel: optionalParam(q, 'channel', new RegExp(`^(${CHANNELS.join('|')})$`)),
    };
    const page = Number(q.get('page') ?? '0');
    if (!Number.isInteger(page) || page < 0 || page >= MAX_RANK / PAGE_SIZE) {
      throw new ApiError('bad_request', `page must be 0..${MAX_RANK / PAGE_SIZE - 1}`);
    }
    const cacheKey = new Request(
      `${url.origin}/v1/games/${game.id}/leaderboards?${new URLSearchParams({
        board,
        mode: mode ?? '',
        country: filter.country ?? (auto ? 'unknown' : ''),
        runtime: filter.runtime ?? '',
        channel: filter.channel ?? '',
        page: String(page),
      })}`,
    );
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    let body = cached ? await cached.json<Record<string, unknown>>() : undefined;
    if (!body) {
      const entries = auto && !filter.country ? [] : await leaderboardPage(env.DB, filter, page);
      body = {
        game: game.id,
        board,
        mode,
        filters: { country: filter.country, runtime: filter.runtime, channel: filter.channel },
        page,
        page_size: PAGE_SIZE,
        entries: entries.map((e) => ({ rank: e.rank, name: e.name, score: e.score })),
      };
      exec.waitUntil(
        cache.put(
          cacheKey,
          json(body, 200, { 'cache-control': `public, max-age=${BOARD_CACHE_SECONDS}` }),
        ),
      );
    }
    if (q.get('me') !== '1')
      return json(body, 200, { 'cache-control': `${visibility}, max-age=${BOARD_CACHE_SECONDS}` });
    const auth = await authenticate(request, env, game.id);
    const checked = await auth.session.check(auth.secretHash);
    if (!checked.ok) return reply(checked, () => null);
    const me = auto && !filter.country ? null : await playerRank(env.DB, filter, auth.player);
    return json({ ...body, me }, 200, {
      'cache-control': 'private, no-store',
    });
  },
);

// --- player ------------------------------------------------------------------

route(
  'GET',
  /^\/v1\/games\/([a-z0-9_]+)\/me\/achievements$/,
  async ({ request, env }, [gameId = '']) => {
    const game = getGame(gameId);
    const auth = await authenticate(request, env, game.id);
    return reply(await auth.session.achievements(auth.secretHash), (r) => ({
      achievements: r.achievements,
    }));
  },
);

route('POST', /^\/v1\/games\/([a-z0-9_]+)\/runs$/, async ({ request, env }, [gameId = '']) => {
  const game = getGame(gameId);
  const auth = await authenticate(request, env, game.id);
  const body = await readJson(request, JSON_LIMIT);
  const build = game.builds.get(str(body, 'build_id', BUILD_ID));
  if (!build)
    throw new ApiError('unsupported_build', 'this build is not registered for ranked play');
  const modes = build.ruleset.modes ?? [];
  const mode = body.mode === undefined ? null : str(body, 'mode', /^[a-z0-9_]{1,32}$/);
  if (modes.length ? mode === null || !modes.includes(mode) : mode !== null)
    throw new ApiError(
      'bad_request',
      modes.length ? 'mode is not one of this build modes' : 'this game has no modes',
    );
  // Throttling, the disabled-ruleset check and admission run in the player's
  // object after the credential check, so forged tokens cannot spend capacity.
  const country = normalizeCountry((request.cf as { country?: string } | undefined)?.country);
  return reply(
    await auth.session.startRun(auth.secretHash, build.id, country, mode),
    (r) => r.run,
    201,
  );
});

route(
  'POST',
  /^\/v1\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/inputs$/,
  async ({ request, env, receivedAt }, [gameId = '', runId = '']) => {
    const game = getGame(gameId);
    const auth = await authenticate(request, env, game.id);
    const body = await readJson(request, INPUT_LIMIT);
    const chunk: InputChunk = {
      seq: int(body, 'seq', 0, 1_000_000),
      fromTick: int(body, 'from_tick', 0, 100_000_000),
      inputs: str(body, 'inputs', /^[0-9:,]{3,12000}$/),
    };
    const checksum = optionalInt(body, 'checksum', 0, 2147483646);
    if (checksum !== undefined) chunk.checksum = checksum;
    const elapsedMs = optionalInt(body, 'elapsed_ms', 0, 60_000);
    if (elapsedMs !== undefined) chunk.elapsedMs = elapsedMs;
    return reply(
      await auth.session.submitInputs(auth.secretHash, runIdOf(runId), chunk, receivedAt),
      (r) => r.ack,
    );
  },
);

route(
  'POST',
  /^\/v1\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/pause$/,
  async ({ request, env, receivedAt }, [gameId = '', runId = '']) => {
    const auth = await authenticate(request, env, getGame(gameId).id);
    const body = await readJson(request, JSON_LIMIT);
    return reply(
      await auth.session.pause(
        auth.secretHash,
        runIdOf(runId),
        int(body, 'tick', 0, 100_000_000),
        receivedAt,
      ),
      (r) => r.ack,
    );
  },
);

route(
  'POST',
  /^\/v1\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/resume$/,
  async ({ request, env }, [gameId = '', runId = '']) => {
    const auth = await authenticate(request, env, getGame(gameId).id);
    return reply(await auth.session.resume(auth.secretHash, runIdOf(runId)), (r) => ({
      ...r.ack,
      server_time: r.server_time,
      expected_tick: r.expected_tick,
    }));
  },
);

route(
  'POST',
  /^\/v1\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/finish$/,
  async ({ request, env }, [gameId = '', runId = '']) => {
    const auth = await authenticate(request, env, getGame(gameId).id);
    const body = await readJson(request, JSON_LIMIT);
    return reply(
      await auth.session.finish(auth.secretHash, runIdOf(runId), int(body, 'tick', 0, 100_000_000)),
      (r) => r.outcome,
    );
  },
);

route(
  'POST',
  /^\/v1\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/abandon$/,
  async ({ request, env }, [gameId = '', runId = '']) => {
    const auth = await authenticate(request, env, getGame(gameId).id);
    return reply(await auth.session.abandon(auth.secretHash, runIdOf(runId)), () => ({
      status: 'abandoned',
    }));
  },
);

// --- administration ------------------------------------------------------------

route(
  'POST',
  /^\/v1\/admin\/games\/([a-z0-9_]+)\/players\/([0-9a-f]{32})\/hide$/,
  async ({ request, env }, [gameId = '', playerId = '']) => {
    await requireAdmin(request, env);
    const body = await readJson(request, JSON_LIMIT);
    if (body.hidden !== undefined && typeof body.hidden !== 'boolean') {
      throw new ApiError('bad_request', 'hidden must be a boolean');
    }
    const hidden = body.hidden !== false;
    await env.DB.prepare('UPDATE players SET hidden = ? WHERE game_id = ? AND player_id = ?')
      .bind(hidden ? 1 : 0, getGame(gameId).id, playerId)
      .run();
    log('admin_hide_player', { game: gameId, hidden });
    return json({ ok: true, hidden });
  },
);

route(
  'POST',
  /^\/v1\/admin\/games\/([a-z0-9_]+)\/runs\/([0-9a-f-]+)\/suppress$/,
  async ({ request, env }, [gameId = '', runId = '']) => {
    await requireAdmin(request, env);
    const game = getGame(gameId);
    const id = runIdOf(runId);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO suppressed_runs (run_id, game_id, suppressed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      ).bind(id, game.id, Date.now()),
      env.DB.prepare('UPDATE results SET suppressed = 1 WHERE game_id = ? AND run_id = ?').bind(
        game.id,
        id,
      ),
    ]);
    await rebuildBests(env.DB, game.id);
    log('admin_suppress_run', { game: game.id });
    return json({ ok: true });
  },
);

route(
  'POST',
  /^\/v1\/admin\/games\/([a-z0-9_]+)\/rulesets\/([0-9a-f]{16})\/disable$/,
  async ({ request, env }, [gameId = '', ruleset = '']) => {
    await requireAdmin(request, env);
    const game = getGame(gameId);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO disabled_rulesets (game_id, ruleset, disabled_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      ).bind(game.id, ruleset, Date.now()),
      env.DB.prepare('UPDATE results SET suppressed = 1 WHERE game_id = ? AND ruleset = ?').bind(
        game.id,
        ruleset,
      ),
    ]);
    await rebuildBests(env.DB, game.id);
    log('admin_disable_ruleset', { game: game.id, ruleset });
    return json({ ok: true });
  },
);

// --- helpers -------------------------------------------------------------------

function getGame(id: string): Game {
  const game = registry.get(id);
  if (!game) throw new ApiError('unknown_game', 'unknown game');
  return game;
}

function session(env: Env, game: string, player: string): DurableObjectStub<PlayerSession> {
  return env.PLAYERS.get(env.PLAYERS.idFromName(`${game}:${player}`));
}

async function authenticate(request: Request, env: Env, game: string) {
  const match = /^Bearer ([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get('authorization') ?? '',
  );
  if (!match) throw new ApiError('unauthorized', 'missing or malformed bearer token');
  const [, player = '', secret = ''] = match;
  return { player, session: session(env, game, player), secretHash: await sha256(secret) };
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const expected = await sha256(env.ADMIN_TOKEN ?? '');
  const given = await sha256((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || given !== expected) {
    throw new ApiError('forbidden', 'administrator credential required');
  }
}

/** Throttle key for the caller's address; an IPv6 client is keyed by its /64. */
function addressKey(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const groups = ip.split('::')[0]?.split(':') ?? [];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

async function limit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError('rate_limited', 'too many requests; retry later');
}

function reply<T extends object>(
  result: ({ ok: true } & T) | Failure,
  pick: (r: T) => unknown,
  status = 200,
): Response {
  if (!result.ok) return errorResponse(result);
  return json(pick(result as T), status, { 'cache-control': 'no-store' });
}

function errorResponse(f: Failure): Response {
  const error: { code: ErrorCode; message: string; details?: unknown } = {
    code: f.code,
    message: f.message,
  };
  if (f.details !== undefined) error.details = f.details;
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (f.code === 'rate_limited' || f.code === 'capacity') headers['retry-after'] = '60';
  return json({ error }, STATUS[f.code], headers);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function optionalParam(q: URLSearchParams, key: string, pattern: RegExp): string | null {
  const v = q.get(key);
  if (v === null || v === '') return null;
  if (!pattern.test(v)) throw new ApiError('bad_request', `${key} is invalid`);
  return v;
}

function runIdOf(id: string): string {
  if (!RUN_ID.test(id)) throw new ApiError('bad_request', 'run id is invalid');
  return id;
}

function normalizeCountry(code: string | undefined): string | null {
  // XX = unknown, T1 = Tor; neither is a country.
  return code && /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
