import { type ErrorFacts, fromFacts } from '@mottyjs/core/host';

// Facts may hold any number, and only an error status may answer a caller.
// Facts that hold none answer with the status of their kind.
export function errorStatus(facts: ErrorFacts): number {
  const { status } = fromFacts(facts);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
}
