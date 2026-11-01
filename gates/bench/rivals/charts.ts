import { parseArgs } from 'node:util';
import { z } from 'zod';
import { median } from '../../measure.ts';
import type { scenarios } from './compare.ts';
import type { programs } from './programs.ts';

const sdk = z.enum(['motty', 'ai-sdk', 'mastra', 'langchain', 'tanstack']);
const scenario = z.enum([
  'text, 20 chunks',
  'stream, 20 chunks',
  'stream, 200 chunks',
  'stream of an object read by an output schema, 20 chunks',
  'serve, 200 chunks',
]);
const timing = z.object({ median: z.number(), multiple: z.number() });
const run = z.object({
  bun: z.string(),
  versions: z.object({
    ai: z.string(),
    '@mastra/core': z.string(),
    '@langchain/openai': z.string(),
    '@tanstack/ai': z.string(),
  }),
  time: z.record(scenario, z.record(sdk, timing)),
  cold: z.record(sdk, timing),
  size: z.record(sdk, z.object({ bytes: z.number(), multiple: z.number() })),
});

type Run = z.infer<typeof run>;
type Figure = { value: number; multiple: number };
type Group = ReturnType<typeof groupOf>;
type Colours = (typeof palettes)[keyof typeof palettes];

const sdkLabels: Record<keyof typeof programs, string> = {
  motty: 'Motty',
  'ai-sdk': 'AI SDK',
  mastra: 'Mastra',
  langchain: 'LangChain',
  tanstack: 'TanStack AI',
};

const scenarioLabels: Record<keyof typeof scenarios, string> = {
  'text, 20 chunks': 'Text, 20 chunks',
  'stream, 20 chunks': 'Stream, 20 chunks',
  'stream, 200 chunks': 'Stream, 200 chunks',
  'stream of an object read by an output schema, 20 chunks':
    'Structured output stream, 20 chunks',
  'serve, 200 chunks': 'Served over HTTP, 200 chunks',
};

const palettes = {
  light: {
    ink: '#1f2328',
    muted: '#59636e',
    rule: '#d1d9e0',
    motty: '#2a78d6',
    rival: '#818b95',
  },
  dark: {
    ink: '#f0f6fc',
    muted: '#9198a1',
    rule: '#3d444d',
    motty: '#3987e5',
    rival: '#6e7681',
  },
};

function figureOf({ median: value, multiple }: z.infer<typeof timing>) {
  return { value, multiple };
}

function thousands(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

// A group shows one precision: decimals drop once its largest figure has
// four digits, for its smallest too.
function measured(unit: string) {
  return (value: number, largest: number) =>
    `${largest >= 1000 ? thousands(value) : value.toFixed(1)} ${unit}`;
}

function kilobytes(value: number) {
  return `${thousands(value / 1000)} KB`;
}

function groupOf(
  title: string,
  row: string,
  runs: Run[],
  read: (run: Run, name: z.infer<typeof sdk>) => Figure,
  format: (value: number, largest: number) => string,
) {
  const figures = sdk.options.map((name) => ({
    name: sdkLabels[name],
    value: median(runs.map((taken) => read(taken, name).value)),
    multiple: median(runs.map((taken) => read(taken, name).multiple)),
  }));
  const largest = Math.max(...figures.map(({ value }) => value));
  const bars = figures.map((figure) => ({
    ...figure,
    shown: format(figure.value, largest),
    // The rounded end adds 4 to the path's straight part, and a tiny figure
    // keeps the end alone.
    length: Math.max(0, (figure.value * 190) / largest - 4),
  }));
  return { title, row, bars };
}

function shortMultiple(multiple: number) {
  return `${multiple.toFixed(multiple >= 10 ? 0 : 1)}×`;
}

function drawGroup({ title, bars }: Group, index: number, colours: Colours) {
  const left = (index % 2) * 430;
  const top = 78 + Math.floor(index / 2) * 166;
  const axis = left + 86;
  return [
    `<text x="${left}" y="${top}" font-size="13" font-weight="600" fill="${colours.ink}">${title}</text>`,
    `<line x1="${axis}" x2="${axis}" y1="${top + 11}" y2="${top + 121}" stroke="${colours.rule}" stroke-width="1"/>`,
    ...bars.flatMap(({ name, shown, multiple, length }, row) => {
      const y = top + 16 + row * 22;
      const label = `x="${left + 78}" y="${y + 10}" font-size="12" text-anchor="end"`;
      const end = `x="${axis + length + 11}" y="${y + 10}" font-size="12" fill="${colours.ink}"`;
      return [
        row === 0
          ? `<text ${label} fill="${colours.ink}" font-weight="600">${name}</text>`
          : `<text ${label} fill="${colours.muted}">${name}</text>`,
        `<path d="M${axis} ${y}h${length}a4 4 0 0 1 4 4v4a4 4 0 0 1 -4 4h-${length}z" fill="${row === 0 ? colours.motty : colours.rival}"/>`,
        row === 0
          ? `<text ${end} font-weight="600">${shown}</text>`
          : `<text ${end}>${shown}<tspan fill="${colours.muted}" font-weight="400">  ${shortMultiple(multiple)}</tspan></text>`,
      ];
    }),
  ];
}

function draw(
  title: string,
  subtitle: string,
  groups: Group[],
  colours: Colours,
) {
  const height = 212 + (Math.ceil(groups.length / 2) - 1) * 166;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 ${height}" width="860" height="${height}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif" role="img" aria-label="${title}. ${subtitle}">`,
    `<text x="0" y="22" font-size="17" font-weight="600" fill="${colours.ink}">${title}</text>`,
    `<text x="0" y="43" font-size="12.5" fill="${colours.muted}">${subtitle}</text>`,
    ...groups.flatMap((group, index) => drawGroup(group, index, colours)),
    '</svg>',
  ].join('\n');
}

