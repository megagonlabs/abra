// @ts-check
/**
 * ControlWidget — one agent-composed toolbar control (`config.controls`). A control does
 * ONE of two things:
 *   - `fires: '<action id>'` — fires a PUBLISHED action (an add_node/add_column button). This is
 *     for CONSEQUENCE / local_effect actions only; the reducer arms the pending / paints the
 *     effect — exactly as the built-in chrome would. Emits `CANVAS_EVENT { control, action, value }`.
 *   - `writes: '<presentation key>'` — sets a `config.presentation` value; a **dotted** sub-key
 *     drives one field of a compound value (`sort.colId`, `sort.dir`, `filter.keyword`), a plain
 *     key drives a scalar (`layout`, `groupBy`, `find`, `focus`). Emits `{ control, config:{ presentation } }`.
 *
 * PRESENTATION IS DRIVEN EXCLUSIVELY THROUGH `writes` (never `fires`): the single source of truth
 * is `config.presentation[key]`, and both the control and the built-in chrome keyed-merge into the
 * SAME key path, so they never diverge. Controls are CONTROLLED — the displayed value is read back
 * from `config.presentation` via the `writes` key (dotted-path aware), mirroring shared state.
 */
import './canvas-chrome.css';

/** read a (possibly dotted) path out of an object */
function readPath(/** @type {any} */ obj, /** @type {string} */ path) {
  return path.split('.').reduce((/** @type {any} */ o, k) => (o == null ? undefined : o[k]), obj);
}
/** build a nested patch `{a:{b:value}}` from a dotted path + value */
function patchPath(/** @type {string} */ path, /** @type {any} */ value) {
  return path.split('.').reduceRight((/** @type {any} */ acc, k) => ({ [k]: acc }), value);
}

export function ControlWidget({ control, canvas, onEvent }) {
  const presentation = canvas?.config?.presentation ?? {};
  // The controlled value mirrors the presentation key this control WRITES (dotted-path aware),
  // so a toolbar control and the built-in chrome/gesture stay in lock-step. A `fires`-only
  // control (consequence/local_effect) has no presentation value to reflect.
  const presKey = control.writes ?? null;
  const current = presKey != null ? readPath(presentation, presKey) : undefined;

  const fire = (/** @type {any} */ value) => {
    if (control.fires) onEvent({ control: control.id, action: control.fires, value });
    else if (control.writes)
      onEvent({ control: control.id, config: { presentation: patchPath(control.writes, value) } });
  };

  if (control.type === 'button') {
    return (
      <button type="button" className="abra-ctrl-btn" onClick={() => fire(control.value ?? true)}>
        {control.label ?? control.id}
      </button>
    );
  }
  if (control.type === 'select') {
    const val = current ?? control.value ?? control.options?.[0] ?? '';
    return (
      <label className="abra-ctrl">
        {control.label}
        <select value={String(val)} onChange={(e) => fire(e.currentTarget.value)}>
          {(control.options ?? []).map((/** @type {string} */ o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (control.type === 'switch') {
    return (
      <label className="abra-ctrl">
        <input
          type="checkbox"
          checked={current ?? !!control.value}
          onChange={(e) => fire(e.currentTarget.checked)}
        />
        {control.label}
      </label>
    );
  }
  if (control.type === 'slider') {
    return (
      <label className="abra-ctrl">
        {control.label}
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={current ?? control.value ?? ''}
          onChange={(e) => fire(Number(e.currentTarget.value))}
        />
      </label>
    );
  }
  if (control.type === 'text') {
    // freeform string — commit on Enter / blur (NOT per-keystroke, which would round-trip
    // every character). Uncontrolled + a value-derived key so an external change re-seeds it.
    const seed = current ?? control.value ?? '';
    return (
      <label className="abra-ctrl">
        {control.label}
        <input
          key={String(seed)}
          type="text"
          defaultValue={seed}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fire(e.currentTarget.value);
          }}
          onBlur={(e) => fire(e.currentTarget.value)}
        />
      </label>
    );
  }
  return null;
}
