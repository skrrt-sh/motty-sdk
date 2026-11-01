import type { Json, Message } from '@mottyjs/core/host';

type Key = Json | undefined;

function absent(key: Key): key is null | undefined {
  return key === undefined || key === null;
}

function cached(message: Message): boolean {
  if (message.cache !== undefined) return true;
  return (message.parts ?? []).some(
    (part) => part.type !== 'provider' && part.cache !== undefined,
  );
}

// Whoever keys a cache asks for one, and an upstream that caches only where it
// is told is told so at the end of the conversation, as a marker a motty sees
// and may move. One placed already says where. A decoder asks this so a hook
// reads the marker, and an encoder so an author's own key has it too.
export function keyed(
  messages: readonly Message[],
  key: Key,
): readonly Message[] {
  if (absent(key)) return messages;
  const last = messages.at(-1);
  if (last === undefined || messages.some(cached)) return messages;
  return [...messages.slice(0, -1), { ...last, cache: { implied: true } }];
}
