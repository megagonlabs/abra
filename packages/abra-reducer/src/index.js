// @ts-check
/**
 * Server entry (the `.` export): the authoritative `reduce` + lifecycle.
 * The export split keeps server logic out of the browser bundle, which imports
 * only `abra-reducer/apply`.
 */

export { isConsequenceAction } from './actionCatalogue.js';
export { applyDelta, linkIndex, mergeContent } from './apply.js';
export { initialState, reduce } from './reduce.js';
