import type { Taken, Takes } from '@mottyjs/serve/codec';

type Effort = Extract<Taken['effort'], readonly unknown[]>[number];

// The Claude models that still take sampling: every one before Opus 4.7. A
// router writes a version with a dot, so the name is read with dashes.
const sampled =
  /^claude-(?:[123](?!\d)|instant|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?(?!-?\d))/;

// Of those, the one that takes an effort and thinks only on a budget, and the
// ones that take a higher effort and may be left to set their own thinking.
const budgeted = /^claude-opus-4-5(?!\d)/;
const selfPaced = /^claude-(?:opus|sonnet)-4-6(?!\d)/;

// What a model answered live: the levels it names in its own refusal.
function paced(name: string): Pick<Taken, 'effort' | 'adaptive'> {
  if (selfPaced.test(name)) return { effort: ['low', 'medium', 'high', 'max'] };
  return budgeted.test(name)
    ? { effort: ['low', 'medium', 'high'], adaptive: false }
    : { effort: false, adaptive: false };
}

// A cloud that serves Claude names it after the maker, and after a region.
const hosted = /^(?:[a-z-]+\.)?anthropic\./;

// A model named after this was written is held to the newest behaviour: no
// temperature but one, and no top-p but the one the API still lets through.
export const anthropicTakes: Takes = (model, reasons) => {
  const name = model.replace(hosted, '').replaceAll('.', '-');
  const fixed: Taken = {
    temperature: 1,
    topP: 0.99,
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: false,
    effort: true,
  };
  if (!sampled.test(name)) return fixed;
  return reasons === true
    ? { ...fixed, topP: [0.95, 1], ...paced(name) }
    : {
        ...fixed,
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        ...paced(name),
      };
};

// The models that always sample and never reason, the search models, which
// do neither, and the ones that sample unless told to reason. A cloud writes
// 3.5 with no dot.
const classic = /^gpt-(?:3\.?5|4)/;
const searching = /-search-/;

// A closed list of what answered so, ended where the name ends: a name
// beside it that nobody asked is held to the newest behaviour instead.
const lenient =
  /^gpt-5\.(?:[124]|4-(?:mini|nano)|3-codex)(?:-\d{4}-\d\d-\d\d)?(?::|$)/;

// A name as it was asked, with the date or the suffix a snapshot adds.
const named = (names: string) =>
  new RegExp(`^(?:${names})(?:-\\d{4}-\\d\\d-\\d\\d)?(?::|$)`);

// The effort levels a model has a word for on the Responses API, as each
// named them in its own refusal. The lists are closed like the one above: a
// model named after this was written is held to the newest, which has every
// level and no order not to reason.
const worded: readonly (readonly [RegExp, readonly Effort[]])[] = [
  [named('chat-latest'), ['medium']],
  [named('o1|o3|o3-mini|o4-mini|o1-pro|o3-pro'), ['low', 'medium', 'high']],
  [named('gpt-5-pro'), ['high']],
  [named('gpt-5|gpt-5-mini|gpt-5-nano'), ['minimal', 'low', 'medium', 'high']],
  [named('gpt-5\\.1'), ['none', 'low', 'medium', 'high']],
  [named('gpt-5\\.[245]-pro'), ['medium', 'high', 'xhigh']],
  [
    named('gpt-5\\.[245]|gpt-5\\.3-codex|gpt-5\\.4-(?:mini|nano)'),
    ['none', 'low', 'medium', 'high', 'xhigh'],
  ],
  [
    named('gpt-5\\.6-(?:luna|sol|terra)|gpt-6-(?:luna|sol)'),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  ],
];
const newest: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Chat Completions has no word for the highest level, and takes one level
// more from the o-series than the Responses API does.
function levels(model: string, chat: boolean): readonly Effort[] {
  const [, found = newest] = worded.find(([name]) => name.test(model)) ?? [];
  if (!chat) return found;
  const rest = found.filter((level) => level !== 'max');
  return /^o\d/.test(model) ? [...rest, 'xhigh'] : rest;
}

// A model named after this was written is held to the newest behaviour: it
// samples only when told not to reason. One that never samples refuses that
// order as well, so it needs no name here.
const openaiOn =
  (chat: boolean): Takes =>
  (tuned, reasons) => {
    // A fine-tuned model behaves as the one it was tuned from.
    const model = tuned.replace(/^ft:/, '');
    // Read only of a model that may reason, the levels cost eight patterns.
    const searches = searching.test(model);
    const always = !searches && classic.test(model);
    const sampling: Taken = {
      temperature: [0, 2],
      topP: [0, 1],
      topK: false,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: searches || always ? false : levels(model, chat),
    };
    const fixed: Taken = {
      ...sampling,
      temperature: 1,
      topP: 1,
      presencePenalty: false,
      frequencyPenalty: false,
    };
    if (searches) return fixed;
    if (always) return sampling;
    const samples = lenient.test(model) ? reasons !== true : reasons === false;
    // Chat Completions refuses a top-p of zero from a model that can reason.
    return samples ? { ...sampling, topP: [0.01, 1] } : fixed;
  };

export const openaiTakes = openaiOn(false);
export const openaiChatTakes = openaiOn(true);

// The Kimi models that still sample, and the ones whose thinking is a switch.
const older = /^moonshot-v1/;
const toggled = /^kimi-k2(?!.*-code)/;

// A model named after this was written is held to the newest behaviour: one
// temperature, one top-p and no penalty, any other value being an error. The
// temperature a switched model allows is another once thinking is off.
export const moonshotTakes: Takes = (model, reasons) => {
  const free: Taken = {
    temperature: [0, 1],
    topP: [0, 1],
    topK: false,
    presencePenalty: true,
    frequencyPenalty: true,
    together: true,
    effort: true,
  };
  if (older.test(model)) return free;
  return {
    ...free,
    temperature: reasons === false && toggled.test(model) ? 0.6 : 1,
    topP: 0.95,
    presencePenalty: false,
    frequencyPenalty: false,
  };
};

// GLM's reference has a narrower temperature than OpenAI's, a top-p that is
// never zero and no penalty.
export const zaiTakes: Takes = () => ({
  temperature: [0, 1],
  topP: [0.01, 1],
  topK: false,
  presencePenalty: false,
  frequencyPenalty: false,
  together: true,
  effort: true,
});

// The models of other makers served here, which take no top-k.
const guest = /^(?:deepseek|kimi|moonshot|minimax)/i;

// Qwen takes a temperature below two and a top-p above zero, so each range
// ends at the nearest value a caller would write.
export const dashscopeTakes: Takes = (model) => ({
  temperature: [0, 1.99],
  topP: [0.01, 1],
  topK: !guest.test(model),
  presencePenalty: true,
  frequencyPenalty: true,
  together: true,
  effort: true,
});

// Mistral's reference has a temperature up to 1.5, a top-p that is never
// zero and no top-k.
export const mistralTakes: Takes = () => ({
  temperature: [0, 1.5],
  topP: [0.01, 1],
  topK: false,
  presencePenalty: true,
  frequencyPenalty: true,
  together: true,
  effort: true,
});

// MiniMax's reference has OpenAI's ranges and no penalty.
export const minimaxTakes: Takes = () => ({
  temperature: [0, 2],
  topP: [0, 1],
  topK: false,
  presencePenalty: false,
  frequencyPenalty: false,
  together: true,
  effort: true,
});
