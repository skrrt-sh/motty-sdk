export function presented(opinions: readonly string[]): string {
  return opinions.map((opinion, seat) => `Panelist ${seat + 1}:\n${opinion}`).join("\n\n");
}
