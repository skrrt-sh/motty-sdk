import { MottyError } from '@mottyjs/core';

/**
 * A call met no script. Its code is one no upstream reports, so it is told from
 * a model a real adapter does not know.
 */
export class Unscripted extends MottyError.define('unscripted', 500) {}
