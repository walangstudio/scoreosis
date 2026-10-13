import { DurableObject } from 'cloudflare:workers';
import { achievementEngine, recordVerifiedRun } from './achievements.js';
import { sqliteStores } from './badgetrip-sqlite.js';
import { ApiError, type Failure, fail } from './errors.js';
import { type Build, type Game, registry } from './games.js';
import { type PublishedResult, publishResult } from './leaderboard.js';
import { log } from './log.js';
import { type InputRun, formatInputs, parseInputs, skipTicks, tickCount } from './validate.js';
import driver from './vm/driver.lua';
import { LuaVm, VmError } from './vm/host.js';
import luaWasm from './vm/lua51.wasm';

export const TICK_RATE = 60;
/** Ticks one input request may carry; two seconds lets a client catch up after a hiccup. */
export const CHUNK_MAX_TICKS = 120;
/** How far behind real time accepted input may be (1.5 s). */
export const WINDOW_TICKS = 90;
/** Client clocks may run this far ahead of the server's expectation. */
const FUTURE_SLACK_TICKS = 6;
const DRIFT = 0.005;
export const PAUSE_MAX_MS = 15 * 60_000;
export const PAUSE_TOTAL_MS = 60 * 60_000;
export const RUN_EXPIRY_MS = 24 * 3_600_000;
const CHECKPOINT_EVERY_TICKS = 600;
const TRACE_RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_BACKOFF_MS = 3_600_000;
const PUBLISH_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
const VM_LIMITS = { memory: 48 << 20, instructions: 400_000_000 };

type RunStatus = 'active' | 'paused' | 'verifying' | 'finished' | 'rejected' | 'expired';

type RunRow = {
  id: string;
  build: string;
  ruleset: string;
  board: string;
  runtime: string;
  channel: string;
  country: string | null;
  seed: number;
  status: RunStatus;
  reason: string | null;
  created_at: number;
  expires_at: number;
  baseline_ms: number;
  baseline_tick: number;
  paused_at: number | null;
  paused_total_ms: number;
  final_tick: number | null;
  score: number | null;
  facts: string | null;
  finalized_at: number | null;
};

