// A developer's shell may tell a rival to trace or log every call, which
// slows it and flatters motty. The one rival that reads its settings from
// the environment is left none, before it is loaded.
for (const name of Object.keys(process.env)) {
  if (/^LANG(?:SMITH|CHAIN)_/.test(name)) delete process.env[name];
}

// Loaded one at a time: a cold start is timed with no other SDK in memory.
export const programs = {
  motty: () => import('./motty.ts'),
  'ai-sdk': () => import('./ai-sdk.ts'),
  mastra: () => import('./mastra.ts'),
  langchain: () => import('./langchain.ts'),
  tanstack: () => import('./tanstack.ts'),
};
