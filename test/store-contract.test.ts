import { env, runInDurableObject } from 'cloudflare:test';
import type { Stores } from '@walangstudio/badgetrip-core';
import { runStoreContract } from '@walangstudio/badgetrip-testing';
import { sqliteStores } from '../src/badgetrip-sqlite.js';

// Optional capabilities are left out, as sqliteStores does not implement them.
const METHODS: Record<keyof Stores, string[]> = {
  events: ['append', 'read', 'count'],
  scores: ['get', 'apply', 'top'],
  achievements: ['award', 'list', 'has'],
  streaks: ['get', 'tick', 'reset'],
};

// Durable Object storage is only reachable inside the object, so every store
// call runs there. Each factory call gets a fresh, empty object.
runStoreContract(() => {
  const stub = env.PLAYERS.get(env.PLAYERS.newUniqueId());
  const remote = (store: keyof Stores) =>
    new Proxy(
      {},
      {
        get: (_, method: string) =>
          METHODS[store].includes(method) &&
          ((...args: unknown[]) => {
            const result = runInDurableObject(stub, async (_instance, state) => {
              const target = sqliteStores(state.storage.sql)[store];
              const fn: unknown = Reflect.get(target, method);
              const value: unknown = typeof fn === 'function' ? fn.apply(target, args) : undefined;
              if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
                const items: unknown[] = [];
                for await (const item of value as AsyncIterable<unknown>) items.push(item);
                return items;
              }
              return value;
            });
            if (method !== 'read') return result;
            return (async function* () {
              yield* (await result) as unknown[];
            })();
          }),
      },
    );
  return {
    events: remote('events'),
    scores: remote('scores'),
    achievements: remote('achievements'),
    streaks: remote('streaks'),
  } as Stores;
});