function tableRow({ row, bars }: Group) {
  const [motty, ...rivals] = bars;
  return `| ${[
    row,
    motty?.shown,
    ...rivals.map(({ multiple }) => `${multiple.toFixed(2)}×`),
  ].join(' | ')} |`;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    out: {
      type: 'string',
      default: `${import.meta.dir}/../../../.github/assets`,
    },
  },
});

const runs = await Promise.all(
  positionals.map(async (path) => run.parse(await Bun.file(path).json())),
);
const [first] = runs;
if (first === undefined) {
  throw new Error(
    'Usage: bun gates/bench/rivals/charts.ts [--out folder] run1.json run2.json ...',
  );
}
const measuredOn = ({ bun, versions }: Run) =>
  JSON.stringify({ bun, versions });
if (runs.some((taken) => measuredOn(taken) !== measuredOn(first))) {
  throw new Error('The runs were not measured on one Bun and one set of SDKs');
}

const time = scenario.options.map((name) =>
  groupOf(
    scenarioLabels[name],
    scenarioLabels[name],
    runs,
    (taken, sdkName) => figureOf(taken.time[name][sdkName]),
    measured('µs'),
  ),
);
const start = [
  groupOf(
    'Cold start: import to first streamed answer',
    'Cold start, import to first streamed answer',
    runs,
    (taken, name) => figureOf(taken.cold[name]),
    measured('ms'),
  ),
  groupOf(
    'Minified program size',
    'Minified program size',
    runs,
    (taken, name) => {
      const { bytes: value, multiple } = taken.size[name];
      return { value, multiple };
    },
    kilobytes,
  ),
];

await Promise.all(
  Object.entries(palettes).flatMap(([palette, colours]) => [
    Bun.write(
      `${values.out}/benchmark-time-${palette}.svg`,
      draw(
        'Time per call',
        'Median, in microseconds. Lower is better. The multiple is each SDK’s time over Motty’s, the median over the rounds.',
        time,
        colours,
      ),
    ),
    Bun.write(
      `${values.out}/benchmark-start-${palette}.svg`,
      draw(
        'Cold start and size',
        'Lower is better. The multiple is each SDK’s figure over Motty’s.',
        start,
        colours,
      ),
    ),
  ]),
);

console.log([...time, ...start].map(tableRow).join('\n'));
console.log(
  `\nBun ${first.bun}, against \`ai\` ${first.versions.ai}, \`@mastra/core\` ${first.versions['@mastra/core']}, \`@langchain/openai\` ${first.versions['@langchain/openai']} and \`@tanstack/ai\` ${first.versions['@tanstack/ai']}`,
);
