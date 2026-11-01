import { env } from 'cloudflare:workers';

// The Worker's text under any flag and date, where `process.env` is empty or
// missing on some. Its own copy goes last, as it has JSON variables as text. A
// binding is no text, so it stays out.
export function environment(): { [name: string]: string | undefined } {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === 'string'),
    ),
    ...(typeof process === 'undefined' ? {} : process.env),
  };
}
