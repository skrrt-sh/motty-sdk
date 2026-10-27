import { expect, test } from 'bun:test';
import { chatCompletionsIn } from '@mottyjs/serve';
import {
  deepseekCuts,
  groqCuts,
  moonshotCuts,
  openaiCuts,
  openrouterCuts,
} from '../src/cuts.ts';

// The router's list holds every other provider's, so it reads all of them.
test('no cut reads anything in what another provider`s failure is told as, or in a failure of a provider that names no account', () => {
  for (const told of [
    'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s.',
    'The project does not have access to model `gpt-5.5-pro`',
    'The server had an error processing your request. Sorry about that! You can retry your request, or contact us through our help center at help.openai.com if the error persists.',
    "This request would exceed your organization's rate limit of 30,000 input tokens per minute (model: claude-sonnet-4-20250514). Please reduce the prompt length.",
    'Rate limit reached for model `openai/gpt-oss-120b` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s.',
    'Your account request reached organization max RPM: 3, please try again after 1 seconds',
    'Rate Limit Reached',
    'Generative Language API has not been used in project before or it is disabled.',
    'Service tier capacity exceeded for this model.',
    'Invalid API Key',
    'Authentication Failed',
    'Requests rate limit exceeded, please try again later.',
    'insufficient balance',
    'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
  ]) {
    for (const { pattern } of openrouterCuts) {
      expect(told.match(pattern)).toBeNull();
    }
  }
});

test('a router`s list reads an id by its words before any id alone, so one provider`s cut leaves another`s words whole', () => {
  const first = openrouterCuts.findIndex(({ bare }) => bare === true);

  expect(first).toBeGreaterThan(0);
  expect(openrouterCuts.slice(first).every(({ bare }) => bare === true)).toBe(
    true,
  );
});

// Told as an overload, which is no request of the caller's said back, so
// an id is read by its shape too.
function told(cuts: typeof openaiCuts, message: string, status = 529) {
  return chatCompletionsIn({ name: 'acme', cuts }).failure(
    status,
    new Headers(),
    JSON.stringify({ error: { message } }),
  ).message;
}

test.each([
  [
    'OpenAI`s organisation, by its words',
    openaiCuts,
    `Rate limit reached in organization org-${'aB3'.repeat(30)} on tokens`,
    'Rate limit reached on tokens',
  ],
  [
    'OpenAI`s project, by its words',
    openaiCuts,
    `Project \`proj_${'aB3'.repeat(30)}\` does not have access`,
    'The project does not have access',
  ],
  [
    'OpenAI`s request, by its words',
    openaiCuts,
    `The server had an error. Please include the request ID req_${'a1'.repeat(40)} in your message.`,
    'The server had an error.',
  ],
  [
    'OpenAI`s organisation, alone',
    openaiCuts,
    `Limit of org-${'aB3'.repeat(30)} reached`,
    'Limit of reached',
  ],
  [
    'Groq`s organisation, by its words',
    groqCuts,
    `Rate limit reached in organization \`org_${'a1'.repeat(40)}\` on tokens`,
    'Rate limit reached on tokens',
  ],
  [
    'Groq`s organisation, alone',
    groqCuts,
    `Limit of org_${'a1'.repeat(40)} reached`,
    'Limit of reached',
  ],
  [
    'Moonshot`s account and key, by their words',
    moonshotCuts,
    `Your account org-${'0f'.repeat(40)} <ak-${'a1'.repeat(40)}> request reached max RPM`,
    'Your account request reached max RPM',
  ],
  [
    'Moonshot`s organisation, alone',
    moonshotCuts,
    `Limit of org-${'0f'.repeat(40)} reached`,
    'Limit of reached',
  ],
  [
    'Moonshot`s key, alone',
    moonshotCuts,
    `Limit of <cak-${'a1'.repeat(40)}> reached`,
    'Limit of reached',
  ],
  [
    'DeepSeek`s request',
    deepseekCuts,
    `Server Error (request_id: ${'0f1e2d3c-'.repeat(9)}0f)`,
    'Server Error',
  ],
  [
    'Google`s project, by its words',
    openrouterCuts,
    `The API has not been used in project ${'5'.repeat(40)} before`,
    'The API has not been used in project before',
  ],
  [
    'Google`s project, in a path',
    openrouterCuts,
    `Quota exceeded for projects/${'5'.repeat(40)}/locations/us-central1`,
    'Quota exceeded for projects/locations/us-central1',
  ],
  [
    'Google`s project, as the resource a permission is for, by its number',
    openrouterCuts,
    `Permission denied on resource project ${'5'.repeat(40)}.`,
    'Permission denied on resource project.',
  ],
  [
    'Google`s project, as the resource a permission is for, by its name',
    openrouterCuts,
    `Permission denied on resource project ${'my-project-7'.repeat(8)}.`,
    'Permission denied on resource project.',
  ],
])(
  '%s, is cut whole when it is longer than any seen, and no part of it is left',
  (_, cuts, said, clean) => {
    expect(told(cuts, said)).toBe(clean);
  },
);

