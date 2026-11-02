// What a host's options are given, outside Workers.
export function environment() {
  return typeof process === 'undefined' ? {} : process.env;
}
