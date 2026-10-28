import type { Json, Message, ProviderData } from '@mottyjs/core/host';

type Key = Json | undefined;

function absent(key: Key): key is null | undefined {
  return key === undefined || key === null;
}

// Both OpenAI APIs take the cache key, so it is held under the key the two
// codecs read: an upstream of either API caches and routes by it.
export function shared(
  own: { hints?: ProviderData },
  key: Key,
): { hints?: ProviderData } {
  if (absent(key)) return own;
  return { hints: { ...own.hints, openai: { prompt_cache_key: key } } };
}

function cached(message: Message): boolean {
  if (message.cache !== undefined) return true;
  return (message.parts ?? []).some(
    (part) => part.type !== 'provider' && part.cache !== undefined,
  );
}

// A caller who keys its cache asks for one, and an upstream that caches only
// where it is told is told so at the end of the conversation, as a marker
// the author sees and may move. One the caller placed itself says where.
export function keyed(messages: Message[], key: Key): Message[] {
  const last = messages.at(-1);
  if (absent(key) || last === undefined || messages.some(cached)) {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, cache: { implied: true } }];
}