test.each([
  [
    openaiCuts,
    'Rate limit reached In Organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on tokens',
    'Rate limit reached on tokens',
  ],
  [
    openaiCuts,
    'PROJECT `proj_Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7` does not have access',
    'The project does not have access',
  ],
  [
    openaiCuts,
    'The server had an error. please include the Request ID req_0123456789abcdef in your message.',
    'The server had an error.',
  ],
  [
    groqCuts,
    'Rate limit reached in Organization `org_01m17c8ntqe9ba25dtdms847wq` on tokens',
    'Rate limit reached on tokens',
  ],
  [
    moonshotCuts,
    'your account org-0123456789abcdef0123456789abcdef <ak-a1b2c3d4e5f6g7h8i9j0> Request reached max RPM',
    'Your account request reached max RPM',
  ],
  [
    deepseekCuts,
    'Server Error (Request_ID: fb642953-7c1e-4b0a-9d55-0e2f6a1b3c4d)',
    'Server Error',
  ],
  [
    openrouterCuts,
    'The API has not been used In Project 542708778979 before',
    'The API has not been used in project before',
  ],
  [
    openrouterCuts,
    'Permission denied on Resource Project 123456789012',
    'Permission denied on resource project',
  ],
  [
    openrouterCuts,
    'Permission denied on resource project my-project-id (or it may not exist)',
    'Permission denied on resource project (or it may not exist)',
  ],
])(
  'a label that is a word is read in any letter case: %#',
  (cuts, said, clean) => {
    expect(told(cuts, said, 400)).toBe(clean);
  },
);

test.each([
  [openaiCuts, 'Tool call id call_org-abcdefghijklmnopqrstuv was not found'],
  [openaiCuts, 'No tool my-proj_abcdefghijklmnopqrstuv is known'],
  [groqCuts, 'No tool my_org_01m17c8ntqe9ba25dtdms847wq is known'],
  [groqCuts, 'No tool reorg_01m17c8ntqe9ba25dtdms847wq is known'],
  [moonshotCuts, 'No tool call_org-0123456789abcdef0123456789abcdef is known'],
  [deepseekCuts, 'Bad table row (request_id: ----------------)'],
  [deepseekCuts, 'Bad table row (request_id: fb642953)'],
  [openrouterCuts, 'Up to 5 projects 1000000 tokens each are allowed'],
  [openrouterCuts, 'See project 20261010 notes and 3 project/1234567 files'],
  [
    openrouterCuts,
    'Each of 5 projects 1000000 tokens for the resource project plan',
  ],
  [openrouterCuts, 'No resource projects 123456789012 or resource project-id'],
])(
  'what only holds an id`s shape inside a longer name, or has none, is not cut: %#',
  (cuts, said) => {
    expect(told(cuts, said)).toBe(said);
  },
);

test('a project in a path is read by its shape alone, so it stays in a request of the caller`s said back', () => {
  expect(
    told(openrouterCuts, 'No file at projects/1234567/files/notes', 400),
  ).toBe('No file at projects/1234567/files/notes');
  expect(told(openrouterCuts, 'No file at projects/1234567/files/notes')).toBe(
    'No file at projects/files/notes',
  );
});

// The router's list holds every other provider's, so one slow pattern in any
// of them is slow here.
test.each([
  [' in organization org-', ''],
  [' in organization `org_', ''],
  ['Project `proj_', ''],
  [' (Please include the request ID req_', ''],
  ['Your account org-', ''],
  [' (request_id: ', ''],
  [' in project ', ''],
  ['projects/', ''],
  [' resource project ', ''],
  ['a1-', ' resource project '],
  ['a1', ' in organization org-'],
  ['a1', 'Project `proj_'],
  ['0f', 'Your account org-'],
  ['0f', ' (request_id: '],
  ['7', ' in project '],
  ['a1', ''],
  ['7', ''],
  ['0f-', ''],
  ['-', ' (request_id: 0'],
  ['org-a1b2c3d4e5f6a7b8c9 ', ''],
  ['<ak-a1b2c3d4 ', ''],
] as const)(
  'the lists read a message that repeats %j after %j in time that grows as its length does',
  (piece, opening) => {
    function taken(size: number) {
      const said = opening + piece.repeat(size / piece.length);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        told(openrouterCuts, said);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    expect(taken(1_000_000)).toBeLessThan(40 * Math.max(taken(100_000), 1));
  },
);
