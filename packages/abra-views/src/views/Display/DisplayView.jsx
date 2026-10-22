// @ts-check
/**
 * DisplayView — read-only media surface. Items are addressed `item/<id>` and render by
 * `type`:
 *   • image     → a raster in the shared RasterStage
 *   • document  → PDF pages (react-pdf) stacked in the SAME RasterStage — a PDF is just
 *                 vertically-concatenated rasters, so image + pdf share one viewer
 *   • map       → an interactive OpenStreetMap (react-leaflet), its OWN pan/zoom engine
 *                 (a map is level-of-detail tiles, not a static raster — the exception)
 * The view is a GALLERY (`config.presentation.layout` ∈ grid | strip — grid tiles, strip =
 * 1×n scroll); clicking a tile OPENS that item in the SINGLE viewer (the media typed by
 * `item.type`), which shows a "← Gallery" affordance whenever there's more than one item.
 * A lone item is just the single viewer (a gallery of one). The opened item follows the
 * shared `config.presentation.focus` (focus_item). Coordination is browsing-only — hover
 * brushes by `ref` in the gallery; the single viewer stays silent. Emits CANVAS_EVENT only.
 */
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  coordinatedKeys,
  EMPTY_SELECTION,
  elementFlags,
  published,
  rows as rowsOf,
} from '../shared/derive.js';
import '../views.css';

// PDF.js worker — version-matched via `pdfjs.version` (react-pdf bundles pdfjs-dist), so
// the worker never mismatches the API. Served from a CDN to stay independent of pnpm
// hoisting; needs network, like the map tiles. (Swap for a bundled worker to go offline.)
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// ---- per-type media renderers -------------------------------------------

/** @param {{ item: any }} props */
function ImageMedia({ item }) {
  return (
    <img
      className="abra-display-img"
      src={item.src}
      alt={item.title ?? item.caption ?? ''}
      draggable={false}
    />
  );
}

/** PDF pages stacked vertically at `width` px (default 820). `firstOnly` renders just the
 * first page (a gallery tile); otherwise ALL pages stack — so a small `width` is a faithful
 * whole-document thumbnail (used by the minimap), not just page 1.
 * @param {{ item: any, width?: number, firstOnly?: boolean }} props */
function DocMedia({ item, width, firstOnly }) {
  const [numPages, setNumPages] = useState(0);
  const count = firstOnly ? 1 : numPages;
  return (
    <Document
      className="abra-display-doc"
      file={item.src}
      onLoadSuccess={(/** @type {{ numPages: number }} */ pdf) => setNumPages(pdf.numPages)}
      loading={<div className="abra-display-msg">Loading PDF…</div>}
      error={<div className="abra-display-msg">Couldn't load PDF</div>}
    >
      {Array.from({ length: count }, (_, i) => (
        <Page
          // biome-ignore lint/suspicious/noArrayIndexKey: a PDF page IS identified by its page number
          key={i}
          className="abra-display-page"
          pageNumber={i + 1}
          width={width ?? 820}
          renderTextLayer={false}
          renderAnnotationLayer={false}
        />
      ))}
    </Document>
  );
}

/** Interactive OSM map framed by `item.center` ([lat, lng]) + `item.zoom`.
 * @param {{ item: any, interactive?: boolean }} props */
function MapMedia({ item, interactive = true }) {
  const center = Array.isArray(item.center) ? item.center : [51.505, -0.09];
  const zoom = Number.isFinite(item.zoom) ? item.zoom : 13;
  return (
    <MapContainer
      className="abra-display-map"
      center={center}
      zoom={zoom}
      scrollWheelZoom={interactive}
      dragging={interactive}
      doubleClickZoom={interactive}
      zoomControl={interactive}
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
    </MapContainer>
  );
}

/** Gallery-tile media (thumbnail): image inline · doc FIRST page · a static mini-map. */
function ItemMedia(/** @type {{ item: any }} */ { item }) {
  if (item.type === 'document') return <DocMedia item={item} width={200} firstOnly />;
  if (item.type === 'map') return <MapMedia item={item} interactive={false} />;
  return <ImageMedia item={item} />;
}

// ---- shared raster viewer (image + pdf) ---------------------------------

const MINIMAP_W = 120;

/** Overview of where the viewport sits in the WHOLE image, with a draggable frame. IMAGES
 * ONLY — a PDF has no minimap (its pages don't make a useful single thumbnail).
 * @param {{ vp: any, item: any, onJump: (fx: number, fy: number) => void }} props */
function Minimap({ vp, item, onJump }) {
  if (item?.type !== 'image' || !item.src) return null; // images only — no PDF/map minimap
  if (vp.w >= 0.999 && vp.h >= 0.999) return null; // content fits — nothing to overview
  const ratio = vp.ratio || 1;
  // The box keeps the IMAGE aspect (so the rect aligns with the thumbnail), capped at MAX_H.
  const MAX_H = 300;
  let W = MINIMAP_W;
  let H = W / ratio;
  if (H > MAX_H) {
    H = MAX_H;
    W = Math.round(H * ratio);
  }
  return (
    <button
      type="button"
      className="abra-display-minimap"
      style={{ width: W, height: H }}
      aria-label="viewport overview"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      }}
    >
      <div className="abra-display-minimap-thumb">
        <img className="abra-display-minimap-img" src={item.src} alt="" />
      </div>
      <span
        className="abra-display-minimap-vp"
        style={{
          left: `${vp.left * 100}%`,
          top: `${vp.top * 100}%`,
          width: `${vp.w * 100}%`,
          height: `${vp.h * 100}%`,
        }}
      />
    </button>
  );
}

