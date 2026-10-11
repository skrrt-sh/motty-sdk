import type { Json, ProviderData } from '@mottyjs/core/host';

// Both OpenAI APIs have an image's `detail`, so it is held under a key the
// two codecs read, where a hint of one API alone is the other's to drop.
const vendor = 'openai';

export function detailed<Rest extends { hints?: ProviderData }>(
  detail: Json | undefined,
  rest: Rest,
): Rest {
  return detail === undefined
    ? rest
    : { ...rest, hints: { ...rest.hints, [vendor]: { detail } } };
}
