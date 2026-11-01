import { env } from 'cloudflare:workers';

// The Worker's text under any date and Node flag, where `process.env` is empty
// or missing on some. A binding is no text, so it stays out.
function bound(): [string, string][] {
  return Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

function own(): { [name: string]: string | undefined } {
  return typeof process === 'undefined' ? {} : process.env;
}

// Its own copy goes last, as it has JSON variables as text.
export function environment(): { [name: string]: string | undefined } {
  return { ...Object.fromEntries(bound()), ...own() };
}

// Both, as a value written over in `process.env` is still the binding's secret.
export function held(): (string | undefined)[] {
  return [...bound().map(([, value]) => value), ...Object.values(own())];
}
