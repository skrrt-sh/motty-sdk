import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { dashscopeTakes } from './takes.ts';

const spent = [
  'Arrearage',
  'BudgetLimitExceeded',
  'AllocationQuota.FreeTierOnly',
];
const busy = ['Throttling.ServiceOverloaded', 'Throttling.ResourceExhausted'];
const limited = ['insufficient_quota', 'limit_requests', 'limit_burst_rate'];
const filtered = [
  'data_inspection_failed',
  'FaqRuleBlocked',
  'CustomRoleBlocked',
  'IPInfringementSuspect',
];
const unknown = ['model_not_found', 'model_not_supported'];

// Here a quota that ran short is a limit per minute, which a wait meets,
// and an account that owes is told as a bad request.
const failures: FailureReader = (_status, _headers, { code, message }) => {
  const name = typeof code === 'string' ? code : '';
  const said = typeof message === 'string' ? message : '';
  if (spent.includes(name) || name.endsWith('BillOverdue')) {
    return { code: 'quota_exceeded' };
  }
  if (busy.includes(name)) return { code: 'overloaded' };
  if (limited.includes(name) || name.startsWith('Throttling')) {
    return { code: 'rate_limited' };
  }
  if (filtered.includes(name)) return { code: 'blocked' };
  if (said.includes('Range of input length should be')) {
    return { code: 'context_too_long' };
  }
  if (unknown.includes(name) || said === 'Model not exist.') {
    return { code: 'unknown_model' };
  }
  return undefined;
};

export function dashscope(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    // Each region has its own address, and a key works in one.
    address = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    prefix = 'dashscope',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // Thinking is a flag with a budget beside it. The newest model's effort
    // may not be sent with a budget, so it is left to the author's own words.
    codec: chatCompletionsIn({
      name: 'dashscope',
      thought: 'reasoning_content',
      asks: 'enable_thinking',
      efforts: [],
      topK: true,
      failures,
    }),
    prefix,
    address,
    key,
    takes: dashscopeTakes,
    ...connection,
  });
}
