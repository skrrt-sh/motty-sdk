import type { Prompt, Tool, ToolChoice } from '@mottyjs/core/host';
import type { Leaving } from './fieldless.ts';

function chosen(choice: ToolChoice | undefined): readonly string[] {
  if (typeof choice !== 'object') return [];
  if ('tool' in choice) return [choice.tool];
  return 'allowed' in choice ? choice.allowed : [];
}

// A tool only another API runs is offered, not asked for: a model never
// shown it cannot call it, so it is left out. A tool choice that names it
// asks for it, and fails the call.
export function offered(
  left: Leaving,
  family: string,
  tools: Prompt['tools'],
  choice: ToolChoice | undefined,
): Tool[] {
  return (tools ?? []).filter((tool) => {
    if (tool.type !== 'provider' || tool.provider[family] !== undefined) {
      return true;
    }
    const named = tool.name !== undefined && chosen(choice).includes(tool.name);
    left.without(named ? 'tool.chosen' : 'tool.offered', true);
    return false;
  });
}
