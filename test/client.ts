import { SELF, env } from 'cloudflare:test';
import { vi } from 'vitest';
import { registry } from '../src/games.js';
import driver from '../src/vm/driver.lua';
import { LuaVm } from '../src/vm/host.js';
import wasm from '../src/vm/lua51.wasm';
import { BUILD, bundle } from './fixtures.js';

export { BUILD };
export const BASE = 'https://scoreosis.test';
let requestCount = 0;

export async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  requestCount++;
  const headers: Record<string, string> = {
    'cf-connecting-ip': `10.${(requestCount >> 16) & 255}.${(requestCount >> 8) & 255}.${requestCount & 255}`,
    ...init.headers,
  };
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

let guestCount = 0;

export async function guest(game = 'ahsteroids', build = BUILD): Promise<string> {
  guestCount++;
  const res = await api('/v1/guests', {
    body: { game_id: game, build_id: build },
    headers: { 'cf-connecting-ip': `203.0.113.${guestCount % 250}` },
  });
  if (res.status !== 201) throw new Error(`guest failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Chooses the player's public name; unnamed players stay off the boards. */
export async function nameTheGuest(game: string, token: string, name = 'test-001') {
  const res = await api(`/v1/games/${game}/me/profile`, {
    method: 'PATCH',
    token,
    body: { display_name: name },
  });
  if (res.status !== 200) throw new Error(`rename failed: ${JSON.stringify(res.body)}`);
}

/** Simulated clock shared by the test and the Durable Objects in this isolate. */
// Far in the future: workerd fires alarms on real time, so a fake time near "now"
// lets alarms race the tests. Tests run alarms with runDurableObjectAlarm.
export function useClock(start = Date.UTC(2031, 0, 1)) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

/** A game's first registered build; Ah!Steroids uses the fixture build. */
const defaultBuild = (game: string): string => {
  const build = game === 'ahsteroids' ? BUILD : registry.get(game)?.builds.keys().next().value;
  if (!build) throw new Error(`no registered build for ${game}`);
  return build;
};

/**
 * Plays a game the way its client does: its own copy of the ranked simulation,
 * one input chunk per second with the state checksum. Ah!Steroids by default.
 */
export class Player {
  token: string;
  game: string;
  buttons = bundle.buttons;
  vm!: LuaVm;
  run!: { run_id: string; seed: number };
  seq = 0;
  tick = 0;
  finished = false;
  private rng: number;

  private constructor(token: string, inputSeed: number, game: string) {
    this.token = token;
    this.rng = inputSeed;
    this.game = game;
  }

  static async create(inputSeed = 7, token?: string, game = 'ahsteroids'): Promise<Player> {
    return new Player(token ?? (await guest(game, defaultBuild(game))), inputSeed, game);
  }

  async start(build = defaultBuild(this.game), mode?: string) {
    const res = await api(`/v1/games/${this.game}/runs`, {
      token: this.token,
      body: { build_id: build, mode },
    });
    if (res.status !== 201) return res;
    this.run = res.body;
    const ruleset = registry.get(this.game)?.builds.get(build)?.ruleset;
    if (!ruleset) throw new Error(`${build} started but is not in the registry`);
    this.buttons = ruleset.buttons;
    this.vm = await LuaVm.create({
      wasm,
      driver,
      modules: ruleset.modules,
      limits: { memory: 32 << 20, instructions: 1e9 },
    });
    this.vm.call('sv_start', `${ruleset.entry}|${this.run.seed}${mode ? `|${mode}` : ''}`);
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
      runs.push([Math.min(20, left), this.rng % 2 ** this.buttons]);
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
    return api(`/v1/games/${this.game}/runs/${this.run.run_id}/inputs`, {
      token: this.token,
      body: chunk,
    });
  }

  finish() {
    return api(`/v1/games/${this.game}/runs/${this.run.run_id}/finish`, {
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

export function stubFor(token: string) {
  const player = token.split('.')[0];
  return env.PLAYERS.get(env.PLAYERS.idFromName(`ahsteroids:${player}`));
}