type InputRow = {
  seq: number;
  from_tick: number;
  ticks: number;
  runs: string;
  checksum: number | null;
  body: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, build TEXT NOT NULL, ruleset TEXT NOT NULL, board TEXT NOT NULL,
  runtime TEXT NOT NULL, channel TEXT NOT NULL, country TEXT, seed INTEGER NOT NULL,
  status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  baseline_ms INTEGER NOT NULL, baseline_tick INTEGER NOT NULL, paused_at INTEGER,
  paused_total_ms INTEGER NOT NULL DEFAULT 0, final_tick INTEGER, score INTEGER, facts TEXT,
  finalized_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS inputs (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, from_tick INTEGER NOT NULL, ticks INTEGER NOT NULL,
  runs TEXT NOT NULL, checksum INTEGER, body TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT PRIMARY KEY, tick INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL
);
`;

export type StartResult = {
  run_id: string;
  seed: number;
  ruleset: string;
  board: string;
  tick_rate: number;
  chunk_max_ticks: number;
  window_ticks: number;
  server_time: number;
  expires_at: number;
};

export type Ack = {
  run_id: string;
  status: RunStatus;
  seq: number;
  ticks_received: number;
  verified_tick: number;
  reason?: string;
};

export type Outcome =
  | { status: 'verifying'; verified_tick: number; ticks_received: number; retry_after_ms: number }
  | {
      status: 'finished';
      score: number;
      facts: Record<string, number>;
      unlocked: string[];
      published: boolean;
    }
  | { status: 'rejected' | 'expired'; reason: string };

/** Live verifier state for the run currently loaded into the VM. */
type Loaded = { runId: string; vm: LuaVm; tick: number; status: string; checkpointTick: number };

/**
 * One object per (game, player). Owns the player's credential, ranked sessions,
 * the gameplay verifier and authoritative BadgeTrip state.
 */
export class PlayerSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private loaded: Loaded | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // --- identity -----------------------------------------------------------

  async register(game: string, player: string, secretHash: string): Promise<boolean> {
    if (this.meta('secret_hash')) return false;
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('game', ?), ('player', ?), ('secret_hash', ?)",
      game,
      player,
      secretHash,
    );
    return true;
  }

  async check(secretHash: string): Promise<{ ok: true; player: string } | Failure> {
    return this.guard(secretHash, async () => ({ player: this.identity().player }));
  }

  // --- runs ---------------------------------------------------------------

  async startRun(
    secretHash: string,
    buildId: string,
    country: string | null,
  ): Promise<{ ok: true; run: StartResult } | Failure> {
    return this.guard(secretHash, async () => {
      const build = this.build(buildId);
      const now = Date.now();
      const active = this.sql
        .exec<RunRow>("SELECT * FROM runs WHERE status IN ('active', 'paused', 'verifying')")
        .toArray();
      for (const run of active) this.expireIfStale(run, now);
      if (
        this.sql.exec("SELECT 1 FROM runs WHERE status IN ('active', 'paused')").toArray().length
      ) {
        throw new ApiError('run_active', 'finish or abandon the active ranked run first');
      }
      const runId = crypto.randomUUID();
      const [random = 1] = crypto.getRandomValues(new Uint32Array(1));
      const seed = (random % 2147483646) + 1;
      const expiresAt = now + RUN_EXPIRY_MS;
      this.sql.exec(
        `INSERT INTO runs (id, build, ruleset, board, runtime, channel, country, seed, status, created_at,
          expires_at, baseline_ms, baseline_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0)`,
        runId,
        build.id,
        build.ruleset.ruleset,
        build.board,
        build.runtime,
        build.channel,
        country,
        seed,
        now,
        expiresAt,
        now,
      );
      await this.scheduleAlarm();
      log('run_started', {
        game: build.game,
        ruleset: build.ruleset.ruleset,
        runtime: build.runtime,
      });
      return {
        run: {
          run_id: runId,
          seed,
          ruleset: build.ruleset.ruleset,
          board: build.board,
          tick_rate: TICK_RATE,
          chunk_max_ticks: CHUNK_MAX_TICKS,
          window_ticks: WINDOW_TICKS,
          server_time: now,
          expires_at: expiresAt,
        },
      };
    });
  }

  async submitInputs(
    secretHash: string,
    runId: string,
    chunk: { seq: number; fromTick: number; inputs: string; checksum?: number },
  ): Promise<{ ok: true; ack: Ack } | Failure> {
    return this.guard(secretHash, async () => {
      const now = Date.now();
      const run = this.run(runId);
      const body = JSON.stringify([
        chunk.seq,
        chunk.fromTick,
        chunk.inputs,
        chunk.checksum ?? null,
      ]);
      const previous = this.sql
        .exec<InputRow>('SELECT * FROM inputs WHERE run_id = ? AND seq = ?', runId, chunk.seq)
        .toArray()[0];
      if (previous) {
        if (previous.body !== body) {
          throw new ApiError(
            'sequence_conflict',
            'a different chunk was already accepted for this seq',
          );
        }
        return { ack: this.ack(run, chunk.seq) };
      }
      this.expireIfStale(run, now);
      if (run.status !== 'active') {
        throw new ApiError('run_not_active', `run is ${run.status}`, { reason: run.reason });
      }
      const { nextSeq, ticks } = this.received(runId);
      if (chunk.seq !== nextSeq) throw new ApiError('sequence_conflict', `expected seq ${nextSeq}`);
      if (chunk.fromTick !== ticks)
        throw new ApiError('sequence_conflict', `expected from_tick ${ticks}`);
      const runs = parseInputs(
        chunk.inputs,
        2 ** this.build(run.build).ruleset.buttons - 1,
        CHUNK_MAX_TICKS,
      );
      const endTick = ticks + tickCount(runs);
      const timing = this.checkTiming(run, endTick, now);
      if (timing) {
        this.reject(run, 'timing', now);
        throw new ApiError('timing_rejected', timing);
      }
      if (this.loaded?.runId === runId && this.loaded.status === 'finished') {
        this.reject(run, 'input_after_end', now);
        throw new ApiError('run_rejected', 'the run already ended at the server');
      }
      this.sql.exec(
        'INSERT INTO inputs (run_id, seq, from_tick, ticks, runs, checksum, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        runId,
        chunk.seq,
        chunk.fromTick,
        tickCount(runs),
        formatInputs(runs),
        chunk.checksum ?? null,
        body,
        now,
      );
      await this.verify(run, now);
      return { ack: this.ack(this.run(runId), chunk.seq) };
    });
  }

  async pause(
    secretHash: string,
    runId: string,
    tick: number,
  ): Promise<{ ok: true; ack: Ack } | Failure> {
    return this.guard(secretHash, async () => {
      const now = Date.now();
      const run = this.run(runId);
      this.expireIfStale(run, now);
      if (run.status !== 'active') throw new ApiError('run_not_active', `run is ${run.status}`);
      const { ticks, nextSeq } = this.received(runId);
      if (tick !== ticks)
        throw new ApiError('sequence_conflict', `flush input up to tick ${tick} first`);
      const timing = this.checkTiming(run, ticks, now);
      if (timing) {
        this.reject(run, 'timing', now);
        throw new ApiError('timing_rejected', timing);
      }
      this.sql.exec("UPDATE runs SET status = 'paused', paused_at = ? WHERE id = ?", now, runId);
      await this.scheduleAlarm();
      return { ack: this.ack(this.run(runId), nextSeq - 1) };
    });
  }

  async resume(
    secretHash: string,
    runId: string,
  ): Promise<{ ok: true; ack: Ack; server_time: number } | Failure> {
    return this.guard(secretHash, async () => {
      const now = Date.now();
      const run = this.run(runId);
      this.expireIfStale(run, now);
      if (run.status !== 'paused' || run.paused_at === null) {
        throw new ApiError('run_not_active', `run is ${run.status}`, { reason: run.reason });
      }
      const { ticks, nextSeq } = this.received(runId);
      this.sql.exec(
        "UPDATE runs SET status = 'active', paused_at = NULL, paused_total_ms = ?, baseline_ms = ?, baseline_tick = ? WHERE id = ?",
        run.paused_total_ms + (now - run.paused_at),
        now,
        ticks,
        runId,
      );
      await this.scheduleAlarm();
      return { ack: this.ack(this.run(runId), nextSeq - 1), server_time: now };
    });
  }

  async finish(
    secretHash: string,
    runId: string,
    tick: number,
  ): Promise<{ ok: true; outcome: Outcome } | Failure> {
    return this.guard(secretHash, async () => {
      const now = Date.now();
      let run = this.run(runId);
      if (run.status === 'active' || run.status === 'paused') {
        const { ticks } = this.received(runId);
        if (tick !== ticks)
          throw new ApiError('sequence_conflict', `flush input up to tick ${tick} first`);
        this.expireIfStale(run, now);
        run = this.run(runId);
        if (run.status === 'active' || run.status === 'paused') {
          this.sql.exec(
            "UPDATE runs SET status = 'verifying', final_tick = ? WHERE id = ?",
            ticks,
            runId,
          );
          run = this.run(runId);
        }
      }
      if (run.status === 'verifying') {
        await this.verify(run, now);
        run = this.run(runId);
      }
      return { outcome: await this.outcome(run) };
    });
  }

  async abandon(secretHash: string, runId: string): Promise<{ ok: true } | Failure> {
    return this.guard(secretHash, async () => {
      const run = this.run(runId);
      if (run.status === 'active' || run.status === 'paused')
        this.reject(run, 'abandoned', Date.now());
      return {};
    });
  }

  async achievements(
    secretHash: string,
  ): Promise<{ ok: true; achievements: Awaited<ReturnType<PlayerSession['catalog']>> } | Failure> {
    return this.guard(secretHash, async () => ({ achievements: await this.catalog() }));
  }

  // --- verification ---------------------------------------------------------

  /** Advances the verifier through received input within this request's budget. */
  private async verify(run: RunRow, now: number): Promise<void> {
    const loaded = await this.load(run);
    let budget = Number(this.env.VERIFY_INSTRUCTIONS);
    const rows = this.sql
      .exec<InputRow>(
        'SELECT * FROM inputs WHERE run_id = ? AND from_tick + ticks > ? ORDER BY seq',
        run.id,
        loaded.tick,
      )
      .toArray();
    try {
      for (const row of rows) {
        if (budget <= 0 || loaded.status === 'finished') break;
        const pending = skipTicks(parseStored(row.runs), loaded.tick - row.from_tick);
        const [tick, finished, checksum] = loaded.vm
          .call('sv_steps', formatInputs(pending), budget)
          .split('|');
        budget -= loaded.vm.lastInstructions();
        loaded.tick = Number(tick);
        loaded.status = finished === '1' ? 'finished' : 'playing';
        if (loaded.status === 'finished' && loaded.tick < row.from_tick + row.ticks) {
          this.reject(run, 'input_after_end', now);
          return;
        }
        if (
          loaded.tick === row.from_tick + row.ticks &&
          row.checksum !== null &&
          Number(checksum) !== row.checksum
        ) {
          this.reject(run, 'desync', now);
          log('desync', { run: run.id, ruleset: run.ruleset, tick: loaded.tick });
          return;
        }
        if (loaded.tick - loaded.checkpointTick >= CHECKPOINT_EVERY_TICKS) {
          this.sql.exec(
            'INSERT INTO checkpoints (run_id, tick, data) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET tick = excluded.tick, data = excluded.data',
            run.id,
            loaded.tick,
            loaded.vm.call('sv_save'),
          );
          loaded.checkpointTick = loaded.tick;
        }
      }
    } catch (error) {
      this.loaded = undefined;
      if (!(error instanceof VmError)) throw error;
      this.reject(run, 'verifier_error', now);
      log('verifier_error', { run: run.id, ruleset: run.ruleset, message: error.message });
      return;
    }
    if (loaded.status === 'finished' && run.status === 'active') {
      this.sql.exec(
        "UPDATE runs SET status = 'verifying', final_tick = ? WHERE id = ?",
        loaded.tick,
        run.id,
      );
    }
    const current = this.run(run.id);
    if (
      current.status === 'verifying' &&
      current.final_tick !== null &&
      loaded.tick >= current.final_tick
    ) {
      await this.finalize(current, loaded, now);
    } else if (current.status === 'verifying') {
      await this.scheduleAlarm(now);
    }
  }

  private async load(run: RunRow): Promise<Loaded> {
    if (this.loaded?.runId === run.id) return this.loaded;
    const build = this.build(run.build);
    const vm = await LuaVm.create({
      wasm: luaWasm,
      driver,
      modules: build.ruleset.modules,
      limits: VM_LIMITS,
    });
    const checkpoint = this.sql
      .exec<{ tick: number; data: string }>(
        'SELECT tick, data FROM checkpoints WHERE run_id = ?',
        run.id,
      )
      .toArray()[0];
    const status = checkpoint
      ? vm.call('sv_load', `${build.ruleset.entry}|${checkpoint.data}`)
      : vm.call('sv_start', `${build.ruleset.entry}|${run.seed}`);
    const [tick, finished] = status.split('|');
    this.loaded = {
      runId: run.id,
      vm,
      tick: Number(tick),
      status: finished === '1' ? 'finished' : 'playing',
      checkpointTick: Number(tick),
    };
    return this.loaded;
  }

  /** Awards achievements and queues publication in one storage transaction. */
  private async finalize(run: RunRow, loaded: Loaded, now: number): Promise<void> {
    if (loaded.status !== 'finished') {
      this.reject(run, 'not_terminal', now);
      return;
    }
    const facts = parseFacts(loaded.vm.call('sv_facts'));
    const score = facts.score ?? 0;
    const build = this.build(run.build);
    const { game, player } = this.identity();
    const result: PublishedResult = {
      run_id: run.id,
      game_id: build.game,
      board: run.board,
      ruleset: run.ruleset,
      player_id: player,
      score,
      runtime: run.runtime,
      channel: run.channel,
      country: run.country,
      accepted_at: now,
      facts,
    };
    let unlocked: string[] = [];
    await this.ctx.storage.transaction(async () => {
      const engine = achievementEngine(sqliteStores(this.sql), game.achievements, () => now);
      unlocked = await recordVerifiedRun(engine, game.achievements, player, run.id, now, facts);
      this.sql.exec(
        "UPDATE runs SET status = 'finished', score = ?, facts = ?, finalized_at = ? WHERE id = ?",
        score,
        JSON.stringify({ facts, unlocked }),
        now,
        run.id,
      );
      this.sql.exec(
        'INSERT INTO outbox (run_id, payload, attempts, next_attempt_at) VALUES (?, ?, 0, ?)',
        run.id,
        JSON.stringify(result),
        now,
      );
    });
    this.loaded = undefined;
    log('run_finished', {
      game: build.game,
      ruleset: run.ruleset,
      score,
      unlocked: unlocked.length,
    });
    await this.flushOutbox(now);
  }

  private async outcome(run: RunRow): Promise<Outcome> {
    if (run.status === 'finished') {
      const { facts, unlocked } = JSON.parse(run.facts ?? '{}') as {
        facts: Record<string, number>;
        unlocked: string[];
      };
      const published =
        this.sql.exec('SELECT 1 FROM outbox WHERE run_id = ?', run.id).toArray().length === 0;
      return { status: 'finished', score: run.score ?? 0, facts, unlocked, published };
    }
    if (run.status === 'rejected' || run.status === 'expired') {
      return { status: run.status, reason: run.reason ?? 'unknown' };
    }
    const { ticks } = this.received(run.id);
    return {
      status: 'verifying',
      verified_tick: this.loaded?.runId === run.id ? this.loaded.tick : 0,
      ticks_received: ticks,
      retry_after_ms: 1000,
    };
  }

  // --- publication outbox ---------------------------------------------------

  private async flushOutbox(now: number): Promise<void> {
    const due = this.sql
      .exec<{ run_id: string; payload: string; attempts: number }>(
        'SELECT run_id, payload, attempts FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10',
        now,
      )
      .toArray();
    for (const row of due) {
      try {
        await publishResult(this.env.DB, JSON.parse(row.payload) as PublishedResult);
        this.sql.exec('DELETE FROM outbox WHERE run_id = ?', row.run_id);
      } catch (error) {
        const delay = PUBLISH_BACKOFF_MS[row.attempts] ?? MAX_BACKOFF_MS;
        this.sql.exec(
          'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE run_id = ?',
          now + delay,
          row.run_id,
        );
        log('publish_retry', { run: row.run_id, attempts: row.attempts + 1, error: String(error) });
      }
    }
    await this.scheduleAlarm(now);
  }

  // --- alarms and expiry ----------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const run of this.sql
      .exec<RunRow>("SELECT * FROM runs WHERE status IN ('active', 'paused', 'verifying')")
      .toArray()) {
      this.expireIfStale(run, now);
      const current = this.run(run.id);
      if (current.status === 'verifying') await this.verify(current, now);
    }
    this.sql.exec(
      `DELETE FROM inputs WHERE run_id IN (SELECT id FROM runs WHERE status IN ('finished', 'rejected', 'expired')
        AND coalesce(finalized_at, expires_at) < ?)`,
      now - TRACE_RETENTION_MS,
    );
    this.sql.exec(
      "DELETE FROM checkpoints WHERE run_id IN (SELECT id FROM runs WHERE status IN ('finished', 'rejected', 'expired'))",
    );
    await this.flushOutbox(now);
  }

  /** Keeps one alarm at the earliest pending deadline. */
  private async scheduleAlarm(now = Date.now()): Promise<void> {
    const deadlines: number[] = [];
    for (const run of this.sql
      .exec<RunRow>("SELECT * FROM runs WHERE status IN ('active', 'paused', 'verifying')")
      .toArray()) {
      if (run.status === 'verifying') deadlines.push(now + 1000);
      else if (run.status === 'paused' && run.paused_at !== null)
        deadlines.push(run.paused_at + PAUSE_MAX_MS);
      else deadlines.push(this.lossDeadline(run));
      deadlines.push(run.expires_at);
    }
    const outbox = this.sql
      .exec<{ at: number | null }>('SELECT min(next_attempt_at) AS at FROM outbox')
      .one().at;
    if (outbox !== null) deadlines.push(outbox);
    const traces = this.sql
      .exec<{ at: number | null }>(
        `SELECT min(coalesce(finalized_at, expires_at)) AS at FROM runs WHERE status IN ('finished', 'rejected', 'expired')
          AND EXISTS (SELECT 1 FROM inputs WHERE inputs.run_id = runs.id)`,
      )
      .one().at;
    if (traces !== null) deadlines.push(traces + TRACE_RETENTION_MS);
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.max(now + 1000, Math.min(...deadlines));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - next) > 500) await this.ctx.storage.setAlarm(next);
  }

  /** Time after which missing input means the connection was lost. */
  private lossDeadline(run: RunRow): number {
    const { ticks } = this.received(run.id);
    return (
      run.baseline_ms +
      ((ticks - run.baseline_tick + WINDOW_TICKS + CHUNK_MAX_TICKS) * 1000) / TICK_RATE
    );
  }

  private expireIfStale(run: RunRow, now: number): void {
    if (run.status !== 'active' && run.status !== 'paused' && run.status !== 'verifying') return;
    let reason: string | undefined;
    if (now >= run.expires_at) reason = 'session_expired';
    else if (run.status === 'paused' && run.paused_at !== null) {
      if (now - run.paused_at > PAUSE_MAX_MS) reason = 'pause_too_long';
      else if (run.paused_total_ms + (now - run.paused_at) > PAUSE_TOTAL_MS)
        reason = 'pause_total_exceeded';
    } else if (run.status === 'active' && now > this.lossDeadline(run)) reason = 'connection_lost';
    if (!reason) return;
    this.sql.exec("UPDATE runs SET status = 'expired', reason = ? WHERE id = ?", reason, run.id);
    if (this.loaded?.runId === run.id) this.loaded = undefined;
    log('run_expired', { run: run.id, reason });
  }

  private reject(run: RunRow, reason: string, now: number): void {
    this.sql.exec(
      "UPDATE runs SET status = 'rejected', reason = ?, finalized_at = ? WHERE id = ?",
      reason,
      now,
      run.id,
    );
    if (this.loaded?.runId === run.id) this.loaded = undefined;
    log('run_rejected', { run: run.id, ruleset: run.ruleset, reason });
  }

  /** Returns why input ending at `endTick` cannot have been played in real time, if so. */
  private checkTiming(run: RunRow, endTick: number, now: number): string | undefined {
    const elapsed = Math.max(0, now - run.baseline_ms);
    const expected = run.baseline_tick + (elapsed * TICK_RATE) / 1000;
    const ahead = FUTURE_SLACK_TICKS + (elapsed * TICK_RATE * DRIFT) / 1000;
    if (endTick > expected + ahead) return 'input is ahead of real time';
    if (endTick < expected - WINDOW_TICKS) return 'input arrived too late';
    return undefined;
  }

  // --- helpers ----------------------------------------------------------------

  private async guard<T extends object>(
    secretHash: string,
    fn: () => Promise<T>,
  ): Promise<({ ok: true } & T) | Failure> {
    const stored = this.meta('secret_hash');
    if (!stored || !timingSafeEqual(stored, secretHash))
      return fail('unauthorized', 'invalid credential');
    try {
      return { ok: true, ...(await fn()) };
    } catch (error) {
      if (error instanceof ApiError) return error.failure;
      throw error;
    }
  }

  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray()[0]?.value;
  }

  private identity(): { game: Game; player: string } {
    const game = registry.get(this.meta('game') ?? '');
    const player = this.meta('player');
    if (!game || !player)
      throw new ApiError('unknown_game', 'player is not registered for a known game');
    return { game, player };
  }

  private run(runId: string): RunRow {
    const run = this.sql.exec<RunRow>('SELECT * FROM runs WHERE id = ?', runId).toArray()[0];
    if (!run) throw new ApiError('not_found', 'unknown run');
    return run;
  }

  private build(buildId: string): Build {
    const build = registry.get(this.meta('game') ?? '')?.builds.get(buildId);
    if (!build)
      throw new ApiError('unsupported_build', 'this build is not registered for ranked play');
    return build;
  }

  private received(runId: string): { nextSeq: number; ticks: number } {
    const row = this.sql
      .exec<{ seq: number | null; end: number | null }>(
        'SELECT max(seq) AS seq, max(from_tick + ticks) AS end FROM inputs WHERE run_id = ?',
        runId,
      )
      .one();
    return { nextSeq: (row.seq ?? -1) + 1, ticks: row.end ?? 0 };
  }

  private ack(run: RunRow, seq: number): Ack {
    const ack: Ack = {
      run_id: run.id,
      status: run.status,
      seq,
      ticks_received: this.received(run.id).ticks,
      verified_tick: this.loaded?.runId === run.id ? this.loaded.tick : 0,
    };
    if (run.reason) ack.reason = run.reason;
    return ack;
  }

  private async catalog() {
    const { game, player } = this.identity();
    const engine = achievementEngine(sqliteStores(this.sql), game.achievements, () => Date.now());
    const views = await engine.catalog(player);
    return views.map((v) => ({
      id: v.code,
      name: v.name,
      description: v.description,
      unlocked: v.unlocked,
      unlocked_at: v.unlockedAt ?? null,
      progress: {
        current: v.progress.current,
        target: v.progress.target,
        percent: v.progress.percent,
      },
    }));
  }
}

function parseStored(runs: string): InputRun[] {
  return runs.split(',').map((pair) => pair.split(':').map(Number) as InputRun);
}

function parseFacts(text: string): Record<string, number> {
  const facts: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [name, value] = line.split('=') as [string, string];
    facts[name] = Number(value);
  }
  return facts;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
