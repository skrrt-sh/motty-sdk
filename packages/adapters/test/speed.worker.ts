import { DurableObject } from 'cloudflare:workers';
import { cloudflare, MottyStorage } from '../src/cloudflare.ts';

export { MottyStorage };

// The least a Durable Object does to keep a value, timed against the
// adapter: one key-value call or two, with no expiry and no checks.
export class BareStorage extends DurableObject {
  async read(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }

  async write(key: string, text: string): Promise<void> {
    this.ctx.storage.kv.put(key, text);
  }

  async add(key: string, by: number): Promise<number> {
    const total = Number(this.ctx.storage.kv.get(key) ?? 0) + by;
    this.ctx.storage.kv.put(key, total);
    return total;
  }
}

// One request makes `calls` calls of one kind in turn, through the adapter
// or straight to the bare object, so the time of the request is theirs.
export default {
  fetch: async (
    request: Request,
    env: {
      STORAGE: DurableObjectNamespace<MottyStorage>;
      BARE: DurableObjectNamespace<BareStorage>;
    },
  ) => {
    const query = new URL(request.url).searchParams;
    const call = query.get('call');
    const calls = Number(query.get('calls') ?? '1');
    const value = { role: 'user', text: 'x'.repeat(512) };
    const storage = cloudflare({ binding: env.STORAGE });
    const bare = env.BARE.getByName('timed');
    const made = {
      'motty get': () => storage.get('timed'),
      'motty set': () => storage.set('timed', value, { ttl: 60_000 }),
      'motty increment': () =>
        storage.increment?.('counted', 1, { ttl: 60_000 }),
      'bare get': async () => {
        const text = await bare.read('timed');
        return typeof text === 'string' ? JSON.parse(text) : undefined;
      },
      'bare set': () => bare.write('timed', JSON.stringify(value)),
      'bare increment': () => bare.add('counted', 1),
    };
    const one = Object.entries(made).find(([name]) => name === call)?.[1];
    if (one === undefined) return new Response(call, { status: 404 });
    for (let done = 0; done < calls; done++) await one();
    return new Response();
  },
};
