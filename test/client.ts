import { SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import bundle from '../games/ahsteroids/rulesets/45629a5a0139f70a.json';
import driver from '../src/vm/driver.lua';
import { LuaVm } from '../src/vm/host.js';
import wasm from '../src/vm/lua51.wasm';

export const BASE = 'https://scoreosis.test';
export const BUILD = 'ahsteroids-dev-web';

export async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: tests assert response bodies field by field
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

export async function guest(game = 'ahsteroids', build = BUILD): Promise<string> {
  const res = await api('/v1/guests', { body: { game_id: game, build_id: build } });
  if (res.status !== 201) throw new Error(`guest failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Simulated clock shared by the test and the Durable Objects in this isolate. */
export function useClock(start = Date.UTC(2026, 9, 13, 12)) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

/**
 * Plays Ah!Steroids the way a game client does: its own copy of the ranked
 * simulation, one input chunk per second with the state checksum.
 */
export class Player {
  token: string;
  vm!: LuaVm;
  run!: { run_id: string; seed: number };
  seq = 0;
  tick = 0;
  finished = false;
  private rng: number;

  private constructor(token: string, inputSeed: number) {
    this.token = token;
    this.rng = inputSeed;
  }

  static async create(inputSeed = 7, token?: string): Promise<Player> {
    return new Player(token ?? (await guest()), inputSeed);
  }

  async start(build = BUILD) {
    const res = await api('/v1/games/ahsteroids/runs', {
      token: this.token,
      body: { build_id: build },
    });
    if (res.status !== 201) return res;
    this.run = res.body;
    this.vm = await LuaVm.create({
      wasm,
      driver,
      modules: bundle.modules,
      limits: { memory: 32 << 20, instructions: 1e9 },
    });
    this.vm.call('sv_start', `game.ranked|${this.run.seed}`);
    this.seq = 0;
    this.tick = 0;
    this.finished = false;
    return res;
  }

  /** Simulates up to `ticks` ticks locally and returns the chunk a client would send. */
  play(ticks = 60) {
    const runs: [number, number][] = [];
    for (let left = ticks; left > 0; left -= 20) {
      this.rng = (this.rng * 48271) % 2147483647;
      runs.push([Math.min(20, left), this.rng % 16]);
    }
    const [tick, finished, checksum] = this.vm
      .call('sv_steps', runs.map(([c, b]) => `${c}:${b}`).join(','))
      .split('|');
    const consumed = Number(tick) - this.tick;
    const sent: [number, number][] = [];
    let left = consumed;
    for (const [c, b] of runs) {
      if (left <= 0) break;
      sent.push([Math.min(c, left), b]);
      left -= c;
    }
    const chunk = {
      seq: this.seq,
      from_tick: this.tick,
      inputs: sent.map(([c, b]) => `${c}:${b}`).join(','),
      checksum: Number(checksum),
    };
    this.tick = Number(tick);
    this.finished = finished === '1';
    this.seq++;
    return chunk;
  }

  send(chunk: object) {
    return api(`/v1/games/ahsteroids/runs/${this.run.run_id}/inputs`, {
      token: this.token,
      body: chunk,
    });
  }

  finish() {
    return api(`/v1/games/ahsteroids/runs/${this.run.run_id}/finish`, {
      token: this.token,
      body: { tick: this.tick },
    });
  }

  /** Plays to the end in real-time steps and finishes. */
  async playToEnd(clock: { advance(ms: number): void }, maxSeconds = 600) {
    for (let s = 0; s < maxSeconds && !this.finished; s++) {
      clock.advance(1000);
      const res = await this.send(this.play());
      if (res.status !== 200)
        throw new Error(`chunk ${this.seq - 1} failed: ${JSON.stringify(res.body)}`);
    }
    let res = await this.finish();
    for (let i = 0; i < 50 && res.body.status === 'verifying'; i++) {
      clock.advance(1000);
      res = await this.finish();
    }
    return res;
  }
}
