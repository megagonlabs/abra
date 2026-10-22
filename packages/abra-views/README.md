# abra-views

The **view definitions** of the ABRA prototype, as React components. In Agent-Bound UI a *view* is a reusable interaction vocabulary over one representation (graph, table, text, display), and a *canvas* instantiates one or more views with task-specific content and interaction semantics. The views are store-agnostic: **props in, `CANVAS_EVENT` out**. A view derives everything it shows from the `canvas` object it is given and reports actions through `onEvent`; it never mutates canvas state. The interaction model itself is described in the paper linked from the repository README.

## Entry points

| Export | Role |
|---|---|
| `CanvasPanel` | Per-canvas renderer: header + body. Dispatches `canvas.view` to a view component; an unknown view renders a plain notice. |
| `CanvasArea` | Body for several canvases: one fixed arrangement per count (1 full, 2 side by side, 3 two-over-one, 4 in a 2×2 grid), every divider resizable. |
| `CanvasHeader` | View glyph, title, owner, the agent-composed controls, working indicator, close. |
| `ControlWidget` | One agent-composed control (`config.controls`): a button, select, switch, slider, or text input that either invokes an enabled action or writes a `config.presentation` key. |
| `ViewRenderer` | Body-only dispatcher over the same view map, no chrome. |
| `GraphView`, `TableView`, `TextView`, `DisplayView` | The four views. |
| `viewCatalogue` | The parsed `catalogue.json` (below). |
| `toggleVisible` | Pure helper for the capped, ordered set of visible canvases. |

Every view follows one contract:

```jsx
<View canvas={canvas} onEvent={(intent) => /* send as CANVAS_EVENT */} />
```

## View definitions

Two JSON files under `src/views/shared/manifests/` are the only source the views consume:

| File | Declares |
|---|---|
| `catalogue.json` | `view.canvas_components.<view>` is the view definition: the view's `content` schema, `presentation` options, `elements` (its addressable element kinds: node and edge; row, column, and cell; paragraph and line; item), `components`, and `actions`, each with its gesture mapping, status, path arity, and execution mode (local effect or consequence). `control` lists the composable controls (button, select, switch, slider, text) an agent may add to a canvas. |
| `actionPresentation.json` | Per view and per action, the view-owned presentation recipe: `view_private` channel assignments (which visual channel paints which state), `broadcasts` (for example `coordination`), and `dwell`. |

**Gestures and actions.** A gesture is how a user performs an interaction on an element (hover, click, drag, double-click, a key); an action is the operation communicated to the agent (`select_node`, `edit_cell`, `add_edge`). Gesture mappings are implemented inside each view and do not depend on any task-specific binding.

**Enabled actions.** A gesture runs only if its action is enabled for the canvas, which means the owning agent published it in `canvas.config.actions` (`published()` in `derive.js`). The agent binds elements to task referents and assigns each enabled action a task-specific `meaning` (and an optional `label`); that is all it authors. The execution mode is part of the view definition, never an agent choice: a **local effect** is handled by the view from view state alone (highlight, select, reposition, sort, ...), and a **consequence** is delegated to the agent that owns the canvas, which resolves it (add node, edit cell, ...). `hasConsequence()` reads the mode from `catalogue.json`.

## Three presentation layers

| Layer | Owner | Lands in | Implemented in |
|---|---|---|---|
| view-private | the view | React state inside the view (hover, selection, edit draft, drag preview) | each `*View.jsx`, channels per `actionPresentation.json` |
| shared overlay | the reducer (canvas hub, mirrored in every client) | `canvas.highlight`, keyed by source: hovering an element highlights its co-referent elements across the other views | reducer; views read it through `coordinatedKeys()` |
| shared durable | the reducer | `content` and `config.presentation` (layout, sort, committed edits) | reducer, from committed action values and resolved consequences |

Local highlight is a static outline or stroke; the co-referent highlight reuses the same channel family as an animated overlay with a distinct accent, so the two stay distinguishable without taking over encoded channels such as edge width.

## Runtime pipeline (one gesture)

```
DOM event in the view (hover, click, drag, double-click, key)
  → resolve the action for { element, gesture } from the view definition   // catalogue.json
  → gate: is the action enabled (published in canvas.config.actions)?       // derive.js published()
  → paint view-private channels                                             // actionPresentation.json
  → onEvent({ action, path, ref?, value? })                                 // the CANVAS_EVENT intent
  → reducer: validates the value; applies a local effect's durable state, or
             records a consequence for the owning agent to resolve; merges the
             co-referent highlight when the action broadcasts coordination
  → every participant re-renders from the new canvas state
```

Transient hover never reaches the reducer except through the co-referent highlight. Committed gestures with a `value` (for example `reposition_node`, `edit_cell`) carry the change on the event.

## Shared helpers

- `views/shared/derive.js`: `rows`, `orderedRows`, `published`, `hasConsequence`, `chromeEnabled`, `affordanceClass`, `coordinatedKeys`, `appliedEffectKeys`, `encoding`, `nominalColor`, `linear`, selection helpers, `elementFlags`.
- `views/shared/interaction.js`: `useInteractionManager`, which suppresses hover and select while a drag, an edit, or a pending-like local operation owns the pointer or keyboard.

## Changing presentation

1. Declare it in `actionPresentation.json` (channels, `broadcasts`, `dwell`), and make sure each channel is allowed for the element in `catalogue.json`.
2. Paint it in the view.
