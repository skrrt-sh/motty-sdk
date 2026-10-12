import { InvalidRequest } from '@mottyjs/core';
import { chatCompletions } from './chat-completions/index.ts';
import type { Codec } from './codec.ts';
import { messages } from './messages/index.ts';
import { responses } from './responses/index.ts';

type Route =
  | { to: 'chat'; codec: Codec }
  | { to: 'models'; model: string | undefined }
  | { to: 'unserved'; said: string }
  | { to: 'nowhere' };

const stateless = 'no state is held between requests';

// What the three APIs have beside their chat endpoint. The first match
// wins, so a longer path stands ahead of the one it begins with.
const unserved: readonly (readonly [path: string, said: string])[] = [
  ['/v1/messages/count_tokens', 'Token counting is not served yet'],
  ['/v1/responses/input_tokens', 'Token counting is not served yet'],
  ['/v1/messages/batches', 'Batches are not served'],
  ['/v1/messages', 'Only POST /v1/messages is served'],
  ['/v1/responses', `Stored responses are not served: ${stateless}`],
  ['/v1/conversations', `Conversations are not served: ${stateless}`],
  [
    '/v1/chat/completions',
    `Stored chat completions are not served: ${stateless}`,
  ],
  ['/v1/embeddings', 'Embeddings are not served'],
  ['/v1/images', 'Images are not served'],
  ['/v1/audio', 'Audio is not served'],
  ['/v1/batches', 'Batches are not served'],
  ['/v1/files', 'Files are not served'],
  ['/v1/realtime', 'Realtime is not served'],
];

// A token sent in any of them reaches no motty, whichever API the request
// came by.
export { credentials } from '@mottyjs/core/host';

function under(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

// A path two APIs share is told apart as their clients are: only one
// of them sends its version in a header.
export function formatOf({ headers }: Request, pathname: string): Codec {
  return (
    [chatCompletions, responses, messages].find(({ paths }) =>
      paths.some((path) => under(pathname, path)),
    ) ?? (headers.has('anthropic-version') ? messages : chatCompletions)
  );
}

function modelIn(pathname: string): string | undefined {
  const written = pathname.slice('/v1/models/'.length);
  try {
    return written === '' ? undefined : decodeURIComponent(written);
  } catch {
    throw new InvalidRequest(`The model name ${written} is not a valid path`);
  }
}

export function routed(request: Request, pathname: string): Route {
  const { method } = request;
  if (method === 'POST') {
    const codec = [chatCompletions, responses, messages].find(({ paths }) =>
      paths.includes(pathname),
    );
    if (codec !== undefined) return { to: 'chat', codec };
  }
  if (method === 'GET' && under(pathname, '/v1/models')) {
    return { to: 'models', model: modelIn(pathname) };
  }
  const found = unserved.find(([path]) => under(pathname, path));
  return found === undefined
    ? { to: 'nowhere' }
    : { to: 'unserved', said: found[1] };
}
