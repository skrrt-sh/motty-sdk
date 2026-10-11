import { type ModelAdapter, type ModelCall, toFacts } from '@mottyjs/core/host';
import type { Codec } from '@mottyjs/serve/codec';
import { parsed } from '@mottyjs/serve/sse';
import {
  addressed,
  broken,
  credentials,
  endpoint,
  moved,
  told,
} from './connection.ts';

type Upstream = {
  codec: Pick<Codec, 'encode' | 'events' | 'failure'>;
  prefix: string;
  address: string;
  // The key itself, and the header that carries it where an API has its own
  // in place of a bearer token.
  key: string | undefined;
  keyHeader?: string;
} & Connection;

// What a host states of a connection beside its key and address. A body
// field is in the provider's own name, and a request's own replaces it
// whole; what each model takes is said in place of the adapter's own rule.
export type Connection = {
  headers?: { [name: string]: string };
  body?: Parameters<Codec['encode']>[2];
  takes?: Parameters<Codec['encode']>[3];
};

// No retry and no time limit here: the motty's own combinators hold both,
// and a second pair underneath would multiply them.
export function chat(upstream: Upstream): ModelAdapter {
  const { codec } = upstream;
  const address = addressed(upstream.prefix, upstream.address);
  const prefix = `${upstream.prefix}/`;
  const { headers: held, clean } = credentials(
    upstream.prefix,
    upstream.key,
    upstream.keyHeader,
    upstream.headers,
  );

  const call: ModelCall = async function* (model, prompt, signal) {
    let encoded: ReturnType<Codec['encode']>;
    try {
      encoded = codec.encode(
        model.slice(prefix.length),
        prompt,
        upstream.body,
        upstream.takes,
      );
    } catch (thrown) {
      // A prompt this API cannot carry never left, so the upstream did
      // not fail: the refusal is the adapter's own.
      yield { type: 'error', error: { ...toFacts(thrown), upstream: false } };
      return;
    }
    // Set by name in any case: a connection's header adds, and does not
    // replace what the API needs. The credential is already set over it.
    const headers = new Headers(held);
    for (const [name, value] of Object.entries(encoded.headers)) {
      headers.set(name, value);
    }
    try {
      const response = await fetch(endpoint(address, encoded.path), {
        method: 'POST',
        headers,
        body: JSON.stringify(encoded.body),
        signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        yield { type: 'error', error: moved(response.status) };
        return;
      }
      // A reply that is one JSON body is no stream, whatever its status.
      const whole = response.headers
        .get('content-type')
        ?.includes('application/json');
      if (!response.ok || response.body === null || whole === true) {
        yield {
          type: 'error',
          // An upstream may echo the key it refused, whole or masked, so
          // whoever reads the failure is handed what cuts the secrets, to
          // cut them from all it reads before it shortens any of it.
          error: codec.failure(
            response.status,
            response.headers,
            await told(response),
            clean,
          ),
        };
        return;
      }
      const { leftOut } = encoded;
      for await (const event of codec.events(parsed(response.body), clean)) {
        // What the prompt lost on its way out is said where the call ends,
        // after whatever the upstream warned of itself.
        yield event.type === 'finish' && leftOut.length > 0
          ? { ...event, warnings: [...(event.warnings ?? []), ...leftOut] }
          : event;
      }
    } catch (thrown) {
      yield { type: 'error', error: broken(signal, thrown, clean) };
    }
  };

  return { serves: (model) => model.startsWith(prefix), call };
}
