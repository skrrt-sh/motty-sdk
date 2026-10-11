import type { Json } from '@mottyjs/core/host';

// A motty is served under one name, whatever models it routes to: those
// are worked out during a request and are not the caller's to pick.
export function modelOf(name: string, started: Date, anthropic: boolean): Json {
  return anthropic
    ? {
        type: 'model',
        id: name,
        display_name: name,
        created_at: started.toISOString(),
      }
    : {
        id: name,
        object: 'model',
        created: Math.floor(started.getTime() / 1000),
        owned_by: 'motty',
      };
}

export function modelList(
  name: string,
  started: Date,
  anthropic: boolean,
): Json {
  const data = [modelOf(name, started, anthropic)];
  return anthropic
    ? { data, has_more: false, first_id: name, last_id: name }
    : { object: 'list', data };
}