/** Scroll (native) + zoom (⌘/ctrl-wheel or ＋/－) + hand-drag pan, with a viewport
 * minimap. One viewer for any raster content — a single image or a tall stack of PDF
 * pages behave identically. Zoom uses CSS `zoom` (not `transform`) so the scroll area
 * grows with it — that's what makes native scroll + the minimap read the right size.
 * @param {{ children: any, item: any }} props */
function RasterStage({ children, item }) {
  const [scale, setScale] = useState(1);
  const [vp, setVp] = useState({ left: 0, top: 0, w: 1, h: 1, ratio: 1 });
  const scrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const drag = useRef(/** @type {{ x: number, y: number, l: number, t: number } | null} */ (null));
  // fraction of the content the viewport is CENTERED on — captured before a zoom so we can
  // keep that point centered after (else CSS `zoom` grows from the top-left corner).
  const centerRef = useRef({ fx: 0.5, fy: 0.5 });
  // one-shot: on an image's first real layout, fit it to the viewport so the WHOLE picture is
  // the opening view (default scale=1 = natural size = a crop of anything bigger than the pane).
  const didFit = useRef(false);

  const captureCenter = () => {
    const el = scrollRef.current;
    if (!el) return;
    const sw = el.scrollWidth || 1;
    const sh = el.scrollHeight || 1;
    centerRef.current = {
      fx: (el.scrollLeft + el.clientWidth / 2) / sw,
      fy: (el.scrollTop + el.clientHeight / 2) / sh,
    };
  };
  // The scale at which the media just FITS the viewport (contain), clamped to ≤ 1 so we
  // never force zoom-IN past natural size. This is the MINIMUM zoom: zooming out further
  // would shrink the media below the viewport in both axes (all-around whitespace). `s` is
  // the current scale (the media element is already zoomed by it, so /s recovers base size).
  // The actual MEDIA box — the <img> or the PDF pages column. NOT `.abra-display-scale`
  // (a full-width flex container whose width = the viewport, which is what broke the
  // minimap); its child is content-sized (820px via align-items:center), so we measure that.
  const mediaEl = () =>
    /** @type {HTMLElement | null} */ (
      scrollRef.current?.querySelector('.abra-display-img, .abra-display-doc') ?? null
    );

  // The scale at which the media just FITS the viewport (contain), clamped to ≤ 1 so we
  // never force zoom-IN past natural size. This is the MINIMUM zoom: below it the media is
  // smaller than the viewport in both axes (all-around whitespace). `s` = current scale
  // (the media is already zoomed by it, so /s recovers base size).
  const fitScale = (/** @type {number} */ s) => {
    const el = scrollRef.current;
    const media = mediaEl();
    if (!el || !media) return 0.25;
    const r = media.getBoundingClientRect();
    const baseW = r.width / s || 1;
    const baseH = r.height / s || 1;
    return Math.min(1, Math.min(el.clientWidth / baseW, el.clientHeight / baseH));
  };
  const zoomBy = (/** @type {number} */ f) => {
    captureCenter();
    setScale((s) => Math.min(6, Math.max(fitScale(s), s * f)));
  };

  const measure = () => {
    const el = scrollRef.current;
    const media = mediaEl();
    if (!el || !media) return;
    // Both rects in SCREEN coordinates (getBoundingClientRect includes CSS zoom). The visible
    // window IS where the scroll viewport overlaps the media — compute the fraction directly.
    // Robust to centering, one-axis-fits, and zoom (scrollWidth was max(content,viewport)).
    const vr = el.getBoundingClientRect();
    const mr = media.getBoundingClientRect();
    const cw = mr.width || 1;
    const ch = mr.height || 1;
    setVp({
      left: Math.max(0, Math.min(1, (vr.left - mr.left) / cw)),
      top: Math.max(0, Math.min(1, (vr.top - mr.top) / ch)),
      w: Math.max(0, Math.min(1, el.clientWidth / cw)),
      h: Math.max(0, Math.min(1, el.clientHeight / ch)),
      ratio: cw / ch,
    });
  };

  // after a zoom, re-center on the captured point; also re-measure when the content
  // resizes (image loads, PDF pages render in).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads refs only; re-run on zoom
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el) return;
    el.scrollLeft = centerRef.current.fx * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = centerRef.current.fy * el.scrollHeight - el.clientHeight / 2;
    measure();
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      measure();
      // First time the media has a real box, fit an IMAGE to the pane (contain) so it opens
      // showing the whole picture. Images only — a PDF opens at readable width and scrolls,
      // not shrunk to fit the whole page stack. Runs once (didFit); RasterStage remounts per
      // item (key=item.id) so it re-arms for the next image.
      if (!didFit.current && item?.type === 'image') {
        const media = mediaEl();
        if (media && media.getBoundingClientRect().width > 0) {
          didFit.current = true;
          const f = fitScale(scale);
          if (f < scale) setScale(f); // only ever zoom OUT to reveal the whole image
        }
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [scale]);

  const jump = (/** @type {number} */ fx, /** @type {number} */ fy) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = fx * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = fy * el.scrollHeight - el.clientHeight / 2;
    measure();
  };

  return (
    <div className="abra-display-viewer">
      <div className="abra-display-zoombar">
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="zoom in">
          ＋
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="zoom out">
          －
        </button>
        <button type="button" onClick={() => setScale((s) => fitScale(s))} aria-label="fit to view">
          ⤢
        </button>
      </div>
      <Minimap vp={vp} item={item} onJump={jump} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hand-drag pan over a scroll surface */}
      <div
        ref={scrollRef}
        className="abra-display-scroll"
        onScroll={measure}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
        }}
        onMouseDown={(e) => {
          const el = scrollRef.current;
          if (el) drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
        }}
        onMouseMove={(e) => {
          const el = scrollRef.current;
          if (drag.current && el) {
            el.scrollLeft = drag.current.l - (e.clientX - drag.current.x);
            el.scrollTop = drag.current.t - (e.clientY - drag.current.y);
          }
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <div className="abra-display-scale" style={{ zoom: scale }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function DisplayView({ canvas, onEvent }) {
  const items = rowsOf(canvas.content?.items, 'id');
  const lit = coordinatedKeys(canvas);
  const presentation = canvas.config?.presentation ?? {};
  // `layout` is ONLY the gallery style (grid | strip; grid default). "single" is NOT a
  // layout — the single viewer is derived: it shows when there is exactly one item, or when
  // an item is opened from the gallery (below).
  const galleryStyle = presentation.layout === 'strip' ? 'strip' : 'grid';
  const focusId = presentation.focus ? String(presentation.focus).replace(/^item\//, '') : null;

  // openId = the item shown in the SINGLE viewer — a view-local lightbox, seeded from the
  // shared `presentation.focus`. null = show the gallery.
  const [openId, setOpenId] = useState(() => focusId ?? null);
  // follow the agent moving the shared focus
  useEffect(() => {
    if (focusId) setOpenId(focusId);
  }, [focusId]);

  // ONE item ⇒ it IS the whole view (a gallery of one); else honor the lightbox selection.
  const opened = items.length === 1 ? items[0] : openId ? items.find((i) => i.id === openId) : null;
  const inSingle = !!opened;

  const emit = (
    /** @type {string} */ action,
    /** @type {string} */ path,
    /** @type {string=} */ ref,
  ) => {
    // the single viewer is VIEWING (pan/zoom one item), not browsing — so it never brushes
    // coordination even if highlight_item is published. Brushing is a gallery gesture.
    if (inSingle) return;
    if (published(canvas, action)) onEvent({ action, path, ref });
  };

  // clicking a gallery tile OPENS it in the single viewer (typed by its media) and shares
  // the focus so peers/agents can follow (focus_item, if published).
  const openItem = (/** @type {any} */ item) => {
    // opening unmounts this tile, so its onMouseLeave (dehighlight_item) never fires — clear
    // its hover coordination NOW, else the overlay leaks and the item stays lit in other
    // views after returning to the gallery. (emit still passes: inSingle is false until the
    // setOpenId below re-renders.)
    emit('dehighlight_item', `item/${item.id}`, item.ref);
    setOpenId(item.id);
    // focus_item shares ONLY the single-view state (`config.presentation.focus`); it carries
    // NO `ref`, so it can never join the cross-view coordination overlay (broadcasts /
    // view_private are both empty in actionPresentation — this keeps that guarantee at the
    // emit site too). Coordination is a gallery-hover concern, not a focus concern.
    if (published(canvas, 'focus_item'))
      onEvent({
        action: 'focus_item',
        path: `item/${item.id}`,
        // presentation is single-source: the focus rides as an explicit config.presentation
        // patch (keyed-merged into config.presentation.focus), the same shape the shared state
        // holds — never a declared value→target derivation.
        config: { presentation: { focus: `item/${item.id}` } },
      });
  };

  const itemProps = (/** @type {any} */ item) => {
    const ref = item.ref;
    const { coordinated } = elementFlags({ sel: EMPTY_SELECTION, lit }, 'item', item.id, ref);
    const hoverable = published(canvas, 'highlight_item');
    return {
      className: `abra-display-item${coordinated ? ' abra-coord' : ''}${hoverable ? ' is-hoverable' : ''}`,
      onMouseEnter: () => emit('highlight_item', `item/${item.id}`, ref),
      onMouseLeave: () => emit('dehighlight_item', `item/${item.id}`, ref),
      onClick: () => openItem(item),
    };
  };

  // SINGLE viewer: the focused item by media type, with a back-to-gallery affordance when
  // there is more than one item to return to.
  if (inSingle) {
    const item = /** @type {any} */ (opened);
    return (
      <div className="abra-display-wrap abra-display-single">
        {items.length > 1 ? (
          <button
            type="button"
            className="abra-display-back"
            onClick={() => setOpenId(null)}
            aria-label="back to gallery"
          >
            ← Gallery
          </button>
        ) : null}
        {item.type === 'map' ? (
          <MapMedia item={item} />
        ) : (
          <RasterStage key={item.id} item={item}>
            {item.type === 'document' ? <DocMedia item={item} /> : <ImageMedia item={item} />}
          </RasterStage>
        )}
      </div>
    );
  }

  // GALLERY: grid tiles, or strip (1×n horizontal scroll). A tile click opens it (above).
  return (
    <div className={`abra-display-wrap abra-display-${galleryStyle}`}>
      {items.map((item) => (
        <button type="button" key={item.id} {...itemProps(item)}>
          <ItemMedia item={item} />
          {item.caption ? <span className="abra-display-caption">{item.caption}</span> : null}
        </button>
      ))}
    </div>
  );
}
