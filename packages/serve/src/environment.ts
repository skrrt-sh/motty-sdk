// What a host's options are given and what masking looks for, outside Workers.
export function environment() {
  return typeof process === 'undefined' ? {} : process.env;
}
