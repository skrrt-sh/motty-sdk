import { DurableObject } from 'cloudflare:workers';
import type { Storage } from '@mottyjs/core/host';
import { parsed } from './json.ts';
import { milliseconds } from './ttl.ts';

// Rows are written only by this object, and are checked as they are read
// back rather than asserted. A key with no time to live expires never.
function isRow(row: unknown): row is { text: string; until: number } {
  return (
    typeof row === 'object' &&
    row !== null &&
    'text' in row &&
    typeof row.text === 'string' &&
    'until' in row &&
    typeof row.until === 'number'
  );
}

function expiry(ttl: number | undefined): number {
  return ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl;
}

// The key-value calls are synchronous and the object runs one call at a
// time, so nothing comes between a read and the write after it. A SQL table
// would have to be made again after deleteAll(); these keys need no schema.
export class MottyStorage extends DurableObject {
  // The expiry is checked on every read, so a key is gone at its time to
  // the millisecond, whenever the alarm comes.
  #live(key: string) {
    const row: unknown = this.ctx.storage.kv.get(key);
    if (!isRow(row)) return undefined;
    if (row.until > Date.now()) return row;
    this.ctx.storage.kv.delete(key);
    return undefined;
  }

  // One alarm per object, at the earliest expiry it holds.
  async #expire(until: number) {
    if (until === Number.POSITIVE_INFINITY) return;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || until < set) await this.ctx.storage.setAlarm(until);
  }

  async read(key: string): Promise<string | undefined> {
    return this.#live(key)?.text;
  }

  async write(key: string, text: string, ttl?: number): Promise<void> {
    const until = expiry(ttl);
    this.ctx.storage.kv.put(key, { text, until });
    await this.#expire(until);
  }

  // An object left with nothing in it is deleted whole, its alarm with it.
  async remove(key: string): Promise<void> {
    this.ctx.storage.kv.delete(key);
    if ([...this.ctx.storage.kv.list({ limit: 1 })].length === 0) {
      await this.ctx.storage.deleteAll();
    }
  }

  // Only a JSON number is added to, and a total that is not finite is
  // returned and not stored. The expiry is set only on the key this call made.
  async add(
    key: string,
    by: number,
    ttl?: number,
  ): Promise<number | undefined> {
    const row = this.#live(key);
    let before = 0;
    if (row !== undefined) {
      let held: unknown;
      try {
        held = JSON.parse(row.text);
      } catch {
        return undefined;
      }
      if (typeof held !== 'number') return undefined;
      before = held;
    }
    const total = before + by;
    if (!Number.isFinite(total)) return total;
    const until = row?.until ?? expiry(ttl);
    this.ctx.storage.kv.put(key, { text: JSON.stringify(total), until });
    if (row === undefined) await this.#expire(until);
    return total;
  }

  // The alarm may come late or early for a key written since, so the sweep
  // deletes what has expired, waits for the next expiry, and deletes the
  // object once nothing is left.
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    let left = false;
    for (const [key, row] of [...this.ctx.storage.kv.list()]) {
      if (isRow(row) && row.until <= now) {
        this.ctx.storage.kv.delete(key);
        continue;
      }
      left = true;
      if (isRow(row)) next = Math.min(next, row.until);
    }
    if (!left) await this.ctx.storage.deleteAll();
    else if (next !== Number.POSITIVE_INFINITY) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

// One object per key unless the host groups keys under a name of its own.
// A binding restricted to a jurisdiction is passed as the binding.
export function cloudflare(options: {
  binding: DurableObjectNamespace<MottyStorage>;
  name?: (key: string) => string;
}): Storage {
  const { binding, name = (key) => key } = options;
  const at = (key: string) => binding.getByName(name(key));
  return {
    get: async (key) => {
      const text = await at(key).read(key);
      if (text === undefined) return undefined;
      return parsed(text);
    },
    set: async (key, value, options) => {
      const ms =
        options?.ttl === undefined ? undefined : milliseconds(options.ttl);
      await at(key).write(key, JSON.stringify(value), ms);
    },
    delete: async (key) => {
      await at(key).remove(key);
    },
    increment: async (key, by, options) => {
      if (!Number.isFinite(by)) {
        throw new Error(`An increment is a finite number, and ${by} is not`);
      }
      const ms =
        options?.ttl === undefined ? undefined : milliseconds(options.ttl);
      const total = await at(key).add(key, by, ms);
      if (total === undefined) {
        throw new Error(`The value stored under ${key} is not a number`);
      }
      if (!Number.isFinite(total)) {
        throw new Error(
          `The total stored under ${key} would not be a finite number`,
        );
      }
      return total;
    },
  };
}
