import { MottyError } from '@mottyjs/core';

// A code no upstream reports, so a call that met no script is told from a
// model a real adapter does not know.
export class Unscripted extends MottyError.define('unscripted', 500) {}
