import { cuts as anthropic } from '@mottyjs/serve/messages-failure';
import type { Cut } from '@mottyjs/serve/upstream-failure';

// An id is cut as far as it runs: one cut by a count would be left in part.
// The count only bounds what a hostile message can cost.

// A limit names the organisation it is counted for, a refusal the project,
// and a server's failure the request to quote to support. The last reads an
// id alone, should the words around it change.
export const openaiCuts: readonly Cut[] = [
  { pattern: / in organization org-[A-Za-z0-9]{16,4096}/gi, replacement: '' },
  {
    pattern: /Project `proj_[A-Za-z0-9]{16,4096}`/gi,
    replacement: 'The project',
  },
  {
    pattern:
      / ?\(?Please include the request ID req_[A-Za-z0-9]{8,4096} in your message\.\)?/gi,
    replacement: '',
  },
  {
    pattern: /(?<![A-Za-z0-9_-])(?:org-|proj_)[A-Za-z0-9]{16,4096}/g,
    replacement: '',
    bare: true,
  },
];

// A rate limit names the organisation it is counted for. The second reads
// its id alone, should the words around it change.
export const groqCuts: readonly Cut[] = [
  { pattern: / in organization `org_[0-9a-z]{16,4096}`/gi, replacement: '' },
  {
    pattern: /(?<![A-Za-z0-9_])org_[0-9a-z]{16,4096}/g,
    replacement: '',
    bare: true,
  },
];

// A rate limit names the organisation, the project and the key it is
// counted for. The last two read each id alone, should the words around
// them change.
export const moonshotCuts: readonly Cut[] = [
  {
    pattern:
      /Your account org-[0-9a-f]{16,4096}(?: \/ proj-[0-9a-f]{16,4096})? ?<c?ak-[a-z0-9]{8,4096}> request/gi,
    replacement: 'Your account request',
  },
  {
    pattern: /(?<![A-Za-z0-9_-])(?:org|proj)-[0-9a-f]{16,4096}/g,
    replacement: '',
    bare: true,
  },
  { pattern: /<c?ak-[a-z0-9]{8,4096}>/g, replacement: '', bare: true },
];

// Runs of hex digits joined by dashes, sixteen characters or more: dashes
// alone are no id.
const hex = '(?=[0-9a-f-]{16})[0-9a-f]{1,4096}(?:-[0-9a-f]{1,4096}){0,64}';

// A failure ends with the request's id, which only its account can look up.
export const deepseekCuts: readonly Cut[] = [
  { pattern: new RegExp(` \\(request_id: ${hex}\\)`, 'gi'), replacement: '' },
];

// Google names the project a key belongs to, and has no adapter of its own:
// in a sentence, as the resource a permission is for, or in a path, which is
// a shape alone. A number beside the word otherwise is a count or a date.
const google: readonly Cut[] = [
  { pattern: /\bin project \d{6,4096}/gi, replacement: 'in project' },
  {
    pattern: /\bresource project [a-z0-9][a-z0-9-]{5,4095}/gi,
    replacement: 'resource project',
  },
  { pattern: /\bprojects\/\d{6,4096}/g, replacement: 'projects', bare: true },
];

const routed = [
  ...openaiCuts,
  ...anthropic,
  ...groqCuts,
  ...moonshotCuts,
  ...deepseekCuts,
  ...google,
];

// What a provider said comes beside the router's own words, in any routed
// provider's. An id read alone is cut last: one provider's would break the
// words another's is read by.
export const openrouterCuts: readonly Cut[] = [
  ...routed.filter(({ bare }) => bare !== true),
  ...routed.filter(({ bare }) => bare === true),
];
