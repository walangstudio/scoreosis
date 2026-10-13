import { registry } from '../src/games.js';

const game = registry.get('ahsteroids');
const build = game?.builds.get('ahsteroids-web-direct-0.1.0');
if (!build)
  throw new Error('tests need the ahsteroids-web-direct-0.1.0 build in games/ahsteroids/game.json');

/** The registered Ah!Steroids build and ruleset the tests play against. */
export const BUILD = build.id;
export const bundle = build.ruleset;
export const RULESET = build.ruleset.ruleset;
