import type { Taken, Takes } from '@mottyjs/serve/codec';

// The Claude models that still take sampling: every one before Opus 4.7. A
// router writes a version with a dot, so the name is read with dashes.
const sampled =
  /^claude-(?:[123](?!\d)|instant|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?(?!-?\d))/;

// Of those, the ones that take an effort.
const leveled = /^claude-(?:opus-4-[56]|sonnet-4-6)(?!\d)/;

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
  const effort = leveled.test(name);
  return reasons === true
    ? { ...fixed, topP: [0.95, 1], effort }
    : { ...fixed, temperature: [0, 1], topP: [0, 1], topK: true, effort };
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

// A model named after this was written is held to the newest behaviour: it
// samples only when told not to reason. One that never samples refuses that
// order as well, so it needs no name here.
export const openaiTakes: Takes = (tuned, reasons) => {
  // A fine-tuned model behaves as the one it was tuned from.
  const model = tuned.replace(/^ft:/, '');
  const sampling: Taken = {
    temperature: [0, 2],
    topP: [0, 1],
    topK: false,
    presencePenalty: true,
    frequencyPenalty: true,
    together: true,
    effort: true,
  };
  const fixed: Taken = {
    ...sampling,
    temperature: 1,
    topP: 1,
    presencePenalty: false,
    frequencyPenalty: false,
  };
  if (searching.test(model)) return { ...fixed, effort: false };
  if (classic.test(model)) return { ...sampling, effort: false };
  const samples = lenient.test(model) ? reasons !== true : reasons === false;
  // Chat Completions refuses a top-p of zero from a model that can reason.
  return samples ? { ...sampling, topP: [0.01, 1] } : fixed;
};

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
