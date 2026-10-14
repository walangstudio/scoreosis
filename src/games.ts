import { games as gameConfigs, rulesets as rulesetBundles } from '../games/rulesets.generated.js';

export const RUNTIMES = ['web', 'windows', 'android', 'ios', 'macos', 'linux'] as const;
export const CHANNELS = ['itch_io', 'google_play', 'steam', 'direct', 'unknown'] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type Channel = (typeof CHANNELS)[number];

export type AchievementSpec = {
  id: string;
  fact: string;
  mode: string;
  gte: number;
  name: string;
  description: string;
};

/** Packed by tools/pack-game.mjs from the game's own ranked Lua modules. */
export type RulesetBundle = {
  game: string;
  ruleset: string;
  entry: string;
  buttons: number;
  /** Optional: one leaderboard per mode (a level, a track), chosen at run start. */
  modes?: string[];
  source: { commit: string; dirty: boolean };
  achievements: AchievementSpec[];
  modules: Record<string, string>;
};

/** games/<id>/game.json, reviewed and deployed by the administrator. */
export type GameConfig = {
  id: string;
  name: string;
  entry: string;
  boards: Record<string, string[]>;
  builds: { id: string; ruleset: string; runtime: string; channel: string }[];
};

export type Build = {
  id: string;
  game: string;
  ruleset: RulesetBundle;
  board: string;
  runtime: Runtime;
  channel: Channel;
};

export type Game = {
  id: string;
  name: string;
  builds: Map<string, Build>;
  boards: Set<string>;
  defaultBoard: string;
  /** Modes of every registered ruleset, the newest ruleset's first; empty when the game has none. */
  modes: string[];
  /** Achievements are defined by the newest ruleset; ids are stable across rulesets. */
  achievements: AchievementSpec[];
};

const isOneOf = <T extends string>(values: readonly T[], v: string): v is T =>
  (values as readonly string[]).includes(v);

export function buildRegistry(configs: GameConfig[], bundles: RulesetBundle[]): Map<string, Game> {
  const registry = new Map<string, Game>();
  for (const config of configs) {
    if (!/^[a-z0-9_]{1,32}$/.test(config.id)) throw new Error(`bad game id ${config.id}`);
    const boardOf = new Map<string, string>();
    for (const [board, rulesets] of Object.entries(config.boards)) {
      for (const r of rulesets) {
        if (boardOf.has(r)) throw new Error(`${config.id}: ruleset ${r} is on two boards`);
        boardOf.set(r, board);
      }
    }
    const builds = new Map<string, Build>();
    let latest: RulesetBundle | undefined;
    let latestBoard = '';
    for (const b of config.builds) {
      const ruleset = bundles.find((x) => x.game === config.id && x.ruleset === b.ruleset);
      const board = boardOf.get(b.ruleset);
      if (!ruleset || !board) throw new Error(`${config.id}/${b.id}: ruleset ${b.ruleset} missing`);
      if (!isOneOf(RUNTIMES, b.runtime) || !isOneOf(CHANNELS, b.channel)) {
        throw new Error(`${config.id}/${b.id}: bad runtime or channel`);
      }
      // Clients read their leaderboard platform from the id (scoreosis/client.lua).
      if (!b.id.startsWith(`${config.id}-${b.runtime}-${b.channel}-`) || b.id.length > 64) {
        throw new Error(`${config.id}/${b.id}: id must be <game>-<runtime>-<channel>-<version>`);
      }
      if (ruleset.entry !== config.entry) throw new Error(`${config.id}: entry mismatch`);
      builds.set(b.id, {
        id: b.id,
        game: config.id,
        ruleset,
        board,
        runtime: b.runtime,
        channel: b.channel,
      });
      latest = ruleset;
      latestBoard = board;
    }
    if (!latest) throw new Error(`${config.id}: no builds`);
    registry.set(config.id, {
      id: config.id,
      name: config.name,
      builds,
      boards: new Set(Object.keys(config.boards)),
      defaultBoard: latestBoard,
      modes: [
        ...new Set(
          [latest, ...[...builds.values()].map((b) => b.ruleset)].flatMap((r) => r.modes ?? []),
        ),
      ],
      achievements: latest.achievements,
    });
  }
  return registry;
}

/** Results and bests key a moded run's board as `<board>/<mode>`. */
export const boardKey = (board: string, mode: string | null | undefined) =>
  mode ? `${board}/${mode}` : board;

export const registry = buildRegistry(gameConfigs, rulesetBundles);
