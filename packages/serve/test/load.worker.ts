import { env } from 'cloudflare:workers';
import { cloudflare, MottyStorage } from '../../adapters/src/cloudflare.ts';
import { openai } from '../../adapters/src/openai.ts';
import { model, motty } from '../../core/src/index.ts';
import { store } from '../../store/src/index.ts';
import { mount } from '../src/index.ts';

export { MottyStorage };

declare global {
  namespace Cloudflare {
    interface Env {
      STORAGE: DurableObjectNamespace<MottyStorage>;
      UPSTREAM: string;
      RECORDS: string;
    }
  }
}

// A request does what a real one does in turn: storage, an upstream stream,
// then a record, each a chance to touch what another request opened.
const { fetch: served } = mount(
  motty({ name: 'coder' }).handle(async ({ prompt }) => {
    await store.increment('asked', 1);
    return model('openai/echo').complete(prompt);
  }),
  () => ({
    models: [
      openai({
        key: 'sk-upstream',
        address: env.UPSTREAM,
        api: 'chat-completions',
      }),
    ],
    storage: cloudflare({ binding: env.STORAGE }),
    report: (report) =>
      fetch(env.RECORDS, {
        method: 'POST',
        body: JSON.stringify(report),
      }).then((reply) => reply.arrayBuffer()),
  }),
);

// The mistake the gate is there to catch, so that the gate can show it sees
// one: a reply opened by one request and read by the next.
let kept: Response | undefined;

export default {
  fetch: async (
    request: Request,
    _env: Cloudflare.Env,
    context: ExecutionContext,
  ) => {
    if (new URL(request.url).pathname !== '/shared') {
      return served(request, undefined, context);
    }
    if (kept === undefined) {
      kept = await fetch(env.RECORDS, { method: 'POST', body: '{}' });
      return new Response('kept');
    }
    try {
      return new Response(await kept.text());
    } catch (thrown) {
      throw new Error(`control: ${thrown}`);
    }
  },
};
