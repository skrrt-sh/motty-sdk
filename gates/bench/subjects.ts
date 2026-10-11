import { motty } from '../../packages/core/src/chain/motty.ts';
import { contractOf } from '../../packages/core/src/chain/run.ts';
import type { Contract } from '../../packages/core/src/contract.ts';
import { answer } from '../../packages/core/src/request/answer.ts';
import { stubHost } from '../../packages/core/test/stub-host.ts';
import { ask, coder, script } from './coder.ts';

const replies = script(4);
const bare = contractOf(
  motty({ name: 'bare' }).handle(() => answer('The lock order differs')),
);
const chained = contractOf(coder());

// A host and a request of its own for every request, read to its last event.
async function request(contract: Contract, model: string) {
  let last = '';
  for await (const event of contract.run(ask(model), stubHost(replies))) {
    last = event.type;
  }
  if (last !== 'finish') throw new Error(`The request ended with ${last}`);
}

export const subjects: Record<string, () => Promise<void>> = {
  'request, handler only': () => request(bare, 'motty/bare'),
  'request, coder chain': () => request(chained, 'motty/coder'),
};
