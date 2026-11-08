// What a host's options are given, outside Workers.
export function environment(): { [name: string]: string | undefined } {
  return typeof process === 'undefined' ? {} : process.env;
}
