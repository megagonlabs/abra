// @ts-check
/**
 * View-type → Blueprint icon name (an `@blueprintjs/icons` name), for the chip bar
 * and cell headers. Rendered via `<Icon icon={viewIcon(view)} />`. Unknown views
 * fall back to a neutral mark. (CanvasHeader keeps its own copy — abra-views can't
 * import the shell.)
 */

/** @type {Record<string, string>} view -> Blueprint IconName */
const ICONS = {
  graph: 'graph',
  table: 'th',
  text: 'paragraph',
  form: 'form',
  diff: 'comparison',
  display: 'media',
  harness: 'lab-test',
};

/** @param {string} view @returns {string} */
export function viewIcon(view) {
  return ICONS[view] ?? 'help';
}
