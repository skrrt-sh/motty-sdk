import { cloudflare, MottyStorage } from '../src/cloudflare.ts';
import { parsed } from '../src/json.ts';

export { MottyStorage };

// Each storage call over HTTP, so the tests run in Bun against the adapter in
// workerd: the path names the call, the query its key and numbers, the body
// the value. `group` keeps every key in one object; `raw` and `text` write
// and read an object's text as another writer would.
export default {
  fetch: async (
    request: Request,
    env: { STORAGE: DurableObjectNamespace<MottyStorage> },
  ) => {
    const query = new URL(request.url).searchParams;
    const call = new URL(request.url).pathname.slice(1);
    const key = query.get('key') ?? '';
    const number = (name: string) => {
      const given = query.get(name);
      return given === null ? undefined : Number(given);
    };
    const ttl = number('ttl');
    const group = query.get('group');
    const storage = cloudflare({
      binding: env.STORAGE,
      ...(group === null ? {} : { name: () => group }),
    });
    const object = env.STORAGE.getByName(group ?? key);
    const options = ttl === undefined ? {} : { ttl };
    const reply = (value: unknown) =>
      new Response(value === undefined ? '' : JSON.stringify(value));
    try {
      if (call === 'raw') {
        await object.write(key, await request.text());
        return new Response();
      }
      if (call === 'text') return new Response(await object.read(key));
      if (call === 'get') return reply(await storage.get(key));
      if (call === 'set') {
        await storage.set(key, parsed(await request.text()), options);
        return reply(undefined);
      }
      if (call === 'delete') return reply(await storage.delete(key));
      return reply(await storage.increment?.(key, number('by') ?? 0, options));
    } catch (thrown) {
      return new Response(thrown instanceof Error ? thrown.message : '', {
        status: 500,
      });
    }
  },
};
