import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { zaiTakes } from './takes.ts';

// GLM numbers its failures, and tells most of them as 429 or 400: a spent
// balance or plan, a model the plan does not hold, a prompt too long.
const failures: FailureReader = (_status, _headers, { code }) => {
  switch (String(code)) {
    case '1000':
    case '1001':
    case '1002':
    case '1003':
    case '1004':
    case '1005':
    case '1220':
    case '1315':
      return { code: 'upstream_refused' };
    case '1113':
    case '1308':
    case '1309':
    case '1310':
    case '1314':
    case '1316':
    case '1317':
    case '1318':
    case '1319':
    case '1320':
    case '1321':
      return { code: 'quota_exceeded' };
    case '1302':
    case '1313':
      return { code: 'rate_limited' };
    case '1305':
      return { code: 'overloaded' };
    case '1211':
    case '1311':
      return { code: 'unknown_model' };
    case '1261':
      return { code: 'context_too_long' };
    case '1301':
      return { code: 'blocked' };
    case '1212':
      return { code: 'unsupported' };
    case '1210':
      return { code: 'invalid_request' };
    default:
      return undefined;
  }
};

export function zai(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.z.ai/api/paas/v4',
    prefix = 'zai',
    body,
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // Thinking is a switch, with three efforts beside it and no budget, and
    // JSON comes by no schema.
    codec: chatCompletionsIn({
      name: 'zai',
      thought: 'reasoning_content',
      asks: 'thinking',
      efforts: ['low', 'high', 'max'],
      output: 'json_object',
      failures,
      limit: 'max_tokens',
    }),
    prefix,
    address,
    key,
    takes: zaiTakes,
    ...connection,
    // A tool call's arguments come whole at the end unless asked to stream.
    body: { tool_stream: true, ...body },
  });
}
