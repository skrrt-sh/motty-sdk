// What a host's options are given, outside Workers.
export function environment() {
  return typeof process === 'undefined' ? {} : process.env;
}

// What masking looks for.
export function held(): (string | undefined)[] {
  return Object.values(environment());
}
