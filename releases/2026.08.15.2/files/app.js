// SAILVu Step 1 MVP — Strait of Georgia / Gulf Islands passage planner.
const SAILVU_VERSION = "2026.08.15.2";

// Scope: Section 10.2 of the SAILVu report. Map, click-to-plan route, per-leg
// speed, ETA, and gate/pass warnings.
//
// 2026-08-01: gate warnings now show real CHS current-prediction events
// (SLACK / EXTREMA_EBB / EXTREMA_FLOOD, from data/gate_predictions.js) when
// available for the nearby station, alongside the proximity check. This is
// REAL data (pulled live from api-sine.dfo-mpo.gc.ca), but it is a static
// snapshot generated 2026-08-01 for 2026-08-01 through 2026-08-04 -- it will
// not reflect any date outside that window. Re-run
// scripts/fetch_model_data.py to refresh it.
//
// 2026-08-01: SalishSeaCast current-field data (data/current_field.js) is
// now also loaded, if present, for two things: (1) direction/speed arrows
// drawn on the map for the snapshot's time step nearest to "now", and (2)
// a leg ETA correction in renderLegs(). Both are NEAREST-NEIGHBOR
// approximations: for each leg, the current is sampled at the single grid
// point nearest the leg's midpoint, at the single available time step
// nearest the leg's start time -- there is no interpolation between grid
// points or between hourly steps, and no re-sampling partway through a
// leg. This is a reasonable engineering approximation for a first cut, not
// a validated navigation-grade current correction; each leg card says so
// explicitly. The data itself is a static pre-download snapshot (per
// Section 1.1's offline-first design) -- re-run scripts/fetch_model_data.py
// to refresh it, and it will not reflect any time outside its own window.
//
// 2026-08-01: three additions.
// (1) "Refresh data" button (refreshDataFiles()) -- re-fetches
//     data/gate_predictions.js and data/current_field.js via cache-busted
//     <script> re-injection (NOT location.reload(), so the in-progress route
//     isn't lost) after the pipeline has been re-run on disk, then
//     re-renders freshness/arrows/heat map/legs/warnings/gate popups.
//     data/gate_stations.js is NOT reloaded -- it's static/hand-edited, not
//     pipeline-regenerated.
// (2) Optional current-speed heat map (renderCurrentHeatMap()), off by
//     default, using the Leaflet.heat CDN plugin -- same snapshot slice as
//     the arrow layer. Like the base map tiles (also CDN-loaded), this one
//     optional layer needs an internet connection; everything else still
//     works fully offline once the page has loaded.
// (3) Gate station markers/popups and gate warnings now also show a
//     SalishSeaCast model sample at that station (gateStationModelHtml()),
//     alongside the existing CHS harmonic prediction -- a second, clearly
//     labeled data source, not a formal comparison (that question was closed
//     in Section 6.7 and is deliberately not reopened here). Station markers
//     are now tracked in a layer group (gateStationLayer) and rebuilt rather
//     than appended to, so a refresh doesn't duplicate them.
//
// 2026-08-02: tide (high/low water level) predictions added -- a new,
// separate data source from the gate stations above (CHS current
// predictions vs. CHS tide predictions are not necessarily the same
// stations). data/tide_stations.js (static, hand-edited, four stations:
// Patricia Bay, Point Atkinson, Nanaimo Harbour, Tumbo Channel) and
// data/tide_predictions.js (pipeline-generated, wrapped
// {generated_at/valid_from/valid_to/stations} shape from the start) mirror
// the gate-station files' own conventions. loadTideStations()/
// loadTidePredictions() are the tide analogues of
// loadGateStations()/loadGatePredictions() -- purple
// map markers (TIDE_STATION_COLOR) keep them visually distinct from the
// orange-red gate stations, blue current arrows/route, and green
// ground-track arrows. Also wired into renderDataFreshness() (a third
// freshness row) and refreshDataFiles() (a third reloaded script).
//
// 2026-08-02: "Refresh data" can now actually run the pipeline, not just
// reload files it already wrote. A browser page can never launch an
// external program by itself (a hard security boundary, not something
// workaroundable) -- so scripts/sailvu_helper_server.py, a plain-stdlib
// HTTP server listening on 127.0.0.1 only, was added as a bridge, started
// via the new scripts/start_sailvu.bat launcher (which also opens
// index.html). refreshDataFiles() now checks HELPER_BASE + "/health"
// first: if the helper is running, it POSTs to "/run-pipeline" and waits
// for the real fetch_model_data.py run to finish before reloading the data
// files below, same as before; if not, it degrades gracefully to the old
// behavior (just reload whatever's on disk) with a status message pointing
// at start_sailvu.bat. run_pipeline.bat (manual, no browser/server) is
// unchanged and still works on its own.

const MAP_CENTER = [49.05, -123.6]; // Strait of Georgia / Gulf Islands, approx.
const MAP_ZOOM = 10;
const KM_PER_NM = 1.852;
// Stride-10 sampled grid spacing (the currently-shipped data/current_field.js
// snapshot) is roughly 3-4 km; the pipeline's GRID_STRIDE was halved to 5
// on 2026-08-02 (roughly 1.5-2 km spacing once a real pipeline run
// regenerates this file -- this sandbox can't do that itself, see
// fetch_model_data.py). Beyond ~2 grid-steps' distance, the nearest sample
// is unlikely to be locally representative (e.g. inside a narrow pass/gut
// the model may not resolve well) -- skip the correction rather than apply
// a probably-wrong number. Left at 8 km for now -- still a reasonable
// "2 grid steps" bound at the OLD stride; revisit once a denser snapshot is
// actually on file, since 2 steps at the new stride would be tighter.
const CURRENT_SAMPLE_MAX_KM = 8;

// 2026-08-06: owner's request -- the map click-query popup (showPointQueryPopup())
// had NO distance cutoff at all for Current/Wind/Waves (unlike the leg-
// sampling functions above, which already reject anything beyond their own
// *_SAMPLE_MAX_KM) -- it always reported whichever point was nearest, no
// matter how far, which silently hid real coverage gaps (e.g. clicking
// somewhere the wave model has no nearby data at all still showed SOME
// number, just from a point that's actually irrelevantly far away). 2km
// flat cutoff, all three parameters, reported as "No data within 2 km."
const POINT_QUERY_MAX_KM = 2;

// 2026-08-05: analogue of CURRENT_SAMPLE_MAX_KM, for sampleWindNear()
// below. Deliberately more generous than the current-field bound: HRDPS's
// native grid spacing (~2.5km) is dense and NOT spatially thinned the way
// the ocean-current grid is (see fetch_hrdps_wind_datamart()'s docstring --
// no grid_stride there, every native point within the fetch bbox is kept),
// so this is not compensating for sparse data the way the current bound's
// own comment describes -- it is simply a sanity ceiling against a station
// falling outside WIND_BBOX's coverage entirely (e.g. if the pipeline was
// last run with the narrower default bbox rather than WIND_BBOX).
const WIND_STATION_SAMPLE_MAX_KM = 15;

// 2026-08-05: analogue of CURRENT_SAMPLE_MAX_KM, for sampleWaveNear() below
// (used by renderLegs()'s per-leg forecast reporting -- see that function's
// own comment for why wind/wave joined the current-only ETA-correction
// sample this session). WAVE_GRID_STRIDE=3 over the wave dataset's native
// ~500m spacing (see fetch_model_data.py's own comments) works out to
// roughly 1.5km actual spacing -- denser than the current field's ~3-4km
// stride-10 spacing that CURRENT_SAMPLE_MAX_KM's 8km bound was sized
// against. Same "~2 grid steps" reasoning, just at this dataset's own
// (tighter) native spacing.
const WAVE_SAMPLE_MAX_KM = 4;

// 2026-08-06: DFO-gate synthetic node -- owner's own design ("insert a
// 'node' into the model that IS the DFO current data... build a bounding
// box at the Gate, and any route, click of other interrogation of that
// 'cell' reports the DFO data"), built after a real session-long
// investigation confirmed WHY the raw model reads poorly at these 4 named
// passes: SalishSeaCast's 500m grid is 5-8x wider than Dodd Narrows itself
// (~70m at the throat, HOTSSea's own peer-reviewed paper independently
// documents the same "grid coarser than the channel" bias pattern), and no
// finer nested model exists publicly for this area (checked). CHS's own
// per-station harmonic prediction is the authoritative source AT these
// specific real, named, professionally-surveyed stations -- using it
// there, flagged plainly, beats fighting a hard grid-resolution wall.
//
// GATE_ZONE_RADIUS_KM reuses the SAME judgement call warningRadiusKm
// already makes elsewhere (gate/pass proximity warnings) for "how close
// counts as being at this gate" -- one number, not a second guess at the
// same question. Any current query landing within this radius of a gate
// station uses that station's DFO-gate node instead of the nearest raw
// model cell, REGARDLESS of whether some raw cell happens to be a few
// meters closer still (see findEnclosingGateZone()) -- the owner's own
// "bounding box," not just "one more competing point."
const GATE_ZONE_RADIUS_KM = 1.5;

// Fixed flood/ebb compass bearings ("sets"), one pair per gate station --
// NOT derived/guessed/inferred from the model. Read directly off each
// station's own official 2026 CHS current-table PDF (marees.gc.ca /
// tides.gc.ca, current-table filename pattern
// 2024_current_<station id>_public.pdf -- 2024 tables used, the most
// recent published; a station's flood/ebb axis is fixed geography, doesn't
// change year to year) -- confirmed 2026-08-05 by fetching and reading
// each PDF directly, not assumed. Each PDF's own printed "+"/"-" line
// reads "+ Flood/flot direction ### True/vraie - Ebb/jusant direction
// ### True/vraie" -- floodDeg/ebbDeg below are exactly those two numbers.
// BOTH stored explicitly, NOT derived as floodDeg+180 -- a real check
// (this session's own test harness) caught that assumption failing for
// Dodd Narrows specifically: its own PDF prints 355/155, only 200° apart,
// not a clean 180° reciprocal like the other three (45/225, 30/210,
// 80/260, all genuinely floodDeg+180). Used exactly as CHS published them
// either way, not "corrected" toward a reciprocal that seemed more
// physically tidy -- the source document is the authority here, not an
// assumption about how straight channels ought to behave.
const GATE_FLOOD_EBB_BEARINGS = {
  "07527": { floodDeg: 45,  ebbDeg: 225 }, // Active Pass -- 2024_current_07527_public.pdf
  "07438": { floodDeg: 30,  ebbDeg: 210 }, // Porlier Pass -- 2024_current_07438_public.pdf
  "07545": { floodDeg: 80,  ebbDeg: 260 }, // Gabriola Passage -- 2024_current_07545_public.pdf
  "07487": { floodDeg: 355, ebbDeg: 155 }, // Dodd Narrows -- 2024_current_07487_public.pdf (NOT floodDeg+180 -- see comment above)
};

// 2026-08-02: current-field (ambient, blue) arrows switched from a fixed
// 10px-per-knot icon to real geo-referenced vectors (buildArrowVectorLayer(),
// same as the ground-track arrows below), per the owner's request that
// vessel-speed and current-speed arrows use "the same scale (pixels per
// knot)". A fixed-pixel icon and real map geometry can only ever agree at
// one specific zoom level, since the icon doesn't grow/shrink with zoom and
// real geometry does -- so making them consistently comparable at ANY zoom
// meant picking one approach for both, and real geometry was already the
// established direction (ground-track arrows were redesigned into it last
// session specifically so they "scale with the zoom"). Both arrow types now
// share the exact same convention: shaft length = speed (kn) x
// GROUND_TRACK_STEP_HOURS x KM_PER_NM -- "how far would this speed carry
// something in one hour" -- so a 1-knot current and a 1-knot vessel speed
// always look identical, and the existing bottom-left scale-arrow legend
// (updateScaleLegend()) now applies to both layers, not just the green one.
// No min/max pixel clamp (unlike the old icon) -- consistent with how the
// ground-track arrows themselves are unclamped; the arrowhead's own
// ARROW_HEAD_MIN_KM/MAX_KM clamps (below) still keep a near-zero-length
// arrow visible as at least a small head.
// Ground-track arrows (per-leg, resultant speed/course OVER GROUND -- boat's
// through-water course/speed plus the sampled current, current-only since
// there is no wind data source) use a distinct color from the ambient
// current-field arrows (blue) and the route line (also blue) and gate
// stations (orange-red), so the three layers read as separate things at a
// glance.
const GROUND_TRACK_ARROW_COLOR = "#2e7d32";

// 2026-08-01 (this session, redesign per the owner's feedback): ground-track
// arrows are now drawn head-to-tail as a real dead-reckoning-style chain --
// each arrow's tail is the previous arrow's head, starting at the leg's
// origin waypoint -- rather than as independent icons at four fixed
// fractions of the leg's length. Each arrow represents GROUND_TRACK_STEP_HOURS
// of travel (the leg's final arrow covers whatever's left over, if the leg
// isn't an exact multiple), so a longer leg gets more, chained arrows and a
// short leg gets one short one -- not a fixed count. Current is re-sampled
// at each arrow's *actual* (possibly drifted) position and elapsed time, not
// at the original straight-line route -- this is what makes the chain bend
// away from the rhumb line when there's cross-track current, which is the
// point of the plot. The boat's own intended course (leg.courseBearing) is
// held constant across the whole leg (consistent with the rest of the app's
// single-course-per-leg model) -- only the current sample and the resulting
// position vary per step.
const GROUND_TRACK_STEP_HOURS = 1;
// Safety cap on arrows per leg (e.g. against a pathologically long leg or a
// near-zero effective speed producing a huge "hours" value) -- not expected
// to bind in normal use.
const GROUND_TRACK_MAX_ARROWS_PER_LEG = 24;

// Arrowhead proportions for the geo-referenced ground-track vectors (see
// buildArrowVectorLayer()): the head is a fraction of the shaft's own
// length, clamped in real km so a very short (slow) or very long (fast)
// arrow still reads as an arrow rather than an all-head triangle or an
// invisible sliver.
const ARROW_HEAD_LENGTH_FRACTION = 0.28;
const ARROW_HEAD_MIN_KM = 0.15;
const ARROW_HEAD_MAX_KM = 1.2;
const ARROW_HEAD_HALF_ANGLE_DEG = 18;
const ROUTE_ARROW_SHAFT_WEIGHT_PX = 3;

// 2026-08-02: current-field arrows (renderCurrentArrowsOnMap(), blue) are
// now drawn thinner-shafted than the ground-track arrows above, per the
// owner's request -- with several hundred of them on screen at once (vs. a
// handful of ground-track arrows per leg), a thinner shaft reads as less
// visually noisy/cluttered. Passed as buildArrowVectorLayer()'s sizeOpts,
// which only affects the caller that opts in -- ground-track arrows still
// use the ROUTE_ARROW_SHAFT_WEIGHT_PX/ARROW_HEAD_* defaults above,
// unchanged.
const CURRENT_ARROW_SHAFT_WEIGHT_PX = ROUTE_ARROW_SHAFT_WEIGHT_PX / 2;

// 2026-08-02 (follow-up): heads are now a FIXED size for every current-field
// arrow, not proportional to that arrow's own length -- per the owner's
// request that shaft length alone should encode current speed, with the
// head just marking "this is the tip," not doubling as another speed cue.
// This replaced an earlier CURRENT_ARROW_HEAD_SCALE (a proportional
// multiplier, like the ground-track arrows still use) entirely -- the two
// approaches aren't combined. Value chosen as double the ground-track
// arrows' own ARROW_HEAD_MIN_KM floor (the size a ground-track arrowhead
// already shrinks to for a very slow/short vector) -- consistent with the
// "2x larger" sizing the owner asked for earlier, just applied as a fixed
// baseline instead of a proportional one, and small enough not to visually
// overlap between neighboring points at the current (denser) grid spacing.
// A single constant to retune if the on-screen result needs adjusting.
const CURRENT_ARROW_FIXED_HEAD_KM = ARROW_HEAD_MIN_KM * 2;

// 2026-08-06: DFO-gate arrows -- owner's request ("I like the big 'DFO'
// arrows on the Gates, since the model isn't accurate there anyway"), after
// seeing currentlybc.com's own big-arrow-plus-speed-label treatment at
// named passes. Drawn 3x the shaft weight and a fixed, larger head vs. the
// ordinary current arrows above, in the same reddish family as the gate
// station markers themselves (#b4472a, loadGateStations()) so the color
// alone reads as "this is a gate" at a glance -- a deliberate visual
// escalation for exactly the 4 stations where a real, CHS-sourced number
// stands in for a raw model cell that's known not to resolve them well
// (see GATE_ZONE_RADIUS_KM's own header comment for the full story).
const DFO_GATE_ARROW_COLOR = "#b4472a";
// 2026-08-06: shaft weight bumped 3x -> 4x -> 8x across three rounds of
// on-screen owner feedback (most recently "Gate arrows could be 2x as wide
// as they are now," from 4x). Head size stayed at 4x (not asked to
// change). Length is untouched throughout -- same GROUND_TRACK_STEP_HOURS-
// based formula as every other current arrow (see
// renderCurrentArrowsOnMap()) -- confirmed for real against the owner's
// own screenshot (2026-08-06T06:00Z): Gabriola Passage DFO 5.12kn vs. the
// nearest raw cell's real 1.07kn, Dodd Narrows ~4.7kn vs. 0.35kn, Porlier
// Pass ~3.9kn vs. 1.42kn -- length differences this large are the real,
// already-quantified model/DFO gap this whole feature exists to surface,
// not a scale bug. Active Pass agreeing closely between the two colors is
// the OTHER half of that same real finding (the widest of the 4 passes,
// where the raw model already tracks DFO reasonably -- matches the
// owner's own earlier manually-picked r=0.59 there).
const DFO_GATE_ARROW_SHAFT_WEIGHT_PX = CURRENT_ARROW_SHAFT_WEIGHT_PX * 8;
const DFO_GATE_ARROW_FIXED_HEAD_KM = CURRENT_ARROW_FIXED_HEAD_KM * 4;

// 2026-08-06, later session (owner's request): "reduce the width of the
// Gate Arrow when zoomed out, but maintain the width at higher zoom
// levels" -- Leaflet's own `weight` option is always a FIXED pixel value,
// it doesn't auto-scale with zoom the way real map geometry (arrow
// length, station-zone boxes) does, so at a zoomed-OUT view the already-
// bold 12px DFO shaft reads as disproportionately fat relative to how
// little real distance is visible. dfoGateArrowShaftWeightPx() below
// interpolates linearly between MIN (at/below ZOOM_MIN_REF) and the
// existing DFO_GATE_ARROW_SHAFT_WEIGHT_PX itself (at/above ZOOM_MAX_REF,
// unchanged from before this change -- "maintain the width at higher
// zoom levels" means this constant stays the real ceiling, not a new
// smaller one). Reference zoom levels chosen around this app's own
// default view (MAP_ZOOM = 10): still thin at a whole-strait overview,
// full width by the time a gate/pass is genuinely zoomed into. Recomputed
// on every "zoomend" (see initMap()'s own new listener) by fully re-
// running renderCurrentArrowsOnMap() -- consistent with how
// updateScaleLegend() already recomputes on the same event, not a new
// pattern for this codebase.
const DFO_GATE_ARROW_SHAFT_WEIGHT_MIN_PX = 3;
const DFO_GATE_ARROW_ZOOM_MIN_REF = 9;
const DFO_GATE_ARROW_ZOOM_MAX_REF = 13;
function dfoGateArrowShaftWeightPx() {
  if (!map) return DFO_GATE_ARROW_SHAFT_WEIGHT_PX;
  const zoom = map.getZoom();
  if (zoom >= DFO_GATE_ARROW_ZOOM_MAX_REF) return DFO_GATE_ARROW_SHAFT_WEIGHT_PX;
  if (zoom <= DFO_GATE_ARROW_ZOOM_MIN_REF) return DFO_GATE_ARROW_SHAFT_WEIGHT_MIN_PX;
  const frac = (zoom - DFO_GATE_ARROW_ZOOM_MIN_REF) / (DFO_GATE_ARROW_ZOOM_MAX_REF - DFO_GATE_ARROW_ZOOM_MIN_REF);
  return DFO_GATE_ARROW_SHAFT_WEIGHT_MIN_PX + frac * (DFO_GATE_ARROW_SHAFT_WEIGHT_PX - DFO_GATE_ARROW_SHAFT_WEIGHT_MIN_PX);
}

// 2026-08-06: plain cartographic distance scale bar (bottom-left map
// control) -- owner's request, replacing the previous boat-speed-based
// reference arrow ("make the scale arrow for wind and currents just a 1km
// alternating black and white bar 5km long"). Fixed real-world length
// (SCALE_LEGEND_SEGMENT_KM x SCALE_LEGEND_SEGMENTS), NOT tied to boat
// speed at all now -- a standard "barber pole" ruler, so its on-screen
// pixel width genuinely varies with zoom (wide when zoomed in, narrow when
// zoomed out), same as any real map's scale bar.
const SCALE_LEGEND_SEGMENT_KM = 1;
const SCALE_LEGEND_SEGMENTS = 5;

// Route line (per-leg polyline) thickness, in px. Kept thin so it doesn't
// visually compete with the (larger, now more numerous) ground-track arrows
// drawn on top of it.
const ROUTE_LINE_WEIGHT = 1;

// Heat map intensity cap, in knots -- fixed (not normalized per-render) for
// the same reason as ARROW_PX_PER_KNOT: a given color means the same speed
// on any day's snapshot. Set a bit above the typical open-water range seen
// so far (roughly 0.1-1.5 kn) so a strong sample near a constriction doesn't
// saturate the whole scale to one color.
const HEATMAP_MAX_KN = 2.5;

// 2026-08-03: wave dot-map ceiling for colorForFraction() below. Set from
// the owner's own real data/wave_field.js (first live pipeline run this
// session): observed max hs was 0.876m in that snapshot (sheltered Gulf
// Islands/Strait of Georgia waters). 1.0m gives a little headroom above
// that observed max WITHOUT claiming to know the area's real worst-case
// wave climate -- this is a starting value from one snapshot, not a
// verified ceiling, same caveat as HEATMAP_MAX_KN's own history.
const WAVE_HEATMAP_MAX_M = 1.0;
const TIDE_HEIGHT_MAX_M = 5.0;
const WIND_CURRENT_INTERACTION_MAX_KN = 2.5;

// 2026-08-01: two earlier attempts at the heat map ("extend to fill the area
// between arrows", then "doesn't scale as I zoom in") were built on top of
// Leaflet.heat, a POINT-DENSITY estimator (think "heatmap of GPS pings"),
// not a continuous-value-field renderer. Its blobs SUM overlapping
// contributions -- so once densifyCurrentSlice() (an earlier fix, since
// removed) started feeding it many nearby interpolated points, overlapping
// blobs stacked their intensity and produced hot spots that didn't reflect
// the true interpolated speed at that location. That's what the owner
// reported next: "the heat map is not smoothly varying" -- individual red
// blobs on a field that should shade gradually. Leaflet.heat was the wrong
// tool for this job from the start (built for clustering/density, not a
// scalar field like current speed), not a tuning problem.
//
// Rebuilt from scratch as buildHeatMeshQuads()/renderCurrentHeatMap() below:
// a mesh of small, real geo-referenced quads (Leaflet polygons in actual
// lat/lon, canvas-rendered for performance), each colored DIRECTLY from its
// own bilinearly-interpolated speed via colorForFraction() -- no density
// summation anywhere, so adjacent quads' colors reflect adjacent true
// values and shade into each other smoothly. Being real map geometry (like
// the ground-track arrows), the mesh also scales with zoom natively, with
// no recompute-on-zoom hack needed -- Leaflet.heat and its whole CDN
// dependency are gone.
// 2026-08-07, real bug found by the owner ("Current heat map ... VERY
// slow"): the "~104 valid cells * 8^2 ~= 6,700 quads" estimate above was
// stale/wrong -- checked against the ACTUAL current dataset on disk
// (data/current_field.js, one time slice) and found 3,135 valid
// (all-4-corners-present) grid cells, not ~104 -- so the old
// subdivisions=8 was really building and rendering ~200,640 individual
// Leaflet polygons per frame (3,135 * 8^2), not ~6,700 -- a ~30x miss,
// almost certainly because this constant was tuned against an early,
// much smaller test bbox before the current wide-area/stride-2 fetch
// existed, and never re-checked after the bbox grew. Dropped 8 -> 2
// (3,135 * 2^2 = 12,540 quads, a ~94% cut from the old real total) --
// still gives some bilinear smoothing within each cell (unlike
// subdivisions=1, which would be one flat-colored quad per native grid
// cell with no interpolation at all), while being fast enough to render.
// Tune this directly if it's still too slow (try 1) or you want it
// smoother again (try 3-4) -- each step change roughly doubles/halves
// the quad count for a given dataset.
const HEATMAP_MESH_SUBDIVISIONS = 2;

// Named colour-lookup-table (CLUT) presets for the heat map, selectable via
// the sidebar dropdown (heatmap-gradient). Each is a list of [fraction,
// hexColor] stops (fraction = 0..1 of HEATMAP_MAX_KN, ascending), fed to
// colorForFraction() for linear RGB interpolation between the two bounding
// stops -- this is OUR OWN color mapping now (see the note above for why),
// not a plugin option, so "classic" needs its own explicit stops rather
// than relying on a library default.
const HEATMAP_GRADIENTS = {
  classic: [[0, "#2b6cb0"], [0.5, "#68d391"], [1, "#e53e3e"]],
  ocean: [[0, "#eff3ff"], [0.25, "#bdd7e7"], [0.5, "#6baed6"], [0.75, "#3182bd"], [1, "#08306b"]],
  viridis: [[0, "#440154"], [0.25, "#3b528b"], [0.5, "#21908d"], [0.75, "#5dc863"], [1, "#fde725"]],
  rainbow: [[0, "#00007f"], [0.15, "#0000ff"], [0.35, "#00ffff"], [0.5, "#7fff7f"], [0.65, "#ffff00"], [0.85, "#ff0000"], [1, "#7f0000"]],
};
const HEATMAP_GRADIENT_DEFAULT = "rainbow";

// Wave-height and wind/current samples share one screen-space dot scale.
// Keep a 4px radius through zoom 9, then double it at each closer zoom
// through the offline basemap's maximum detailed zoom (12).
function seaStateDotRadiusPx() {
  const zoomSteps = Math.max(0, Math.min(3, map.getZoom() - 9));
  return 4 * Math.pow(2, zoomSteps);
}

// Source-specific opposition dots: CIOPS is a coarse ~2 km grid and must
// grow strongly at close zooms to retain field coverage. SeaCast is much
// finer, so its growth is capped to prevent overlapping blobs. We avoid
// interpolating CIOPS because its records lack a structured water/land mask;
// interpolation could otherwise paint model values across islands.
function defaultMapTuning(product, zoom) {
  // Calibration always begins from the same raw, unblurred native-point
  // display. It must not inherit any of the source-specific sizing/blur
  // experiments that this tool exists to replace. Product and zoom remain
  // arguments because saved overrides are still indexed independently.
  return { diameter: product === "tide-height" ? 34 : 8, blur: 0, labelX: 0, labelY: 0, arrowLength: 100, arrowThickness: 1 };
}

function mapTuningStorageKey(product, zoom = map.getZoom()) {
  return product === "wind-arrows" ? "wind-arrows:all" : `${product}:${zoom}`;
}

function mapTuningEntry(product, zoom = map.getZoom()) {
  return mapDisplayTuning[mapTuningStorageKey(product, zoom)] || defaultMapTuning(product, zoom);
}

function mapTuningRadiusPx(product) {
  return mapTuningEntry(product).diameter / 2;
}

function defaultMapProductOffset(product) {
  // WaveWatch calibration: two native 0.0045-degree rows north from the
  // untouched source coordinates. Kept here—not in the data pipeline—so it
  // is visible, adjustable, and resettable with the general nudge tool.
  return product === "waves" ? { lat: 0.009, lon: 0 } : { lat: 0, lon: 0 };
}

function mapProductOffset(product) {
  return mapProductOffsets[product] || defaultMapProductOffset(product);
}

function mapProductNudgeStep(product) {
  // Half-row calibration steps make the final WaveWatch coastline alignment
  // adjustable without moving a full native source-grid row at a time.
  if (product === "waves") return { lat: 0.00225, lon: 0.00225 };
  if (product === "opposition-ciops") return { lat: 0.018, lon: 0.027 };
  return { lat: 0.005, lon: 0.0075 };
}

function offsetMapPoint(record, product) {
  const offset = mapProductOffset(product);
  return [Number(record.lat) + offset.lat, Number(record.lon) + offset.lon];
}

// QGIS/CanVec marine-water polygons, compacted into data/water_mask.js by
// scripts/build_water_mask.py. A quarter-degree spatial index keeps the
// point-in-polygon work cheap even though the source coastline is detailed.
// If the optional mask is absent, retain the old rendering behaviour.
let marineWaterMaskIndex = null;
const MARINE_MASK_BUCKET_DEG = 0.25;

function buildMarineWaterMaskIndex() {
  if (marineWaterMaskIndex) return marineWaterMaskIndex;
  const geometries = Array.isArray(window.SAILVU_WATER_MASK) ? window.SAILVU_WATER_MASK : [];
  const polygons = [];
  const buckets = new Map();
  geometries.forEach((geometry) => {
    const groups = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    (groups || []).forEach((rings) => {
      if (!rings || !rings.length || !rings[0].length) return;
      let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
      rings[0].forEach(([lon, lat]) => {
        west = Math.min(west, lon); east = Math.max(east, lon);
        south = Math.min(south, lat); north = Math.max(north, lat);
      });
      const polygonIndex = polygons.push({ rings, west, east, south, north }) - 1;
      for (let row = Math.floor(south / MARINE_MASK_BUCKET_DEG); row <= Math.floor(north / MARINE_MASK_BUCKET_DEG); row++) {
        for (let col = Math.floor(west / MARINE_MASK_BUCKET_DEG); col <= Math.floor(east / MARINE_MASK_BUCKET_DEG); col++) {
          const key = `${row},${col}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(polygonIndex);
        }
      }
    });
  });
  marineWaterMaskIndex = { available: polygons.length > 0, polygons, buckets };
  return marineWaterMaskIndex;
}

function pointInMaskRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isMarineWater(lat, lon) {
  const index = buildMarineWaterMaskIndex();
  if (!index.available) return true;
  const key = `${Math.floor(lat / MARINE_MASK_BUCKET_DEG)},${Math.floor(lon / MARINE_MASK_BUCKET_DEG)}`;
  const candidates = index.buckets.get(key) || [];
  for (const polygonIndex of candidates) {
    const polygon = index.polygons[polygonIndex];
    if (lon < polygon.west || lon > polygon.east || lat < polygon.south || lat > polygon.north) continue;
    if (!pointInMaskRing(lat, lon, polygon.rings[0])) continue;
    if (!polygon.rings.slice(1).some((hole) => pointInMaskRing(lat, lon, hole))) return true;
  }
  return false;
}
// Shared with the KIDS Passage to Nanaimo game so its route uses the same
// detailed offline coastline mask as the main map products.
window.SAILVU_IS_MARINE_WATER = isMarineWater;

// Clip a dedicated Leaflet Canvas renderer to the actual marine polygons.
// Centre-point filtering alone is insufficient for the deliberately large
// wave/opposition dots: their centres can be offshore while their painted
// pixels overlap an island. destination-in retains only pixels over water,
// without painting a land overlay that would conceal basemap detail.
function clipRendererToMarineWater(renderer) {
  const index = buildMarineWaterMaskIndex();
  if (!index.available || !renderer) return;
  const applyClip = () => {
    const canvas = typeof renderer.getContainer === "function" ? renderer.getContainer() : renderer._container;
    if (!canvas || !map || !renderer._bounds) return;
    const bounds = map.getBounds();
    const origin = renderer._bounds.min;
    const pathParts = [];
    index.polygons.forEach((polygon) => {
      if (polygon.east < bounds.getWest() || polygon.west > bounds.getEast() ||
          polygon.north < bounds.getSouth() || polygon.south > bounds.getNorth()) return;
      polygon.rings.forEach((ring) => {
        ring.forEach(([lon, lat], pointIndex) => {
          const point = map.latLngToLayerPoint([lat, lon]);
          pathParts.push(`${pointIndex === 0 ? "M" : "L"}${(point.x - origin.x).toFixed(1)},${(point.y - origin.y).toFixed(1)}`);
        });
        pathParts.push("Z");
      });
    });
    if (!pathParts.length) return;

    const clipId = renderer._sailvuWaterClipId || `sailvu-water-clip-${L.stamp(renderer)}`;
    renderer._sailvuWaterClipId = clipId;
    let svg = document.getElementById(`${clipId}-svg`);
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = `${clipId}-svg`;
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.style.position = "absolute";
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      const clip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
      clip.id = clipId;
      clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill-rule", "evenodd");
      path.setAttribute("clip-rule", "evenodd");
      clip.appendChild(path);
      defs.appendChild(clip);
      svg.appendChild(defs);
      map.getContainer().appendChild(svg);
    }
    svg.querySelector("path").setAttribute("d", pathParts.join(""));
    canvas.style.clipPath = `url(#${clipId})`;
    canvas.style.webkitClipPath = `url(#${clipId})`;
  };

  // SVG/CSS clipping happens after Canvas painting (and after its optional
  // blur filter), so Leaflet cannot erase it during a redraw.
  if (!renderer._sailvuWaterClipAttached && typeof renderer.on === "function") {
    renderer.on("update", () => requestAnimationFrame(applyClip));
    renderer._sailvuWaterClipAttached = true;
  }
  requestAnimationFrame(applyClip);
}

function interactionTuningProduct(source) {
  return source === "ciops" ? "opposition-ciops" : "opposition-seacast";
}

function interactionDotRadiusPx(source) {
  return mapTuningRadiusPx(interactionTuningProduct(source));
}

// Visually blend overlapping Sea State samples without interpolating across
// masked land cells or dropping narrow-channel points. Each field owns its
// renderer, so this filter affects only that field's Canvas.
function smoothSeaStateRenderer(renderer, radiusPx = seaStateDotRadiusPx(), explicitBlurPx = null) {
  const canvas = typeof renderer.getContainer === "function" ? renderer.getContainer() : renderer._container;
  if (!canvas) return;
  const blurPx = explicitBlurPx === null ? Math.max(1.25, radiusPx * 0.3) : Math.max(0, explicitBlurPx);
  canvas.style.filter = `blur(${blurPx}px)`;
}

let mapTuningRenderPending = false;
function selectedMapTuningProduct() {
  return document.getElementById("map-tuning-product")?.value || "waves";
}

function repaintTunedMapProduct(product) {
  if (product === "waves" && waveMapEnabled) renderWaveMap();
  if (product === interactionTuningProduct(windCurrentInteractionSource) && windCurrentInteractionEnabled) renderWindCurrentInteractionMap();
  if (product === "tide-height" && tideHeightEnabled) loadTideStations();
  if (product === "wind-arrows") {
    if (windArrowsEnabled) renderWindArrowsOnMap();
    if (windStationsEnabled) loadWindStations();
  }
}

function scheduleMapTuningRepaint(product) {
  if (mapTuningRenderPending) return;
  mapTuningRenderPending = true;
  requestAnimationFrame(() => {
    mapTuningRenderPending = false;
    repaintTunedMapProduct(product);
  });
}

function updateMapTuningPanel() {
  if (!map) return;
  const product = selectedMapTuningProduct();
  const zoom = map.getZoom();
  const entry = mapTuningEntry(product, zoom);
  const zoomEl = document.getElementById("map-tuning-zoom");
  const diameter = document.getElementById("map-tuning-diameter");
  const blur = document.getElementById("map-tuning-blur");
  const isWindArrows = product === "wind-arrows";
  if (zoomEl) zoomEl.textContent = isWindArrows ? "All zooms" : String(zoom);
  if (diameter) {
    diameter.max = product === "opposition-seacast" || product === "opposition-ciops" ? "125" : "80";
    diameter.value = String(entry.diameter);
  }
  if (blur) blur.value = String(entry.blur);
  const diameterRow = document.getElementById("map-tuning-diameter-row");
  const blurRow = document.getElementById("map-tuning-blur-row");
  const windControls = document.getElementById("map-tuning-wind-arrow-controls");
  if (diameterRow) diameterRow.hidden = isWindArrows;
  if (blurRow) blurRow.hidden = isWindArrows;
  if (windControls) windControls.hidden = !isWindArrows;
  const arrowLength = document.getElementById("map-tuning-arrow-length");
  const arrowThickness = document.getElementById("map-tuning-arrow-thickness");
  if (arrowLength) arrowLength.value = String(entry.arrowLength ?? 100);
  if (arrowThickness) arrowThickness.value = String(entry.arrowThickness ?? 1);
  const arrowLengthValue = document.getElementById("map-tuning-arrow-length-value");
  const arrowThicknessValue = document.getElementById("map-tuning-arrow-thickness-value");
  if (arrowLengthValue) arrowLengthValue.textContent = `${Number(entry.arrowLength ?? 100).toFixed(0)}%`;
  if (arrowThicknessValue) arrowThicknessValue.textContent = `${Number(entry.arrowThickness ?? 1).toFixed(2)}×`;
  const diameterValue = document.getElementById("map-tuning-diameter-value");
  const blurValue = document.getElementById("map-tuning-blur-value");
  if (diameterValue) diameterValue.textContent = `${Number(entry.diameter).toFixed(0)} px`;
  if (blurValue) blurValue.textContent = `${Number(entry.blur).toFixed(2)} px`;
  const labelOffsets = document.getElementById("map-tuning-label-offsets");
  const labelX = document.getElementById("map-tuning-label-x");
  const labelY = document.getElementById("map-tuning-label-y");
  if (labelOffsets) labelOffsets.hidden = product !== "tide-height";
  if (labelX) labelX.value = String(Number(entry.labelX) || 0);
  if (labelY) labelY.value = String(Number(entry.labelY) || 0);
  const labelXValue = document.getElementById("map-tuning-label-x-value");
  const labelYValue = document.getElementById("map-tuning-label-y-value");
  if (labelXValue) labelXValue.textContent = `${Number(entry.labelX) || 0} px`;
  if (labelYValue) labelYValue.textContent = `${Number(entry.labelY) || 0} px`;
  const offset = mapProductOffset(product);
  const step = mapProductNudgeStep(product);
  const offsetValue = document.getElementById("map-tuning-offset-value");
  if (offsetValue) offsetValue.textContent = `${(offset.lat / step.lat).toFixed(1)} rows N, ${(offset.lon / step.lon).toFixed(1)} columns E`;
  const positionRow = document.getElementById("map-tuning-position-row");
  const nudgeGrid = document.getElementById("map-tuning-nudge-grid");
  if (positionRow) positionRow.hidden = isWindArrows;
  if (nudgeGrid) nudgeGrid.hidden = isWindArrows;
  const resetZoomButton = document.getElementById("map-tuning-reset-zoom");
  if (resetZoomButton) resetZoomButton.textContent = isWindArrows ? "Reset wind-arrow size" : "Reset this zoom";
}

function saveMapTuningField(field, value) {
  const product = selectedMapTuningProduct();
  const key = mapTuningStorageKey(product);
  mapDisplayTuning[key] = { ...mapTuningEntry(product), [field]: Number(value) };
  localStorage.setItem(MAP_TUNING_STORAGE_KEY, JSON.stringify(mapDisplayTuning));
  updateMapTuningPanel();
  scheduleMapTuningRepaint(product);
}

function initializeMapDisplayTuning() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_TUNING_STORAGE_KEY) || "{}");
    if (saved && typeof saved === "object") mapDisplayTuning = saved;
  } catch (_) { mapDisplayTuning = {}; }
  // One-time owner-requested reset after the first wind-arrow calibration.
  // Limit it to this product so wave/opposition/tide work is preserved.
  const windResetKey = "sailvu.wind-arrow-tuning-global-reset.v2";
  if (!localStorage.getItem(windResetKey)) {
    Object.keys(mapDisplayTuning)
      .filter((key) => key.startsWith("wind-arrows:"))
      .forEach((key) => delete mapDisplayTuning[key]);
    localStorage.setItem(MAP_TUNING_STORAGE_KEY, JSON.stringify(mapDisplayTuning));
    localStorage.setItem(windResetKey, "done");
  }
  try {
    const savedOffsets = JSON.parse(localStorage.getItem(MAP_PRODUCT_OFFSETS_KEY) || "{}");
    if (savedOffsets && typeof savedOffsets === "object") mapProductOffsets = savedOffsets;
  } catch (_) { mapProductOffsets = {}; }
  const product = document.getElementById("map-tuning-product");
  const diameter = document.getElementById("map-tuning-diameter");
  const blur = document.getElementById("map-tuning-blur");
  const arrowLength = document.getElementById("map-tuning-arrow-length");
  const arrowThickness = document.getElementById("map-tuning-arrow-thickness");
  const labelX = document.getElementById("map-tuning-label-x");
  const labelY = document.getElementById("map-tuning-label-y");
  product?.addEventListener("change", updateMapTuningPanel);
  diameter?.addEventListener("input", (e) => saveMapTuningField("diameter", e.target.value));
  blur?.addEventListener("input", (e) => saveMapTuningField("blur", e.target.value));
  arrowLength?.addEventListener("input", (e) => saveMapTuningField("arrowLength", e.target.value));
  arrowThickness?.addEventListener("input", (e) => saveMapTuningField("arrowThickness", e.target.value));
  labelX?.addEventListener("input", (e) => saveMapTuningField("labelX", e.target.value));
  labelY?.addEventListener("input", (e) => saveMapTuningField("labelY", e.target.value));
  document.getElementById("map-tuning-reset-zoom")?.addEventListener("click", () => {
    const chosen = selectedMapTuningProduct();
    delete mapDisplayTuning[mapTuningStorageKey(chosen)];
    localStorage.setItem(MAP_TUNING_STORAGE_KEY, JSON.stringify(mapDisplayTuning));
    updateMapTuningPanel(); repaintTunedMapProduct(chosen);
  });
  document.getElementById("map-tuning-reset-product")?.addEventListener("click", () => {
    const chosen = selectedMapTuningProduct();
    Object.keys(mapDisplayTuning).filter((key) => key.startsWith(`${chosen}:`)).forEach((key) => delete mapDisplayTuning[key]);
    localStorage.setItem(MAP_TUNING_STORAGE_KEY, JSON.stringify(mapDisplayTuning));
    updateMapTuningPanel(); repaintTunedMapProduct(chosen);
  });
  const nudge = (latDirection, lonDirection) => {
    const chosen = selectedMapTuningProduct();
    const current = mapProductOffset(chosen);
    const step = mapProductNudgeStep(chosen);
    mapProductOffsets[chosen] = { lat: current.lat + latDirection * step.lat, lon: current.lon + lonDirection * step.lon };
    localStorage.setItem(MAP_PRODUCT_OFFSETS_KEY, JSON.stringify(mapProductOffsets));
    updateMapTuningPanel(); repaintTunedMapProduct(chosen);
  };
  document.getElementById("map-nudge-north")?.addEventListener("click", () => nudge(1, 0));
  document.getElementById("map-nudge-south")?.addEventListener("click", () => nudge(-1, 0));
  document.getElementById("map-nudge-east")?.addEventListener("click", () => nudge(0, 1));
  document.getElementById("map-nudge-west")?.addEventListener("click", () => nudge(0, -1));
  document.getElementById("map-nudge-reset")?.addEventListener("click", () => {
    const chosen = selectedMapTuningProduct();
    delete mapProductOffsets[chosen];
    localStorage.setItem(MAP_PRODUCT_OFFSETS_KEY, JSON.stringify(mapProductOffsets));
    updateMapTuningPanel(); repaintTunedMapProduct(chosen);
  });
  updateMapTuningPanel();
}

const SPATIAL_PREVIEW_LABELS = ["8× spacing", "4× spacing", "2× spacing", "Native"];
const SPATIAL_PREVIEW_STRIDES = [8, 4, 2, 1];

function spatialPreviewLevel() {
  return 3;
}

function spatialPreviewStride() {
  return SPATIAL_PREVIEW_STRIDES[spatialPreviewLevel()] || 1;
}

function spatialPreviewBounds() {
  return null;
}

function recordsInsideSpatialPreview(records) {
  const bounds = spatialPreviewBounds();
  if (!bounds) return records;
  return records.filter((record) => {
    const lat = Number(record.lat), lon = Number(record.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= bounds.lat_min && lat <= bounds.lat_max &&
      lon >= bounds.lon_min && lon <= bounds.lon_max;
  });
}

// Screen-preview analogue of server-side spatial subsampling. It retains
// one real model point per larger projected grid cell; it never interpolates
// new values, and the untouched full-resolution arrays remain in memory.
function spatiallySubsampleRecords(records, nativeSpacingKm) {
  records = recordsInsideSpatialPreview(records);
  const stride = spatialPreviewStride();
  if (stride <= 1 || records.length < 2) return records;
  const cellKm = nativeSpacingKm * stride;
  const kept = new Map();
  records.forEach((record) => {
    const lat = Number(record.lat), lon = Number(record.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const yKm = lat * 111.32;
    const xKm = lon * 111.32 * Math.cos(lat * Math.PI / 180);
    const source = record.source || (record.VelEastCiops_kn !== undefined ? "CIOPS-West" : "default");
    const key = `${source}:${Math.floor(xKm / cellKm)}:${Math.floor(yKm / cellKm)}`;
    if (!kept.has(key)) kept.set(key, record);
  });
  return Array.from(kept.values());
}

function structuredGridSubsample(records) {
  records = recordsInsideSpatialPreview(records);
  const stride = spatialPreviewStride();
  if (stride <= 1) return records;
  const xs = [...new Set(records.map((r) => Number(r.gridX)).filter(Number.isFinite))].sort((a, b) => a - b);
  const ys = [...new Set(records.map((r) => Number(r.gridY)).filter(Number.isFinite))].sort((a, b) => a - b);
  const keepX = new Set(xs.filter((_, index) => index % stride === 0));
  const keepY = new Set(ys.filter((_, index) => index % stride === 0));
  return records.filter((r) => keepX.has(Number(r.gridX)) && keepY.has(Number(r.gridY)));
}

function renderSpatialPreviewLayers() {
  renderCurrentArrowsOnMap();
  renderCurrentHeatMap();
  renderWindArrowsOnMap();
  renderWaveMap();
  renderWindCurrentInteractionMap();
}

// --- small color-interpolation helpers for the CLUTs above ---
function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Linear RGB interpolation between the two gradient stops bounding
// `fraction` (0-1). Stops must be sorted ascending by fraction.
function colorForFraction(stops, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (f >= stops[i][0] && f <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const t = span > 0 ? (f - lo[0]) / span : 0;
  const [r0, g0, b0] = hexToRgb(lo[1]);
  const [r1, g1, b1] = hexToRgb(hi[1]);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r},${g},${b})`;
}

// 2026-08-06, later session (owner's explicit request): "Icons for buoys,
// shore stations and gates should all be the same size" -- one shared
// radius, not three separately hand-set `radius: 6` literals that happen
// (or might stop happening) to agree. Used by loadTideStations() and
// loadWindStations()'s own plain-dot fallback marker.
//
// 2026-08-06, SAME later session, next round -- owner's follow-up request
// explicitly UNDOES the "gates match too" half of the above: "reduce the
// size of the Gate Icon to a solid circle half the size of the current
// [i.e. this constant's own, at-the-time] Icon" -- gates are also moving
// to their own future "Currents" tab (owner's own stated plan), so
// decoupling their marker size from buoy/shore-station markers now is
// consistent with that direction, not a contradiction of the invariant
// above -- that invariant still holds for tide/wind, just no longer
// includes gates. See GATE_STATION_MARKER_RADIUS_PX below,
// loadGateStations()'s own updated call site.
const STATION_MARKER_RADIUS_PX = 6;
const GATE_STATION_MARKER_RADIUS_PX = STATION_MARKER_RADIUS_PX / 2;

// 2026-08-07, owner's request: "Tide station symbols 3X larger at all
// zooms." Breaks tide stations back OUT of the "match other icons"
// invariant above (loadTideStations() previously used
// GATE_STATION_MARKER_RADIUS_PX itself, 3px, per the 2026-08-06 "same size
// as other icons" round) -- a deliberate, explicit owner request this time,
// not a regression of that earlier one. "At all zooms" needs no
// zoom-dependent interpolation the way the wind-station arrows' own recent
// zoom-scaling did (see WIND_STATION_ARROW_ZOOM_MIN/MAX's comment) --
// L.circleMarker's `radius` is already a fixed PIXEL value, constant
// across zoom levels by construction, so a plain 3x multiply on the
// existing constant is the whole change.
const TIDE_STATION_MARKER_RADIUS_PX = GATE_STATION_MARKER_RADIUS_PX * 3;

// Tide station markers use a distinct color from gate stations (orange-red),
// the route/current-field arrows (blue), and ground-track arrows (green) --
// a purple family reads as "a third, different kind of marker" at a glance.
const TIDE_STATION_COLOR = "#6b3fa0";
const TIDE_STATION_FILL_COLOR = "#b794f4";

// 2026-08-05: wind station markers (loadWindStations()) -- originally the
// same muted gold family as WIND_ARROW_COLOR below (both represent wind,
// just two different sources of it). CHANGED 2026-08-07, owner's explicit
// request ("make them... red"): same red family this app already uses for
// "something needs attention"/highlighted-current items elsewhere
// (`.ec-title-warning`/`.wp-marker-current` in style.css, the current-
// verification point picker) -- not chosen for an alarm meaning here, just
// reused as an existing, already-legible red rather than inventing a new
// one. Applies everywhere this constant is used: the map icon, its plain-
// dot fallback, and the real-observation-history graph's own line color.
const WIND_STATION_COLOR = "#000000";
const WIND_STATION_FILL_COLOR = "#000000";
// 2026-08-06, later session -- THIRD design for these markers, per the
// owner's own on-screen feedback each round:
//   1. First cut: a genuinely proportional arrow (buildArrowVectorLayer(),
//      length ~ speed, its own bounded min/max/shaft-weight/head-size
//      constants) -- deliberately DIFFERENT from the field "Wind arrows"
//      layer's fixed-shaft-+-feathers convention, reasoned through in this
//      comment's own prior text (see CHANGELOG.md/HANDOFF.md for the
//      full-length version, not reproduced here since it's now superseded).
//   2. Enlarged 4x after the first real on-screen look.
//   3. THIS round: owner explicitly asked to go "back to [the] same
//      length/knot as 'Wind arrows'" -- i.e. reuse buildWindArrowLayer()
//      (the field layer's own function) wholesale, fixed WIND_ARROW_SHAFT_KM
//      length + windFeatherCounts() speed encoding, not a bespoke
//      proportional scale -- "but 3x fatter" than the field arrows'
//      normal weight (confirmed via AskUserQuestion: reuse the field
//      layer's own style, just thicker, not a rescaled proportional
//      arrow). WIND_STATION_ARROW_WEIGHT_MULTIPLIER below is
//      buildWindArrowLayer()'s new optional weightMultiplier param (see
//      that function's own comment) -- the ONLY difference from a plain
//      field-arrow call now; length/feather geometry is 100% shared code,
//      not a second copy.
const WIND_STATION_ARROW_WEIGHT_MULTIPLIER = 3;

// 2026-08-07, owner's request history: an earlier zoom-dependent 1x-2x/
// 1.25x-5x SCALE curve (windStationArrowWeightMultiplier(),
// WIND_STATION_ARROW_ZOOM_MIN/MAX, WIND_STATION_ICON_BASE_PX,
// WIND_STATION_ICON_WIDE_ZOOM_SCALE) lived here -- DELETED this round, not
// just unused, per the owner's follow-up: "same scale as modelled winds."
// Replaced by windStationIconSizePx() below, which derives the icon's
// pixel footprint from the map's own real km-per-pixel scale at the
// station's latitude/current zoom, matching WIND_ARROW_SHAFT_KM (the
// field wind-arrow layer's own real tip-to-tail length) exactly -- so a
// station icon now grows/shrinks with zoom the same way a real geo-anchored
// arrow would, instead of following its own independent hand-tuned curve.
// WIND_STATION_ARROW_WEIGHT_MULTIPLIER (3x) is reused directly, flat (no
// zoom interpolation), as buildWindArrowIconSvg()'s new weightMultiplier
// param -- the owner's plain "3x thicker" ask, kept separate from size so
// the arrow stays legible even where the real-scale length above is small.
//
// Standard Web Mercator meters-per-pixel formula (matches Leaflet's default
// EPSG:3857 CRS, confirmed unchanged -- see initMap()'s own L.map() call,
// no custom `crs` option). viewBoxSpanFrac (0.78) is
// buildWindArrowIconSvg()'s own fixed tip(y=10)-to-tail(y=88) span as a
// fraction of its 100-unit viewBox -- kept in sync by hand if that SVG's
// own geometry ever changes.
// Floor so a station icon never shrinks below legibility at a wide zoom
// (where the real-scale math below would otherwise make it just a few px).
const WIND_STATION_ARROW_ICON_MIN_PX = 14;
function windStationIconSizePx(lat) {
  if (!map) return WIND_STATION_ARROW_ICON_MIN_PX;
  const zoom = map.getZoom();
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  const shaftPx = (WIND_ARROW_SHAFT_KM * 1000) / metersPerPixel;
  const viewBoxSpanFrac = 0.78;
  return Math.max(WIND_STATION_ARROW_ICON_MIN_PX, Math.round(shaftPx / viewBoxSpanFrac));
}

// 2026-08-02: wind arrows (renderWindArrowsOnMap()) -- first frontend
// consumer of window.WIND_FIELD_DATA (see loadWindField()); the pipeline
// side of this was built in an earlier session but nothing read the file
// yet. A distinct color from every other arrow/marker family already in
// use (blue current-field/route, green ground-track, purple tide, orange-
// red gate) -- a muted gold reads as "a fifth, different kind of thing" at
// a glance and doesn't fight the heat map's own red/blue/green stops when
// both are on at once.
const WIND_ARROW_COLOR = "#a67c00";
// Off by default (like the heat map toggle) rather than always-on (like the
// current-field arrows): the real data/wind_field.js has never actually been
// generated by a live pipeline run yet (this sandbox can't reach the ERDDAP
// server -- see HANDOFF.md), so its real row count/density is unconfirmed.
// Shipping this opt-in avoids surprising Gary's son with an unverified,
// possibly-dense new layer on by default the first time this ships.
let windArrowsEnabled = false;
let windArrowLayer = null;

// 2026-08-06: EC marine warning zone overlay (owner's "WEATHER tab"
// request) -- off by default, same convention as every other map overlay.
// See loadMarineZones()/renderMarineZonesOnMap()/renderMarineZoneLegend()
// further down for the actual logic.
let marineZonesEnabled = false;
let marineZoneLayer = null;
let marineZoneLegendControl = null;
let marineExtendedMapEnabled = false;
let marineExtendedMapLayer = null;
let marineExtendedLegendControl = null;
let marineTooltipSuppressed = false;

function setMarineTooltipSuppressed(suppressed) {
  marineTooltipSuppressed = suppressed;
  const mapElement = document.getElementById("map");
  if (mapElement) mapElement.classList.toggle("marine-tooltip-dismissed", suppressed);
}
// 2026-08-07, owner's request: "Turn off flashing Environment Canada title
// after Marine Warning box has been clicked once." Set true the first time
// #marine-zones-toggle's own change handler fires (any click -- on or off,
// since a checkbox click always changes its state, so "clicked once" and
// "changed once" are the same event here) -- see that handler's own
// comment. updateEnvironmentCanadaWarningFlag() reads this to permanently
// suppress the flash for the rest of this page load once the owner has
// interacted with the checkbox at all, on the reasoning that a click is
// itself the acknowledgment the flash exists to prompt -- a NEW warning
// appearing after that (a later "Refresh data" run) won't re-flash until
// the page is reloaded, a deliberate trade-off, not an oversight.
let marineWarningTitleAcknowledged = false;
// 2026-08-07, owner's request: "Make EC weather zone outlines visible when
// any EC tab is open" -- tracks whether the sidebar's Environment Canada
// group (Marine Synopsis / Marine Weather Warnings, index.html) is
// currently expanded, independent of marineZonesEnabled above (the actual
// checkbox). See isMarineZoneSectionOpen()/renderMarineZonesOnMap()'s own
// comments for how this drives an OUTLINE-only (no status-color fill)
// rendering of the same zone shapes when the checkbox itself is off.
let marineZoneSectionOpen = false;

// 2026-08-03: wind arrows confirmed against real data for the first time
// this session -- and at the current/ground-track arrows' own length
// convention (distance covered in GROUND_TRACK_STEP_HOURS, same as
// current arrows), they were WAY too long: wind speeds (often 10-30kn)
// are commonly an order of magnitude higher than the current speeds
// (typically 0.1-1.5kn, see HEATMAP_MAX_KN) that convention was tuned
// for, and the HRDPS wind grid is also coarser than the ocean current
// grid (~2.2-2.4km spacing at WIND_GRID_STRIDE=1, vs. the denser strided
// ocean grid) -- the combination produced arrows several grid cells long,
// overlapping their neighbors and reading as a tangled mess (reported by
// the owner as "lots of them - maybe duplicated?"). A same-session
// follow-up shortened the arrows' length convention, then the owner asked
// for standard meteorological wind barbs (pointing FROM, per WMO
// convention) instead of a scaled-down arrow -- and then, a later session,
// asked for a THIRD design after finding the WMO convention confusing on a
// boating app used alongside current arrows: a real arrow (shaft +
// arrowhead, built on the same buildArrowVectorLayer() the current arrows
// use) pointing TOWARD the direction the wind is blowing, the same
// convention as every other vector in this app, with feather-style marks
// near the TAIL (not the WMO barb's position near the tip) sloping
// backward from the direction of travel -- like real arrow fletching, per
// the owner's own bow-and-arrow framing. See buildWindArrowLayer() below.
// Unlike current arrows, the STAFF LENGTH IS STILL FIXED regardless of
// speed -- speed is encoded entirely by the number/size of feather
// marks/pennants, unchanged from the WMO-barb design's approach to that
// part, just relocated and reoriented.
//
// Wind-arrow geometry constants (all in km unless noted):
const WIND_ARROW_SHAFT_KM = 1.0; // fixed shaft length -- same for every reading, regardless of speed
const WIND_ARROW_FEATHER_SPACING_KM = 0.22; // distance between successive feather/pennant attachment points, measured outward from the tail
const WIND_ARROW_FEATHER_KM = 0.35; // a full (10kn) feather's length
const WIND_ARROW_HALF_FEATHER_KM = WIND_ARROW_FEATHER_KM * 0.5; // a half (5kn) feather's length
const WIND_ARROW_PENNANT_BASE_KM = WIND_ARROW_FEATHER_SPACING_KM * 0.6; // a pennant's (50kn) base width along the shaft
// Angle (added to the shaft's own backward/reciprocal bearing) that every
// feather/pennant sweeps toward -- real arrow fletching flares back and
// out to the side from its attachment point near the tail, not straight
// back along the shaft (which wouldn't read as a separate mark at all) and
// not perpendicular to the shaft (which is what the discarded WMO-barb
// design looked like, and what the owner flagged as "plotted wrong").
// Which exact side has no meaning, so this is a fixed stylistic choice,
// applied consistently to every reading.
const WIND_ARROW_FEATHER_ANGLE_OFFSET_DEG = 35;
const WIND_ARROW_SHAFT_WEIGHT_PX = CURRENT_ARROW_SHAFT_WEIGHT_PX;
// Below this, draws a small circle (calm) rather than a shaft with no
// feathers -- 2.5kn split the difference between "genuinely calm" and
// "5kn would round down to nothing to draw anyway."
const WIND_ARROW_CALM_KN_THRESHOLD = 2.5;
const WIND_ARROW_CALM_RADIUS_KM = 0.12;

let map;
let vancouverIslandOutlineLayer = null;
let waypoints = []; // [{lat, lon}]
let markers = [];
let legLines = []; // one Leaflet polyline per leg (not one line for the whole route), so each can carry its own hover tooltip
let gateStations = [];
let gateStationLayer = null; // layer group, so refreshDataFiles() can rebuild station markers/popups without duplicating them
let tideStations = [];
let tideStationLayer = null; // same reason as gateStationLayer above
let tideContourLayer = null;
let tideHeatMapLayer = null;
// 2026-08-06, later session (owner's request): tide stations used to be
// always-on, no toggle at all (loadTideStations() ran unconditionally) --
// off by default now, same convention as windStationsEnabled just below
// and marineZonesEnabled/waveMapEnabled/etc. Shown only once the owner
// clicks the new Tides sub-tab button (#tide-stations-toggle).
let tideStationsEnabled = false;
let tideHeightEnabled = false;
let tideHeightGradientKey = HEATMAP_GRADIENT_DEFAULT;
let tideContoursEnabled = false;
let tideHeatMapEnabled = false;
let windStations = [];
let windStationLayer = null; // same reason as gateStationLayer above
// 2026-08-06, later session (owner's request): wind station markers used
// to be always-on with no toggle -- default false (off) now, matching
// every other map overlay's own default-off convention (current/wind
// FIELD arrows are the one deliberate exception, defaulting true -- see
// salishSeaCastArrowsEnabled/ciopsArrowsEnabled's own comment just below --
// this is a brand-new toggle, not a behavior change to an existing
// default-on one, so it follows the more common pattern instead).
let windStationsEnabled = false;
let warningRadiusKm = 1.5;
let legTimings = []; // computed by renderLegs(), reused by renderWarnings()
let currentArrowLayer = null;
// 2026-08-06, later session (owner's mid-turn follow-up: "Click within the
// Gate box, calls up the graph AND the arrow"): renderCurrentArrowsOnMap()
// (DFO-gate pass, below) fills this in every time it runs -- station id ->
// {html, latlng} for that station's own arrow popup (the same text
// buildArrowVectorLayer() already binds directly to the arrow's shapes).
// loadGateStations()'s own gate-zone box click handler reads it to ALSO
// open that popup, not just the graph -- these two pieces of UI live in
// two different, independently-rebuilt layers/functions (gateStationLayer
// vs. currentArrowLayer), so a plain shared lookup (not a live layer
// reference) is the simplest way to bridge them without coupling the two
// render functions' call order or internals together.
let dfoGateArrowInfoByStationId = {};
// 2026-08-03: current-field arrows were previously always-on with no way
// to hide them, unlike the heat map and (new this session) wind arrows,
// which both have their own checkbox -- added per the owner's request
// after seeing wind + current arrows both on screen at once. Defaults to
// true so existing behavior (always shown) is unchanged until someone
// actually unchecks the new box.
//
// 2026-08-06, later session (owner's request: "Delete 'Current arrows'.
// Add SalishSeaCast Model button. Add CIOPS Model button."): the single
// currentArrowsEnabled checkbox is gone, split into one flag per real
// current-field data source, each independently toggleable -- see
// renderCurrentArrowsOnMap()'s own updated comment for how each raw
// record's vec.source ("SalishSeaCast"/"CIOPS-West", set in
// currentVectorKn()) is matched against these. Both default true, same
// reasoning as currentArrowsEnabled's own default above -- this is a UI
// reshape (one combined toggle -> two per-model ones), not a behavior
// change, so "both models shown" stays the out-of-the-box default. NOTE:
// this is deliberately separate from currentDataSource (current-source-
// select below) -- that select still drives which source(s) are LOADED
// into the pipeline at all (heat map, ETA, station tooltips); these two
// flags only filter which of the loaded sources get drawn as ARROWS.
// 2026-08-07, owner's request: "no currents by default" -- both flipped
// false (was true/true, "both models shown" out of the box). index.html's
// two checkboxes had their `checked` attribute removed to match --
// they're the actual source of truth read at DOMContentLoaded time (see
// this file's own wiring further down), these two `let`s are just their
// starting values before that wiring runs.
let salishSeaCastArrowsEnabled = false;
let ciopsArrowsEnabled = false;
// 2026-08-06, later session (owner's request: "Gate boxes off by default,
// on when button clicked"): loadGateStations() used to run unconditionally
// (station dot markers + the red gate-zone click boxes together, one
// layer group) -- off by default now, same convention as
// tideStationsEnabled/windStationsEnabled. The DFO-gate current ARROWS
// (renderCurrentArrowsOnMap()'s own separate pass, real CHS predictions at
// these same 4 stations) are tied to this SAME flag now too, not the two
// model flags above -- both are "the real gate stations' own data",
// conceptually one feature, kept together rather than adding a third
// separate toggle the owner didn't ask for. Flagged in HANDOFF.md in case
// the owner wants gate arrows split out on their own switch instead.
let gateBoxesEnabled = false;
// 2026-08-05: lets the owner pick which current MODEL is shown, instead of
// always blending SalishSeaCast (south, ~500m) and CIOPS-West (north,
// ~2km, Port Hardy extension) together -- the two sources have genuinely
// different native resolutions (confirmed against real data the same
// session the north extension started working), so mixing them on one map
// reads as an inconsistent "comb" texture at the seam. Originally a
// dedicated currentSourceMode string + its own "Current data source"
// dropdown; every consumer of loadCurrentField() (arrows, heat mesh,
// point-query, gate/route sampling) still needs to agree on one filter,
// internal consistency unchanged.
//
// 2026-08-06, later session (owner's request: "Delete the 'Current data
// source' text and box - we now have buttons"): the dropdown and its
// backing variable are gone -- salishSeaCastArrowsEnabled/ciopsArrowsEnabled
// (declared above, next to gateBoxesEnabled) are now the SOLE source of
// truth for which model(s) are shown, everywhere, not just for arrow
// visibility as originally scoped. currentSourceLabel() below derives the
// same "both"/one-source-only/"none" concept the old string used to hold,
// purely for display text -- loadCurrentField()'s own filter reads the two
// flags directly, no intermediate string needed there.
function currentSourceLabel() {
  if (salishSeaCastArrowsEnabled && ciopsArrowsEnabled) return "both";
  if (salishSeaCastArrowsEnabled) return "salishseacast";
  if (ciopsArrowsEnabled) return "ciops-west";
  return "none";
}
let groundTrackArrowLayer = null;
let heatLayer = null;
let heatMapEnabled = false;
let heatMapGradientKey = HEATMAP_GRADIENT_DEFAULT;
let windCurrentInteractionLayer = null;
let windCurrentInteractionEnabled = false;
let windCurrentInteractionGradientKey = HEATMAP_GRADIENT_DEFAULT;
let windCurrentInteractionSource = "salishseacast";
const MAP_TUNING_STORAGE_KEY = "sailvu.map-display-tuning.v2";
let mapDisplayTuning = {};
const MAP_PRODUCT_OFFSETS_KEY = "sailvu.map-product-offsets.v1";
let mapProductOffsets = {};
let waveMapLayer = null;
let waveMapEnabled = false; // off by default, same as heat map/wind arrows -- first time this layer ships
let waveMapGradientKey = HEATMAP_GRADIENT_DEFAULT; // 2026-08-03: LUT picker added alongside the smooth mesh, same gradient set as the current heat map
let landsatSstLayer = null;
let landsatSstRenderSerial = 0;
let sstMapLegendControl = null;
let sstMapLegendOffset = {x:0,y:0};
const LANDSAT_SST_SETTINGS_KEY="sailvu.landsat-sst.settings.v1";
const SST_LUT_LOWER_C=10;
const SST_LUT_UPPER_C=24;
const SST_LUT_GRADIENT="rainbow";
const sstValueRasterCache = new Map();

function saveLandsatSstSettings(){
  const value=id=>document.getElementById(id)?.value;
  try{localStorage.setItem(LANDSAT_SST_SETTINGS_KEY,JSON.stringify({scene:value("sst-scene"),slope:value("sst-slope"),offset:value("sst-offset"),opacity:value("sst-opacity"),calibrationHours:value("sst-calibration-hours")}));}catch(_){/* Settings remain usable for this session. */}
}

function loadLandsatSstSettings(){try{return JSON.parse(localStorage.getItem(LANDSAT_SST_SETTINGS_KEY)||"{}");}catch(_){return {};}}

function selectedLandsatSst() {
  const catalog = window.LANDSAT_SST_CATALOG;
  if (!Array.isArray(catalog) || !catalog.length) return window.LANDSAT_SST_DATA;
  return catalog.find(item => item.scene_id === document.getElementById("sst-scene")?.value) || catalog[0];
}

function roundedSstBounds(data) {
  return {lower:Math.floor(Number(data?.temperature_c?.min??0)),upper:Math.ceil(Number(data?.temperature_c?.max??1))};
}

function formatSstSceneDate(value, includeTime=true) {
  const date=new Date(value);if(Number.isNaN(date.getTime()))return "Unknown date";
  const day=date.toISOString().slice(0,10),time=date.toISOString().slice(11,16);
  return includeTime?`${day} ${time} UTC`:day;
}

function sstSceneResolution(data) { return data?.sensor==="AVHRR"?"1 km":"35 m"; }

function formatSstSceneLocal(value) {
  const date=new Date(value);if(Number.isNaN(date.getTime()))return "Unknown date";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Vancouver",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,timeZoneName:"short"}).formatToParts(date);
  const get=type=>parts.find(part=>part.type===type)?.value||"";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function sstSceneSensorLabel(data) { return data?.sensor==="AVHRR"?"AVHRR":"Landsat"; }
function sstSceneShortLabel(data) { return `${sstSceneSensorLabel(data)} — ${formatSstSceneLocal(data?.acquired_at)}, ${sstSceneResolution(data)}`; }

function showSstSceneDetails(data) {
  const bounds=data?.bounds||[],temperature=data?.temperature_c||{};
  showInfoPopup("SST scene details",`<p><strong>${mapPointEscape(sstSceneShortLabel(data))}</strong></p><dl><dt>Scene ID</dt><dd>${mapPointEscape(data?.scene_id||"Unknown")}</dd><dt>Source</dt><dd>${mapPointEscape(data?.source||"Unknown")}</dd><dt>Sensor / platform</dt><dd>${mapPointEscape([data?.sensor,data?.platform].filter(Boolean).join(" / ")||"Landsat thermal")}</dd><dt>Acquired</dt><dd>${mapPointEscape(formatSstSceneLocal(data?.acquired_at))} (${mapPointEscape(formatSstSceneDate(data?.acquired_at))})</dd><dt>Native resolution</dt><dd>${mapPointEscape(data?.native_resolution||sstSceneResolution(data))}</dd><dt>Displayed grid</dt><dd>${mapPointEscape(data?.display_resolution||data?.georeferencing?.method||"Native satellite grid")}</dd><dt>Coverage</dt><dd>${mapPointEscape(String(data?.valid_water_percent??"Unknown"))}% valid water</dd><dt>Scene temperature range</dt><dd>${mapPointEscape(String(temperature.min??"?"))} to ${mapPointEscape(String(temperature.max??"?"))} &deg;C</dd><dt>Map bounds</dt><dd>${mapPointEscape(JSON.stringify(bounds))}</dd><dt>Quality filtering</dt><dd>${mapPointEscape(data?.quality_filter||"Satellite quality and water masks applied")}</dd></dl><p>${mapPointEscape(data?.disclaimer||"")}</p>`);
}

function updateSstSceneSelectionUi() {
  const data=selectedLandsatSst(),picker=document.getElementById("sst-scene");
  if(!data)return;
  const label=sstSceneShortLabel(data);
  if(picker)picker.title=`Selected SST scene: ${label}`;
}

function renderSstMapLegend() {
  if(!map)return;
  if(sstMapLegendControl){map.removeControl(sstMapLegendControl);sstMapLegendControl=null;}
  if(!landsatSstLayer)return;
  const data=selectedLandsatSst(),lower=SST_LUT_LOWER_C,upper=SST_LUT_UPPER_C;
  const gradient=HEATMAP_GRADIENTS[SST_LUT_GRADIENT];
  const swatches=Array.from({length:24},(_,i)=>colorForFraction(gradient,i/23)).map(color=>`<span style="background:${color};flex:1"></span>`).join("");
  const label=sstSceneShortLabel(data);
  const Legend=L.Control.extend({options:{position:"bottomright"},onAdd(){const div=L.DomUtil.create("div","sst-map-legend");div.innerHTML=`<div class="sst-map-legend-title">Sea Surface Temperature</div><div class="sst-map-legend-scene">${mapPointEscape(label)}</div><div class="sst-map-legend-bar">${swatches}</div><div class="sst-map-legend-ticks"><span>${Math.round(lower)} &deg;C</span><span>${Math.round(upper)} &deg;C</span></div>`;div.style.transform=`translate(${sstMapLegendOffset.x}px,${sstMapLegendOffset.y}px)`;let drag=null,moved=false;div.addEventListener("pointerdown",event=>{drag={x:event.clientX,y:event.clientY,startX:sstMapLegendOffset.x,startY:sstMapLegendOffset.y};moved=false;div.setPointerCapture(event.pointerId);event.preventDefault();});div.addEventListener("pointermove",event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;sstMapLegendOffset={x:drag.startX+dx,y:drag.startY+dy};div.style.transform=`translate(${sstMapLegendOffset.x}px,${sstMapLegendOffset.y}px)`;});div.addEventListener("pointerup",()=>{drag=null;if(!moved)showSstSceneDetails(data);});div.addEventListener("pointercancel",()=>{drag=null;});L.DomEvent.disableClickPropagation(div);L.DomEvent.disableScrollPropagation(div);return div;}});
  sstMapLegendControl=new Legend();sstMapLegendControl.addTo(map);
}

function loadSstValueImage(src) {
  return new Promise((resolve, reject) => { const image=new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error("Could not load SST value raster")); image.src=src; });
}

async function loadSstValueRaster(data) {
  if (sstValueRasterCache.has(data.scene_id)) return sstValueRasterCache.get(data.scene_id);
  const promise = loadSstValueImage(data.value_image).then((image) => {
    const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(image,0,0);
    return {width:canvas.width,height:canvas.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data};
  });
  sstValueRasterCache.set(data.scene_id,promise);
  return promise;
}

async function sampleLandsatSstAt(data, lat, lon) {
  const raster=await loadSstValueRaster(data),bounds=data.bounds,encoding=data.value_encoding_c||{min:-5,max:35};
  if(!bounds||lat<bounds[0][0]||lat>bounds[1][0]||lon<bounds[0][1]||lon>bounds[1][1])return null;
  const mercatorY=value=>Math.log(Math.tan(Math.PI/4+value*Math.PI/360));
  const fractionX=(lon-bounds[0][1])/(bounds[1][1]-bounds[0][1]);
  const fractionY=(mercatorY(bounds[1][0])-mercatorY(lat))/(mercatorY(bounds[1][0])-mercatorY(bounds[0][0]));
  const x=Math.max(0,Math.min(raster.width-1,Math.floor(fractionX*raster.width)));
  const y=Math.max(0,Math.min(raster.height-1,Math.floor(fractionY*raster.height)));
  const index=(y*raster.width+x)*4;if(!raster.pixels[index+3])return null;
  return encoding.min+(raster.pixels[index]/255)*(encoding.max-encoding.min);
}

function computeSstRegression(points) {
  const n=points.length;if(n<2)return null;
  const meanX=points.reduce((sum,p)=>sum+p.x,0)/n,meanY=points.reduce((sum,p)=>sum+p.y,0)/n;
  const sxx=points.reduce((sum,p)=>sum+(p.x-meanX)**2,0);if(sxx<=0)return null;
  const sxy=points.reduce((sum,p)=>sum+(p.x-meanX)*(p.y-meanY),0);
  const slope=sxy/sxx,offset=meanY-slope*meanX;
  const residual=points.reduce((sum,p)=>sum+(p.y-(slope*p.x+offset))**2,0);
  const total=points.reduce((sum,p)=>sum+(p.y-meanY)**2,0);
  return {n,slope,offset,r2:total>0?1-residual/total:null,rmse:Math.sqrt(residual/n)};
}

async function buildSstCalibrationPoints(maxHours) {
  const entries=window.WIND_VERIFICATION_LOG_DATA?.entries||[],scene=selectedLandsatSst();
  const stations=window.WIND_STATIONS_DATA?.stations||[],limitMs=maxHours*3600000,points=[];
  if(!scene)return points;
  for(const entry of entries){
    if(typeof entry.water_temp_c!=="number")continue;
    if(entry.scene_id&&entry.scene_id!==scene.scene_id)continue;
    const station=stations.find(item=>item.id===entry.station_id)||(Number.isFinite(entry.lat)&&Number.isFinite(entry.lon)?{id:entry.station_id,name:entry.station_name||entry.station_id,lat:entry.lat,lon:entry.lon}:null);if(!station)continue;
    const obsTime=entry.obs_time_utc?new Date(entry.obs_time_utc):parseObsTimeLocal(entry.obs_time_local)||(entry.fetched_at?new Date(entry.fetched_at):null);
    if(!obsTime||!Number.isFinite(obsTime.getTime()))continue;
    if(Math.abs(new Date(scene.acquired_at).getTime()-obsTime.getTime())>limitMs)continue;
    const satellite=await sampleLandsatSstAt(scene,station.lat,station.lon);if(!Number.isFinite(satellite))continue;
    points.push({x:satellite,y:entry.water_temp_c,label:`${station.name} / ${new Date(scene.acquired_at).toLocaleDateString()}`,obsTime:obsTime.toISOString(),modelTime:scene.acquired_at,stationId:station.id});
  }
  return points;
}

async function showSstCalibrationGraph() {
  const button=document.getElementById("sst-calibration-plot"),maxHours=Math.max(1,Number(document.getElementById("sst-calibration-hours")?.value||24));
  if(button)button.disabled=true;
  try{
    const scene=selectedLandsatSst(),points=await buildSstCalibrationPoints(maxHours),regression=computeSstRegression(points),stats=computeVerificationStats(points);
    if(points.length<2||!regression){
      openGraphPopup("Measured vs satellite SST",(ctx,w,h)=>{ctx.fillStyle="#666";ctx.font="12px sans-serif";ctx.fillText(`Only ${points.length} paired historical observation${points.length===1?"":"s"} are available for this image; at least 2 are required.`,12,h/2,w-24);},`Selected scene: ${scene?.scene_id||"none"}. A pair requires an archived buoy temperature within ${maxHours} hours and a valid satellite water pixel. Absence means matching historical buoy data were unavailable, not that the image failed.`,null);
      return;
    }
    const applyId=`sst-apply-regression-${Date.now()}`;
    const overlay=openGraphPopup("Measured vs satellite SST",(ctx,w,h)=>drawScatterChart(ctx,w,h,points,{color:"#7a3db8",xUnitLabel:"Satellite SST (\u00b0C)",yUnitLabel:"Buoy SST (\u00b0C)",stats,regression}),`Each point pairs an archived buoy water temperature with this satellite acquisition within ${maxHours} hours and samples the uncalibrated satellite raster at that buoy. The fitted equation is measured = satellite &times; slope + offset.`,null,`<div><strong>Regression:</strong> measured = satellite &times; ${regression.slope.toFixed(4)} ${regression.offset<0?"&minus;":"+"} ${Math.abs(regression.offset).toFixed(3)} &deg;C; R&sup2; ${regression.r2===null?"n/a":regression.r2.toFixed(3)}; residual RMSE ${regression.rmse.toFixed(2)} &deg;C; n=${regression.n}. <button type="button" id="${applyId}">Apply regression to SST calibration</button></div>`);
    overlay?.querySelector(`#${applyId}`)?.addEventListener("click",()=>{document.getElementById("sst-slope").value=regression.slope.toFixed(4);document.getElementById("sst-offset").value=regression.offset.toFixed(3);saveLandsatSstSettings();renderLandsatSst();});
  }catch(error){showInfoPopup("SST calibration",`<p>Calibration plot could not be prepared: ${mapPointEscape(error.message)}</p>`);}
  finally{if(button)button.disabled=false;}
}

async function recolorLandsatSst(data) {
  const image=await loadSstValueImage(data.value_image), canvas=document.createElement("canvas");
  canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(image,0,0);
  const pixels=context.getImageData(0,0,canvas.width,canvas.height),bytes=pixels.data,encoding=data.value_encoding_c||{min:-5,max:35};
  const slope=Number(document.getElementById("sst-slope")?.value||1),offset=Number(document.getElementById("sst-offset")?.value||0);
  const lower=SST_LUT_LOWER_C,upper=SST_LUT_UPPER_C;
  const gradient=HEATMAP_GRADIENTS[SST_LUT_GRADIENT];
  for(let i=0;i<bytes.length;i+=4){
    if(!bytes[i+3])continue;
    const raw=encoding.min+(bytes[i]/255)*(encoding.max-encoding.min),value=raw*slope+offset;
    const rgb=colorForFraction(gradient,(value-lower)/Math.max(.01,upper-lower)).match(/\d+/g).map(Number);
    bytes[i]=rgb[0];bytes[i+1]=rgb[1];bytes[i+2]=rgb[2];bytes[i+3]=220;
  }
  context.putImageData(pixels,0,0);return canvas.toDataURL("image/png");
}

async function renderLandsatSst() {
  const serial=++landsatSstRenderSerial;
  if(landsatSstLayer){map.removeLayer(landsatSstLayer);landsatSstLayer=null;}renderMapLegend();renderSstMapLegend();
  const toggle=document.getElementById("sst-toggle"),data=selectedLandsatSst();
  if(!(data?.value_image||data?.image)||!Array.isArray(data.bounds)){
    if(toggle){toggle.checked=false;toggle.disabled=true;}
    return;
  }
  toggle.disabled=false;
  if(!toggle.checked)return;
  try{const image=data.value_image?await recolorLandsatSst(data):data.image;if(serial!==landsatSstRenderSerial)return;landsatSstLayer=L.imageOverlay(image,data.bounds,{opacity:Number(document.getElementById("sst-opacity")?.value||72)/100,interactive:false,pane:"overlayPane",className:"sst-pixelated"}).addTo(map);renderMapLegend();renderSstMapLegend();}
  catch(error){toggle.checked=false;toggle.title=`SST image could not be rendered: ${error.message}`;}
}

// 2026-08-03: caches for the fixed Y-axis domain used by the point-query
// graphs (see drawLineChart()'s opts.yDomain comment) -- computed by
// scanning every record in the whole loaded field once, not just the
// clicked point, so it's worth caching rather than rescanning on every
// popup open. Invalidated (set back to null) by refreshDataFiles() after a
// pipeline re-run, so a refreshed dataset's own real range is picked up
// rather than a stale one from page load.
let cachedCurrentSpeedRange = null;
let cachedWaveHeightRange = null;
let cachedWindSpeedRange = null; // 2026-08-04: same fixed-Y-axis caching as the two above, for showPointWindGraph()
let scaleLegendControl = null;
let dataRefreshInProgress = false;

// 2026-08-03: "Area of Operations" -- owner request after a real day on the
// water: the app's fixed BBOX (the whole Strait of Georgia/Gulf Islands
// region) is far more area than a single day's trip actually needs, and as
// current/wind grid density keeps climbing (GRID_STRIDE 10->5->3->2 across
// sessions, wind added on top), always loading high-res data for the whole
// region won't scale, especially offline. Scoped with the owner to
// frontend-only for this pass: draw a box on the map, see its bounds,
// nothing else -- NOT yet wired into the data pipeline (fetch_model_data.py
// still always uses its own fixed BBOX). That wiring is a deliberate
// follow-up, not done here.
let areaOfOperations = null; // {lat_min, lat_max, lon_min, lon_max} or null
let aoiDrawing = false; // true only while actively dragging out a new box
let aoiDrawStart = null; // {lat, lon} where the current drag began
let aoiTempRectangleLayer = null; // live-updating rectangle while dragging
let aoiRectangleLayer = null; // the finalized rectangle shown once a drag completes
// A plain click-drag on the map still fires a "click" event on mouseup if
// Leaflet doesn't consider it a real pan/drag -- without this guard,
// finishing an AOI box would ALSO drop a route waypoint at the release
// point. Set true for exactly one click right after a drag completes,
// consumed (and reset) by the very next click handler invocation.
let suppressNextMapClick = false;

// 2026-08-06: current-verification grid-point override picking -- see
// buildCurrentVerificationPoints()'s own updated comment and
// startVerificationPick()'s comment for the full story. null = not
// currently picking; a real gate station id (window.GATE_STATIONS_DATA)
// = "the next map click sets that station's override point," same
// intercept-the-map-click pattern aoiDrawing above already uses.
let verificationPickStationId = null;
let verificationPickLayer = null; // layer group of candidate grid-point dots shown only while picking
let makingGatePickActive = false;
let makingGatePosition = null;
let makingGatePositionMarker = null;
let makingGateArrivalMarker = null;
let vesselPickActive = false;
let vesselPosition = null;
let vesselPositionMarker = null;
let vesselTrackLayer = null;
let aisTargetLayer = null;
const aisTargets = new Map();
let vesselTrack = [];
let loadedVesselTrackKey = null;
let deviceGpsWatchId = null;
let signalKSocket = null;
let signalKReconnectTimer = null;
let vesselAutoReportTimer = null;
let vesselAutoReportInProgress = false;
let signalKManualDisconnect = false;
let vesselFreshnessTimer = null;
let vesselRecording = true;
let vesselVoyageId = null;
let signalKConnectionState = "disconnected";
let signalKServerBase = "";
let signalKLastMessageAt = null;
let signalKReconnectCount = 0;
const signalKSeenPaths = new Set();
const vesselValues = {};
const vesselValueTimes = {};
const vesselValueReceivedTimes = {};
const vesselValueSources = {};
const VESSEL_SETTINGS_KEY = "sailvu.vessel.settings.v1";
const VESSEL_STALE_MS = 15000;
const VESSEL_UNDERWAY_SOG_KN = 0.5;
const VESSEL_UNDERWAY_SAMPLE_MS = 10000;
const VESSEL_STATIONARY_SAMPLE_MS = 3600000;
const VESSEL_AUTO_REPORT_INTERVAL_MS = 15 * 60 * 1000;
const vesselLogic = window.SAILVU_VESSEL_LOGIC;
let mapPointPickActive = false;
let pendingMapPointPosition = null;
let pendingMapPointCapturedAt = null;
let pendingMapPointMarker = null;
let savedMapPoints = [];
let savedMapPointLayer = null;
const SAVED_MAP_POINTS_KEY = "sailvu.saved-map-points.v1";

function mapPointEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function mapPointSymbolHtml(point, displaySize = 20) {
  const symbols = {
    pin: "📍", anchor: "⚓", marina: "⛵", hazard: "⚠️", waypoint: "●",
    fishing: "🎣", fish: "🐟", whale: "🐋", restaurant: "🍽️", swimming: "🏊", store: "🛒",
  };
  if (point.symbol === "custom" && /^https?:\/\//i.test(point.customUrl || "")) {
    return `<span class="sailvu-map-symbol-inner"><img src="${mapPointEscape(point.customUrl)}" alt=""></span>`;
  }
  const fontSize = Math.max(12, Math.min(96, Number(displaySize) || 20));
  return `<span class="sailvu-map-symbol-inner" style="font-size:${fontSize}px">${symbols[point.symbol] || symbols.pin}</span>`;
}

function renderSavedMapPoints() {
  if (!map) return;
  if (savedMapPointLayer) map.removeLayer(savedMapPointLayer);
  savedMapPointLayer = L.layerGroup();
  savedMapPoints.forEach((point) => {
    const size = Math.max(12, Math.min(96, Number(point.size) || 32));
    const marker = L.marker([point.lat, point.lon], {
      icon: L.divIcon({ className: "sailvu-map-symbol", html: mapPointSymbolHtml(point, size), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    });
    const captured = point.capturedAt ? new Date(point.capturedAt).toLocaleString() : "Time not recorded";
    marker.bindPopup(`<strong>${mapPointEscape(point.name || "Map point")}</strong>${point.description ? `<p>${mapPointEscape(point.description).replace(/\n/g, "<br>")}</p>` : ""}<small>${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}<br>${mapPointEscape(captured)}</small>`);
    marker.addTo(savedMapPointLayer);
  });
  savedMapPointLayer.addTo(map);
  const list = document.getElementById("map-point-list");
  if (!list) return;
  list.innerHTML = savedMapPoints.length ? savedMapPoints.map((point) => `<div class="map-point-list-item"><span>${mapPointSymbolHtml(point)}</span><button type="button" data-map-point-show="${mapPointEscape(point.id)}">${mapPointEscape(point.name || "Unnamed point")}</button><button type="button" data-map-point-delete="${mapPointEscape(point.id)}" aria-label="Delete ${mapPointEscape(point.name || "point")}">×</button></div>`).join("") : '<span class="disclaimer">No saved map points.</span>';
}

function closeMapPointEditor() {
  mapPointPickActive = false;
  pendingMapPointPosition = null;
  pendingMapPointCapturedAt = null;
  if (pendingMapPointMarker && map) map.removeLayer(pendingMapPointMarker);
  pendingMapPointMarker = null;
  document.getElementById("map").style.cursor = "";
  document.getElementById("map-point-editor").hidden = true;
}

function beginMapPointEditor(latlng, capturedAt = new Date(), source = "map") {
  mapPointPickActive = false;
  pendingMapPointPosition = { lat: latlng.lat, lon: latlng.lng };
  pendingMapPointCapturedAt = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  document.getElementById("map").style.cursor = "";
  if (pendingMapPointMarker && map) map.removeLayer(pendingMapPointMarker);
  pendingMapPointMarker = L.marker([latlng.lat, latlng.lng], {
    interactive: false,
    zIndexOffset: 2000,
    icon: L.divIcon({ className: "pending-map-point-crosshair", html: "<span>+</span>", iconSize: [34, 34], iconAnchor: [17, 17] }),
  }).addTo(map);
  document.getElementById("map-point-position").textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  document.getElementById("map-point-time").textContent = pendingMapPointCapturedAt.toLocaleString();
  document.getElementById("map-point-editor").hidden = false;
  document.getElementById("map-point-instruction").textContent = `${source === "vessel" ? "Boat position" : "Map position"} captured at ${pendingMapPointCapturedAt.toLocaleTimeString()}. Add optional details, then save.`;
  document.getElementById("map-point-name").focus();
}

function initializeMapPointTool() {
  try { savedMapPoints = JSON.parse(localStorage.getItem(SAVED_MAP_POINTS_KEY) || "[]"); } catch (_) { savedMapPoints = []; }
  if (!Array.isArray(savedMapPoints)) savedMapPoints = [];
  renderSavedMapPoints();
  document.getElementById("map-point-add-btn")?.addEventListener("click", () => {
    const positionReceivedAt = vesselValueReceivedTimes.position ? new Date(vesselValueReceivedTimes.position).getTime() : 0;
    const hasFreshBoatPosition = vesselPosition && Number.isFinite(vesselPosition.lat) && Number.isFinite(vesselPosition.lon) && Date.now() - positionReceivedAt <= 60000;
    if (hasFreshBoatPosition) {
      beginMapPointEditor({ lat: vesselPosition.lat, lng: vesselPosition.lon }, new Date(), "vessel");
      return;
    }
    closeMapPointEditor();
    mapPointPickActive = true;
    document.getElementById("map").style.cursor = "crosshair";
    document.getElementById("map-point-instruction").textContent = "Crosshair active — click the map to capture the location and time.";
  });
  const symbol = document.getElementById("map-point-symbol");
  symbol?.addEventListener("change", () => { document.getElementById("map-point-custom-row").hidden = symbol.value !== "custom"; });
  const size = document.getElementById("map-point-size");
  size?.addEventListener("input", () => { document.getElementById("map-point-size-value").textContent = `${size.value} px`; });
  document.getElementById("map-point-cancel-btn")?.addEventListener("click", closeMapPointEditor);
  document.getElementById("map-point-save-btn")?.addEventListener("click", () => {
    if (!pendingMapPointPosition) return;
    const customUrl = document.getElementById("map-point-custom-url").value.trim();
    if (symbol.value === "custom" && !/^https?:\/\//i.test(customUrl)) { alert("Enter a complete http:// or https:// image URL."); return; }
    savedMapPoints.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...pendingMapPointPosition, capturedAt: (pendingMapPointCapturedAt || new Date()).toISOString(), symbol: symbol.value, customUrl, size: Number(size.value), name: document.getElementById("map-point-name").value.trim(), description: document.getElementById("map-point-description").value.trim() });
    localStorage.setItem(SAVED_MAP_POINTS_KEY, JSON.stringify(savedMapPoints));
    document.getElementById("map-point-name").value = ""; document.getElementById("map-point-description").value = "";
    closeMapPointEditor(); renderSavedMapPoints();
    document.getElementById("map-point-instruction").textContent = "Point saved. Add another or click a symbol on the map for details.";
  });
  document.getElementById("map-point-list")?.addEventListener("click", (event) => {
    const showId = event.target.dataset.mapPointShow;
    const deleteId = event.target.dataset.mapPointDelete;
    if (showId) { const point = savedMapPoints.find((p) => p.id === showId); if (point) map.setView([point.lat, point.lon], Math.max(map.getZoom(), 12)); }
    if (deleteId) { const point = savedMapPoints.find((p) => p.id === deleteId); if (point && confirm(`Delete “${point.name || "Unnamed point"}”?`)) { savedMapPoints = savedMapPoints.filter((p) => p.id !== deleteId); localStorage.setItem(SAVED_MAP_POINTS_KEY, JSON.stringify(savedMapPoints)); renderSavedMapPoints(); } }
  });
}

function vesselDayKey(date = new Date()) {
  return vesselLogic.dayKey(date);
}

function saveVesselSettings(changes) {
  try {
    const current = JSON.parse(localStorage.getItem(VESSEL_SETTINGS_KEY) || "{}");
    localStorage.setItem(VESSEL_SETTINGS_KEY, JSON.stringify({ ...current, ...changes }));
  } catch (_) {}
}

function savedVesselLogKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith("sailvu.vessel.track.")) keys.push(key);
  }
  return keys.sort().reverse();
}

function readSavedVesselLog(key) {
  try { return vesselLogic.validRecords(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch (_) { return []; }
}

async function renderVesselStorage() {
  const list = document.getElementById("vessel-saved-logs"), summary = document.getElementById("vessel-storage-summary");
  if (!list || !summary) return;
  const keys = savedVesselLogKeys(); let bytes = 0;
  const rows = keys.map((key) => { const raw = localStorage.getItem(key) || ""; bytes += new Blob([raw]).size; return { key, day: key.split(".").pop(), count: readSavedVesselLog(key).length }; });
  let quotaText = "";
  try { const estimate = await navigator.storage?.estimate?.(); if (estimate?.quota) quotaText = `; browser storage ${((estimate.usage || 0) / 1048576).toFixed(1)} of ${(estimate.quota / 1048576).toFixed(0)} MB used`; } catch (_) {}
  summary.textContent = `${rows.length} saved day(s), voyage logs ${(bytes / 1048576).toFixed(2)} MB${quotaText}. Nothing is deleted automatically.`;
  list.innerHTML = rows.map((r) => `<div class="vessel-saved-log"><span>${r.day} — ${r.count} records${r.key === loadedVesselTrackKey ? " (today)" : ""}</span><button type="button" data-log-export="${r.key}">Backup</button><button type="button" data-log-delete="${r.key}" ${r.key === loadedVesselTrackKey ? "disabled title=\"Use Clear today's track for today\"" : ""}>Delete</button></div>`).join("") || "No saved logs.";
}

function backupSavedVesselLog(key) {
  const records = readSavedVesselLog(key), day = key.split(".").pop();
  const backup = { schema: "sailvu.voyage-log.v1", exportedAt: new Date().toISOString(), dayKey: key, records };
  downloadVesselFile(JSON.stringify(backup, null, 2), "application/json", `${day}-sailvu-voyage-backup.json`);
}

function vesselReportDiagnostics() {
  return {
    connection: { state: signalKConnectionState, server: signalKServerBase, lastMessageAt: signalKLastMessageAt, reconnectCount: signalKReconnectCount },
    pathsSeen: [...signalKSeenPaths].sort(), instrumentSources: vesselValueSources,
    instrumentTimestamps: vesselValueTimes, latestInstrumentValues: vesselValues,
    sampling: { underwaySogKn: VESSEL_UNDERWAY_SOG_KN, underwayIntervalSeconds: VESSEL_UNDERWAY_SAMPLE_MS / 1000, stationaryIntervalMinutes: VESSEL_STATIONARY_SAMPLE_MS / 60000 },
  };
}

async function archiveSavedVoyageReports() {
  if (vesselAutoReportInProgress) return;
  const status = document.getElementById("vessel-auto-report-status");
  vesselAutoReportInProgress = true;
  try {
    const keys = savedVesselLogKeys();
    let latest = null;
    for (const key of keys) {
      const records = readSavedVesselLog(key);
      if (!records.length) continue;
      const response = await fetchWithTimeout(`${HELPER_BASE}/archive-voyage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: key.split(".").pop(), records, diagnostics: vesselReportDiagnostics() }),
      }, 30000);
      if (!response.ok) throw new Error(`helper returned ${response.status}`);
      latest = await response.json();
    }
    if (status) status.textContent = latest
      ? `Automatic report saved: ${latest.filename} (${latest.records} records). Updated every 15 minutes; nothing is deleted.`
      : "Automatic reports are ready; the first ZIP will be created after instrument data arrive.";
  } catch (_) {
    if (status) status.textContent = "Automatic report is waiting for the SAILVu helper. Leave SAILVu running; it will retry in 15 minutes.";
  } finally { vesselAutoReportInProgress = false; }
}

function setVesselStatus(message, state = "") {
  const el = document.getElementById("vessel-status");
  if (!el) return;
  el.textContent = message;
  el.className = `vessel-status ${state}`.trim();
}

function renderSignalKDiagnostics() {
  const el = document.getElementById("signalk-diagnostics");
  if (!el) return;
  const lastMessage = signalKLastMessageAt ? `${new Date(signalKLastMessageAt).toLocaleTimeString()} (${Math.max(0, Math.round((Date.now() - new Date(signalKLastMessageAt).getTime()) / 1000))} s ago)` : "none";
  const sources = [...new Set(Object.values(vesselValueSources).filter(Boolean))].join(", ") || "not reported";
  const paths = [...signalKSeenPaths].sort();
  el.innerHTML = `<div class="vessel-diagnostics-grid"><span>State</span><strong>${mapPointEscape(signalKConnectionState)}</strong><span>Server</span><span>${mapPointEscape(signalKServerBase || "--")}</span><span>Last message</span><span>${mapPointEscape(lastMessage)}</span><span>Reconnects</span><span>${signalKReconnectCount}</span><span>Sources</span><span>${mapPointEscape(sources)}</span><span>Paths seen</span><span>${paths.length}</span></div>${paths.length ? `<ul class="vessel-diagnostics-paths">${paths.map((p) => `<li>${mapPointEscape(p)}</li>`).join("")}</ul>` : ""}`;
}

function renderVesselInstruments() {
  const set = (name, value) => {
    const el = document.querySelector(`[data-vessel-value="${name}"]`);
    if (el) el.textContent = value;
  };
  const setStale = (name, stale) => document.querySelector(`[data-vessel-value="${name}"]`)?.classList.toggle("stale", stale);
  const stale = (name) => vesselValueReceivedTimes[name] && Date.now() - new Date(vesselValueReceivedTimes[name]).getTime() > VESSEL_STALE_MS;
  set("position", vesselPosition ? `${vesselPosition.lat.toFixed(5)}, ${vesselPosition.lon.toFixed(5)}` : "--");
  set("sog", Number.isFinite(vesselValues.sog) ? `${vesselValues.sog.toFixed(1)} kn` : "--");
  set("cog", Number.isFinite(vesselValues.cog) ? `${Math.round(vesselValues.cog)}°` : "--");
  set("heading", Number.isFinite(vesselValues.heading) ? `${Math.round(vesselValues.heading)}° M` : "--");
  set("stw", Number.isFinite(vesselValues.stw) ? `${vesselValues.stw.toFixed(1)} kn` : "--");
  const wind = Number.isFinite(vesselValues.aws) ? `${vesselValues.aws.toFixed(1)} kn` : "--";
  const awa = Number.isFinite(vesselValues.awa) ? `${Math.abs(Math.round(vesselValues.awa))}° ${vesselValues.awa < 0 ? "P" : "S"}` : "";
  set("awa", awa ? `${wind} / ${awa}` : wind);
  set("depth", Number.isFinite(vesselValues.depth) ? `${vesselValues.depth.toFixed(1)} m` : "--");
  set("waterTemp", Number.isFinite(vesselValues.waterTemp) ? `${vesselValues.waterTemp.toFixed(1)} °C` : "--");
  const times = Object.values(vesselValueReceivedTimes).map((t) => new Date(t).getTime()).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : NaN;
  set("age", Number.isFinite(newest) ? `${Math.max(0, Math.round((Date.now() - newest) / 1000))} s` : "--");
  ["position", "sog", "cog", "heading", "stw", "awa", "depth", "waterTemp"].forEach((name) => setStale(name, stale(name)));
  renderVesselInstrumentDetails();
}

function renderVesselInstrumentDetails() {
  const table = document.getElementById("vessel-instrument-detail-table"), warning = document.getElementById("vessel-quality-warning");
  if (!table || !warning) return;
  const now = Date.now();
  const rows = [
    ["Position", "position", vesselPosition ? `${vesselPosition.lat.toFixed(5)}, ${vesselPosition.lon.toFixed(5)}` : "--"],
    ["SOG", "sog", Number.isFinite(vesselValues.sog) ? `${vesselValues.sog.toFixed(1)} kn` : "--"],
    ["COG", "cog", Number.isFinite(vesselValues.cog) ? `${Math.round(vesselValues.cog)}°` : "--"],
    ["Heading", "heading", Number.isFinite(vesselValues.heading) ? `${Math.round(vesselValues.heading)}° M` : "--"],
    ["STW", "stw", Number.isFinite(vesselValues.stw) ? `${vesselValues.stw.toFixed(1)} kn` : "--"],
    ["Wind", "awa", Number.isFinite(vesselValues.aws) ? `${vesselValues.aws.toFixed(1)} kn` : "--"],
    ["Depth", "depth", Number.isFinite(vesselValues.depth) ? `${vesselValues.depth.toFixed(1)} m` : "--"],
    ["Water", "waterTemp", Number.isFinite(vesselValues.waterTemp) ? `${vesselValues.waterTemp.toFixed(1)} °C` : "--"],
  ].map(([label, key, value]) => {
    const timestamp = vesselValueTimes[key], receivedTimestamp = vesselValueReceivedTimes[key];
    const age = receivedTimestamp ? Math.max(0, Math.round((now - new Date(receivedTimestamp).getTime()) / 1000)) : null;
    const limits = key === "waterTemp" ? { min: -2, max: 35 } : key === "depth" ? { min: 0 } : {};
    const quality = vesselLogic.quality(receivedTimestamp, vesselValues[key], { nowMs: now, staleMs: VESSEL_STALE_MS, ...limits });
    const clockSkew = vesselLogic.clockSkewMs(timestamp, receivedTimestamp);
    return { label, key, value, quality, age, timestamp, clockSkew, source: vesselValueSources[key] || "--" };
  });
  table.innerHTML = `<div class="vessel-instrument-row"><strong>Value</strong><strong>Status</strong><strong>Age</strong><strong>Source / time</strong></div>${rows.map((r) => `<div class="vessel-instrument-row"><span>${r.label}: ${mapPointEscape(r.value)}</span><span class="quality-${r.quality}">${r.quality}</span><span>${r.age === null ? "--" : `${r.age} s`}</span><span>${mapPointEscape(r.source)}${r.timestamp ? ` / ${new Date(r.timestamp).toLocaleTimeString()}` : ""}</span></div>`).join("")}`;
  const warnings = rows.filter((r) => r.quality === "warning").map((r) => `${r.label} ${r.value} is outside SAILVu's plausibility range; compare with the vessel instrument.`);
  if (rows.some((r) => Number.isFinite(r.clockSkew) && r.clockSkew > 300000)) warnings.push("Signal K timestamps disagree with this device by more than 5 minutes. Live freshness uses arrival time; check the Signal K server clock.");
  warning.hidden = !warnings.length; warning.textContent = warnings.join(" ");
}

function loadTodayVesselTrack() {
  if (loadedVesselTrackKey && loadedVesselTrackKey !== vesselDayKey() && vesselTrack.length) saveDailyVesselGeoJSON(loadedVesselTrackKey, vesselTrack);
  loadedVesselTrackKey = vesselDayKey();
  try { vesselTrack = vesselLogic.validRecords(JSON.parse(localStorage.getItem(loadedVesselTrackKey) || "[]")); }
  catch (_) { vesselTrack = []; }
  if (!Array.isArray(vesselTrack)) vesselTrack = [];
  renderVesselTrack();
  renderVesselStorage();
}

function renderVesselTrack() {
  if (!map) return;
  if (vesselTrackLayer) map.removeLayer(vesselTrackLayer);
  const allTracks = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith("sailvu.voyage.") && key !== loadedVesselTrackKey) allTracks.push(vesselLogic.validRecords(JSON.parse(localStorage.getItem(key) || "[]")));
    }
  } catch (_) {}
  allTracks.push(vesselTrack);
  const trackSegments = allTracks.filter((records) => records.length > 1).map((records) => records.map((p) => [p.lat, p.lon]));
  if (trackSegments.length && document.getElementById("vessel-track-toggle")?.checked !== false) {
    vesselTrackLayer = L.polyline(trackSegments, {
      color: "#1261a0", weight: 3, opacity: 0.8,
    }).addTo(map);
  } else vesselTrackLayer = null;
  const summary = document.getElementById("vessel-log-summary");
  if (summary) {
    if (!vesselTrack.length) summary.textContent = "Today's voyage log is empty.";
    else {
      const first = vesselTrack[0], last = vesselTrack[vesselTrack.length - 1];
      const distanceNm = vesselTrack.slice(1).reduce((sum, p, i) => sum + haversineKm(vesselTrack[i], p) / 1.852, 0);
      const stats = vesselLogic.voyageStats(vesselTrack);
      const speedText = stats.speed ? `, SOG avg ${stats.speed.average.toFixed(1)} / max ${stats.speed.max.toFixed(1)} kn` : "";
      const depthText = stats.depth ? `, depth ${stats.depth.min.toFixed(1)}–${stats.depth.max.toFixed(1)} m` : "";
      const windText = stats.wind ? `, apparent wind ${stats.wind.min.toFixed(1)}–${stats.wind.max.toFixed(1)} kn` : "";
      summary.textContent = `${vesselRecording ? "Recording" : "Paused"}: ${vesselTrack.length} records from ${new Date(first.time).toLocaleTimeString()} to ${new Date(last.time).toLocaleTimeString()} (${vesselLogic.formatDuration(stats.durationMs)}) — ${distanceNm.toFixed(2)} NM${speedText}${depthText}${windText}.`;
    }
  }
}

function renderAisTargets() {
  if (!map) return;
  if (aisTargetLayer) map.removeLayer(aisTargetLayer);
  aisTargetLayer = L.layerGroup();
  if (!document.getElementById("ais-overlay-toggle")?.checked || !vesselPosition) { aisTargetLayer.addTo(map); return; }
  const now = Date.now();
  aisTargets.forEach((target, context) => {
    if (now - target.receivedAt > 300000) { aisTargets.delete(context); return; }
    if (!target.position) return;
    const rangeNm = haversineKm(vesselPosition, target.position) / 1.852;
    if (rangeNm > 10) return;
    const marker = L.circleMarker([target.position.lat, target.position.lon], { radius: 6, color: "#7b1fa2", weight: 2, fillColor: "#fff", fillOpacity: 0.9 });
    const name = target.name || target.mmsi || "AIS target";
    marker.bindTooltip(`${mapPointEscape(name)} · ${rangeNm.toFixed(1)} NM`, { direction: "top" });
    marker.bindPopup(`<strong>${mapPointEscape(name)}</strong><br>MMSI ${mapPointEscape(target.mmsi || "--")}<br>Range ${rangeNm.toFixed(1)} NM<br>SOG ${Number.isFinite(target.sog) ? `${target.sog.toFixed(1)} kn` : "--"}<br>COG ${Number.isFinite(target.cog) ? `${Math.round(target.cog)}° T` : "--"}<br><small>Situational awareness only—not collision avoidance.</small>`);
    marker.addTo(aisTargetLayer);
  });
  aisTargetLayer.addTo(map);
}

function handleAisDelta(delta) {
  const context = String(delta.context || "");
  if (!context.startsWith("vessels.") || context === "vessels.self") return false;
  const target = aisTargets.get(context) || { mmsi: context.match(/(\d{9})/)?.[1] || "", receivedAt: Date.now() };
  (delta.updates || []).forEach((update) => (update.values || []).forEach(({ path, value }) => {
    if (path === "navigation.position" && value) target.position = { lat: Number(value.latitude), lon: Number(value.longitude) };
    else if (path === "navigation.speedOverGround") target.sog = vesselLogic.msToKn(value);
    else if (path === "navigation.courseOverGroundTrue") target.cog = (vesselLogic.radToDeg(value) + 360) % 360;
    else if (path === "name") target.name = String(value || "");
  }));
  target.receivedAt = Date.now(); aisTargets.set(context, target); renderAisTargets(); return true;
}

function appendVesselTrack(position) {
  if (!vesselRecording) return;
  if (loadedVesselTrackKey !== vesselDayKey()) {
    archiveSavedVoyageReports();
    loadTodayVesselTrack();
    vesselVoyageId = vesselTrack.find((p) => p.voyageId)?.voyageId || new Date().toISOString();
    setVesselStatus("Automatic recording started a new daily voyage log after midnight.", "connected");
  }
  const last = vesselTrack[vesselTrack.length - 1];
  const now = Date.now();
  const sogAgeMs = vesselValueReceivedTimes.sog ? now - new Date(vesselValueReceivedTimes.sog).getTime() : Infinity;
  const samplingMode = vesselLogic.samplingMode(Number(vesselValues.sog), sogAgeMs, VESSEL_STALE_MS, VESSEL_UNDERWAY_SOG_KN);
  // Record immediately on a stationary/underway transition, otherwise use a
  // fixed interval. Swinging at anchor does not create extra points merely
  // because the GPS position moves several metres.
  if (!vesselLogic.shouldRecord(last, samplingMode, now, VESSEL_UNDERWAY_SAMPLE_MS, VESSEL_STATIONARY_SAMPLE_MS)) return;
  vesselTrack.push({
    voyageId: vesselVoyageId, samplingMode, lat: position.lat, lon: position.lon,
    time: position.time || new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), source: position.source,
    sog: vesselValues.sog, cog: vesselValues.cog, headingMagnetic: vesselValues.heading,
    stw: vesselValues.stw, apparentWindSpeed: vesselValues.aws, apparentWindAngle: vesselValues.awa,
    depthBelowTransducer: vesselValues.depth, waterTemperatureC: vesselValues.waterTemp,
  });
  if (vesselTrack.length > 10000) vesselTrack = vesselTrack.slice(-10000);
  try { localStorage.setItem(loadedVesselTrackKey, JSON.stringify(vesselTrack)); saveDailyVesselGeoJSON(loadedVesselTrackKey, vesselTrack); }
  catch (error) {
    vesselTrack.pop();
    setVesselStatus(`Voyage log could not be saved: ${error.message}. Export or clear old browser data.`, "error");
  }
  renderVesselTrack();
}

function updateMakingGateFromVessel() {
  const station = selectedMakingGate();
  if (!station || !vesselPosition) return;
  const distanceNm = haversineKm(vesselPosition, station) / 1.852;
  const liveSog = Number(vesselValues.sog);
  const sogAgeMs = vesselValueReceivedTimes.sog ? Date.now() - new Date(vesselValueReceivedTimes.sog).getTime() : Infinity;
  const usesLiveSog = Number.isFinite(liveSog) && liveSog > 0.1 && sogAgeMs <= VESSEL_STALE_MS;
  const speedKn = Math.max(0.1, usesLiveSog ? liveSog : Number(document.getElementById("speed")?.value) || 5);
  const travelHours = distanceNm / speedKn;
  const arrival = new Date(Date.now() + travelHours * 3600000);
  const status = document.getElementById("making-gate-status");
  if (status) status.innerHTML = `<strong>Advisory only — not for navigation.</strong> <strong>${distanceNm.toFixed(1)} NM</strong> to ${station.name} at ${speedKn.toFixed(1)} kn (${usesLiveSog ? "fresh live SOG" : "entered boat speed"}) — arrival ${arrival.toLocaleString()} (${travelHours.toFixed(1)} h).`;
  makingGateArrivalMarker = { stationId: station.id, x: arrival, label: "Boat arrival", color: "#2e7d32", now: true };
  refreshOpenGraphPopup();
}

function setVesselPosition(lat, lon, source = "manual", extra = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  vesselPosition = { lat, lon, source, time: extra.time || new Date().toISOString() };
  vesselValueTimes.position = vesselPosition.time;
  vesselValueReceivedTimes.position = extra.receivedAt || new Date().toISOString();
  makingGatePosition = { lat, lon };
  Object.assign(vesselValues, extra);
  if (vesselPositionMarker) map.removeLayer(vesselPositionMarker);
  vesselPositionMarker = L.circleMarker([lat, lon], {
    radius: 8, color: "#1261a0", weight: 3, fillColor: "#fff", fillOpacity: 1,
  }).addTo(map).bindTooltip(`Vessel (${source})`, { direction: "top" });
  makingGatePositionMarker = vesselPositionMarker;
  appendVesselTrack(vesselPosition);
  renderAisTargets();
  renderVesselInstruments();
  setVesselStatus(`${source === "manual" ? "Manual" : source} fix received ${new Date(vesselPosition.time).toLocaleTimeString()}.`, "connected");
  updateMakingGateFromVessel();
}

function signalKWebSocketUrl(base, token) {
  const url = new URL(base.includes("://") ? base : `http://${base}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/signalk/v1/stream";
  url.search = "subscribe=none";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function handleSignalKDelta(delta) {
  if (handleAisDelta(delta)) return;
  const { msToKn, radToDeg, kelvinToC } = vesselLogic;
  let positionUpdate = null;
  signalKLastMessageAt = new Date().toISOString();
  (delta.updates || []).forEach((update) => (update.values || []).forEach(({ path, value }) => {
    const timestamp = update.timestamp || new Date().toISOString();
    const receivedTimestamp = new Date().toISOString();
    const source = update.$source || update.source?.label || (typeof update.source === "string" ? update.source : "");
    signalKSeenPaths.add(path);
    const sourceKey = ({
      "navigation.position": "position", "navigation.speedOverGround": "sog", "navigation.courseOverGroundTrue": "cog",
      "navigation.headingMagnetic": "heading", "navigation.speedThroughWater": "stw",
      "environment.wind.speedApparent": "awa", "environment.wind.angleApparent": "awa",
      "environment.depth.belowTransducer": "depth", "environment.water.temperature": "waterTemp",
    })[path];
    if (sourceKey && source) vesselValueSources[sourceKey] = source;
    if (sourceKey) vesselValueReceivedTimes[sourceKey] = receivedTimestamp;
    if (path === "navigation.position" && value) positionUpdate = { lat: Number(value.latitude), lon: Number(value.longitude), time: timestamp };
    else if (path === "navigation.speedOverGround") { vesselValues.sog = msToKn(value); vesselValueTimes.sog = timestamp; }
    else if (path === "navigation.courseOverGroundTrue") { vesselValues.cog = (radToDeg(value) + 360) % 360; vesselValueTimes.cog = timestamp; }
    else if (path === "navigation.headingMagnetic") { vesselValues.heading = (radToDeg(value) + 360) % 360; vesselValueTimes.heading = timestamp; }
    else if (path === "navigation.speedThroughWater") { vesselValues.stw = msToKn(value); vesselValueTimes.stw = timestamp; }
    else if (path === "environment.wind.speedApparent") { vesselValues.aws = msToKn(value); vesselValueTimes.awa = timestamp; }
    else if (path === "environment.wind.angleApparent") { vesselValues.awa = radToDeg(value); vesselValueTimes.awa = timestamp; }
    else if (path === "environment.wind.speedTrueWater") vesselValues.tws = msToKn(value);
    else if (path === "environment.wind.angleTrueWater") vesselValues.twa = radToDeg(value);
    else if (path === "environment.depth.belowTransducer") { vesselValues.depth = Number(value); vesselValueTimes.depth = timestamp; }
    else if (path === "environment.water.temperature") { vesselValues.waterTemp = kelvinToC(value); vesselValueTimes.waterTemp = timestamp; }
  }));
  // Apply the position after the rest of this delta so its saved voyage-log
  // record contains the newest instrument values even when position appears
  // first in the Signal K values array.
  if (positionUpdate) setVesselPosition(positionUpdate.lat, positionUpdate.lon, "Signal K", { time: positionUpdate.time, receivedAt: vesselValueReceivedTimes.position });
  renderVesselInstruments();
  renderSignalKDiagnostics();
  updateMakingGateFromVessel();
}

function connectSignalK() {
  const button = document.getElementById("signalk-connect-btn");
  if (signalKSocket) {
    signalKManualDisconnect = true; clearTimeout(signalKReconnectTimer); signalKSocket.close(); signalKSocket = null;
    button.textContent = "Connect Signal K";
    signalKConnectionState = "disconnected by user"; renderSignalKDiagnostics(); setVesselStatus("Signal K disconnected."); return;
  }
  const base = document.getElementById("signalk-url").value.trim();
  const token = document.getElementById("signalk-token").value.trim();
  try {
    signalKManualDisconnect = false;
    signalKServerBase = base; signalKConnectionState = "connecting"; renderSignalKDiagnostics();
    signalKSocket = new WebSocket(signalKWebSocketUrl(base, token));
    setVesselStatus(`Connecting to ${base}…`);
    signalKSocket.onopen = () => {
      signalKConnectionState = "connected"; signalKReconnectCount = 0; renderSignalKDiagnostics();
      button.textContent = "Disconnect Signal K";
      setVesselStatus(`Connected to Signal K at ${base}; waiting for vessel data…`, "connected");
      signalKSocket.send(JSON.stringify({ context: "vessels.self", subscribe: [
        { path: "navigation.*", period: 1000 }, { path: "environment.wind.*", period: 1000 }, { path: "environment.depth.*", period: 2000 }, { path: "environment.water.temperature", period: 5000 },
      ] }));
      if (document.getElementById("ais-overlay-toggle")?.checked) signalKSocket.send(JSON.stringify({ context: "vessels.*", subscribe: [
        { path: "name", period: 60000 }, { path: "navigation.position", period: 5000 }, { path: "navigation.speedOverGround", period: 5000 }, { path: "navigation.courseOverGroundTrue", period: 5000 },
      ] }));
    };
    signalKSocket.onmessage = (event) => { try { handleSignalKDelta(JSON.parse(event.data)); } catch (_) {} };
    signalKSocket.onerror = () => { signalKConnectionState = "connection error"; renderSignalKDiagnostics(); setVesselStatus(`Could not connect to ${base}. Check boat Wi-Fi, address, port and token.`, "error"); };
    signalKSocket.onclose = () => {
      signalKSocket = null; button.textContent = "Connect Signal K";
      if (!signalKManualDisconnect) {
        signalKConnectionState = "waiting to reconnect"; signalKReconnectCount += 1;
        const reconnectDelay = vesselLogic.reconnectDelayMs(signalKReconnectCount);
        renderSignalKDiagnostics();
        setVesselStatus(`Signal K connection lost; reconnecting in ${reconnectDelay / 1000} seconds…`, "error");
        clearTimeout(signalKReconnectTimer); signalKReconnectTimer = setTimeout(connectSignalK, reconnectDelay);
      }
    };
    saveVesselSettings({ base, tracking: document.getElementById("vessel-track-toggle").checked });
  } catch (error) { setVesselStatus(`Invalid Signal K address: ${error.message}`, "error"); }
}

function exportTodayVesselTrack() {
  const day = vesselDayKey().split(".").pop();
  const geojson = vesselGeoJSON(vesselTrack, loadedVesselTrackKey);
  downloadVesselFile(JSON.stringify(geojson, null, 2), "application/geo+json", `${vesselDayKey().split(".").pop()}-sailvu-track.geojson`);
}

function csvCell(value) {
  return vesselLogic.csvCell(value);
}

function exportTodayVesselCsv() {
  const fields = ["voyageId", "samplingMode", "time", "receivedAt", "source", "lat", "lon", "sog", "cog", "headingMagnetic", "stw", "apparentWindSpeed", "apparentWindAngle", "depthBelowTransducer", "waterTemperatureC"];
  const csv = [fields.join(","), ...vesselTrack.map((p) => fields.map((f) => csvCell(p[f])).join(","))].join("\r\n");
  downloadVesselFile(csv, "text/csv;charset=utf-8", `${vesselDayKey().split(".").pop()}-sailvu-voyage-log.csv`);
}

function downloadVesselFile(content, type, filename) {
  let objectUrl = "";
  try {
    const blob = new Blob([content], { type });
    const a = document.createElement("a"); objectUrl = URL.createObjectURL(blob); a.href = objectUrl; a.download = filename; a.click();
    setVesselStatus(`Downloaded ${filename}.`, "connected");
    return true;
  } catch (error) {
    setVesselStatus(`Could not download ${filename}: ${error.message}. Try again or check browser download permissions.`, "error");
    return false;
  } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
}

function exportSignalKDiagnostics() {
  const report = {
    schema: "sailvu.signalk-diagnostics.v1", exportedAt: new Date().toISOString(),
    connection: { state: signalKConnectionState, server: signalKServerBase, lastMessageAt: signalKLastMessageAt, reconnectCount: signalKReconnectCount },
    pathsSeen: [...signalKSeenPaths].sort(), instrumentSources: vesselValueSources,
    instrumentTimestamps: vesselValueTimes, instrumentReceivedTimes: vesselValueReceivedTimes, latestInstrumentValues: vesselValues,
    sampling: { underwaySogKn: VESSEL_UNDERWAY_SOG_KN, underwayIntervalSeconds: VESSEL_UNDERWAY_SAMPLE_MS / 1000, stationaryIntervalMinutes: VESSEL_STATIONARY_SAMPLE_MS / 60000 }, voyageRecordsToday: vesselTrack.length,
  };
  downloadVesselFile(JSON.stringify(report, null, 2), "application/json", `${vesselDayKey().split(".").pop()}-sailvu-signalk-diagnostics.json`);
}

function backupTodayVesselLog() {
  const backup = { schema: "sailvu.voyage-log.v1", exportedAt: new Date().toISOString(), dayKey: loadedVesselTrackKey, records: vesselTrack };
  downloadVesselFile(JSON.stringify(backup, null, 2), "application/json", `${vesselDayKey().split(".").pop()}-sailvu-voyage-backup.json`);
}

async function importVesselBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.schema !== "sailvu.voyage-log.v1" || !Array.isArray(backup.records)) throw new Error("not a SAILVu voyage-log backup");
    const valid = vesselLogic.validRecords(backup.records);
    if (!valid.length) throw new Error("backup contains no valid records");
    if (!confirm(`Replace today's ${vesselTrack.length} record(s) with ${valid.length} imported record(s)?`)) return;
    localStorage.setItem(loadedVesselTrackKey, JSON.stringify(valid)); vesselTrack = valid; renderVesselTrack();
    setVesselStatus(`Imported ${valid.length} voyage-log records.`, "connected");
  } catch (error) { setVesselStatus(`Could not import voyage backup: ${error.message}.`, "error"); }
}

function setVesselRecording(recording) {
  vesselRecording = recording;
  const button = document.getElementById("vessel-record-btn");
  if (button) {
    button.textContent = `Automatic recording: ${recording ? "ON" : "OFF"}`;
    button.classList.toggle("recording-on", recording); button.classList.toggle("recording-off", !recording);
    button.setAttribute("aria-pressed", String(recording));
  }
  saveVesselSettings({ automaticRecording: recording });
  renderVesselTrack();
}

function startNewVesselVoyage() {
  if (vesselTrack.length && !confirm("Start a new voyage? Export or back up the current log first; this clears today's saved records.")) return;
  vesselTrack = []; vesselVoyageId = new Date().toISOString();
  try { localStorage.removeItem(loadedVesselTrackKey); } catch (_) {}
  setVesselRecording(true); renderVesselTrack(); setVesselStatus("New voyage started; waiting for the next position fix.", "connected");
}

function clearTodayVesselTrack() {
  if (!vesselTrack.length) {
    setVesselStatus("Today's track is already empty.");
    return;
  }
  if (!window.confirm(`Clear all ${vesselTrack.length} saved point${vesselTrack.length === 1 ? "" : "s"} from today's track?`)) return;
  vesselTrack = [];
  loadedVesselTrackKey = vesselDayKey();
  try { localStorage.removeItem(loadedVesselTrackKey); } catch (_) {}
  renderVesselTrack();
  setVesselStatus("Today's track was cleared. Live positioning remains active.", "connected");
}

function initializeVesselIntegration() {
  loadTodayVesselTrack();
  clearInterval(vesselAutoReportTimer);
  vesselAutoReportTimer = setInterval(archiveSavedVoyageReports, VESSEL_AUTO_REPORT_INTERVAL_MS);
  setTimeout(archiveSavedVoyageReports, 5000);
  const instrumentsOverlay = document.getElementById("vessel-instruments");
  const instrumentDetailsOverlay = document.querySelector(".vessel-instrument-details");
  const mapElement = document.getElementById("map");
  if (instrumentsOverlay && mapElement) {
    mapElement.append(instrumentsOverlay);
    if (window.L?.DomEvent) {
      L.DomEvent.disableClickPropagation(instrumentsOverlay);
      L.DomEvent.disableScrollPropagation(instrumentsOverlay);
    }
    const dragHandle = instrumentsOverlay.querySelector(".vessel-instruments-drag-handle");
    let overlayDrag = null, overlayMoved = false;
    dragHandle?.addEventListener("pointerdown", (event) => {
      const overlayRect = instrumentsOverlay.getBoundingClientRect();
      const mapRect = mapElement.getBoundingClientRect();
      overlayDrag = { x: event.clientX, y: event.clientY, left: overlayRect.left - mapRect.left, top: overlayRect.top - mapRect.top };
      overlayMoved = false;
      dragHandle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    dragHandle?.addEventListener("pointermove", (event) => {
      if (!overlayDrag) return;
      if (Math.abs(event.clientX-overlayDrag.x)+Math.abs(event.clientY-overlayDrag.y)>3) overlayMoved=true;
      const maxLeft = Math.max(0, mapElement.clientWidth - instrumentsOverlay.offsetWidth);
      const maxTop = Math.max(0, mapElement.clientHeight - instrumentsOverlay.offsetHeight);
      instrumentsOverlay.style.left = `${Math.max(0, Math.min(maxLeft, overlayDrag.left + event.clientX - overlayDrag.x))}px`;
      instrumentsOverlay.style.top = `${Math.max(0, Math.min(maxTop, overlayDrag.top + event.clientY - overlayDrag.y))}px`;
      instrumentsOverlay.style.right = "auto";
      instrumentsOverlay.style.bottom = "auto";
      event.stopPropagation();
    });
    dragHandle?.addEventListener("pointerup", () => { overlayDrag = null; });
    dragHandle?.addEventListener("pointercancel", () => { overlayDrag = null; });
    const toggleInstrumentCollapse=()=>{if(overlayMoved){overlayMoved=false;return;}const collapsed=instrumentsOverlay.classList.toggle("instruments-collapsed");dragHandle.setAttribute("aria-expanded",String(!collapsed));};
    dragHandle?.addEventListener("click",toggleInstrumentCollapse);
    dragHandle?.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();toggleInstrumentCollapse();}});
  }
  if (instrumentDetailsOverlay) {
    instrumentDetailsOverlay.classList.remove("vessel-instrument-details-overlay");
    instrumentDetailsOverlay.hidden = false;
  }
  document.getElementById("vessel-instruments-overlay-toggle")?.addEventListener("change", (event) => {
    if (instrumentsOverlay) instrumentsOverlay.hidden = !event.target.checked;
    saveVesselSettings({ instrumentsOverlay: event.target.checked });
  });
  vesselVoyageId = vesselTrack.find((p) => p.voyageId)?.voyageId || new Date().toISOString();
  try {
    const settings = JSON.parse(localStorage.getItem(VESSEL_SETTINGS_KEY) || "{}");
    if (settings.base) document.getElementById("signalk-url").value = settings.base;
    if (typeof settings.tracking === "boolean") document.getElementById("vessel-track-toggle").checked = settings.tracking;
    document.getElementById("ais-overlay-toggle").checked = settings.aisOverlay === true;
    document.getElementById("vessel-instruments-overlay-toggle").checked = settings.instrumentsOverlay === true;
    if (instrumentsOverlay) instrumentsOverlay.hidden = settings.instrumentsOverlay !== true;
    document.getElementById("signalk-auto-connect-toggle").checked = true;
    // Fail safe toward unattended logging: only an explicit saved false turns
    // automatic recording off; new installs and older settings default to on.
    vesselRecording = settings.automaticRecording !== false;
  } catch (_) {}
  setVesselRecording(vesselRecording);
  renderVesselStorage();
  document.getElementById("vessel-manual-btn").addEventListener("click", () => { vesselPickActive = true; document.getElementById("map").style.cursor = "crosshair"; setVesselStatus("Click the vessel's present position on the map."); });
  document.getElementById("vessel-device-gps-btn").addEventListener("click", () => {
    const button = document.getElementById("vessel-device-gps-btn");
    if (deviceGpsWatchId !== null) { navigator.geolocation.clearWatch(deviceGpsWatchId); deviceGpsWatchId = null; button.textContent = "Use this device's GPS"; return; }
    if (!navigator.geolocation) { setVesselStatus("This browser does not provide device GPS.", "error"); return; }
    deviceGpsWatchId = navigator.geolocation.watchPosition((p) => setVesselPosition(p.coords.latitude, p.coords.longitude, "Device GPS", { sog: Number.isFinite(p.coords.speed) ? p.coords.speed * 1.943844 : vesselValues.sog, cog: Number.isFinite(p.coords.heading) ? p.coords.heading : vesselValues.cog, time: new Date(p.timestamp).toISOString() }), (e) => setVesselStatus(`Device GPS unavailable: ${e.message}`, "error"), { enableHighAccuracy: true, maximumAge: 2000 });
    button.textContent = "Stop device GPS";
  });
  document.getElementById("signalk-connect-btn").addEventListener("click", connectSignalK);
  saveVesselSettings({ automaticConnection: true });
  const housekeepingToggle = document.getElementById("vessel-housekeeping-toggle");
  const housekeepingControls = document.getElementById("vessel-housekeeping-controls");
  const savedLogs = document.querySelector(".vessel-log-storage");
  if (housekeepingControls && savedLogs) housekeepingControls.append(savedLogs);
  housekeepingToggle?.addEventListener("change", () => { housekeepingControls.hidden = !housekeepingToggle.checked; });
  document.getElementById("signalk-diagnostics-export-btn").addEventListener("click", exportSignalKDiagnostics);
  document.getElementById("vessel-export-btn").addEventListener("click", exportTodayVesselTrack);
  document.getElementById("vessel-export-csv-btn").addEventListener("click", exportTodayVesselCsv);
  document.getElementById("vessel-backup-btn").addEventListener("click", backupTodayVesselLog);
  document.getElementById("vessel-import-btn").addEventListener("click", () => document.getElementById("vessel-import-file").click());
  document.getElementById("vessel-import-file").addEventListener("change", (e) => { const file = e.target.files?.[0]; if (file) importVesselBackup(file); e.target.value = ""; });
  document.getElementById("vessel-record-btn").addEventListener("click", () => setVesselRecording(!vesselRecording));
  document.getElementById("vessel-new-voyage-btn").addEventListener("click", startNewVesselVoyage);
  document.getElementById("vessel-clear-track-btn").addEventListener("click", clearTodayVesselTrack);
  document.getElementById("vessel-saved-logs").addEventListener("click", (event) => {
    const exportKey = event.target.dataset.logExport, deleteKey = event.target.dataset.logDelete;
    if (exportKey) backupSavedVesselLog(exportKey);
    if (deleteKey && deleteKey !== loadedVesselTrackKey && confirm(`Delete saved voyage log ${deleteKey.split(".").pop()}? Export it first if it may be needed.`)) { localStorage.removeItem(deleteKey); renderVesselStorage(); }
  });
  document.getElementById("vessel-track-toggle").addEventListener("change", (e) => {
    const base = document.getElementById("signalk-url").value.trim(); saveVesselSettings({ base, tracking: e.target.checked }); renderVesselTrack();
  });
  document.getElementById("ais-overlay-toggle").addEventListener("change", (e) => {
    saveVesselSettings({ aisOverlay: e.target.checked }); renderAisTargets();
    if (e.target.checked && signalKSocket?.readyState === WebSocket.OPEN) signalKSocket.send(JSON.stringify({ context: "vessels.*", subscribe: [
      { path: "name", period: 60000 }, { path: "navigation.position", period: 5000 }, { path: "navigation.speedOverGround", period: 5000 }, { path: "navigation.courseOverGroundTrue", period: 5000 },
    ] }));
  });
  vesselFreshnessTimer = setInterval(() => { renderVesselInstruments(); renderSignalKDiagnostics(); }, 1000);
  setTimeout(connectSignalK, 250);
}

const ONBOARD_CHECKS = [
  "Confirm the device is joined to Vite Vite's boat Wi-Fi.",
  "Confirm SailVu shows Signal K connected at 10.39.1.1:3000.",
  "Confirm Position, Heading, STW, apparent wind and Depth visually agree with the vessel instruments.",
  "Check Water temperature. If SailVu warns that it is implausible, record the vessel-instrument value in Notes.",
  "Open Instrument details and confirm live values say current rather than stale.",
  "Reload SailVu and confirm Signal K reconnects automatically and today's track returns.",
  "Try signalk.local:3000, then restore 10.39.1.1:3000. Record whether the hostname works.",
  "Turn on nearby AIS vessels and confirm any targets agree with the vessel's AIS display; then turn it off if not needed.",
  "Export the CSV log and GeoJSON track and confirm both downloads appear.",
];
let onboardCheckIndex = 0;
let onboardCheckResults = [];

function renderOnboardCheck() {
  const panel = document.getElementById("onboard-check-panel"), summary = document.getElementById("onboard-check-summary");
  if (onboardCheckIndex >= ONBOARD_CHECKS.length) {
    panel.hidden = true; document.getElementById("onboard-check-export-btn").hidden = false;
    const counts = (result) => onboardCheckResults.filter((item) => item.result === result).length;
    summary.textContent = `Complete: ${counts("pass")} passed, ${counts("problem")} problem(s), ${counts("skip")} skipped. Export the report before leaving.`;
    return;
  }
  panel.hidden = false;
  document.getElementById("onboard-check-progress").textContent = `Check ${onboardCheckIndex + 1} of ${ONBOARD_CHECKS.length}`;
  document.getElementById("onboard-check-action").textContent = ONBOARD_CHECKS[onboardCheckIndex];
  document.getElementById("onboard-check-notes").value = "";
  summary.textContent = onboardCheckResults.length ? `${onboardCheckResults.length} response(s) recorded.` : "";
}

function initializeOnboardChecks() {
  document.getElementById("onboard-check-start-btn").addEventListener("click", () => { onboardCheckIndex = 0; onboardCheckResults = []; document.getElementById("onboard-check-export-btn").hidden = true; renderOnboardCheck(); });
  document.getElementById("onboard-check-panel").addEventListener("click", (event) => {
    const result = event.target.dataset.onboardResult; if (!result) return;
    onboardCheckResults.push({ check: onboardCheckIndex + 1, action: ONBOARD_CHECKS[onboardCheckIndex], result, notes: document.getElementById("onboard-check-notes").value.trim(), recordedAt: new Date().toISOString() });
    onboardCheckIndex += 1; renderOnboardCheck();
  });
  document.getElementById("onboard-check-export-btn").addEventListener("click", () => downloadVesselFile(JSON.stringify({ schema: "sailvu.onboard-check.v1", vessel: "Vite Vite", completedAt: new Date().toISOString(), signalKServer: signalKServerBase, results: onboardCheckResults }, null, 2), "application/json", `${vesselDayKey().split(".").pop()}-sailvu-onboard-check.json`));
}

let fishingRestrictionsLayer = null;
let protectedAreasLayer = null;
let dfoManagementAreasLayer = null;
let dfoManagementAreaLabels = null;
function conservationPopup(feature, kind) {
  const p = feature.properties || {}, title = p.name || p.NAME || kind;
  const detail = kind === "Fishing restriction" ? (p.restrictions || p.category || "See current regulations") : (p.designation || p.category || "Protected area");
  const source = p.sourceUrl ? `<a href="${mapPointEscape(p.sourceUrl)}" target="_blank" rel="noopener">Source</a>` : mapPointEscape(p.source || "Source not supplied");
  const regulations = p.regulationsUrl ? ` · <a href="${mapPointEscape(p.regulationsUrl)}" target="_blank" rel="noopener">Current DFO regulations</a>` : "";
  const date = p.effectiveDate ? `<br><strong>Boundary dataset: ${mapPointEscape(p.effectiveDate)}</strong>` : "";
  const advisory = kind === "Fishing restriction"
    ? "Transparent planning overlay only—verify the current RCA variation order and regulations."
    : "Official provincial boundary overlay. A park designation does not by itself describe every marine or fishing restriction.";
  return `<strong>${mapPointEscape(title)}</strong><br>${mapPointEscape(detail)}${date}<br>${source}${regulations}<br><small>${advisory}</small>`;
}
function initializeConservationLayers() {
  const fishing = window.SAILVU_FISHING_RESTRICTIONS?.features || [], protectedFeatures = window.SAILVU_PROTECTED_AREAS?.features || [], managementFeatures = window.SAILVU_DFO_MANAGEMENT_AREAS?.features || [];
  fishingRestrictionsLayer = L.geoJSON(window.SAILVU_FISHING_RESTRICTIONS, { style: { color: "#c62828", weight: 2, fillColor: "#ef5350", fillOpacity: 0.16 }, onEachFeature: (feature, layer) => layer.bindPopup(conservationPopup(feature, "Fishing restriction")) });
  protectedAreasLayer = L.geoJSON(window.SAILVU_PROTECTED_AREAS, { style: { color: "#00695c", weight: 2, dashArray: "6 4", fillColor: "#26a69a", fillOpacity: 0.12 }, onEachFeature: (feature, layer) => layer.bindPopup(conservationPopup(feature, "Protected area")) });
  dfoManagementAreaLabels = L.layerGroup();
  dfoManagementAreasLayer = L.geoJSON(window.SAILVU_DFO_MANAGEMENT_AREAS, {
    style: { color: "#553c9a", weight: 2, dashArray: "8 5", fillColor: "#805ad5", fillOpacity: 0.045 },
    onEachFeature: (feature, layer) => {
      const p=feature.properties||{}, area=mapPointEscape(p.area), url=mapPointEscape(p.regulationsUrl||p.indexUrl);
      layer.bindPopup(`<strong>DFO Management Area ${area}</strong><br><a href="${url}" target="_blank" rel="noopener">Open Area ${area} recreational fishing regulations</a><br><a href="${mapPointEscape(p.indexUrl)}" target="_blank" rel="noopener">DFO area index</a><br><small>Verify current notices and closures before fishing.</small>`);
      const centre=layer.getBounds().getCenter();
      L.marker(centre,{interactive:false,icon:L.divIcon({className:"dfo-management-area-label",html:`<span>${area}</span>`,iconSize:[38,30],iconAnchor:[19,15]})}).addTo(dfoManagementAreaLabels);
    }
  });
  const status = document.getElementById("conservation-layers-status"); status.textContent = `${fishing.length} fishing-restriction area(s); ${protectedFeatures.length} BC marine park(s); ${managementFeatures.length} DFO management area(s) loaded.`;
  document.getElementById("fishing-restrictions-toggle").addEventListener("change", (event) => event.target.checked ? fishingRestrictionsLayer.addTo(map) : map.removeLayer(fishingRestrictionsLayer));
  document.getElementById("protected-areas-toggle").addEventListener("change", (event) => event.target.checked ? protectedAreasLayer.addTo(map) : map.removeLayer(protectedAreasLayer));
  document.getElementById("dfo-management-areas-toggle").addEventListener("change", (event) => { if(event.target.checked){dfoManagementAreasLayer.addTo(map);dfoManagementAreaLabels.addTo(map);}else{map.removeLayer(dfoManagementAreasLayer);map.removeLayer(dfoManagementAreaLabels);} });
}

// 2026-08-07, owner's request: "add a button for 'highlight the stations
// on the map that I have picked'" -- a layer group of crosshair markers,
// one per currently-checked Verification station (see
// getSelectedVerificationStationIds()), toggled by the "Highlight stations
// on map" button. Deliberately a SEPARATE layer/variable from
// queryPointMarker (showClickPointMarker()'s single-marker slot for "the
// one most recent point click") -- this feature shows potentially many
// stations at once and needs to persist independently of whatever the last
// single point-query or graph-click marker was.
let verificationHighlightLayer = null;

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function selectedMakingGate() {
  const id = document.getElementById("making-gate-select")?.value;
  return ((window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || []).find((station) => station.id === id) || null;
}

function initializeMakingGatePlanner() {
  const select = document.getElementById("making-gate-select");
  const button = document.getElementById("making-gate-position-btn");
  if (!select || !button) return;
  const stations = (window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || [];
  select.innerHTML = '<option value="">Select a gate</option>' + stations
    .map((station) => `<option value="${station.id}">${station.name}</option>`).join("");
  button.addEventListener("click", () => {
    const station = selectedMakingGate();
    const status = document.getElementById("making-gate-status");
    if (!station) {
      if (status) status.textContent = "Select a gate first.";
      select.focus();
      return;
    }
    makingGatePickActive = true;
    document.getElementById("map").style.cursor = "crosshair";
    if (status) status.textContent = `Click your present position on the map for ${station.name}.`;
  });
  select.addEventListener("change", () => {
    makingGatePickActive = false;
    makingGateArrivalMarker = null;
    document.getElementById("map").style.cursor = "";
    const status = document.getElementById("making-gate-status");
    const station = selectedMakingGate();
    if (status) status.textContent = station ? "Now click “Click present position on map”." : "Select a gate, then set your present position.";
    if (station) {
      const now = new Date();
      const start = new Date(now.getTime() - 4 * 3600000);
      const end = new Date(start.getTime() + 24 * 3600000);
      showGateCurrentGraph(station, null, { start, end, makingGateDynamic: true });
    }
  });
}

function completeMakingGatePosition(latlng) {
  const station = selectedMakingGate();
  if (!station) return;
  makingGatePickActive = false;
  setVesselPosition(latlng.lat, latlng.lng, "manual");
  document.getElementById("map").style.cursor = "";
  return;
  makingGatePosition = { lat: latlng.lat, lon: latlng.lng };
  document.getElementById("map").style.cursor = "";
  if (makingGatePositionMarker) map.removeLayer(makingGatePositionMarker);
  makingGatePositionMarker = L.circleMarker(latlng, {
    radius: 7, color: "#1b6ca8", weight: 3, fillColor: "#fff", fillOpacity: 1,
  }).addTo(map).bindTooltip("Clicked present position", { direction: "top" });
  const distanceKm = haversineKm(makingGatePosition, station);
  const distanceNm = distanceKm / 1.852;
  const speedKn = Math.max(0.1, Number(document.getElementById("speed")?.value) || 5);
  const travelHours = distanceNm / speedKn;
  const arrival = new Date(Date.now() + travelHours * 3600000);
  const status = document.getElementById("making-gate-status");
  if (status) status.innerHTML = `<strong>${distanceNm.toFixed(1)} NM</strong> to ${station.name} at ${speedKn.toFixed(1)} kn — arrival ${arrival.toLocaleString()} (${travelHours.toFixed(1)} h).`;
  makingGateArrivalMarker = {
    stationId: station.id,
    x: arrival,
    label: "Boat arrival",
    color: "#2e7d32",
    now: true,
  };
  refreshOpenGraphPopup();
}

// Perpendicular distance (km) from point p to the segment a-b, using a flat
// local-degrees approximation (fine at this latitude/scale for a proximity
// check; not for navigation).
function pointToSegmentKm(p, a, b) {
  const toXY = (pt) => ({
    x: pt.lon * Math.cos((a.lat * Math.PI) / 180),
    y: pt.lat,
  });
  const P = toXY(p), A = toXY(a), B = toXY(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const closest = { lat: A.y + t * dy, lon: (A.x + t * dx) / Math.cos((a.lat * Math.PI) / 180) };
  return haversineKm(p, closest);
}

function toDeg(r) {
  return (r * 180) / Math.PI;
}

// Great-circle initial bearing from a to b, in compass degrees (0=N, 90=E).
function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Great-circle destination point: given a start point, an initial compass
// bearing, and a distance (km), returns the resulting {lat, lon}. Inverse
// of bearingDeg()+haversineKm() -- used to draw ground-track arrows as real
// geo-referenced vectors (see renderGroundTrackArrows()) rather than
// fixed-screen-pixel icons, so they scale with zoom the way any other map
// geometry does, with no per-zoom recompute needed.
function destinationPoint(start, initialBearingDeg, distanceKm) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const brng = toRad(initialBearingDeg);
  const lat1 = toRad(start.lat);
  const lon1 = toRad(start.lon);
  const dR = distanceKm / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: (((toDeg(lon2) + 540) % 360) - 180) };
}

// Builds one geo-referenced arrow vector (shaft polyline + a filled
// triangular arrowhead polygon) from `from` to `to`, both real {lat, lon}
// points -- NOT a fixed-screen-pixel icon like buildCurrentArrowIcon(). All
// three shapes (shaft, two head edges) are ordinary Leaflet geometry, so
// Leaflet itself redraws them at the correct size and position on every
// zoom/pan -- no recompute-on-zoom needed. (The heat map mesh -- see
// buildHeatMeshQuads() -- is built the same way, as real polygons, for the
// same reason.) Returns an L.layerGroup with both shapes, plus the arrow's
// own bearing/distance for popup text.
// extraOpts (optional): merged into both the shaft's and head's Leaflet
// options -- added 2026-08-02 so renderCurrentArrowsOnMap() can pass a
// single shared L.canvas() renderer for its ~hundred-plus arrows (same
// reason renderCurrentHeatMap() shares one canvas renderer across its
// thousands of quads: one shared canvas is far cheaper than one SVG DOM
// element per shape). Ground-track arrows (a handful per leg) still use
// the default SVG renderer, which is fine at that count and keeps their
// existing crisp look.
// sizeOpts (optional, added 2026-08-02): lets one caller diverge from the
// shared default shaft-weight/head-size constants above without affecting
// the other caller -- specifically, the current-field arrows are now drawn
// with a thinner shaft than the ground-track arrows, per the owner's
// request, even though both still go through this same helper and the same
// underlying ARROW_HEAD_*/ROUTE_ARROW_SHAFT_WEIGHT_PX constants as their
// DEFAULTS. `shaftWeightPx` overrides the shaft's line weight directly.
// `headScale` multiplies the computed (length-proportional) head length --
// still how the ground-track arrows size their heads. `fixedHeadLenKm`
// (added in the same 2026-08-02 follow-up) instead sets a CONSTANT head
// length regardless of the arrow's own length -- used by the current-field
// arrows so head size reads as "this is the tip," not a second speed cue
// alongside shaft length; `headScale` is ignored when `fixedHeadLenKm` is
// given (they're two different sizing modes, not combined).
function buildArrowVectorLayer(from, to, colorHex, popupHtml, extraOpts, sizeOpts) {
  extraOpts = extraOpts || {};
  sizeOpts = sizeOpts || {};
  const shaftWeightPx = sizeOpts.shaftWeightPx !== undefined ? sizeOpts.shaftWeightPx : ROUTE_ARROW_SHAFT_WEIGHT_PX;
  const headScale = sizeOpts.headScale !== undefined ? sizeOpts.headScale : 1;
  const distanceKm = haversineKm(from, to);
  const brng = bearingDeg(from, to);
  const headLenKm = sizeOpts.fixedHeadLenKm !== undefined
    ? sizeOpts.fixedHeadLenKm
    : Math.max(ARROW_HEAD_MIN_KM, Math.min(ARROW_HEAD_MAX_KM, distanceKm * ARROW_HEAD_LENGTH_FRACTION)) * headScale;
  // Don't let the head eat the whole shaft on a very short arrow -- applies
  // whether headLenKm came from the fixed value or the proportional calc.
  const clampedHeadLenKm = Math.min(headLenKm, distanceKm * 0.9);
  const headBase = destinationPoint(from, brng, Math.max(0, distanceKm - clampedHeadLenKm));
  const halfWidthKm = clampedHeadLenKm * Math.tan((ARROW_HEAD_HALF_ANGLE_DEG * Math.PI) / 180);
  const wingLeft = destinationPoint(headBase, brng - 90, halfWidthKm);
  const wingRight = destinationPoint(headBase, brng + 90, halfWidthKm);

  const group = L.layerGroup();
  const shaft = L.polyline(
    [
      [from.lat, from.lon],
      [headBase.lat, headBase.lon],
    ],
    { color: colorHex, weight: shaftWeightPx, ...extraOpts }
  );
  const head = L.polygon(
    [
      [to.lat, to.lon],
      [wingLeft.lat, wingLeft.lon],
      [wingRight.lat, wingRight.lon],
    ],
    { color: colorHex, weight: 0, fillColor: colorHex, fillOpacity: 1, ...extraOpts }
  );
  if (popupHtml) {
    shaft.bindPopup(popupHtml);
    head.bindPopup(popupHtml);
  }
  shaft.addTo(group);
  head.addTo(group);
  return group;
}

// Decomposes a wind speed into feather units: pennants (50kn each), full
// feathers (10kn each), and at most one half feather (5kn) -- the same
// counting scheme the discarded WMO-barb design used (rounds to the
// nearest 5kn first, same as real synoptic charts), just renamed since
// these are no longer meteorological barbs. Exported as its own function
// (not inlined into buildWindArrowLayer()) so it can be unit-tested against
// known speed/unit-count pairs independently of any drawing.
function windFeatherCounts(speedKn) {
  const rounded = Math.round(speedKn / 5) * 5;
  let remaining = rounded;
  const pennants = Math.floor(remaining / 50);
  remaining -= pennants * 50;
  const fullFeathers = Math.floor(remaining / 10);
  remaining -= fullFeathers * 10;
  const halfFeather = remaining >= 5 ? 1 : 0;
  return { rounded, pennants, fullFeathers, halfFeather };
}

// 2026-08-07, owner's request: "Icon for buoy/shore station winds when
// zoomed out provides data on hover or click, but not when zoomed in.
// Allow both hover and click at all zooms" + "Change Wind Icon to the
// standard wind arrow used elsewhere on this map, but make it 5x larger
// at the zooms currently showing the circle and cross hair." Builds a
// SCREEN-SPACE SVG version of the same shaft+arrowhead+feather/pennant
// (or calm-diamond) symbol buildWindArrowLayer() draws with real geo
// coordinates -- same windFeatherCounts() speed encoding, same "points
// TOWARD the compass bearing wind is blowing, like an arrow in flight"
// convention, just drawn once in a fixed local viewBox (arrow pointing
// "up") and rotated into place via a CSS transform on the caller's own
// divIcon wrapper, instead of real destinationPoint() geometry. This is
// what loadWindStations() now uses for EVERY station marker at EVERY
// zoom (replacing both the old Canvas-rendered geo-arrow at close zoom
// AND the crosshair-only symbol at wide zoom) -- see that function's own
// comment for why: a single DOM element (one L.marker + divIcon) gets
// plain, reliable browser hover/click for free, the same way the old
// crosshair symbol always did; the Canvas-rendered geo-arrow's multi-leaf-
// shape hit-testing (bindStationInteractivity()'s per-leaf-shape
// recursion, now unused/removed) was the inconsistent one. sizePx sets
// the icon's overall footprint -- since the whole SVG scales together
// (one fixed viewBox, no non-scaling-stroke), a bigger sizePx makes
// EVERYTHING bigger together (shaft, head, feathers, stroke width alike),
// not just line thickness -- true "5x larger," not just "5x fatter."
//
// 2026-08-07, LATER same day, owner's follow-up: "make them 3x thicker...
// and same scale as modelled winds." `weightMultiplier` (new, optional,
// default 1) scales ONLY the stroke-width numbers below, independent of
// sizePx -- needed because loadWindStations() now derives sizePx from the
// map's own real km-per-pixel scale (see its own comment) to match the
// field wind arrows' real geographic length, and at typical zooms that's
// small enough that the ORIGINAL fixed stroke-width (5-6, sized for the
// old ~26-130px icons) would read as a hairline -- thickening independent
// of that real-scale length is what keeps it legible.
function buildWindArrowIconSvg(speedKn, colorHex, sizePx, weightMultiplier) {
  weightMultiplier = weightMultiplier || 1;
  const { rounded, pennants, fullFeathers, halfFeather } = windFeatherCounts(speedKn);
  if (rounded < WIND_ARROW_CALM_KN_THRESHOLD) {
    // Small diamond outline, centered -- no shaft/head/feathers, same
    // "calm" convention as buildWindArrowLayer()'s own geo version.
    return (
      `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100">` +
      `<polygon points="50,32 68,50 50,68 32,50" fill="none" stroke="${colorHex}" stroke-width="${6 * weightMultiplier}"/>` +
      `</svg>`
    );
  }
  const units = [];
  for (let i = 0; i < pennants; i++) units.push("pennant");
  for (let i = 0; i < fullFeathers; i++) units.push("full");
  if (halfFeather) units.push("half");
  // Slots run from the tail (y=88, i=0) toward the tip as i increases --
  // same outward-from-the-tail ordering buildWindArrowLayer() uses, just
  // capped at 5 slots (comfortably covers every realistic Salish Sea
  // reading -- 5 units alone is already 50-70+kn depending on the pennant/
  // feather mix) so a rare extreme reading can't crowd ticks into the
  // arrowhead itself.
  const tickSvg = units
    .slice(0, 5)
    .map((kind, i) => {
      const y = 88 - i * 11;
      if (kind === "pennant") {
        // Small filled flag, swept back-left from the shaft -- same
        // "fletching near the nock" shape family as a feather tick below,
        // just filled instead of a bare line, matching the geo version's
        // own pennant-vs-feather distinction.
        return `<polygon points="50,${y} 34,${y + 5} 50,${y + 10}" fill="${colorHex}"/>`;
      }
      const len = kind === "half" ? 8 : 14;
      return `<line x1="50" y1="${y}" x2="${50 - len}" y2="${y + 7}" stroke="${colorHex}" stroke-width="${5 * weightMultiplier}" stroke-linecap="round"/>`;
    })
    .join("");
  return (
    `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100">` +
    `<line x1="50" y1="88" x2="50" y2="26" stroke="${colorHex}" stroke-width="${5 * weightMultiplier}"/>` +
    `<polygon points="50,10 38,30 62,30" fill="${colorHex}"/>` +
    tickSvg +
    `</svg>`
  );
}

// Builds one wind-arrow symbol at `at` ({lat, lon}), pointing TOWARD compass
// bearing `dirDeg` (the direction the wind is blowing toward) at `speedKn`
// -- the same "toward" convention as buildArrowVectorLayer()'s current
// arrows, per the owner's explicit direction: "the wind arrows work the
// same way a (bow and) arrow works, it flies in the direction of the wind,
// just like the current arrows." Shaft + arrowhead are literally drawn by
// buildArrowVectorLayer() (same shape/scale reasoning as any other arrow in
// this app), with feather-style marks (windFeatherCounts()) attached near
// the TAIL, swept backward and to one side from the direction of travel
// (WIND_ARROW_FEATHER_ANGLE_OFFSET_DEG off the shaft's own reciprocal
// bearing) -- like real arrow fletching flares back from the nock, not the
// WMO barb convention's perpendicular ticks near the tip (which the owner
// flagged as "plotted wrong" once the rest of the symbol became an actual
// arrow). Below WIND_ARROW_CALM_KN_THRESHOLD, draws a small diamond
// instead (no shaft/arrowhead/feathers at all -- standard convention for
// calm, unchanged from the discarded barb design).
// `weightMultiplier` (optional, default 1, added 2026-08-06 later session):
// scales every STROKE weight below (shaft, feather lines, the calm
// diamond's outline) without touching any length/position (shaft length,
// feather length/spacing, pennant size) -- added so loadWindStations()
// can draw buoy/shore-station arrows "the same length/knot as Wind
// arrows, but 3x fatter" (owner's explicit request) by reusing this exact
// function/geometry, just thicker, rather than a second hand-maintained
// copy of the whole shaft+feather+pennant+calm-diamond drawing logic.
// renderWindArrowsOnMap()'s own field-arrow call site doesn't pass this
// (defaults to 1), so its own look is completely unchanged.
function buildWindArrowLayer(at, dirDeg, speedKn, colorHex, popupHtml, extraOpts, weightMultiplier, lengthMultiplier) {
  extraOpts = extraOpts || {};
  weightMultiplier = weightMultiplier || 1;
  lengthMultiplier = lengthMultiplier || 1;
  const group = L.layerGroup();
  const { rounded, pennants, fullFeathers, halfFeather } = windFeatherCounts(speedKn);

  if (rounded < WIND_ARROW_CALM_KN_THRESHOLD) {
    const pts = [0, 90, 180, 270].map((b) => destinationPoint(at, b, WIND_ARROW_CALM_RADIUS_KM * lengthMultiplier));
    const calmMarker = L.polygon(
      pts.map((p) => [p.lat, p.lon]),
      { color: colorHex, weight: 1 * weightMultiplier, fillOpacity: 0, ...extraOpts }
    );
    if (popupHtml) calmMarker.bindPopup(popupHtml);
    calmMarker.addTo(group);
    return group;
  }

  const tip = destinationPoint(at, dirDeg, WIND_ARROW_SHAFT_KM * lengthMultiplier);
  buildArrowVectorLayer(at, tip, colorHex, popupHtml, extraOpts, { shaftWeightPx: WIND_ARROW_SHAFT_WEIGHT_PX * weightMultiplier }).addTo(group);

  // Every feather/pennant sweeps back from this bearing (the shaft's
  // reciprocal/backward direction, offset to one side) -- see the
  // WIND_ARROW_FEATHER_ANGLE_OFFSET_DEG constant's own comment for why.
  const featherBearing = reciprocalBearingDeg(dirDeg) + WIND_ARROW_FEATHER_ANGLE_OFFSET_DEG;

  // Largest units first, closest to the tail (nearest `at`) -- unlike the
  // discarded WMO-barb design (which clustered units near the tip, per
  // real synoptic-chart convention), real arrow fletching sits near the
  // nock regardless of what it's encoding, so the units are ordered
  // outward from the tail here instead.
  const units = [];
  for (let i = 0; i < pennants; i++) units.push("pennant");
  for (let i = 0; i < fullFeathers; i++) units.push("full");
  if (halfFeather) units.push("half");

  units.forEach((kind, i) => {
    const distFromTailKm = i * WIND_ARROW_FEATHER_SPACING_KM * lengthMultiplier;
    const slotPoint = destinationPoint(at, dirDeg, distFromTailKm);
    if (kind === "pennant") {
      const baseOuterPoint = destinationPoint(at, dirDeg, distFromTailKm + WIND_ARROW_PENNANT_BASE_KM * lengthMultiplier);
      const apex = destinationPoint(slotPoint, featherBearing, WIND_ARROW_FEATHER_KM * lengthMultiplier);
      const pennant = L.polygon(
        [
          [slotPoint.lat, slotPoint.lon],
          [baseOuterPoint.lat, baseOuterPoint.lon],
          [apex.lat, apex.lon],
        ],
        { color: colorHex, weight: 0, fillColor: colorHex, fillOpacity: 1, ...extraOpts }
      );
      if (popupHtml) pennant.bindPopup(popupHtml);
      pennant.addTo(group);
    } else {
      const featherLenKm = (kind === "half" ? WIND_ARROW_HALF_FEATHER_KM : WIND_ARROW_FEATHER_KM) * lengthMultiplier;
      const featherEnd = destinationPoint(slotPoint, featherBearing, featherLenKm);
      const feather = L.polyline(
        [
          [slotPoint.lat, slotPoint.lon],
          [featherEnd.lat, featherEnd.lon],
        ],
        { color: colorHex, weight: WIND_ARROW_SHAFT_WEIGHT_PX * weightMultiplier, ...extraOpts }
      );
      if (popupHtml) feather.bindPopup(popupHtml);
      feather.addTo(group);
    }
  });

  return group;
}

function loadCurrentField() {
  // Reads window.CURRENT_FIELD_DATA, set by data/current_field.js (same
  // plain-<script> convention as the other data files, no fetch()). Only
  // records with a resolved lat/lon are usable -- fetch_model_data.py flags
  // (and this filters out) any record its lat/lon lookup couldn't match.
  const data = window.CURRENT_FIELD_DATA;
  if (!data || !data.records) return [];
  let recs = data.records.filter((r) => r.lat !== undefined && r.lon !== undefined);
  // 2026-08-05: single choke point for which model source(s) show -- every
  // consumer of current data (arrows, heat mesh, point-query, gate/tide/
  // wind station model samples, route/leg ETA sampling, ground-track
  // arrows) calls this function rather than reading window.CURRENT_FIELD_DATA
  // directly, so filtering here makes the whole app consistently show one
  // source (or both, or neither) with no separate wiring needed per
  // feature.
  //
  // 2026-08-06, later session (owner's request): filters directly on
  // salishSeaCastArrowsEnabled/ciopsArrowsEnabled now (see those flags' own
  // comment) instead of the old currentSourceMode string + its 3-branch
  // if/else -- a plain per-record check handles "both on"/"one on"/"both
  // off" (-> empty recs, DFO-gate synthetic nodes still concat'd below) all
  // in one line, no separate "none" case needed. SalishSeaCast records
  // carry no "source" field at all (only CIOPS-West's extra_records do --
  // see build_app_data_js()'s own comment in fetch_model_data.py), hence
  // checking "=== 'CIOPS-West'" rather than a positive SalishSeaCast match.
  recs = recs.filter((r) => (r.source === "CIOPS-West" ? ciopsArrowsEnabled : salishSeaCastArrowsEnabled));
  // 2026-08-06: DFO-gate synthetic nodes (see GATE_ZONE_RADIUS_KM's own
  // header comment) always included regardless of the two Model flags --
  // appended AFTER the filter above, not filtered by it. This isn't a
  // "which broad-coverage model" tradeoff like SalishSeaCast/CIOPS-West,
  // it's a targeted accuracy fix at 4 specific named stations, so it
  // applies no matter which broad source is currently selected. Unaffected
  // by gateBoxesEnabled -- that flag only gates whether the DFO-gate
  // ARROWS get drawn (renderCurrentArrowsOnMap()); these synthetic nodes
  // still feed the heat map/ETA/tooltips regardless, same as before this
  // session's Gate-boxes toggle was added.
  return recs.concat(loadDfoGateRecords());
}

// 2026-08-07, real regression found by the owner: "until recently we were
// able to view the current heat map by itself without the SeaCast
// Currents." Root cause: loadCurrentField()'s salishSeaCastArrowsEnabled/
// ciopsArrowsEnabled gate above (2026-08-06, "sole source of truth for
// arrows/heat map/ETA/tooltips") has applied to the heat map since that
// date, but it went unnoticed because both flags defaulted TRUE until
// this same day's separate "no currents by default" change flipped them
// to FALSE -- so the heat map's own #heatmap-toggle checkbox always had
// data available before, and silently stopped having any the moment the
// two Model checkboxes' default changed, even though the heat map has
// its own independent on/off control and was never meant to need the
// Model checkboxes too. Fix: the heat map now reads directly from here
// (same lat/lon-defined filter as loadCurrentField()'s own first line,
// no DFO-gate concat -- see buildHeatMeshQuads()'s own comment for why
// DFO-gate/CIOPS-West records can't feed the mesh anyway, no gridX/gridY)
// instead of loadCurrentField(), so it's no longer gated by the two Model
// checkboxes at all. Arrows/ETA/point-query/station tooltips are
// UNCHANGED -- they still go through loadCurrentField() and are still
// correctly gated by those two checkboxes, per the owner's original
// 2026-08-06 request for THOSE features.
function loadHeatMapCurrentField() {
  const data = window.CURRENT_FIELD_DATA;
  if (!data || !data.records) return [];
  return data.records.filter((r) => r.lat !== undefined && r.lon !== undefined);
}

// 2026-08-07, owner's request: "Under OCEAN/Currents: if data is not
// available, add 'not available' in bold red font immediately after the
// parameter name." Checks each Currents-tab data source independently and
// toggles its own <span class="param-unavailable-badge" hidden> (index.html)
// -- deliberately keyed to whether real data EXISTS for that source, not to
// the source's own checkbox/checked state: a row can be off (unchecked) and
// still show no badge (data is there, just not displayed right now), or on
// and show the badge (nothing to actually display once checked). SalishSeaCast
// vs. CIOPS-West split mirrors loadCurrentField()'s own filter (SalishSeaCast
// records carry no "source" field at all; only CIOPS-West's do -- see that
// function's own comment) -- reads window.CURRENT_FIELD_DATA directly rather
// than through loadCurrentField() itself, since that function already filters
// OUT whichever source is currently unchecked, which would make an
// unchecked-but-actually-available source misreport as "not available" here.
function updateCurrentSourceAvailability() {
  const records = (window.CURRENT_FIELD_DATA && window.CURRENT_FIELD_DATA.records) || [];
  const usable = records.filter((r) => r.lat !== undefined && r.lon !== undefined);
  const salishAvailable = usable.some((r) => r.source !== "CIOPS-West");
  const ciopsAvailable = usable.some((r) => r.source === "CIOPS-West");
  const gateAvailable = loadDfoGateRecords().length > 0;
  const heatMapAvailable = loadHeatMapCurrentField().length > 0;
  const badges = [
    ["salishseacast-unavailable-badge", salishAvailable],
    ["ciops-unavailable-badge", ciopsAvailable],
    ["gate-currents-unavailable-badge", gateAvailable],
    ["heatmap-unavailable-badge", heatMapAvailable],
  ];
  badges.forEach(([id, available]) => {
    const el = document.getElementById(id);
    if (el) el.hidden = available;
  });
}

// 2026-08-06: loadCurrentField() minus DFO-gate synthetic nodes -- used
// ONLY by the current-verification tool (buildCurrentVerificationPoints(),
// showGateCurrentComponentsGraph(), startVerificationPick()'s own
// candidate-dot list) and the DFO-gate builder's own zone-priority check
// below, all of which need the REAL raw model, not the synthetic node.
// Verification specifically must keep comparing CHS's curve against the
// actual model -- comparing it against a node that's ITSELF derived from
// that same CHS curve would be circular (trivially "perfect," not a real
// check), and the point-picker shouldn't offer the synthetic node as if it
// were a real, independently-existing grid cell to choose.
function loadRawCurrentField() {
  return loadCurrentField().filter((r) => r.source !== "DFO-gate");
}

// 2026-08-06: flood/ebb phase ("which half of the tidal cycle is
// targetTime in") at one gate station, from its own already-fetched
// SLACK/EXTREMA_EBB/EXTREMA_FLOOD event timeline (gate_predictions.js,
// loadGatePredictions()) -- the same real data source the gate warnings
// and gate-current-graph dots already use, not a new fetch. Finds the
// event immediately before AND immediately after targetTime; whichever of
// those two is an EXTREMA (not a SLACK) tells the phase directly, since
// events strictly alternate SLACK/EXTREMA/SLACK/EXTREMA in real tidal
// data -- at most one of the two bracketing events can be a SLACK. Falls
// back to the single nearest EXTREMA overall only if BOTH bracketing
// events happen to be SLACK (shouldn't occur with real alternating data,
// but degrades gracefully rather than guessing outright). Returns null if
// there's no usable event data at all for this station.
function gatePhaseAt(events, targetTime) {
  if (!events || !events.length) return null;
  const sorted = [...events].sort((a, b) => new Date(a.time) - new Date(b.time));
  const t = targetTime.getTime();
  let before = null, after = null;
  sorted.forEach((e) => {
    const et = new Date(e.time).getTime();
    if (et <= t) before = e;
    if (et >= t && !after) after = e;
  });
  const asPhase = (e) => (e && e.type === "EXTREMA_FLOOD" ? "flood" : e && e.type === "EXTREMA_EBB" ? "ebb" : null);
  const bracketPhase = asPhase(before) || asPhase(after);
  if (bracketPhase) return bracketPhase;
  let nearest = null, nearestDiff = Infinity;
  sorted.forEach((e) => {
    if (e.type !== "EXTREMA_FLOOD" && e.type !== "EXTREMA_EBB") return;
    const diff = Math.abs(new Date(e.time).getTime() - t);
    if (diff < nearestDiff) { nearestDiff = diff; nearest = e; }
  });
  return asPhase(nearest);
}

// 2026-08-06: builds the DFO-gate synthetic current records -- one per
// (gate station, DFO curve hour) -- see GATE_ZONE_RADIUS_KM's own header
// comment for the full "why" and CURRENT_FIELD_DATA's own source citation
// for GATE_FLOOD_EBB_BEARINGS. Speed = CHS's own predicted magnitude at
// that hour (gate_current_curve.js, real, unsigned); direction = the
// station's own fixed CHS-published flood/ebb bearing, signed by
// gatePhaseAt() against the station's own real SLACK/EXTREMA timeline
// (gate_predictions.js) -- both are real, independently-sourced CHS data,
// combined here (not blended with the model at all) into one fully signed
// vector per hour. Skips a station entirely if any of the three required
// inputs (a published bearing, curve data, or event data) is missing,
// rather than guessing a partial record.
function buildDfoGateRecords() {
  const stationsData = window.GATE_STATIONS_DATA;
  const curveData = window.GATE_CURRENT_CURVE_DATA;
  if (!stationsData || !curveData || !curveData.stations) return [];
  const predictions = loadGatePredictions();
  const records = [];
  stationsData.stations.forEach((st) => {
    const bearings = GATE_FLOOD_EBB_BEARINGS[st.id];
    const curve = curveData.stations[st.id];
    if (!bearings || !curve || !curve.curve) return;
    const events = (predictions[st.id] && predictions[st.id].events) || [];
    curve.curve.forEach((pt) => {
      if (typeof pt.speed_kn !== "number") return;
      const phase = gatePhaseAt(events, new Date(pt.time));
      // No usable event data at all for this hour -- still record the
      // magnitude (real, CHS's own) rather than dropping the point, but
      // direction defaults to the flood bearing, an honest coin-flip only
      // in this fallback case, not the normal path.
      const bearingDeg = phase === "ebb" ? bearings.ebbDeg : bearings.floodDeg;
      const { eastKn, northKn } = vectorFromSpeedDir(pt.speed_kn, bearingDeg);
      records.push({
        time: pt.time,
        lat: st.lat,
        lon: st.lon,
        VelEastDfo_kn: eastKn,
        VelNorthDfo_kn: northKn,
        source: "DFO-gate",
      });
    });
  });
  return records;
}

// Lazily built, cached (buildDfoGateRecords() re-derives from three
// already-loaded files on every call otherwise, and loadCurrentField()
// calls this on every single invocation -- far too hot a path to rebuild
// from scratch each time). Reset to null in refreshDataFiles() alongside
// this app's other post-pipeline-reload caches, so a fresh "Refresh data"
// run's new curve/event data is picked up rather than a stale build.
let cachedDfoGateRecords = null;
function loadDfoGateRecords() {
  if (cachedDfoGateRecords) return cachedDfoGateRecords;
  cachedDfoGateRecords = buildDfoGateRecords();
  return cachedDfoGateRecords;
}

// 2026-08-06, later session (owner's request: "Delete the 'Current data
// source' text and box - we now have buttons"): replaces
// setCurrentSourceMode() -- same re-render list (mirrors what
// refreshDataFiles() runs after a pipeline reload: arrows/heat map/legs/
// warnings/gate & tide station tooltips all resample), just triggered by
// the two Model checkboxes now instead of the deleted dropdown. Called
// AFTER salishSeaCastArrowsEnabled/ciopsArrowsEnabled is already updated
// by the caller, not passed a value itself -- there's no longer a single
// "mode" value to compare against/short-circuit on, each checkbox just
// flips its own flag and calls this.
function refreshAfterCurrentSourceChange() {
  cachedCurrentSpeedRange = null; // scanned over whichever source(s) are now enabled, not the whole blended field
  renderCurrentArrowsOnMap();
  renderCurrentHeatMap();
  renderWindCurrentInteractionMap();
  loadGateStations();
  loadTideStations();
  loadWindStations();
  redraw(); // legs, ground-track arrows, warnings, route-conditions sampling
}

// Reads window.WIND_FIELD_DATA, set by data/wind_field.js (same plain-
// <script> convention as current_field.js -- see build_wind_field_js() in
// fetch_model_data.py, which deliberately mirrors current_field.js's
// {generated_at, valid_from, valid_to, records[]} wrapper and lat/lon-
// filtering requirement for this exact reuse). 2026-08-02: first frontend
// function to read this file -- the pipeline-side fetch was built in an
// earlier session, nothing consumed it until now.
function loadWindField() {
  const data = window.WIND_FIELD_DATA;
  if (!data || !data.records) return [];
  return data.records.filter((r) => r.lat !== undefined && r.lon !== undefined);
}

// Reads window.WAVE_FIELD_DATA, set by data/wave_field.js -- same
// {generated_at, valid_from, valid_to, records[]} wrapper as current/wind.
// 2026-08-03: added alongside the pipeline-side fetch in this same session
// (see build_wave_field_js() in fetch_model_data.py). Returns [] safely if
// the file is missing/not yet generated, same as the other two loaders --
// this sandbox could not pull real wave data, so data/wave_field.js will
// not exist with real content until the pipeline is run for real.
function loadWaveField() {
  const data = window.WAVE_FIELD_DATA;
  if (!data || !data.records) return [];
  return data.records.filter((r) => r.lat !== undefined && r.lon !== undefined);
}

// Global current-speed range (min forced to 0, max = the fastest usable
// sample anywhere in the whole loaded field, any time slice) -- feeds
// showPointCurrentGraph()'s fixed Y-axis (drawLineChart()'s opts.yDomain).
// Scans currentVectorKn()/currentSpeedDir() over every record, not just one
// point -- the same per-point accessors used everywhere else in this file,
// just applied field-wide instead of at a single grid point.
function currentSpeedRange() {
  if (cachedCurrentSpeedRange) return cachedCurrentSpeedRange;
  let max = 0;
  loadCurrentField().forEach((r) => {
    const vec = currentVectorKn(r);
    if (!vec) return;
    const { speedKn } = currentSpeedDir(vec);
    if (speedKn > max) max = speedKn;
  });
  // 2026-08-03: round UP to the nearest whole knot, per the owner's
  // request after seeing a raw "4.96" axis label -- Math.ceil(0) stays 0
  // (empty/no-data case), not pushed up to 1.
  cachedCurrentSpeedRange = { min: 0, max: Math.ceil(max) };
  return cachedCurrentSpeedRange;
}

// Wave analogue of currentSpeedRange() above -- scalar, so just a min/max
// over hs_m directly, no vector accessor needed. Same nearest-whole-unit
// rounding (whole meters here, same reasoning as currentSpeedRange()).
function waveHeightRange() {
  if (cachedWaveHeightRange) return cachedWaveHeightRange;
  let max = 0;
  loadWaveField().forEach((r) => {
    if (r.hs_m !== undefined && r.hs_m > max) max = r.hs_m;
  });
  cachedWaveHeightRange = { min: 0, max: Math.ceil(max) };
  return cachedWaveHeightRange;
}

// 2026-08-04: wind analogue of currentSpeedRange() above -- same vector
// accessor (windVectorKn()) + speed/dir helper (currentSpeedDir()) current
// already uses, scanned field-wide for showPointWindGraph()'s fixed Y-axis.
// Added alongside that function, per the owner's request to bring wind's
// "Show graph" up to parity with current/waves (both already had one).
function windSpeedRange() {
  if (cachedWindSpeedRange) return cachedWindSpeedRange;
  let max = 0;
  loadWindField().forEach((r) => {
    const vec = windVectorKn(r);
    if (!vec) return;
    const { speedKn } = currentSpeedDir(vec);
    if (speedKn > max) max = speedKn;
  });
  cachedWindSpeedRange = { min: 0, max: Math.ceil(max) };
  return cachedWindSpeedRange;
}

// Wind vector accessor -- analogous to currentVectorKn() below, but wind
// records carry only one component pair (u_wind_kn/v_wind_kn, 10m only --
// no 5m/10m depth choice like the ocean current data has).
function windVectorKn(rec) {
  if (rec.u_wind_kn !== undefined && rec.v_wind_kn !== undefined) {
    return { eastKn: rec.u_wind_kn, northKn: rec.v_wind_kn };
  }
  return null;
}

// Prefers the near-surface (5m) velocity; falls back to 10m if 5m is
// missing/NaN at this point. Returns null if neither is available.
//
// 2026-08-05: gained a third branch for CIOPS-West records (the Port
// Hardy north-extension source, fetch_ciops_west_current() in
// fetch_model_data.py) -- distinct field names (VelEastCiops_kn/
// VelNorthCiops_kn, not VelEast5_kn/VelNorth5_kn) so this never silently
// blends a 0.5m CIOPS-West sample with a 5m/10m SalishSeaCast one under
// one label. `source` is set explicitly here ("SalishSeaCast" for the
// first two branches, "CIOPS-West" for the third) so callers that show
// depth (e.g. the point-query popup, the arrow tooltip) can show which
// model a given sample actually came from -- both a resolution caveat
// (2km vs ~500m) and an honesty check given CIOPS-West's own unconfirmed-
// axis-convention caveat (see CIOPS_WEST_CURRENT_VARS' comment in
// fetch_model_data.py).
function currentVectorKn(rec) {
  if (rec.VelEast5_kn !== undefined && rec.VelNorth5_kn !== undefined) {
    return { eastKn: rec.VelEast5_kn, northKn: rec.VelNorth5_kn, depth: "5m", source: "SalishSeaCast" };
  }
  if (rec.VelEast10_kn !== undefined && rec.VelNorth10_kn !== undefined) {
    return { eastKn: rec.VelEast10_kn, northKn: rec.VelNorth10_kn, depth: "10m", source: "SalishSeaCast" };
  }
  if (rec.VelEastCiops_kn !== undefined && rec.VelNorthCiops_kn !== undefined) {
    return { eastKn: rec.VelEastCiops_kn, northKn: rec.VelNorthCiops_kn, depth: "0.5m", source: "CIOPS-West" };
  }
  // 2026-08-06: DFO-gate synthetic node -- see buildDfoGateRecords()'s own
  // header comment. "depth" here isn't a real depth (this isn't a 3D model
  // sample) -- reused as the display slot every existing "(${vec.depth}...)"
  // caller already has, so this reads as "(CHS gate prediction, ...)"
  // rather than adding a whole new text field to every one of those call
  // sites.
  if (rec.VelEastDfo_kn !== undefined && rec.VelNorthDfo_kn !== undefined) {
    return { eastKn: rec.VelEastDfo_kn, northKn: rec.VelNorthDfo_kn, depth: "CHS gate prediction", source: "DFO-gate" };
  }
  return null;
}

// Converts an east/north component pair (knots) into speed + the compass
// direction the current is flowing TOWARD.
function currentSpeedDir(vec) {
  const speedKn = Math.sqrt(vec.eastKn ** 2 + vec.northKn ** 2);
  const mathAngle = Math.atan2(vec.northKn, vec.eastKn); // 0=east, CCW
  const dirDeg = (90 - toDeg(mathAngle) + 360) % 360; // compass bearing, CW from north
  return { speedKn, dirDeg };
}

// 2026-08-06: exact inverse of currentSpeedDir() above -- given a known
// speed and compass bearing (same TOWARD convention), reconstructs
// {eastKn, northKn}. Used only by buildDfoGateRecords() below, where the
// bearing is known (CHS's own published fixed flood/ebb "sets" --
// GATE_FLOOD_EBB_BEARINGS) but there's no raw east/north pair to derive it
// from the usual way (every other current source in this app already has
// real vector components; DFO's own data is speed-only).
function vectorFromSpeedDir(speedKn, dirDeg) {
  const mathAngle = (((90 - dirDeg + 360) % 360) * Math.PI) / 180;
  return { eastKn: speedKn * Math.cos(mathAngle), northKn: speedKn * Math.sin(mathAngle) };
}

// The opposite compass bearing (e.g. 270 -> 90). The wind ARROW itself is
// drawn pointing TOWARD (same "blowing/flowing TOWARD" convention shared by
// both the current and wind vector data, and the same convention the
// current arrows are drawn with) -- but this is still used for two
// FROM-facing things: (1) the feather marks on a wind arrow sweep back from
// the shaft's reciprocal bearing (see buildWindArrowLayer()), and (2) each
// wind arrow's popup/status text reports wind direction the way mariners
// actually speak it out loud ("a 15kn wind FROM the northwest"), even
// though the arrow drawn on the map points the opposite way, toward where
// the wind is going -- see renderWindArrowsOnMap()'s own comment.
function reciprocalBearingDeg(dirDeg) {
  return (dirDeg + 180) % 360;
}

// 2026-08-06, later session: real EC wind-station observations
// (fetch_wind_station_obs(), window.WIND_STATIONS_OBS_DATA) report
// direction as 16-point compass TEXT (e.g. "NW"), the FROM convention
// mariners speak wind in -- not degrees, unlike every other direction
// value in this app. Standard 16-point mapping, used only to let
// loadWindStations() draw a real directional arrow icon from the real
// observation (see that function's own comment) -- returns null for
// anything not an exact match (e.g. "calm", or a future EC page format
// change), never guesses.
const COMPASS_16_TO_DEG = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
function compassTextToDeg(text) {
  return COMPASS_16_TO_DEG[text] !== undefined ? COMPASS_16_TO_DEG[text] : null;
}

// Projects a current vector onto a course bearing: alongKn is the component
// helping (positive) or hindering (negative) travel along that course;
// crossKn is the component pushing sideways off it.
function projectOntoCourse(vec, courseBearingDeg) {
  const theta = (courseBearingDeg * Math.PI) / 180;
  const alongKn = vec.eastKn * Math.sin(theta) + vec.northKn * Math.cos(theta);
  const crossKn = vec.eastKn * Math.cos(theta) - vec.northKn * Math.sin(theta);
  return { alongKn, crossKn };
}

// Of all records at exactly one time value, returns the one closest to
// (lat, lon), plus that distance -- used both for leg-correction sampling
// and (indirectly) for the map-arrow display.
function nearestGridPoint(slice, lat, lon) {
  let best = null, bestKm = Infinity;
  slice.forEach((rec) => {
    const d = haversineKm({ lat, lon }, { lat: rec.lat, lon: rec.lon });
    if (d < bestKm) {
      bestKm = d;
      best = rec;
    }
  });
  return best ? { record: best, distKm: bestKm } : null;
}

// 2026-08-06: the gate station (if any) whose GATE_ZONE_RADIUS_KM zone
// (lat, lon) falls inside -- ties broken by whichever station is actually
// closest, though in practice the 4 zones don't overlap (stations are
// several km apart, radius 1.5km). Deliberately separate from
// nearestGridPoint() above (a generic, shared helper used by wind/wave too,
// which have no concept of a "gate zone") rather than teaching that
// function about gates -- see nearestCurrentPoint()'s own comment for how
// the two combine.
function findEnclosingGateZone(lat, lon) {
  const stations = (window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || [];
  let best = null, bestKm = Infinity;
  stations.forEach((st) => {
    const d = haversineKm({ lat, lon }, st);
    if (d <= GATE_ZONE_RADIUS_KM && d < bestKm) {
      bestKm = d;
      best = st;
    }
  });
  return best;
}

// 2026-08-06: gate-zone-aware current sample -- checks
// findEnclosingGateZone() FIRST and, if (lat, lon) falls inside one AND
// `records` actually contains that station's DFO-gate data, returns it
// REGARDLESS of whether some raw model cell in `records` happens to be
// geometrically closer still (the owner's own "bounding box at the Gate"
// design -- plain nearest-distance alone wouldn't reliably prefer the DFO
// node the moment you click anywhere other than the station's own exact
// coordinate, since real grid cells routinely sit within a few hundred
// meters of these stations too).
//
// Deliberately does its OWN independent nearest-time search scoped to just
// this one station's own DFO-gate records, rather than reusing whatever
// timeKey a caller already picked across the WHOLE mixed records array:
// DFO-gate records sit on CHS's own hourly grid (on-the-hour), not the raw
// model's (SalishSeaCast's own steps are offset to :30) -- a single
// "nearest time key across everything" pick would routinely land on a raw-
// model time the DFO-gate record doesn't share at all, silently hiding it
// from a plain slice-then-search. This sidesteps that by never slicing the
// mixed array in the first place for this branch.
//
// Returns null (not a zone, or the zone has no usable DFO-gate data for
// this station/time) -- callers fall through to their own normal raw-model
// lookup in that case. `records` gates whether this applies at all: pass
// loadCurrentField() (includes DFO-gate nodes) to get this behavior, or
// loadRawCurrentField() (excludes them) to guarantee it never fires --
// Verification's own sampling always does the latter, see
// buildCurrentVerificationPoints()'s own comment.
function sampleDfoGateNear(records, lat, lon, targetTime) {
  const zoneStation = findEnclosingGateZone(lat, lon);
  if (!zoneStation) return null;
  const dfoRecords = records.filter((r) => r.source === "DFO-gate" && r.lat === zoneStation.lat && r.lon === zoneStation.lon);
  if (!dfoRecords.length) return null;
  const timeKey = nearestTimeKey(dfoRecords, targetTime);
  if (!timeKey) return null;
  const rec = dfoRecords.find((r) => r.time === timeKey);
  const vec = currentVectorKn(rec);
  if (!vec) return null;
  const { speedKn, dirDeg } = currentSpeedDir(vec);
  return { timeKey, distKm: haversineKm({ lat, lon }, zoneStation), speedKn, dirDeg, vec };
}

// 2026-08-04: marks exactly where the point-query popup below is reporting
// on -- the owner's request for "a cursor to show where I clicked" (the
// popup itself opens slightly offset above the click, and it's easy to
// lose track of the exact point once the map's been panned/zoomed under
// it). Just one crosshair marker at a time -- re-set on every call, and
// removed when the popup it belongs to closes (see popup.on("remove", ...)
// below), so it never lingers or piles up across repeated clicks.
//
// 2026-08-07: also reused by handleVerificationPointClick() (owner's
// request: "highlight the location point" when a Verification graph
// click pans the map there) -- same variable/marker slot, so triggering
// either one clears/replaces whatever the other left behind, rather than
// two independent highlight markers persisting at once.
let queryPointMarker = null;

// Shared crosshair-marker builder for queryPointMarker -- originally
// inline in showPointQueryPopup() below, extracted 2026-08-07 so
// handleVerificationPointClick() can place the same visual mark without
// duplicating the icon HTML/CSS class wiring. Removed and re-added on
// every call rather than just moved, so there's never a stale marker left
// behind if a caller throws before reaching this point. interactive:
// false keeps it a pure visual indicator -- it must NOT swallow clicks
// meant for the map underneath (e.g. a station marker that happens to sit
// right under it, or the click that opens the next point query).
function showClickPointMarker(latlng) {
  if (queryPointMarker) {
    map.removeLayer(queryPointMarker);
    queryPointMarker = null;
  }
  queryPointMarker = L.marker(latlng, {
    icon: L.divIcon({
      className: "click-point-marker",
      html: `<div class="click-point-marker-inner"><div class="click-point-marker-ring"></div></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
}

// 2026-08-03: shift+click point query, per the owner's request -- shows the
// nearest current and wind readings (independently -- they're different
// grids, resolved separately) at wherever was clicked, at the snapshot
// nearest to now for each. Reuses the exact same nearest-neighbor machinery
// already used for leg ETA correction (nearestGridPoint()) and the arrow
// layers' time-slice selection (nearestSlice()) -- this is just those same
// lookups anchored at an arbitrary clicked point instead of a route
// waypoint or a data grid point. Read-only/informational: doesn't touch the
// route, doesn't write anywhere.
async function showPointQueryPopup(latlng) {
  const lines = [];
  // {gridX, gridY} for a SalishSeaCast point, OR {lat, lon} for a
  // CIOPS-West point (2026-08-05: that source has no gridX/gridY index
  // pair at all -- see showPointCurrentGraph()'s own updated comment for
  // why this can't just fall through to the gridX/gridY path with
  // undefined values, a real bug this anchor shape avoids). Set below if
  // a usable current sample was found.
  let currentGraphAnchor = null;

  // 2026-08-04, REAL BUG found by the owner: this popup's three
  // nearestSlice() calls below were never passed selectedFieldTime,
  // unlike renderCurrentArrowsOnMap()/renderWindArrowsOnMap()/
  // renderWaveMap() (see those functions' own calls), which all switched
  // to it when PageUp/PageDown time-stepping was added 2026-08-04. That
  // meant clicking the map for a point reading always showed the sample
  // nearest to real "now", even while PageUp/PageDown had the MAP itself
  // showing a different (scrubbed) time -- invisible for current/waves
  // (dense ~30min-native cadence, so "now" and a recently-scrubbed time
  // usually round to the same or an adjacent slice by coincidence) but
  // became visible for wind specifically once HRDPS_WIND_HOUR_STRIDE
  // thinning (same day) widened the gap between available slices. Root
  // cause was the same missing parameter on all three calls, not a
  // wind-only issue -- fixed by passing selectedFieldTime here too, same
  // as every map-layer renderer already does.
  const currentRecords = loadCurrentField();
  if (currentRecords.length) {
    // 2026-08-06: DFO-gate zone check first -- see sampleDfoGateNear()'s
    // own comment for why a click near one of the 4 gate stations should
    // report CHS's own prediction there instead of the nearest raw model
    // cell. gateZone non-null exactly when dfoSample is non-null (both
    // come from the same findEnclosingGateZone() check) -- computed once
    // here rather than twice, and reused below for the graph anchor.
    const gateZone = findEnclosingGateZone(latlng.lat, latlng.lng);
    const dfoSample = gateZone ? sampleDfoGateNear(currentRecords, latlng.lat, latlng.lng, selectedFieldTime || new Date()) : null;
    let timeKey, vec, distKm;
    if (dfoSample) {
      ({ timeKey, vec, distKm } = dfoSample);
      // 2026-08-05: CIOPS-West records have no gridX/gridY at all (see
      // this variable's own comment above) -- lat/lon anchor instead, same
      // pattern waveGraphAnchor/windGraphAnchor use. 2026-08-06: DFO-gate
      // records have no gridX/gridY either -- same lat/lon-anchor path,
      // which for a DFO-gate sample is the station's own coordinate (every
      // one of that station's DFO-gate records shares it exactly), so
      // "Show graph" plots that station's whole signed DFO series.
      currentGraphAnchor = { lat: gateZone.lat, lon: gateZone.lon };
    } else {
      const { timeKey: tk, slice } = nearestSlice(currentRecords, selectedFieldTime);
      const nearest = nearestGridPoint(slice, latlng.lat, latlng.lng);
      const inRange = nearest && nearest.distKm <= POINT_QUERY_MAX_KM;
      timeKey = tk;
      vec = inRange ? currentVectorKn(nearest.record) : null;
      distKm = inRange ? nearest.distKm : null;
      if (inRange) {
        currentGraphAnchor = (nearest.record.gridX !== undefined && nearest.record.gridY !== undefined)
          ? { gridX: nearest.record.gridX, gridY: nearest.record.gridY }
          : { lat: nearest.record.lat, lon: nearest.record.lon };
      }
    }
    if (vec) {
      const { speedKn, dirDeg } = currentSpeedDir(vec);
      const sourceNote =
        vec.source === "CIOPS-West" ? ", CIOPS-West — coarser 2km model"
        : vec.source === "DFO-gate" ? ", CHS/DFO gate prediction — not the raw model"
        : "";
      lines.push(
        `<strong>Current:</strong> ${speedKn.toFixed(2)} kn toward ${dirDeg.toFixed(0)}&deg; ` +
        `(${vec.depth}${sourceNote}, ${dfoSample ? "at" : "nearest sample"} ${distKm.toFixed(2)} km away, ${new Date(timeKey).toLocaleString()}) ` +
        `<button type="button" class="graph-link" data-show-current-graph>Show graph</button>`
      );
    } else {
      lines.push(`<strong>Current:</strong> no data within ${POINT_QUERY_MAX_KM} km.`);
    }
  } else {
    lines.push("<strong>Current:</strong> no data loaded.");
  }

  // windGraphAnchor is {lat, lon}, matched by exact equality -- same
  // pattern/reasoning as waveGraphAnchor below (the Datamart wind field has
  // no gridX/gridY index pair, see build_datamart_wind_field_js()'s
  // docstring), NOT the gridX/gridY pattern showPointCurrentGraph() uses.
  let windGraphAnchor = null;
  const windRecords = loadWindField();
  if (windRecords.length) {
    const { timeKey, slice } = nearestSlice(windRecords, selectedFieldTime);
    const nearest = nearestGridPoint(slice, latlng.lat, latlng.lng);
    const inRange = nearest && nearest.distKm <= POINT_QUERY_MAX_KM;
    const vec = inRange ? windVectorKn(nearest.record) : null;
    if (vec) {
      const { speedKn, dirDeg } = currentSpeedDir(vec);
      // Reported "FROM", not "toward" -- standard meteorological
      // convention (e.g. "wind from the SW at 15kn"), unlike the current
      // reading above, which stays "toward" (this app's convention for
      // current everywhere else). See reciprocalBearingDeg()'s own
      // comment.
      const fromDeg = reciprocalBearingDeg(dirDeg);
      windGraphAnchor = { lat: nearest.record.lat, lon: nearest.record.lon };
      lines.push(
        `<strong>Wind:</strong> ${speedKn.toFixed(2)} kn from ${fromDeg.toFixed(0)}&deg; ` +
        `(10m, nearest sample ${nearest.distKm.toFixed(2)} km away, ${new Date(timeKey).toLocaleString()}) ` +
        `<button type="button" class="graph-link" data-show-wind-graph>Show graph</button>`
      );
    } else {
      lines.push(`<strong>Wind:</strong> no data within ${POINT_QUERY_MAX_KM} km.`);
    }
  } else {
    lines.push("<strong>Wind:</strong> no data loaded.");
  }

  // 2026-08-03: waves. Scalar (hs, significant wave height), not a vector
  // like current/wind -- no direction, but a scalar graphs over time just
  // as well as a vector's speed component does (see showPointWaveGraph()
  // below) -- corrected after the owner pointed out the earlier "scalar so
  // no graph" framing was wrong. waveGraphAnchor is {lat, lon} (not
  // gridX/gridY -- this dataset has no such index pair, see
  // WAVE_DATASET_ID's own comment in fetch_model_data.py) of the nearest
  // usable point, used below to re-select the same point across all time
  // slices by exact lat/lon match (deterministic float parse from the same
  // ERDDAP coordinate-value query every time step, per
  // build_wave_field_js()).
  let waveGraphAnchor = null;
  const waveRecords = loadWaveField();
  if (waveRecords.length) {
    const { timeKey, slice } = nearestSlice(waveRecords, selectedFieldTime);
    const nearest = nearestGridPoint(slice, latlng.lat, latlng.lng);
    const inRange = nearest && nearest.distKm <= POINT_QUERY_MAX_KM;
    if (inRange && nearest.record.hs_m !== undefined) {
      waveGraphAnchor = { lat: nearest.record.lat, lon: nearest.record.lon };
      lines.push(
        `<strong>Waves:</strong> ${nearest.record.hs_m.toFixed(2)} m significant height ` +
        `(nearest sample ${nearest.distKm.toFixed(2)} km away, ${new Date(timeKey).toLocaleString()}) ` +
        `<button type="button" class="graph-link" data-show-wave-graph>Show graph</button>`
      );
    } else {
      lines.push(`<strong>Waves:</strong> no data within ${POINT_QUERY_MAX_KM} km.`);
    }
  } else {
    lines.push("<strong>Waves:</strong> no data loaded.");
  }

  if(landsatSstLayer){
    const data=selectedLandsatSst(),raw=data?await sampleLandsatSstAt(data,latlng.lat,latlng.lng):null;
    if(Number.isFinite(raw)){
      const slope=Number(document.getElementById("sst-slope")?.value||1),offset=Number(document.getElementById("sst-offset")?.value||0),displayed=raw*slope+offset;
      lines.push(`<strong>SST:</strong> ${displayed.toFixed(1)} &deg;C (satellite ${raw.toFixed(1)} &deg;C, ${mapPointEscape(formatSstSceneDate(data.acquired_at))}, ${mapPointEscape(data.scene_id)}).`);
    }else{lines.push("<strong>SST:</strong> no valid water-temperature pixel at this location in the displayed scene.");}
  }

  // 2026-08-04: click-location marker -- see showClickPointMarker()'s own
  // comment (below this function) for the shared implementation.
  showClickPointMarker(latlng);

  // 2026-08-04: className tags this specific popup so style.css can give
  // it a "move" cursor (and buttons inside it their normal pointer cursor
  // back) without touching every OTHER Leaflet popup in the app (the
  // current-arrow/calm/pennant/feather bindPopup() tooltips elsewhere are
  // NOT draggable and shouldn't look like they are) -- see the drag
  // wiring in the popupopen handler below, and its matching CSS rule.
  const popup = L.popup({ className: "point-query-popup" }).setLatLng(latlng).setContent(lines.join("<br>"));
  // Leaflet auto-closes any previously-open standalone popup (map.openPopup())
  // before opening a new one, so this "remove" listener also cleanly clears
  // THIS marker the moment a later click opens a fresh popup/marker pair of
  // its own, not just on an explicit close-button click.
  popup.on("remove", () => {
    if (queryPointMarker) {
      map.removeLayer(queryPointMarker);
      queryPointMarker = null;
    }
  });
  // "Show graph" (added 2026-08-03 for current/waves, 2026-08-04 for wind --
  // see showPointCurrentGraph()'s own comment) needs its click handler wired
  // AFTER the popup's HTML is actually in the DOM, which only happens once
  // Leaflet opens it -- map.once("popupopen", ...) registered before
  // openOn() below catches exactly that moment for this specific popup.
  map.once("popupopen", (e) => {
    const waveBtn = e.popup.getElement() && e.popup.getElement().querySelector("[data-show-wave-graph]");
    if (waveBtn && waveGraphAnchor) {
      waveBtn.addEventListener("click", () =>
        showPointWaveGraph(waveGraphAnchor.lat, waveGraphAnchor.lon, latlng)
      );
    }
    const btn = e.popup.getElement() && e.popup.getElement().querySelector("[data-show-current-graph]");
    if (btn && currentGraphAnchor) {
      btn.addEventListener("click", () => showPointCurrentGraph(currentGraphAnchor, latlng));
    }
    const windBtn = e.popup.getElement() && e.popup.getElement().querySelector("[data-show-wind-graph]");
    if (windBtn && windGraphAnchor) {
      windBtn.addEventListener("click", () =>
        showPointWindGraph(windGraphAnchor.lat, windGraphAnchor.lon, latlng)
      );
    }

    // 2026-08-04: draggable popup -- owner's request to move this box too,
    // not just the graph modals. Leaflet repositions a popup purely from
    // its latlng + options.offset (see Popup._updatePosition() in the
    // Leaflet source) -- NOT from a plain CSS transform we could just set
    // ourselves, so dragging here means nudging options.offset and asking
    // Leaflet to re-run its OWN positioning. Deliberately calling the
    // private _updatePosition() directly rather than the public update()
    // -- update() also calls _updateContent(), which re-sets
    // .leaflet-popup-content's innerHTML from scratch on every call and
    // would silently detach the Show-graph button listeners just wired
    // above (new DOM nodes, same HTML, no listeners) after the first drag.
    // _updatePosition() alone only touches position (left/bottom), so the
    // content and its listeners are left completely alone.
    const popupEl = e.popup.getElement();
    const wrapper = popupEl && popupEl.querySelector(".leaflet-popup-content-wrapper");
    if (wrapper) {
      const baseOffset = L.point(popup.options.offset || [0, 7]);
      let dragOffsetX = 0, dragOffsetY = 0;
      wrapper.addEventListener("mousedown", (ev) => {
        // Don't hijack Show-graph clicks -- the close button (a sibling of
        // this wrapper in Leaflet's own DOM structure, not a descendant)
        // is already outside this listener's reach and needs no such check.
        if (ev.target.closest("button")) return;
        ev.preventDefault();
        const startX = ev.clientX - dragOffsetX;
        const startY = ev.clientY - dragOffsetY;
        function onMove(mv) {
          dragOffsetX = mv.clientX - startX;
          dragOffsetY = mv.clientY - startY;
          popup.options.offset = L.point(baseOffset.x + dragOffsetX, baseOffset.y + dragOffsetY);
          popup._updatePosition();
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
  });
  popup.openOn(map);
}

// 2026-08-03: point-query graph, CURRENT ONLY for now -- the owner's
// stated end goal is current+wind+tide together, but current is the only
// one of the three with a dense-enough spatial grid AND a long enough time
// range (~41h, vs. wind's ~4h) to make a compelling graph on short notice.
// Wind would reuse this same approach almost exactly (see loadWindField()/
// windVectorKn()); tide is fundamentally different -- it's only defined at
// the 4 discrete CHS tide stations, not at an arbitrary clicked point, so
// showing it here would mean graphing the NEAREST STATION's real curve
// (already exactly what showTideGraph() does) rather than a true value at
// the click -- deliberately left out rather than guessed at, see
// README.md's backlog entry for the open question.
//
// gridX/gridY (not lat/lon) identify a SalishSeaCast point -- confirmed via
// a one-off node inspection of data/current_field.js this session that
// gridX/gridY are stable integers (stored as strings) identifying the same
// model grid cell across all ~42 time slices, whereas lat/lon are floats
// best not relied on for exact equality. latlng (the actual clicked point,
// not the grid point) is only used for the popup title and distance
// framing.
//
// 2026-08-05: anchor is now an OBJECT ({gridX, gridY} or {lat, lon}), not
// two positional gridX/gridY args -- CIOPS-West records (the Port Hardy
// north-extension source) have no gridX/gridY at all. Passing undefined
// through as gridX/gridY would have matched EVERY CIOPS-West record
// anywhere on the map (all sharing gridX===undefined/gridY===undefined),
// not just the one clicked point -- a real bug caught while wiring this
// up, not shipped. anchor.gridX!==undefined selects which match strategy
// to use; showPointQueryPopup() (this function's only caller) already
// builds the right shape per source -- see its own currentGraphAnchor
// comment.
//
// 2026-08-06: the match logic itself factored out to matchesCurrentAnchor()
// (just below) so sampleCurrentAtAnchor() -- the verification grid-point
// override's own pinned lookup -- can reuse the exact same anchor-shape
// rules instead of a second hand-copied version.
function showPointCurrentGraph(anchor, latlng) {
  const records = loadCurrentField();
  const series = records
    .filter((r) => matchesCurrentAnchor(r, anchor))
    .map((r) => {
      const vec = currentVectorKn(r);
      if (!vec) return null; // this time slice has no usable velocity at this point -- skip, don't plot a gap as zero
      return { x: new Date(r.time), y: currentSpeedDir(vec).speedKn, depth: vec.depth, source: vec.source };
    })
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);

  const title = `Current at ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  if (series.length < 2) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough current-field data on file to plot a graph.", 12, h / 2);
    }, "", null);
    return;
  }

  const timeBounds = { min: series[0].x, max: series[series.length - 1].x };
  openGraphPopup(
    title,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // "Now" marker reuses the exact same opts.markers mechanism as
      // showGateCurrentGraph()'s slack/max-ebb/max-flood lines -- just one
      // marker instead of several. 2026-08-04: computed HERE, inside
      // renderFn, from selectedFieldTime (falling back to real "now" when
      // live) rather than once outside as a fixed new Date() snapshot --
      // so it moves when refreshOpenGraphPopup() repaints this graph after
      // a PageUp/PageDown/Home time-step (see stepFieldTime()). 2026-08-05:
      // drawLineChart() itself now labels wherever the series crosses each
      // marker (see its own comment) -- no separate label code needed here.
      // 2026-08-07: no longer run through filterPointsByRange() -- `now:
      // true` lets drawLineChart() itself draw a flashing directional arrow
      // when this falls outside the plotted/zoomed window instead of just
      // vanishing (see drawNowArrow()'s own comment).
      const nowMarker = buildTimeMarkers();
      return drawLineChart(ctx, w, h, filterPointsByRange(series, rangeStart, rangeEnd), {
        color: "#185fa5", // same blue as the map's current arrows
        yUnitLabel: "kn",
        markers: nowMarker,
        yDomain: [currentSpeedRange().min, currentSpeedRange().max],
      });
    },
    // 2026-08-05: source name now reads from the actual sample (SalishSeaCast
    // or CIOPS-West) instead of a hardcoded "SalishSeaCast" -- this graph can
    // now be opened from either source's points (see showPointCurrentGraph()'s
    // own updated comment on the anchor-object change).
    // 2026-08-06: a third phrasing branch for DFO-gate anchors -- the
    // default "at the nearest X grid point" phrasing would read as "at the
    // nearest DFO-gate grid point," implying this is just another raw
    // model source picked by proximity, when it's actually CHS's own
    // per-station prediction, not a grid cell at all.
    (series[0].source === "DFO-gate"
      ? `CHS's own predicted current speed at this gate station (not a raw model grid cell -- see the Verification section for why this station gets its own real prediction instead)`
      : `Modeled current speed (magnitude only, ${series[0].depth} depth) at the nearest ${series[0].source || "SalishSeaCast"} grid point to where you clicked`) +
      `. Y-axis is fixed to the whole loaded field's own min/max speed, not autoscaled to this point, so graphs from different points are directly comparable. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window. Static pre-download (Section 8.1) — re-run the data pipeline to refresh. Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds
  );
}

// 2026-08-03: wave point-query graph. Reuses showPointCurrentGraph()'s
// exact machinery (openGraphPopup/drawLineChart/filterPointsByRange, "now"
// marker) -- a scalar (hs, significant wave height) plots over time just
// as well as current speed does; only difference from the current version
// is matching the anchor point by exact lat/lon equality instead of
// gridX/gridY, since the wave dataset has no such index pair (see
// showPointQueryPopup()'s waveGraphAnchor comment for why exact lat/lon
// match is safe here).
function showPointWaveGraph(lat, lon, latlng) {
  const records = loadWaveField();
  const series = records
    .filter((r) => r.lat === lat && r.lon === lon)
    .map((r) => {
      if (r.hs_m === undefined) return null; // this time slice has no usable value at this point -- skip, don't plot a gap as zero
      return { x: new Date(r.time), y: r.hs_m };
    })
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);

  const title = `Waves at ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  if (series.length < 2) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough wave-field data on file to plot a graph.", 12, h / 2);
    }, "", null);
    return;
  }

  const timeBounds = { min: series[0].x, max: series[series.length - 1].x };
  openGraphPopup(
    title,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-04: live "now" marker -- see showPointCurrentGraph()'s
      // matching comment for why this is computed inside renderFn now.
      // 2026-08-07: unfiltered + `now: true` -- see showPointCurrentGraph()'s
      // matching comment.
      const nowMarker = buildTimeMarkers();
      return drawLineChart(ctx, w, h, filterPointsByRange(series, rangeStart, rangeEnd), {
        color: "#0a7d7d", // distinct teal, not the current-blue or wind-* colors used elsewhere
        yUnitLabel: "m",
        markers: nowMarker,
        yDomain: [waveHeightRange().min, waveHeightRange().max],
      });
    },
    `Modeled significant wave height at the nearest SalishSeaCast WaveWatch III grid point to where you clicked. Y-axis is fixed to the whole loaded field's own min/max height, not autoscaled to this point, so graphs from different points are directly comparable. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window. Static pre-download (Section 8.1) — re-run the data pipeline to refresh. Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds
  );
}

// 2026-08-04: wind point-query graph -- owner's request, bringing wind's
// "Show graph" up to parity with current/waves (both already had one; wind
// was the last of the three still missing it). Reuses the exact same
// machinery as the two functions above (openGraphPopup()/drawLineChart()/
// filterPointsByRange(), "now" marker, fixed-Y-axis-via-*Range() pattern).
// Matched by exact lat/lon equality, same as showPointWaveGraph() and for
// the same reason -- the Datamart wind field has no gridX/gridY index pair
// (see build_datamart_wind_field_js()'s docstring in fetch_model_data.py),
// unlike the OLD SalishSeaCast-rebroadcast wind schema showPointCurrentGraph()'s
// gridX/gridY approach was built for. Plots SPEED only (not direction),
// same "magnitude only for now" scope showPointCurrentGraph() already has
// for current -- direction-on-graph is a separate, already-backlogged item
// for both (see README's "Backlog / ideas").
function showPointWindGraph(lat, lon, latlng, ecDetailHtml = "") {
  const records = loadWindField();
  const series = records
    .filter((r) => r.lat === lat && r.lon === lon)
    .map((r) => {
      const vec = windVectorKn(r);
      if (!vec) return null; // this time slice has no usable value at this point -- skip, don't plot a gap as zero
      return { x: new Date(r.time), y: currentSpeedDir(vec).speedKn };
    })
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);

  const title = `Wind at ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  if (series.length < 2) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough wind-field data on file to plot a graph.", 12, h / 2);
    }, "", null);
    return;
  }

  const timeBounds = { min: series[0].x, max: series[series.length - 1].x };
  const ecOverlay = marineForecastBarsForPoint(latlng.lat, latlng.lng);
  openGraphPopup(
    title,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-04: live "now" marker -- see showPointCurrentGraph()'s
      // matching comment for why this is computed inside renderFn now.
      const nowMarker = buildTimeMarkers();
      return drawLineChart(ctx, w, h, filterPointsByRange(series, rangeStart, rangeEnd), {
        color: WIND_ARROW_COLOR, // same muted gold as the map's wind arrows
        yUnitLabel: "kn",
        markers: nowMarker,
        yDomain: [windSpeedRange().min, windSpeedRange().max],
        barOverlays: ecOverlay.bars,
      });
    },
    `Modeled 10m wind speed (magnitude only, direction not plotted) at the nearest HRDPS grid point to where you clicked. Y-axis is fixed to the whole loaded field's own min/max speed, not autoscaled to this point, so graphs from different points are directly comparable. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window. Static pre-download — re-run the data pipeline to refresh. Note: HRDPS_WIND_HOUR_STRIDE thins the time axis by default (every 2nd forecast hour) — this graph will look coarser than current/waves' own graphs unless "Full hourly wind resolution" was checked on the last refresh. Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds,
    ecDetailHtml,
    ecDetailHtml ? "graph-modal-ec" : ""
  );
}

// 2026-08-06: real observation history for one wind station -- owner's
// report ("I can't plot shore station or buoy data - the window always
// goes to the nearest model data"). Reads window.WIND_VERIFICATION_LOG_DATA
// (data/wind_verification_log.js), the same accumulating obs/model log the
// Verification scatter already uses -- plots the REAL obs_speed_kn side of
// each logged pair over time (fetched_at), not the model side. Only ever
// called when there are >=2 real entries for this station (see
// loadWindStations()'s own click handler) -- with fewer than that there's
// nothing real yet to plot.
function showWindStationObsGraph(station) {
  const log = window.WIND_VERIFICATION_LOG_DATA;
  const pts = ((log && log.entries) || [])
    .filter((e) => e.station_id === station.id && typeof e.obs_speed_kn === "number")
    .map((e) => ({ x: new Date(e.fetched_at), y: e.obs_speed_kn }))
    .sort((a, b) => a.x - b.x);

  const title = `${station.name} — real observation history`;
  const timeBounds = { min: pts[0].x, max: pts[pts.length - 1].x };
  openGraphPopup(
    title,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-07, owner's request ("Show NOW vertical dashed line in Buoy
      // and shore station winds, to emphasize this is historical") -- this
      // graph is a real observation LOG (one point per past "Refresh data"
      // run), unlike the model point-query graphs it's otherwise styled to
      // match; it never had a live/map-time marker at all before. Same
      // `now: true`/unfiltered-markers convention as those graphs (see
      // showPointCurrentGraph()'s comment) -- most useful here specifically,
      // since this log's own newest point is very often well behind real
      // "now" (only updated on refresh, not continuously), so the flashing
      // out-of-range arrow will show up routinely, not just occasionally.
      const nowMarker = buildTimeMarkers();
      return drawLineChart(ctx, w, h, filterPointsByRange(pts, rangeStart, rangeEnd), {
        color: WIND_STATION_COLOR,
        yUnitLabel: "kn",
        markers: nowMarker,
      });
    },
    `Real wind speed observed at ${station.name} (weather.gc.ca), one point per "Refresh data" run so far (${pts.length} logged) -- not a forecast, what was actually measured each time. Not fixed to a Y-axis shared with other graphs. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window (routine here, since this log only advances on "Refresh data," not continuously). Drag the Start/End sliders below to zoom.`,
    timeBounds
  );
}

// Of all distinct time values present in records, returns the one closest
// to targetTime. The dataset is a static, bounded snapshot (see header
// comment) -- if targetTime is well outside its window, this still returns
// the nearest edge value, which callers should treat with reduced
// confidence (not flagged separately here; the snapshot-date caveat is
// shown in the UI regardless).
function nearestTimeKey(records, targetTime) {
  const uniqueTimes = [...new Set(records.map((r) => r.time))];
  if (uniqueTimes.length === 0) return null;
  let best = uniqueTimes[0];
  let bestDiff = Math.abs(new Date(uniqueTimes[0]) - targetTime);
  for (const t of uniqueTimes) {
    const diff = Math.abs(new Date(t) - targetTime);
    if (diff < bestDiff) {
      best = t;
      bestDiff = diff;
    }
  }
  return best;
}

// Nearest-neighbor current sample at (lat, lon) and targetTime: finds the
// closest available time step, then the closest grid point within it,
// rejecting anything beyond CURRENT_SAMPLE_MAX_KM (see that constant's
// comment) or with no usable velocity. Shared by renderLegs()'s per-leg ETA
// sample and renderGroundTrackArrows()'s multiple per-position samples, so
// both use identical logic rather than two hand-maintained copies of it.
function sampleCurrentNear(records, lat, lon, targetTime) {
  if (!records.length) return null;
  // 2026-08-06: DFO-gate zone check first -- see sampleDfoGateNear()'s own
  // comment for why this can't just be folded into the generic
  // nearestTimeKey()/nearestGridPoint() pipeline below. Only ever fires
  // when `records` actually contains DFO-gate data (i.e. the caller passed
  // loadCurrentField(), not loadRawCurrentField()) -- Verification's own
  // callers pass the raw variant specifically to stay excluded, see
  // buildCurrentVerificationPoints()'s own comment.
  const dfoSample = sampleDfoGateNear(records, lat, lon, targetTime);
  if (dfoSample) return dfoSample;
  const timeKey = nearestTimeKey(records, targetTime);
  if (!timeKey) return null;
  const slice = records.filter((r) => r.time === timeKey);
  const nearest = nearestGridPoint(slice, lat, lon);
  if (!nearest || nearest.distKm > CURRENT_SAMPLE_MAX_KM) return null;
  const vec = currentVectorKn(nearest.record);
  if (!vec) return null;
  const { speedKn, dirDeg } = currentSpeedDir(vec);
  return { timeKey, distKm: nearest.distKm, speedKn, dirDeg, vec };
}

// 2026-08-06: shared by showPointCurrentGraph() (an arbitrary clicked point)
// and sampleCurrentAtAnchor() below (a verification override's pinned
// point) -- one real grid cell identified either by its stable SalishSeaCast
// {gridX, gridY} index pair, or by exact {lat, lon} equality for CIOPS-West
// records, which carry no grid index at all (see showPointCurrentGraph()'s
// own longer-standing comment on why the two sources need different match
// strategies).
function matchesCurrentAnchor(r, anchor) {
  return anchor.gridX !== undefined
    ? r.gridX === anchor.gridX && r.gridY === anchor.gridY
    : r.lat === anchor.lat && r.lon === anchor.lon;
}

// Pinned-point analogue of sampleCurrentNear() above, added 2026-08-06 for
// the current-verification grid-point override (owner's request after
// finding buildCurrentVerificationPoints()'s automatic nearest-point pick
// can land in a hydrodynamically wrong cell in a narrow gate/pass --
// confirmed for real at Dodd Narrows: the nearest valid SalishSeaCast cell
// there reads ~0.06kn, essentially slack water, almost certainly an
// eddy/backwater cell next to the real channel rather than the channel
// itself, since Dodd Narrows itself runs up to ~9kn). Finds the nearest
// time step exactly like sampleCurrentNear(), but then requires an EXACT
// match against the one chosen cell (matchesCurrentAnchor()) instead of a
// fresh nearest-neighbor search at each hour -- the whole point of an
// override is "always this one real cell," not "whichever happens to be
// closest this hour." Returns null if that exact cell has no usable
// velocity at this time slice -- normally can't happen (land/water masking
// is static per cell) but stays a possibility if a later pipeline refresh
// changed the field's own point layout under an old saved override, so
// callers already treat a null return as "skip this point," same as
// sampleCurrentNear().
function sampleCurrentAtAnchor(records, anchor, targetTime) {
  if (!records.length) return null;
  const timeKey = nearestTimeKey(records, targetTime);
  if (!timeKey) return null;
  const rec = records.find((r) => r.time === timeKey && matchesCurrentAnchor(r, anchor));
  if (!rec) return null;
  const vec = currentVectorKn(rec);
  if (!vec) return null;
  const { speedKn, dirDeg } = currentSpeedDir(vec);
  return { timeKey, distKm: 0, speedKn, dirDeg, vec, pinned: true };
}

// Wind analogue of sampleCurrentNear() above, added 2026-08-05 for
// windStationModelHtml()'s shore-wind-station "second data source" line --
// same nearest-time/nearest-grid-point logic, just windVectorKn() instead
// of currentVectorKn() and WIND_STATION_SAMPLE_MAX_KM instead of
// CURRENT_SAMPLE_MAX_KM (see that constant's own comment for why the bound
// differs). dirDeg here follows the same "TOWARD" convention as
// currentSpeedDir() (see that function's own comment) -- callers that want
// the FROM convention mariners speak wind in should apply
// reciprocalBearingDeg() themselves, same as renderWindArrowsOnMap() does.
function sampleWindNear(records, lat, lon, targetTime) {
  if (!records.length) return null;
  const timeKey = nearestTimeKey(records, targetTime);
  if (!timeKey) return null;
  const slice = records.filter((r) => r.time === timeKey);
  const nearest = nearestGridPoint(slice, lat, lon);
  if (!nearest || nearest.distKm > WIND_STATION_SAMPLE_MAX_KM) return null;
  const vec = windVectorKn(nearest.record);
  if (!vec) return null;
  const { speedKn, dirDeg } = currentSpeedDir(vec);
  return { timeKey, distKm: nearest.distKm, speedKn, dirDeg, vec };
}

// Wave analogue of sampleCurrentNear()/sampleWindNear() above, added
// 2026-08-05 for renderLegs()'s per-leg forecast reporting. Scalar (hs_m,
// significant wave height in meters), not a vector -- no direction/dirDeg
// (the wave field this app loads has no direction variable yet, see
// README's backlog: "other WaveWatch III variables"). Same nearest-time/
// nearest-grid-point logic as the other two, just WAVE_SAMPLE_MAX_KM as the
// distance bound (this dataset's own, denser, native spacing -- see that
// constant's own comment).
function sampleWaveNear(records, lat, lon, targetTime) {
  if (!records.length) return null;
  const timeKey = nearestTimeKey(records, targetTime);
  if (!timeKey) return null;
  const slice = records.filter((r) => r.time === timeKey);
  const nearest = nearestGridPoint(slice, lat, lon);
  if (!nearest || nearest.distKm > WAVE_SAMPLE_MAX_KM) return null;
  if (nearest.record.hs_m === undefined) return null;
  return { timeKey, distKm: nearest.distKm, hsM: nearest.record.hs_m };
}

// Given the boat's own speed through water (along courseBearingDeg) and a
// sampled current vector, returns the resultant over-the-ground speed and
// direction (current only, not wind), plus the along/cross-track
// components used for the ETA correction and drift note. Correctly
// resolves to a reciprocal-ish bearing when the current overpowers the
// boat (effectiveSpeed negative) rather than producing a nonsensical
// result -- atan2 handles that quadrant correctly on its own.
function computeResultantGroundTrack(speedThroughWater, courseBearingDeg, vec) {
  const { alongKn, crossKn } = projectOntoCourse(vec, courseBearingDeg);
  const effectiveSpeed = speedThroughWater + alongKn;
  const groundSpeedKn = Math.sqrt(effectiveSpeed ** 2 + crossKn ** 2);
  const groundBearingDeg = (courseBearingDeg + toDeg(Math.atan2(crossKn, effectiveSpeed)) + 360) % 360;
  return { alongKn, crossKn, effectiveSpeed, groundSpeedKn, groundBearingDeg };
}

// 2026-08-05: shared by renderLegs() (the ETA number) and
// renderGroundTrackArrows() (the visual chain) -- one code path for both,
// not two hand-maintained copies of the same leeway math (this project
// deliberately avoids that duplication class elsewhere too, e.g. the
// time-scrubber's refreshFieldTimeDependents()). Combines a current sample
// and a leeway-scaled CROSSWIND-only wind contribution into one
// over-the-ground drift vector at (lat, lon, targetTime) relative to
// courseBearingDeg.
//
// Wind doesn't carry a boat at its own full speed the way current does --
// only the component of wind CROSSWISE to courseBearingDeg contributes
// (the standard simplified leeway model: dead-ahead/astern wind gives ~zero
// leeway, a beam wind gives the most), scaled by leewayPercent (0 = wind
// excluded entirely). `projectOntoCourse()`'s own crossKn is exactly
// windSpeedKn x sin(windDir - courseBearing) -- the angle-dependence this
// was built for falls out of that existing helper, not a new formula.
// leewayCrossKn is then re-expressed as an east/north vector along the
// course's own perpendicular (starboard) axis, since leeway is a purely
// CROSS-track slip through the water, not a push in the wind's own
// direction, before being added to the current vector.
//
// Returns null only when there's truly nothing to apply (no current sample
// AND no wind-leeway contribution) -- callers should fall back to pure
// through-water course/speed in that case, same as the pre-existing
// current-only behavior did when no current sample was found.
function sampleCombinedDrift(currentRecords, windRecords, lat, lon, targetTime, courseBearingDeg, leewayPercent) {
  const currentSample = sampleCurrentNear(currentRecords, lat, lon, targetTime);
  const windSample = sampleWindNear(windRecords, lat, lon, targetTime);
  let windCrossKn = 0, leewayCrossKn = 0;
  if (windSample && leewayPercent) {
    windCrossKn = projectOntoCourse(windSample.vec, courseBearingDeg).crossKn;
    leewayCrossKn = windCrossKn * (leewayPercent / 100);
  }
  // Epsilon, not exact-zero -- courseBearingDeg comes from real great-
  // circle geometry (bearingDeg()), so a genuinely dead-ahead/astern wind
  // resolves to something like 1e-14, not exactly 0. Caught this via this
  // feature's own verification harness (a synthetic east-west route's real
  // bearing wasn't exactly 90°) -- see README's changelog entry for detail.
  if (!currentSample && Math.abs(leewayCrossKn) < 1e-6) return null;
  const cVec = currentSample ? currentSample.vec : { eastKn: 0, northKn: 0 };
  const theta = (courseBearingDeg * Math.PI) / 180;
  const leewayVec = { eastKn: leewayCrossKn * Math.cos(theta), northKn: -leewayCrossKn * Math.sin(theta) };
  const vec = { eastKn: cVec.eastKn + leewayVec.eastKn, northKn: cVec.northKn + leewayVec.northKn };
  return { vec, currentSample, windSample, windCrossKn, leewayCrossKn };
}

// Builds the "second data source" line shown in a gate station's popup and
// in gate warnings: a SalishSeaCast model sample at that station's exact
// coordinates, at targetTime. Deliberately labeled as a separate source, not
// a comparison against the CHS harmonic prediction shown alongside it (that
// question was closed in Section 6.7). Reuses sampleCurrentNear() -- same
// nearest-neighbor/CURRENT_SAMPLE_MAX_KM logic as everything else that reads
// the current field, so this isn't a fourth hand-written lookup.
// 2026-08-06: both callers below deliberately pass loadRawCurrentField(),
// NOT loadCurrentField() -- this text's whole framing is "a SEPARATE data
// source, for comparison against the CHS prediction shown right above it"
// (see the return string below); if a gate-zone query silently swapped in
// the DFO-gate node here, that sentence would become actively false (it's
// no longer separate, it's derived FROM that same CHS prediction). The new
// DFO-gate blending is deliberately surfaced through OTHER interrogation
// paths instead (point-query clicks, ETA/ground-track sampling,
// showPointQueryPopup()'s "Show graph") -- this specific text keeps its
// original, still-accurate job: the raw model's own independent read.
function gateStationModelHtml(station, records, targetTime) {
  if (!records.length) {
    return "SalishSeaCast model at this station: not loaded (run scripts/fetch_model_data.py).";
  }
  const sample = sampleCurrentNear(records, station.lat, station.lon, targetTime);
  if (!sample) {
    return `SalishSeaCast model at this station: no sample within ${CURRENT_SAMPLE_MAX_KM} km.`;
  }
  return (
    `SalishSeaCast model at this station (separate data source, not the CHS ` +
    `harmonic prediction above): ${sample.speedKn.toFixed(2)} kn toward ${sample.dirDeg.toFixed(0)}&deg; ` +
    `(${sample.distKm.toFixed(1)} km away, snapshot ${new Date(sample.timeKey).toLocaleString()}).`
  );
  // 2026-08-06: deliberately kept text-only, no embedded button -- this
  // helper is reused in TWO different DOM contexts (loadGateStations()'s
  // Leaflet tooltip, renderWarnings()'s plain sidebar HTML), each with its
  // own click-wiring mechanism. An embedded button here would render fine
  // in both but only ever be wired up in whichever caller happened to
  // remember to wire it -- a real "looks clickable, silently does nothing"
  // trap in the other one. Each caller below builds and wires its own
  // "Show E/W & N/S graph" button instead (see showGateCurrentComponentsGraph()).
}

// Wind-station analogue of gateStationModelHtml() -- but inverted, since
// here the REAL observation (window.WIND_STATIONS_OBS_DATA, scraped by
// fetch_wind_station_obs()) is the primary line and the HRDPS model sample
// (sampleWindNear()) is the "second data source." Both are shown together
// in a wind station's hover tooltip so the owner can compare model vs.
// real obs at a glance, per his explicit request ("I will want to compare
// the model with the real wind obs") when this feature was scoped.
// Direction is reported two different ways because the two sources give it
// two different ways: the real observation is EC's own compass-text FROM
// convention (e.g. "NW"), already what mariners expect and not converted;
// the modeled sample follows this app's usual TOWARD-convention degrees
// (see currentSpeedDir()'s own comment) with reciprocalBearingDeg() applied
// so it reads as a FROM bearing too, for a fair, like-for-like comparison.
function windStationModelHtml(station, obsData, windRecords, targetTime) {
  const obs = obsData && obsData.stations ? obsData.stations[station.id] : null;
  const sample = windRecords.length ? sampleWindNear(windRecords, station.lat, station.lon, targetTime) : null;

  // 2026-08-07, owner's request: "when real observation time and model
  // time do not coincide or overlap, bold flash the times for each of
  // them." Same model-hour-bucket comparison pickWindStationArrowVector()
  // uses -- see parseObsTimeLocal()'s own comment for why this station's
  // own obs_time_local (not the whole-scrape's shared obsData.fetched_at)
  // is the right, more accurate time to compare against; a mismatch here
  // between the DISPLAYED obs/model times is exactly what this flash is
  // meant to flag, so the more accurate per-station time matters more here
  // than anywhere else it's used. Falls back to fetched_at only if this
  // station's own time string didn't parse. Only meaningful when both a
  // real obs and a model sample actually exist -- nothing to compare
  // otherwise.
  const obsOwnTime = obs && (parseObsTimeLocal(obs.obs_time_local) || (obsData.fetched_at ? new Date(obsData.fetched_at) : null));
  const timesMismatch =
    !!(obs && obs.ok && obsOwnTime && sample && windRecords.length &&
      sample.timeKey !== nearestTimeKey(windRecords, obsOwnTime));
  const flashTime = (text) => (timesMismatch ? `<strong class="time-mismatch-flash">${text}</strong>` : text);

  let obsHtml;
  if (!obsData) {
    obsHtml = "Real observation: not loaded (run scripts/fetch_model_data.py).";
  } else if (!obs || !obs.ok) {
    obsHtml = `Real observation: fetch failed for this station in the last pipeline run${obs && obs.error ? ` (${obs.error})` : ""}.`;
  } else if (obs.dir_compass === "calm") {
    obsHtml = `Real observation (weather.gc.ca): calm (${flashTime(obs.obs_time_local)}).`;
  } else {
    const gustNote = obs.gust_kn != null ? `, gusts ${obs.gust_kn.toFixed(0)} kn` : "";
    obsHtml = `Real observation (weather.gc.ca): ${obs.speed_kn.toFixed(0)} kn${gustNote} from ${obs.dir_compass} (${flashTime(obs.obs_time_local)}).`;
  }
  if (obs && obs.ok && typeof obs.water_temp_c === "number") {
    obsHtml += `<br><strong>Water temperature: ${obs.water_temp_c.toFixed(1)} &deg;C</strong> (buoy observation).`;
  }

  let modelHtml;
  if (!windRecords.length) {
    modelHtml = "HRDPS model at this station: not loaded (run scripts/fetch_model_data.py).";
  } else if (!sample) {
    modelHtml = `HRDPS model at this station: no sample within ${WIND_STATION_SAMPLE_MAX_KM} km.`;
  } else {
    const fromDeg = reciprocalBearingDeg(sample.dirDeg);
    modelHtml = `HRDPS model at this station (separate data source): ${sample.speedKn.toFixed(2)} kn from ${fromDeg.toFixed(0)}&deg; ` +
      `(${sample.distKm.toFixed(1)} km away, snapshot ${flashTime(new Date(sample.timeKey).toLocaleString())}).`;
  }
  return `${obsHtml}<br>${modelHtml}`;
}

function loadGateStations() {
  // Reads from window.GATE_STATIONS_DATA, set by data/gate_stations.js
  // (a plain <script> tag, loaded before this file). Deliberately NOT a
  // fetch() of a JSON file: browsers block fetch() of local files under the
  // file:// origin, which broke this when opened by double-clicking
  // index.html directly rather than through a local server. This form works
  // either way.
  //
  // 2026-08-01: rebuilds a layer group (gateStationLayer) rather than adding
  // markers straight to the map, and now also samples the current field for
  // each station (gateStationModelHtml()) -- both changes needed so
  // refreshDataFiles() can call this again after a pipeline re-run without
  // duplicating markers or showing a stale model sample.
  //
  // 2026-08-05: `now` renamed in spirit only (still named `now` -- see
  // below) but now reads selectedFieldTime first -- completes the full
  // time-scrubber's "Scope of effect" decision (README.md), which
  // explicitly named gate/tide station tooltip "model sample" text as one
  // of the things the scrubbed time should drive, alongside current/wind
  // arrows, the heat map, and the point-query popup (all already wired
  // 2026-08-04). This function is re-run by refreshFieldTimeDependents()
  // on every scrub step/slider move, same as those.
  const data = window.GATE_STATIONS_DATA;
  if (!data) {
    console.error("GATE_STATIONS_DATA missing — check that data/gate_stations.js loaded before app.js.");
    return;
  }
  // gateStations/warningRadiusKm are populated UNCONDITIONALLY, even when
  // the map layer below is gated off -- renderWarnings()'s own leg/gate-
  // proximity check (a safety feature, not a map decoration) reads these
  // two module-level vars directly and would silently go empty/no-op if
  // this function bailed out before reaching them. Only the VISIBLE layer
  // (station dots + red click boxes) is gated on gateBoxesEnabled below.
  gateStations = data.stations;
  warningRadiusKm = data.warning_radius_km || 1.5;

  // 2026-08-06, later session (owner's request: "Gate boxes off by
  // default, on when button clicked") -- see gateBoxesEnabled's own
  // comment for the full reasoning, including why the DFO-gate current
  // ARROWS (a separate function, renderCurrentArrowsOnMap()) are tied to
  // this same flag. Same guard shape as loadTideStations()'s own
  // tideStationsEnabled guard -- just placed AFTER the two data-only
  // assignments above, not before, for the reason given in that comment.
  if (!gateBoxesEnabled) {
    if (gateStationLayer) {
      map.removeLayer(gateStationLayer);
      gateStationLayer = null;
    }
    return;
  }

  if (gateStationLayer) map.removeLayer(gateStationLayer);
  gateStationLayer = L.layerGroup();

  const currentRecords = loadRawCurrentField(); // see gateStationModelHtml()'s own comment for why raw, not loadCurrentField()
  const now = selectedFieldTime || new Date();
  gateStations.forEach((s) => {
    const modelHtml = gateStationModelHtml(s, currentRecords, now);
    // 2026-08-02: clicking the marker now opens the current-speed graph
    // directly (showGateCurrentGraph()) -- per the owner's feedback that
    // clicking the map icon, not a sidebar button, is the expected way to
    // reach it. The name/CHS id/model-sample text that used to live in a
    // click-triggered Leaflet popup is now a hover tooltip instead
    // (bindTooltip(), opens on mouseover, doesn't consume the click), so
    // that information isn't lost -- it's just reached a different way.
    // 2026-08-06: {interactive: true} -- the tooltip's HTML now includes a
    // "Show E/W & N/S graph" button (showGateCurrentComponentsGraph());
    // Leaflet tooltips default to interactive:false (mouse events pass
    // straight through, so no button inside one is ever clickable) -- this
    // opts just the gate-station tooltip in. Doesn't change hover-to-open/
    // mouseout-to-close behavior, it only makes the tooltip's own content
    // receive clicks once open. The button markup is built HERE, not
    // inside gateStationModelHtml() -- that helper is reused in a second,
    // non-tooltip DOM context (renderWarnings()) with its own separate
    // click-wiring below, see its own comment for why.
    const tooltipHtml =
      `<strong>${s.name}</strong><br>CHS station ${s.id}<br>${modelHtml}` +
      `<br><button type="button" class="graph-link" data-show-current-components>Show E/W &amp; N/S graph</button>`;
    const marker = L.circleMarker([s.lat, s.lon], {
      // 2026-08-06, later session (owner's request): half of
      // STATION_MARKER_RADIUS_PX now, decoupled from tide/wind-fallback
      // markers -- see that constant's own comment. fillOpacity 1 (was
      // 0.8) per the owner's explicit "solid circle" wording.
      radius: GATE_STATION_MARKER_RADIUS_PX,
      stroke: false,
      fillColor: "#e07a5f",
      fillOpacity: 1,
    })
      .bindTooltip(tooltipHtml, { interactive: true })
      .on("click", () => showGateCurrentGraph(s))
      .addTo(gateStationLayer);
    // Wired on every "tooltipopen" (not just once) since Leaflet rebuilds
    // the tooltip's DOM content fresh each time it opens -- a listener
    // attached only at marker-creation time would target a node that's
    // already gone by the time the owner actually hovers. Closured over
    // `s` (this station) from the forEach above, so each marker's button
    // opens exactly its own station's graph -- no shared/global lookup
    // needed, unlike the point-query popup's anchor pattern (that one's
    // click location varies per open, this one doesn't).
    marker.on("tooltipopen", () => {
      const el = marker.getTooltip() && marker.getTooltip().getElement();
      const btn = el && el.querySelector("[data-show-current-components]");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation(); // don't also trigger the marker's own click-opens-CHS-graph handler
          showGateCurrentComponentsGraph(s);
        });
      }
    });
    // 2026-08-06: owner's request -- outline the DFO-gate "bounding box"
    // (GATE_ZONE_RADIUS_KM, see its own header comment) directly on the
    // map, since it's already the real area both the gate/pass warnings
    // and the DFO-gate zone-priority sampling use, just never drawn. A
    // square (not a circle) per the owner's own "red box" wording -- side
    // length 2x the radius, corners placed via destinationPoint() at 45/
    // 225deg so it's centered on the station without a second geometry
    // helper.
    // 2026-08-06, later session (owner's request): "click within the Gate
    // box, calls up the graph" -- was `fill: false, interactive: false`
    // (a thin reference outline only). Now `fill: true, fillOpacity: 0`
    // + `interactive: true` -- NOT `fill: false` -- per this exact
    // codebase's own documented Leaflet gotcha (see HANDOFF.md/
    // CHANGELOG.md, marine-zone "Clear" status round): `fill: false`
    // stops a shape's INTERIOR from registering clicks in Leaflet's SVG
    // renderer, only the outline would respond; `fillOpacity: 0` stays
    // visually invisible while keeping the whole box clickable. Same
    // showGateCurrentGraph(s) the small station marker's own click
    // already opens -- one graph, two ways to reach it (the marker dot
    // is now quite small, see GATE_STATION_MARKER_RADIUS_PX -- the box
    // gives a much bigger real click target).
    const zoneDiagKm = GATE_ZONE_RADIUS_KM * Math.SQRT2;
    const zoneNe = destinationPoint(s, 45, zoneDiagKm);
    const zoneSw = destinationPoint(s, 225, zoneDiagKm);
    L.rectangle([[zoneSw.lat, zoneSw.lon], [zoneNe.lat, zoneNe.lon]], {
      color: "#c0392b",
      weight: 1.5,
      fill: true,
      fillOpacity: 0,
      interactive: true,
    })
      .on("click", () => {
        showGateCurrentGraph(s);
        // 2026-08-06, later session (owner's mid-turn follow-up: "Click
        // within the Gate box, calls up the graph AND the arrow") --
        // also opens the DFO-gate arrow's own popup (same text its own
        // shapes show on a direct click), reading it from
        // dfoGateArrowInfoByStationId (populated by
        // renderCurrentArrowsOnMap()'s own DFO-gate pass -- own comment
        // there for why this is a lookup, not a live layer reference).
        // Silently does nothing extra if that pass hasn't populated this
        // station yet (e.g. current arrows toggled off, or no CHS sample
        // this run) -- the graph above still opens either way.
        const info = dfoGateArrowInfoByStationId[s.id];
        if (info) {
          L.popup().setLatLng([info.latlng.lat, info.latlng.lon]).setContent(info.html).openOn(map);
        }
      })
      .addTo(gateStationLayer);
  });
  gateStationLayer.addTo(map);
}

function loadGatePredictions() {
  // Reads window.GATE_PREDICTIONS_DATA, set by data/gate_predictions.js
  // (same plain-<script> convention as gate_stations.js, no fetch()).
  // Optional: the app still works with proximity-only warnings if this
  // file is missing or a station has no entry/no events.
  //
  // 2026-08-01: the file's shape changed from a flat {code: {...}} dict to
  // {generated_at, valid_from, valid_to, stations: {code: {...}}} so
  // staleness can be checked (see dataFreshnessInfo()/renderDataFreshness()).
  // Unwrapped here so existing callers (predictions[station.id]) don't need
  // to change.
  //
  // 2026-08-01 (later): found this session -- the actual data/gate_predictions.js
  // committed in the project folder still has the OLD flat shape (predates
  // the pipeline's switch to the wrapped one; it's a static file this
  // sandbox can't regenerate, since only Gary's son can run the pipeline).
  // Before this fix, `data.stations` was silently undefined on that file,
  // so this always returned {} -- meaning every "Next: slack/max ebb/flood
  // at..." lookup (gate/pass warnings AND the sidebar station list) was
  // silently empty even though the event data was right there. Now accepts
  // either shape: unwrap .stations if present, else check whether `data`
  // itself already looks like a {code: {events: [...]}} map.
  const data = window.GATE_PREDICTIONS_DATA;
  if (!data) return {};
  if (data.stations) return data.stations;
  const looksFlat = Object.values(data).some((v) => v && typeof v === "object" && Array.isArray(v.events));
  return looksFlat ? data : {};
}

// Reads window.TIDE_STATIONS_DATA, set by data/tide_stations.js (same
// plain-<script>, hand-edited, no-fetch() convention as gate_stations.js --
// see that file's own header comment for why). A DIFFERENT set of CHS
// stations from gateStations -- tide (water level) and current predictions
// are not necessarily available at the same station -- so this is tracked
// entirely separately (own array, own layer group, own sidebar section),
// not merged into gateStations.
function loadTideStations() {
  // 2026-08-06, later session (owner's request): off by default now --
  // same tideStationsEnabled guard shape as loadWindStations()'s own
  // windStationsEnabled guard just below (remove any existing layer, bail
  // out before touching window.TIDE_STATIONS_DATA at all).
  if (!tideStationsEnabled && !tideHeightEnabled && !tideContoursEnabled && !tideHeatMapEnabled) {
    if (tideStationLayer) {
      map.removeLayer(tideStationLayer);
      tideStationLayer = null;
    }
    if (tideContourLayer) {
      map.removeLayer(tideContourLayer);
      tideContourLayer = null;
    }
    if (tideHeatMapLayer) {
      map.removeLayer(tideHeatMapLayer);
      tideHeatMapLayer = null;
    }
    renderMapLegend();
    return;
  }
  const data = window.TIDE_STATIONS_DATA;
  if (!data) {
    console.error("TIDE_STATIONS_DATA missing — check that data/tide_stations.js loaded before app.js.");
    return;
  }
  tideStations = data.stations;

  if (tideStationLayer) map.removeLayer(tideStationLayer);
  tideStationLayer = L.layerGroup();

  const predictions = loadTidePredictions();
  // 2026-08-05: reads selectedFieldTime first -- see loadGateStations()'s
  // matching comment. "Next" tide event is now relative to the scrubbed
  // time when one is set (so scrubbing forward shows what's next AT that
  // future point, not what's next from real "now"), real "now" otherwise.
  const now = selectedFieldTime || new Date();
  tideStations.forEach((s) => {
    const stationPred = predictions[s.id];
    const tideHeight = tideHeightAt(stationPred, now);
    let eventsHtml = "CHS tide predictions: not loaded (run scripts/fetch_model_data.py).";
    if (stationPred && stationPred.ok && stationPred.events && stationPred.events.length) {
      const next = findNextEvents(stationPred.events, now);
      eventsHtml = next.length
        ? "Next: " + next.map(formatTideEvent).join(", ")
        : "No tide events on file at/after now — the snapshot may not cover today.";
    } else if (stationPred && stationPred.ok === false) {
      eventsHtml = "CHS tide predictions: fetch failed for this station in the last pipeline run.";
    }
    // 2026-08-02: clicking the marker now opens the tide-cycle graph
    // directly (showTideGraph()) -- per the owner's feedback that clicking
    // the map icon, not a sidebar button, is the expected way to reach it.
    // The name/CHS id/next-event text that used to live in a click-triggered
    // Leaflet popup is now a hover tooltip instead (bindTooltip(), opens on
    // mouseover, doesn't consume the click), so that information isn't lost.
    // 2026-08-06, later session (owner's request, "make Tide station icons
    // the same size as other icons"): matched to GATE_STATION_MARKER_RADIUS_PX
    // (3px) at the time.
    // 2026-08-07, later session (owner's request): "Tide station symbols 3X
    // larger at all zooms" -- now TIDE_STATION_MARKER_RADIUS_PX (9px, =
    // GATE_STATION_MARKER_RADIUS_PX * 3, see that constant's own comment),
    // deliberately breaking from the "match other icons" sizing again, this
    // time on purpose.
    if (!tideStationsEnabled && !tideHeightEnabled) return;
    const marker = tideHeightEnabled && tideHeight !== null
      ? L.marker(offsetMapPoint(s, "tide-height"), {
          icon: buildTideHeightIcon(tideHeight),
          keyboard: true,
          title: `${s.name}: ${tideHeight.toFixed(1)} m`,
        })
      : L.circleMarker([s.lat, s.lon], {
          radius: TIDE_STATION_MARKER_RADIUS_PX,
          stroke: false,
          fillColor: TIDE_STATION_FILL_COLOR,
          fillOpacity: 0.8,
        });
    marker
      .bindTooltip(`<strong>${s.name}</strong><br>CHS station ${s.id}<br>${tideHeight !== null ? `Height: ${tideHeight.toFixed(1)} m at ${now.toLocaleString()}<br>` : ""}${eventsHtml}`)
      .on("click", () => showTideGraph(s))
      .addTo(tideStationLayer);
  });
  renderTideHeatMap(predictions, now);
  renderTideContours(predictions, now);
  tideStationLayer.addTo(map);
  renderMapLegend();
}

function tideHeightAt(stationPred, targetTime) {
  if (!stationPred || !stationPred.ok || !Array.isArray(stationPred.events) || stationPred.events.length < 2) return null;
  const curve = interpolateTideCurve(stationPred.events, 24);
  const targetMs = targetTime.getTime();
  if (targetMs < curve[0].x.getTime() || targetMs > curve[curve.length - 1].x.getTime()) return null;
  return interpolateYAtTime(curve, targetMs);
}

function buildTideHeightIcon(heightM) {
  const gradient = HEATMAP_GRADIENTS[tideHeightGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  const color = colorForFraction(gradient, heightM / TIDE_HEIGHT_MAX_M);
  const size = Math.max(12, Math.min(80, mapTuningEntry("tide-height").diameter));
  const fontSize = Math.max(8, Math.min(16, size * 0.32));
  const tuning = mapTuningEntry("tide-height");
  const html = `<span class="tide-height-badge" style="background:${color};width:${size}px;height:${size}px;min-width:${size}px;font-size:${fontSize}px"><span class="tide-height-value" style="transform:translate(${Number(tuning.labelX) || 0}px,${Number(tuning.labelY) || 0}px)">${heightM.toFixed(1)}</span></span>`;
  return L.divIcon({ className: "tide-height-marker", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function tideSpatialSamples(predictions, targetTime) {
  return tideStations.map((s) => {
    const height = tideHeightAt(predictions[s.id], targetTime);
    return height === null ? null : { lat: s.lat, lon: s.lon, height };
  }).filter(Boolean);
}

function estimateTideHeight(samples, lat, lon) {
  const ranked = samples.map((s) => ({ s, d: Math.max(0.5, haversineKm({ lat, lon }, s)) }))
    .sort((a, b) => a.d - b.d).slice(0, 6);
  if (!ranked.length || ranked[0].d > 60) return null;
  let weighted = 0, weights = 0;
  ranked.forEach(({ s, d }) => { const w = 1 / (d * d); weighted += s.height * w; weights += w; });
  return weighted / weights;
}

function renderTideHeatMap(predictions, targetTime) {
  if (tideHeatMapLayer) {
    map.removeLayer(tideHeatMapLayer);
    tideHeatMapLayer = null;
  }
  if (!tideHeatMapEnabled) return;
  const samples = tideSpatialSamples(predictions, targetTime);
  if (samples.length < 3) return;
  const bounds = map.getBounds();
  const rows = 32, cols = 32;
  const latStep = (bounds.getNorth() - bounds.getSouth()) / rows;
  const lonStep = (bounds.getEast() - bounds.getWest()) / cols;
  const gradient = HEATMAP_GRADIENTS[tideHeightGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  const renderer = L.canvas({ padding: 0.1 });
  tideHeatMapLayer = L.layerGroup();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const south = bounds.getSouth() + r * latStep;
    const west = bounds.getWest() + c * lonStep;
    const centerLat = south + latStep / 2;
    const centerLon = west + lonStep / 2;
    if (!isMarineWater(centerLat, centerLon)) continue;
    const value = estimateTideHeight(samples, centerLat, centerLon);
    if (value === null) continue;
    const color = colorForFraction(gradient, value / TIDE_HEIGHT_MAX_M);
    L.rectangle([[south, west], [south + latStep, west + lonStep]], {
      renderer, stroke: false, fillColor: color, fillOpacity: 0.48, interactive: false,
    }).addTo(tideHeatMapLayer);
  }
  tideHeatMapLayer.addTo(map);
  clipRendererToMarineWater(renderer);
}

// Draw approximate tide-height isolines from the discrete CHS stations.
// Inverse-distance weighting is deliberately limited to locations within
// 60 km of a contributing station to avoid presenting distant extrapolation.
function renderTideContours(predictions, targetTime) {
  if (tideContourLayer) {
    map.removeLayer(tideContourLayer);
    tideContourLayer = null;
  }
  if (!tideContoursEnabled) return;
  const samples = tideSpatialSamples(predictions, targetTime);
  if (samples.length < 3) return;

  const bounds = map.getBounds();
  const rows = 32, cols = 32;
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const lat = bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * r / rows;
    const row = [];
    for (let c = 0; c <= cols; c++) {
      const lon = bounds.getWest() + (bounds.getEast() - bounds.getWest()) * c / cols;
      row.push({ lat, lon, value: estimateTideHeight(samples, lat, lon) });
    }
    grid.push(row);
  }
  const gradient = HEATMAP_GRADIENTS[tideHeightGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  tideContourLayer = L.layerGroup();
  const interpolateEdge = (a, b, level) => {
    const f = (level - a.value) / (b.value - a.value);
    return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
  };
  for (let level = 0.5; level < TIDE_HEIGHT_MAX_M; level += 0.5) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const corners = [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]];
      if (corners.some((p) => p.value === null)) continue;
      const crossings = [];
      for (let e = 0; e < 4; e++) {
        const a = corners[e], b = corners[(e + 1) % 4];
        if ((a.value < level && b.value >= level) || (b.value < level && a.value >= level)) crossings.push(interpolateEdge(a, b, level));
      }
      const color = colorForFraction(gradient, level / TIDE_HEIGHT_MAX_M);
      if (crossings.length === 2) L.polyline(crossings, { color, weight: 2, opacity: 0.8, interactive: false }).addTo(tideContourLayer);
      else if (crossings.length === 4) {
        L.polyline([crossings[0], crossings[1]], { color, weight: 2, opacity: 0.8, interactive: false }).addTo(tideContourLayer);
        L.polyline([crossings[2], crossings[3]], { color, weight: 2, opacity: 0.8, interactive: false }).addTo(tideContourLayer);
      }
    }
  }
  tideContourLayer.addTo(map);
}

// Reads window.WIND_STATIONS_DATA, set by data/wind_stations.js (same
// hand-edited, no-fetch() convention as gate_stations.js/tide_stations.js
// -- see that file's own header comment for the full station list and
// coordinate sourcing). Added 2026-08-05 for the owner's "add shore
// stations with wind data for Canadian waters north of Brentwood and south
// of Port Hardy" request. A third, separately-tracked station set (own
// array, own layer group) -- not merged into gateStations/tideStations,
// same reasoning loadTideStations()'s own comment gives for keeping THOSE
// two apart: different station networks, different data.
//
// Clicking a marker opens the existing point-query wind graph
// (showPointWindGraph()) at the nearest HRDPS grid point to the station --
// reuses that graph wholesale rather than building a new graph type, since
// the real observation is a single live snapshot (no time series to plot;
// see fetch_wind_station_obs()'s own comment), while the modeled field
// DOES have one. The hover tooltip (windStationModelHtml()) carries the
// real-observation snapshot alongside a same-moment modeled sample, so
// both data sources are visible without opening anything.
// 2026-08-06, later session: used to bind a hover tooltip + click handler
// onto every leaf shape of a Canvas-rendered buildWindArrowLayer() group
// (recursing into its nested shaft+head layerGroup). REMOVED 2026-08-07:
// loadWindStations() no longer draws stations with buildWindArrowLayer()
// at all -- every station is one plain DOM marker now (buildWindArrowIconSvg(),
// see loadWindStations()'s own comment), which gets hover/click directly
// via .bindTooltip()/.on("click") with no per-leaf-shape recursion needed.
// That technology swap is itself the fix for the owner's "provides data on
// hover or click, but not when zoomed in" report -- a single DOM element's
// hover/click is simple and reliable at any zoom, unlike hit-testing across
// several Canvas leaf shapes.

// 2026-08-06, later session (owner's request): picks the best available
// real direction+speed for a station's arrow icon -- the real observation
// (dir_compass text, FROM convention) when it's usable, else the HRDPS
// model sample (already TOWARD-degrees) as a fallback, matching
// windStationModelHtml()'s own "real obs is primary, model is the second
// source" priority. Returns null when neither gives a usable direction
// (station fetch failed, or a real "calm" reading with no model sample to
// fall back to) -- caller draws a plain dot in that case, same as before
// this feature existed.
//
// 2026-08-07, owner's follow-up: the popup screenshot showed a real obs
// (8:00 AM) and model sample (10:00 AM) two hours apart with no flash --
// because the comparison below originally used `obsData.fetched_at` (when
// the PIPELINE last ran the scrape), not the station's own actual reading
// time -- those two can legitimately differ (a buoy can report a reading
// older than the fetch itself). Fixed by parsing `obs.obs_time_local`
// directly: its format is fixed and known (`_WIND_OBS_TIME_RE` in
// fetch_model_data.py: "HH:MM AM/PM ZZZ DD Month YYYY", e.g. "08:00 AM PDT
// 07 August 2026") -- this pipeline's OWN scrape output, not arbitrary
// third-party text, so a targeted regex is safe here even though that
// field's own header comment elsewhere calls it "not reliably parseable"
// in the general sense (true for arbitrary text, not for this fixed
// format). Only PST/PDT are mapped (the only zones any station in this
// app's Pacific-coast scope reports in) -- an unrecognized/missing
// abbreviation returns null rather than guessing, so callers fall back to
// `obsData.fetched_at` as before rather than silently mis-converting.
const WIND_OBS_TZ_OFFSET_HOURS = { PST: -8, PDT: -7 };
const WIND_OBS_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function parseObsTimeLocal(text) {
  if (!text) return null;
  const m = /^(\d{1,2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,4})\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const offsetHours = WIND_OBS_TZ_OFFSET_HOURS[m[4]];
  const monthIdx = WIND_OBS_MONTHS.indexOf(m[6]);
  if (offsetHours === undefined || monthIdx === -1) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3] === "PM") hour += 12;
  const utcMs = Date.UTC(parseInt(m[7], 10), monthIdx, parseInt(m[5], 10), hour, parseInt(m[2], 10)) - offsetHours * 3600000;
  return new Date(utcMs);
}

// 2026-08-07, owner's report ("Buoy/shore station wind icons do not update
// when map time changes") -- confirmed real: the real observation
// (obsData) is always a single LIVE snapshot (see fetch_wind_station_obs()'s
// own comment), not a time series, so preferring it unconditionally meant
// the icon never visibly moved with the time scrubber. First fix (same
// day) gated the real-obs branch on `isLive` (selectedFieldTime === null).
// REFINED same day, owner's follow-up ("show real observation when model
// time is the same as the real data observation time, otherwise do not
// show real observation icons"): `isLive` removed -- replaced by comparing
// which MODEL time step (nearestTimeKey(), the same nearest-hour bucketing
// sampleWindNear() itself uses) is nearest to the currently-displayed
// targetTime vs. nearest to the obs's own real reading time. Prefers this
// STATION'S OWN `obs.obs_time_local` (parseObsTimeLocal(), above -- the
// more accurate, per-station value) over the whole-scrape's shared
// `obsData.fetched_at`, falling back to fetched_at only if that station's
// own time string didn't parse. Millisecond equality would essentially
// never match (a real reading time is an arbitrary real-world timestamp,
// not an hourly model step), so "same" means "both land in the same model
// hour bucket," not exact equality. Falls through to the model sample AT
// targetTime otherwise -- showing the live obs at a DIFFERENT model time,
// unlabeled as such, would misrepresent a single present-moment reading as
// if it were that other time's own value. If the model has no sample
// there either (station falls all the way through), returns null same as
// before -- the caller's plain-dot fallback, not a stale/misleading
// obs-based arrow.
function pickWindStationArrowVector(station, obsData, windRecords, targetTime) {
  const obsAtStation = obsData && obsData.stations ? obsData.stations[station.id] : null;
  const obsOwnTime = (obsAtStation && parseObsTimeLocal(obsAtStation.obs_time_local)) ||
    (obsData && obsData.fetched_at ? new Date(obsData.fetched_at) : null);
  const obsIsCurrentModelTime =
    obsOwnTime &&
    windRecords.length > 0 &&
    nearestTimeKey(windRecords, targetTime) === nearestTimeKey(windRecords, obsOwnTime);
  if (obsIsCurrentModelTime && obsAtStation && obsAtStation.ok && obsAtStation.dir_compass && obsAtStation.dir_compass !== "calm") {
    const fromDeg = compassTextToDeg(obsAtStation.dir_compass);
    if (fromDeg !== null && typeof obsAtStation.speed_kn === "number") {
      return { speedKn: obsAtStation.speed_kn, dirDeg: reciprocalBearingDeg(fromDeg), source: "obs" };
    }
  }
  const modelSample = sampleWindNear(windRecords, station.lat, station.lon, targetTime);
  if (modelSample) {
    return { speedKn: modelSample.speedKn, dirDeg: modelSample.dirDeg, source: "model" };
  }
  return null;
}

// Reads window.WIND_STATIONS_DATA, set by data/wind_stations.js (same
// hand-edited, no-fetch() convention as gate_stations.js/tide_stations.js
// -- see that file's own header comment for the full station list and
// coordinate sourcing). Added 2026-08-05 for the owner's "add shore
// stations with wind data for Canadian waters north of Brentwood and south
// of Port Hardy" request. A third, separately-tracked station set (own
// array, own layer group) -- not merged into gateStations/tideStations,
// same reasoning loadTideStations()'s own comment gives for keeping THOSE
// two apart: different station networks, different data.
//
// Clicking a marker opens the existing point-query wind graph
// (showPointWindGraph()) at the nearest HRDPS grid point to the station --
// reuses that graph wholesale rather than building a new graph type, since
// the real observation is a single live snapshot (no time series to plot;
// see fetch_wind_station_obs()'s own comment), while the modeled field
// DOES have one. The hover tooltip (windStationModelHtml()) carries the
// real-observation snapshot alongside a same-moment modeled sample, so
// both data sources are visible without opening anything.
//
// 2026-08-06, later session (owner's request, two changes): (1) off by
// default now -- windStationsEnabled guard below, same convention as
// every other map overlay; (2) each station now draws as a real
// directional wind-arrow icon (pickWindStationArrowVector() above +
// buildWindArrowLayer() -- SAME fixed-length/feather-encoded style as the
// field "Wind arrows" layer, just WIND_STATION_ARROW_WEIGHT_MULTIPLIER
// (3x) thicker, per the owner's explicit "back to same length/knot as
// Wind arrows, but 3x fatter" -- see that constant's own comment for the
// two earlier designs this superseded) instead of a plain dot -- the old
// dot is kept ONLY as the fallback for a station with no usable direction
// from either source (pickWindStationArrowVector() returned null).
// 2026-08-06, real bug the owner caught: this always opened the MODEL
// graph at the nearest grid point, never the station's own real data --
// "I can't plot shore station or buoy data." Now opens the real
// accumulated observation history (showWindStationObsGraph(),
// data/wind_verification_log.js) when there's enough of it logged; only
// falls back to the model graph when there isn't (a station with fewer
// than 2 real logged readings has nothing real to plot yet).
//
// 2026-08-07, owner's request: "Allow the user to query the buoy and shore
// station wind." Before this, a click on a station marker jumped straight
// to the full time-series graph (openWindStationGraph() below) -- the
// hover tooltip (windStationModelHtml()) was the only "just show me the
// current reading" path, which doesn't work at all on touch (no hover) and
// meant a full graph modal just to read one number on desktop too. This
// gives clicking its own lightweight popup instead -- same real-obs/model
// content the tooltip already shows, plus a "Show graph" button for the
// existing time-series view -- same two-tier "quick popup now, graph one
// click further" pattern showPointQueryPopup() already uses for arbitrary
// map-click queries (own "Show graph" buttons + deferred click wiring via
// map.once("popupopen", ...), same reason: the button doesn't exist in the
// DOM to attach a listener to until Leaflet actually renders the popup).
// Plain (non-draggable) popup -- NOT the "point-query-popup" className
// showPointQueryPopup() uses, since that class's CSS assumes the matching
// drag-wiring this function doesn't duplicate; reusing just the class
// without the wiring would show a "move" cursor for a popup that doesn't
// actually move.
function showWindStationQueryPopup(station) {
  const obsData = window.WIND_STATIONS_OBS_DATA || null;
  const windRecords = loadWindField();
  const now = selectedFieldTime || new Date();
  const tooltipHtml = windStationModelHtml(station, obsData, windRecords, now);
  const content =
    `<strong>${station.name}</strong><br>EC station ${station.id}<br>${tooltipHtml}` +
    `<br><button type="button" class="graph-link" data-show-wind-station-graph>Show graph</button>`;
  const popup = L.popup().setLatLng([station.lat, station.lon]).setContent(content);
  map.once("popupopen", (e) => {
    const btn = e.popup.getElement() && e.popup.getElement().querySelector("[data-show-wind-station-graph]");
    if (btn) btn.addEventListener("click", () => openWindStationGraph(station));
  });
  popup.openOn(map);
}

// 2026-08-07: extracted out of loadWindStations()'s own marker onClick
// (still reached from showWindStationQueryPopup()'s own "Show graph"
// button above, via a marker's real click) so
// handleVerificationPointClick() can call it too, for the Verification
// section's "click a point -> open that station's own graph" request --
// same graph either way a station gets reached from.
function openWindStationGraph(station) {
  const log = window.WIND_VERIFICATION_LOG_DATA;
  const realCount = ((log && log.entries) || []).filter(
    (e) => e.station_id === station.id && typeof e.obs_speed_kn === "number"
  ).length;
  if (realCount >= 2) {
    showWindStationObsGraph(station);
    return;
  }
  const windRecords = loadWindField();
  const { slice } = nearestSlice(windRecords, selectedFieldTime || new Date());
  const nearest = nearestGridPoint(slice, station.lat, station.lon);
  if (nearest) {
    showPointWindGraph(nearest.record.lat, nearest.record.lon, { lat: station.lat, lng: station.lon });
  }
}

function loadWindStations() {
  if (!windStationsEnabled) {
    if (windStationLayer) {
      map.removeLayer(windStationLayer);
      windStationLayer = null;
    }
    clearVerificationHighlight();
    return;
  }
  const data = window.WIND_STATIONS_DATA;
  if (!data) {
    console.error("WIND_STATIONS_DATA missing — check that data/wind_stations.js loaded before app.js.");
    return;
  }
  windStations = data.stations;

  if (windStationLayer) map.removeLayer(windStationLayer);
  // Every station now carries its own single red circle. Remove the older
  // verification-ring layer so it cannot draw a second circle around each.
  clearVerificationHighlight();
  windStationLayer = L.layerGroup();

  const obsData = window.WIND_STATIONS_OBS_DATA || null;
  const windRecords = loadWindField();
  // 2026-08-05: reads selectedFieldTime first -- see loadGateStations()'s
  // matching comment. The tooltip's own modeled-HRDPS half
  // (sampleWindNear()) moves with the scrubber; its real-obs half is
  // always a single live snapshot regardless (see fetch_wind_station_obs()'s
  // own comment), so that half's TEXT stays whatever it is on disk either
  // way -- shown alongside the model figure specifically so both are
  // visible, not one silently swapped for the other. `isLive` (2026-08-07,
  // see pickWindStationArrowVector()'s own comment) is what actually
  // changes now: the ARROW ICON itself uses the real obs only while
  // selectedFieldTime is null (real "now"), and the model sample at any
  // other scrubbed time -- fixing the owner's "icons do not update when
  // map time changes" report.
  const now = selectedFieldTime || new Date();
  // 2026-08-07: every station -- at every zoom -- draws as ONE plain DOM
  // marker (L.marker + divIcon) wrapping a screen-space SVG wind-arrow icon
  // (buildWindArrowIconSvg()) for reliable hover/click at any size. Icon
  // size is now computed PER STATION inside the loop below
  // (windStationIconSizePx(s.lat)) -- see that function's own comment --
  // since it depends on each station's own latitude, not a single global
  // value.
  windStations.forEach((s) => {
    const tooltipHtml = windStationModelHtml(s, obsData, windRecords, now);
    // 2026-08-07: opens a lightweight query popup (real-obs/model reading +
    // a "Show graph" button) rather than jumping straight to the full
    // graph -- see showWindStationQueryPopup()'s own comment. The graph
    // itself is still one click further, via that popup's button ->
    // openWindStationGraph() (also still reachable directly from the
    // Verification section's own point-click handler,
    // handleVerificationPointClick()).
    const onClick = () => showWindStationQueryPopup(s);

    const vector = pickWindStationArrowVector(s, obsData, windRecords, now);
    const sourceNote = vector ? ` (${vector.source === "obs" ? "real observation" : "modeled"})` : "";
    const fullTooltipHtml = `<strong>${s.name}</strong><br>EC station ${s.id}${sourceNote}<br>${tooltipHtml}`;

    if (vector) {
      // Use the exact same geographic arrow builder, length and weight as
      // the modelled wind field. The black station circle below supplies a
      // reliable hover/click target independently of the arrow geometry.
      const stationWindTuning = mapTuningEntry("wind-arrows");
      const stationLengthMultiplier = Math.max(0.5, Number(stationWindTuning.arrowLength ?? 100) / 100);
      const stationThicknessMultiplier = Math.max(1, Number(stationWindTuning.arrowThickness ?? 1));
      buildWindArrowLayer(
        { lat: s.lat, lon: s.lon }, vector.dirDeg, vector.speedKn,
        WIND_STATION_COLOR, null, {}, stationThicknessMultiplier,
        stationLengthMultiplier
      ).addTo(windStationLayer);
    }

    // One circular target per station, drawn after the arrow so stations
    // such as Fanny Island remain unmistakably highlighted.
    L.circleMarker([s.lat, s.lon], {
      pane: "markerPane",
      radius: STATION_MARKER_RADIUS_PX + 5,
      color: "#c0392b",
      weight: 3,
      opacity: 1,
      fill: false,
    })
      .bindTooltip(fullTooltipHtml)
      .on("click", onClick)
      .addTo(windStationLayer);
  });
  windStationLayer.addTo(map);
}

// Reads window.TIDE_PREDICTIONS_DATA, set by data/tide_predictions.js (same
// convention as gate_predictions.js). Unwraps .stations -- there's no
// legacy flat-shape tide_predictions.js in this project (unlike
// gate_predictions.js, see loadGatePredictions()'s comment), since this file
// didn't exist before the wrapped shape did, but this stays defensive about
// a missing/malformed file the same way loadGatePredictions() does.
function loadTidePredictions() {
  const data = window.TIDE_PREDICTIONS_DATA;
  if (!data) return {};
  return data.stations || {};
}

// Formats one tide event for display -- the tide-prediction analogue of
// formatEvent() (which is current-gate-specific: SLACK/EXTREMA_EBB/
// EXTREMA_FLOOD + speed_kn). Height is shown in meters (chart datum), per
// CHS convention -- see fetch_model_data.py's build_tide_predictions_js().
// An "unknown" type (see _classify_hilo_events()'s doc for when this can
// happen -- only at the ragged edge of a very narrow snapshot window)
// still shows the height, just without a High/Low label.
function formatTideEvent(e) {
  const t = new Date(e.time);
  const label = e.type === "unknown" ? "tide event" : e.type.toLowerCase() + " tide";
  return `${label} (${e.height_m.toFixed(2)} m) at ${t.toLocaleString()}`;
}

// --- Reusable popup graph tool (2026-08-02) ---
// A small, dependency-free modal overlay + canvas line-chart renderer.
// First used below for the tide-cycle chart (showTideGraph()) and the gate
// current-cycle chart (showGateCurrentGraph()), but openGraphPopup() itself
// is generic -- just a title, a draw callback, and an optional note -- so a
// future graph (e.g. a fuel-burn or wind chart, per the Section 10.6
// backlog) can reuse it without touching this code. Deliberately NOT a CDN
// chart library: consistent with the rest of SAILVu's offline-first, no-
// new-dependency approach (the heat map went through the opposite journey --
// built on Leaflet.heat, then rebuilt without it -- see that history in
// app.js's top-of-file comments/README.md).
// 2026-08-06, owner's request: graphs are no longer one shared, reused
// modal (which meant opening a second graph silently replaced whatever
// was already showing) -- every openGraphPopup() call now builds its own
// independent modal element, stays open until its own "Cancel" button is
// clicked, and any number can be on screen at once. openGraphModals[]
// tracks every currently-open one ({overlay, redraw}) so
// refreshOpenGraphPopup() (the map time-scrubber's live-update hook) can
// repaint ALL of them, not just a single tracked instance.
let openGraphModals = [];
// How many graphs have been opened this session -- used only to cascade
// each new graph's starting position a little further down/right than the
// last (see openGraphPopup()), so opening several doesn't just stack them
// exactly on top of each other at screen center. Never reset/decremented
// (not tied to how many are still open), so positions keep advancing even
// as older graphs are cancelled.
let graphCascadeCount = 0;

// 2026-08-07, owner's request: "where NOW is before or after the period of
// the data insert a flashing arrow pointing in the direction of NOW." A
// graph's "now"/"map time" marker (any opts.markers entry with `now: true`
// -- see drawLineChart()/drawMultiLineChart()'s own comment) used to simply
// not draw at all once its time fell outside the plotted window, no visual
// cue that it existed off-screen. `nowArrowBlinkOn` toggles on a plain
// interval (not tied to any specific graph) and drives drawNowArrow()'s
// own on/off frames below -- same "toggle a state, redraw" mechanism this
// app already uses for CSS flashes (`.ec-title-flash`/`.refresh-flash-red`
// in style.css), just via a canvas redraw instead of a CSS animation,
// since this arrow is drawn on the graph's own canvas, not a separate DOM
// element. Runs unconditionally (not started/stopped per-graph) -- the
// actual per-frame cost is a no-op forEach over openGraphModals[] whenever
// none are open, negligible even continuously.
let nowArrowBlinkOn = true;
setInterval(() => {
  nowArrowBlinkOn = !nowArrowBlinkOn;
  refreshOpenGraphPopup();
}, 550); // ~1.1s full on/off cycle, matching ec-title-flash's own period

// Draws a small flashing triangle at the plot's left or right edge, pointing
// further in that direction, for a `now: true` marker (see
// drawLineChart()/drawMultiLineChart()'s own comment) whose real time falls
// outside the currently plotted window -- "the data doesn't reach NOW (or
// NOW isn't in the zoomed-to range), but NOW is over that way." Only draws
// on "on" frames (nowArrowBlinkOn) -- the caller still calls this every
// redraw either way, so the "off" frames naturally just skip drawing,
// producing the flash via the same periodic redraw the marker line itself
// already gets (refreshOpenGraphPopup(), above). `direction`: "before" (off
// the LEFT edge -- NOW is earlier than everything plotted) or "after" (off
// the RIGHT edge -- NOW is later). `label` reuses the marker's own label
// ("Map time"/"Now") when it has one, else a plain "NOW".
function drawNowArrow(ctx, direction, pad, plotW, plotH, color, label) {
  if (!nowArrowBlinkOn) return;
  const y = pad.top + plotH / 2;
  const size = 9;
  const x = direction === "before" ? pad.left : pad.left + plotW;
  const dx = direction === "before" ? -1 : 1;
  ctx.fillStyle = color || "#a33";
  ctx.beginPath();
  ctx.moveTo(x + dx * size, y);
  ctx.lineTo(x, y - size * 0.65);
  ctx.lineTo(x, y + size * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.font = "9px sans-serif";
  ctx.textAlign = direction === "before" ? "left" : "right";
  ctx.textBaseline = "middle";
  ctx.fillText(label || "MAP", x + dx * (size + 3), y);
}

// 2026-08-07, owner's request: split the single "now"/"map time" marker
// into two -- MAP (dashed, follows the scrubber, same as before, now
// always labeled "MAP" not conditionally "Now") and NOW (solid, always
// real new Date(), new -- so a scrubbed view still shows where real "now"
// actually is). Both flagged `now: true` for drawNowArrow()'s out-of-range
// arrow. When live (selectedFieldTime null) the two sit at ~the same
// instant and may visually overlap -- expected, not a bug.
function buildTimeMarkers() {
  return [
    { x: new Date(), color: "#000", label: "NOW", dashed: false, now: true },
    { x: selectedFieldTime || new Date(), color: "#333", label: "MAP", dashed: true, now: true },
  ];
}

// Re-runs every currently-open graph's own redraw() (a no-op if none are
// open). Each point-query graph (current/wind/wave) recomputes its "now"
// marker from the live selectedFieldTime INSIDE its renderFn (see those
// functions below), so simply repainting is enough to move the dashed
// line -- no separate marker-tracking state needed here.
function refreshOpenGraphPopup() {
  openGraphModals.forEach((m) => m.redraw());
}

// title: string shown in the modal header. renderFn(ctx, width, height,
// rangeStart, rangeEnd): called against a freshly cleared canvas every time
// the chart needs (re)drawing -- once at open, then again on every Start/End
// slider move. rangeStart/rangeEnd are Date objects reflecting the sliders'
// current position, or both null if timeBounds (below) wasn't given.
// Callers do their own drawing via drawLineChart() (below) or their own
// canvas calls, typically filtering their point arrays to [rangeStart,
// rangeEnd] first (see filterPointsByRange()). noteHtml: optional small
// print shown under the chart (e.g. a data-source/interpolation caveat) --
// used here to be explicit when a curve is interpolated rather than
// measured, per the project's report-writing rigor standard. timeBounds:
// optional {min: Date, max: Date} covering the full data range -- if given,
// shows and initializes the Start/End sliders spanning min..max (both start
// fully open, showing the whole range); if omitted/null, the sliders are
// hidden and renderFn is called once with rangeStart/rangeEnd both null.
//
// 2026-08-06, owner's request: builds a brand-new, independent modal
// element on EVERY call now, instead of reusing one shared/cached element
// (ensureGraphModal(), removed) -- opening a graph used to silently
// replace whatever graph was already showing, since there was only ever
// one modal to populate. Any number can now be open at once, each with its
// own drag position, own hover/range-slider state (all local to this call,
// not module-level globals anymore), and its own explicit "Cancel" button
// -- nothing closes a graph except clicking that button. Tracked in
// openGraphModals[] so refreshOpenGraphPopup() (the map time-scrubber's
// live-update hook) reaches every open one, not just a single tracked
// instance.
function openGraphPopup(title, renderFn, noteHtml, timeBounds, detailHtml = "", modalClass = "") {
  const overlay = document.createElement("div");
  overlay.className = "graph-modal-overlay open";
  overlay.innerHTML =
    `<div class="graph-modal graph-modal-resizable">` +
    // 2026-08-05: noteHtml (the data-source/interpolation caveat each
    // show*Graph() function passes) used to sit permanently under the
    // chart -- the owner asked to cut that "excess verbiage" down to a
    // "?" symbol instead. graph-modal-help-btn toggles graph-modal-note
    // open/closed (now a small floating popover, see its CSS) rather than
    // removing the text -- the project's report-writing rigor standard
    // (don't drop a data-source/interpolation caveat) still applies, it's
    // just opt-in-visible now instead of always-on.
    `<div class="graph-modal-header"><span class="graph-modal-title"></span>` +
    `<button class="graph-modal-help-btn" type="button" aria-label="About this graph" title="About this graph">?</button>` +
    `<button class="graph-modal-close" aria-label="Cancel">Cancel</button></div>` +
    `<canvas class="graph-modal-canvas"></canvas>` +
    `<div class="graph-modal-detail"></div>` +
    // 2026-08-06: click-to-set-map-time hint -- same [hidden] gating as
    // .graph-modal-range-controls below (both keyed off timeBounds), so it
    // only shows on graphs that actually have a time axis to click.
    `<div class="graph-modal-hint"></div>` +
    // 2026-08-02: start/end time-range sliders, added below the chart so a
    // long snapshot window (e.g. the gate current curve's ~3 days) can be
    // zoomed into a narrower stretch. Hidden (via .graph-modal-range-
    // controls[hidden]) for callers that pass no timeBounds to
    // openGraphPopup() -- e.g. the "not enough data on file" fallback
    // messages, which have no time axis to slide over.
    `<div class="graph-modal-range-controls">` +
    `<div class="graph-range-row">` +
    `<label class="graph-range-label">Start</label>` +
    `<input type="range" class="graph-range-start">` +
    `<span class="graph-range-value graph-range-start-value"></span>` +
    `</div>` +
    `<div class="graph-range-row">` +
    `<label class="graph-range-label">End</label>` +
    `<input type="range" class="graph-range-end">` +
    `<span class="graph-range-value graph-range-end-value"></span>` +
    `</div>` +
    `</div>` +
    `<div class="graph-modal-note"></div>` +
    `</div>`;

  overlay.querySelector(".graph-modal-title").textContent = title;
  const noteEl = overlay.querySelector(".graph-modal-note");
  noteEl.innerHTML = noteHtml || "";
  const detailEl = overlay.querySelector(".graph-modal-detail");
  detailEl.innerHTML = detailHtml || "";
  detailEl.hidden = !detailHtml;
  overlay.querySelector(".graph-modal-help-btn").style.display = noteHtml ? "" : "none";

  const modalBox = overlay.querySelector(".graph-modal");
  if (modalClass) modalBox.classList.add(modalClass);
  const header = overlay.querySelector(".graph-modal-header");
  const canvas = overlay.querySelector(".graph-modal-canvas");
  // Fixed logical size -- simplest thing that reads well in a modal; not
  // attempting to be responsive to window size for this first cut.
  let width = 420, height = 260;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  let graphFontScale = 1;
  const scaledCtx = new Proxy(ctx, {
    get(target, property) {
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "font" && typeof value === "string") {
        value = value.replace(/(\d+(?:\.\d+)?)px/, (_, px) => `${Math.round(Number(px) * graphFontScale)}px`);
      }
      target[property] = value;
      return true;
    },
  });

  const hintEl = overlay.querySelector(".graph-modal-hint");
  const rangeControls = overlay.querySelector(".graph-modal-range-controls");
  const startInput = overlay.querySelector(".graph-range-start");
  const endInput = overlay.querySelector(".graph-range-end");
  const startLabel = overlay.querySelector(".graph-range-start-value");
  const endLabel = overlay.querySelector(".graph-range-end-value");

  // Per-instance chart layout, closed over by THIS modal's own hover
  // handlers below -- was a module-level activeChartLayout shared (and
  // clobbered) by whichever graph happened to be open; now each graph
  // keeps its own.
  let chartLayout = null;

  function redraw() {
    ctx.clearRect(0, 0, width, height);
    graphFontScale = Math.max(1, Math.min(2.2, Math.sqrt((width * height) / (420 * 260))));
    modalBox.style.setProperty("--graph-ui-scale", graphFontScale.toFixed(2));
    const result = timeBounds
      ? renderFn(scaledCtx, width, height, new Date(Number(startInput.value)), new Date(Number(endInput.value)))
      : renderFn(scaledCtx, width, height, null, null);
    chartLayout = result || null;
  }

  function closeThisGraph() {
    resizeObserver?.disconnect();
    overlay.remove();
    openGraphModals = openGraphModals.filter((m) => m.overlay !== overlay);
  }

  // "?" popover open/close, and closing it when clicking elsewhere on the
  // graph -- scoped to this modal's own elements, same behavior as before.
  modalBox.addEventListener("click", (e) => {
    const helpBtn = overlay.querySelector(".graph-modal-help-btn");
    if (noteEl.classList.contains("open") && e.target !== helpBtn && !noteEl.contains(e.target)) {
      noteEl.classList.remove("open");
    }
  });
  overlay.querySelector(".graph-modal-close").addEventListener("click", closeThisGraph);
  overlay.querySelector(".graph-modal-help-btn").addEventListener("click", () => {
    noteEl.classList.toggle("open");
  });

  // 2026-08-04: draggable/"floating" modal -- owner's request to be able to
  // move a graph out of screen-center (e.g. to compare it against the map
  // underneath). Position is applied as a CSS transform on .graph-modal
  // itself; the overlay stays the fixed, full-screen, flex-centering
  // backdrop (style.css), so dragging just offsets the box from that
  // centered starting point.
  //
  // 2026-08-06: starting offset is now CASCADED (graphCascadeCount), not
  // always (0, 0) -- with multiple graphs able to stay open at once (this
  // whole change), several opening exactly stacked at screen center would
  // make all but the top one invisible until manually dragged apart.
  const CASCADE_STEP_PX = 28, CASCADE_WRAP = 8;
  const cascadeIndex = graphCascadeCount++ % CASCADE_WRAP;
  let dragOffsetX = cascadeIndex * CASCADE_STEP_PX;
  let dragOffsetY = cascadeIndex * CASCADE_STEP_PX;
  modalBox.style.transform = `translate(${dragOffsetX}px, ${dragOffsetY}px)`;
  const DRAG_MARGIN = 40; // px of the modal that must stay on-screen on every side, so its header is always re-grabbable
  header.addEventListener("mousedown", (e) => {
    if (e.target.closest(".graph-modal-close")) return; // don't hijack the close button's own click
    e.preventDefault();
    const startX = e.clientX - dragOffsetX;
    const startY = e.clientY - dragOffsetY;
    function onMove(ev) {
      let nextX = ev.clientX - startX;
      let nextY = ev.clientY - startY;
      modalBox.style.transform = `translate(${nextX}px, ${nextY}px)`;
      const rect = modalBox.getBoundingClientRect();
      if (rect.right < DRAG_MARGIN) nextX += DRAG_MARGIN - rect.right;
      else if (rect.left > window.innerWidth - DRAG_MARGIN) nextX += (window.innerWidth - DRAG_MARGIN) - rect.left;
      if (rect.bottom < DRAG_MARGIN) nextY += DRAG_MARGIN - rect.bottom;
      else if (rect.top > window.innerHeight - DRAG_MARGIN) nextY += (window.innerHeight - DRAG_MARGIN) - rect.top;
      modalBox.style.transform = `translate(${nextX}px, ${nextY}px)`;
      dragOffsetX = nextX;
      dragOffsetY = nextY;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 2026-08-05: hover readout -- point at any spot on a graph, read its
  // exact x/y value, see the nearest real point highlighted. Scoped to
  // THIS modal's own canvas/chartLayout now, not a shared module-level
  // pair -- each open graph gets its own independent hover.
  canvas.addEventListener("mousemove", (ev) => {
    if (!chartLayout) return;
    // Clean redraw first (also refreshes chartLayout to the current
    // renderFn's output) so a previous hover frame's highlight/label never
    // lingers or trails as the mouse moves -- the base chart is cheap
    // enough (small canvas, a few hundred points at most) that redrawing
    // it on every mousemove is not a real performance concern here.
    redraw();
    const layout = chartLayout;
    if (!layout) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mouseX = (ev.clientX - rect.left) * scaleX;

    // 2026-08-05: scatter charts (drawScatterChart()'s `kind: "scatter"`
    // layout) branch off here into a 2D-pixel-distance nearest-point search
    // instead of the time-series x-only one below -- a scatter point's x is
    // a plain number (speed), not a time to snap a vertical guide line to,
    // so "nearest along x" isn't a meaningful notion here the way it is for
    // a line chart. See drawScatterHoverOverlay()'s own comment.
    if (layout.kind === "scatter") {
      if (!layout.plotted.length) return;
      const scaleY = canvas.height / rect.height;
      const mouseY = (ev.clientY - rect.top) * scaleY;
      let nearest = layout.plotted[0];
      let bestDist = Infinity;
      for (const p of layout.plotted) {
        const d = Math.hypot(p.px - mouseX, p.py - mouseY);
        if (d < bestDist) {
          bestDist = d;
          nearest = p;
        }
      }
      drawScatterHoverOverlay(ctx, layout, nearest);
      return;
    }

    if (!layout.sorted || !layout.sorted.length) return;
    let nearest = layout.sorted[0];
    let bestDist = Infinity;
    for (const p of layout.sorted) {
      const d = Math.abs(layout.xToPx(p.x.getTime()) - mouseX);
      if (d < bestDist) {
        bestDist = d;
        nearest = p;
      }
    }
    drawChartHoverOverlay(ctx, layout, nearest);
  });
  canvas.addEventListener("mouseleave", () => {
    // Just redraw clean -- simplest way to erase the hover overlay without
    // needing to track/undo exactly what it drew.
    if (chartLayout) redraw();
  });

  // 2026-08-06: owner's request -- click a point on a time-series graph to
  // set the MAP's own displayed time to it (selectedFieldTime), same as
  // dragging the floating time-scrubber. Gated on `timeBounds` (not, say,
  // chartLayout.kind) -- the same condition that already decides whether
  // this graph even HAS a time axis/range sliders (the Verification
  // scatter graph passes null for timeBounds, x there is a speed value,
  // not a time -- clicking it must stay a no-op there). Reuses the exact
  // same "nearest real point to this pixel X" search the hover handler
  // above already does, just on "click" instead of "mousemove", and
  // commits that point's own x (a Date) as the new selectedFieldTime
  // instead of just drawing a hover label.
  //
  // 2026-08-07, owner's request: "When I click on a point in the graph,
  // take me to that location and open the tidal graph" -- a SEPARATE
  // branch, checked first, for scatter charts specifically (Verification
  // is the only caller that sets chartLayout.verificationKind -- see
  // drawScatterChart()'s own comment). Does the same 2D nearest-point
  // search the scatter hover handler above already does, then hands off
  // to handleVerificationPointClick() -- kept as its own function since
  // panning the map + opening a station's real graph is a bigger action
  // than anything else this canvas click handler does.
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mouseX = (ev.clientX - rect.left) * scaleX;

    if (chartLayout && chartLayout.kind === "scatter" && chartLayout.verificationKind) {
      if (!chartLayout.plotted.length) return;
      const scaleY = canvas.height / rect.height;
      const mouseY = (ev.clientY - rect.top) * scaleY;
      let nearest = chartLayout.plotted[0];
      let bestDist = Infinity;
      for (const p of chartLayout.plotted) {
        const d = Math.hypot(p.px - mouseX, p.py - mouseY);
        if (d < bestDist) {
          bestDist = d;
          nearest = p;
        }
      }
      handleVerificationPointClick(chartLayout.verificationKind, nearest.stationId);
      return;
    }

    if (chartLayout && chartLayout.kind === "ec-bars" && chartLayout.bars.length) {
      const relativeX = mouseX - chartLayout.pad.left;
      if (relativeX < 0 || relativeX > chartLayout.plotW) return;
      const index = Math.min(chartLayout.bars.length - 1, Math.floor(relativeX / chartLayout.slot));
      const bar = chartLayout.bars[index];
      selectedFieldTime = new Date((bar.start.getTime() + bar.end.getTime()) / 2);
      refreshFieldTimeDependents();
      return;
    }

    if (!timeBounds || !chartLayout || !chartLayout.sorted || !chartLayout.sorted.length) return;
    let nearest = chartLayout.sorted[0];
    let bestDist = Infinity;
    for (const p of chartLayout.sorted) {
      const d = Math.abs(chartLayout.xToPx(p.x.getTime()) - mouseX);
      if (d < bestDist) {
        bestDist = d;
        nearest = p;
      }
    }
    selectedFieldTime = nearest.x;
    refreshFieldTimeDependents(); // repaints map arrows/heat map/station tooltips AND every open graph's own "now" line, including this one
  });

  if (timeBounds) {
    rangeControls.hidden = false;
    hintEl.textContent = "Click the chart to set the map's displayed time.";
    const minMs = timeBounds.min.getTime();
    const maxMs = timeBounds.max.getTime();
    // ~500 steps across the full range (floor of 1 minute) -- fine enough
    // for smooth dragging regardless of the underlying data's own spacing
    // (hourly gate-curve points, unevenly-spaced tide-curve points); the
    // slider's granularity is independent of the data's granularity since
    // filterPointsByRange() just keeps whatever real points fall inside
    // whatever window the slider lands on.
    const step = Math.max(60000, Math.round((maxMs - minMs) / 500));
    [startInput, endInput].forEach((el) => {
      el.min = String(minMs);
      el.max = String(maxMs);
      el.step = String(step);
    });
    startInput.value = String(minMs);
    endInput.value = String(maxMs);

    function updateLabels() {
      startLabel.textContent = new Date(Number(startInput.value)).toLocaleString();
      endLabel.textContent = new Date(Number(endInput.value)).toLocaleString();
    }

    startInput.oninput = () => {
      // Don't let the handles cross -- clamp start at end rather than
      // allowing an inverted (start > end) range.
      if (Number(startInput.value) > Number(endInput.value)) startInput.value = endInput.value;
      updateLabels();
      redraw();
    };
    endInput.oninput = () => {
      if (Number(endInput.value) < Number(startInput.value)) endInput.value = startInput.value;
      updateLabels();
      redraw();
    };
    updateLabels();
  } else {
    rangeControls.hidden = true;
    hintEl.textContent = "";
  }

  document.body.appendChild(overlay);
  redraw();
  if (chartLayout && chartLayout.kind === "ec-bars") {
    modalBox.classList.add("graph-modal-ec");
    hintEl.textContent = "Click a forecast bar to set the map's displayed date and time.";
  }
  // Keep the canvas bitmap synchronized with its CSS size while the owner
  // drags the graph window's lower-right resize corner. Redrawing at the new
  // logical size preserves sharp axes/text instead of stretching pixels.
  let resizeFrame = null;
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.max(280, Math.round(rect.width));
      const nextHeight = Math.max(140, Math.round(rect.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      redraw();
    });
  }) : null;
  resizeObserver?.observe(modalBox);
  openGraphModals.push({ overlay, redraw });
  return overlay;
}

// Keeps only the points whose x (a Date) falls within [start, end] --
// inclusive, both Date objects. Returns `points` unchanged if start/end is
// null (the no-timeBounds case, see openGraphPopup() above). Shared by
// showTideGraph()/showGateCurrentGraph() to zoom their charts (and their
// event/marker overlays) to whatever window the Start/End sliders land on,
// without needing to recompute the underlying curve/events themselves.
function filterPointsByRange(points, start, end) {
  if (!start || !end) return points;
  const startMs = start.getTime();
  const endMs = end.getTime();
  return points.filter((p) => {
    const t = p.x.getTime();
    return t >= startMs && t <= endMs;
  });
}

// Linear interpolation of `sorted`'s (already x-sorted, per drawLineChart's
// own sort) y-value at targetMs -- used to label wherever a chart's curve
// crosses a vertical marker line (the "now" line, gate slack/ebb/flood
// events) with an actual number, not just the line itself. Clamped to the
// series' own first/last value outside its time range rather than
// extrapolating -- a marker sitting right at (or just past, by a
// sub-sample amount) either edge of a bounded snapshot is common (e.g. the
// "now" marker vs. a Start/End-slider-narrowed window) and should read as
// "the nearest real value," not a wild extrapolated guess. Returns null
// only for an empty series (drawLineChart's own guard already prevents
// that from reaching here in practice).
function interpolateYAtTime(sorted, targetMs) {
  if (!sorted.length) return null;
  if (targetMs <= sorted[0].x.getTime()) return sorted[0].y;
  const last = sorted[sorted.length - 1];
  if (targetMs >= last.x.getTime()) return last.y;
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i].x.getTime(), t1 = sorted[i + 1].x.getTime();
    if (targetMs >= t0 && targetMs <= t1) {
      const frac = t1 === t0 ? 0 : (targetMs - t0) / (t1 - t0);
      return sorted[i].y + frac * (sorted[i + 1].y - sorted[i].y);
    }
  }
  return null;
}

// Draws a simple axes + line chart into ctx (width x height, already
// cleared by the caller). points: [{x: Date, y: number}], any order (sorted
// internally by x). opts: color, dashed (stroke style), showPoints (draw a
// small dot at every point in `points`), extraPoints (additional [{x,y}]
// dots drawn in the SAME coordinate scale without a second axis pass --
// used by showTideGraph() to mark the real known events on top of the
// interpolated curve), markers (vertical dashed reference lines, e.g. CHS
// slack/max-ebb/max-flood times -- 2026-08-05: now also labeled with the
// series' own value at that point, via interpolateYAtTime() above),
// yUnitLabel (rotated axis caption).
//
// 2026-08-05: now RETURNS a small layout object ({sorted, pad, plotW,
// plotH, xToPx, yToPx, width, height, yUnitLabel}) instead of nothing --
// openGraphPopup()'s redraw() captures this (via each caller's renderFn
// now `return`ing this call's result) into activeChartLayout, which the
// canvas mousemove/mouseleave handlers in ensureGraphModal() use to find
// the nearest real point under the cursor and draw a hover
// highlight/readout, without re-implementing this function's own
// axis-scaling math a second time. `points.length === 0` (the "not enough
// data" fallback branches in each show*Graph() function) never reaches
// this function at all -- those draw their own fillText and return
// undefined, which is exactly what disables hover for them (see
// activeChartLayout's own null-check).
function drawLineChart(ctx, width, height, points, opts) {
  opts = opts || {};
  const pad = { left: 40, right: 12, top: 12, bottom: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  if (!points.length) {
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.fillText("No data to plot.", pad.left, height / 2);
    return;
  }

  const sorted = [...points].sort((a, b) => a.x.getTime() - b.x.getTime());
  const xs = sorted.map((p) => p.x.getTime());
  const ys = sorted.map((p) => p.y).concat((opts.extraPoints || []).map((p) => p.y));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  // 2026-08-03: opts.yDomain -- fixed [min, max] Y-axis bounds, added at the
  // owner's request so point-query graphs (current/wave) use ONE consistent
  // scale (the map/model's own overall min/max) across every point queried,
  // instead of autoscaling per-click -- a calm spot's graph used to fill the
  // whole plot height the same as a busy spot's, which made them look
  // deceptively similar at a glance. When absent, falls back to the
  // original per-series autoscale (still used by the gate/tide graphs,
  // which already show real per-station values on their own natural
  // scale -- not changed here).
  const yMinRaw = opts.yDomain ? opts.yDomain[0] : Math.min(...ys, 0);
  const yMaxRaw = opts.yDomain ? opts.yDomain[1] : Math.max(...ys);
  // 2026-08-03: no extra 10% headroom added on top of a fixed opts.yDomain
  // -- currentSpeedRange()/waveHeightRange() already round their max UP to
  // the nearest whole unit (e.g. an observed 4.96kn becomes a 5kn axis
  // top), which is itself the headroom the owner asked for ("round the max
  // up to the nearest whole digit", after seeing "4.96" as an axis label).
  // Adding 10% on top of an already-rounded number would put a non-round
  // value (5.5) back on the axis, undoing the point of rounding it. The
  // autoscale path (no yDomain) keeps its original padding unchanged.
  const yMin = yMinRaw;
  const yMax = opts.yDomain ? yMaxRaw : yMaxRaw + ((yMaxRaw - yMinRaw) * 0.1 || 1);

  const xToPx = (t) => pad.left + ((t - xMin) / (xMax - xMin || 1)) * plotW;
  const yToPx = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // Optional EC extended-forecast bars behind a modeled wind line. Each
  // bar spans its forecast day horizontally and reaches that day's stated
  // maximum wind on the same knots axis. The translucent fill preserves
  // the hourly model line and grid while making the official zone forecast
  // directly comparable to it.
  (opts.barOverlays || []).forEach((bar) => {
    const startMs = Math.max(xMin, bar.start.getTime());
    const endMs = Math.min(xMax, bar.end.getTime());
    if (endMs <= startMs) return;
    const x1 = xToPx(startMs), x2 = xToPx(endMs);
    const yTop = yToPx(Math.min(yMax, Math.max(yMin, bar.maxKn)));
    const yBase = yToPx(Math.max(yMin, 0));
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = bar.color;
    ctx.fillRect(x1, Math.min(yTop, yBase), Math.max(1, x2 - x1), Math.abs(yBase - yTop));
    ctx.restore();
    ctx.fillStyle = "#444";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(bar.label, (x1 + x2) / 2, pad.top + 2, Math.max(30, x2 - x1 - 4));
  });

  // Axes
  ctx.strokeStyle = "#ccc";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  // Y-axis ticks (4 divisions) + horizontal gridlines
  ctx.fillStyle = "#888";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const py = yToPx(v);
    ctx.fillText(v.toFixed(1), pad.left - 4, py);
    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(pad.left + plotW, py);
    ctx.stroke();
  }

  // X-axis ticks -- a handful of labeled points along the range, not every
  // sample (would overlap illegibly).
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xTickCount = Math.min(5, sorted.length);
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1 || 1);
    const px = xToPx(t);
    const d = new Date(t);
    ctx.fillText(
      d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }),
      px,
      pad.top + plotH + 4
    );
  }

  // Optional vertical reference markers (e.g. slack/max-ebb/max-flood times)
  // -- drawn BEFORE the line itself so the line (and this function's own
  // intersection dot/label, added further below, after the line) render on
  // top of these dashed guides rather than under them.
  // 2026-08-05: `m.label` support added (same rotated-text mechanism
  // drawMultiLineChart() already has) -- this graph type can now carry
  // TWO distinguishable markers at once (e.g. showGateCurrentGraph()'s
  // "Map time"/"Now" plus a route leg's own arrival time at that gate),
  // where color alone would be an easy-to-miss distinction.
  (opts.markers || []).forEach((m) => {
    const px = xToPx(m.x.getTime());
    if (px < pad.left || px > pad.left + plotW) {
      // 2026-08-07, owner's request: a `now: true` marker (the live/map-time
      // line every graph carries -- see each show*Graph()'s own nowMarker)
      // that falls outside the plotted window gets a flashing directional
      // arrow at the near edge instead of silently not drawing at all -- see
      // drawNowArrow()'s own comment. Non-`now` markers (slack/ebb/flood,
      // route-leg arrival times) keep the original silent-skip behavior --
      // the owner only asked for this on the NOW line specifically.
      if (m.now) drawNowArrow(ctx, px < pad.left ? "before" : "after", pad, plotW, plotH, m.color, m.label);
      return;
    }
    ctx.strokeStyle = m.color || "#a33";
    // 2026-08-07: `m.dashed === false` -> solid (the new NOW marker,
    // buildTimeMarkers()) -- same convention drawMultiLineChart() already
    // had; previously every marker here was unconditionally dashed.
    ctx.setLineDash(m.dashed === false ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    if (m.label) {
      ctx.save();
      ctx.font = "9px sans-serif";
      ctx.fillStyle = m.color || "#666";
      ctx.translate(px + 3, pad.top + 3);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(m.label, 0, 0);
      ctx.restore();
    }
  });

  // The line itself
  ctx.strokeStyle = opts.color || "#2a628f";
  ctx.lineWidth = 2;
  ctx.setLineDash(opts.dashed ? [5, 4] : []);
  ctx.beginPath();
  sorted.forEach((p, i) => {
    const px = xToPx(p.x.getTime());
    const py = yToPx(p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  if (opts.regression) {
    ctx.save();
    ctx.beginPath();ctx.rect(pad.left,pad.top,plotW,plotH);ctx.clip();
    ctx.strokeStyle="#7a3db8";ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(toPx(0),toPy(opts.regression.offset));
    ctx.lineTo(toPx(domainMax),toPy(opts.regression.slope*domainMax+opts.regression.offset));ctx.stroke();
    ctx.restore();
  }

  if (opts.showPoints) {
    ctx.fillStyle = opts.color || "#2a628f";
    sorted.forEach((p) => {
      const px = xToPx(p.x.getTime());
      const py = yToPx(p.y);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  if (opts.extraPoints) {
    // 2026-08-05: per-point `color` (falling back to opts.extraColor, then
    // opts.color, as before) -- added so showGateCurrentGraph() can plot
    // its slack/max-ebb/max-flood events as color-coded dots ON the curve
    // (grey/red/blue, same colors it used to draw as full-height vertical
    // lines) instead of a single uniform-colored dot for every point.
    opts.extraPoints.forEach((p) => {
      const px = xToPx(p.x.getTime());
      const py = yToPx(p.y);
      ctx.fillStyle = p.color || opts.extraColor || opts.color || "#2a628f";
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  if (opts.yUnitLabel) {
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.fillText(opts.yUnitLabel, 0, 0);
    ctx.restore();
  }

  // 2026-08-05: label wherever the plotted series crosses a marker line --
  // owner's request ("label the point intersecting the vertical dashed
  // line"). Drawn AFTER the line/points/extraPoints above, so this dot
  // sits on top of them rather than getting drawn over. Uses
  // interpolateYAtTime() (above) rather than requiring an exact sample at
  // the marker's timestamp -- markers (the live "now" line especially)
  // routinely fall BETWEEN two real samples, not exactly on one.
  (opts.markers || []).forEach((m) => {
    const px = xToPx(m.x.getTime());
    if (px < pad.left || px > pad.left + plotW) return;
    const yAtMarker = interpolateYAtTime(sorted, m.x.getTime());
    if (yAtMarker === null) return;
    const py = yToPx(yAtMarker);
    const color = m.color || "#a33";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();

    const label = yAtMarker.toFixed(2) + (opts.yUnitLabel ? " " + opts.yUnitLabel : "");
    ctx.font = "10px sans-serif";
    // Flip the label to the left of the dot, and/or below it, whenever the
    // default right-and-above placement would run off the canvas edge --
    // the marker closest to "now" is often near the right edge of the
    // plot (a live, unscrubbed graph's marker sits at the rightmost
    // sample), where a naive fixed offset would clip.
    const labelW = ctx.measureText(label).width;
    const flipLeft = px + 6 + labelW > pad.left + plotW;
    const flipDown = py - 6 < pad.top + 8;
    ctx.textAlign = flipLeft ? "right" : "left";
    ctx.textBaseline = flipDown ? "top" : "bottom";
    ctx.fillStyle = "#222";
    ctx.fillText(label, px + (flipLeft ? -6 : 6), py + (flipDown ? 6 : -6));
  });

  return { sorted, pad, plotW, plotH, xMin, xMax, yMin, yMax, xToPx, yToPx, width, height, yUnitLabel: opts.yUnitLabel || "" };
}

// 2026-08-05: multi-series analogue of drawLineChart() above, built for
// showRouteConditionsGraph() (current/wind/combined-effect speed together
// on one whole-route graph, per the owner's request, scoped via
// AskUserQuestion -- see index.html's own comment on the button that opens
// it). Kept as a separate function rather than refactoring drawLineChart()
// into a series-array API -- drawLineChart() has many existing single-line
// call sites (point-query current/wave, gate/tide curves) this project
// can't visually re-verify in this sandbox (no browser), so adding
// alongside it is the lower-risk path, the same "new function mirrors an
// existing one" pattern already used elsewhere (sampleWindNear() mirroring
// sampleCurrentNear(), etc.).
//
// series: [{ points: [{x:Date,y:number}], color, label, axis, unit, shape,
// showPoints, extraPoints }, ...].
// `axis` ("left", the default, "right", or "farright" -- 2026-08-05, third
// axis added per the owner's request "add an other Y axis for the current
// (3 axes altogether)" so Current/Wind/Waves can each have their own fully
// independent scale, instead of Current+Wind sharing one knots axis).
// Each axis still shares ONE Y-domain across whichever series are on it
// (auto-computed from that axis' own combined min/max, unless
// opts.yDomain/opts.yDomainRight/opts.yDomainFarRight override it).
// `unit` -- short unit string for that series' OWN hover-label text (falls
// back to opts.yUnitLabel/opts.yUnitLabelRight/opts.yUnitLabelFarRight per
// axis if omitted) -- ALSO now appended directly to that axis' own tick
// numbers when it's a right/farright axis (e.g. "12.3kn"), since with up
// to 3 axes there isn't clean room for 3 separate rotated unit labels
// without them crowding each other -- see the tick-drawing code below.
// `shape` -- 2026-08-05, owner's request "add symbols... to help
// differentiate the current, wind and wave plots": one of "circle"
// (default), "square", or "triangle", used for that series' showPoints
// dots (and mirrored in the legend swatch) -- lets series be told apart
// by shape, not color alone.
function drawMultiLineChart(ctx, width, height, series, opts) {
  opts = opts || {};
  const hasRightAxis = series.some((s) => s.axis === "right");
  const hasFarRightAxis = series.some((s) => s.axis === "farright");
  // Each secondary axis (right/farright) gets its own ~40px of room for
  // tick numbers (now including an inline unit suffix, e.g. "12.3kn" --
  // see this function's own top comment) plus a small gap before the next
  // axis out.
  const SECONDARY_AXIS_WIDTH = 40;
  const pad = {
    left: 40,
    right: 12 + (hasRightAxis ? SECONDARY_AXIS_WIDTH : 0) + (hasFarRightAxis ? SECONDARY_AXIS_WIDTH : 0),
    top: 22,
    bottom: 28,
  }; // extra top padding vs. drawLineChart() for the legend row
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const seriesSorted = series.map((s) => ({
    ...s,
    sorted: [...s.points].sort((a, b) => a.x.getTime() - b.x.getTime()),
  }));
  const nonEmpty = seriesSorted.filter((s) => s.sorted.length > 0);
  if (!nonEmpty.length) {
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.fillText("No data to plot.", pad.left, height / 2);
    return null;
  }

  const leftNonEmpty = nonEmpty.filter((s) => s.axis !== "right" && s.axis !== "farright");
  const rightNonEmpty = nonEmpty.filter((s) => s.axis === "right");
  const farRightNonEmpty = nonEmpty.filter((s) => s.axis === "farright");
  // Falls back to using every series for the left axis if somehow nothing
  // was assigned to it (e.g. a caller puts everything on "right") -- keeps
  // the left axis/X-axis structure sane rather than dividing by an empty
  // array; not expected in practice (this graph always has Current on the
  // left).
  const leftDomainSeries = leftNonEmpty.length ? leftNonEmpty : nonEmpty;

  const allXs = nonEmpty.flatMap((s) => s.sorted.map((p) => p.x.getTime()));
  const xMin = Math.min(...allXs), xMax = Math.max(...allXs);

  const leftYs = leftDomainSeries.flatMap((s) => s.sorted.map((p) => p.y));
  const yMinRaw = opts.yDomain ? opts.yDomain[0] : Math.min(...leftYs, 0);
  const yMaxRaw = opts.yDomain ? opts.yDomain[1] : Math.max(...leftYs);
  const yMin = yMinRaw;
  const yMax = opts.yDomain ? yMaxRaw : yMaxRaw + ((yMaxRaw - yMinRaw) * 0.1 || 1);
  const yToPx = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  let yMinR = 0, yMaxR = 1, yToPxRight = yToPx;
  if (rightNonEmpty.length) {
    const rightYs = rightNonEmpty.flatMap((s) => s.sorted.map((p) => p.y));
    yMinR = opts.yDomainRight ? opts.yDomainRight[0] : Math.min(...rightYs, 0);
    const yMaxRraw = opts.yDomainRight ? opts.yDomainRight[1] : Math.max(...rightYs);
    yMaxR = opts.yDomainRight ? yMaxRraw : yMaxRraw + ((yMaxRraw - yMinR) * 0.1 || 1);
    yToPxRight = (v) => pad.top + plotH - ((v - yMinR) / (yMaxR - yMinR || 1)) * plotH;
  }
  // 2026-08-05: third axis, owner's request "add an other Y axis for the
  // current (3 axes altogether)" -- exact same pattern as the right axis
  // above, just its own domain/accessor.
  let yMinFR = 0, yMaxFR = 1, yToPxFarRight = yToPx;
  if (farRightNonEmpty.length) {
    const farRightYs = farRightNonEmpty.flatMap((s) => s.sorted.map((p) => p.y));
    yMinFR = opts.yDomainFarRight ? opts.yDomainFarRight[0] : Math.min(...farRightYs, 0);
    const yMaxFRraw = opts.yDomainFarRight ? opts.yDomainFarRight[1] : Math.max(...farRightYs);
    yMaxFR = opts.yDomainFarRight ? yMaxFRraw : yMaxFRraw + ((yMaxFRraw - yMinFR) * 0.1 || 1);
    yToPxFarRight = (v) => pad.top + plotH - ((v - yMinFR) / (yMaxFR - yMinFR || 1)) * plotH;
  }
  // Per-series y-to-px accessor, resolved once here rather than re-checked
  // `s.axis` at every draw/hover site below.
  seriesSorted.forEach((s) => {
    s.yToPx = s.axis === "right" ? yToPxRight : s.axis === "farright" ? yToPxFarRight : yToPx;
  });

  const xToPx = (t) => pad.left + ((t - xMin) / (xMax - xMin || 1)) * plotW;

  // 2026-08-05: per-axis color, matching that axis' own series -- owner's
  // request "colour the Y axis the same as the plot for each parameter."
  // Only meaningful (and only used) when exactly one series sits on a
  // given axis, which is true for every current caller (Current/Wind/
  // Waves each on their own axis) -- falls back to neutral grey if an
  // axis somehow has zero or more than one series, rather than guessing
  // which one to color it after.
  function axisColor(nonEmptyForAxis) {
    return nonEmptyForAxis.length === 1 ? nonEmptyForAxis[0].color : "#888";
  }
  const leftColor = axisColor(leftNonEmpty.length ? leftNonEmpty : nonEmpty);
  const rightColor = axisColor(rightNonEmpty);
  const farRightColor = axisColor(farRightNonEmpty);
  // FarRight axis' own vertical line sits further out than the right
  // axis' (plot-edge) line, only pushed out by SECONDARY_AXIS_WIDTH if a
  // right axis is ALSO present -- if farright is the only secondary axis
  // in play, it sits right at the plot edge instead, same place "right"
  // alone would have.
  const farRightLineX = pad.left + plotW + (hasRightAxis ? SECONDARY_AXIS_WIDTH : 0);

  // Axes -- left/bottom border (neutral grey, the shared plot frame) drawn
  // separately from the right-hand axis line(s) below, which are each
  // colored to match their own series (see axisColor() above).
  ctx.strokeStyle = "#ccc";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  if (hasRightAxis) {
    // Right axis' own vertical line, colored to match its series, so a
    // right-hand series' scale reads as its own distinct, identifiable
    // axis -- not just unlabeled ticks floating off the main plot.
    ctx.strokeStyle = rightColor;
    ctx.beginPath();
    ctx.moveTo(pad.left + plotW, pad.top);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();
  }
  if (hasFarRightAxis) {
    ctx.strokeStyle = farRightColor;
    ctx.beginPath();
    ctx.moveTo(farRightLineX, pad.top);
    ctx.lineTo(farRightLineX, pad.top + plotH);
    ctx.stroke();
  }

  // Left Y-axis ticks + gridlines (same layout as drawLineChart()), colored
  // to match the left axis' own series.
  ctx.fillStyle = leftColor;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const py = yToPx(v);
    ctx.fillText(v.toFixed(1), pad.left - 4, py);
    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(pad.left + plotW, py);
    ctx.stroke();
  }

  // Right Y-axis ticks -- text only, no gridlines (the left axis' gridlines
  // already cover the plot; a second set at a different scale would be
  // visually confusing, implying a shared grid that doesn't actually
  // exist). Colored to match. Unit suffix appended inline (e.g. "12.3kn")
  // rather than a separate rotated axis label -- with up to 3 axes now,
  // there isn't clean room for 3 rotated labels without them colliding.
  if (rightNonEmpty.length) {
    ctx.fillStyle = rightColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const v = yMinR + ((yMaxR - yMinR) * i) / yTicks;
      const py = yToPxRight(v);
      ctx.fillText(v.toFixed(1) + (opts.yUnitLabelRight || ""), pad.left + plotW + 4, py);
    }
  }
  // FarRight Y-axis ticks -- same idea, one axis further out.
  if (farRightNonEmpty.length) {
    ctx.fillStyle = farRightColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const v = yMinFR + ((yMaxFR - yMinFR) * i) / yTicks;
      const py = yToPxFarRight(v);
      ctx.fillText(v.toFixed(2) + (opts.yUnitLabelFarRight || ""), farRightLineX + 4, py);
    }
  }

  // X-axis ticks -- against the series with the most points (typically the
  // "combined" one, which always has a point at every sampled leg-step
  // regardless of whether current/wind data was available there -- see
  // buildRouteConditionsSeries()'s own comment).
  ctx.fillStyle = "#888";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const longest = nonEmpty.reduce((a, b) => (b.sorted.length > a.sorted.length ? b : a));
  const xTickCount = Math.min(5, longest.sorted.length);
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1 || 1);
    const px = xToPx(t);
    const d = new Date(t);
    ctx.fillText(d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }), px, pad.top + plotH + 4);
  }

  // Marker lines -- same idea as drawLineChart()'s own markers, extended
  // here with owner-requested additions (2026-08-05): `m.dashed` (solid
  // when explicitly false, dashed by default -- lets waypoint markers read
  // as visually distinct from the map-time marker), `m.label` (a short
  // rotated text tag at the top of the line, e.g. "WP2" or "Map time" --
  // see showRouteConditionsGraph() for what actually gets passed), and
  // `m.width` (line width, default 1 -- lets the "current" highlighted
  // waypoint marker -- owner's request: highlight the same waypoint on the
  // map and this graph together as the map's time steps -- stand out from
  // the other, un-highlighted waypoint markers with a thicker line and
  // bold label, not just a different color).
  (opts.markers || []).forEach((m) => {
    const px = xToPx(m.x.getTime());
    if (px < pad.left || px > pad.left + plotW) {
      // 2026-08-07: same out-of-range NOW-arrow treatment as
      // drawLineChart()'s own marker loop -- see drawNowArrow()'s comment.
      if (m.now) drawNowArrow(ctx, px < pad.left ? "before" : "after", pad, plotW, plotH, m.color, m.label);
      return;
    }
    ctx.strokeStyle = m.color || "#a33";
    ctx.lineWidth = m.width || 1;
    ctx.setLineDash(m.dashed === false ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    if (m.label) {
      // Rotated 90° so a short label ("WP3", "Map time") takes almost no
      // horizontal room next to its own line -- several waypoint markers
      // can sit fairly close together on a multi-leg route without their
      // labels overlapping the way upright text would.
      ctx.save();
      ctx.font = m.width > 1 ? "bold 9px sans-serif" : "9px sans-serif";
      ctx.fillStyle = m.color || "#666";
      ctx.translate(px + 3, pad.top + 3);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(m.label, 0, 0);
      ctx.restore();
    }
  });

  // Small shape helpers for showPoints below -- owner's request "add
  // symbols... to help differentiate the current, wind and wave plots":
  // distinguishable by outline shape, not just line/fill color. `r` is
  // each shape's own half-width/radius, matched visually across shapes
  // (not literally the same formula) so circle/square/triangle read as
  // roughly the same size at a glance.
  const SHAPE_DRAWERS = {
    circle: (px, py, r) => {
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    },
    square: (px, py, r) => {
      ctx.fillRect(px - r * 0.85, py - r * 0.85, r * 1.7, r * 1.7);
    },
    triangle: (px, py, r) => {
      ctx.beginPath();
      ctx.moveTo(px, py - r * 1.15);
      ctx.lineTo(px + r * 1.15, py + r * 0.85);
      ctx.lineTo(px - r * 1.15, py + r * 0.85);
      ctx.closePath();
      ctx.fill();
    },
  };

  // Each series' own line, in the order given (not re-sorted/grouped) --
  // callers control draw/legend order (current, wind, waves). Uses
  // s.yToPx (left/right/farright axis, resolved above), not the bare
  // left-axis yToPx -- the one part of this function a right- or
  // farright-axis series actually needs to differ on.
  seriesSorted.forEach((s) => {
    if (!s.sorted.length) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    // 2026-08-05: owner's request -- "make lines solid, dashed, dotted to
    // help differentiate parameters," on top of the existing color/shape
    // cues (this graph now has three independent ways to tell series
    // apart: color, point shape, and line style -- readable even in
    // greyscale or by someone colorblind, not just color-dependent).
    // `s.lineDash` is a plain canvas setLineDash() array; falls back to
    // solid (`[]`) for any series that doesn't specify one, so every
    // pre-existing caller of drawMultiLineChart() (tide/gate-current
    // graphs don't call this function at all, but any future caller that
    // omits lineDash) keeps its original solid-line appearance.
    ctx.setLineDash(s.lineDash || []);
    ctx.beginPath();
    s.sorted.forEach((p, i) => {
      const px = xToPx(p.x.getTime());
      const py = s.yToPx(p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]); // reset immediately -- showPoints/extraPoints below use fills, not strokes, but leaving a dash pattern set is a latent footgun for any future code added here

    // 2026-08-05: owner's request -- "plot the data nodes as small
    // symbols," so each real sample reads as a distinct point, not just
    // wherever the connecting line happens to pass (this graph's samples
    // are hourly and genuinely discrete, not a dense continuous series
    // the way e.g. the tide curve's eased interpolation is -- a plain
    // line alone risks implying more resolution/precision between hours
    // than actually exists). Opt-in per series via `s.showPoints` (same
    // name/shape as drawLineChart()'s own opts.showPoints) -- drawn AFTER
    // that series' own line so the dots sit on top of it, not under.
    // `s.shape` (2026-08-05 follow-up, owner's "add symbols... to help
    // differentiate" request) picks which SHAPE_DRAWERS entry to use,
    // defaulting to "circle" for any series that doesn't specify one
    // (keeps every pre-existing caller's appearance unchanged).
    if (s.showPoints) {
      ctx.fillStyle = s.color;
      const draw = SHAPE_DRAWERS[s.shape] || SHAPE_DRAWERS.circle;
      s.sorted.forEach((p) => {
        const px = xToPx(p.x.getTime());
        const py = s.yToPx(p.y);
        draw(px, py, 2.5);
      });
    }

    // 2026-08-05: owner's request -- "plot the calculated current
    // magnitude in the Gate on the route conditions plot, as a labelled
    // large dot." `s.extraPoints`: [{x, y, label, color?}], drawn larger
    // (radius 5, white-outlined) than the plain hourly showPoints dots
    // above so a gate value reads as a distinct, called-out figure, not
    // just another sample -- plus an always-visible text label (the
    // showPoints dots above deliberately have none; this is the one
    // request that specifically asked for a LABELLED dot). Position flips
    // left/up near canvas edges, same reasoning as drawChartHoverOverlay()'s
    // own label box. Always a circle regardless of s.shape -- its size and
    // white outline already make it visually distinct from the small
    // showPoints dots, a shape change on top would be redundant.
    if (s.extraPoints && s.extraPoints.length) {
      s.extraPoints.forEach((p) => {
        const px = xToPx(p.x.getTime());
        const py = s.yToPx(p.y);
        const color = p.color || s.color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (p.label) {
          ctx.font = "10px sans-serif";
          const textW = ctx.measureText(p.label).width;
          const boxPad = 4;
          const boxW = textW + boxPad * 2;
          const boxH = 16;
          let boxX = px + 8;
          if (boxX + boxW > width) boxX = px - boxW - 8;
          if (boxX < 0) boxX = 2;
          let boxY = py - boxH - 6;
          if (boxY < pad.top) boxY = py + 8;
          ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
          ctx.fillRect(boxX, boxY, boxW, boxH);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(boxX, boxY, boxW, boxH);
          ctx.fillStyle = "#222";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(p.label, boxX + boxPad, boxY + boxH / 2);
        }
      });
    }
  });

  // Legend: one row above the plot, color swatch + shape + label per
  // series -- the shape swatch (2026-08-05 follow-up) mirrors whatever
  // SHAPE_DRAWERS entry that series' own showPoints dots use, so the
  // legend teaches the color<->shape mapping too, not just color.
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let legendX = pad.left;
  const legendY = 10;
  series.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.lineDash || []); // legend swatch mirrors the series' own line style, same reasoning as the shape swatch below
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 14, legendY);
    ctx.stroke();
    ctx.setLineDash([]);
    if (s.showPoints) {
      ctx.fillStyle = s.color;
      const draw = SHAPE_DRAWERS[s.shape] || SHAPE_DRAWERS.circle;
      draw(legendX + 7, legendY, 2.5);
    }
    ctx.fillStyle = "#333";
    ctx.fillText(s.label, legendX + 18, legendY);
    legendX += 18 + ctx.measureText(s.label).width + 14;
  });

  // Left axis' own rotated unit label -- unchanged from before (still the
  // one axis with clean room for it, at the far left of the canvas).
  // Right and farright axes get their unit as an inline tick suffix
  // instead (see the tick-drawing code above) -- no separate rotated
  // labels competing for space with each other.
  if (opts.yUnitLabel) {
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = leftColor;
    ctx.font = "10px sans-serif";
    ctx.fillText(opts.yUnitLabel, 0, 0);
    ctx.restore();
  }

  // Resolve each series' own hover-label unit now (falls back to the axis'
  // shared unit label if the series didn't specify its own) -- read by
  // drawChartHoverOverlay() below, one lookup per series instead of
  // re-deriving axis-vs-unit logic there too.
  seriesSorted.forEach((s) => {
    s.unit = s.unit || (s.axis === "right" ? opts.yUnitLabelRight : s.axis === "farright" ? opts.yUnitLabelFarRight : opts.yUnitLabel) || "";
  });

  // `sorted` = the longest series' own points -- used ONLY so the shared
  // hover mousemove handler in ensureGraphModal() (which expects a single
  // `layout.sorted` to find the x-nearest sample) keeps working unchanged
  // against this multi-series layout too. `series` (plural, with each
  // series' own `sorted`/`color`/`label`/`yToPx`/`unit`) is what
  // drawChartHoverOverlay() actually reads to show every value at once --
  // see its own updated comment.
  return {
    sorted: longest.sorted,
    series: seriesSorted,
    pad, plotW, plotH, xMin, xMax, yMin, yMax, xToPx, yToPx, width, height,
    yUnitLabel: opts.yUnitLabel || "",
  };
}

// ============================================================================
// Verification: obs/reference vs. model XY scatter -- owner's 2026-08-05
// request ("Establish a database of shore/buoy station winds and currents
// and make an XY plot of each parameter ... vs the nearest Model point ...
// to show the 'calibration' of the model values, for all times in the
// current model run"). Two data sources, scoped via AskUserQuestion:
//
// - Wind: real station observations (data/wind_stations_obs.js's scrape)
//   paired with the nearest HRDPS model sample, one pair PER PIPELINE RUN
//   (that scrape is a single live snapshot, not a time series -- see that
//   file's own header comment). fetch_model_data.py accumulates these pairs
//   into data/wind_verification_log.js across every "Refresh data" run (see
//   build_wind_verification_log_js()'s own docstring there), so the plot
//   genuinely grows richer over repeated runs.
// - Current: no real current-observation source exists in this pipeline
//   (owner confirmed, chose this fallback over skipping current entirely) --
//   CHS's own predicted gate current-speed curve (data/gate_current_curve.js,
//   a tidal/harmonic prediction, NOT a buoy observation) stands in as the
//   reference, paired against the nearest SalishSeaCast/CIOPS-West sample at
//   each curve hour. This needs no accumulation/backend change: the CHS
//   curve already spans the whole loaded forecast window in one file, so
//   every point in "the current model run" is available from a single page
//   load/refresh, computed entirely client-side.
// ============================================================================

// Scatter analogue of drawLineChart()/drawMultiLineChart() above -- X and Y
// are both plain numbers (not Date), sharing ONE domain starting at 0 on
// both axes so the 1:1 reference line always reads as a clean 45-degree
// diagonal (an unequal-scale scatter would visually distort what "matches
// the model" looks like).
//
// 2026-08-05: now DOES return a hover layout, at the owner's request to see
// a station name/time popup when hovering a point (this used to be
// deliberately inert -- see the removed comment this replaced -- because
// the shared canvas mousemove handler's original nearest-point search was
// x-only and assumed a Date .x, neither of which fits a plain-number
// scatter). Returns `{ kind: "scatter", plotted, pad, plotW, plotH, width,
// height }` instead of drawLineChart()'s `{ sorted, xToPx, yToPx, ... }`
// shape -- `kind` is what tells ensureGraphModal()'s mousemove handler (and
// drawScatterHoverOverlay(), below) to take the 2D-pixel-distance branch
// instead of the time-series one. `plotted` carries each point's already-
// computed pixel position (px, py) plus its original label/time, so hover
// never needs to re-derive toPx()/toPy() against a stale domainMax.
function drawScatterChart(ctx, width, height, points, opts) {
  opts = opts || {};
  const pad = { left: 40, right: 12, top: 12, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  if (!points.length) {
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.fillText("No paired data to plot.", pad.left, height / 2);
    return;
  }

  const allVals = points.reduce((acc, p) => acc.concat([p.x, p.y]), []);
  const maxVal = Math.max(...allVals, 0);
  const domainMax = Math.ceil(maxVal * 1.05) || 1;
  const toPx = (v) => pad.left + (v / domainMax) * plotW;
  const toPy = (v) => pad.top + plotH - (v / domainMax) * plotH;

  ctx.strokeStyle = "#ccc";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  // Shared ticks/gridlines -- same domain on both axes, so one loop labels
  // both the Y (left) and X (bottom) axis at each division.
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (domainMax * i) / ticks;
    const py = toPy(v);
    const px = toPx(v);
    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(pad.left + plotW, py);
    ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(v.toFixed(1), pad.left - 4, py);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(v.toFixed(1), px, pad.top + plotH + 4);
  }

  // 1:1 reference line -- dashed, drawn before the scatter dots so the dots
  // sit on top of it, same layering convention drawLineChart() uses for its
  // own marker lines.
  ctx.strokeStyle = "#999";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(toPx(0), toPy(0));
  ctx.lineTo(toPx(domainMax), toPy(domainMax));
  ctx.stroke();
  ctx.setLineDash([]);

  const color = opts.color || "#2a628f";
  // 2026-08-05: `plotted` mirrors `points` but with each point's real pixel
  // position (px, py) baked in -- this is what the hover handler's 2D
  // nearest-point search (drawScatterHoverOverlay(), below) uses, so it
  // never has to call toPx()/toPy() again against a domainMax that could in
  // principle differ if this function were ever called again with a
  // different points array before a stale layout got replaced.
  const plotted = [];
  points.forEach((p) => {
    const px = toPx(p.x), py = toPy(p.y);
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fillStyle = p.color || color;
    ctx.globalAlpha = 0.6; // semi-transparent so overlapping points at similar values still read as "many", not one solid blob
    ctx.fill();
    ctx.globalAlpha = 1;
    // 2026-08-07: stationId carried through -- see this function's own
    // `verificationKind` on the returned layout, below.
    plotted.push({ px, py, x: p.x, y: p.y, label: p.label, obsTime: p.obsTime, modelTime: p.modelTime, stationId: p.stationId });
  });

  ctx.fillStyle = "#666";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(opts.xUnitLabel || "Reference", pad.left + plotW / 2, height - 2);
  ctx.save();
  ctx.translate(10, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(opts.yUnitLabel || "Model", 0, 0);
  ctx.restore();

  if (opts.stats) {
    const { n, bias, rmse, r } = opts.stats;
    const lines = [
      `n = ${n}`,
      `bias = ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`,
      `RMSE = ${rmse.toFixed(2)}`,
      r === null ? "r = n/a" : `r = ${r.toFixed(2)}`,
    ];
    if(opts.regression){lines.push(`slope = ${opts.regression.slope.toFixed(3)}`,`offset = ${opts.regression.offset.toFixed(2)}`);}
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#333";
    lines.forEach((line, i) => ctx.fillText(line, pad.left + 6, pad.top + 4 + i * 12));
  }

  return {
    kind: "scatter",
    plotted,
    pad,
    plotW,
    plotH,
    width,
    height,
    xUnitLabel: opts.xUnitLabel || "",
    yUnitLabel: opts.yUnitLabel || "",
    // 2026-08-07: "wind"/"current"/undefined -- only the Verification
    // graph passes this (opts.pointKind, see showVerificationGraph()).
    // openGraphPopup()'s click handler uses it to decide whether/how to
    // react to a scatter-point click at all.
    verificationKind: opts.pointKind || null,
  };
}

// n, bias (mean(model-reference) -- positive means the model reads high),
// RMSE, and Pearson's r between the reference (x) and model (y) values.
// r is null (not 0) below n=2 or a zero-variance series -- "n/a" is a more
// honest label than a misleading 0 for "not enough spread to compute a
// correlation," same reasoning drawScatterChart()'s own "r = n/a" fallback
// reads.
function computeVerificationStats(points) {
  const n = points.length;
  if (!n) return { n: 0, bias: 0, rmse: 0, r: null };
  let sumDiff = 0, sumSqDiff = 0, sumX = 0, sumY = 0;
  points.forEach((p) => {
    const diff = p.y - p.x;
    sumDiff += diff;
    sumSqDiff += diff * diff;
    sumX += p.x;
    sumY += p.y;
  });
  const bias = sumDiff / n;
  const rmse = Math.sqrt(sumSqDiff / n);
  let r = null;
  if (n >= 2) {
    const meanX = sumX / n, meanY = sumY / n;
    let num = 0, denX = 0, denY = 0;
    points.forEach((p) => {
      const dx = p.x - meanX, dy = p.y - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    });
    r = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : null;
  }
  return { n, bias, rmse, r };
}

// Reads window.WIND_VERIFICATION_LOG_DATA (data/wind_verification_log.js,
// accumulated by fetch_model_data.py's build_wind_verification_log_js() --
// see this section's own header comment above). stationIds is an array of
// real WIND_STATIONS codes (see data/wind_stations.js) -- 2026-08-07, owner's
// "add off/on buttons for each of the stations, so I can select the ones I
// want" request replaced the old single "all"-or-one-id <select> with a
// checkbox per station (see populateVerificationStationOptions() and
// getSelectedVerificationStationIds()), so this now filters against a set
// of ids rather than one value.
function buildWindVerificationPoints(stationIds) {
  const data = window.WIND_VERIFICATION_LOG_DATA;
  if (!data || !data.entries) return [];
  return data.entries
    .filter((e) => stationIds.includes(e.station_id))
    .filter((e) => typeof e.obs_speed_kn === "number" && typeof e.model_speed_kn === "number")
    // 2026-08-05: obsTime/modelTime carried through so drawScatterChart()'s
    // hover popup can show when each side of the pair is actually from --
    // and, per the owner's follow-up request, how far apart they are. This
    // pipeline has no true per-station obs timestamp parsed to UTC (only
    // obs_time_local, a locale string never sent to the browser -- see
    // fetch_wind_station_obs() in fetch_model_data.py); e.fetched_at (when
    // THIS run pulled the obs) is what the pipeline itself already uses as
    // the obs-side target time for picking model_time's own nearest-sample
    // lookup (see main()'s verif_entries loop, `target_dt = ...fetched_at`),
    // so it's the correct obs-side stand-in here too, not an approximation
    // invented just for this popup. modelTime = e.model_time, the HRDPS
    // sample's own timestamp -- whichever HRDPS output hour is nearest to
    // obsTime, with no time-gap cap in the matching pipeline (only a
    // distance cap, WIND_VERIFICATION_MAX_KM -- see
    // _nearest_wind_model_sample() in fetch_model_data.py), so the popup's
    // Δt is a real, sometimes non-trivial, model/obs time gap -- not zero by
    // construction.
    .map((e) => ({
      x: e.obs_speed_kn,
      y: e.model_speed_kn,
      label: e.station_name,
      obsTime: e.fetched_at,
      modelTime: e.model_time,
      // 2026-08-07, owner's request -- clicking a scatter point pans the
      // map to its real station and opens that station's own graph (see
      // handleVerificationPointClick()) -- needs the station's real id,
      // not just its display name, to look it up in WIND_STATIONS_DATA.
      stationId: e.station_id,
    }));
}

// CHS's predicted gate current-speed curve (reference, x) vs. the nearest
// current-model sample (y) at that station, at every hour the curve covers
// -- see this section's own header comment for why CHS's curve, not a real
// observation, is the reference here. Reuses sampleCurrentNear() and
// loadCurrentField() (so this respects the owner's own SalishSeaCast
// Model/CIOPS Model checkbox choice, same as every other current consumer
// -- see loadCurrentField()'s own comment) rather than a separate
// hand-written lookup.
//
// 2026-08-06: per-station verification override (loadVerificationOverrides())
// checked first -- owner's finding that automatic nearest-point picking
// produced an uncorrelated scatter (Active Pass r=0.40) where Wind's own
// graph, built the same way conceptually, reads cleanly (r=0.61+). Root
// cause confirmed two ways: (1) the screenshot that prompted this had
// "Current data source" set to CIOPS-West-only, so the graph was built
// entirely from the coarse ~2km grid even though all 4 gate stations sit
// inside SalishSeaCast's own much finer (~0.3-0.8km) native domain -- no
// code bug, just the map's own filter silently applying here too via
// loadCurrentField() (unchanged, still correct behavior, see that
// function's own comment) -- switching the dropdown alone fixes this half.
// (2) even SalishSeaCast's own nearest VALID cell can be a real eddy/
// backwater pocket right next to the actual channel in a narrow, high-shear
// pass -- confirmed for real at Dodd Narrows (nearest valid cell ~0.06kn,
// essentially slack, vs. that station's real currents up to ~9kn) -- a
// straight-line "nearest" pick has no notion of which side of a narrow
// channel it's landed on. An override lets the owner pick the right cell
// by eye instead (see startVerificationPick()).
// stationIds: array of real GATE_STATIONS ids -- see
// buildWindVerificationPoints()'s own comment on the 2026-08-07 switch from
// a single "all"-or-one-id value to a checked-ids array.
function buildCurrentVerificationPoints(stationIds) {
  const stationsData = window.GATE_STATIONS_DATA;
  const curveData = window.GATE_CURRENT_CURVE_DATA;
  if (!stationsData || !curveData || !curveData.stations) return [];
  // 2026-08-06: loadRawCurrentField(), NOT loadCurrentField() -- this
  // function's whole job is comparing CHS's curve against the REAL raw
  // model; the DFO-gate synthetic node (built FROM this same curve) would
  // make that comparison circular/trivially "perfect" if it were allowed
  // to win here. See loadRawCurrentField()'s own comment.
  const records = loadRawCurrentField();
  const overrides = loadVerificationOverrides();
  const points = [];
  stationsData.stations.forEach((st) => {
    if (!stationIds.includes(st.id)) return;
    const curve = curveData.stations[st.id];
    if (!curve || !curve.curve) return;
    const override = overrides[st.id];
    curve.curve.forEach((pt) => {
      if (typeof pt.speed_kn !== "number") return;
      const sample = override
        ? sampleCurrentAtAnchor(records, override.anchor, new Date(pt.time))
        : sampleCurrentNear(records, st.lat, st.lon, new Date(pt.time));
      if (!sample) return;
      // obsTime/modelTime: see buildWindVerificationPoints()'s own comment
      // on why scatter points carry both. Here obsTime is CHS's own curve
      // hour (pt.time, the "reference" queried) and modelTime is
      // sample.timeKey, the current-model timestamp sampleCurrentNear()/
      // sampleCurrentAtAnchor() actually landed on (nearestTimeKey() picks
      // the model's own nearest available hour to pt.time, which need not
      // be pt.time exactly).
      // 2026-08-07, owner's request -- clicking a scatter point pans the
      // map to its real gate station and opens that station's own current
      // graph (see handleVerificationPointClick()) -- needs the real
      // station id, not just its display name.
      points.push({ x: pt.speed_kn, y: sample.speedKn, label: st.name, obsTime: pt.time, modelTime: sample.timeKey, stationId: st.id });
    });
  });
  return points;
}

// Opens the Verification graph -- kind is "wind" or "current", stationIds is
// an array of checked station ids from the matching station list (see
// buildWindVerificationPoints()/buildCurrentVerificationPoints() and
// getSelectedVerificationStationIds() above). Wired to the sidebar's "Show
// verification graph" button, see DOMContentLoaded below.
function showVerificationGraph(kind, stationIds) {
  const isWind = kind === "wind";
  const points = isWind ? buildWindVerificationPoints(stationIds) : buildCurrentVerificationPoints(stationIds);
  const stats = computeVerificationStats(points);
  const stationsData = isWind ? window.WIND_STATIONS_DATA : window.GATE_STATIONS_DATA;
  const totalStations = ((stationsData && stationsData.stations) || []).length;
  let stationLabel;
  if (stationIds.length === 0) {
    stationLabel = "no stations selected";
  } else if (stationIds.length === totalStations) {
    stationLabel = "all stations";
  } else if (stationIds.length === 1) {
    const st = ((stationsData && stationsData.stations) || []).find((s) => s.id === stationIds[0]);
    stationLabel = (st && st.name) || stationIds[0];
  } else {
    stationLabel = `${stationIds.length} stations`;
  }
  const title = `${isWind ? "Wind" : "Current"} verification — ${stationLabel}`;

  if (points.length < 2) {
    const msg = isWind
      ? 'Not enough logged obs/model pairs yet for this station -- run "Refresh data" a few times to build up the log (data/wind_verification_log.js).'
      : "Not enough CHS/model pairs to plot -- check that data/current_field.js and data/gate_current_curve.js are both loaded (run \"Refresh data\").";
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText(msg, 12, h / 2, w - 24);
    }, "", null);
    return;
  }

  openGraphPopup(
    title,
    (ctx, w, h) =>
      // 2026-08-05: `return` added -- openGraphPopup()'s redraw() captures
      // this into activeChartLayout, which is what makes the hover popup
      // (station name/time) work at all; see drawScatterChart()'s own
      // comment.
      drawScatterChart(ctx, w, h, points, {
        color: isWind ? "#b8860b" : "#185fa5", // gold family (matches wind-station markers) vs. blue (matches current arrows)
        xUnitLabel: isWind ? "Observed wind speed (kn)" : "CHS predicted current speed (kn)",
        yUnitLabel: isWind ? "HRDPS model wind speed (kn)" : "Model current speed (kn)",
        // 2026-08-07, owner's request: click a scatter point -> pan the map
        // to its real station + open that station's own graph. Carried
        // through to the returned chartLayout (drawScatterChart()'s own
        // `verificationKind`) so openGraphPopup()'s click handler knows
        // which station list/graph type to use -- see
        // handleVerificationPointClick().
        pointKind: kind,
        stats,
      }),
    isWind
      ? `Each point is one logged (real station observation, nearest HRDPS model sample) pair from data/wind_verification_log.js, accumulated across every "Refresh data" run so far (${stats.n} pairs plotted). Dashed line = perfect model/obs agreement. Positive bias = model reads high vs. the real observation on average.`
      : `Each point is one hour of CHS's predicted gate current-speed curve vs. the nearest ${currentSourceLabel() === "both" ? "SalishSeaCast/CIOPS-West" : currentSourceLabel()} model sample at that station, across the whole currently loaded forecast window (${stats.n} pairs plotted). CHS's curve is a tidal/harmonic prediction, not a real buoy observation -- see the Verification section's own disclaimer. Dashed line = perfect agreement.`,
    null
  );
}

// 2026-08-07, owner's request: "When I click on a point in the graph,
// take me to that location and open the tidal graph." Called from
// openGraphPopup()'s canvas click handler when the open graph is a
// Verification scatter chart (chartLayout.verificationKind, set by
// drawScatterChart() from showVerificationGraph()'s own `kind`).
//
// "Current" points are gate stations -- CHS's predicted gate current
// curve IS a tidal/harmonic prediction (see the Verification section's
// own disclaimer text), so "the tidal graph" for one of these points is
// showGateCurrentGraph() at that gate, the same popup a real click on the
// gate's own map marker/route-leg warning opens.
//
// "Wind" points have no tidal-anything equivalent -- wind stations aren't
// tide/current stations. Rather than force a mismatched graph onto them,
// this opens openWindStationGraph() instead, the SAME graph a real click
// on that wind station's own map marker opens (real observation history
// if enough is logged, else the nearest-model-point graph) -- the closest
// real equivalent to "this point's own station graph" that exists for
// wind. Flagged: if the owner specifically wants NO graph for Wind
// clicks (only the map pan), this assumption needs revisiting.
function handleVerificationPointClick(kind, stationId) {
  if (!stationId) return; // "all stations" selections group multiple gate stations under one CHS-curve fetch, but every individual POINT (buildCurrentVerificationPoints()/buildWindVerificationPoints()) always carries its own real station id -- this is just a defensive no-op, not an expected path.
  const isWind = kind === "wind";
  const stationsData = isWind ? window.WIND_STATIONS_DATA : window.GATE_STATIONS_DATA;
  const station = stationsData && stationsData.stations && stationsData.stations.find((s) => s.id === stationId);
  if (!station || typeof station.lat !== "number" || typeof station.lon !== "number") return;
  // Same "pan to a station" call startVerificationPick() already uses --
  // see that function's own comment.
  map.setView([station.lat, station.lon], Math.max(map.getZoom(), 13));
  // 2026-08-07, owner's request: "highlight the location point." Same
  // red crosshair marker showPointQueryPopup() places at a clicked map
  // point (showClickPointMarker(), see its own comment) -- reused as-is
  // rather than a new marker style, since the need is identical: mark
  // exactly which spot this action refers to.
  showClickPointMarker(L.latLng(station.lat, station.lon));
  if (isWind) {
    openWindStationGraph(station);
  } else {
    showGateCurrentGraph(station, null);
  }
}

// Repopulates #verification-station-checkboxes to match whichever
// parameter (wind/current) is currently selected -- the two parameters draw
// from different station lists (WIND_STATIONS_DATA vs. GATE_STATIONS_DATA).
//
// 2026-08-07, owner's request: "add off/on buttons for each of the
// stations, so I can select the ones I want" -- was a single <select>
// offering "All stations" or exactly one specific station; now one
// checkbox per station plus an "All stations" bulk-select toggle (wired in
// DOMContentLoaded via a single delegated "change" listener on the
// container, since this function replaces the container's innerHTML on
// every call -- an individually-attached listener would be lost each time).
// Every checkbox defaults to checked, matching the old <select>'s "all"
// default. No previous-selection carryover across a parameter switch:
// station ids never collide between the two lists (same fact the old
// single-select version relied on), so there'd be nothing real to carry
// over -- this always resets to "everything checked" on a switch, same
// effective result the old code's fallback-to-"all" produced.
function populateVerificationStationOptions() {
  const paramSelect = document.getElementById("verification-param-select");
  const container = document.getElementById("verification-station-checkboxes");
  if (!paramSelect || !container) return;
  const kind = paramSelect.value;
  const stationsData = kind === "wind" ? window.WIND_STATIONS_DATA : window.GATE_STATIONS_DATA;
  const stations = (stationsData && stationsData.stations) || [];
  container.innerHTML =
    `<label class="verification-station-checkbox verification-station-all-row">
      <input type="checkbox" id="verification-station-all" checked> <strong>All stations</strong>
    </label>` +
    stations
      .map(
        (st) =>
          `<label class="verification-station-checkbox"><input type="checkbox" value="${st.id}" checked> ${st.name}</label>`
      )
      .join("");
}

// Returns the ids of every currently-checked individual station checkbox
// (NOT the "All stations" toggle itself, which has no `value` attribute --
// see the querySelector filter below) -- the array buildWindVerificationPoints()
// / buildCurrentVerificationPoints() / showVerificationGraph() now filter
// against, replacing the old single dropdown's one string value.
function getSelectedVerificationStationIds() {
  const container = document.getElementById("verification-station-checkboxes");
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"][value]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

// Removes the highlight marker set (if any) -- pulled out so both the
// button's own toggle-off click AND a parameter/station-checkbox change
// (which can make the current highlight set stale/wrong, e.g. switching
// Parameter swaps in a whole different station list) can clear it the same
// way, same pattern cancelVerificationPick() already uses for the pick
// tool below.
function clearVerificationHighlight() {
  if (verificationHighlightLayer) {
    map.removeLayer(verificationHighlightLayer);
    verificationHighlightLayer = null;
  }
  const button = document.getElementById("verification-highlight-btn");
  if (button) button.textContent = "Highlight";
}

// 2026-08-07, owner's request: "add a button for 'highlight the stations
// on the map that I have picked'." Places one crosshair marker (same
// `.click-point-marker` icon showClickPointMarker()/handleVerificationPointClick()
// already use elsewhere for "here's the exact spot this refers to", reused
// for visual consistency) at every currently-checked station's real
// coordinate, then pans/zooms the map to fit all of them. Always redraws
// from the CURRENT checkbox state rather than toggling on/off -- clicking
// this again after changing which stations are checked updates the
// highlight set to match, rather than just hiding whatever was there
// before (unchecking every station and clicking this is what clears it).
function highlightSelectedVerificationStations() {
  clearVerificationHighlight();
  const stationsData = window.WIND_STATIONS_DATA;
  const allStations = (stationsData && stationsData.stations) || [];
  const stations = allStations.filter((st) => typeof st.lat === "number" && typeof st.lon === "number");
  if (stations.length === 0) return;

  const markers = stations.map((st) => {
    // Keep the ring comfortably outside the geographic wind symbol. The
    // symbol grows with zoom, so the ring is rebuilt on zoomend below and
    // never shrinks below 34 px at wide zooms.
    const diameter = Math.max(34, windStationIconSizePx(st.lat) + 16);
    return L.marker([st.lat, st.lon], {
      icon: L.divIcon({
        className: "wind-station-highlight-marker",
        html: `<div class="wind-station-highlight-ring" style="width:${diameter}px;height:${diameter}px;"></div>`,
        iconSize: [diameter, diameter],
        iconAnchor: [diameter / 2, diameter / 2],
      }),
      interactive: false,
      keyboard: false,
    });
  });
  verificationHighlightLayer = L.layerGroup(markers).addTo(map);
  const button = document.getElementById("verification-highlight-btn");
  if (button) button.textContent = "Unhighlight";
}

// --- Current verification grid-point override (2026-08-06) ---
// See buildCurrentVerificationPoints()'s own updated comment for the full
// story/root cause. This block is: persistence (localStorage), the
// map-click "picking" interaction, and the sidebar status text -- in that
// order below.

const VERIFICATION_OVERRIDES_KEY = "sailvu_current_verification_overrides";
// In-memory mirror, lazily filled from localStorage on first read -- once
// loaded, this object (not a fresh localStorage.getItem() call) is the
// source of truth for the rest of the page session. That way an override
// picked mid-session still works for every subsequent graph even if
// localStorage itself is flaky or blocked (file://-served pages can behave
// inconsistently across browsers -- every read/write below is wrapped in
// try/catch for exactly this, degrading to "doesn't survive a reload"
// rather than a crash, never silently losing the pick you just made).
let verificationOverridesCache = null;

function loadVerificationOverrides() {
  if (verificationOverridesCache) return verificationOverridesCache;
  try {
    verificationOverridesCache = JSON.parse(localStorage.getItem(VERIFICATION_OVERRIDES_KEY) || "{}");
  } catch (e) {
    verificationOverridesCache = {};
  }
  return verificationOverridesCache;
}

// override shape: { anchor: {gridX, gridY} | {lat, lon}, lat, lon, source,
// pickedAt } -- anchor is what sampleCurrentAtAnchor() actually matches on
// (same shape showPointCurrentGraph() uses); lat/lon/source/pickedAt are
// display-only, for renderVerificationOverrideStatus()'s status text.
function saveVerificationOverride(stationId, override) {
  const all = loadVerificationOverrides();
  all[stationId] = override;
  try {
    localStorage.setItem(VERIFICATION_OVERRIDES_KEY, JSON.stringify(all));
  } catch (e) {
    // Unavailable/blocked localStorage -- the in-memory cache above still
    // has it for the rest of this page session, nothing more to do here.
  }
}

function clearVerificationOverride(stationId) {
  const all = loadVerificationOverrides();
  delete all[stationId];
  try {
    localStorage.setItem(VERIFICATION_OVERRIDES_KEY, JSON.stringify(all));
  } catch (e) {}
}

// --- Verification comment box (2026-08-07, owner's request: "Add comment
// box under Verification, plus Edit/Save.") ---
// One freeform note, not per-station/parameter -- same localStorage
// convention as VERIFICATION_OVERRIDES_KEY just above (own key, try/catch
// on every read/write, degrades to "doesn't survive a reload" rather than
// throwing if localStorage is blocked on a file://-served page).
const VERIFICATION_COMMENT_KEY = "sailvu_verification_comment";

function loadVerificationComment() {
  try {
    return localStorage.getItem(VERIFICATION_COMMENT_KEY) || "";
  } catch (e) {
    return "";
  }
}

function saveVerificationComment(text) {
  try {
    localStorage.setItem(VERIFICATION_COMMENT_KEY, text);
    return true;
  } catch (e) {
    // Blocked/unavailable localStorage -- the textarea itself still shows
    // what was typed for the rest of this page session, it just won't
    // survive a reload. Caller (the Save button handler) reports this in
    // #verification-comment-status rather than failing silently.
    return false;
  }
}

// How far around a gate station to offer candidate grid cells when picking
// -- deliberately wider than CURRENT_SAMPLE_MAX_KM (8km, the automatic-pick
// rejection distance) since the whole point is to let the owner see (and if
// useful, choose) cells the automatic pick would never have offered.
const VERIFICATION_PICK_RADIUS_KM = 10;

// Enters grid-point picking mode for one gate station. The next plain map
// click -- intercepted at the top of the map's own "click" handler in
// initMap(), same pattern aoiDrawing already uses there -- sets that
// station's verification override instead of opening the usual point-query
// popup. Also draws every real candidate cell within
// VERIFICATION_PICK_RADIUS_KM as its own small clickable dot, colored by
// speed (colorForFraction()/HEATMAP_GRADIENTS.classic, the same scale the
// heat map itself uses, scaled to the fastest candidate here rather than
// HEATMAP_MAX_KN's fixed 2.5kn open-water tuning -- these are gates/passes,
// routinely faster) so a slack backwater cell reads visibly differently
// from a fast one right next to it -- exactly the distinction that's hard
// to see from raw numbers alone. Uses the nearest time slice to whatever
// the map is currently showing (selectedFieldTime) and respects the
// current-source selector via loadCurrentField(), same as every other
// current consumer in this file.
function startVerificationPick(stationId) {
  const st = ((window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || []).find((s) => s.id === stationId);
  if (!st) return;
  verificationPickStationId = stationId;

  // 2026-08-06: loadRawCurrentField(), NOT loadCurrentField() -- the
  // DFO-gate synthetic node isn't a real, independently-existing grid cell
  // to offer as a pickable candidate here (see loadRawCurrentField()'s own
  // comment); it's placed exactly at the station's own coordinate anyway,
  // so it would just be a confusing zero-distance dot sitting on top of
  // the marker.
  const records = loadRawCurrentField();
  const { slice } = nearestSlice(records, selectedFieldTime);
  const candidates = slice
    .map((r) => {
      const vec = currentVectorKn(r);
      if (!vec) return null; // masked/no data at this cell -- not pickable
      const distKm = haversineKm(st, { lat: r.lat, lon: r.lon });
      if (distKm > VERIFICATION_PICK_RADIUS_KM) return null;
      return { record: r, distKm, speedKn: currentSpeedDir(vec).speedKn, source: vec.source || "SalishSeaCast" };
    })
    .filter(Boolean);

  if (verificationPickLayer) map.removeLayer(verificationPickLayer);
  verificationPickLayer = L.layerGroup();
  const maxKn = Math.max(1, ...candidates.map((c) => c.speedKn)); // floor of 1 so an all-slack neighborhood doesn't divide by ~0
  candidates.forEach((c) => {
    const color = colorForFraction(HEATMAP_GRADIENTS.classic, c.speedKn / maxKn);
    L.circleMarker([c.record.lat, c.record.lon], {
      radius: 6,
      stroke: false,
      fillColor: color,
      fillOpacity: 0.85,
    })
      .bindTooltip(`${c.speedKn.toFixed(2)} kn — ${c.distKm.toFixed(2)} km from ${st.name} (${c.source})`, { direction: "top" })
      .on("click", (e) => {
        // Stop this from also bubbling up to the map's own "click" handler
        // below (which would otherwise immediately re-pick via
        // nearestGridPoint() at the click coordinate -- usually the same
        // cell, but not guaranteed, and definitely redundant).
        L.DomEvent.stopPropagation(e);
        pickVerificationPoint(stationId, c.record);
      })
      .addTo(verificationPickLayer);
  });
  verificationPickLayer.addTo(map);
  map.setView([st.lat, st.lon], Math.max(map.getZoom(), 13));
  document.getElementById("map").style.cursor = "crosshair";
  renderVerificationOverrideStatus();
}

// Commits one real grid cell as a station's verification override -- called
// either from a candidate dot's own click handler above, or (if the owner
// clicks elsewhere on the map while picking, not exactly on a dot) from the
// map's own "click" handler falling back to nearestGridPoint() at the
// clicked coordinate, same forgiving click-near-it behavior
// showPointQueryPopup() already gives every other point query in this app.
function pickVerificationPoint(stationId, record) {
  const anchor =
    record.gridX !== undefined && record.gridY !== undefined
      ? { gridX: record.gridX, gridY: record.gridY }
      : { lat: record.lat, lon: record.lon };
  saveVerificationOverride(stationId, {
    anchor,
    lat: record.lat,
    lon: record.lon,
    source: record.source || "SalishSeaCast",
    pickedAt: new Date().toISOString(),
  });
  cancelVerificationPick();
}

// Leaves picking mode without necessarily having picked anything (also
// called right after a successful pick, above, to tear down the temporary
// candidate-dot layer and restore the normal map cursor/click behavior).
function cancelVerificationPick() {
  verificationPickStationId = null;
  if (verificationPickLayer) {
    map.removeLayer(verificationPickLayer);
    verificationPickLayer = null;
  }
  document.getElementById("map").style.cursor = "";
  renderVerificationOverrideStatus();
}

// Renders the override row/status text -- only shown at all for Current +
// exactly one checked station (an override is meaningless for Wind, which
// already has a real observation source, and with zero or multiple stations
// checked there's no single station to pick a point for). Called on every
// parameter/station change and after every pick/clear, so it never goes
// stale.
//
// 2026-08-07: "one specific station" used to mean the old <select>'s value
// wasn't "all"; now that stations are checkboxes (see
// populateVerificationStationOptions()), it means exactly one checkbox is
// checked -- see getSelectedVerificationStationIds().
function renderVerificationOverrideStatus() {
  const row = document.getElementById("verification-override-row");
  const statusEl = document.getElementById("verification-override-status");
  const pickBtn = document.getElementById("verification-pick-btn");
  const clearBtn = document.getElementById("verification-clear-override-btn");
  if (!row || !statusEl || !pickBtn || !clearBtn) return;

  const paramSelect = document.getElementById("verification-param-select");
  const selected = getSelectedVerificationStationIds();
  const stationId = selected.length === 1 ? selected[0] : null;
  const show = paramSelect && paramSelect.value === "current" && !!stationId;
  row.style.display = show ? "" : "none";
  statusEl.style.display = show ? "" : "none";
  if (!show) return;

  const picking = verificationPickStationId === stationId;
  pickBtn.textContent = picking ? "Cancel picking (click map, or Esc)" : "Pick verification point";
  const override = loadVerificationOverrides()[stationId];
  clearBtn.style.display = override ? "" : "none";

  if (picking) {
    statusEl.textContent = "Click a colored dot (or anywhere nearby) on the map to set this station's verification point.";
  } else if (override) {
    const st = ((window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || []).find((s) => s.id === stationId);
    const distKm = st ? haversineKm(st, override).toFixed(2) : "?";
    statusEl.textContent =
      `Using custom point: ${override.lat.toFixed(4)}, ${override.lon.toFixed(4)} ` +
      `(${override.source}, ${distKm} km from the official station coordinate) instead of the automatic nearest pick.`;
  } else {
    statusEl.textContent = "Using the automatically nearest model grid point (default) -- no override set.";
  }
}

// 2026-08-05: hover readout, shared by every graph type via the canvas
// mousemove handler in ensureGraphModal() -- owner's request to be able to
// hover any point on a graph and read its x/y value, with the nearest
// point highlighted. `layout` is whatever drawLineChart() most recently
// returned (see that function's own comment); `point` is the nearest real
// {x: Date, y: number} sample to the cursor, already chosen by the caller
// (against layout.sorted -- see drawMultiLineChart()'s own comment on why
// IT sets `sorted` to its longest series, purely so this x-nearest lookup
// keeps working unchanged for a multi-series layout too).
// Drawn on top of a just-completed clean redraw (see the mousemove
// handler), so this never needs to erase a previous frame itself.
//
// 2026-08-05 follow-up: `layout.series` (plural -- only set by
// drawMultiLineChart()) switches this into a multi-value mode: instead of
// one dot/one-line label for `point.y`, it draws one small dot per series
// (colored to match that series' line) and a multi-line label listing
// every series' own value AT point.x (via interpolateYAtTime() -- the
// cursor's snapped x won't usually land exactly on every series' own
// sample times, especially when current/wind data was missing at some
// steps and that series has fewer points than others). Single-series
// callers (every graph type before this one) never set `layout.series`,
// so their behavior is completely unchanged.
function drawChartHoverOverlay(ctx, layout, point) {
  const { pad, plotH, xToPx, yToPx, width, yUnitLabel } = layout;
  const px = xToPx(point.x.getTime());

  ctx.save();

  // Vertical guide line under the cursor's snapped-to-data x position --
  // lighter/finer than the marker lines (dotted, gray) so it doesn't read
  // as another data marker.
  ctx.strokeStyle = "#999";
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(px, pad.top);
  ctx.lineTo(px, pad.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const dateStr = point.x.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  if (layout.series) {
    // Multi-series mode: one dot per series (skipping any series with no
    // usable value at this x -- e.g. no wind sample anywhere near this
    // stretch of the route), then a stacked label box.
    const rows = [];
    layout.series.forEach((s) => {
      if (!s.sorted.length) return;
      const y = interpolateYAtTime(s.sorted, point.x.getTime());
      if (y === null) return;
      // s.yToPx (left- or right-axis, whichever this series is on) -- NOT
      // the bare layout.yToPx, which is left-axis only. See
      // drawMultiLineChart()'s own comment on why a right-axis series
      // (e.g. Waves, different units from Current/Wind/Combined) needs its
      // own scale here too, not just when its line was originally drawn.
      const py = s.yToPx(y);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const unit = s.unit || yUnitLabel;
      rows.push({ color: s.color, text: `${s.label}: ${y.toFixed(2)}${unit ? " " + unit : ""}` });
    });

    ctx.font = "11px sans-serif";
    const lineH = 14;
    const measuredW = Math.max(ctx.measureText(dateStr).width, ...rows.map((r) => ctx.measureText(r.text).width));
    const boxPad = 5;
    const boxW = measuredW + boxPad * 2 + 12; // +12 for the color swatch column
    const boxH = lineH * (rows.length + 1) + boxPad * 2;
    let boxX = px + 8;
    if (boxX + boxW > width) boxX = px - boxW - 8;
    if (boxX < 0) boxX = 2;
    let boxY = pad.top + 4;

    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#222";
    ctx.fillText(dateStr, boxX + boxPad, boxY + boxPad + lineH / 2);
    rows.forEach((r, i) => {
      const rowY = boxY + boxPad + lineH * (i + 1) + lineH / 2;
      ctx.fillStyle = r.color;
      ctx.fillRect(boxX + boxPad, rowY - 4, 8, 8);
      ctx.fillStyle = "#222";
      ctx.fillText(r.text, boxX + boxPad + 12, rowY);
    });

    ctx.restore();
    return;
  }

  const py = yToPx(point.y);

  // Highlighted point
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Date + value readout in a small label box, flipped left/up whenever
  // the default right-and-above placement would run off whichever canvas
  // edge is closest -- same reasoning as drawLineChart()'s own marker
  // label above (this is deliberately similar/adjacent code, not
  // factored into one shared helper, since the two have slightly
  // different layout needs: a filled box here vs. plain text there).
  const valStr = point.y.toFixed(2) + (yUnitLabel ? " " + yUnitLabel : "");
  const text = `${dateStr}  ${valStr}`;
  ctx.font = "11px sans-serif";
  const textW = ctx.measureText(text).width;
  const boxPad = 4;
  const boxW = textW + boxPad * 2;
  const boxH = 16;
  let boxX = px + 8;
  if (boxX + boxW > width) boxX = px - boxW - 8;
  if (boxX < 0) boxX = 2;
  let boxY = py - boxH - 6;
  if (boxY < pad.top) boxY = py + 10;

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#222";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, boxX + boxPad, boxY + boxH / 2);

  ctx.restore();
}

// Formats a millisecond delta (model time minus obs/reference time) as a
// short signed duration, e.g. "+1h 05m", "-20 min", "+0 min" -- used by
// drawScatterHoverOverlay()'s own Δt row, below. Sign convention matches
// computeVerificationStats()'s bias (model minus reference): positive means
// the model sample is timestamped LATER than the obs/reference point it was
// paired against.
function formatTimeDiff(ms) {
  const totalMin = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const mag = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
  return (ms < 0 ? "-" : "+") + mag;
}

// 2026-08-05: scatter analogue of drawChartHoverOverlay() above, added at
// the owner's request ("Wind works well - add name/time popup when mouse is
// over a point") -- a scatter point's x is a plain number (a speed), not a
// Date, so there's no time axis on this chart type for a value to line up
// against; the popup is the only place a scatter point's station name/time
// can be shown at all. `point` here is one entry from drawScatterChart()'s
// own `plotted` array (already has real px/py baked in -- see that
// function's comment), picked by ensureGraphModal()'s mousemove handler via
// plain 2D pixel distance (nearest dot to the cursor), NOT the x-only
// nearest-in-time search drawLineChart()'s layout uses.
//
// 2026-08-05 follow-up: owner's next request -- show the time gap between
// the obs/reference side and the model side of the pair too, not just each
// side's own timestamp. obsTime/modelTime are genuinely different moments
// (see buildWindVerificationPoints()'s/buildCurrentVerificationPoints()'s
// own comments on what each represents), so this Δt is a real property of
// the pairing -- e.g. a large Δt on an outlier point is a legitimate reason
// that point's obs/model values disagree, not just noise.
function drawScatterHoverOverlay(ctx, layout, point) {
  const { width, height } = layout;
  ctx.save();

  // Highlighted point -- same look as drawChartHoverOverlay()'s own dot.
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(point.px, point.py, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Station/gate name always shown; obs/model timestamps and their gap only
  // if this point carries them (buildWindVerificationPoints()/
  // buildCurrentVerificationPoints() both set both fields, but a future
  // scatter caller that doesn't would just get a name-only popup rather
  // than an "Invalid Date" string).
  const lines = [point.label || "(unnamed)"];
  const fmtOpts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const obsD = point.obsTime ? new Date(point.obsTime) : null;
  const modelD = point.modelTime ? new Date(point.modelTime) : null;
  const obsValid = obsD && !isNaN(obsD.getTime());
  const modelValid = modelD && !isNaN(modelD.getTime());
  if (obsValid) lines.push(`Obs: ${obsD.toLocaleString(undefined, fmtOpts)}`);
  if (modelValid) lines.push(`Model: ${modelD.toLocaleString(undefined, fmtOpts)}`);
  if (obsValid && modelValid) {
    lines.push(`Δt: ${formatTimeDiff(modelD.getTime() - obsD.getTime())}`);
  }
  const xStr = point.x.toFixed(2) + (layout.xUnitLabel ? " " + layout.xUnitLabel : "");
  const yStr = point.y.toFixed(2) + (layout.yUnitLabel ? " " + layout.yUnitLabel : "");
  lines.push(xStr, yStr);

  ctx.font = "11px sans-serif";
  const lineH = 14;
  const boxPad = 5;
  const measuredW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = measuredW + boxPad * 2;
  const boxH = lineH * lines.length + boxPad * 2;
  // Flip left/up whenever the default right-and-below placement would run
  // off whichever canvas edge is closest -- same reasoning as
  // drawChartHoverOverlay()'s own label placement above.
  let boxX = point.px + 8;
  if (boxX + boxW > width) boxX = point.px - boxW - 8;
  if (boxX < 0) boxX = 2;
  let boxY = point.py + 8;
  if (boxY + boxH > height) boxY = point.py - boxH - 8;
  if (boxY < 0) boxY = 2;

  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#222";
  lines.forEach((line, i) => {
    // First line (the name) bold-ish via a slightly larger/darker weight cue
    // isn't available without a second font load, so it's just listed first
    // -- position alone reads as "the label" ahead of the time/value rows.
    ctx.fillText(line, boxX + boxPad, boxY + boxPad + lineH * i + lineH / 2);
  });

  ctx.restore();
}

// Builds a smooth-ish curve between a tide station's known high/low events,
// purely for the chart -- NOT a claim about the true intermediate shape,
// unlike the gate current-speed curve below (which is the real continuous
// CHS series). Each segment between two consecutive known events is eased
// with a half-cosine (so it eases in/out at each known point the way a real
// tide does, rather than a sawtooth straight line). Always clearly labeled
// as interpolated in the popup's caption (see showTideGraph()) -- the
// project's report-writing rigor standard applies here too: don't present
// an estimate as measured data.
function interpolateTideCurve(events, stepsPerSegment) {
  stepsPerSegment = stepsPerSegment || 12;
  const pts = [];
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i], b = events[i + 1];
    const t0 = new Date(a.time).getTime();
    const t1 = new Date(b.time).getTime();
    for (let s = 0; s < stepsPerSegment; s++) {
      const f = s / stepsPerSegment;
      const eased = (1 - Math.cos(f * Math.PI)) / 2; // half-cosine ease, not linear
      const h = a.height_m + (b.height_m - a.height_m) * eased;
      pts.push({ x: new Date(t0 + (t1 - t0) * f), y: h });
    }
  }
  const last = events[events.length - 1];
  if (last) pts.push({ x: new Date(last.time), y: last.height_m });
  return pts;
}

// --- Reusable "About" info popup (2026-08-03) ---
// Small text-only modal, added when the Current Field/Wind Field sidebar
// sections were flattened from their own <details> into a single
// checkbox + About row each (per the owner's request to cut sidebar
// verbosity -- see index.html's own comment above those rows). Deliberately
// reuses the graph-modal-overlay/.graph-modal/.graph-modal-header CSS
// already built for openGraphPopup() (style.css) rather than inventing a
// second modal look -- same overlay/backdrop/close-button behavior, just a
// plain text body (.info-modal-body) instead of a canvas. A SEPARATE
// overlay element from the graph modal's (own graphModalEl), so an About
// popup and a graph popup can't collide if both existed at once, even
// though in practice only one is ever open at a time.
let infoModalEl = null;

function ensureInfoModal() {
  if (infoModalEl) return infoModalEl;
  const overlay = document.createElement("div");
  overlay.className = "graph-modal-overlay";
  overlay.innerHTML =
    `<div class="graph-modal">` +
    `<div class="graph-modal-header"><span class="graph-modal-title"></span><button class="graph-modal-close" aria-label="Close">&times;</button></div>` +
    `<div class="info-modal-body"></div>` +
    `</div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeInfoPopup();
  });
  overlay.querySelector(".graph-modal-close").addEventListener("click", closeInfoPopup);
  document.body.appendChild(overlay);
  infoModalEl = overlay;
  return overlay;
}

function closeInfoPopup() {
  if (infoModalEl) infoModalEl.classList.remove("open");
}

// title: modal header text. bodyHtml: raw HTML shown in the body -- callers
// pass the same status text that used to sit inline in the sidebar (e.g.
// #current-field-info's innerHTML, still kept up to date by
// renderCurrentArrowsOnMap() exactly as before, just [hidden] in the
// sidebar now instead of removed) so nothing already written had to be
// re-authored for this popup.
function showInfoPopup(title, bodyHtml) {
  const overlay = ensureInfoModal();
  overlay.querySelector(".graph-modal-title").textContent = title;
  overlay.querySelector(".info-modal-body").innerHTML = bodyHtml;
  overlay.classList.add("open");
}

// Opens the tide-cycle graph popup for one tide station, using whatever
// high/low events are on file in data/tide_predictions.js (loadTidePredictions()).
function showTideGraph(station) {
  const predictions = loadTidePredictions();
  const stationPred = predictions[station.id];
  if (!stationPred || !stationPred.ok || !stationPred.events || stationPred.events.length < 2) {
    openGraphPopup(`${station.name} — tide graph`, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough tide events on file to plot a graph.", 12, h / 2);
    }, "", null);
    return;
  }
  const events = stationPred.events;
  const curvePts = interpolateTideCurve(events);
  const eventPts = events.map((e) => ({ x: new Date(e.time), y: e.height_m }));
  const timeBounds = { min: curvePts[0].x, max: curvePts[curvePts.length - 1].x };
  openGraphPopup(
    `${station.name} — tide graph`,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-05: owner's request -- this graph (and the gate current
      // graph below) should look like the point-query graphs' single
      // dashed "now" line + solid curve, not its own different style.
      // `dashed: true` (used to mark this curve as interpolated, not
      // measured) is dropped for the same reason -- see the note text
      // below, which still says so in words instead now.
      const nowMarker = buildTimeMarkers();
      return drawLineChart(ctx, w, h, filterPointsByRange(curvePts, rangeStart, rangeEnd), {
        color: TIDE_STATION_COLOR,
        yUnitLabel: "m (chart datum)",
        extraPoints: filterPointsByRange(eventPts, rangeStart, rangeEnd),
        markers: nowMarker,
      });
    },
    `Smoothed interpolation between the known High/Low events (marked with dots) — not a measured curve. Heights in meters, chart datum. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window. Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds
  );
}

// Opens the current-cycle graph popup for one gate station, using the real
// continuous wcsp1 curve in data/gate_current_curve.js if loaded, with the
// existing discrete slack/max-ebb/max-flood events (already shown as text
// in the sidebar/warnings) overlaid as colored dots ON the curve, so this
// chart and that text read as the same underlying data, not two
// disconnected views.
//
// 2026-08-05: those events used to each get their own full-height dashed
// vertical line (plus, after that same day's earlier marker-labeling
// change, a text label on every one of them) -- with a typical ~3-day
// window covering a dozen-plus slack/ebb/flood events, that was a wall of
// a dozen-plus dashed lines and labels, not the clean "one dashed line"
// look the other graphs have. Owner's request: bring this down to the
// SAME look as every other graph -- exactly one dashed "now" line
// (opts.markers, still auto-labeled by drawLineChart()) plus the generic
// on-hover dotted line, with the slack/ebb/flood events now plotted as
// color-coded dots via opts.extraPoints instead (same mechanism
// showTideGraph() already used for its own known High/Low events, extended
// this same day to support per-point color -- see drawLineChart()'s
// extraPoints comment). Their color-coding (grey=slack, red=max-ebb,
// blue=max-flood) is unchanged, just moved from a line's stroke color to a
// dot's fill color, and each dot's height comes from interpolateYAtTime()
// against the curve itself rather than sitting the events at a fixed
// height.
// 2026-08-05: legMarker (optional -- {x: Date, label: string}) added, per
// the owner's request ("plot the Gate current for the appropriate time
// where a route leg goes through or near a gate"). "The appropriate time"
// is the same `arriveTime` renderWarnings() already computes and uses for
// this exact gate/leg pairing (its CHS next-event lookup and its
// SalishSeaCast model-sample text both already key off it) -- reused here
// rather than a new, second notion of "when the route is at this gate."
// Drawn alongside the existing live "now"/map-time marker (own color/
// label), not instead of it -- both are useful reference points on the
// same chart. Undefined when this is opened by clicking a gate marker
// directly on the map (the original, still-supported call path, no route
// context available there).
function showGateCurrentGraph(station, legMarker, windowOptions) {
  const curveData = window.GATE_CURRENT_CURVE_DATA;
  const stationCurve = curveData && curveData.stations && curveData.stations[station.id];
  if (!stationCurve || !stationCurve.ok || !stationCurve.curve || stationCurve.curve.length < 2) {
    openGraphPopup(`${station.name} — current graph`, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("No current-curve data on file (run scripts/fetch_model_data.py).", 12, h / 2);
    }, "", null);
    return;
  }
  const allPts = stationCurve.curve.map((c) => ({ x: new Date(c.time), y: c.speed_kn }));
  const requestedStart = windowOptions && windowOptions.start instanceof Date ? windowOptions.start : null;
  const requestedEnd = windowOptions && windowOptions.end instanceof Date ? windowOptions.end : null;
  const pts = requestedStart && requestedEnd
    ? allPts.filter((point) => point.x >= requestedStart && point.x <= requestedEnd)
    : allPts;
  if (pts.length < 2) {
    openGraphPopup(`${station.name} — 24-hour window`, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("No gate-current curve is available in this 24-hour window.", 12, h / 2);
    }, "Refresh tide and gate data to obtain the current 24-hour prediction window.", null);
    return;
  }
  const sortedPts = [...pts].sort((a, b) => a.x.getTime() - b.x.getTime());
  const predictions = loadGatePredictions();
  const stationPred = predictions[station.id];
  const eventDots = ((stationPred && stationPred.events) || [])
    .map((e) => {
      const x = new Date(e.time);
      const y = interpolateYAtTime(sortedPts, x.getTime());
      if (y === null) return null; // event time fell entirely outside the curve's own range -- skip rather than guess
      return {
        x,
        y,
        color: e.type === "SLACK" ? "#888" : e.type === "EXTREMA_EBB" ? "#a33" : "#2a628f",
      };
    })
    .filter(Boolean);
  const timeBounds = { min: requestedStart || pts[0].x, max: requestedEnd || pts[pts.length - 1].x };
  const makingGate = windowOptions && windowOptions.makingGate;
  const makingGateDynamic = !!(windowOptions && windowOptions.makingGateDynamic);
  const arrivalBeyondWindow = makingGate && makingGate.arrival > timeBounds.max;
  openGraphPopup(
    makingGate || makingGateDynamic ? `${station.name} — making it to the gate (24h window)` : `${station.name} — current graph`,
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-05: computed INSIDE renderFn (not once outside it) --
      // same live-refresh pattern showPointCurrentGraph()/
      // showRouteConditionsGraph() already use, so this marker also moves
      // when refreshFieldTimeDependents() repaints an open graph on every
      // map time-step (PageUp/PageDown/slider/Prev-Next/Home).
      // 2026-08-07: nowMarker itself no longer run through
      // filterPointsByRange() -- `now: true` lets it draw a flashing
      // out-of-range arrow instead of vanishing (see drawNowArrow()'s own
      // comment). legMarker keeps the original filtered/silent-skip
      // behavior -- the owner only asked for the arrow treatment on the
      // live/map-time line, not a route leg's own gate-arrival marker.
      const nowMarker = buildTimeMarkers();
      if (makingGate || makingGateDynamic) {
        const mapMarker = nowMarker.find((marker) => marker.label === "MAP");
        if (mapMarker) {
          const deltaMinutes = Math.round((mapMarker.x.getTime() - Date.now()) / 60000);
          const sign = deltaMinutes < 0 ? "-" : "+";
          const absoluteMinutes = Math.abs(deltaMinutes);
          mapMarker.label = `Map ${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")} hrs`;
        }
      }
      const dynamicArrival = makingGateDynamic && makingGateArrivalMarker && makingGateArrivalMarker.stationId === station.id
        ? makingGateArrivalMarker
        : null;
      const activeArrivalMarker = dynamicArrival || legMarker;
      const otherMarkers = activeArrivalMarker ? [{ ...activeArrivalMarker, color: activeArrivalMarker.color || "#2e7d32" }] : [];
      const visibleOtherMarkers = dynamicArrival ? otherMarkers : filterPointsByRange(otherMarkers, rangeStart, rangeEnd);
      return drawLineChart(ctx, w, h, filterPointsByRange(pts, rangeStart, rangeEnd), {
        color: "#b4472a",
        yUnitLabel: "kn",
        markers: [...visibleOtherMarkers, ...nowMarker],
        extraPoints: filterPointsByRange(eventDots, rangeStart, rangeEnd),
      });
    },
    `Real CHS current-speed prediction curve (magnitude only — not signed by ebb/flood direction). Colored dots mark the discrete slack (grey) / max-ebb (red) / max-flood (blue) events already shown in the sidebar. Grey dashed line ("Map time"/"Now") marks the present/map-scrubbed time and moves live as you step it — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window.` +
      (legMarker ? ` Green dashed line marks the route leg's own forecast arrival time at this gate — the time actually relevant for passage planning, not "now".` : ``) +
      (makingGate ? ` Clicked position is ${makingGate.distanceNm.toFixed(1)} NM from the gate; at ${makingGate.speedKn.toFixed(1)} kn the estimated arrival is ${makingGate.arrival.toLocaleString()}.` : ``) +
      (makingGateDynamic ? ` Select “Click present position on map” and click the map to add the boat's estimated arrival line.` : ``) +
      (arrivalBeyondWindow ? ` The estimated arrival is beyond this 24-hour graph window.` : ``) +
      ` Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds
  );
}

// East/north component series at one fixed anchor, across every time step
// -- shared by showGateCurrentComponentsGraph() below for BOTH the
// automatic-nearest anchor and (when set) a verification-override anchor,
// so the two aren't two hand-copied loops. Same matchesCurrentAnchor()
// pinning sampleCurrentAtAnchor()/showPointCurrentGraph() use -- one fixed
// cell across the whole series, not a fresh nearest-neighbor search per hour.
function extractComponentSeries(records, anchor) {
  const eastPts = [], northPts = [];
  let sourceLabel = "SalishSeaCast";
  records
    .filter((r) => matchesCurrentAnchor(r, anchor))
    .forEach((r) => {
      const vec = currentVectorKn(r);
      if (!vec) return; // masked/no data at this cell for this time slice -- skip, don't plot a gap as zero
      sourceLabel = vec.source || sourceLabel;
      eastPts.push({ x: new Date(r.time), y: vec.eastKn });
      northPts.push({ x: new Date(r.time), y: vec.northKn });
    });
  eastPts.sort((a, b) => a.x - b.x);
  northPts.sort((a, b) => a.x - b.x);
  return { eastPts, northPts, sourceLabel };
}

// 2026-08-06: standard oceanographic "current ellipse" diagnostic --
// eigen-decomposition of the east/north covariance matrix. A real tidal
// PASS should show strongly rectilinear (back-and-forth along one line)
// flow, not a wandering/rotary vector, since water squeezed through a
// narrow channel has nowhere to go but along it. `rectilinearity` is
// 1 - minorAxis/majorAxis: 1.0 = perfectly reversing along one bearing
// (an ideal narrow-channel signature), 0.0 = a perfect circle (no
// preferred direction at all -- would be a red flag for a point claimed to
// represent a pass). `bearingDeg` is the major axis' own compass bearing,
// folded to 0-180° since an axis (unlike a single vector) has no
// forward/backward sense -- compare this by eye against the pass' own
// real charted orientation. Not invented for this app -- this is the same
// analysis real oceanographers run on current-meter records; used here as
// a quantitative way to answer "which candidate point's flow looks more
// like a real channel," not just eyeballing two overlaid lines.
function currentEllipseStats(eastPts, northPts) {
  const n = Math.min(eastPts.length, northPts.length);
  if (n < 3) return null;
  const e = eastPts.slice(0, n).map((p) => p.y);
  const nn = northPts.slice(0, n).map((p) => p.y);
  const meanE = e.reduce((a, b) => a + b, 0) / n;
  const meanN = nn.reduce((a, b) => a + b, 0) / n;
  let cee = 0, cnn = 0, cen = 0;
  for (let i = 0; i < n; i++) {
    const de = e[i] - meanE, dn = nn[i] - meanN;
    cee += de * de;
    cnn += dn * dn;
    cen += de * dn;
  }
  cee /= n; cnn /= n; cen /= n;
  const trace = cee + cnn;
  const spread = Math.sqrt(((cee - cnn) / 2) ** 2 + cen ** 2);
  const major = trace / 2 + spread;
  const minor = Math.max(0, trace / 2 - spread);
  const rectilinearity = major > 0 ? 1 - minor / major : 0;
  // Same math-angle -> compass-bearing conversion currentSpeedDir() uses,
  // then folded to 0-180 -- this is an AXIS (a line), not a directed
  // vector, so e.g. 40 deg and 220 deg describe the exact same axis.
  const mathAngle = 0.5 * Math.atan2(2 * cen, cee - cnn);
  const bearingDeg = ((90 - toDeg(mathAngle) + 360) % 360) % 180;
  return { rectilinearity, bearingDeg, majorAmpKn: Math.sqrt(major) };
}

function ellipseStatsText(label, stats) {
  if (!stats) return `${label}: not enough data to compute.`;
  return `${label}: rectilinearity ${stats.rectilinearity.toFixed(2)} (1.0 = perfectly back-and-forth along one line, 0.0 = a circle), major-axis bearing ${stats.bearingDeg.toFixed(0)}°/${((stats.bearingDeg + 180) % 360).toFixed(0)}°, amplitude ${stats.majorAmpKn.toFixed(2)}kn.`;
}

// 2026-08-06: exact-anchor equality -- distinct from matchesCurrentAnchor()
// (which tests a RECORD against an anchor) -- this compares two ANCHORS
// directly, used by showGateCurrentComponentsGraph() to detect and flag
// the real, owner-reported case of a picked verification point resolving
// to the exact same model cell the automatic pick already uses (easy to do
// by accident -- clicking near the station marker itself, rather than a
// visibly farther candidate dot, naturally snaps right back to the nearest
// cell, since that's by definition the closest one to any nearby click
// too). Without this check the two "auto"/"picked" line-pairs would
// silently draw as identical, and the resulting "picked" numbers weren't
// obviously matching until now.
function anchorsEqual(a, b) {
  if (!a || !b) return false;
  return a.gridX !== undefined ? a.gridX === b.gridX && a.gridY === b.gridY : a.lat === b.lat && a.lon === b.lon;
}

// 2026-08-06: signed East/West and North/South current-component graph for
// a gate station -- owner's backlog item ("plot the current graphs as N/S
// for Dodd Narrows, all other Gates E/W... two parallel plots"), revisited
// now that it's buildable on the MODEL side today: CHS's own curve (above)
// is still unsigned-magnitude-only, blocked on a real direction dataset
// (BACKLOG.md), but the model (`currentVectorKn()`'s eastKn/northKn) has
// always carried real signed components -- this just plots them, no new
// data needed.
//
// 2026-08-06 follow-up, same day: when a verification override exists for
// this station, ALSO plots the automatic-nearest point's own components
// alongside it (solid = auto, dashed = picked -- same lineDash convention
// the route-conditions graph already established) -- owner's own follow-up
// request ("compare the components for the Model" -- picked point vs.
// automatic nearest point), a direct visual+numeric test of whether
// picking actually found a more representative cell. Falls back to a
// single (auto-only) pair when no override is set, same as before.
function showGateCurrentComponentsGraph(station) {
  // 2026-08-06: loadRawCurrentField(), NOT loadCurrentField() -- both the
  // "auto" and "picked" points in this graph are meant to be real,
  // independently-existing model cells (that's the whole comparison this
  // graph exists to make); the DFO-gate synthetic node sits exactly at the
  // station's own coordinate and would just win every "nearest" contest
  // trivially, collapsing the comparison. See loadRawCurrentField()'s own
  // comment.
  const records = loadRawCurrentField();
  const title = `${station.name} — East/North current components (model)`;
  if (!records.length) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Current field not loaded (run scripts/fetch_model_data.py).", 12, h / 2);
    }, "", null);
    return;
  }

  const { slice } = nearestSlice(records, selectedFieldTime);
  const nearest = nearestGridPoint(slice, station.lat, station.lon);
  if (!nearest) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText(`No current sample near ${station.name}.`, 12, h / 2);
    }, "", null);
    return;
  }
  const autoAnchor =
    nearest.record.gridX !== undefined && nearest.record.gridY !== undefined
      ? { gridX: nearest.record.gridX, gridY: nearest.record.gridY }
      : { lat: nearest.record.lat, lon: nearest.record.lon };
  const autoSeries = extractComponentSeries(records, autoAnchor);

  const override = loadVerificationOverrides()[station.id];
  const pickedSeries = override ? extractComponentSeries(records, override.anchor) : null;

  if (autoSeries.eastPts.length < 2 && (!pickedSeries || pickedSeries.eastPts.length < 2)) {
    openGraphPopup(title, (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("Not enough current-field data on file to plot a graph.", 12, h / 2);
    }, "", null);
    return;
  }

  const allPts = [...autoSeries.eastPts, ...(pickedSeries ? pickedSeries.eastPts : [])];
  const timeBounds = {
    min: allPts.reduce((m, p) => (p.x < m ? p.x : m), allPts[0].x),
    max: allPts.reduce((m, p) => (p.x > m ? p.x : m), allPts[0].x),
  };

  const autoStats = currentEllipseStats(autoSeries.eastPts, autoSeries.northPts);
  const pickedStats = pickedSeries ? currentEllipseStats(pickedSeries.eastPts, pickedSeries.northPts) : null;
  // 2026-08-06: real owner-reported case -- a pick that lands on the exact
  // same cell the automatic pick already uses (see anchorsEqual()'s own
  // comment for why this happens easily). pickedDistKm shown in the
  // "picked" series' own label, same as "auto"'s, so this is visible on
  // the chart itself, not just in the note text below.
  const sameAsAuto = pickedSeries && anchorsEqual(autoAnchor, override.anchor);
  const pickedDistKm = pickedSeries ? haversineKm(station, override) : null;

  openGraphPopup(
    title,
    (ctx, w, h, rangeStart, rangeEnd) => {
      const nowMarker = buildTimeMarkers();
      const autoLabel = pickedSeries ? `East — auto (${nearest.distKm.toFixed(2)}km)` : "East (+) / West (−)";
      const autoNLabel = pickedSeries ? `North — auto (${nearest.distKm.toFixed(2)}km)` : "North (+) / South (−)";
      const series = [
        { points: filterPointsByRange(autoSeries.eastPts, rangeStart, rangeEnd), color: "#1a7a3c", label: autoLabel, shape: "circle", showPoints: true },
        { points: filterPointsByRange(autoSeries.northPts, rangeStart, rangeEnd), color: "#a3341a", label: autoNLabel, shape: "triangle", showPoints: true },
      ];
      if (pickedSeries) {
        series.push(
          { points: filterPointsByRange(pickedSeries.eastPts, rangeStart, rangeEnd), color: "#1a7a3c", label: `East — picked (${pickedDistKm.toFixed(2)}km)`, shape: "circle", showPoints: true, lineDash: [7, 4] },
          { points: filterPointsByRange(pickedSeries.northPts, rangeStart, rangeEnd), color: "#a3341a", label: `North — picked (${pickedDistKm.toFixed(2)}km)`, shape: "triangle", showPoints: true, lineDash: [7, 4] }
        );
      }
      return drawMultiLineChart(ctx, w, h, series, { yUnitLabel: "kn", markers: nowMarker });
    },
    (sameAsAuto
      ? `<strong>Your picked point is the exact same model cell the automatic pick already uses</strong> (both line-pairs below are identical, by construction — not a display bug). This happens when the map click that set the override landed closer to this cell than to any other real grid cell — easy to do by clicking near the station marker itself. Go to Setup → Verification → Current → ${station.name} → "Pick verification point" again and click a colored dot noticeably farther from the marker (one further into the channel, not right on top of it) for a genuinely different comparison. `
      : pickedSeries
      ? `Comparing the automatically nearest model point (${nearest.distKm.toFixed(2)}km from ${station.name}, solid lines) against your picked verification point (${pickedDistKm.toFixed(2)}km from the station, ${override.source}, dashed lines). `
      : `Signed East/West and North/South components of the modeled current (${autoSeries.sourceLabel}) at the automatically nearest model point (${nearest.distKm.toFixed(2)}km away — pick a verification point in Setup → Verification to compare it against this one). `) +
      `Positive East = flowing east, positive North = flowing north. ` +
      ellipseStatsText("Auto point", autoStats) +
      (pickedStats ? ` ${ellipseStatsText("Picked point", pickedStats)}` : "") +
      ` A higher rectilinearity and a major-axis bearing closer to ${station.name}'s own real channel orientation both argue for that point being the more representative one. Dashed vertical line marks the present time (or the map's scrubbed time, if set) — a flashing arrow at the plot edge points toward it when it falls outside the plotted/zoomed window. Static pre-download — re-run the data pipeline to refresh. Drag the Start/End sliders below the chart to zoom into a narrower time window.`,
    timeBounds
  );
}

// Compares "now" against a data file's valid_from/valid_to (if present) and
// returns a status string plus whether it should be flagged as stale. Used
// for both gate_predictions.js and current_field.js -- same shape of
// problem (a static, dated snapshot silently going out of its covered
// window), so one function covers both.
// 2026-08-03: added a `valid` field (distinct from `stale`) per the
// owner's request that these rows read red by default, green+bold only
// when genuinely-loaded, currently-applicable data backs them -- `stale`
// alone didn't quite match that: the "not yet in effect" case is also
// `stale: false` (it's not an EXPIRED snapshot) but isn't really "valid,
// loaded data" either (it doesn't apply yet). `valid` is true only for the
// final "current" branch below -- the one genuinely-good state.
// treatNotYetInEffectAsCurrent (added 2026-08-03): the current-field/wind
// rows routinely showed "not yet in effect" for a completely mundane
// reason -- their valid_from is the first hourly forecast step at/after
// fetch time (_resolve_time_index_window() in fetch_model_data.py), which
// can sit a few minutes to just under an hour AHEAD of the actual fetch
// moment. Anyone loading the page in that short window saw an alarming-
// looking message even though the arrows/barbs render just fine regardless
// (renderCurrentArrowsOnMap()/renderWindArrowsOnMap() both use
// nearestSlice() to find the closest available time slice no matter what
// valid_from says). Per the owner: keep the STALE (expired) warning as a
// real, meaningful signal, but stop surfacing this particular false
// positive -- "if it is stale, say so; if not, fix it for the user."
// Scoped to callers that opt in (current-field and wind only, in
// renderDataFreshness() below) rather than changed globally -- gate/tide
// predictions' valid_from is a real, meaningful future boundary (a
// multi-day CHS prediction window that genuinely hasn't started yet would
// be worth flagging), not a same-session rolling-window artifact, so their
// stricter behavior is intentionally left unchanged.
function dataFreshnessInfo(label, meta, now, options) {
  now = now || new Date();
  options = options || {};
  if (!meta || (!meta.valid_from && !meta.valid_to)) {
    return {
      stale: true,
      valid: false,
      html: `<strong>${label}:</strong> no data loaded, or an older file predating freshness tracking — run scripts/fetch_model_data.py.`,
    };
  }
  const validFrom = meta.valid_from ? new Date(meta.valid_from) : null;
  const validTo = meta.valid_to ? new Date(meta.valid_to) : null;
  if (validTo && now > validTo) {
    // 2026-08-04: cut down from a much longer explanation (see git history/
    // HANDOFF.md if the reasoning is needed again) -- owner asked to keep
    // this terse: "STALE - once daily data expired nn hours ago" was the
    // requested shape. options.cadenceNote carries the short "why" per
    // source (e.g. wind's "once daily" -- HRDPS's real publish cadence,
    // the reason re-running doesn't always fix wind staleness, see the
    // fuller reasoning previously here); sources without a cadenceNote
    // (gate/current/tide, all of which SHOULD be fixed by a re-run) just
    // say "STALE - expired nnh ago", no re-run instruction spelled out --
    // the red "Refresh data" button is right there.
    const hoursAgo = Math.max(0, Math.round((now - validTo) / 3600000));
    const cadence = options.cadenceNote ? `${options.cadenceNote} ` : "";
    return {
      stale: true,
      valid: false,
      html: `<strong>${label}:</strong> STALE — ${cadence}data expired ${hoursAgo}h ago.`,
    };
  }
  if (validFrom && now < validFrom && !options.treatNotYetInEffectAsCurrent) {
    return {
      stale: false,
      valid: false,
      html: `<strong>${label}:</strong> snapshot not yet in effect (valid from ${validFrom.toLocaleString()}) — check your system clock if this is unexpected.`,
    };
  }
  // 2026-08-04: dropped the word "current" from this line (was "current —
  // valid through ...") -- owner flagged it as confusable with OCEAN
  // current, right below a literal "Current-field arrows" row using the
  // same word for the other meaning. "VALID for next NNh" replaces it,
  // plus a friendlier through-date (weekday + time + timezone abbreviation,
  // e.g. "Wednesday, 5:00 PM PDT") instead of the previous raw
  // toLocaleString() default (numeric date, no weekday/timezone).
  const hoursRemaining = validTo ? Math.max(0, Math.round((validTo - now) / 3600000)) : null;
  const throughText = validTo
    ? validTo.toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })
    : "unknown";
  return {
    stale: false,
    valid: true,
    html: `<strong>${label}:</strong> VALID for next ${hoursRemaining === null ? "?" : hoursRemaining}h — through ${throughText}.`,
  };
}

function renderDataFreshness() {
  const el = document.getElementById("data-freshness");
  if (!el) return;
  const now = new Date();
  // 2026-08-04: generated_at added to each meta (previously only valid_from/
  // valid_to) so dataFreshnessInfo()'s STALE branch can show when a file
  // was actually last fetched, not just when its forecast window expired --
  // see that branch's own comment for why this distinction matters.
  const gateMeta = window.GATE_PREDICTIONS_DATA
    ? { valid_from: window.GATE_PREDICTIONS_DATA.valid_from, valid_to: window.GATE_PREDICTIONS_DATA.valid_to, generated_at: window.GATE_PREDICTIONS_DATA.generated_at }
    : null;
  const currentMeta = window.CURRENT_FIELD_DATA
    ? { valid_from: window.CURRENT_FIELD_DATA.valid_from, valid_to: window.CURRENT_FIELD_DATA.valid_to, generated_at: window.CURRENT_FIELD_DATA.generated_at }
    : null;
  const tideMeta = window.TIDE_PREDICTIONS_DATA
    ? { valid_from: window.TIDE_PREDICTIONS_DATA.valid_from, valid_to: window.TIDE_PREDICTIONS_DATA.valid_to, generated_at: window.TIDE_PREDICTIONS_DATA.generated_at }
    : null;
  const windMeta = window.WIND_FIELD_DATA
    ? { valid_from: window.WIND_FIELD_DATA.valid_from, valid_to: window.WIND_FIELD_DATA.valid_to, generated_at: window.WIND_FIELD_DATA.generated_at }
    : null;
  const gate = dataFreshnessInfo("Gate/pass current predictions", gateMeta, now);
  const current = dataFreshnessInfo("Current-field arrows/ETA correction", currentMeta, now, {
    treatNotYetInEffectAsCurrent: true,
  });
  const tide = dataFreshnessInfo("Tide (high/low) predictions", tideMeta, now);
  const wind = dataFreshnessInfo("Wind arrows (10m, HRDPS, display only)", windMeta, now, {
    treatNotYetInEffectAsCurrent: true,
    cadenceNote: "once daily", // HRDPS's real publish cadence -- see dataFreshnessInfo()'s STALE-branch comment
  });
  // 2026-08-03: red by default, solid green + bold once valid, currently-
  // applicable data is actually loaded -- previously blue/red based on
  // `stale` alone (see dataFreshnessInfo()'s own comment on why `valid` is
  // a distinct, stricter field).
  el.innerHTML = [gate, current, tide, wind]
    .map(
      (r) =>
        `<div style="font-size:12px;padding:4px 0;color:${r.valid ? "#1e7e34" : "#c0392b"};font-weight:${r.valid ? "700" : "400"};">${r.html}</div>`
    )
    .join("") + currentSourceCoverageWarningsHtml();
  if (!dataRefreshInProgress) {
    const allProductsCurrent = Object.keys(DOWNLOAD_PRODUCT_LABELS)
      .every((product) => dataProductFileState(product).state === "current");
    setRefreshButtonState(allProductsCurrent ? "done" : "idle");
  }
  renderDownloadProductProgress();
  renderDataReadiness();
}

let activeDownloadProgress = null;
let lastRefreshFailedProducts = new Set();
let unattributedPipelineFailure = false;
const DOWNLOAD_PRODUCT_LABELS = { currents: "Currents", wind: "Wind", waves: "Waves", tides: "Tides", ec: "EC marine forecasts" };

function dataProductFileState(product) {
  const now = Date.now();
  const sources = {
    currents: window.CURRENT_FIELD_DATA,
    wind: window.WIND_FIELD_DATA,
    waves: window.WAVE_FIELD_DATA,
    tides: window.TIDE_PREDICTIONS_DATA,
    ec: window.MARINE_FORECASTS_DATA,
  };
  const data = sources[product];
  const hasRecords = product === "tides"
    ? !!(data && data.stations && Object.keys(data.stations).length)
    : product === "ec"
      ? !!(data && data.zones && Object.keys(data.zones).length)
      : !!(data && Array.isArray(data.records) && data.records.length);
  if (!hasRecords) return { state: "missing", percent: 0, text: "no data" };
  const validTo = data.valid_to && new Date(data.valid_to).getTime();
  const generated = new Date(data.fetched_at || data.generated_at || 0).getTime();
  const stale = (Number.isFinite(validTo) && now > validTo) || (product === "ec" && generated && now - generated > 36 * 3600000);
  return stale
    ? { state: "stale", percent: 100, text: "stale data" }
    : { state: "current", percent: 100, text: "available" };
}

function formatDataStatusDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";
}

function dataProductStatusDetail(product) {
  const definitions = {
    currents: { data: window.CURRENT_FIELD_DATA, source: "SeaCast / CIOPS", coverage: "Downloaded model region" },
    wind: { data: window.WIND_FIELD_DATA, source: "ECCC HRDPS", coverage: "Downloaded model region" },
    waves: { data: window.WAVE_FIELD_DATA, source: "WaveWatch III", coverage: "Downloaded model region" },
    tides: { data: window.TIDE_PREDICTIONS_DATA, source: "CHS", coverage: "Loaded stations" },
    ec: { data: window.MARINE_FORECASTS_DATA, source: "ECCC marine forecasts", coverage: "Loaded marine zones" },
  };
  const definition = definitions[product], data = definition.data, base = dataProductFileState(product);
  let state = base.state, label = state === "current" ? "Current" : state === "missing" ? "Missing" : "Stale";
  if (lastRefreshFailedProducts.has(product) && state !== "missing") { state = "retained"; label = "Saved data"; }
  let coverage = data?.coverage?.label || definition.coverage;
  if (product === "tides" && data?.stations) coverage = `${Object.keys(data.stations).length} stations`;
  if (product === "ec" && data?.zones) coverage = `${Object.keys(data.zones).length} zones`;
  return {
    product, label, state, source: data?.source || definition.source, coverage,
    validTo: formatDataStatusDate(data?.valid_to),
    updated: formatDataStatusDate(data?.fetched_at || data?.generated_at),
  };
}

function renderDataReadiness() {
  const banner = document.getElementById("data-readiness"), body = document.getElementById("data-status-body");
  if (!banner || !body) return;
  const rows = Object.keys(DOWNLOAD_PRODUCT_LABELS).map(dataProductStatusDetail);
  const missing = rows.filter(row => row.state === "missing"), old = rows.filter(row => row.state === "stale" || row.state === "retained");
  const title = document.getElementById("data-readiness-title"), action = document.getElementById("data-readiness-action");
  banner.className = "data-readiness";
  const heading = document.getElementById("data-refresh-heading-status");
  if (missing.length) {
    banner.classList.add("is-missing"); title.textContent = "Refresh recommended";
    action.textContent = `${missing.map(row => DOWNLOAD_PRODUCT_LABELS[row.product]).join(", ")} missing. Refresh manually or enable automatic refresh.`;
  } else if (old.length && !navigator.onLine) {
    banner.classList.add("is-saved"); title.textContent = "Using saved data";
    action.textContent = "SAILVu is offline. Saved information remains available and automatic refresh will wait for a connection.";
  } else if (old.length) {
    banner.classList.add("is-recommended"); title.textContent = "Refresh recommended";
    action.textContent = "SAILVu can continue with saved data. Refresh now, or enable automatic daily refresh below.";
  } else {
    banner.classList.add("is-ready"); title.textContent = "Ready";
    action.textContent = loadAutoRefreshSettings().enabled ? "Automatic refresh is on." : "Data are current. Automatic daily refresh is available below.";
  }
  if (heading) {
    const ready = !missing.length && !old.length;
    heading.textContent = ready ? "Data is up to date" : "Refresh";
    heading.className = `data-refresh-heading ${ready ? "data-current" : "refresh-needed"}`;
  }
  body.innerHTML = rows.map(row => `<tr><th scope="row">${mapPointEscape(DOWNLOAD_PRODUCT_LABELS[row.product])}</th><td class="status-${row.state}">${mapPointEscape(row.label)}</td><td>${mapPointEscape(row.source)}</td><td>${mapPointEscape(row.coverage)}</td><td>${mapPointEscape(row.validTo)}</td><td>${mapPointEscape(row.updated)}</td></tr>`).join("");
}

function updateDownloadProductProgress(progress) {
  if (!activeDownloadProgress || !progress || !progress.stage) return;
  const order = ["starting", "marine_forecasts", "currents", "wind", "waves", "gate", "tide", "curve", "done"];
  const stageIndex = Math.max(0, order.indexOf(progress.stage));
  const completionStage = { ec: 2, currents: 3, wind: 4, waves: 5, tides: 7 };
  Object.keys(DOWNLOAD_PRODUCT_LABELS).forEach((product) => {
    if (!activeDownloadProgress.selected.includes(product)) return;
    const startIndex = completionStage[product] - 1;
    let percent = stageIndex > startIndex ? 100 : stageIndex === startIndex ? 15 : 0;
    if (product === "wind" && progress.stage === "wind" && progress.done && progress.total) {
      percent = Math.max(1, Math.min(99, Math.round(progress.done / progress.total * 100)));
    }
    activeDownloadProgress.percent[product] = percent;
  });
  renderDownloadProductProgress();
}

function renderDownloadProductProgress() {
  const el = document.getElementById("data-refresh-progress");
  if (!el) return;
  const selected = activeDownloadProgress ? activeDownloadProgress.selected : selectedDownloadProducts();
  const selectedHours = selectedDownloadHours();
  Object.keys(DOWNLOAD_PRODUCT_LABELS).forEach((product) => {
    const isSelected = selected.includes(product);
    const base = dataProductFileState(product);
    if (!activeDownloadProgress && lastRefreshFailedProducts.has(product)) {
      base.state = "stale";
      base.text = "refresh failed; previous data retained";
    }
    const runningPercent = activeDownloadProgress && isSelected ? (activeDownloadProgress.percent[product] || 0) : null;
    const percent = runningPercent === null ? base.percent : runningPercent;
    const state = runningPercent === null ? base.state : (percent >= 100 ? "current" : "loading");
    const text = !isSelected ? `${base.text}; not selected` : runningPercent === null ? base.text : percent >= 100 ? "stage complete" : `${percent}%`;
    document.querySelectorAll(`[data-download-cell^="${product}:"]`).forEach((cell) => {
      const cellHours = Number(cell.dataset.downloadCell.split(":")[1]);
      cell.classList.toggle("is-selected", isSelected && cellHours === selectedHours);
      cell.classList.toggle("is-unselected-product", !isSelected);
      cell.classList.toggle("is-stale", isSelected && cellHours === selectedHours && state === "stale");
      cell.classList.toggle("is-failed", isSelected && cellHours === selectedHours && lastRefreshFailedProducts.has(product));
      cell.title = cellHours === selectedHours ? text : "Estimated download size";
      cell.style.backgroundImage = isSelected && cellHours === selectedHours && percent > 0
        ? `linear-gradient(to right, rgba(46,139,69,.72) ${percent}%, transparent ${percent}%)`
        : "none";
    });
  });
  el.innerHTML = (unattributedPipelineFailure
    ? '<div class="download-estimate-warning">The refresh failed before a data product could run. The previous files were retained; see the status above or helper window for the specific error.</div>'
    : "");
}

// 2026-08-07, owner's request: "If a model doesn't load, then the Data
// refresh field needs to warn the operator. The text needs to be more
// specific - to CIOPS currents, SalishSeaCast Currents." Direct follow-up
// to the real CIOPS-West-silently-failed incident this same day (see
// CHANGELOG.md) -- the "Current-field arrows/ETA correction" row above
// (currentMeta/dataFreshnessInfo()) only reflects current_field.js's
// OVERALL valid_from/valid_to window, which stays green even when
// SalishSeaCast succeeds and CIOPS-West quietly returns nothing: Python's
// build_app_data_js() only WIDENS that window when ciops_records is
// non-empty, it never shrinks it or flags the gap when ciops_records is
// empty (see fetch_ciops_west_current()'s own try/except). So this checks
// actual RECORD presence in the loaded file instead of a time window --
// "is this source's data in the file at all," a question the existing
// row can't answer. CIOPS-West records carry an explicit "source":
// "CIOPS-West" field (build_app_data_js()'s extra_records); SalishSeaCast
// rows never carry a "source" field at all, so presence of either
// per-model velocity field (VelEast5_kn/VelEast10_kn) is the marker for
// those instead (see current_field.js's own header comment for the field
// names). Only emits a row when a source is ACTUALLY missing -- silent
// (no row) when both are present, matching the "warn" framing of the
// request rather than always restating "OK" for everything.
function currentSourceCoverageWarningsHtml() {
  const records = (window.CURRENT_FIELD_DATA && window.CURRENT_FIELD_DATA.records) || [];
  const hasSalishSeaCast = records.some((r) => r.VelEast5_kn !== undefined || r.VelEast10_kn !== undefined);
  const hasCiopsWest = records.some((r) => r.source === "CIOPS-West");
  const warnings = [];
  if (!hasSalishSeaCast) {
    warnings.push("SalishSeaCast currents: no data in the loaded file — that track failed on the last refresh.");
  }
  if (!hasCiopsWest) {
    warnings.push("CIOPS-West currents (Port Hardy north extension): no data in the loaded file — that track failed on the last refresh.");
  }
  return warnings
    .map((w) => `<div style="font-size:12px;padding:4px 0;color:#c0392b;font-weight:700;">&#9888; ${w}</div>`)
    .join("");
}

// 2026-08-01: previously just name + coordinates -- the CHS predicted
// events and SalishSeaCast model sample already existed (gate marker
// Standard Web Mercator meters-per-pixel at a given latitude/zoom (same
// formula behind Leaflet's own tile math) -- used by updateScaleLegend() to
// convert the legend's real-world reference distance into an on-screen
// pixel length, since (unlike the ground-track arrows, which are real
// Leaflet geometry and scale themselves) the legend is a fixed screen-space
// UI control that has to compute its own pixel width per zoom level.
function metersPerPixelAt(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Adds the bottom-left distance-scale-bar control (see
// SCALE_LEGEND_SEGMENT_KM's comment) to the map, once. Its content is
// filled in/kept current by updateScaleLegend(), called from redraw() and
// on zoom/pan.
function addScaleLegendControl() {
  const LegendControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "scale-legend");
      div.innerHTML =
        `<svg class="scale-legend-svg" height="20" width="20"></svg>` +
        `<span class="scale-legend-label"></span>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  scaleLegendControl = new LegendControl();
  scaleLegendControl.addTo(map);
}

// Redraws the scale bar's segment widths from the current map zoom/center.
// Cheap (one small SVG rebuild) -- safe to call from redraw() and the
// map's zoomend/moveend handlers. No longer reads boat speed at all (see
// SCALE_LEGEND_SEGMENT_KM's own comment) -- still called on speed changes
// by existing callers, which is now simply a no-op for this control.
function updateScaleLegend() {
  if (!scaleLegendControl || !map) return;
  const container = scaleLegendControl.getContainer();
  if (!container) return;
  const svg = container.querySelector(".scale-legend-svg");
  const label = container.querySelector(".scale-legend-label");
  if (!svg || !label) return;

  const center = map.getCenter();
  const mPerPx = metersPerPixelAt(center.lat, map.getZoom());
  const segmentPx = mPerPx > 0 ? (SCALE_LEGEND_SEGMENT_KM * 1000) / mPerPx : 0;
  const h = 10;

  svg.setAttribute("width", String(segmentPx * SCALE_LEGEND_SEGMENTS));
  svg.setAttribute("height", String(h));
  let bars = "";
  for (let i = 0; i < SCALE_LEGEND_SEGMENTS; i++) {
    bars += `<rect x="${i * segmentPx}" y="0" width="${segmentPx}" height="${h}" fill="${i % 2 === 0 ? "#000" : "#fff"}" stroke="#000" stroke-width="1"/>`;
  }
  svg.innerHTML = bars;
  label.textContent = `${SCALE_LEGEND_SEGMENT_KM * SCALE_LEGEND_SEGMENTS} km`;
}

// 2026-08-06: owner's request -- a context-sensitive colour-scale (LUT)
// legend for the heat-map-style layers (current speed, wave height), shown
// only while that layer is actually on, stacked in the same bottom-left
// corner as the scale-arrow legend above (both real Leaflet controls,
// Leaflet handles the stacking itself). Rebuilt from scratch on every call
// (removed + re-added) rather than patched in place -- cheap (at most 2
// small rows), and avoids tracking per-row DOM state across toggle/
// gradient changes. Called from renderCurrentHeatMap()/renderWaveMap()
// themselves (their own enabled flags are already current by the time
// either runs), not scattered across every checkbox/select handler.
let mapLutLegendControl = null;
function renderMapLegend() {
  if (!map) return;
  if (mapLutLegendControl) {
    map.removeControl(mapLutLegendControl);
    mapLutLegendControl = null;
  }
  // 2026-08-06: checks the actual LAYER objects (non-null only once
  // something real was drawn), not heatMapEnabled/waveMapEnabled -- the
  // checkbox can be on with nothing actually rendered (e.g. "CIOPS-West
  // only" has no gridX/gridY index, so the heat MESH specifically draws
  // nothing even though the checkbox is checked and CIOPS-West arrows/
  // point-query still work fine) -- see renderCurrentHeatMap()'s own
  // comment for the real report this fixes.
  const rows = [];
  if (heatLayer) {
    rows.push({ label: "Current (kn)", max: HEATMAP_MAX_KN, gradient: HEATMAP_GRADIENTS[heatMapGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT] });
  }
  if (waveMapLayer) {
    rows.push({ label: "Waves (m)", max: WAVE_HEATMAP_MAX_M, gradient: HEATMAP_GRADIENTS[waveMapGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT] });
  }
  if (windCurrentInteractionLayer) {
    const selectedGradient = HEATMAP_GRADIENTS[windCurrentInteractionGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
    rows.push({ label: "Wind/current (kn)", min: -WIND_CURRENT_INTERACTION_MAX_KN, mid: 0, max: WIND_CURRENT_INTERACTION_MAX_KN, gradient: selectedGradient.map(([f, color]) => [1 - f, color]).reverse() });
  }
  if (tideHeightEnabled && tideStationLayer) {
    rows.push({ label: "Tide (m)", max: TIDE_HEIGHT_MAX_M, gradient: HEATMAP_GRADIENTS[tideHeightGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT] });
  }
  else if ((tideContoursEnabled && tideContourLayer) || (tideHeatMapEnabled && tideHeatMapLayer)) {
    rows.push({ label: "Tide (m)", max: TIDE_HEIGHT_MAX_M, gradient: HEATMAP_GRADIENTS[tideHeightGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT] });
  }
  if (!rows.length) return;

  const STEPS = 12;
  const LegendControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "map-lut-legend");
      div.innerHTML = rows
        .map((r) => {
          const swatches = Array.from({ length: STEPS }, (_, i) => colorForFraction(r.gradient, i / (STEPS - 1)))
            .map((c) => `<span style="background:${c};flex:1;"></span>`)
            .join("");
          return (
            `<div class="map-lut-row"><span class="map-lut-label">${r.label}</span>` +
            `<div class="map-lut-bar">${swatches}</div>` +
            `<span class="map-lut-ticks"><span>${r.min === undefined ? 0 : r.min}</span>${r.mid === undefined ? "" : `<span>${r.mid}</span>`}<span>${r.max}</span></span></div>`
          );
        })
        .join("");
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  mapLutLegendControl = new LegendControl();
  mapLutLegendControl.addTo(map);
}

// Temporary cartography-tuning readout. This makes it possible to report the
// exact Leaflet zoom at which baked offline labels become too dense. The scale
// is approximate and latitude-aware; zoom is the authoritative value for tile
// regeneration decisions.
function addZoomDebugControl() {
  const ZoomDebugControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const div = L.DomUtil.create("div", "zoom-debug-control");
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  const control = new ZoomDebugControl();
  control.addTo(map);

  const update = () => {
    const zoom = map.getZoom();
    const latitudeRadians = map.getCenter().lat * Math.PI / 180;
    const metersPerPixel = 156543.03392804097 * Math.cos(latitudeRadians) / Math.pow(2, zoom);
    const scaleDenominator = Math.round(metersPerPixel * 3779.5275590551);
    const container = control.getContainer();
    if (container) {
      container.textContent = `Zoom ${zoom} · ~1:${scaleDenominator.toLocaleString()}`;
    }
  };

  map.on("zoomend moveend", update);
  update();
}

function voyageRegionLeafletBounds() {
  return L.latLngBounds(
    [VOYAGE_REGION_BOUNDS.lat_min, VOYAGE_REGION_BOUNDS.lon_min],
    [VOYAGE_REGION_BOUNDS.lat_max, VOYAGE_REGION_BOUNDS.lon_max]
  );
}

function updateMapPanLimits() {
  if (!map) return;
  const bounds = voyageRegionLeafletBounds();
  map.setMinZoom(7);
  if (map.getZoom() <= 7) {
    map.setMaxBounds(bounds);
    map.panInsideBounds(bounds, { animate: false });
  } else {
    map.setMaxBounds(null);
  }
}

function initMap() {
  // 2026-08-03: boxZoom: false -- Leaflet's default Shift+drag-to-zoom-to-a-
  // box behavior directly collides with this app's own Shift+click-to-add-
  // waypoint convention. Any real mouse click has a tiny bit of movement
  // between mousedown and mouseup; with boxZoom left on, Leaflet sometimes
  // reads that as the start of a box-zoom drag rather than a click, and
  // zooms to whatever small/odd box that accidental movement traced out --
  // exactly the "shift+click sometimes zooms to a random spot" the owner
  // hit. This app has no use for box-zoom, so disabling it outright is
  // strictly a bugfix here, not a lost feature.
  const voyageBounds = voyageRegionLeafletBounds();
  map = L.map("map", { boxZoom: false, minZoom: 7, maxBounds: voyageBounds, maxBoundsViscosity: 1.0 }).setView(MAP_CENTER, MAP_ZOOM);
  updateMapPanLimits();
  map.on("zoomend resize", updateMapPanLimits);
  map.createPane("landOutlinePane");
  map.getPane("landOutlinePane").style.zIndex = "450";
  map.getPane("landOutlinePane").style.pointerEvents = "none";
  // 2026-08-05: owner's report (screenshot) -- right-clicking the map
  // (including right over a waypoint tooltip/marker) was popping up the
  // BROWSER's own native right-click context menu (Edge: "Hide menu /
  // More actions / Send to Copilot / Copy / Search"), overlapping our own
  // tooltip. A previous attempt this same day guessed this was Edge's
  // text-selection mini-toolbar and added user-select: none to fix it --
  // wrong diagnosis (this is a genuinely different Edge menu, triggered
  // by a right-click, not a hover/selection), so that fix (kept -- still
  // harmless/still a reasonable thing to have either way) didn't touch
  // this. Real root cause: Leaflet's Map class re-fires the native
  // "contextmenu" DOM event as its own Leaflet "contextmenu" event (see
  // Map.js's _initEvents) but does NOT call preventDefault() on it itself
  // -- that only happens if you opt into Leaflet's separate ContextMenu
  // plugin, which this app doesn't use -- so the browser's default menu
  // was reaching the screen untouched. This app has no custom right-click
  // behavior of its own to offer instead, so the fix is simply to stop
  // the browser's default action outright.
  map.getContainer().addEventListener("contextmenu", (e) => e.preventDefault());

  // 2026-08-07, owner's request: "add a Basemap tab with three options" --
  // three tile sources instead of the single hardcoded OSM layer above,
  // matching BACKLOG.md's "More base maps (topo, plain)" wish-list item.
  // Layer defs pulled by the owner from the Family Mapper project (see
  // family-mapper-basemaps.md, sourced there from
  // Borstad_Cooke_Places_Map_2026-07-15_2130UTC.html lines 1417-1432) --
  // URLs/maxZoom/attribution copied verbatim from that file, not
  // independently re-derived, so this stays consistent with the other app.
  // Only one of the three is ever added to `map` at a time (see
  // setBaseLayer() below, wired to #basemap-select in the DOMContentLoaded
  // handler) -- they share Leaflet's one default tile pane, so swapping is
  // just remove-old/add-new, no z-index/pane work needed (contrast with
  // arrowPane above, which exists because THAT layer needed to coexist
  // with another canvas, not replace it).
  window.BASE_LAYERS = {
    standard: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
      subdomains: "abc",
    }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution:
        "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)",
      maxZoom: 17,
      subdomains: "abc",
    }),
    canvecOffline: L.tileLayer("tiles/canvec_final/{z}/{x}/{y}.png", {
      attribution: "Natural Resources Canada — CanVec",
      bounds: [[48.4583519, -126.9140625], [50.4575040, -122.5195313]],
      minZoom: 7,
      maxZoom: 12,
      minNativeZoom: 7,
      maxNativeZoom: 12,
      noWrap: true,
    }),
  };
  const baseLayerZoomLimits = {
    standard: { min: 0, max: 19 },
    topo: { min: 0, max: 17 },
    canvecOffline: { min: 7, max: 12 },
  };
  // 2026-08-07, owner's request: "remove Plain - we'll fight with that
  // another day." A third "plain"/"grey" entry lived here for most of this
  // session (four rounds, none landed anywhere the owner was happy with --
  // light_all+invert, dark_all+brightness (real grey-vs-white separation
  // but a "disturbing stipple pattern" + illegible labels), a real
  // Government of Canada "Simple Grey" ArcGIS service (came up blank,
  // cause undiagnosed), then back to dark_all+brightness before this
  // removal) -- see git history/CHANGELOG.md for the full trail if this is
  // picked back up. #basemap-select (index.html) now offers only Standard/
  // Topographic; its default `selected` option moved back to "standard"
  // (was "plain" only because of this now-abandoned experiment).
  let activeBaseLayerKey = "canvecOffline";
  map.setMinZoom(baseLayerZoomLimits[activeBaseLayerKey].min);
  map.setMaxZoom(baseLayerZoomLimits[activeBaseLayerKey].max);
  window.BASE_LAYERS[activeBaseLayerKey].addTo(map);

  if (window.VANCOUVER_ISLAND_OUTLINE) {
    vancouverIslandOutlineLayer = L.geoJSON(window.VANCOUVER_ISLAND_OUTLINE, {
      pane: "landOutlinePane",
      interactive: false,
      style: {
        color: "#9aa0a6",
        weight: 1,
        opacity: 0.8,
        fill: false,
        lineJoin: "round",
      },
    }).addTo(map);
  }

  // Swaps the active base tile layer. Exposed on window (not just a local
  // closure) so the #basemap-select listener below can call it without
  // restructuring initMap()'s scope.
  window.setBaseLayer = function (key) {
    if (!window.BASE_LAYERS[key] || key === activeBaseLayerKey) return;
    map.removeLayer(window.BASE_LAYERS[activeBaseLayerKey]);
    const limits = baseLayerZoomLimits[key];
    map.setMinZoom(limits.min);
    map.setMaxZoom(limits.max);
    window.BASE_LAYERS[key].addTo(map);
    activeBaseLayerKey = key;
  };

  // 2026-08-02: a dedicated pane for the current-field arrows, always above
  // Leaflet's default "overlayPane" (z-index 400) where the heat map's
  // quad mesh (renderCurrentHeatMap()) lives. Both layers use their own
  // L.canvas() renderer -- i.e. two separate <canvas> elements -- so which
  // one visually covers the other depends on DOM order, not just which was
  // logically "added" more recently: toggling the heat map checkbox ON
  // *after* the arrows have already rendered appends the heat map's canvas
  // later in the DOM, which then painted over the arrows, making them
  // invisible against the heat map's own colors. Giving the arrows their
  // own higher-z-index pane fixes this permanently, regardless of which
  // order the two layers are toggled/rebuilt in.
  map.createPane("arrowPane");
  map.getPane("arrowPane").style.zIndex = 450;
  // 2026-08-02 (follow-up, real regression found after shipping the above):
  // a Leaflet Canvas renderer's <canvas> element is one single DOM node
  // covering the WHOLE current viewport -- unlike the SVG renderer (used
  // for the gate/tide station markers), which sets pointer-events: none on
  // its own outer <svg> container so empty space is click-through and only
  // individual shapes (each its own real DOM node) capture clicks. A canvas
  // has no per-shape DOM nodes, so without this line the ENTIRE arrowPane
  // canvas -- including its mostly-empty, mostly-transparent area -- sat
  // above the markers' pane and silently absorbed every click on the map
  // before it could ever reach a station marker underneath, breaking
  // "click a marker to open its tide/current graph" everywhere, not just
  // where an arrow was actually drawn. pointer-events: none keeps the
  // visual stacking fix above (arrows drawn on top of the heat map) while
  // making the arrow canvas fully click-through, restoring marker clicks.
  // Trade-off: current-field arrows are no longer clickable for their own
  // speed/direction popup (buildArrowVectorLayer()'s bindPopup on the
  // current-field layer specifically) -- accepted since marker clickability
  // is the higher-value interaction and this is the only reliable fix
  // without reintroducing one-DOM-node-per-arrow SVG overhead.
  map.getPane("arrowPane").style.pointerEvents = "none";

  map.on("click", (e) => {
    if (suppressNextMapClick) {
      suppressNextMapClick = false;
      return;
    }
    if (aoiDrawing) return; // shouldn't normally reach here (drag suppresses the click), guard anyway
    if (mapPointPickActive) {
      beginMapPointEditor(e.latlng);
      return;
    }
    if (vesselPickActive) {
      vesselPickActive = false;
      document.getElementById("map").style.cursor = "";
      setVesselPosition(e.latlng.lat, e.latlng.lng, "manual");
      return;
    }
    if (makingGatePickActive) {
      completeMakingGatePosition(e.latlng);
      return;
    }
    // 2026-08-06: current-verification grid-point picking takes over plain
    // clicks while active (startVerificationPick()) -- a click straight on
    // one of that mode's own candidate dots is handled by the dot's own
    // click listener (which stops propagation before this ever runs, see
    // startVerificationPick()'s own comment); this branch is the fallback
    // for clicking elsewhere nearby, same nearestGridPoint() lookup
    // showPointQueryPopup() below already uses for its own point query.
    // Deliberately checked before the shift-click/waypoint branch below --
    // picking mode owns every plain click until cancelled, no route editing
    // half-mixed in.
    if (verificationPickStationId) {
      // loadRawCurrentField(), NOT loadCurrentField() -- same reasoning as
      // startVerificationPick()'s own candidate-dot list: the DFO-gate
      // synthetic node isn't a real pickable cell (it sits exactly at the
      // station's own coordinate, so it would win this click-fallback
      // every time near that station, silently defeating the whole point
      // of picking a REAL candidate cell).
      const records = loadRawCurrentField();
      const { slice } = nearestSlice(records, selectedFieldTime);
      const nearest = nearestGridPoint(slice, e.latlng.lat, e.latlng.lng);
      if (nearest) pickVerificationPoint(verificationPickStationId, nearest.record);
      return;
    }
    // 2026-08-03: swapped at the owner's request -- shift+click now adds a
    // route waypoint, plain click queries the nearest current/wind readings
    // at this point. (Previously the reverse: plain click added a waypoint,
    // shift+click queried.) e.originalEvent is the underlying native DOM
    // MouseEvent, which is where shiftKey actually lives (Leaflet's own
    // event object doesn't carry it).
    if (e.originalEvent && e.originalEvent.shiftKey) {
      waypoints.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      redraw();
      return;
    }
    showPointQueryPopup(e.latlng);
  });

  // Area of Operations click-drag handlers -- see areaOfOperations's own
  // comment near its declaration for the feature's background/scope. Only
  // active while aoiDrawing is true (toggled on by the "Draw area" button),
  // so normal map panning/click-to-add-waypoint is unaffected the rest of
  // the time.
  map.on("mousedown", (e) => {
    if (!aoiDrawing) return;
    aoiDrawStart = e.latlng;
    if (aoiTempRectangleLayer) {
      map.removeLayer(aoiTempRectangleLayer);
      aoiTempRectangleLayer = null;
    }
  });
  map.on("mousemove", (e) => {
    if (!aoiDrawing || !aoiDrawStart) return;
    const bounds = L.latLngBounds(aoiDrawStart, e.latlng);
    if (aoiTempRectangleLayer) map.removeLayer(aoiTempRectangleLayer);
    aoiTempRectangleLayer = L.rectangle(bounds, {
      color: "#2368a2",
      weight: 2,
      dashArray: "6,4",
      fillOpacity: 0.08,
    }).addTo(map);
  });
  map.on("mouseup", (e) => {
    if (!aoiDrawing || !aoiDrawStart) return;
    const bounds = L.latLngBounds(aoiDrawStart, e.latlng);
    aoiDrawStart = null;
    aoiDrawing = false;
    map.dragging.enable();
    document.getElementById("map").style.cursor = "";
    // A plain click (no real drag) produces a degenerate, ~zero-area
    // bounds -- treat that as "cancelled" rather than finalizing a
    // useless sliver AOI. ~0.001 deg is well under any realistic AOI size
    // at this map's zoom levels.
    const isDegenerate = bounds.getNorth() - bounds.getSouth() < 0.001 || bounds.getEast() - bounds.getWest() < 0.001;
    if (!isDegenerate) {
      finalizeAoi(bounds);
      suppressNextMapClick = true;
    } else if (aoiTempRectangleLayer) {
      map.removeLayer(aoiTempRectangleLayer);
      aoiTempRectangleLayer = null;
    }
    renderAoiInfo();
    renderDownloadPlanner();
  });

  addScaleLegendControl();
  map.on("moveend", () => {
    if (tideContoursEnabled || tideHeatMapEnabled) loadTideStations();
  });
  addZoomDebugControl();
  // The legend is fixed screen-space UI (unlike the ground-track arrows,
  // which are real map geometry and rescale themselves) -- it has to be
  // explicitly recomputed on zoom and pan (pan changes latitude, which
  // changes meters-per-pixel slightly).
  map.on("zoomend moveend", () => updateScaleLegend());
  updateScaleLegend();

  // 2026-08-06, later session (owner's request): DFO-gate arrow shaft
  // width is now zoom-dependent (dfoGateArrowShaftWeightPx(), see that
  // function's own comment) -- Leaflet doesn't recompute an already-drawn
  // shape's `weight` on its own when the zoom changes, so this re-runs
  // the whole current-arrow render (cheap enough already to run after
  // every pipeline refresh/source-mode switch/leg edit -- see its other
  // call sites) on every "zoomend". renderCurrentArrowsOnMap() itself
  // still gates internally on salishSeaCastArrowsEnabled/ciopsArrowsEnabled/
  // gateBoxesEnabled, so this is a safe no-op when every one of those is off.
  map.on("zoomend", () => renderCurrentArrowsOnMap());

  // 2026-08-07, owner's request: wind station markers are now also
  // zoom-dependent (windStationArrowWeightMultiplier()'s scaled arrow
  // weight, and the wide-zoom crosshair swap -- see WIND_STATION_ARROW_ZOOM_MIN/
  // MAX's own comment) -- same "Leaflet doesn't recompute an already-drawn
  // shape on zoom, so re-run the whole render" reasoning as the DFO-gate
  // listener just above. loadWindStations() already gates internally on
  // windStationsEnabled, so this is a safe no-op when that's off.
  map.on("zoomend", () => loadWindStations());
  map.on("zoomend", () => {
    if (verificationHighlightLayer) highlightSelectedVerificationStations();
  });

  // Both Sea State dot layers use seaStateDotRadiusPx(), so recreate their
  // Canvas markers after a zoom step to apply the new screen-space radius.
  map.on("zoomend", () => {
    updateMapTuningPanel();
    if (waveMapEnabled) renderWaveMap();
    if (windCurrentInteractionEnabled) renderWindCurrentInteractionMap();
  });
}

// Enters AOI-drawing mode: disables map panning (so the drag draws a box
// instead of moving the map, same reason Leaflet.draw-style plugins do
// this) and shows a crosshair cursor. The actual box is built live by the
// mousedown/mousemove/mouseup handlers registered in initMap().
function startAoiDraw() {
  aoiDrawing = true;
  map.dragging.disable();
  document.getElementById("map").style.cursor = "crosshair";
  renderAoiInfo();
  renderDownloadPlanner();
}

function cancelAoiDraw() {
  if (aoiTempRectangleLayer) {
    map.removeLayer(aoiTempRectangleLayer);
    aoiTempRectangleLayer = null;
  }
  aoiDrawStart = null;
  aoiDrawing = false;
  map.dragging.enable();
  document.getElementById("map").style.cursor = "";
  renderAoiInfo();
  renderDownloadPlanner();
}

function syncAoiRectangleVisibility() {
  if (!map) return;
  if (aoiRectangleLayer) {
    map.removeLayer(aoiRectangleLayer);
    aoiRectangleLayer = null;
  }
  // Keep the saved download AOI, but hide its red rectangle while the EC
  // forecast polygons are active so it cannot masquerade as a marine-zone
  // or warning boundary.
  if (!areaOfOperations || marineZonesEnabled) return;
  aoiRectangleLayer = L.rectangle([
    [areaOfOperations.lat_min, areaOfOperations.lon_min],
    [areaOfOperations.lat_max, areaOfOperations.lon_max],
  ], { color: "#2368a2", weight: 2, fillOpacity: 0.05 }).addTo(map);
}

// Commits a completed drag as the new Area of Operations: replaces any
// previous rectangle (both the finalized one and a leftover in-progress
// one), stores the plain lat/lon bounds (not a Leaflet-specific object) in
// areaOfOperations so it's easy to read/serialize elsewhere later, and
// draws the final rectangle.
function finalizeAoi(bounds) {
  if (aoiTempRectangleLayer) {
    map.removeLayer(aoiTempRectangleLayer);
    aoiTempRectangleLayer = null;
  }
  if (aoiRectangleLayer) {
    map.removeLayer(aoiRectangleLayer);
    aoiRectangleLayer = null;
  }
  areaOfOperations = {
    lat_min: bounds.getSouth(),
    lat_max: bounds.getNorth(),
    lon_min: bounds.getWest(),
    lon_max: bounds.getEast(),
  };
  syncAoiRectangleVisibility();
  renderDownloadPlanner();
  renderSpatialPreviewLayers();
  refreshVoyageRegionDisplay();
}

function clearAoi() {
  areaOfOperations = null;
  if (aoiRectangleLayer) {
    map.removeLayer(aoiRectangleLayer);
    aoiRectangleLayer = null;
  }
  if (aoiTempRectangleLayer) {
    map.removeLayer(aoiTempRectangleLayer);
    aoiTempRectangleLayer = null;
  }
  aoiDrawStart = null;
  aoiDrawing = false;
  if (map) map.dragging.enable();
  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.style.cursor = "";
  renderAoiInfo();
  renderDownloadPlanner();
  renderSpatialPreviewLayers();
  refreshVoyageRegionDisplay();
}

function aoiMeasurements(bounds) {
  if (!bounds) return null;
  const midLat = (bounds.lat_min + bounds.lat_max) / 2;
  const midLon = (bounds.lon_min + bounds.lon_max) / 2;
  const widthKm = haversineKm({ lat: midLat, lon: bounds.lon_min }, { lat: midLat, lon: bounds.lon_max });
  const heightKm = haversineKm({ lat: bounds.lat_min, lon: midLon }, { lat: bounds.lat_max, lon: midLon });
  return { widthKm, heightKm, areaKm2: widthKm * heightKm };
}

// Renders the "Area of Operations" sidebar section: current drawing state,
// the selected bounds (if any), and a copy-pasteable snippet matching
// fetch_model_data.py's BBOX dict format -- makes the selection concretely
// useful today (paste it in by hand to try a smaller region) even though
// this pass deliberately doesn't wire it into the pipeline automatically
// (scoped with the owner as a separate follow-up).
function renderAoiInfo() {
  const el = document.getElementById("aoi-info");
  if (!el) return;
  if (aoiDrawing) {
    el.innerHTML =
      "<p style='font-size:12px;color:#666;'>Click-drag a box on the map now to set the area.</p>";
    return;
  }
  if (!areaOfOperations) {
    el.innerHTML =
      "<p style='font-size:12px;color:#666;'>No area selected. Click \"Draw area on map\" below, then click-drag a box.</p>";
    return;
  }
  const { lat_min, lat_max, lon_min, lon_max } = areaOfOperations;
  const measured = aoiMeasurements(areaOfOperations);
  const bboxSnippet =
    `{"lat_min": ${lat_min.toFixed(4)}, "lat_max": ${lat_max.toFixed(4)}, ` +
    `"lon_min": ${lon_min.toFixed(4)}, "lon_max": ${lon_max.toFixed(4)}}`;
  el.innerHTML =
    `<p style="font-size:12px;color:#666;">Selected area: ${measured.widthKm.toFixed(1)} × ${measured.heightKm.toFixed(1)} km ` +
    `(${Math.round(measured.areaKm2).toLocaleString()} km²).<br>Lat ${lat_min.toFixed(4)} to ${lat_max.toFixed(4)}, ` +
    `lon ${lon_min.toFixed(4)} to ${lon_max.toFixed(4)}.</p>` +
    `<p style="font-size:12px;color:#666;">This box is used by the Voyage Region download plan.</p>` +
    `<code style="font-size:11px;display:block;background:#f4f4f4;padding:6px;border-radius:4px;white-space:pre-wrap;word-break:break-all;">${bboxSnippet}</code>`;
}

function redraw() {
  // renderLegs() first: it (re)populates legTimings, which the marker and
  // leg-line tooltips below both read from. Order matters here.
  renderLegs();

  markers.forEach((m) => map.removeLayer(m));
  markers = waypoints.map((wp, i) => {
    // legTimings[i - 1] is the leg that ARRIVES at this waypoint (i.e. from
    // WP i to WP i+1 in 1-based labels) -- there is no such leg for WP1.
    const arrivingLeg = i > 0 ? legTimings[i - 1] : null;
    let tooltipHtml = `<strong>WP ${i + 1}</strong>`;
    if (arrivingLeg) {
      tooltipHtml +=
        `<br>Arrive: ${arrivingLeg.arriveTime.toLocaleString()}` +
        `<br>Distance from WP${i}: ${arrivingLeg.distNm.toFixed(2)} nm` +
        `<br>Course from WP${i}: ${arrivingLeg.courseBearing.toFixed(0)}&deg;`;
    }
    return L.marker([wp.lat, wp.lon], {
      icon: L.divIcon({
        className: "wp-marker",
        html: `<div class="wp-marker-inner">${i + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .addTo(map)
      // 2026-08-05: className: "wp-tooltip" (style.css) -- see that rule's
      // own comment for why this specific tooltip needed a wider max-width
      // than the other, shorter ones share.
      .bindTooltip(tooltipHtml, { permanent: false, className: "wp-tooltip" });
  });

  legLines.forEach((l) => map.removeLayer(l));
  legLines = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const leg = legTimings[i];
    const line = L.polyline(
      [[a.lat, a.lon], [b.lat, b.lon]],
      { color: "#2a628f", weight: ROUTE_LINE_WEIGHT }
    ).addTo(map);
    if (leg) {
      line.bindTooltip(
        `<strong>Leg ${i + 1}</strong>` +
          `<br>Underway: ${leg.hours.toFixed(2)} h` +
          `<br>Start: ${leg.startTime.toLocaleString()}` +
          `<br>End: ${leg.arriveTime.toLocaleString()}`,
        { sticky: true }
      );
    }
    legLines.push(line);
  }

  renderGroundTrackArrows();
  renderWarnings();
  updateScaleLegend(); // speed may have changed -- keep the legend in sync
  highlightCurrentWaypointOnMap(); // markers[] was just rebuilt above -- keep the highlight in sync with it
}

// 2026-08-05: owner's request -- "As I step through time on the map with
// the Route Conditions graph open - highlight the waypoint on both the
// route and the graph." Index into `waypoints`/`legTimings` of whichever
// waypoint's own real time (WP1 = the route's departure time, every other
// WP = the leg arriving there) is CLOSEST to the map's currently displayed
// time (selectedFieldTime, or real "now" if the scrubber is at Live) --
// same "nearest in time" idea nearestTimeKey() already uses for field
// data, just against waypoint times instead of forecast-hour steps. The
// ONE shared computation for both halves of the owner's request:
// highlightCurrentWaypointOnMap() below (map markers) and
// showRouteConditionsGraph()'s own renderFn (the graph's WP marker lines)
// both call this, so the two views can never disagree about which
// waypoint counts as "current."
function currentWaypointIndex() {
  if (!waypoints.length || !legTimings.length) return -1;
  const times = [legTimings[0].startTime, ...legTimings.map((l) => l.arriveTime)];
  const target = (selectedFieldTime || new Date()).getTime();
  let best = 0;
  let bestDiff = Math.abs(times[0].getTime() - target);
  for (let i = 1; i < times.length; i++) {
    const diff = Math.abs(times[i].getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

// Toggles the "wp-marker-current" CSS class (style.css) on whichever map
// waypoint marker currentWaypointIndex() picks -- called from redraw()
// (route just changed) and refreshFieldTimeDependents() (map time just
// stepped), the same two triggers that already keep every other
// time/route-dependent map layer in sync. m.getElement() is Leaflet's own
// accessor for a marker's DOM icon element -- returns null/undefined
// before the marker's been added to the map, guarded against below (not
// expected in practice here since redraw() always rebuilds `markers`
// immediately before calling this).
function highlightCurrentWaypointOnMap() {
  const idx = currentWaypointIndex();
  markers.forEach((m, i) => {
    const el = m.getElement && m.getElement();
    if (!el) return;
    el.classList.toggle("wp-marker-current", i === idx);
  });
}

// Draws each leg's ground track as a series of real GROUND_TRACK_STEP_HOURS-
// long vectors -- see that constant's comment for the reasoning. Each step:
// place the arrow's tail on the leg's own straight route line at this
// elapsed time (i.e. where the boat would be if it held its through-water
// speed/course with NO current at all), sample the current there, compute
// the resultant speed/course over ground (boat's course through water +
// current), and draw the vector that far in that direction. Repeat until
// the leg's full duration is covered.
//
// 2026-08-02: each arrow's tail used to be the PREVIOUS arrow's head (a
// head-to-tail dead-reckoning chain), so cross-track drift accumulated
// visually across the whole leg. Per the owner's request, every arrow now
// starts fresh from the intended route line instead -- each one shows "if
// you were exactly on your line right now, here's the local current's
// effect over the next step," not a cumulative drifted trace. (The owner
// separately noticed that the old chained behavior, combined with a long
// leg and a deliberately very low through-water speed, could be used as an
// ad hoc way to trace the current field along a route -- a near-zero boat
// speed makes the resultant almost pure current, so the chain barely
// advanced along the leg but kept sampling forward in time/position. That
// was a side effect of the chaining, not of the speed input by itself, and
// is no longer reproducible now that each arrow re-anchors to the line --
// tracing the current field itself is really a job for the flow-
// visualization backlog idea, Section 10.6, not this per-leg diagnostic.)
function renderGroundTrackArrows() {
  if (groundTrackArrowLayer) map.removeLayer(groundTrackArrowLayer);
  groundTrackArrowLayer = L.layerGroup();

  const currentRecords = loadCurrentField();
  // 2026-08-05: wind (leeway-scaled) folded in here too, via the same
  // sampleCombinedDrift() renderLegs() uses -- one code path for both, so
  // the visual chain and the leg's own ETA number can't silently disagree.
  const windRecords = loadWindField();
  const leewayPercent = getLeewayPercent();

  legTimings.forEach((leg, i) => {
    let elapsedHours = 0;
    let stepIndex = 0;
    while (elapsedHours < leg.hours - 1e-9 && stepIndex < GROUND_TRACK_MAX_ARROWS_PER_LEG) {
      const stepHours = Math.min(GROUND_TRACK_STEP_HOURS, leg.hours - elapsedHours);
      const sampleTime = new Date(leg.startTime.getTime() + elapsedHours * 3600 * 1000);

      // Position on the leg's own straight route line at this elapsed time
      // -- the boat's through-water distance covered so far (leg.speed x
      // elapsedHours), along the leg's constant intended course. NOT
      // carried over from the previous iteration's arrow endpoint.
      const pos = destinationPoint(leg.from, leg.courseBearing, leg.speed * elapsedHours * KM_PER_NM);

      const drift = sampleCombinedDrift(currentRecords, windRecords, pos.lat, pos.lon, sampleTime, leg.courseBearing, leewayPercent);

      // No current sample AND no wind-leeway contribution here (out of
      // range / no data / leeway 0%) -- fall back to pure through-water
      // course/speed for this step rather than skipping it silently.
      const resultant = drift
        ? computeResultantGroundTrack(leg.speed, leg.courseBearing, drift.vec)
        : { groundSpeedKn: leg.speed, groundBearingDeg: leg.courseBearing };

      const stepDistanceKm = resultant.groundSpeedKn * stepHours * KM_PER_NM;
      const nextPos = destinationPoint(pos, resultant.groundBearingDeg, Math.max(0, stepDistanceKm));

      const sample = drift ? drift.currentSample : null;
      const windSample = drift ? drift.windSample : null;
      const windBit = windSample
        ? (leewayPercent
            ? `Wind ${windSample.speedKn.toFixed(1)} kn from ${reciprocalBearingDeg(windSample.dirDeg).toFixed(0)}&deg; ` +
              `→ ${leewayPercent}% leeway = ${Math.abs(drift.leewayCrossKn).toFixed(2)} kn cross-track.`
            : `Wind sampled but Leeway is 0% (excluded).`)
        : `No wind sample within range.`;

      const popupHtml =
        `<strong>Leg ${i + 1} ground track, step ${stepIndex + 1}</strong> ` +
        `(current + wind-leeway): ` +
        `${resultant.groundSpeedKn.toFixed(2)} kn toward ${resultant.groundBearingDeg.toFixed(0)}&deg;, ` +
        `${stepHours.toFixed(2)} h.<br>Course through water: ${leg.courseBearing.toFixed(0)}&deg; at ${leg.speed.toFixed(1)} kn.` +
        (sample
          ? `<br>Current sampled ${sample.distKm.toFixed(1)} km away, snapshot ${new Date(sample.timeKey).toLocaleString()}. ` +
            `Nearest-neighbor approximation -- no interpolation between grid points or forecast hours.`
          : `<br>No current sample within ${CURRENT_SAMPLE_MAX_KM} km here.`) +
        `<br>${windBit}`;

      buildArrowVectorLayer(pos, nextPos, GROUND_TRACK_ARROW_COLOR, popupHtml).addTo(groundTrackArrowLayer);

      elapsedHours += stepHours;
      stepIndex++;
    }
  });
  groundTrackArrowLayer.addTo(map);
}

function renderLegs() {
  const el = document.getElementById("legs");
  if (waypoints.length < 2) {
    el.innerHTML = "<p style='font-size:12px;color:#666;'>Click at least two points on the map to plan a route.</p>";
    legTimings = []; // otherwise stale entries survive an undo back below 2 waypoints
    return;
  }

  const defaultSpeed = parseFloat(document.getElementById("speed").value) || 5;
  const departureInput = document.getElementById("departure").value;
  let cursorTime = departureInput ? new Date(departureInput) : new Date();

  const currentRecords = loadCurrentField();
  // 2026-08-05: owner's explicit request ("conditions... at the time we get
  // to each [step] are [relevant]... present conditions... are not") --
  // current's per-leg ETA correction below already sampled at each leg's
  // own forecast startTime, not real "now"; wind/wave had no per-leg
  // reporting at all until now. Loaded once here, same as currentRecords
  // above, and sampled per-leg below via sampleWindNear()/sampleWaveNear()
  // (same nearest-time/nearest-grid-point pattern sampleCurrentNear()
  // already uses for current).
  const windRecords = loadWindField();
  const waveRecords = loadWaveField();

  legTimings = [];
  let html = "";
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const distKm = haversineKm(a, b);
    const distNm = distKm / KM_PER_NM;
    const speed = getLegSpeed(i, defaultSpeed);
    const baselineHours = speed > 0 ? distNm / speed : 0;
    const startTime = new Date(cursorTime);
    const courseBearing = bearingDeg(a, b);
    const midpoint = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };

    // Sample the current field once, at this leg's midpoint and start time --
    // a single nearest-neighbor lookup, not an interpolation or a re-sample
    // partway through the leg. See header comment for the caveat. (The
    // ground-track arrows drawn in renderGroundTrackArrows() take several
    // additional independent samples along this same leg -- this one here
    // is specifically the sample the ETA correction and drift note use.)
    // 2026-08-05: wind folded into the ETA/ground-track correction, per the
    // owner's explicit request -- previously current-only. Shared with
    // renderGroundTrackArrows() via sampleCombinedDrift() (see that
    // function's own comment for the leeway model/reasoning) rather than a
    // second hand-written copy of the same math.
    const leewayPercent = getLeewayPercent();
    const drift = sampleCombinedDrift(currentRecords, windRecords, midpoint.lat, midpoint.lon, startTime, courseBearing, leewayPercent);
    const sample = drift ? drift.currentSample : sampleCurrentNear(currentRecords, midpoint.lat, midpoint.lon, startTime);
    const windSample = drift ? drift.windSample : sampleWindNear(windRecords, midpoint.lat, midpoint.lon, startTime);
    const windCrossKn = drift ? drift.windCrossKn : 0;
    const leewayCrossKn = drift ? drift.leewayCrossKn : 0;

    let correction = null;
    if (sample) {
      correction = { timeKey: sample.timeKey, distKm: sample.distKm, speedKn: sample.speedKn, dirDeg: sample.dirDeg };
    }

    let hours = baselineHours;
    let correctionNote;
    let correctionColor = "#a33";
    if (drift) {
      const resultant = computeResultantGroundTrack(speed, courseBearing, drift.vec);
      if (!correction) correction = {};
      correction.alongKn = resultant.alongKn;
      correction.crossKn = resultant.crossKn;
      const effectiveSpeed = resultant.effectiveSpeed;

      // Resultant over-the-ground vector: the boat's own forward vector
      // (speed, along the intended course) plus current plus wind-leeway
      // (either may be zero/absent -- see above). Stored even when
      // effectiveSpeed is too low/negative to apply to the ETA below --
      // that adverse case (current+wind overpowering the boat, net
      // movement backward over ground) is exactly the one most worth
      // visualizing, not hiding.
      correction.groundSpeedKn = resultant.groundSpeedKn;
      correction.groundBearingDeg = resultant.groundBearingDeg;

      const currentPart = sample
        ? `Current: sampled ${sample.speedKn.toFixed(2)} kn toward ${sample.dirDeg.toFixed(0)}° ` +
          `(${sample.distKm.toFixed(1)} km from leg midpoint, snapshot ${new Date(sample.timeKey).toLocaleString()}).`
        : `Current: ` +
          (currentRecords.length
            ? `no sample within ${CURRENT_SAMPLE_MAX_KM} km of this leg's midpoint.`
            : `no current-field data loaded (data/current_field.js missing or empty — run scripts/fetch_model_data.py).`);

      let windPart;
      if (!windSample) {
        windPart = `Wind/leeway: no wind-field sample near this leg's midpoint to draw a leeway contribution from.`;
      } else if (!leewayPercent) {
        windPart = `Wind/leeway: Leeway is set to 0% — wind excluded from this correction (raw forecast still shown below).`;
      } else {
        const leewaySide = leewayCrossKn >= 0 ? "starboard" : "port";
        windPart =
          `Wind/leeway: crosswind component ${Math.abs(windCrossKn).toFixed(2)} kn relative to this leg's ${courseBearing.toFixed(0)}° course ` +
          `→ ${leewayPercent}% leeway = ${Math.abs(leewayCrossKn).toFixed(2)} kn drift to ${leewaySide} ` +
          `(0.00 kn means wind is near dead-ahead/astern relative to the course, not that it was excluded).`;
      }

      // crossKn > 0 = the COMBINED current+leeway push is to starboard of
      // the intended course, < 0 = to port. Informational only -- not
      // applied to the route or the ETA; steering/waypoint choices to
      // counter it are on the sailor.
      const driftSide = correction.crossKn >= 0 ? "starboard" : "port";
      const driftNote = ` Combined cross-track drift: ${Math.abs(correction.crossKn).toFixed(2)} kn to ${driftSide} (not corrected for — a sideways push off the direct line between waypoints).`;
      if (effectiveSpeed > 0.2) {
        hours = distNm / effectiveSpeed;
        correctionColor = "#2a628f";
        correctionNote =
          `${currentPart} ${windPart} ` +
          `Along-track ${correction.alongKn >= 0 ? "+" : ""}${correction.alongKn.toFixed(2)} kn → effective speed over ground ${effectiveSpeed.toFixed(2)} kn. ` +
          `Nearest-neighbor approximation only (no interpolation between grid points or forecast hours) — indicative, not precise.` +
          driftNote;
      } else {
        correctionNote =
          `${currentPart} ${windPart} Combined along-track ${correction.alongKn.toFixed(2)} kn opposes travel by more than your boat speed ` +
          `— ETA correction not applied; showing the uncorrected straight-line estimate instead. Reconsider timing for this leg.` +
          driftNote;
      }
    } else {
      // 2026-08-05: drift is null here for one of three distinct reasons --
      // no wind sample at all, Leeway% actually set to 0, or (the subtle
      // one) a real wind sample whose crosswind component just happens to
      // resolve to ~0 because it's dead-ahead/astern relative to this leg's
      // course. Conflating the last case with "Leeway is 0%" would be
      // actively misleading (the setting isn't 0, the geometry is) -- kept
      // as three separate branches rather than the earlier two-way check.
      const currentReason = currentRecords.length
        ? `no current-field sample within ${CURRENT_SAMPLE_MAX_KM} km of this leg's midpoint`
        : `no current-field data loaded`;
      const windReason = !windSample
        ? `no wind-field sample near this leg's midpoint either`
        : !leewayPercent
        ? `Leeway is 0% (wind excluded)`
        : `wind is dead-ahead/astern relative to this leg's course (zero crosswind component, so zero leeway)`;
      correctionNote = `Current/wind-leeway ETA correction: not applied — ${currentReason}, and ${windReason}.`;
    }

    // 2026-08-05: wind/wave forecast text for this leg -- same midpoint/
    // startTime sample as the correction above (this leg's OWN forecast
    // time, not real "now"). The raw forecast shown here regardless of
    // whether Leeway % actually folded it into the correction above.
    let windNote;
    if (windSample) {
      const fromDeg = reciprocalBearingDeg(windSample.dirDeg);
      windNote =
        `Wind (forecast): ${windSample.speedKn.toFixed(1)} kn from ${fromDeg.toFixed(0)}° ` +
        `(${windSample.distKm.toFixed(1)} km from leg midpoint, snapshot ${new Date(windSample.timeKey).toLocaleString()}).`;
    } else {
      windNote =
        `Wind (forecast): not available — ` +
        (windRecords.length
          ? `no wind-field sample within ${WIND_STATION_SAMPLE_MAX_KM} km of this leg's midpoint.`
          : `no wind-field data loaded (data/wind_field.js missing or empty — run scripts/fetch_model_data.py).`);
    }

    let waveNote;
    const waveSample = sampleWaveNear(waveRecords, midpoint.lat, midpoint.lon, startTime);
    if (waveSample) {
      waveNote =
        `Waves (forecast): ${waveSample.hsM.toFixed(2)} m significant height ` +
        `(${waveSample.distKm.toFixed(1)} km from leg midpoint, snapshot ${new Date(waveSample.timeKey).toLocaleString()}).`;
    } else {
      waveNote =
        `Waves (forecast): not available — ` +
        (waveRecords.length
          ? `no wave-field sample within ${WAVE_SAMPLE_MAX_KM} km of this leg's midpoint.`
          : `no wave-field data loaded (data/wave_field.js missing or empty — run scripts/fetch_model_data.py).`);
    }

    cursorTime = new Date(cursorTime.getTime() + hours * 3600 * 1000);
    legTimings.push({ startTime, arriveTime: new Date(cursorTime), correction, windSample, waveSample, distNm, courseBearing, hours, midpoint, from: a, to: b, speed });

    // legOpenState[i] persists this leg's collapsed/expanded state across
    // renderLegs() rebuilds (every speed/departure/waypoint change replaces
    // #legs' innerHTML wholesale) -- default open (undefined/true) so a leg
    // never starts collapsed on its own. See the "toggle" listener below,
    // which is what keeps this in sync with what the user actually clicked.
    const openAttr = legOpenState[i] === false ? "" : "open";

    // 2026-08-05: owner's request -- each leg down to ONE line (was five
    // separate <div> rows plus a whole paragraph), everything else moved
    // behind a "?" toggle (legNoteOpenState[i], same persist-across-
    // rebuilds reasoning as legOpenState above -- without it, editing the
    // leg-speed input inside the note would trigger redraw() and
    // immediately re-close the very note the input lives in). km (not nm)
    // and short a/p-suffixed clock times, per the owner's own example
    // format ("3.62km,350°, 5kn, 45min, 42minC, 5:31-6:17") -- the fuller
    // nm figure and full date/time are still in the "?" note, not lost.
    const baselineMin = Math.round(baselineHours * 60);
    const correctedMin = Math.round(hours * 60);
    const showCorrected = !!correction && hours !== baselineHours;
    const summaryLine =
      `${distKm.toFixed(2)} km, ${courseBearing.toFixed(0)}&deg;, ${speed} kn, ${baselineMin} min` +
      (showCorrected ? `, ${correctedMin} minC` : "") +
      `, ${formatShortClockTime(startTime)}&ndash;${formatShortClockTime(cursorTime)}`;
    const noteOpen = !!legNoteOpenState[i];

    html += `
      <details class="leg" data-leg="${i}" ${openAttr}>
        <summary class="leg-title">Leg ${i + 1}-${i + 2}</summary>
        <div class="leg-line">
          <span>${summaryLine}</span>
          <button type="button" class="leg-help-btn" data-leg="${i}" aria-label="Leg details" title="Leg details">?</button>
        </div>
        <div class="leg-note" data-leg="${i}" ${noteOpen ? "" : "hidden"}>
          <div>Distance: ${distKm.toFixed(2)} km (${distNm.toFixed(2)} nm), course ${courseBearing.toFixed(0)}&deg;</div>
          <div>Speed (through water): <input type="number" class="leg-speed" data-leg="${i}" value="${speed}" min="0.1" step="0.1"> kn</div>
          <div>Time underway: ${hours.toFixed(2)} h${showCorrected ? ` (uncorrected: ${baselineHours.toFixed(2)} h)` : ""}</div>
          <div>Depart leg: ${startTime.toLocaleString()}</div>
          <div>Arrive leg: ${cursorTime.toLocaleString()}</div>
          <div style="margin-top:4px;color:${correctionColor};font-size:11px;">
            ${correctionNote}
          </div>
          <div style="margin-top:4px;font-size:11px;">${windNote}</div>
          <div style="margin-top:4px;font-size:11px;">${waveNote}</div>
        </div>
      </details>`;
  }

  // 2026-08-03: route-totals summary, per the owner's request -- previously
  // only per-leg distance/duration/ETA existed; nothing summed across the
  // whole route. Computed from legTimings, which the loop above just
  // finished building, so total distance/hours are a plain sum and the
  // final ETA is simply the last leg's arriveTime (== cursorTime at this
  // point, since cursorTime was advanced leg-by-leg through the loop).
  // Placed ABOVE the per-leg cards (prepended to `html`) so it's the first
  // thing visible without having to scroll past every leg.
  const totalDistNm = legTimings.reduce((sum, leg) => sum + leg.distNm, 0);
  const totalDistKm = totalDistNm * KM_PER_NM;
  const totalHours = legTimings.reduce((sum, leg) => sum + leg.hours, 0);
  const finalEta = legTimings[legTimings.length - 1].arriveTime;
  const summaryHtml =
    `<div style="font-size:12px;padding:6px 8px;margin-bottom:10px;background:#eef4f9;border:1px solid #b9d3e6;border-radius:4px;">` +
    `<strong>Route total:</strong> ${totalDistKm.toFixed(2)} km (${totalDistNm.toFixed(2)} nm), ${totalHours.toFixed(2)} h underway. ` +
    `<strong>ETA at final waypoint:</strong> ${finalEta.toLocaleString()}.` +
    `</div>`;
  el.innerHTML = summaryHtml + html;

  el.querySelectorAll(".leg-speed").forEach((input) => {
    input.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.leg, 10);
      legSpeedOverrides[idx] = parseFloat(e.target.value) || defaultSpeed;
      // redraw(), not renderLegs(): the waypoint/leg-line hover tooltips are
      // built from legTimings too and would otherwise go stale after this.
      redraw();
    });
  });

  el.querySelectorAll(".leg").forEach((detailsEl) => {
    const idx = parseInt(detailsEl.dataset.leg, 10);
    detailsEl.addEventListener("toggle", () => {
      legOpenState[idx] = detailsEl.open;
    });
  });

  // 2026-08-05: toggles the one-line-summary's "?" -- see legNoteOpenState's
  // own comment for why this is tracked in a persisted object rather than
  // just flipping `.hidden` in place (which would be simpler here, but
  // wouldn't survive the next redraw()/renderLegs() rebuild triggered by
  // editing the leg-speed input that lives inside this very note).
  el.querySelectorAll(".leg-help-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.leg, 10);
      legNoteOpenState[idx] = !legNoteOpenState[idx];
      const noteEl = el.querySelector(`.leg-note[data-leg="${idx}"]`);
      if (noteEl) noteEl.hidden = !legNoteOpenState[idx];
    });
  });
}

// 2026-08-05: per-leg "?" note open/closed state (leg index -> boolean),
// same persistence reasoning as legOpenState below -- default closed
// (undefined/false), since the whole point of collapsing this behind a
// "?" was to keep the sidebar short by default.
const legNoteOpenState = {};

// Formats a Date as a short "H:MMa"/"H:MMp" clock time (12-hour, lowercase
// a/p suffix instead of " AM"/" PM") -- used only in each leg's one-line
// summary (renderLegs()), which has to fit distance/course/speed/time/
// depart-arrive on one line; the fuller `toLocaleString()` (date + zone-
// aware time) is still used in that leg's "?" note for Depart/Arrive.
function formatShortClockTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

// Per-leg collapsed/expanded state (leg index -> boolean), read/written by
// renderLegs() above -- see its comment. Not reset on route changes: if you
// collapse Leg 2 and then add a waypoint, Leg 2 stays collapsed (indices
// are stable as long as you're only appending, which is the common case;
// undo/clear naturally start over since legTimings/waypoints do too).
const legOpenState = {};

const legSpeedOverrides = {};
function getLegSpeed(i, fallback) {
  return legSpeedOverrides[i] !== undefined ? legSpeedOverrides[i] : fallback;
}

// 2026-08-05: reads `#leeway-percent` (index.html, Layout Route section) --
// the percentage of wind's crosswind component folded into the ETA/ground-
// track correction as leeway. 0 (or an unparseable/missing field) means
// wind is excluded from the correction entirely, same behavior as before
// this feature existed.
function getLeewayPercent() {
  const el = document.getElementById("leeway-percent");
  const v = el ? parseFloat(el.value) : 0;
  return Number.isFinite(v) ? v : 0;
}

// Returns the next event at-or-after refTime, and the one after that, from
// a station's events array (sorted ascending by time, as CHS returns them).
function findNextEvents(events, refTime) {
  if (!events || events.length === 0) return [];
  const idx = events.findIndex((e) => new Date(e.time) >= refTime);
  if (idx === -1) return []; // refTime is after the snapshot's last event
  return events.slice(idx, idx + 2);
}

function formatEvent(e) {
  const t = new Date(e.time);
  const label = { SLACK: "slack", EXTREMA_EBB: "max ebb", EXTREMA_FLOOD: "max flood" }[e.type] || e.type;
  const speed = e.type === "SLACK" ? "" : ` (${e.speed_kn.toFixed(1)} kn)`;
  return `${label}${speed} at ${t.toLocaleString()}`;
}

// 2026-08-05: factored out of renderWarnings() so showRouteConditionsGraph()
// can reuse the exact same "which gate stations does this route actually
// pass near, on which leg" logic for its own labeled current dots -- one
// proximity-detection pass, not two independently-maintained copies (the
// same "one code path" reasoning this project applies elsewhere, e.g.
// sampleCombinedDrift() shared by renderLegs()/renderGroundTrackArrows()).
function findRouteGateHits() {
  const hits = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    gateStations.forEach((s) => {
      const d = pointToSegmentKm(s, a, b);
      if (d <= warningRadiusKm) {
        hits.push({ leg: i + 1, station: s, distKm: d, legIndex: i });
      }
    });
  }
  return hits;
}

function renderWarnings() {
  const el = document.getElementById("warnings");
  if (waypoints.length < 2) {
    el.innerHTML = "No route yet.";
    return;
  }

  const predictions = loadGatePredictions();
  const hits = findRouteGateHits();

  if (hits.length === 0) {
    el.innerHTML = "<p style='font-size:12px;color:#666;'>No known gate/pass stations within " + warningRadiusKm + " km of the route.</p>";
    return;
  }

  el.innerHTML = hits
    .map((h, i) => {
      const stationPred = predictions[h.station.id];
      const arriveTime = legTimings[h.legIndex] ? legTimings[h.legIndex].arriveTime : new Date();
      let eventsHtml = `Check CHS current predictions for this station directly — not pulled into this app.`;
      if (stationPred && stationPred.ok && stationPred.events && stationPred.events.length) {
        const next = findNextEvents(stationPred.events, arriveTime);
        if (next.length) {
          eventsHtml =
            "Next: " + next.map(formatEvent).join(", ") +
            ` <span style="color:#888;">(CHS prediction snapshot — not live; re-run the data pipeline to refresh)</span>`;
        } else {
          eventsHtml = `No prediction events on file at/after your estimated arrival — the data snapshot may not cover this date. Check CHS directly.`;
        }
      }
      const modelHtml = gateStationModelHtml(h.station, loadRawCurrentField(), arriveTime); // see gateStationModelHtml()'s own comment for why raw, not loadCurrentField()
      // 2026-08-05: owner's request -- "plot the Gate current for the
      // appropriate time where a route leg goes through or near a gate."
      // `data-hit` indexes back into `hits` (still in scope below, this
      // whole render is one function call) so the click handler can reuse
      // the exact same `arriveTime` this warning text was already built
      // from, not a second computation of "when is the route here."
      // 2026-08-06: `data-hit-components` -- same index, second button --
      // opens showGateCurrentComponentsGraph() (E/W & N/S, model-only) from
      // this same warning row. Wired separately below alongside `[data-hit]`,
      // since gateStationModelHtml() deliberately doesn't embed either
      // button itself (see its own comment).
      return `<div class="warning-item"><strong>Leg ${h.leg}</strong>: passes within ${h.distKm.toFixed(2)} km of <strong>${h.station.name}</strong>. ${eventsHtml}<br><span style="color:#888;">${modelHtml}</span> <button type="button" class="graph-link" data-hit="${i}">Show gate current graph</button> <button type="button" class="graph-link" data-hit-components="${i}">Show E/W &amp; N/S graph</button></div>`;
    })
    .join("");

  el.querySelectorAll("[data-hit]").forEach((btn) => {
    const h = hits[parseInt(btn.dataset.hit, 10)];
    btn.addEventListener("click", () => {
      const arriveTime = legTimings[h.legIndex] ? legTimings[h.legIndex].arriveTime : new Date();
      showGateCurrentGraph(h.station, { x: arriveTime, label: `Leg ${h.leg} arrival` });
    });
  });
  el.querySelectorAll("[data-hit-components]").forEach((btn) => {
    const h = hits[parseInt(btn.dataset.hitComponents, 10)];
    btn.addEventListener("click", () => showGateCurrentComponentsGraph(h.station));
  });
}

// 2026-08-05: owner's request ("report conditions along each route
// segment" + "plot the route" -- his own hand-drawn sketch was the
// starting point), scoped down via AskUserQuestion to ONE graph covering
// the whole route (not per-leg, not on-map markers) with current, wind,
// and the combined/resultant (over-the-ground) speed as three separate
// lines. Steps through every leg exactly the way renderGroundTrackArrows()
// already does (same GROUND_TRACK_STEP_HOURS cadence, same
// destinationPoint() position formula, same sampleCombinedDrift() call) --
// deliberately the SAME position-stepping path as the ground-track arrows
// (destinationPoint() along each leg's own straight route line, same
// GROUND_TRACK_STEP_HOURS cadence -- "hourly intervals," per the owner's
// own wording), not a second hand-written copy of that geometry.
//
// Unlike renderGroundTrackArrows()'s arrow-per-STEP loop (which only cares
// about the interior of each step), this builds GRAPH POINTS, so each
// leg's exact final (arrival) instant is always included as its own point,
// not just whatever step happened to land near it -- otherwise a short
// leg (under one GROUND_TRACK_STEP_HOURS) could contribute only its
// departure-instant sample and never its arrival one.
//
// 2026-08-05, owner changed his mind (same day, twice): this now reports
// the RAW map/forecast conditions (current, wind, waves exactly as the
// model has them) at each point, NOT the vessel's resultant/leeway-
// corrected effect -- the earlier "Combined (over ground)" line is
// dropped entirely, and with it any need for courseBearing/leg.speed/
// leeway in the SAMPLING itself (sampleCombinedDrift()/
// getLeewayPercent() are no longer called here -- this function doesn't
// need to know anything about the boat, only the map data). Plain
// sampleCurrentNear()/sampleWindNear()/sampleWaveNear() at each stepped
// position instead. The vessel's own resultant effect is still available
// elsewhere (each leg's "?" note, the green ground-track arrows) -- this
// graph is deliberately now just "what does the map say here," full stop.
//
// IMPORTANT (owner's own emphasis, kept exactly as it always was): each
// point is sampled at its own FORECAST time (leg.startTime + elapsed
// hours) -- the time the vessel would actually be at that position given
// the route's set departure time -- NOT real "now". Only WHICH quantities
// get sampled changed today; the time axis itself did not.
function buildRouteConditionsSeries() {
  const currentRecords = loadCurrentField();
  const windRecords = loadWindField();
  const waveRecords = loadWaveField();
  const currentPts = [], windPts = [], wavePts = [];

  legTimings.forEach((leg) => {
    const marks = [];
    let h = 0;
    while (h < leg.hours - 1e-9 && marks.length <= GROUND_TRACK_MAX_ARROWS_PER_LEG) {
      marks.push(h);
      h += GROUND_TRACK_STEP_HOURS;
    }
    marks.push(leg.hours); // always end exactly at this leg's own arrival time

    marks.forEach((hrs) => {
      const sampleTime = new Date(leg.startTime.getTime() + hrs * 3600 * 1000);
      const pos = destinationPoint(leg.from, leg.courseBearing, leg.speed * hrs * KM_PER_NM);

      // Each line only gets a point where a real sample exists -- skipping
      // (not zero-filling) an unavailable stretch, same "don't plot a gap
      // as zero" principle showPointWaveGraph() already documents for its
      // own hs_m gaps.
      const currentSample = sampleCurrentNear(currentRecords, pos.lat, pos.lon, sampleTime);
      if (currentSample) currentPts.push({ x: sampleTime, y: currentSample.speedKn });

      const windSample = sampleWindNear(windRecords, pos.lat, pos.lon, sampleTime);
      if (windSample) windPts.push({ x: sampleTime, y: windSample.speedKn });

      const waveSample = sampleWaveNear(waveRecords, pos.lat, pos.lon, sampleTime);
      if (waveSample) wavePts.push({ x: sampleTime, y: waveSample.hsM });
    });
  });

  return { currentPts, windPts, wavePts };
}

// 2026-08-05: opens the whole-route conditions graph (button in the Query
// Route sidebar section, index.html). See buildRouteConditionsSeries()'s
// own comment for what's actually being sampled/plotted.
function showRouteConditionsGraph() {
  if (waypoints.length < 2 || !legTimings.length) {
    openGraphPopup("Route conditions", (ctx, w, h) => {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.fillText("No route yet — lay one out in Layout Route first.", 12, h / 2);
    }, "", null);
    return;
  }

  const { currentPts, windPts, wavePts } = buildRouteConditionsSeries();
  const allTimes = [...currentPts, ...windPts, ...wavePts].map((p) => p.x.getTime());
  const timeBounds = allTimes.length
    ? { min: new Date(Math.min(...allTimes)), max: new Date(Math.max(...allTimes)) }
    : null;

  // Waypoint markers (WP1, WP2, ...): fixed for the life of this graph --
  // a route's own waypoints/timing don't change while the popup is open,
  // only the map time does (mapTimeMarker below) -- so these are safe to
  // compute once here rather than inside the renderFn closure. Times come
  // directly from legTimings: WP1 is the first leg's startTime, every
  // other WP is some leg's arriveTime -- consecutive legs share that
  // boundary instant, so `[leg0.startTime, ...legs.map(arriveTime)]` gives
  // exactly one time per waypoint, matching the "WP1 -> WP2" numbering
  // renderLegs() itself already uses for leg titles.
  const waypointMarkers = [legTimings[0].startTime, ...legTimings.map((l) => l.arriveTime)].map((t, i) => ({
    x: t,
    color: "#999",
    dashed: false,
    label: `WP${i + 1}`,
  }));

  // 2026-08-05: owner's request -- "plot the calculated current magnitude
  // in the Gate on the route conditions plot, as a labelled large dot."
  // Reuses findRouteGateHits() (the SAME proximity-detection pass
  // renderWarnings() already runs) so "which gates does this route pass
  // near" is computed exactly once, not independently re-derived here and
  // risking disagreement with the Query Route warning list. For each hit,
  // samples the SalishSeaCast model current AT THAT STATION'S OWN
  // COORDINATES (not wherever the route's own sampled path happens to
  // pass -- a gate's real current can differ meaningfully from the field
  // a few hundred meters away) at the leg's own `arriveTime` -- the exact
  // same sample `gateStationModelHtml()` already shows as text next to
  // that same warning. Fixed for the graph's lifetime, like the waypoint
  // markers above -- a route's own gate proximity doesn't change while
  // the popup stays open.
  // 2026-08-05: owner's follow-up -- "plot the current graphs as N/S for
  // Dodd Narrows, all other Gates E/W." Scoped down (owner's own choice,
  // via clarifying question) to just this dot's LABEL, not the CHS gate
  // current curve graph (that data source is unsigned-magnitude-only --
  // see README's "N/S (Dodd Narrows) vs E/W" backlog entry -- owner plans
  // to add a direction dataset separately). The dot's Y-POSITION stays the
  // plain speed magnitude (same axis/domain as the Current line it sits
  // on -- keeps it visually comparable to that line, and avoids a signed
  // value landing off-chart below the magnitude-only y=0 floor). Only the
  // label text becomes signed. Signed by the RAW geometric north/east
  // vector component -- NOT a guessed "flood direction" (no confident
  // hydrographic knowledge of local flood/ebb bearing per station) -- so
  // positive strictly means "toward north"/"toward east", same convention
  // compass coordinates always use.
  function signedGateAxisLabel(stationName, vec) {
    const isDoddNarrows = stationName === "Dodd Narrows";
    const component = isDoddNarrows ? vec.northKn : vec.eastKn;
    const axisChar = isDoddNarrows ? (component >= 0 ? "N" : "S") : (component >= 0 ? "E" : "W");
    return `${axisChar} ${Math.abs(component).toFixed(2)} kn`;
  }

  const currentRecordsForGateDots = loadCurrentField();
  const gateDots = findRouteGateHits()
    .map((hit) => {
      const arriveTime = legTimings[hit.legIndex] ? legTimings[hit.legIndex].arriveTime : new Date();
      const sample = sampleCurrentNear(currentRecordsForGateDots, hit.station.lat, hit.station.lon, arriveTime);
      if (!sample) return null;
      return { x: arriveTime, y: sample.speedKn, label: `${hit.station.name}: ${signedGateAxisLabel(hit.station.name, sample.vec)}` };
    })
    .filter(Boolean);

  openGraphPopup(
    "Route conditions — current / wind / waves",
    (ctx, w, h, rangeStart, rangeEnd) => {
      // 2026-08-05: computed INSIDE the renderFn, NOT once outside it --
      // same pattern showPointCurrentGraph()'s own "now" marker already
      // established (see its own comment): this is what lets
      // refreshOpenGraphPopup() (called from refreshFieldTimeDependents()
      // on every PageUp/PageDown/slider/Prev-Next/Home step) actually
      // MOVE this line when it re-invokes this renderFn, rather than
      // repainting the same captured-at-open-time value forever. Answers
      // the owner's "when I step through the map, move the indicator
      // line" request -- the underlying mechanism already existed from
      // the time-scrubber feature; this graph just wasn't plugged into it
      // correctly the first time.
      // 2026-08-07: `now: true` -- see showPointCurrentGraph()'s comment.
      // Kept OUT of the filterPointsByRange() call below (unlike
      // highlightedWaypointMarkers, which keeps its original filtered/
      // silent-skip behavior) so it can draw a flashing out-of-range arrow
      // instead of vanishing when scrubbed/zoomed away.
      const mapTimeMarker = buildTimeMarkers();
      // 2026-08-05: owner's request -- "highlight the waypoint on both the
      // route and the graph" as the map's time steps. currentWaypointIndex()
      // is the SAME shared computation highlightCurrentWaypointOnMap() uses
      // for the map markers (both triggered by the exact same
      // refreshFieldTimeDependents() call), so the two views can never pick
      // different waypoints. Clones just the highlighted entry (color +
      // width) rather than mutating waypointMarkers itself, which stays the
      // one fixed-for-the-graph's-lifetime array built above.
      const highlightIdx = currentWaypointIndex();
      const highlightedWaypointMarkers = waypointMarkers.map((wm, i) =>
        i === highlightIdx ? { ...wm, color: "#c0392b", width: 3 } : wm
      );
      const markers = timeBounds
        ? [...filterPointsByRange(highlightedWaypointMarkers, rangeStart, rangeEnd), ...mapTimeMarker]
        : [];
      return drawMultiLineChart(ctx, w, h, [
        // 2026-08-05: owner's request -- "Add symbols to the Route
        // condition plots to help differentiate the current, wind and wave
        // plots" (`shape`) and "Add an other Y axis for the current (3
        // axes altogether)" -- Current/Wind/Waves now each get their own
        // independent axis (left/right/farright) instead of Current+Wind
        // sharing one knots-scaled left axis. Axis/tick colors follow
        // automatically from each axis' own single series' color -- see
        // drawMultiLineChart()'s own axisColor() comment. `lineDash`
        // (2026-08-05 follow-up, owner's "make lines solid, dashed, dotted
        // to help differentiate parameters") -- solid/dashed/dotted, same
        // Current/Wind/Waves order as the shape convention above, so the
        // two cues reinforce each other rather than being assigned
        // independently.
        { points: filterPointsByRange(currentPts, rangeStart, rangeEnd), color: "#2a628f", label: "Current", unit: "kn", showPoints: true, shape: "circle", lineDash: [], extraPoints: filterPointsByRange(gateDots, rangeStart, rangeEnd) },
        { points: filterPointsByRange(windPts, rangeStart, rangeEnd), color: "#b8860b", label: "Wind", unit: "kn", showPoints: true, shape: "triangle", axis: "right", lineDash: [7, 4] },
        { points: filterPointsByRange(wavePts, rangeStart, rangeEnd), color: "#178a8a", label: "Waves", unit: "m", showPoints: true, shape: "square", axis: "farright", lineDash: [1.5, 3] },
      ], {
        yUnitLabel: "kn",
        yUnitLabelRight: "kn",
        yUnitLabelFarRight: "m",
        markers, // already range-filtered (waypoints) / left unfiltered (mapTimeMarker) above
      });
    },
    `Raw map/forecast conditions (NOT the vessel's resultant/leeway-corrected effect -- that's each leg's own "?" note and the green ground-track arrows instead) sampled hourly along the route, each point at ITS OWN forecast time (the time the vessel would actually be there, given your set departure time) — not real "now". Current (circles), Wind (triangles), and Waves (squares) each have their own Y axis, colored to match that line — reading its own tick numbers, not a shared scale. Small symbols mark each actual sampled data point; the line between them is a plain connect-the-dots, not an interpolation. Current/Wind/Waves each gap wherever no usable sample was found nearby (not shown as zero). Waves is height only (no direction/period — not in the loaded wave data yet). Grey solid lines (WP1, WP2, ...) mark each waypoint's own real arrival time; the waypoint nearest the map's currently displayed time is highlighted (thicker red line here, red ring around its marker on the map) and stays in sync between the two as you step the map's time. Dashed line ("Map time"/"Now") marks whatever instant the map is currently showing, and moves live as you step the map's time — this graph stays open while you do that; the map underneath (including its own floating time-scrubber) stays fully clickable. A flashing arrow at the plot edge points toward that line when it falls outside the plotted/zoomed window (e.g. the route's own time span doesn't reach the current map time). Nearest-neighbor sampling only — no interpolation between grid points or forecast hours.`,
    timeBounds
  );
}

// Of a records array, returns the single time-step slice nearest to "now"
// plus that timeKey. Shared by renderCurrentArrowsOnMap() and
// renderCurrentHeatMap() so both layers always show the exact same snapshot
// moment rather than two independently-computed (and potentially different,
// e.g. right at a tie) "nearest to now" values.
// 2026-08-04: targetTime param added (defaults to real "now", so every
// existing call site keeps working unchanged) -- proof-of-concept step for
// the full time-scrubber scoped in README.md's backlog. selectedFieldTime
// (below) is the one caller that passes something other than the default.
function nearestSlice(records, targetTime) {
  const timeKey = nearestTimeKey(records, targetTime || new Date());
  const slice = records.filter((r) => r.time === timeKey);
  return { timeKey, slice };
}

// 2026-08-04, extended to the full scoped scrubber 2026-08-05 (see
// README.md's "Time-scrubber for modelled wind/current" backlog entry for
// the original scoping conversation/decisions this implements) -- null
// means "live/now" (the original, only behavior before 2026-08-04);
// non-null is a Date snapshot the owner has scrubbed to, via the floating
// map control (ensureFieldTimeControl()), its sidebar mirror, or the
// PageUp/PageDown/Home keyboard shortcuts -- all four drive this same
// state and are kept in sync by refreshFieldTimeDependents() below. Drives
// current arrows, the heat map, wind arrows, the wave map, gate/tide/wind
// station tooltips, and the point-query popup -- everything that samples
// "nearest to now" already reads this via nearestSlice()'s or its own
// `selectedFieldTime || new Date()` fallback. Deliberately does NOT drive
// leg ETA/ground-track correction, which already samples real per-leg
// elapsed times, not "now" -- explicitly out of scope per the README
// decision, left alone.
let selectedFieldTime = null;
let fieldTimeAutoDirection = 0;
let fieldTimeAutoTimer = null;
const FIELD_TIME_AUTO_INTERVAL_MS = 750;

function stopFieldTimeAuto() {
  if (fieldTimeAutoTimer) clearInterval(fieldTimeAutoTimer);
  fieldTimeAutoTimer = null;
  fieldTimeAutoDirection = 0;
  if (fieldTimeControlEl) renderFieldTimeControl();
}

function startFieldTimeAuto(dir) {
  const direction = dir < 0 ? -1 : 1;
  if (fieldTimeAutoDirection === direction) {
    stopFieldTimeAuto();
    return;
  }
  if (fieldTimeAutoTimer) clearInterval(fieldTimeAutoTimer);
  fieldTimeAutoDirection = direction;
  const tick = () => {
    const steps = currentFieldTimeSteps();
    const idx = fieldTimeCurrentIndex(steps);
    const next = idx + direction;
    if (!steps.length || idx < 0 || next < 0 || next >= steps.length) {
      stopFieldTimeAuto();
      return;
    }
    setFieldTimeIndex(next);
  };
  tick();
  if (fieldTimeAutoDirection) fieldTimeAutoTimer = setInterval(tick, FIELD_TIME_AUTO_INTERVAL_MS);
}

// Sorted unique time values actually present in the current field -- the
// scrubber (slider + Prev/Next + PageUp/PageDown) steps through THIS list,
// one entry at a time, rather than jumping by a fixed 1h offset -- safer
// if the pipeline's own cadence ever isn't exactly hourly, and free since
// loadCurrentField() already has to be read anyway. Per the README
// decision, the scrubber's own RANGE is the current field's full ~41h
// span (not clipped to wind's shorter window) -- wind/wave naturally
// freeze at their own last available slice once stepped past it, via
// nearestTimeKey()'s existing nearest-match logic, no extra clamping code
// needed for that.
function currentFieldTimeSteps() {
  const records = loadCurrentField();
  return [...new Set(records.map((r) => r.time))].sort();
}

// Index into `steps` that selectedFieldTime currently corresponds to -- or,
// when selectedFieldTime is null (live), the index nearest to real "now"
// (purely for positioning the slider thumb sensibly; live mode doesn't
// actually pin to this index -- see setFieldTimeIndex()/resetFieldTimeToLive()
// below, and renderFieldTimeControl()'s own "Live" labeling). Returns -1 if
// `steps` is empty.
function fieldTimeCurrentIndex(steps) {
  if (!steps.length) return -1;
  const target = selectedFieldTime ? selectedFieldTime.toISOString() : nearestTimeKey(loadCurrentField(), new Date());
  let idx = steps.indexOf(target);
  if (idx === -1) {
    // Not an exact match (e.g. real "now" falls between two hourly steps)
    // -- fall back to nearestTimeKey's own closest-match logic.
    const nearest = nearestTimeKey(loadCurrentField(), selectedFieldTime || new Date());
    idx = steps.indexOf(nearest);
  }
  return idx;
}

// Everything that needs to happen after selectedFieldTime changes, from ANY
// of its entry points (slider drag, Prev/Next buttons, PageUp/PageDown
// keys, or a Live-button/Home-key reset) -- one shared function so all of
// them stay in sync rather than several hand-maintained copies of the same
// render-call list (the exact bug class the 2026-08-04 POC's inline
// Home-key handler was already at risk of). Station-tooltip reloads
// (loadGateStations()/loadTideStations()/loadWindStations()) added
// 2026-08-05 -- completes the "Scope of effect" decision in README.md,
// which named gate/tide station tooltip "model sample" text as one of the
// things the scrubbed time should drive, alongside the four map layers and
// the point-query popup (that last one already reads selectedFieldTime
// directly inside showPointQueryPopup() -- nothing to refresh here unless
// it's currently open, which it can't be while a keyboard/slider event is
// firing, since opening it is itself a map click).
let fieldTimeRefreshFrame = null;

function refreshFieldTimeDependentsNow() {
  renderCurrentArrowsOnMap();
  renderCurrentHeatMap();
  renderWindArrowsOnMap();
  renderWaveMap();
  renderWindCurrentInteractionMap();
  // The unified Environment Canada forecast colours live on
  // marineZoneLayer (renderMarineZonesOnMap), not the older separate
  // marineExtendedMapLayer. Rebuild them on every map-time step so the
  // zone fill selects the same dated EC bar as the open six-bar graph.
  renderMarineZonesOnMap();
  renderMarineExtendedForecastMap();
  loadGateStations();
  loadTideStations();
  loadWindStations();
  renderFieldTimeControl();
  highlightCurrentWaypointOnMap(); // 2026-08-05: keep the map's highlighted WP in step with the scrub, same trigger as everything else here
  refreshOpenGraphPopup(); // move the open graph's (if any) dashed "now" line along with the scrub
}

// Rebuilding every time-dependent map layer is deliberately expensive. A
// child can generate several click/key/slider events before the browser has
// painted even one result; drawing each obsolete intermediate hour makes the
// app appear to stop responding. Keep selectedFieldTime synchronous, but
// coalesce all redraw requests in a browser frame to the newest requested
// hour. Nothing is skipped from the final state.
function refreshFieldTimeDependents() {
  if (fieldTimeRefreshFrame !== null) return;
  const schedule = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
  fieldTimeRefreshFrame = schedule(() => {
    fieldTimeRefreshFrame = null;
    refreshFieldTimeDependentsNow();
  });
}

// Sets selectedFieldTime to steps[idx] (clamped to the valid range) and
// refreshes everything that depends on it. Shared by the floating
// control's slider "input" handler and stepFieldTime() below.
function setFieldTimeIndex(idx) {
  const steps = currentFieldTimeSteps();
  if (!steps.length) return;
  const clamped = Math.max(0, Math.min(steps.length - 1, idx));
  selectedFieldTime = new Date(steps[clamped]);
  refreshFieldTimeDependents();
}

// Steps selectedFieldTime by one entry in currentFieldTimeSteps(), in `dir`
// (+1 or -1) -- the floating control's Prev/Next buttons and the
// PageUp/PageDown keys both call this. Starts from whichever slice is
// currently showing (the real "now" slice, if selectedFieldTime is still
// null) so the first press moves from whatever's actually on screen, not
// from an arbitrary list edge. Clamps at either end rather than wrapping --
// stepping off the end just stops, matching the "frozen at last available
// hour" behavior already decided for wind in README's full-scrubber scope.
function stepFieldTime(dir) {
  stopFieldTimeAuto();
  const steps = currentFieldTimeSteps();
  if (!steps.length) return;
  const idx = fieldTimeCurrentIndex(steps);
  setFieldTimeIndex(idx === -1 ? (dir > 0 ? 0 : steps.length - 1) : idx + dir);
}

// Resets selectedFieldTime to null (live/"now") -- the floating control's
// Live button, the sidebar mirror's Now button, and the Home key all call
// this.
function resetFieldTimeToLive() {
  stopFieldTimeAuto();
  selectedFieldTime = null;
  refreshFieldTimeDependents();
}

let fieldTimeControlEl = null; // cached floating-control DOM, built once by ensureFieldTimeControl()

// Builds the floating map-time scrubber ONCE (Prev/Next buttons, a range
// slider, a Live/Now toggle button, and a status label) and wires its
// event listeners -- same "build once, update on every change" pattern
// ensureGraphModal() already uses for the graph popup. Reuses the
// .graph-link button look (style.css) for visual consistency with the rest
// of the app rather than inventing new button chrome. Positioned
// bottom-CENTER (own .field-time-control CSS, style.css) so it doesn't
// collide with the ground-track scale-arrow legend (bottom-left, a Leaflet
// control) or Leaflet's own attribution control (bottom-right) -- the
// 2026-08-04 POC's plain status box sat bottom-left, at real risk of
// exactly that collision; not carried forward. This is the ONE real
// slider/buttons per the README decision -- the sidebar mirror
// (renderFieldTimeControl() below) is read-only status text plus its own
// small Now button, not a second independent slider.
function ensureFieldTimeControl() {
  if (fieldTimeControlEl) return fieldTimeControlEl;
  const el = document.createElement("div");
  el.className = "field-time-control";
  el.innerHTML =
    `<strong class="field-time-drag-handle" role="button" tabindex="0" aria-expanded="true" title="Drag to move; click to collapse">Map Time</strong>` +
    `<div class="field-time-control-body">` +
    `<button type="button" class="graph-link field-time-auto-prev-btn" title="Automatically step backward; press again to stop">Auto &#9664;</button>` +
    `<button type="button" class="graph-link field-time-prev-btn" title="Step back one snapshot (PageUp)">PgUp &#9664;</button>` +
    `<input type="range" class="field-time-slider" min="0" max="0" value="0" step="1" aria-label="Scrub current/wind/wave time">` +
    `<button type="button" class="graph-link field-time-next-btn" title="Step forward one snapshot (PageDown)">&#9654; PgDn</button>` +
    `<button type="button" class="graph-link field-time-auto-next-btn" title="Automatically step forward; press again to stop">&#9654; Auto</button>` +
    `<button type="button" class="graph-link field-time-live-btn" title="Return to now (Home)">NOW</button>` +
    `<span class="field-time-label"></span></div>`;
  document.body.appendChild(el);

  const dragHandle=el.querySelector(".field-time-drag-handle");
  let drag=null,moved=false;
  dragHandle.addEventListener("pointerdown",event=>{
    const rect=el.getBoundingClientRect();
    drag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};moved=false;
    dragHandle.setPointerCapture(event.pointerId);event.preventDefault();
  });
  dragHandle.addEventListener("pointermove",event=>{
    if(!drag)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
    el.style.left=`${Math.max(0,Math.min(window.innerWidth-el.offsetWidth,drag.left+dx))}px`;
    el.style.top=`${Math.max(0,Math.min(window.innerHeight-el.offsetHeight,drag.top+dy))}px`;
    el.style.right="auto";el.style.bottom="auto";el.style.transform="none";
  });
  dragHandle.addEventListener("pointerup",()=>{drag=null;});
  dragHandle.addEventListener("pointercancel",()=>{drag=null;});
  const toggleCollapse=()=>{if(moved){moved=false;return;}const collapsed=el.classList.toggle("field-time-collapsed");dragHandle.setAttribute("aria-expanded",String(!collapsed));};
  dragHandle.addEventListener("click",toggleCollapse);
  dragHandle.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();toggleCollapse();}});

  el.querySelector(".field-time-auto-prev-btn").addEventListener("click", () => startFieldTimeAuto(-1));
  el.querySelector(".field-time-prev-btn").addEventListener("click", () => stepFieldTime(-1));
  el.querySelector(".field-time-next-btn").addEventListener("click", () => stepFieldTime(1));
  el.querySelector(".field-time-auto-next-btn").addEventListener("click", () => startFieldTimeAuto(1));
  el.querySelector(".field-time-live-btn").addEventListener("click", resetFieldTimeToLive);
  // "input" (not "change") so the map updates live as the thumb is
  // dragged -- same responsiveness as the graph popup's own Start/End
  // range sliders (openGraphPopup()).
  el.querySelector(".field-time-slider").addEventListener("input", (e) => {
    stopFieldTimeAuto();
    setFieldTimeIndex(parseInt(e.target.value, 10));
  });

  fieldTimeControlEl = el;
  return el;
}

// Updates the floating control (building it on first call) AND its sidebar
// mirror (#field-time-sidebar-status/#field-time-now-btn, index.html's Map
// section) from the current selectedFieldTime/data-on-file state. Called
// by refreshFieldTimeDependents() after every change, and once from
// init() so both show something sane before the owner has touched either.
// Hides the floating control entirely (and says so in the sidebar mirror)
// when there's no current-field data on file at all -- nothing to scrub
// through yet.
function renderFieldTimeControl() {
  const steps = currentFieldTimeSteps();
  const el = ensureFieldTimeControl();
  const sidebarStatus = document.getElementById("field-time-sidebar-status");

  if (!steps.length) {
    el.style.display = "none";
    if (sidebarStatus) sidebarStatus.textContent = "Time: no current-field data on file";
    return;
  }
  el.style.display = "";

  const slider = el.querySelector(".field-time-slider");
  const liveBtn = el.querySelector(".field-time-live-btn");
  const label = el.querySelector(".field-time-label");
  const prevBtn = el.querySelector(".field-time-prev-btn");
  const nextBtn = el.querySelector(".field-time-next-btn");
  const autoPrevBtn = el.querySelector(".field-time-auto-prev-btn");
  const autoNextBtn = el.querySelector(".field-time-auto-next-btn");

  slider.max = String(steps.length - 1);
  const idx = fieldTimeCurrentIndex(steps);
  slider.value = String(Math.max(0, idx));
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx === -1 || idx >= steps.length - 1;
  autoPrevBtn.disabled = idx <= 0;
  autoNextBtn.disabled = idx === -1 || idx >= steps.length - 1;
  autoPrevBtn.classList.toggle("is-running", fieldTimeAutoDirection < 0);
  autoNextBtn.classList.toggle("is-running", fieldTimeAutoDirection > 0);

  liveBtn.classList.toggle("is-live", !selectedFieldTime);
  const activeProducts = [];
  if (salishSeaCastArrowsEnabled || ciopsArrowsEnabled) activeProducts.push("Currents");
  if (heatMapEnabled) activeProducts.push("Current speed");
  if (windArrowsEnabled) activeProducts.push("Wind");
  if (waveMapEnabled) activeProducts.push("Waves");
  if (windCurrentInteractionEnabled) activeProducts.push("Wind/current opposition");
  const productLabel = activeProducts.length ? activeProducts.join(" + ") : "Model time";
  const displayedTime = selectedFieldTime || (idx >= 0 ? new Date(steps[idx]) : new Date());
  label.textContent = `${productLabel} · ${displayedTime.toLocaleString()}`;
  el.title = "current/wind/waves — drag to scrub, Prev/Next or PageUp/PageDown to step, Live/Home to return";

  if (sidebarStatus) {
    sidebarStatus.textContent = "Time: " + (selectedFieldTime ? selectedFieldTime.toLocaleString() : "live");
  }
}

// Draws direction/speed arrows for the current-field time step nearest to
// "now" -- a static snapshot in time, not a live layer. Independent of the
// route, so it's rendered once at load, not from redraw().
//
// 2026-08-02: rebuilt from L.marker/buildCurrentArrowIcon() (a fixed-pixel
// divIcon) to buildArrowVectorLayer() (real geo-referenced polyline+polygon
// vectors, the same helper the ground-track arrows use) -- see the
// ARROW_HEAD_*/GROUND_TRACK_STEP_HOURS comment block near the top of this
// file for why. Uses one shared L.canvas() renderer for every arrow (passed
// as buildArrowVectorLayer()'s extraOpts) rather than one SVG element per
// arrow -- there can be 100+ grid points in a slice, and a shared canvas is
// far cheaper, the same reasoning as renderCurrentHeatMap()'s shared
// renderer for its (far more numerous) quads.
function renderCurrentArrowsOnMap() {
  const infoEl = document.getElementById("current-field-info");
  if (currentArrowLayer) {
    map.removeLayer(currentArrowLayer);
    currentArrowLayer = null;
  }
  // 2026-08-06, later session (owner's request: "Delete 'Current arrows'.
  // Add SalishSeaCast Model button. Add CIOPS Model button."): the single
  // currentArrowsEnabled early-return is gone -- see
  // salishSeaCastArrowsEnabled/ciopsArrowsEnabled/gateBoxesEnabled's own
  // comments (near their declarations) for the full reasoning. Nothing to
  // draw at all only when EVERY relevant toggle is off.
  if (!salishSeaCastArrowsEnabled && !ciopsArrowsEnabled && !gateBoxesEnabled) {
    if (infoEl) {
      infoEl.innerHTML =
        "<p style='font-size:12px;color:#666;'>Current arrows are off. Enable SalishSeaCast Model, CIOPS Model, or Gate Currents below to draw them.</p>";
    }
    return;
  }

  // 2026-08-06, REAL BUG FOUND ON-SCREEN by the owner ("the gate arrows
  // show alternately with the SeaCast data, never together"): this used to
  // call loadCurrentField() (which now includes the 4 DFO-gate synthetic
  // records) and run ONE nearestSlice() over the whole mixed array.
  // nearestSlice() picks a single GLOBAL nearest time key, then keeps only
  // records sharing that EXACT timestamp -- DFO-gate records sit on their
  // own time grid (CHS's curve hours, on-the-hour) which essentially never
  // coincides with SalishSeaCast's (:30-offset) or CIOPS-West's own grid,
  // so whichever grid happened to be globally nearest at any given moment
  // would win the WHOLE slice, silently starving it down to just that one
  // source -- either all raw arrows and zero DFO-gate ones, or the reverse,
  // never both. Same root cause the 30-minute SalishSeaCast/CIOPS-West
  // label-shift fix (elsewhere in this file) already solved for THOSE two
  // sources; DFO-gate's own on-the-hour grid reintroduced the same class of
  // bug at a third grid.
  //
  // Fixed by NOT mixing DFO-gate into this slice at all: rawRecords
  // (loadRawCurrentField()) drives the ordinary nearestSlice()/slice.forEach
  // loop below exactly as before 2026-08-06, and the (at most) 4 DFO-gate
  // arrows are drawn in a SEPARATE pass further down, each via its own
  // independent per-station nearest-time lookup (sampleDfoGateNear(), the
  // same mechanism sampleCurrentNear()/showPointQueryPopup() already use
  // for exactly this reason) -- so they render on EVERY call regardless of
  // what the raw grid's own globally-nearest time happens to be.
  const rawRecords = loadRawCurrentField();
  const dfoStations = (window.GATE_STATIONS_DATA && window.GATE_STATIONS_DATA.stations) || [];
  if (!rawRecords.length && !dfoStations.length) {
    if (infoEl) {
      infoEl.innerHTML =
        "<p style='font-size:12px;color:#666;'>No current-field data loaded (data/current_field.js missing or empty — run scripts/fetch_model_data.py).</p>";
    }
    return;
  }

  currentArrowLayer = L.layerGroup();
  // pane: "arrowPane" (created in initMap(), z-index above the heat map's
  // default overlayPane) keeps these arrows visible on top of the heat map
  // regardless of which order the two layers are built/toggled in -- see
  // the pane's own comment in initMap() for the bug this fixes.
  const renderer = L.canvas({ padding: 0.2, pane: "arrowPane" });

  let drawn = 0;
  let rawTimeKey = null;
  if (rawRecords.length && (salishSeaCastArrowsEnabled || ciopsArrowsEnabled)) {
    const { timeKey, slice } = nearestSlice(rawRecords, selectedFieldTime);
    rawTimeKey = timeKey;
    spatiallySubsampleRecords(recordsInsideVoyageRegion(slice), 1).forEach((rec) => {
      const vec = currentVectorKn(rec);
      if (!vec) return;
      // 2026-08-06, later session: per-source visibility, replacing the
      // old single currentArrowsEnabled flag -- see that flag's own
      // (removed) comment / salishSeaCastArrowsEnabled's new one. vec.source
      // is set in currentVectorKn() itself ("SalishSeaCast" or
      // "CIOPS-West", never anything else for rawRecords -- loadRawCurrentField()
      // already excludes "DFO-gate" records, see that function's own comment).
      if (vec.source === "CIOPS-West" && !ciopsArrowsEnabled) return;
      if (vec.source === "SalishSeaCast" && !salishSeaCastArrowsEnabled) return;
      const { speedKn, dirDeg } = currentSpeedDir(vec);
      const from = { lat: rec.lat, lon: rec.lon };
      const distanceKm = speedKn * GROUND_TRACK_STEP_HOURS * KM_PER_NM;
      const to = destinationPoint(from, dirDeg, distanceKm);
      // 2026-08-05: source note added -- some arrows near Port Hardy now come
      // from CIOPS-West (coarser 2km, unverified axis convention), not
      // SalishSeaCast -- see currentVectorKn()'s own comment. Shown here so
      // that caveat is visible at the point of use, not just in code comments.
      const sourceNote = vec.source === "CIOPS-West" ? ", CIOPS-West 2km" : "";
      const popupHtml = `${speedKn.toFixed(2)} kn toward ${dirDeg.toFixed(0)}&deg; (${vec.depth}${sourceNote}, ${new Date(timeKey).toLocaleString()})`;
      buildArrowVectorLayer(from, to, "#185fa5", popupHtml, { renderer }, {
        shaftWeightPx: CURRENT_ARROW_SHAFT_WEIGHT_PX,
        fixedHeadLenKm: CURRENT_ARROW_FIXED_HEAD_KM,
      }).addTo(currentArrowLayer);
      drawn++;
    });
  }

  // 2026-08-06: DFO-gate arrows -- see this function's own top comment for
  // why these are a separate pass, not part of the slice above. Drawn
  // bigger/bolder, in their own color -- see DFO_GATE_ARROW_COLOR's own
  // comment. Arrow LENGTH still means the same real thing everywhere on
  // this map (drift distance in GROUND_TRACK_STEP_HOURS) -- only weight/
  // head size/color/label escalate, not the underlying geometry.
  //
  // 2026-08-06, later session (owner's request): gated on gateBoxesEnabled
  // now, not the old currentArrowsEnabled -- these are real CHS
  // predictions AT the 4 gate stations, grouped with the gate
  // markers/boxes (loadGateStations(), same flag) as one feature, not with
  // the two general current-field MODEL toggles above.
  const dfoNow = selectedFieldTime || new Date();
  if (gateBoxesEnabled) dfoStations.forEach((st) => {
    const sample = sampleDfoGateNear(loadCurrentField(), st.lat, st.lon, dfoNow);
    if (!sample) return;
    const { speedKn, dirDeg, vec, timeKey } = sample;
    const from = { lat: st.lat, lon: st.lon };
    const distanceKm = speedKn * GROUND_TRACK_STEP_HOURS * KM_PER_NM;
    const to = destinationPoint(from, dirDeg, distanceKm);
    const popupHtml = `${speedKn.toFixed(2)} kn toward ${dirDeg.toFixed(0)}&deg; (${vec.depth}, CHS/DFO gate prediction — not the raw model, ${new Date(timeKey).toLocaleString()})`;
    // 2026-08-06, later session: recorded for loadGateStations()'s own
    // gate-zone box click handler -- see dfoGateArrowInfoByStationId's
    // own comment for why this is a plain lookup, not a live layer
    // reference.
    dfoGateArrowInfoByStationId[st.id] = { html: popupHtml, latlng: to };
    const arrowGroup = buildArrowVectorLayer(from, to, DFO_GATE_ARROW_COLOR, popupHtml, { renderer }, {
      shaftWeightPx: dfoGateArrowShaftWeightPx(),
      fixedHeadLenKm: DFO_GATE_ARROW_FIXED_HEAD_KM,
    });
    arrowGroup.addTo(currentArrowLayer);
    // 2026-08-06: speed-label badge, DFO-gate arrows only -- owner's
    // request, inspired by currentlybc.com's own always-visible numeric
    // label next to each named pass' arrow. Every OTHER current arrow
    // here stays click-for-popup only (there are routinely hundreds of
    // them -- a label on each would bury the map); these 4 are
    // deliberately the exception. Default marker pane (not "arrowPane",
    // which sits BELOW markers and is click-through) so the label
    // reliably renders on top of the arrow and the heat map both.
    // 2026-08-06, later session (owner's request): "Gate current labels
    // off, on with hover" -- was permanently visible (opacity 1,
    // unconditional). Now starts at opacity 0 (still added to the map,
    // still real DOM -- just invisible, not toggled via display:none/
    // re-added each time, so setOpacity() below is a cheap style flip,
    // not a re-render) and is only shown while hovering the arrow itself
    // (shaft or head -- arrowGroup's own two leaf shapes, bound directly
    // since buildArrowVectorLayer()'s group is flat, unlike
    // buildWindArrowLayer()'s nested one -- see bindStationInteractivity()'s
    // own comment for that distinction).
    const label = L.marker([to.lat, to.lon], {
      icon: L.divIcon({
        className: "current-arrow dfo-gate-arrow-label",
        html: `<div class="dfo-gate-arrow-label-inner">${speedKn.toFixed(1)} kt</div>`,
        iconSize: null,
      }),
      interactive: false,
      opacity: 0,
    }).addTo(currentArrowLayer);
    arrowGroup.eachLayer((layer) => {
      layer.on("mouseover", () => label.setOpacity(1));
      layer.on("mouseout", () => label.setOpacity(0));
    });
    drawn++;
  });

  currentArrowLayer.addTo(map);

  if (infoEl) {
    infoEl.innerHTML =
      `<p style="font-size:12px;color:#666;">Showing ${drawn} points for the snapshot nearest to now` +
      (rawTimeKey ? `: ${new Date(rawTimeKey).toLocaleString()}` : "") +
      (gateBoxesEnabled && dfoStations.length ? ` (the ${dfoStations.length} DFO-gate arrows each use their own independently-nearest time, not necessarily this same one)` : "") +
      `. Arrow length: distance the current would carry a drifting object in ${GROUND_TRACK_STEP_HOURS}h — same scale as the green vessel ground-track arrows (see the scale-arrow legend, bottom-left). ` +
      `Static pre-download (Section 8.1) — re-run the data pipeline to refresh.</p>`;
  }
}

// Wind analogue of renderCurrentArrowsOnMap() above -- same nearest-slice-
// to-now approach, same shared arrowPane/canvas renderer (so wind symbols
// also sit above the heat map and are click-through, same trade-off already
// accepted for current arrows). Real differences from the current-field
// version: (1) gated behind windArrowsEnabled (off by default -- see that
// flag's own comment for why) rather than always rendered; (2)
// windVectorKn()/currentSpeedDir() reuse currentVectorKn()'s sibling helper
// directly -- that function only ever operates on a plain {eastKn,
// northKn} pair, nothing current-specific, so no wind-specific duplicate
// was needed; and (3) draws wind ARROWS (buildWindArrowLayer()) pointing
// TOWARD, the same direction convention as the blue current arrows -- a
// design that went through two prior iterations (a scaled-down arrow, then
// standard WMO wind barbs pointing FROM) before landing here, per the
// owner's explicit final direction. The popup/status text below still
// REPORTS wind direction as "from" a compass bearing
// (reciprocalBearingDeg()) -- that's how wind is conventionally spoken
// about by mariners ("15kn from the northwest"), independent of which way
// the arrow itself is drawn on the map.
function renderWindArrowsOnMap() {
  const infoEl = document.getElementById("wind-field-info");
  if (windArrowLayer) {
    map.removeLayer(windArrowLayer);
    windArrowLayer = null;
  }
  if (!windArrowsEnabled) {
    if (infoEl) {
      infoEl.innerHTML =
        "<p style='font-size:12px;color:#666;'>Wind arrows are off. Enable the checkbox below to draw them (experimental -- see note).</p>";
    }
    return;
  }

  const records = loadWindField();
  if (!records.length) {
    if (infoEl) {
      infoEl.innerHTML =
        "<p style='font-size:12px;color:#666;'>No wind data loaded (data/wind_field.js missing or empty — run scripts/fetch_model_data.py on a machine that can reach the SalishSeaCast ERDDAP server; this has not been done for real yet, see HANDOFF.md).</p>";
    }
    return;
  }

  const { timeKey, slice } = nearestSlice(records, selectedFieldTime);
  const previewSlice = spatiallySubsampleRecords(recordsInsideVoyageRegion(slice), 2.5);

  windArrowLayer = L.layerGroup();
  const renderer = L.canvas({ padding: 0.2, pane: "arrowPane" });
  const windArrowTuning = mapTuningEntry("wind-arrows");
  const windArrowLengthMultiplier = Math.max(0.5, Number(windArrowTuning.arrowLength ?? 100) / 100);
  const windArrowThicknessMultiplier = Math.max(1, Number(windArrowTuning.arrowThickness ?? 1));

  let drawn = 0;
  previewSlice.forEach((rec) => {
    const vec = windVectorKn(rec);
    if (!vec) return;
    const { speedKn, dirDeg } = currentSpeedDir(vec); // dirDeg = blowing TOWARD -- the arrow is drawn pointing this way, same as current arrows
    const dirFromDeg = reciprocalBearingDeg(dirDeg); // for the popup's spoken-convention text only, see this function's own comment
    const at = { lat: rec.lat, lon: rec.lon };
    const { rounded } = windFeatherCounts(speedKn);
    const popupHtml =
      `${speedKn.toFixed(2)} kn wind from ${dirFromDeg.toFixed(0)}&deg; ` +
      `(rounded to ${rounded}kn for the feather marks, 10m, ${new Date(timeKey).toLocaleString()})`;
    buildWindArrowLayer(
      at, dirDeg, speedKn, WIND_ARROW_COLOR, popupHtml, { renderer },
      windArrowThicknessMultiplier, windArrowLengthMultiplier
    ).addTo(windArrowLayer);
    drawn++;
  });
  windArrowLayer.addTo(map);

  if (infoEl) {
    infoEl.innerHTML =
      `<p style="font-size:12px;color:#666;">Showing ${drawn} points for the snapshot nearest to now: ${new Date(timeKey).toLocaleString()}. ` +
      `Gold arrows point in the direction the wind is blowing toward — the same convention as the blue current arrows. ` +
      `Feather-style marks near the tail encode speed, rounded to the nearest 5kn (triangle pennant = 50kn, long feather = 10kn, short feather = 5kn); shaft length is fixed, not proportional to speed like the current arrows. ` +
      `NOT yet applied to any leg's ETA/ground-track correction, display only. ` +
      `HRDPS forecast via SalishSeaCast ERDDAP, static pre-download — re-run the data pipeline to refresh.</p>`;
  }
}

// 2026-08-06: owner's "WEATHER tab" request -- real EC marine warning zone
// overlay. Three data sources combined here: data/marine_zones.js (hand-
// edited identity list -- siteID/name), data/marine_zone_status.js (real
// scraped Warning/Watch/Advisory status, refreshed every "Refresh data"
// run), data/marine_zone_shapes.js (real EC boundary polygons -- see that
// file's own header comment for a real open caveat: unconfirmed on an
// actual pipeline run as of this writing). A zone with no shape yet simply
// isn't drawn (not an error) -- see #marine-zones-status's own summary
// text for a count. Colours match EC's own region_e.html legend (Warning/
// Watch/Advisory/no warning or watch).
const MARINE_ZONE_COLORS = { warning: "#d32f2f", watch: "#f57c00", advisory: "#fbc02d", none: "#888888" };
const MARINE_ZONE_LABELS = { warning: "Warning", watch: "Watch", advisory: "Advisory", none: "Clear" };

function loadMarineZones() {
  const zonesData = window.MARINE_ZONES_DATA;
  if (!zonesData || !Array.isArray(zonesData.zones)) return [];
  const statuses = (window.MARINE_ZONE_STATUS_DATA && window.MARINE_ZONE_STATUS_DATA.zones) || {};
  const shapes = (window.MARINE_ZONE_SHAPES_DATA && window.MARINE_ZONE_SHAPES_DATA.zones) || {};
  const mapID = zonesData.mapID || "03";
  return zonesData.zones.map((z) => {
    const st = statuses[z.siteID];
    const sh = shapes[z.siteID];
    return {
      siteID: z.siteID,
      name: z.name,
      status: st && st.ok ? st.status : "none",
      statusText: st && st.status_text,
      statusOk: !!(st && st.ok),
      rings: sh && sh.rings && sh.rings.length ? sh.rings : null,
      // 2026-08-06, round 4: EC's own zone geometry has ONE polygon each
      // for "Strait of Georgia" and "Juan de Fuca Strait" -- the 5 named
      // sub-zones (north/south of Nanaimo, west/central/east entrance)
      // are this app's OWN geometric split of that one polygon
      // (fetch_marine_zone_shapes()'s own comment in fetch_model_data.py),
      // not a boundary EC itself drew. Surfaced here, not just in a code
      // comment, since it's real information about how much to trust the
      // shown boundary.
      approximate: !!(sh && sh.approximate),
      url: `https://weather.gc.ca/marine/forecast_e.html?mapID=${mapID}&siteID=${z.siteID}`,
    };
  });
}

function marineZonePopupHtml(zone) {
  const forecast = window.MARINE_FORECASTS_DATA &&
    window.MARINE_FORECASTS_DATA.zones &&
    window.MARINE_FORECASTS_DATA.zones[zone.siteID];
  const link = `<a href="${zone.url}" target="_blank" rel="noopener">Open Environment Canada forecast &#8599;</a>`;
  if (!forecast || !forecast.ok) {
    return `<strong>${ecTooltipText(zone.name)}</strong><br>` +
      `<div class="ec-zone-tooltip-warning">${ecTooltipText(zone.statusText || MARINE_ZONE_LABELS[zone.status] || "Status unavailable")}</div>` +
      `<em>Forecast text is unavailable in the current local snapshot.</em><br>${link}`;
  }
  const warning = forecast.warning_detail;
  const warningText = zone.statusText || (warning && warning.title) || "No warning in effect";
  const warningDetail = warning && warning.text;
  const regular = forecast.forecast && forecast.forecast.text;
  const extended = forecast.extended && forecast.extended.text;
  return `<strong>${ecTooltipText(zone.name)}</strong>` +
    `<div class="ec-zone-tooltip-warning"><strong>${ecTooltipText(warningText)}</strong>${warningDetail ? `<br>${ecTooltipText(warningDetail)}` : ""}</div>` +
    `<div><strong>Forecast:</strong> ${ecTooltipText(regular || "No forecast text available.")}</div>` +
    `<div><strong>Extended:</strong> ${ecTooltipText(extended || "No extended forecast text available.")}</div>` +
    `<small>${ecTooltipText((forecast.forecast && forecast.forecast.issued) || "")}</small><br>${link}`;
}

// 2026-08-07, owner's request: "Make EC weather zone outlines visible when
// any EC tab is open." "Open" here means the FULL chain is expanded --
// #wind-weather-details (the top-level tab) AND #environment-canada-details
// (the group) both open, AND at least one of the actual EC content
// sub-sections (#marine-synopsis-details/#marine-weather-warnings-details)
// is itself open too -- checking only the leaf sections isn't enough
// because a nested <details>'s own `open` attribute is independent of its
// ancestors' (it can stay true even while an ancestor is collapsed and
// hides it), and checking only the top/group levels isn't enough either
// since the owner could collapse Marine Synopsis specifically while leaving
// Marine Weather Warnings open (or vice versa) without wanting the whole
// group treated as closed.
function isMarineZoneSectionOpen() {
  const top = document.getElementById("wind-weather-details");
  const group = document.getElementById("environment-canada-details");
  if (!top || !top.open || !group || !group.open) return false;
  return ["marine-synopsis-details", "marine-weather-warnings-details"].some((id) => {
    const el = document.getElementById(id);
    return el && el.open;
  });
}

// Recomputes marineZoneSectionOpen from the DOM (isMarineZoneSectionOpen()
// above) and only re-renders the zone layer when that actually changes --
// wired to each relevant <details>'s own native "toggle" event below (fires
// on that element whenever ITS open/closed state changes, whether by a
// direct click or a script setting .open) plus once at startup.
function updateMarineZoneSectionOpenState() {
  const open = isMarineZoneSectionOpen();
  if (open === marineZoneSectionOpen) return;
  marineZoneSectionOpen = open;
  renderMarineZonesOnMap();
}

// 2026-08-07, owner's request: "Make the red Weather Warning maps now
// under EC warning zones on by default if any wind is on. User can turn it
// off." Called from wind-toggle/wind-stations-toggle's own change
// listeners, only when that specific toggle just switched ON.
//
// REMOVED 2026-08-07, later same day (owner's explicit reversal): "Do not
// turn Marine Warning on when I click 'Modelled winds' or 'Buoy and shore
// stations'." Both call sites below now just flip their own toggle's
// enabled flag and re-render -- marine-zones-toggle is untouched by either
// wind layer's own toggle from here on, on or off.

// 2026-08-07, owner's request: "The 'Environment Canada' title should turn
// red and flash if there is a Warning in any of the zones." Reads the same
// loadMarineZones() every other real-status consumer here does -- "a
// Warning" is read literally: real zone status === "warning" specifically
// (not "watch"/"advisory"/"none", which get no flash). Runs from the top of
// renderMarineZonesOnMap() (see that function's own call to this),
// unconditionally -- independent of marineZonesEnabled/marineZoneSectionOpen,
// so the title still flashes for a real Warning even with the map overlay
// and this whole section collapsed/off. Class-toggle only (no text change);
// see .ec-title-warning in style.css for the actual flash animation.
function updateEnvironmentCanadaWarningFlag() {
  const el = document.getElementById("environment-canada-title-text");
  if (!el) return;
  // 2026-08-07: see marineWarningTitleAcknowledged's own comment -- once
  // set, this always reads false regardless of real zone status.
  const hasWarning = !marineWarningTitleAcknowledged && loadMarineZones().some((z) => z.status === "warning");
  el.classList.toggle("ec-title-warning", hasWarning);
}

// Click opens the zone's own live EC forecast page in a new tab -- same
// "plain outbound link" pattern as the existing Map -> Wind arrows EC link
// in index.html (owner's explicit item 4: "when the zone is clicked, the
// EC page for that zone appears"), just triggered from a map shape instead
// of a sidebar link. rel="noopener" for the same reason every other
// target="_blank" link in this app uses it (the new tab can't reach back
// into this page via window.opener).
// 2026-08-07, owner's request: "Make EC weather zone outlines visible when
// any EC tab is open." showOutlinesOnly (marine-zones-toggle off, but the
// sidebar's Environment Canada group expanded -- see marineZoneSectionOpen's
// own comment) draws the same real zone shapes as a plain grey OUTLINE, no
// status-color fill, no click-through, no legend/status text -- a lighter
// "here's the zone boundary for context while you're reading" cue, distinct
// from the full colored Warning/Watch/Advisory overlay the checkbox itself
// still controls. Either condition alone is enough to draw SOMETHING;
// marineZonesEnabled (checked) always wins the full-color rendering when
// both are true at once.
function renderMarineZonesOnMap() {
  updateEnvironmentCanadaWarningFlag(); // unconditional -- see that function's own comment for why this runs even when the rest of this function early-returns below
  const statusEl = document.getElementById("marine-zones-status");
  if (marineZoneLayer) {
    map.removeLayer(marineZoneLayer);
    marineZoneLayer = null;
  }
  const showOutlinesOnly = !marineZonesEnabled && marineZoneSectionOpen;
  if (!marineZonesEnabled && !showOutlinesOnly) {
    if (statusEl) statusEl.textContent = "";
    renderMarineZoneLegend(0);
    return;
  }

  const zones = loadMarineZones();
  if (!zones.length) {
    if (statusEl) {
      statusEl.textContent = showOutlinesOnly
        ? ""
        : "No zone data loaded (data/marine_zones.js missing or empty).";
    }
    renderMarineZoneLegend(0);
    return;
  }

  marineZoneLayer = L.layerGroup();
  let drawnCount = 0;
  let forecastPeriodLabel = "forecast";
  const forecastZones = (window.MARINE_FORECASTS_DATA && window.MARINE_FORECASTS_DATA.zones) || {};
  const targetMs = (selectedFieldTime || new Date()).getTime();
  zones.forEach((z) => {
    if (!z.rings) return;
    if (showOutlinesOnly) {
      // Plain grey outline, no fill, no status color -- just "here's where
      // this zone is" while the owner reads the Marine Synopsis/Warnings
      // text, not a claim about its current Warning/Watch/Advisory status
      // (that's what the checkbox's own full overlay is for).
      const outlinePoly = L.polygon(z.rings, {
        color: MARINE_ZONE_COLORS.none,
        weight: 1,
        fill: false,
      });
      outlinePoly.bindTooltip(`<strong>${z.name}</strong>`, { sticky: true });
      const forecast = window.MARINE_FORECASTS_DATA && window.MARINE_FORECASTS_DATA.zones && window.MARINE_FORECASTS_DATA.zones[z.siteID];
      outlinePoly.on("click", (event) => showEcZoneWindGraph(z, forecast, event.latlng));
      outlinePoly.addTo(marineZoneLayer);
      drawnCount++;
      return;
    }
    const forecast = forecastZones[z.siteID];
    const bars = ecForecastBars(forecast);
    const active = bars.find((bar) => targetMs >= bar.start.getTime() && targetMs < bar.end.getTime()) ||
      bars.slice().sort((a, b) =>
        Math.abs((a.start.getTime() + a.end.getTime()) / 2 - targetMs) -
        Math.abs((b.start.getTime() + b.end.getTime()) / 2 - targetMs)
      )[0];
    const color = active ? active.color : MARINE_ZONE_COLORS.none;
    if (active) forecastPeriodLabel = String(active.label || "forecast").split(" ")[0];
    const hasWarning = !selectedFieldTime && z.status === "warning";
    // 2026-08-06, owner feedback (round 5): Clear zones get NO fill at
    // all now (owner's explicit "should not be coloured at all") -- outline
    // only, every zone, always (that part unchanged). Warning/Watch/
    // Advisory stay fully opaque (round 3's fix). MARINE_ZONE_COLORS.none
    // (grey) is now only ever used for the outline colour on a Clear zone,
    // never a fill colour.
    const poly = L.polygon(z.rings, {
      color: hasWarning ? MARINE_ZONE_COLORS.warning : "#555",
      weight: hasWarning ? 4 : 1.5,
      // 2026-08-06, later session (owner feedback): dropped the dashed
      // border for approximate zones (was `z.approximate ? "6,4" : null`)
      // -- owner's explicit call, all zone boundaries solid now. z.approximate
      // itself is untouched (still available if this needs revisiting).
      dashArray: null,
      // 2026-08-06, round 6, real Leaflet gotcha (owner report: click
      // stopped opening the EC page once Clear zones went fill:false) --
      // Leaflet/SVG only registers clicks INSIDE a shape whose fill isn't
      // literally "none"; fillOpacity: 0 stays invisible (same visual
      // result the owner asked for) while keeping fill: true, so the
      // whole zone -- not just its outline -- stays clickable regardless
      // of status.
      fill: true,
      fillColor: color,
      fillOpacity: active ? 0.7 : 0,
    });
    // 2026-08-06, later session (owner feedback, tooltips confirmed
    // working on-screen): dropped the "Approximate boundary" sentence and
    // "Click for EC's own forecast page" line from the tooltip itself --
    // owner's explicit call, extra verbosity not needed once the tooltip
    // was confirmed working. Click-through to EC's page
    // (poly.on("click", ...) below) is unchanged, just not narrated in
    // the tooltip text anymore.
    const synopsisData = window.MARINE_WEATHER_STATEMENT_DATA;
    const synopsisText = synopsisData && synopsisData.ok && synopsisData.text
      ? synopsisData.text
      : "No Marine Weather Statement is currently available in the local snapshot.";
    const warningLine = hasWarning
      ? `<div class="ec-zone-tooltip-warning">${ecTooltipText((forecast && forecast.warning_detail && forecast.warning_detail.title) || z.statusText || "Marine warning in effect")}</div>`
      : "";
    const tooltip = `<strong>${ecTooltipText(z.name)}</strong>
      <div class="ec-zone-tooltip-period">At displayed time: ${ecTooltipText(active && active.label || "No forecast period")}</div>
      <div>${ecTooltipText(active && active.text || "No forecast text available for this time.")}</div>
      ${warningLine}
      <div><strong>Marine synopsis:</strong> ${ecTooltipText(synopsisText)}</div>
      <div><strong>Forecast:</strong> ${ecTooltipText(forecast && forecast.forecast && forecast.forecast.text || "No forecast text available.")}</div>
      <div><strong>Extended forecast:</strong> ${ecTooltipText(forecast && forecast.extended && forecast.extended.text || "No extended forecast text available.")}</div>
      <div class="ec-zone-tooltip-action">Click for ${windArrowsEnabled ? "modelled wind with EC forecast colours" : "six-bar EC forecast graph"}</div>`;
    poly.bindTooltip(tooltip, { sticky: true, className: "ec-zone-forecast-tooltip" });
    poly.on("tooltipopen", () => {
      if (marineTooltipSuppressed) poly.closeTooltip();
    });
    poly.on("mouseout", () => {
      setMarineTooltipSuppressed(false);
    });
    poly.on("click", (event) => showEcZoneWindGraph(z, forecast, event.latlng));
    poly.addTo(marineZoneLayer);
    drawnCount++;
  });
  marineZoneLayer.addTo(map);

  if (showOutlinesOnly) {
    // No status/legend text in outline-only mode -- nothing here claims to
    // reflect current Warning/Watch/Advisory status, so a status summary
    // line and a color-key legend would both be misleading.
    if (statusEl) statusEl.textContent = "";
    renderMarineZoneLegend(0);
    return;
  }

  const fetchedAt = window.MARINE_ZONE_STATUS_DATA && window.MARINE_ZONE_STATUS_DATA.fetched_at;
  const missingShapes = zones.filter((z) => !z.rings).length;
  const failedStatus = zones.filter((z) => !z.statusOk).length;
  if (statusEl) {
    let msg = fetchedAt
      ? `${drawnCount}/${zones.length} zones shown, status fetched ${new Date(fetchedAt).toLocaleString()}.`
      : `${drawnCount}/${zones.length} zones shown (pipeline not yet run for this — see HANDOFF.md).`;
    if (missingShapes) msg += ` ${missingShapes} zone(s) have no boundary shape yet.`;
    if (failedStatus) msg += ` ${failedStatus} zone(s)' status fetch failed last run.`;
    statusEl.textContent = msg;
  }

  renderMarineZoneLegend(0);
  renderMarineExtendedLegend(forecastPeriodLabel, drawnCount);
}

// Self-contained toggle (removes its own prior control every call), same
// pattern as renderMapLegend() above -- but a fixed 4-row categorical key,
// not that function's continuous gradient bars, so its own small control
// rather than reusing that one. Shown whenever at least one zone is
// actually drawn (regardless of which statuses are present among them --
// a stable, always-the-same-4-rows key, matching EC's own legend, is
// simpler than rebuilding it per whichever statuses happen to be active).
function renderMarineZoneLegend(drawnCount) {
  if (!map) return;
  if (marineZoneLegendControl) {
    map.removeControl(marineZoneLegendControl);
    marineZoneLegendControl = null;
  }
  if (!drawnCount) return;

  const order = ["warning", "watch", "advisory", "none"];
  const LegendControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "marine-zone-legend");
      // 2026-08-06, round 5: Clear's swatch shows an unfilled (transparent)
      // box, not a solid grey one -- matches what a Clear zone actually
      // looks like on the map now (outline only, no fill). The swatch's
      // own CSS border (see .marine-zone-legend-swatch in style.css)
      // still shows in the zone's outline colour either way.
      div.innerHTML = order
        .map((k) => {
          const bg = k === "none" ? "transparent" : MARINE_ZONE_COLORS[k];
          return `<div class="marine-zone-legend-row"><span class="marine-zone-legend-swatch" style="background:${bg};border-color:${MARINE_ZONE_COLORS[k]};"></span>${MARINE_ZONE_LABELS[k]}</div>`;
        })
        .join("");
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  marineZoneLegendControl = new LegendControl();
  marineZoneLegendControl.addTo(map);
}

// 2026-08-06, later session (owner's request): real EC "Marine Weather
// Statement" narrative text -- fetch_marine_weather_statement() in
// fetch_model_data.py, data/marine_weather_statement.js -- shown as the
// FIRST item under the Weather tab (index.html's #marine-weather-statement,
// right below <summary>Weather</summary>). Independent of the zone-status/
// zone-shape overlay above: one fixed zone (mapID=02/siteID=07010, "Juan de
// Fuca Strait - central strait" under the South Coast region menu -- the
// owner's own linked page), not the 9-zone MARINE_ZONES loop. Real text
// picked up from the page (issued time + statement prose), not just a
// link to the URL -- owner's explicit ask.
function renderMarineWeatherStatement() {
  const el = document.getElementById("marine-weather-statement");
  if (!el) return;
  const data = window.MARINE_WEATHER_STATEMENT_DATA;
  const url = (data && data.url) || "https://weather.gc.ca/marine/forecast_e.html?mapID=02&siteID=07010";
  const title = (data && data.title) || "Juan de Fuca Strait - central strait - South Coast - Environment Canada";
  const linkHtml = `<a href="${url}" target="_blank" rel="noopener">${title} &#8599;</a>`;
  if (!data) {
    el.innerHTML = `${linkHtml}<br><em>Not yet fetched — run "Refresh data" to load the real statement text.</em>`;
  } else if (!data.ok) {
    el.innerHTML = `${linkHtml}<br><em>Last fetch failed: ${data.error || "unknown error"}.</em>`;
  } else if (!data.text) {
    el.innerHTML = `${linkHtml}<br><em>No Marine Weather Statement currently issued for this zone.</em>`;
  } else {
    el.innerHTML = `${linkHtml}<br><strong>${data.issued || "Issued"}</strong> — ${data.text}`;
  }
}

// 2026-08-06, later session (owner's request): live check for whether the
// real page's Marine Weather Statement has changed since
// data/marine_weather_statement.js was last generated -- wired to
// marine-zones-toggle's own change handler (owner's explicit choice of
// trigger, not a separate button). Goes through the local helper server's
// new POST /check-marine-statement (sailvu_helper_server.py), NOT a direct
// browser fetch() to weather.gc.ca -- same reason every other external
// source in this app is fetched server-side (see that file's own module
// docstring): a plain gov site with no CORS allow-origin header would
// silently fail a cross-origin fetch() from this file://-served page.
// Non-fatal if the helper isn't running -- degrades to "can't check right
// now" (#marine-zones-status says so), same pattern as refreshDataFiles()'s
// own helperAvailable check. Does NOT touch data/marine_weather_statement.js
// on disk -- that still only updates via a real "Refresh data" pipeline
// run; this is a read-only freshness check, not a partial refresh.
async function checkMarineWeatherStatementFreshness() {
  const warningEl = document.getElementById("marine-weather-freshness-warning");
  const statusEl = document.getElementById("marine-zones-status");
  if (!warningEl) return;
  const cached = window.MARINE_WEATHER_STATEMENT_DATA;
  try {
    const resp = await fetchWithTimeout(`${HELPER_BASE}/check-marine-statement`, {}, HELPER_HEALTH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`helper returned ${resp.status}`);
    const live = await resp.json();
    if (!live.ok) throw new Error(live.error || "live fetch failed");
    const changed = !cached || !cached.ok || (live.issued || null) !== (cached.issued || null);
    warningEl.hidden = !changed;
    if (statusEl) {
      statusEl.textContent = changed
        ? `Marine Weather Statement changed since the last "Refresh data" run (live: ${live.issued || "no statement issued"}) — re-run "Refresh data" to update.`
        : `Marine Weather Statement checked live just now — matches the current snapshot (${live.issued || "no statement issued"}).`;
    }
  } catch (err) {
    // Helper not running / not reachable / live fetch failed -- can't
    // confirm freshness either way, so leave the warning's current state
    // alone rather than guessing.
    if (statusEl) {
      statusEl.textContent = "Couldn't live-check the Marine Weather Statement (local helper server not running?).";
    }
  }
}

// 2026-08-07, later session (owner's request): "Capture the EC Forecasts,
// extended forecasts and warnings and display them" under the renamed
// "Marine Weather Forecasts and Warnings" subheading (index.html's own
// updated comment above #marine-weather-warnings-details). Unlike
// renderMarineWeatherStatement() above (one fixed zone), Forecast/Extended
// Forecast/active-warning-detail text is per-zone -- fetch_marine_forecasts()
// in fetch_model_data.py hits all 9 MARINE_ZONES pages, one each, into
// data/marine_forecasts.js (window.MARINE_FORECASTS_DATA.zones, keyed by
// siteID) -- so this needs its own zone picker
// (#marine-forecast-zone-select) rather than one fixed block. Zone NAMES
// come from loadMarineZones() (same list the map overlay above already
// uses, data/marine_zones.js) so the picker still has real zone names even
// before data/marine_forecasts.js exists yet (first run, or this session's
// scrape genuinely failing) -- degrades to per-zone "not yet fetched"/
// "fetch failed" text rather than an empty picker. Selection is read off
// the <select> itself (no separate module-level var) and preserved across
// re-renders (e.g. after "Refresh data") as long as the same zone still
// exists in the rebuilt option list.
function renderMarineForecasts() {
  const selectEl = document.getElementById("marine-forecast-zone-select");
  const statusEl = document.getElementById("marine-forecast-status");
  const textEl = document.getElementById("marine-forecast-text");
  const extEl = document.getElementById("marine-extended-forecast-text");
  const warnEl = document.getElementById("marine-forecast-warning-text");
  if (!selectEl || !statusEl || !textEl || !extEl || !warnEl) return;

  const zones = loadMarineZones();
  if (!zones.length) {
    selectEl.innerHTML = "";
    statusEl.textContent = "No zone data loaded (data/marine_zones.js missing or empty).";
    textEl.innerHTML = "";
    extEl.innerHTML = "";
    warnEl.innerHTML = "";
    return;
  }

  const prevSelection = selectEl.value;
  selectEl.innerHTML = zones.map((z) => `<option value="${z.siteID}">${z.name}</option>`).join("");
  const selectedID = zones.some((z) => z.siteID === prevSelection) ? prevSelection : zones[0].siteID;
  selectEl.value = selectedID;
  const zoneName = (zones.find((z) => z.siteID === selectedID) || {}).name || selectedID;

  const data = window.MARINE_FORECASTS_DATA;
  const zoneData = data && data.zones && data.zones[selectedID];
  const url = (zoneData && zoneData.url) || `https://weather.gc.ca/marine/forecast_e.html?mapID=03&siteID=${selectedID}`;
  const linkHtml = `<a href="${url}" target="_blank" rel="noopener">${zoneName} &#8599;</a>`;

  if (!data) {
    statusEl.innerHTML = `${linkHtml}<br><em>Not yet fetched — run "Refresh data" to load Forecast/Extended Forecast/Warning text.</em>`;
    textEl.innerHTML = "";
    extEl.innerHTML = "";
    warnEl.innerHTML = "";
    return;
  }
  if (!zoneData || !zoneData.ok) {
    statusEl.innerHTML = `${linkHtml}<br><em>Last fetch failed: ${(zoneData && zoneData.error) || "unknown error"}.</em>`;
    textEl.innerHTML = "";
    extEl.innerHTML = "";
    warnEl.innerHTML = "";
    return;
  }

  // 2026-08-07: this scrape (fetch_marine_forecasts()'s own regexes) is
  // UNVERIFIED against real raw HTML as of this edit -- surfaced here, not
  // just in code comments, so the owner sees it in the UI until a real
  // "Refresh data" run confirms it one way or the other.
  const fetchedNote = data.fetched_at ? ` — fetched ${new Date(data.fetched_at).toLocaleString()}` : "";
  statusEl.innerHTML = `${linkHtml}${fetchedNote}`;

  textEl.innerHTML = zoneData.forecast
    ? `<strong>${zoneData.forecast.issued || "Issued"}</strong> — ${zoneData.forecast.text}`
    : `<em>No Marine Forecast text captured for this zone.</em>`;

  extEl.innerHTML = zoneData.extended
    ? `<strong>${zoneData.extended.issued || "Issued"}</strong> — ${zoneData.extended.text}`
    : `<em>No Extended Forecast text captured for this zone.</em>`;

  warnEl.innerHTML = zoneData.warning_detail
    ? `<strong>${zoneData.warning_detail.title}</strong> (${zoneData.warning_detail.issued || "Issued"}) — ${zoneData.warning_detail.text}`
    : "";
}

const EC_EXTENDED_WIND_BANDS = [
  { max: 14, color: "#43a047", label: "Light / under 15 kt" },
  { max: 19, color: "#fdd835", label: "15–19 kt" },
  { max: 33, color: "#fb8c00", label: "Strong: 20–33 kt" },
  { max: Infinity, color: "#d32f2f", label: "Gale / storm: 34+ kt" },
];

function parseEcExtendedWind(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const clauses = normalized.split(/(?<=[.!;])\s+/);
  const directions = {
    north: "N", northeast: "NE", east: "E", southeast: "SE",
    south: "S", southwest: "SW", west: "W", northwest: "NW",
    northerly: "N", northeasterly: "NE", easterly: "E", southeasterly: "SE",
    southerly: "S", southwesterly: "SW", westerly: "W", northwesterly: "NW",
    variable: "VAR",
  };
  let best = null;
  clauses.forEach((clause) => {
    // EC normally writes "knots" only after the first speed in a chain:
    // "10 to 15 knots increasing to northwest 20 to 25". Extended-period
    // text contains wind only, so every numeric range here is a wind speed.
    const ranges = Array.from(clause.matchAll(/\b(\d+)(?:\s*(?:to|-)\s*(\d+))?\b/gi));
    if (!ranges.length && /\bwind\s+light\b/i.test(clause)) {
      if (!best) best = { minKn: 0, maxKn: 0, direction: "Light", text: normalized };
      return;
    }
    ranges.forEach((match) => {
      const minKn = Number(match[1]);
      const maxKn = Number(match[2] || match[1]);
      const before = clause.slice(0, match.index).toLowerCase();
      const directionMatches = Array.from(before.matchAll(/\b(northwesterly|southwesterly|northeasterly|southeasterly|northwest|southwest|northeast|southeast|northerly|southerly|easterly|westerly|north|south|east|west|variable)\b/g));
      const directionWord = directionMatches.length ? directionMatches[directionMatches.length - 1][1] : null;
      const candidate = { minKn, maxKn, direction: directionWord ? directions[directionWord] : "Wind", text: normalized };
      if (!best || candidate.maxKn > best.maxKn) best = candidate;
    });
  });
  return best;
}

function ecExtendedWindColor(maxKn) {
  if (!Number.isFinite(maxKn)) return "#888888";
  return EC_EXTENDED_WIND_BANDS.find((band) => maxKn <= band.max).color;
}

function ecExtendedWindLabel(parsed) {
  if (!parsed) return "No data";
  if (parsed.maxKn === 0) return "Light";
  const speed = parsed.minKn === parsed.maxKn ? `${parsed.maxKn}` : `${parsed.minKn}–${parsed.maxKn}`;
  return `${parsed.direction} ${speed} kt`;
}

function ecTooltipText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatEcForecastDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pointInMarineRing(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = Number(ring[i][0]), xi = Number(ring[i][1]);
    const yj = Number(ring[j][0]), xj = Number(ring[j][1]);
    const crosses = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function ecForecastBars(forecast) {
  if (!forecast) return [];
  const bars = [];
  const regularParsed = parseEcExtendedWind(forecast.forecast && forecast.forecast.text);
  if (regularParsed && forecast.regular_valid_date) {
    const dayStart = new Date(`${forecast.regular_valid_date}T00:00:00`);
    const segments = [
      { name: "Today", start: dayStart, end: new Date(dayStart.getTime() + 18 * 3600 * 1000) },
      { name: "Tonight", start: new Date(dayStart.getTime() + 18 * 3600 * 1000), end: new Date(dayStart.getTime() + 30 * 3600 * 1000) },
      { name: "Tomorrow", start: new Date(dayStart.getTime() + 30 * 3600 * 1000), end: new Date(dayStart.getTime() + 48 * 3600 * 1000) },
    ];
    segments.forEach((segment) => bars.push({
      ...segment,
      dateLabel: formatEcForecastDate(segment.start),
      maxKn: regularParsed.maxKn,
      color: ecExtendedWindColor(regularParsed.maxKn),
      label: `${segment.name} (${formatEcForecastDate(segment.start)}) ${ecExtendedWindLabel(regularParsed)}`,
      text: forecast.forecast.text,
    }));
  }
  (forecast.extended_periods || []).forEach((period) => {
    const parsed = parseEcExtendedWind(period.text);
    if (!parsed || !period.valid_date) return;
    const start = new Date(`${period.valid_date}T00:00:00`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    bars.push({
      start,
      end,
      dateLabel: formatEcForecastDate(start),
      maxKn: parsed.maxKn,
      color: ecExtendedWindColor(parsed.maxKn),
      label: `${period.name} (${formatEcForecastDate(start)}) ${ecExtendedWindLabel(parsed)}`,
      text: period.text,
      name: period.name,
    });
  });
  return bars.slice(0, 6);
}

function marineForecastBarsForPoint(lat, lon) {
  const zone = loadMarineZones().find((item) => item.rings && pointInMarineRing(lat, lon, item.rings));
  const forecast = zone && window.MARINE_FORECASTS_DATA && window.MARINE_FORECASTS_DATA.zones && window.MARINE_FORECASTS_DATA.zones[zone.siteID];
  if (!zone || !forecast) return { zone: null, bars: [] };
  const bars = ecForecastBars(forecast);
  return { zone, bars };
}

function ecForecastProgressionHtml(zoneName, periods, activeDay, issued) {
  const panels = periods.map((period) => {
    const parsed = parseEcExtendedWind(period.text);
    const maxKn = parsed && parsed.maxKn;
    const color = ecExtendedWindColor(maxKn);
    const height = Math.max(8, Math.min(70, (Number(maxKn) || 0) / 50 * 70));
    const active = period.name === activeDay ? " is-active" : "";
    return `<div class="ec-forecast-day-panel${active}" title="${String(period.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}">
      <div class="ec-forecast-bar-track"><div class="ec-forecast-bar" style="height:${height}px;background:${color};"></div></div>
      <strong>${period.name}</strong><span>${ecExtendedWindLabel(parsed)}</span>
    </div>`;
  }).join("");
  const activePeriod = periods.find((period) => period.name === activeDay);
  const safeText = String(activePeriod && activePeriod.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<strong>${zoneName}</strong><div class="ec-forecast-progression">${panels}</div><div class="ec-forecast-popup-text"><strong>${activeDay}</strong>: ${safeText}</div><small>${issued || ""}</small>`;
}

function renderMarineExtendedLegend(dayName, drawnCount) {
  if (marineExtendedLegendControl) {
    map.removeControl(marineExtendedLegendControl);
    marineExtendedLegendControl = null;
  }
  if (!drawnCount) return;
  const Legend = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "marine-zone-legend");
      div.innerHTML = `<strong>EC ${dayName || "extended forecast"}</strong>` + EC_EXTENDED_WIND_BANDS.map((band) =>
        `<div class="marine-zone-legend-row"><span class="marine-zone-legend-swatch" style="background:${band.color};border-color:${band.color};"></span>${band.label}</div>`
      ).join("");
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  marineExtendedLegendControl = new Legend();
  marineExtendedLegendControl.addTo(map);
}

function drawEcForecastBarChart(ctx, width, height, bars, markers = []) {
  const pad = { left: 38, right: 10, top: 14, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const yMax = Math.max(10, Math.ceil(Math.max(...bars.map((bar) => bar.maxKn), 0) / 10) * 10);
  ctx.strokeStyle = "#aaa";
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();
  for (let i = 0; i <= 4; i++) {
    const value = yMax * i / 4;
    const y = pad.top + plotH - value / yMax * plotH;
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(value.toFixed(0), pad.left - 4, y);
    ctx.strokeStyle = "#eee";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
  }
  const slot = plotW / Math.max(1, bars.length);
  bars.forEach((bar, index) => {
    const barWidth = Math.max(12, slot * 0.62);
    const x = pad.left + index * slot + (slot - barWidth) / 2;
    const barHeight = bar.maxKn / yMax * plotH;
    const y = pad.top + plotH - barHeight;
    ctx.fillStyle = bar.color;
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(x, y, barWidth, barHeight);
    ctx.fillStyle = "#222";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${bar.maxKn} kt`, x + barWidth / 2, Math.max(pad.top + 10, y - 2));
    ctx.textBaseline = "top";
    const shortName = bar.name || String(bar.label || "").split(" ")[0];
    ctx.fillText(shortName, x + barWidth / 2, pad.top + plotH + 4);
    ctx.fillText(bar.dateLabel || formatEcForecastDate(bar.start), x + barWidth / 2, pad.top + plotH + 16);
  });
  const timeMin = bars[0].start.getTime();
  const timeMax = bars[bars.length - 1].end.getTime();
  markers.forEach((marker) => {
    const markerMs = marker.x.getTime();
    if (markerMs < timeMin || markerMs > timeMax) {
      if (marker.now) drawNowArrow(ctx, markerMs < timeMin ? "before" : "after", pad, plotW, plotH, marker.color, marker.label);
      return;
    }
    let barIndex = bars.findIndex((bar) => markerMs >= bar.start.getTime() && markerMs < bar.end.getTime());
    if (barIndex < 0) {
      barIndex = bars.reduce((best, bar, index) =>
        Math.abs(bar.start.getTime() - markerMs) < Math.abs(bars[best].start.getTime() - markerMs) ? index : best, 0);
    }
    const markerBar = bars[barIndex];
    const fraction = Math.max(0, Math.min(1,
      (markerMs - markerBar.start.getTime()) / Math.max(1, markerBar.end.getTime() - markerBar.start.getTime())
    ));
    const px = pad.left + (barIndex + fraction) * slot;
    ctx.strokeStyle = marker.color || "#333";
    ctx.lineWidth = 1.5;
    ctx.setLineDash(marker.dashed === false ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.font = "9px sans-serif";
    ctx.fillStyle = marker.color || "#333";
    ctx.translate(px + 3, pad.top + 3);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(marker.label || "MAP", 0, 0);
    ctx.restore();
  });
  ctx.save();
  ctx.translate(11, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#666";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("kn", 0, 0);
  ctx.restore();
  return { kind: "ec-bars", bars, pad, plotW, plotH, slot };
}

function showEcOnlyForecastGraph(zone, forecast, detailHtml = marineZonePopupHtml(zone)) {
  const bars = ecForecastBars(forecast);
  openGraphPopup(
    `EC wind forecast — ${zone.name}`,
    (ctx, width, height) => {
      if (!bars.length) {
        ctx.fillStyle = "#777";
        ctx.font = "12px sans-serif";
        ctx.fillText("No EC forecast periods are available for this zone.", 12, height / 2);
        return null;
      }
      return drawEcForecastBarChart(ctx, width, height, bars, buildTimeMarkers());
    },
    "Environment Canada marine-zone forecast. Six bars comprise Today, Tonight, Tomorrow, and the three extended-forecast days. Regular-forecast bars use the strongest stated wind across EC's combined Today/Tonight/Tomorrow bulletin.",
    null,
    detailHtml
  );
}

function showEcZoneWindGraph(zone, forecast, latlng) {
  // Environment Canada is the click target, but the graph uses the richer
  // local HRDPS series whenever one exists near the click. The wind-arrow
  // display toggle controls map clutter only; it does not hide available
  // model data from this query. EC's six-period bars are the offline/small-
  // package fallback when no usable model series reaches the clicked zone.
  const detailHtml = marineZonePopupHtml(zone);
  if (!windArrowsEnabled) {
    showEcOnlyForecastGraph(zone, forecast, detailHtml);
    return;
  }
  const windRecords = loadWindField();
  if (windRecords.length) {
    const { slice } = nearestSlice(windRecords, selectedFieldTime || new Date());
    const nearest = nearestGridPoint(slice, latlng.lat, latlng.lng);
    const usableSeriesCount = nearest ? windRecords.filter((record) =>
      record.lat === nearest.record.lat && record.lon === nearest.record.lon && windVectorKn(record)
    ).length : 0;
    if (nearest && nearest.distKm <= POINT_QUERY_MAX_KM && usableSeriesCount >= 2) {
      showPointWindGraph(nearest.record.lat, nearest.record.lon, latlng, detailHtml);
      return;
    }
  }
  showEcOnlyForecastGraph(zone, forecast, detailHtml);
}

function renderMarineExtendedForecastMap() {
  if (marineExtendedMapLayer) {
    map.removeLayer(marineExtendedMapLayer);
    marineExtendedMapLayer = null;
  }
  const data = window.MARINE_FORECASTS_DATA;
  const forecastZones = (data && data.zones) || {};
  if (!marineExtendedMapEnabled || !map) {
    // The unified EC forecast layer now uses marineZoneLayer and owns this
    // same legend. Do not erase its freshly updated dated-period legend
    // merely because the superseded separate layer is disabled.
    if (!marineZonesEnabled) renderMarineExtendedLegend("", 0);
    return;
  }

  marineExtendedMapLayer = L.layerGroup();
  let drawnCount = 0;
  let activePeriodLabel = "EC forecast";
  const showCurrentWarnings = !selectedFieldTime;
  const targetMs = (selectedFieldTime || new Date()).getTime();
  loadMarineZones().forEach((zone) => {
    if (!zone.rings) return;
    const forecast = forecastZones[zone.siteID];
    const bars = ecForecastBars(forecast);
    if (!bars.length) return;
    const active = bars.find((bar) => targetMs >= bar.start.getTime() && targetMs < bar.end.getTime()) ||
      bars.slice().sort((a, b) =>
        Math.abs((a.start.getTime() + a.end.getTime()) / 2 - targetMs) -
        Math.abs((b.start.getTime() + b.end.getTime()) / 2 - targetMs)
      )[0];
    activePeriodLabel = String(active.label || "EC forecast").split(" ")[0];
    const color = active.color;
    const label = String(active.label || "").replace(/^\S+\s*/, "");
    const hasCurrentWarning = showCurrentWarnings && zone.status === "warning";
    const poly = L.polygon(zone.rings, {
      color: hasCurrentWarning ? MARINE_ZONE_COLORS.warning : "#555",
      weight: hasCurrentWarning ? 4 : 1.5,
      fill: true,
      fillColor: color,
      fillOpacity: 0.7,
    });
    const warningTitle = forecast.warning_detail && forecast.warning_detail.title;
    const warningLine = hasCurrentWarning
      ? `<div class="ec-zone-tooltip-warning">${ecTooltipText(warningTitle || zone.statusText || "Marine warning in effect")}</div>`
      : "";
    const extendedNames = new Set((forecast.extended_periods || []).map((period) => period.name));
    const issued = extendedNames.has(active.name)
      ? forecast.extended && forecast.extended.issued
      : forecast.forecast && forecast.forecast.issued;
    const synopsisData = window.MARINE_WEATHER_STATEMENT_DATA;
    const synopsisText = synopsisData && synopsisData.ok && synopsisData.text
      ? synopsisData.text
      : "No Marine Weather Statement is currently available in the local snapshot.";
    const regularText = forecast.forecast && forecast.forecast.text;
    const extendedText = forecast.extended && forecast.extended.text;
    const tooltip = `<strong>${ecTooltipText(zone.name)}</strong>
      <div class="ec-zone-tooltip-period">At displayed time: ${ecTooltipText(active.label)}</div>
      <div>${ecTooltipText(active.text)}</div>
      ${warningLine}
      <div><strong>Marine synopsis:</strong> ${ecTooltipText(synopsisText)}</div>
      <div><strong>Forecast:</strong> ${ecTooltipText(regularText || "No forecast text available.")}</div>
      <div><strong>Extended forecast:</strong> ${ecTooltipText(extendedText || "No extended forecast text available.")}</div>
      <small>${ecTooltipText(issued)}</small>
      <div class="ec-zone-tooltip-action">Click for ${windArrowsEnabled ? "modelled wind with EC forecast colours" : "six-bar EC forecast graph"}</div>`;
    poly.bindTooltip(tooltip, { sticky: true, className: "ec-zone-forecast-tooltip" });
    poly.on("tooltipopen", () => {
      if (marineTooltipSuppressed) poly.closeTooltip();
    });
    poly.on("mouseout", () => {
      setMarineTooltipSuppressed(false);
    });
    poly.on("click", (event) => showEcZoneWindGraph(zone, forecast, event.latlng));
    poly.addTo(marineExtendedMapLayer);
    const center = poly.getBounds().getCenter();
    L.marker(center, {
      interactive: false,
      icon: L.divIcon({ className: "ec-extended-zone-label", html: label, iconSize: null }),
    }).addTo(marineExtendedMapLayer);
    drawnCount++;
  });
  marineExtendedMapLayer.addTo(map);
  renderMarineExtendedLegend(activePeriodLabel, drawnCount);
}

// Builds the heat map's mesh: for each 10x10 grid cell of the structured
// SalishSeaCast grid (gridX/gridY on each record -- see loadCurrentField())
// whose all four corners have a usable velocity (currentVectorKn() non-null
// -- any masked/land corner skips the whole cell, so the mesh never invents
// current values over land), bilinearly interpolate a
// (HEATMAP_MESH_SUBDIVISIONS+1)^2 sub-grid of {lat, lon, speedKn} nodes,
// then emit one small quad polygon per sub-cell with its own averaged
// speed. Unlike the old point-cloud approach fed to Leaflet.heat, each
// quad's color (assigned in renderCurrentHeatMap()) comes directly from
// its own interpolated value -- no density summation, so neighboring quads
// shade into each other the way the underlying field actually does. Only
// feeds the heat map -- the arrow/ETA/ground-track layers deliberately
// remain strict nearest-neighbor (not navigation-grade), per the
// top-of-file note.
function buildHeatMeshQuads(slice) {
  const byGrid = new Map();
  const gxSet = new Set(), gySet = new Set();
  slice.forEach((rec) => {
    const vec = currentVectorKn(rec);
    if (!vec) return;
    const gx = Number(rec.gridX), gy = Number(rec.gridY);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    const { speedKn } = currentSpeedDir(vec);
    gxSet.add(gx);
    gySet.add(gy);
    byGrid.set(`${gx},${gy}`, { lat: rec.lat, lon: rec.lon, speedKn });
  });

  const gxSorted = [...gxSet].sort((a, b) => a - b);
  const gySorted = [...gySet].sort((a, b) => a - b);
  const quads = [];
  if (gxSorted.length < 2 || gySorted.length < 2) return quads;
  const stepX = gxSorted[1] - gxSorted[0];
  const stepY = gySorted[1] - gySorted[0];
  const n = HEATMAP_MESH_SUBDIVISIONS;

  const bilerp = (c00, c10, c01, c11, u, v, field) => {
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    return c00[field] * w00 + c10[field] * w10 + c01[field] * w01 + c11[field] * w11;
  };

  for (let i = 0; i < gxSorted.length - 1; i++) {
    const gx0 = gxSorted[i];
    const gx1 = gx0 + stepX;
    for (let j = 0; j < gySorted.length - 1; j++) {
      const gy0 = gySorted[j];
      const gy1 = gy0 + stepY;
      const c00 = byGrid.get(`${gx0},${gy0}`);
      const c10 = byGrid.get(`${gx1},${gy0}`);
      const c01 = byGrid.get(`${gx0},${gy1}`);
      const c11 = byGrid.get(`${gx1},${gy1}`);
      if (!c00 || !c10 || !c01 || !c11) continue; // any masked/land corner -- leave this cell empty

      // Build the (n+1)x(n+1) interpolated sub-grid for this cell once...
      const nodes = [];
      for (let a = 0; a <= n; a++) {
        const u = a / n;
        const row = [];
        for (let b = 0; b <= n; b++) {
          const v = b / n;
          row.push({
            lat: bilerp(c00, c10, c01, c11, u, v, "lat"),
            lon: bilerp(c00, c10, c01, c11, u, v, "lon"),
            speedKn: bilerp(c00, c10, c01, c11, u, v, "speedKn"),
          });
        }
        nodes.push(row);
      }
      // ...then emit one quad per sub-cell, corners in ring order, colored
      // by the average of its 4 corner speeds.
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const p00 = nodes[a][b], p10 = nodes[a + 1][b], p11 = nodes[a + 1][b + 1], p01 = nodes[a][b + 1];
          quads.push({
            corners: [[p00.lat, p00.lon], [p10.lat, p10.lon], [p11.lat, p11.lon], [p01.lat, p01.lon]],
            speedKn: (p00.speedKn + p10.speedKn + p11.speedKn + p01.speedKn) / 4,
          });
        }
      }
    }
  }
  return quads;
}

// 2026-08-03: wave analogue of buildHeatMeshQuads() above, same bilinear-
// interpolation approach (any masked/land corner skips the whole cell, no
// invented values over land). Structurally different input, though: the
// wave dataset has no gridX/gridY index pair (see WAVE_DATASET_ID's own
// comment in fetch_model_data.py -- lat/lon ARE the real dimensions here),
// so the (i, j) grid indices used below are derived by sorting each
// slice's own unique lat and lon values and using their array position --
// confirmed safe via a one-off node check against the owner's real
// data/wave_field.js this session: the wave grid is a fully regular
// lat x lon rectangle (45 x 48 = 2160 points, uniform ~0.0135 deg lat /
// ~0.021 deg lon step, floating-point noise only), so this index
// derivation is exact, not an approximation.
//
// WAVE_MESH_SUBDIVISIONS is lower than the current field's
// HEATMAP_MESH_SUBDIVISIONS (3 vs 8) specifically to keep the quad count
// in the same rough ballpark despite the wave grid having ~8x more valid
// cells (864 vs the current field's own "~104 valid cells" figure, per
// that constant's comment) -- confirmed via the same node check: 864
// valid cells * 3^2 = 7,776 quads, close to the current heat map's own
// ~6,700, rather than the 55,296 an unadjusted subdivisions=8 would have
// produced. Picked for browser render cost, not appearance -- a lower
// subdivision count was the deliberate choice here, not an oversight.
const WAVE_MESH_SUBDIVISIONS = 3;

function buildWaveMeshQuads(slice) {
  const latSet = new Set(), lonSet = new Set();
  slice.forEach((rec) => {
    if (rec.hs_m === undefined) return;
    latSet.add(rec.lat);
    lonSet.add(rec.lon);
  });
  const latSorted = [...latSet].sort((a, b) => a - b);
  const lonSorted = [...lonSet].sort((a, b) => a - b);
  const latIdx = new Map(latSorted.map((v, i) => [v, i]));
  const lonIdx = new Map(lonSorted.map((v, i) => [v, i]));

  const byGrid = new Map();
  slice.forEach((rec) => {
    if (rec.hs_m === undefined) return;
    const gi = lonIdx.get(rec.lon), gj = latIdx.get(rec.lat);
    byGrid.set(`${gi},${gj}`, { lat: rec.lat, lon: rec.lon, hs_m: rec.hs_m });
  });

  const quads = [];
  if (lonSorted.length < 2 || latSorted.length < 2) return quads;
  const n = WAVE_MESH_SUBDIVISIONS;

  const bilerp = (c00, c10, c01, c11, u, v, field) => {
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    return c00[field] * w00 + c10[field] * w10 + c01[field] * w01 + c11[field] * w11;
  };

  for (let i = 0; i < lonSorted.length - 1; i++) {
    for (let j = 0; j < latSorted.length - 1; j++) {
      const c00 = byGrid.get(`${i},${j}`);
      const c10 = byGrid.get(`${i + 1},${j}`);
      const c01 = byGrid.get(`${i},${j + 1}`);
      const c11 = byGrid.get(`${i + 1},${j + 1}`);
      if (!c00 || !c10 || !c01 || !c11) continue; // any masked/land corner -- leave this cell empty

      const nodes = [];
      for (let a = 0; a <= n; a++) {
        const u = a / n;
        const row = [];
        for (let b = 0; b <= n; b++) {
          const v = b / n;
          row.push({
            lat: bilerp(c00, c10, c01, c11, u, v, "lat"),
            lon: bilerp(c00, c10, c01, c11, u, v, "lon"),
            hs_m: bilerp(c00, c10, c01, c11, u, v, "hs_m"),
          });
        }
        nodes.push(row);
      }
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const p00 = nodes[a][b], p10 = nodes[a + 1][b], p11 = nodes[a + 1][b + 1], p01 = nodes[a][b + 1];
          quads.push({
            corners: [[p00.lat, p00.lon], [p10.lat, p10.lon], [p11.lat, p11.lon], [p01.lat, p01.lon]],
            hs_m: (p00.hs_m + p10.hs_m + p11.hs_m + p01.hs_m) / 4,
          });
        }
      }
    }
  }
  return quads;
}

// Optional heat-map layer over the same snapshot slice as the arrows (see
// nearestSlice()), colored by current speed. Off by default (heatMapEnabled)
// -- toggled by the sidebar checkbox. Pure Leaflet core geometry (canvas-
// rendered polygons) -- no CDN plugin, so unlike the base map tiles this
// works fully offline once the page (and its own Leaflet/app.js) has
// loaded, the same as route planning, gate warnings, and the other current
// layers.
function renderCurrentHeatMap() {
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
  // 2026-08-06: renderMapLegend() moved to the END (was the first line) --
  // real bug the owner caught, "LUT shows up, heat map does not." The LUT
  // now reads whether heatLayer actually ended up non-null (real quads
  // drawn), not just whether the checkbox is on -- e.g. "CIOPS-West only"
  // has no gridX/gridY index, so buildHeatMeshQuads() legitimately returns
  // nothing even with the checkbox checked; the old top-of-function call
  // couldn't know that yet and showed the LUT regardless.
  if (!heatMapEnabled) {
    renderMapLegend();
    return;
  }
  // 2026-08-07: loadHeatMapCurrentField(), not loadCurrentField() -- see
  // that function's own comment for the real regression this fixes (heat
  // map used to work with both Model checkboxes off, until their default
  // changed and exposed a gate the heat map was never meant to have).
  const records = loadHeatMapCurrentField();
  if (!records.length) {
    renderMapLegend();
    return;
  }

  const { slice } = nearestSlice(records, selectedFieldTime);
  const quads = buildHeatMeshQuads(structuredGridSubsample(recordsInsideVoyageRegion(slice)));
  if (!quads.length) {
    renderMapLegend();
    return;
  }

  const gradient = HEATMAP_GRADIENTS[heatMapGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  const renderer = L.canvas({ padding: 0.2 }); // one shared canvas for ~thousands of quads, not one SVG element each
  heatLayer = L.layerGroup();
  quads.forEach((q) => {
    const centerLat = q.corners.reduce((sum, point) => sum + point[0], 0) / q.corners.length;
    const centerLon = q.corners.reduce((sum, point) => sum + point[1], 0) / q.corners.length;
    if (!isMarineWater(centerLat, centerLon)) return;
    const color = colorForFraction(gradient, q.speedKn / HEATMAP_MAX_KN);
    L.polygon(q.corners, {
      renderer,
      stroke: false,
      fillColor: color,
      fillOpacity: 1,
      interactive: false, // decorative layer -- thousands of click/hover targets would only cost performance
    }).addTo(heatLayer);
  });
  heatLayer.addTo(map);
  clipRendererToMarineWater(renderer);
  renderMapLegend();
}

// Signed projection of the current vector onto the wind direction.
// Negative = opposing, positive = following, zero = cross-flow/weak current.
// Rendered at valid ocean-current points (SalishSeaCast or CIOPS-West) that
// have an HRDPS wind sample within 6 km. Anchoring at the current coordinate
// prevents land-capable HRDPS grid points from placing interaction dots over
// land. A small spatial hash avoids an all-pairs wind/current search.
function renderWindCurrentInteractionMap() {
  if (windCurrentInteractionLayer) {
    map.removeLayer(windCurrentInteractionLayer);
    windCurrentInteractionLayer = null;
  }
  if (!windCurrentInteractionEnabled) {
    renderMapLegend();
    return;
  }
  const currentRecords = loadHeatMapCurrentField();
  const windRecords = loadWindField();
  if (!currentRecords.length || !windRecords.length) {
    renderMapLegend();
    return;
  }
  const { slice: allCurrentRawSlice } = nearestSlice(currentRecords, selectedFieldTime);
  const currentRawSlice = recordsInsideVoyageRegion(allCurrentRawSlice).filter((record) =>
    windCurrentInteractionSource === "ciops"
      ? record.source === "CIOPS-West"
      : record.source !== "CIOPS-West"
  );
  const { slice: unboundedWindRawSlice } = nearestSlice(windRecords, selectedFieldTime);
  const windRawSlice = recordsInsideVoyageRegion(unboundedWindRawSlice);
  const currentSlice = spatiallySubsampleRecords(currentRawSlice, 1);
  const windSlice = spatiallySubsampleRecords(windRawSlice, 2.5);
  const cellSize = 0.05;
  const buckets = new Map();
  windSlice.forEach((rec) => {
    const wind = windVectorKn(rec);
    if (!wind) return;
    const key = `${Math.floor(rec.lat / cellSize)},${Math.floor(rec.lon / cellSize)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ rec, wind });
  });
  function nearestWind(lat, lon) {
    const row = Math.floor(lat / cellSize), col = Math.floor(lon / cellSize);
    let best = null, bestKm = Infinity;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const candidates = buckets.get(`${row + dr},${col + dc}`) || [];
      candidates.forEach((candidate) => {
        const km = haversineKm({ lat, lon }, candidate.rec);
        if (km < bestKm) { bestKm = km; best = candidate; }
      });
    }
    return best && bestKm <= 6 ? best : null;
  }

  const selectedGradient = HEATMAP_GRADIENTS[windCurrentInteractionGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  const gradient = selectedGradient.map(([f, color]) => [1 - f, color]).reverse();
  // Match Wave heights' shared-canvas dot rendering and zoom-dependent size.
  // At overview zooms the samples overlap into a field; above zoom 9 their
  // shared radius doubles per step so individual points remain prominent.
  const renderer = L.canvas({ padding: 0.2 });
  windCurrentInteractionLayer = L.layerGroup();
  let drawn = 0;
  currentSlice.forEach((currentRec) => {
    const current = currentVectorKn(currentRec);
    if (!current) return;
    const nearest = nearestWind(currentRec.lat, currentRec.lon);
    if (!nearest) return;
    const windSpeed = Math.hypot(nearest.wind.eastKn, nearest.wind.northKn);
    if (windSpeed < 0.5) return;
    const indexKn = (current.eastKn * nearest.wind.eastKn + current.northKn * nearest.wind.northKn) / windSpeed;
    const fraction = (indexKn + WIND_CURRENT_INTERACTION_MAX_KN) / (2 * WIND_CURRENT_INTERACTION_MAX_KN);
    const color = colorForFraction(gradient, fraction);
    const mapPoint = offsetMapPoint(currentRec, interactionTuningProduct(windCurrentInteractionSource));
    if (!isMarineWater(mapPoint[0], mapPoint[1])) return;
    L.circleMarker(mapPoint, {
      renderer, radius: interactionDotRadiusPx(windCurrentInteractionSource), stroke: false, fillColor: color,
      fillOpacity: 1, interactive: false,
    }).addTo(windCurrentInteractionLayer);
    drawn++;
  });
  if (drawn) {
    windCurrentInteractionLayer.addTo(map);
    smoothSeaStateRenderer(renderer, interactionDotRadiusPx(windCurrentInteractionSource), mapTuningEntry(interactionTuningProduct(windCurrentInteractionSource)).blur);
    clipRendererToMarineWater(renderer);
  }
  else windCurrentInteractionLayer = null;
  renderMapLegend();
}

// 2026-08-03: wave "map". Went through 3 versions the same session, same
// budget level, all owner-directed: (1) plain small colored dots (cheap
// first pass), (2) upgraded to a smooth bilinearly-interpolated mesh
// (buildWaveMeshQuads(), same approach as renderCurrentHeatMap()'s
// buildHeatMeshQuads()), (3) REVERTED back to dots, enlarged, after the
// owner's own screenshot showed the mesh's real cost: buildWaveMeshQuads()
// requires all 4 corners of a cell to be unmasked before drawing anything
// there, and the wave grid's ~1.5-2km native spacing is coarser than many
// of the Gulf Islands channels are wide -- so most channel-adjacent cells
// have at least one land-masked corner and get dropped entirely, losing
// exactly the narrow-channel data the owner most wants to see (open Strait
// water, with its dense fully-unmasked interior, looked fine; the channels
// did not). Per-point dots have no such requirement -- every point with a
// real hs_m value draws on its own, channels included -- at the cost of
// visible gaps between points rather than a seamless gradient. The shared
// radius scales via seaStateDotRadiusPx() above zoom 9. buildWaveMeshQuads()
// is left in place, unused, rather than deleted -- see the backlog for a
// possible future partial-corner/IDW variant that wouldn't have this
// failure mode, if that's ever worth the effort.
function renderWaveMap() {
  if (waveMapLayer) {
    map.removeLayer(waveMapLayer);
    waveMapLayer = null;
  }
  // 2026-08-06: renderMapLegend() moved to the end -- see
  // renderCurrentHeatMap()'s own comment for why (LUT must reflect what
  // actually rendered, not just the checkbox).
  if (!waveMapEnabled) {
    renderMapLegend();
    return;
  }
  const records = loadWaveField();
  if (!records.length) {
    renderMapLegend();
    return;
  }

  const { slice: rawSlice } = nearestSlice(records, selectedFieldTime);
  const slice = spatiallySubsampleRecords(recordsInsideVoyageRegion(rawSlice), 1.5);
  const gradient = HEATMAP_GRADIENTS[waveMapGradientKey] || HEATMAP_GRADIENTS[HEATMAP_GRADIENT_DEFAULT];
  const renderer = L.canvas({ padding: 0.2 }); // one shared canvas, same reasoning as renderCurrentHeatMap()
  waveMapLayer = L.layerGroup();
  slice.forEach((r) => {
    if (r.hs_m === undefined) return;
    const color = colorForFraction(gradient, r.hs_m / WAVE_HEATMAP_MAX_M);
    const mapPoint = offsetMapPoint(r, "waves");
    if (!isMarineWater(mapPoint[0], mapPoint[1])) return;
    L.circleMarker(mapPoint, {
      renderer,
      radius: mapTuningRadiusPx("waves"),
      stroke: false,
      fillColor: color,
      fillOpacity: 1,
      interactive: false, // decorative layer
    }).addTo(waveMapLayer);
  });
  waveMapLayer.addTo(map);
  smoothSeaStateRenderer(renderer, mapTuningRadiusPx("waves"), mapTuningEntry("waves").blur);
  clipRendererToMarineWater(renderer);
  renderMapLegend();
}

function undoLast() {
  waypoints.pop();
  redraw();
}

// 2026-08-05: no longer reachable from the UI -- its "Clear route" button
// was removed at the owner's request (see the DOMContentLoaded handler's
// own comment) with no replacement control or shortcut added, just the
// existing shift+click-to-add/Backspace-to-undo-last gestures called out
// in a hint line instead. Left defined rather than deleted -- cheap to
// keep, and the obvious thing to wire up again if the owner asks for a
// "clear everything" control back (a button, a keyboard shortcut,
// whatever) later.
function clearRoute() {
  waypoints = [];
  redraw();
}

// Base URL for the optional local helper server (scripts/sailvu_helper_
// server.py, started by scripts/start_sailvu.bat) that lets "Refresh data"
// actually re-run the pipeline. Loopback-only by the server's own design
// (see that file's docstring) -- this is never reachable off this machine.
const HELPER_BASE = "http://127.0.0.1:8765";
const HELPER_HEALTH_TIMEOUT_MS = 2000;

// Plain fetch() to a helper server that isn't running doesn't fail fast --
// it hangs until the browser's own (long) connection-refused/timeout
// handling kicks in. AbortController forces a fast, deliberate "not
// running" signal instead, so refreshDataFiles() can degrade gracefully
// without a multi-second stall on the common case (helper not started).
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

function setUpdateStatus(message, isError = false) {
  const element = document.getElementById("update-status");
  if (!element) return;
  element.textContent = message;
  element.style.color = isError ? "#a40000" : "";
}

async function checkSailvuUpdate() {
  const install = document.getElementById("update-install-btn");
  setUpdateStatus("Checking the approved update channel…");
  if (install) install.hidden = true;
  try {
    const response = await fetchWithTimeout(`${HELPER_BASE}/check-update`, {}, 30000);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (!result.configured) return setUpdateStatus("The updater is installed, but its public release channel has not been configured yet.");
    if (!result.available) return setUpdateStatus(`SailVu ${result.version || "current"} is already installed.`);
    const size = result.bytes ? `, ${(result.bytes / 1048576).toFixed(1)} MB` : "";
    setUpdateStatus(`SailVu ${result.version} is available (${result.files} changed file(s)${size}). ${result.notes || ""}`);
    if (install) install.hidden = false;
  } catch (error) {
    setUpdateStatus(`Could not check for updates: ${error.message}. Start SailVu with its launcher and check the internet connection.`, true);
  }
}

async function installSailvuUpdate() {
  if (!window.confirm("Install the checked SailVu update now? Do this while tied up, not while navigating. SailVu must be restarted afterward.")) return;
  setUpdateStatus("Downloading and verifying changed files…");
  try {
    const response = await fetch(`${HELPER_BASE}/install-update`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setUpdateStatus(`Installed SailVu ${result.version} (${result.files} file(s)). Close and restart SailVu. A rollback copy was saved.`);
    document.getElementById("update-install-btn").hidden = true;
    document.getElementById("update-rollback-btn").hidden = false;
  } catch (error) { setUpdateStatus(`Update was not installed: ${error.message}`, true); }
}

async function stageLocalSailvuUpdate() {
  const file = document.getElementById("local-update-file")?.files?.[0];
  if (!file) return setUpdateStatus("Choose a SailVu patch ZIP first.", true);
  if (file.size > 100 * 1024 * 1024) return setUpdateStatus("Patch ZIP is larger than 100 MB.", true);
  setUpdateStatus("Verifying the selected patch package…");
  try {
    const response = await fetch(`${HELPER_BASE}/stage-local-update`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const size = result.bytes ? `, ${(result.bytes / 1048576).toFixed(1)} MB` : "";
    setUpdateStatus(`Verified SailVu ${result.version} (${result.files} changed file(s)${size}). ${result.notes || ""}`);
    document.getElementById("update-install-btn").hidden = false;
  } catch (error) { setUpdateStatus(`Patch was rejected: ${error.message}`, true); }
}

async function rollbackSailvuUpdate() {
  if (!window.confirm("Restore the files from before the last SailVu update? SailVu must be restarted afterward.")) return;
  setUpdateStatus("Restoring the previous SailVu version…");
  try {
    const response = await fetch(`${HELPER_BASE}/rollback-update`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setUpdateStatus(`Restored SailVu ${result.version}. Close and restart SailVu.`);
  } catch (error) { setUpdateStatus(`Could not roll back: ${error.message}`, true); }
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Could not read screenshot"));
    reader.readAsDataURL(file);
  });
}

async function createSailvuFeedback() {
  const status = document.getElementById("feedback-status");
  const screenshot = document.getElementById("feedback-screenshot")?.files?.[0];
  if (screenshot && screenshot.size > 5 * 1024 * 1024) {
    status.textContent = "Screenshot is larger than 5 MB; choose a smaller image."; return;
  }
  status.textContent = "Preparing a private feedback ZIP…";
  try {
    const payload = {
      notes: document.getElementById("feedback-notes")?.value || "",
      app: { schema: "sailvu.feedback.v1", version: SAILVU_VERSION, createdAt: new Date().toISOString() },
      browser: { userAgent: navigator.userAgent, online: navigator.onLine, language: navigator.language, viewport: `${innerWidth}x${innerHeight}` },
      connection: { state: signalKConnectionState, server: signalKServerBase, lastMessageAt: signalKLastMessageAt, reconnectCount: signalKReconnectCount },
      pathsSeen: [...signalKSeenPaths].sort(), instrumentSources: vesselValueSources,
      instrumentTimestamps: vesselValueTimes, instrumentReceivedTimes: vesselValueReceivedTimes,
      latestInstrumentValues: vesselValues,
      sampling: { underwaySogKn: VESSEL_UNDERWAY_SOG_KN, underwayIntervalSeconds: VESSEL_UNDERWAY_SAMPLE_MS / 1000, stationaryIntervalMinutes: VESSEL_STATIONARY_SAMPLE_MS / 60000 },
      storage: { voyageRecordsToday: vesselTrack.length, dayKey: loadedVesselTrackKey },
      recentVoyageRecords: document.getElementById("feedback-voyage-toggle")?.checked ? vesselTrack.slice(-100) : [],
    };
    if (screenshot) payload.screenshot = { name: screenshot.name, data: await fileAsBase64(screenshot) };
    const response = await fetch(`${HELPER_BASE}/create-feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const a = document.createElement("a");
    a.href = `${HELPER_BASE}/download-feedback?name=${encodeURIComponent(result.filename)}`; a.download = result.filename; a.click();
    status.textContent = `Downloaded ${result.filename}. It excludes Signal K tokens and browser storage; email or copy this ZIP to Gary or Chris.`;
  } catch (error) { status.textContent = `Could not create feedback bundle: ${error.message}. Start SailVu with its launcher.`; }
}

async function initializeUpdatesAndFeedback() {
  const versionEl = document.getElementById("sailvu-version");
  if (versionEl) versionEl.textContent = SAILVU_VERSION;
  document.documentElement.dataset.sailvuVersion = SAILVU_VERSION;
  document.getElementById("update-check-btn")?.addEventListener("click", checkSailvuUpdate);
  document.getElementById("update-install-btn")?.addEventListener("click", installSailvuUpdate);
  document.getElementById("local-update-stage-btn")?.addEventListener("click", stageLocalSailvuUpdate);
  document.getElementById("update-rollback-btn")?.addEventListener("click", rollbackSailvuUpdate);
  document.getElementById("feedback-create-btn")?.addEventListener("click", createSailvuFeedback);
  try {
    const response = await fetchWithTimeout(`${HELPER_BASE}/health`, {}, HELPER_HEALTH_TIMEOUT_MS);
    const health = await response.json();
    const rollback = document.getElementById("update-rollback-btn");
    if (rollback) rollback.hidden = !health.updates?.rollbackAvailable;
  } catch (_) { /* The explicit buttons explain how to start the helper. */ }
}

// Re-injects a data <script> tag with a cache-busting query string so a
// freshly re-run pipeline's output is actually re-fetched, not served from
// whatever the browser cached under the plain file:// path. Returns a
// promise resolving once the new script has executed (so window.X_DATA is
// guaranteed set before the caller re-renders anything). Removes any
// previous copy of the same tag first so repeated refreshes don't pile up
// duplicate <script> elements.
// optional (added 2026-08-02 for data/wind_field.js): if true, a failed load
// (e.g. a 404 because the pipeline has never actually written this file --
// the real, expected state until a live run generates it for the first time,
// see HANDOFF.md) resolves instead of rejecting, so one missing optional
// file doesn't fail the whole Promise.all() in refreshDataFiles() and abort
// reloading the other, already-working data files. The four pre-existing
// callers (gate/tide predictions, current field, gate current curve) don't
// pass this and keep their original reject-on-error behavior -- those files
// are expected to always exist.
function reloadScript(src, optional) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-refresh-src="${src}"]`);
    if (existing) existing.remove();
    const s = document.createElement("script");
    s.src = `${src}?t=${Date.now()}`;
    s.dataset.refreshSrc = src;
    s.onload = () => resolve();
    s.onerror = () => {
      if (optional) {
        console.warn(`${src} not found/failed to load -- treated as optional, continuing.`);
        resolve();
      } else {
        reject(new Error(`Failed to load ${src}`));
      }
    };
    document.body.appendChild(s);
  });
}

// "Refresh data" button handler. First checks whether the local helper
// server (scripts/sailvu_helper_server.py, started by
// scripts/start_sailvu.bat) is running; if so, asks it to actually re-run
// fetch_model_data.py and waits for that to finish. Either way, it then
// re-fetches the pipeline-generated data files (NOT gate_stations.js or
// tide_stations.js, which are static/hand-edited) and re-renders everything
// that depends on them -- deliberately NOT location.reload(), so the
// route/waypoints already on the map aren't lost. Re-runs loadGateStations()
// too, since gate station popups/warnings now include a SalishSeaCast model
// sample (see gateStationModelHtml()) that should reflect the
// newly-refreshed snapshot, not the one from page load. Same reasoning for
// loadTideStations().
// 2026-08-03: three-state visual treatment for the "Refresh data" button,
// per the owner's request -- previously a plain button gave no at-a-glance
// sense of whether a refresh was running or had just finished, only the
// small adjacent text status said so. "idle" (red, flashing) is the resting
// state, inviting a click; "working" (yellow, flashing) while
// refreshDataFiles() is actually running; "done" (solid green, no
// animation) once it completes -- including when the underlying pipeline
// only partially succeeded (e.g. one track failed but the others' files
// still reloaded), since the refresh OPERATION itself did complete; the
// adjacent #refresh-status text still carries that partial-failure detail.
// Only a genuine exception (couldn't reload files at all) goes back to
// "idle" rather than "done" -- see refreshDataFiles()'s catch block.
function setRefreshButtonState(state) {
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;
  btn.classList.remove("refresh-state-idle", "refresh-state-working", "refresh-state-done");
  if (state === "working") {
    btn.classList.add("refresh-state-working");
    btn.textContent = "Downloading";
  } else if (state === "done") {
    btn.classList.add("refresh-state-done");
    btn.textContent = "Current";
  } else if (state === "failed") {
    btn.classList.add("refresh-state-idle");
    btn.textContent = "Failed";
  } else {
    btn.classList.add("refresh-state-idle");
    btn.textContent = "Refresh";
  }
}

// 2026-08-04: polling interval for GET /progress while /run-pipeline is in
// flight (see sailvu_helper_server.py's module docstring for why this is a
// separate poll rather than the POST response itself streaming progress).
// 1.5s: frequent enough to feel live against a multi-minute wind fetch,
// not so frequent it's spamming a plain-stdlib HTTP server with no real
// concurrency needs here.
const PROGRESS_POLL_MS = 1500;
const REFRESH_TIMINGS_KEY = "sailvu.refreshTimings.v1";
const AUTO_REFRESH_KEY = "sailvu.autoRefresh.v1";
const DOWNLOAD_PLAN_KEY = "sailvu.downloadPlan.v1";
const DOWNLOAD_TESTS_KEY = "sailvu.downloadTests.v1";
const DOWNLOAD_PRODUCT_MB_72H = { currents: 80, wind: 120, waves: 55, tides: 2, ec: 0.2 };
const DOWNLOAD_FULL_REGION_DEG2 = (50.9 - 48.4) * (-122.9 - -127.7);
const VOYAGE_REGION_BOUNDS = { lat_min: 48.4, lat_max: 50.42, lon_min: -125.55, lon_max: -122.75 };
let adminModeEnabled = false;
let autoRefreshTimer = null;
let refreshAbortController = null;

async function stopDataRefresh() {
  const status = document.getElementById("refresh-status");
  if (status) status.textContent = "Stopping download…";
  try { await fetch(`${HELPER_BASE}/stop-pipeline`, { method: "POST" }); } catch (_) {}
  refreshAbortController?.abort();
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadAutoRefreshSettings() {
  try {
    return { enabled: true, time: "04:00", lastSuccessfulDate: "", nextRetryAt: 0, failureCount: 0, ...JSON.parse(localStorage.getItem(AUTO_REFRESH_KEY) || "{}") };
  } catch (_) {
    return { enabled: true, time: "04:00", lastSuccessfulDate: "", nextRetryAt: 0, failureCount: 0 };
  }
}

function vesselGeoJSON(records, key) {
  const day = String(key || vesselDayKey()).split(".").pop();
  return { type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: `SAILVu vessel track ${day}`, records: records.length }, geometry: { type: "LineString", coordinates: records.map((p) => [p.lon, p.lat]) } },
    ...records.map(({ lat, lon, ...properties }) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } })),
  ] };
}

function saveDailyVesselGeoJSON(key, records) {
  try { localStorage.setItem(`sailvu.dailyGeoJSON.${String(key).split(".").pop()}`, JSON.stringify(vesselGeoJSON(records, key))); } catch (_) {}
}

function saveAutoRefreshSettings(settings) {
  localStorage.setItem(AUTO_REFRESH_KEY, JSON.stringify(settings));
}

function renderAutoRefreshStatus(message = "") {
  const status = document.getElementById("auto-refresh-status");
  if (!status) return;
  const settings = loadAutoRefreshSettings();
  if (message) {
    status.textContent = message;
  } else if (settings.enabled) {
    status.textContent = `Next automatic refresh: ${settings.time} local time (small Cellular Minimum package). Failed downloads retry every 30 minutes.`;
  } else {
    status.textContent = "Automatic refresh is off.";
  }
}

async function checkAutomaticRefresh() {
  const settings = loadAutoRefreshSettings();
  if (!settings.enabled || dataRefreshInProgress) return;
  const now = new Date();
  const today = localDateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (currentTime < settings.time || settings.lastSuccessfulDate === today || Date.now() < Number(settings.nextRetryAt || 0)) return;
  renderAutoRefreshStatus(`Automatic cellular refresh started at ${now.toLocaleTimeString()}.`);
  const succeeded = await refreshDataFiles({ scheduled: true, forceMode: "cellular" });
  const updated = loadAutoRefreshSettings();
  if (succeeded) {
    updated.lastSuccessfulDate = today; updated.nextRetryAt = 0; updated.failureCount = 0;
    renderAutoRefreshStatus(`Automatic cellular refresh succeeded ${new Date().toLocaleString()}; next run is tomorrow at ${updated.time}.`);
  } else {
    updated.failureCount = Number(updated.failureCount || 0) + 1;
    updated.nextRetryAt = Date.now() + 30 * 60 * 1000;
    renderAutoRefreshStatus(`Cellular refresh could not reach the data service. Existing data are safe; retry ${new Date(updated.nextRetryAt).toLocaleTimeString()}.`);
  }
  saveAutoRefreshSettings(updated);
}

function initializeAutomaticRefresh() {
  const toggle = document.getElementById("auto-refresh-toggle");
  const time = document.getElementById("auto-refresh-time");
  if (!toggle || !time) return;
  const settings = loadAutoRefreshSettings();
  toggle.checked = settings.enabled;
  time.value = settings.time;
  time.disabled = !settings.enabled;
  const persist = () => {
    const updated = loadAutoRefreshSettings();
    updated.enabled = toggle.checked;
    updated.time = time.value || "04:00";
    saveAutoRefreshSettings(updated);
    time.disabled = !updated.enabled;
    renderAutoRefreshStatus();
    renderDataReadiness();
    checkAutomaticRefresh();
  };
  toggle.addEventListener("change", persist);
  time.addEventListener("change", persist);
  window.addEventListener("online", () => { renderDataReadiness(); checkAutomaticRefresh(); });
  window.addEventListener("offline", renderDataReadiness);
  renderAutoRefreshStatus();
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(checkAutomaticRefresh, 30000);
  checkAutomaticRefresh();
}

function renderAdminMode() {
  document.querySelectorAll(".admin-only").forEach((element) => {
    if (element.id === "voyage-region-controls") {
      element.hidden = !adminModeEnabled || document.getElementById("refresh-mode-select")?.value !== "voyage";
    } else {
      element.hidden = !adminModeEnabled;
    }
  });
  const button = document.getElementById("admin-toggle-btn");
  if (button) button.textContent = adminModeEnabled ? "Close Admin" : "Admin";
}

function activeVoyageRegionBounds() {
  return document.getElementById("refresh-mode-select")?.value === "voyage"
    ? (areaOfOperations || VOYAGE_REGION_BOUNDS)
    : null;
}

function recordsInsideVoyageRegion(records) {
  const bounds = activeVoyageRegionBounds();
  if (!bounds) return records;
  return records.filter((record) =>
    Number(record.lat) >= bounds.lat_min && Number(record.lat) <= bounds.lat_max &&
    Number(record.lon) >= bounds.lon_min && Number(record.lon) <= bounds.lon_max
  );
}

function refreshVoyageRegionDisplay() {
  renderCurrentArrowsOnMap();
  renderCurrentHeatMap();
  renderWindArrowsOnMap();
  renderWaveMap();
  renderWindCurrentInteractionMap();
}

function selectedDownloadProducts() {
  return Array.from(document.querySelectorAll("[data-download-product]"))
    .filter((input) => input.checked)
    .map((input) => input.dataset.downloadProduct);
}

function selectedDownloadHours() {
  return Number(document.querySelector("[data-download-hours]:checked")?.dataset.downloadHours || 48);
}

function downloadCoverageBounds(coverage) {
  if (coverage === "aoi") return areaOfOperations;
  if (coverage === "voyage") return { ...(areaOfOperations || VOYAGE_REGION_BOUNDS) };
  if (coverage === "view" && map) {
    const bounds = map.getBounds();
    return { lat_min: bounds.getSouth(), lat_max: bounds.getNorth(), lon_min: bounds.getWest(), lon_max: bounds.getEast() };
  }
  return null;
}

function currentDownloadPlan() {
  const mode = document.getElementById("refresh-mode-select")?.value || "full";
  const coverage = mode === "navigation" ? "view" : mode === "voyage" ? "voyage" : "full";
  const hours = selectedDownloadHours();
  const resolution = 3;
  return { mode, coverage, bounds: downloadCoverageBounds(coverage), hours, resolution, products: selectedDownloadProducts(), currentSource: "auto" };
}

function productDownloadEstimate(plan, product, hours) {
  if (plan.mode === "cellular" && product !== "ec") return { low: 0, high: 0, seconds: 0 };
  return estimateDownloadPlan({ ...plan, hours, products: [product] });
}

function formatDownloadCell(estimate) {
  return `~${formatDownloadMb((estimate.low + estimate.high) / 2)}`;
}

function estimateDownloadPlan(plan) {
  if (plan.mode === "cellular") return { low: 0.1, high: 0.4, seconds: 2 };
  let areaFraction = 1;
  if (plan.coverage !== "full" && plan.bounds) {
    const area = Math.max(0, plan.bounds.lat_max - plan.bounds.lat_min) * Math.max(0, plan.bounds.lon_max - plan.bounds.lon_min);
    areaFraction = Math.max(0.03, Math.min(1, area * 1.4 / DOWNLOAD_FULL_REGION_DEG2));
  }
  const resolutionFactor = [1 / 64, 1 / 16, 1 / 4, 1][plan.resolution] || 1;
  const timeFactor = Math.max(24, plan.hours) / 72;
  const mb = plan.products.reduce((sum, product) => {
    const base = DOWNLOAD_PRODUCT_MB_72H[product] || 0;
    if (product === "ec") return sum + base;
    if (product === "tides") return sum + base * timeFactor;
    return sum + base * areaFraction * resolutionFactor * timeFactor;
  }, 0);
  const throughputMbS = plan.mode === "full" || plan.mode === "voyage" ? 6 : 0.35;
  return { low: Math.max(0.1, mb * 0.8), high: Math.max(0.2, mb * 1.25), seconds: mb / throughputMbS };
}

function formatDownloadMb(value) {
  return value < 1 ? `${Math.round(value * 1000)} KB` : `${value.toFixed(value < 10 ? 1 : 0)} MB`;
}

function loadDownloadTests() {
  try { return JSON.parse(localStorage.getItem(DOWNLOAD_TESTS_KEY) || "[]") || []; }
  catch (err) { return []; }
}

function recordDownloadTest(plan, elapsedSeconds, metrics, success) {
  const measured = aoiMeasurements(plan.bounds);
  const tests = loadDownloadTests();
  tests.unshift({
    completedAt: new Date().toISOString(),
    mode: plan.mode,
    coverage: plan.coverage,
    areaKm2: measured && measured.areaKm2,
    hours: plan.hours,
    resolution: plan.resolution,
    products: plan.products,
    downloadBytes: metrics && Number(metrics.download_bytes),
    elapsedSeconds,
    success,
  });
  try { localStorage.setItem(DOWNLOAD_TESTS_KEY, JSON.stringify(tests.slice(0, 12))); } catch (err) { /* optional */ }
  renderDownloadTestResults();
}

function renderDownloadTestResults() {
  const el = document.getElementById("download-test-results");
  if (!el) return;
  const tests = loadDownloadTests();
  if (!tests.length) {
    el.innerHTML = "<strong>Test results</strong><br>No measured refreshes yet.";
    return;
  }
  const rows = tests.slice(0, 6).map((test) => {
    const area = Number.isFinite(test.areaKm2) ? `${Math.round(test.areaKm2).toLocaleString()} km²` : test.coverage;
    const bytes = Number.isFinite(test.downloadBytes) ? formatDownloadMb(test.downloadBytes / (1024 * 1024)) : "not reported";
    return `<tr><td>${area}</td><td>${test.hours}h / ${SPATIAL_PREVIEW_LABELS[test.resolution] || "—"}</td>` +
      `<td>${bytes}</td><td>${formatRefreshDuration(test.elapsedSeconds)}${test.success ? "" : " (failed)"}</td></tr>`;
  }).join("");
  el.innerHTML = `<strong>Recent measured refreshes</strong><table><thead><tr><th>Area</th><th>Plan</th><th>Downloaded</th><th>Elapsed</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function applyDownloadPreset(mode) {
  const presets = {
    cellular: { hours: 24, products: ["ec"] },
    navigation: { hours: 48, products: ["currents", "wind", "waves", "tides", "ec"] },
    voyage: { hours: 72, products: ["currents", "wind", "waves", "tides", "ec"] },
    full: { hours: 72, products: ["currents", "wind", "waves", "tides", "ec"] },
  };
  const preset = presets[mode] || presets.full;
  const hours = document.querySelector(`[data-download-hours="${preset.hours}"]`);
  if (hours) hours.checked = true;
  document.querySelectorAll("[data-download-product]").forEach((input) => {
    input.checked = preset.products.includes(input.dataset.downloadProduct);
  });
  renderDownloadPlanner();
  if (map) renderSpatialPreviewLayers();
}

function restoreDownloadPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(DOWNLOAD_PLAN_KEY) || "null");
    if (!saved || !["cellular", "navigation", "voyage", "full"].includes(saved.mode)) return false;
    if (saved.mode === "navigation") saved.mode = "voyage";
    const mode = document.getElementById("refresh-mode-select");
    if (mode) mode.value = saved.mode;
    const savedHours = [24, 48, 72].includes(Number(saved.hours)) ? Number(saved.hours) : 48;
    const hours = document.querySelector(`[data-download-hours="${savedHours}"]`);
    if (hours) hours.checked = true;
    // `bounds` in a Navigation plan is the transient current map viewport,
    // recomputed whenever the planner renders. Older code restored ANY
    // saved bounds as a hand-drawn AOI, producing the red rectangle that
    // changed size to match the viewport on every reload. Only restore the
    // dedicated AOI field (or a genuinely old coverage:"aoi" plan).
    const savedAoi = saved.aoiBounds || (saved.coverage === "aoi" ? saved.bounds : null);
    if (savedAoi && ["lat_min", "lat_max", "lon_min", "lon_max"].every((key) => Number.isFinite(Number(savedAoi[key])))) {
      areaOfOperations = {
        lat_min: Number(savedAoi.lat_min), lat_max: Number(savedAoi.lat_max),
        lon_min: Number(savedAoi.lon_min), lon_max: Number(savedAoi.lon_max),
      };
      renderAoiInfo();
    } else {
      areaOfOperations = null;
    }
    syncAoiRectangleVisibility();
    document.querySelectorAll("[data-download-product]").forEach((input) => {
      input.checked = Array.isArray(saved.products) && saved.products.includes(input.dataset.downloadProduct);
    });
    renderDownloadPlanner();
    if (map) renderSpatialPreviewLayers();
    return true;
  } catch (err) {
    return false;
  }
}

function renderDownloadPlanner() {
  const estimateEl = document.getElementById("download-estimate");
  if (!estimateEl) return;
  const plan = currentDownloadPlan();
  const voyageControls = document.getElementById("voyage-region-controls");
  const voyageInfo = document.getElementById("voyage-region-info");
  if (voyageControls) voyageControls.hidden = plan.mode !== "voyage" || !adminModeEnabled;
  if (voyageInfo && plan.mode === "voyage") {
    voyageInfo.textContent = areaOfOperations ? "Custom box selected" : "Default: through north Quadra";
  }
  const estimate = estimateDownloadPlan(plan);
  const cellular = plan.mode === "cellular";
  document.querySelectorAll("[data-download-product]").forEach((input) => { input.disabled = cellular; });
  document.querySelectorAll("[data-download-hours]").forEach((input) => { input.disabled = cellular; });
  const measured = aoiMeasurements(plan.bounds);
  [24, 48, 72].forEach((hours) => {
    Object.keys(DOWNLOAD_PRODUCT_LABELS).forEach((product) => {
      const cell = document.querySelector(`[data-download-cell="${product}:${hours}"]`);
      if (cell) cell.textContent = formatDownloadCell(productDownloadEstimate(plan, product, hours));
    });
    const totalCell = document.querySelector(`[data-download-total="${hours}"]`);
    if (totalCell) totalCell.textContent = formatDownloadCell(estimateDownloadPlan({ ...plan, hours }));
  });
  const areaLine = measured ? `${Math.round(measured.areaKm2).toLocaleString()} km² current map view · ` : "";
  estimateEl.innerHTML = `${areaLine}<strong>${formatDownloadCell(estimate)}</strong> selected · native resolution`;
  // Persist user choices and a real hand-drawn AOI, never the transient
  // current-view bounds. The latter is recalculated from map.getBounds()
  // whenever the plan is used.
  const savedPlan = { ...plan, bounds: null, aoiBounds: areaOfOperations };
  try { localStorage.setItem(DOWNLOAD_PLAN_KEY, JSON.stringify(savedPlan)); } catch (err) { /* optional persistence */ }
  renderDownloadTestResults();
  renderDownloadProductProgress();
}

function formatRefreshDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function refreshModeLabel(mode) {
  return mode === "cellular" ? "Cellular Minimum" : mode === "navigation" ? "Cellular Current View" : mode === "voyage" ? "Voyage Region" : "Shore Wi-Fi Full Region";
}

function loadRefreshTimings() {
  try {
    return JSON.parse(localStorage.getItem(REFRESH_TIMINGS_KEY) || "{}") || {};
  } catch (err) {
    return {};
  }
}

function showLastRefreshTiming(mode) {
  const timerEl = document.getElementById("refresh-timer");
  if (!timerEl || dataRefreshInProgress) return;
  const saved = loadRefreshTimings()[mode];
  const label = refreshModeLabel(mode);
  timerEl.textContent = saved
    ? `Last ${label}: ${formatRefreshDuration(saved.seconds)} (${new Date(saved.completedAt).toLocaleString()})`
    : `No ${label} refresh time recorded yet.`;
}

// Formats one GET /progress response into the short status-line text
// shown next to the Refresh button. Stage names match write_progress()'s
// call sites in fetch_model_data.py's main() exactly (string literals on
// both ends, no shared enum -- small, stable list, not worth the
// indirection of keeping it in sync a fancier way).
function formatPipelineProgress(progress) {
  if (!progress || !progress.stage || progress.stage === "idle" || progress.stage === "starting") {
    return "Running pipeline…";
  }
  if (progress.stage === "wind" && progress.done && progress.total) {
    return `Running pipeline — fetching wind: hour ${progress.done} of ${progress.total}…`;
  }
  const stageLabels = {
    currents: "fetching currents",
    wind: "fetching wind",
    waves: "fetching waves",
    gate: "fetching gate predictions",
    tide: "fetching tide predictions",
    curve: "fetching gate current curves",
    wind_obs: "fetching real wind observations",
    verification: "logging wind verification pairs",
    marine_forecasts: "fetching EC marine forecasts",
    fallback_essential: "full package failed; preparing ESSENTIAL fallback",
    fallback_briefing: "ESSENTIAL failed; preparing EC BRIEFING fallback",
    done: "finishing up",
  };
  const label = stageLabels[progress.stage] || progress.stage;
  return `Running pipeline — ${label}…`;
}

async function refreshDataFiles(options = {}) {
  if (dataRefreshInProgress) return false;
  const btn = document.getElementById("refresh-btn");
  const statusEl = document.getElementById("refresh-status");
  const refreshModeEl = document.getElementById("refresh-mode-select");
  const refreshMode = options.forceMode || (refreshModeEl ? refreshModeEl.value : "full");
  const cellular = refreshMode === "cellular";
  const downloadPlan = cellular && options.forceMode
    ? { mode: "cellular", products: ["ec"], hours: 24, resolutionKm: 3, coverage: "official marine zones" }
    : currentDownloadPlan();
  if (!downloadPlan.products.length) {
    if (statusEl) statusEl.textContent = "Select at least one data product before pressing Go.";
    return false;
  }
  dataRefreshInProgress = true;
  refreshAbortController = new AbortController();
  const stopBtn = document.getElementById("refresh-stop-btn");
  if (stopBtn) stopBtn.disabled = false;
  lastRefreshFailedProducts = new Set();
  unattributedPipelineFailure = false;
  activeDownloadProgress = { selected: downloadPlan.products.slice(), percent: {} };
  renderDownloadProductProgress();
  const windHourly = !cellular && (downloadPlan.mode === "full" || downloadPlan.mode === "voyage");
  const timerEl = document.getElementById("refresh-timer");
  const refreshStartedAt = performance.now();
  let elapsedTimer = null;
  const updateElapsedTimer = () => {
    if (timerEl) timerEl.textContent = `Elapsed: ${formatRefreshDuration((performance.now() - refreshStartedAt) / 1000)} · ${refreshModeLabel(refreshMode)}`;
  };
  updateElapsedTimer();
  elapsedTimer = setInterval(updateElapsedTimer, 1000);
  if (btn) {
    btn.disabled = true;
    btn.title = ""; // clear any previous run's failure tooltip -- see the one set near this function's end
  }
  setRefreshButtonState("working");
  if (statusEl) statusEl.textContent = "Checking for local helper server…";
  // 2026-08-07, owner's request: "move this message to a popup that
  // disappears when data is refreshed" -- reuses the existing About-
  // button info-popup machinery (showInfoPopup()/closeInfoPopup()) rather
  // than a new modal. Opened here, at the very start of a refresh;
  // closeInfoPopup() is called in this function's own `finally` block
  // below, which runs on every exit path (success or failure), so the
  // popup is always gone by the time the attempt concludes.
  const refreshInfoTextEl = document.getElementById("refresh-info-text");
  if (refreshInfoTextEl && !options.scheduled) showInfoPopup(
    cellular ? "Cellular Data Refresh" : "Data Refresh",
    cellular
      ? "Downloading only the small official English Environment Canada marine forecasts and extended forecasts. Existing model grids and other data remain unchanged."
      : refreshInfoTextEl.innerHTML
  );

  // null = helper not running (nothing to report on that front); true/false
  // = helper ran the pipeline and it succeeded/failed.
  let pipelineRanOk = null;
  let pipelineMetrics = null;
  let progressTimer = null;
  // 2026-08-07, real bug found by the owner: a real run where SalishSeaCast
  // succeeded but CIOPS-West came back with zero records went completely
  // unreported -- the overall pipeline's returncode/`success` flag only
  // reflects a hard crash, and fetch_model_data.py's "one failing does not
  // block the others" design (see fetch_ciops_west_current()'s own
  // try/except in that file) means a single track failing does NOT flip
  // that flag. Every track's own catch block DOES print a line starting
  // with "FAILED" though (consistent convention across all of them, e.g.
  // currents/wind/waves/tide/gate) -- result.output captures that text
  // (sailvu_helper_server.py's run_pipeline()) but nothing previously read
  // it unless the whole run failed. Best-effort text scan (this pipeline
  // has no structured per-track status), populated below once `result` is
  // available, surfaced in the status text regardless of overall success.
  let partialFailureLines = [];

  try {
    let helperAvailable = false;
    let helperInfo = null;
    try {
      const healthResp = await fetchWithTimeout(
        `${HELPER_BASE}/health`,
        {},
        HELPER_HEALTH_TIMEOUT_MS
      );
      helperAvailable = healthResp.ok;
      if (healthResp.ok) helperInfo = await healthResp.json();
    } catch (err) {
      helperAvailable = false; // not running / not reachable -- not an error, just degrade
    }

    if (helperAvailable) {
      const requiredHelperVersion = refreshMode === "cellular" ? 2 : refreshMode === "voyage" ? 5 : 4;
      if (requiredHelperVersion && (!helperInfo || Number(helperInfo.apiVersion || 0) < requiredHelperVersion)) {
        throw new Error("The running helper server is too old for this safe refresh mode. Restart SAILVu, then try again.");
      }
      if (statusEl) {
        statusEl.textContent = cellular
          ? "Running Cellular refresh — EC marine forecasts only…"
          : windHourly
            ? "Running pipeline — a complete all-data download takes about 8 minutes on a fibre-optic connection…"
            : "Running selected data download…";
      }
      // Poll /progress independently of the /run-pipeline await below --
      // that request only resolves once the ENTIRE pipeline (all six
      // tracks) finishes, so this is the only way to show movement before
      // then. Best-effort: a failed poll just skips that tick, doesn't
      // interrupt the real pipeline request in progress.
      progressTimer = setInterval(async () => {
        try {
          const progResp = await fetchWithTimeout(`${HELPER_BASE}/progress`, {}, HELPER_HEALTH_TIMEOUT_MS);
          const progress = await progResp.json();
          updateDownloadProductProgress(progress);
          if (statusEl) statusEl.textContent = formatPipelineProgress(progress);
        } catch (err) {
          // skip this tick -- see comment above
        }
      }, PROGRESS_POLL_MS);

      try {
        const runResp = await fetch(`${HELPER_BASE}/run-pipeline`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ windHourly, refreshMode, downloadPlan }),
          signal: refreshAbortController.signal,
        });
        const result = await runResp.json();
        pipelineRanOk = !!result.success;
        pipelineMetrics = result.metrics || null;
        if (!pipelineRanOk) console.error("Pipeline run failed:", result);
        // See partialFailureLines' own declaration above for why this scan
        // exists even on a "successful" run.
        if (Array.isArray(result.failedLines) || result.output) {
          partialFailureLines = Array.isArray(result.failedLines)
            ? result.failedLines
            : result.output.split("\n").map((l) => l.trim()).filter((l) => l.includes("FAILED"));
          if (partialFailureLines.length) console.warn("Pipeline: some tracks failed:", partialFailureLines);
        }
        if (!pipelineRanOk && !partialFailureLines.length && result.output) {
          const lines = result.output.split("\n").map((line) => line.trim()).filter(Boolean);
          if (lines.length) partialFailureLines = [lines[lines.length - 1]];
        }
      } catch (err) {
        pipelineRanOk = false;
        console.error("Pipeline run request failed:", err);
      } finally {
        if (progressTimer) clearInterval(progressTimer);
      }
    }

    if (statusEl) statusEl.textContent = "Reloading data files…";
    await Promise.all([
      reloadScript("data/gate_predictions.js"),
      reloadScript("data/current_field.js"),
      reloadScript("data/tide_predictions.js"),
      reloadScript("data/gate_current_curve.js"),
      reloadScript("data/wind_field.js", /* optional */ true),
      reloadScript("data/wave_field.js", /* optional */ true),
      reloadScript("data/wind_stations_obs.js", /* optional */ true),
      reloadScript("data/wind_verification_log.js", /* optional */ true),
      reloadScript("data/marine_zone_status.js", /* optional */ true),
      reloadScript("data/marine_zone_shapes.js", /* optional */ true),
      reloadScript("data/marine_weather_statement.js", /* optional */ true),
      // 2026-08-07, owner's request: "Every time the Data is Refreshed
      // under SETUP, refresh the weather data" -- data/marine_forecasts.js
      // (fetch_marine_forecasts()/build_marine_forecasts_js() in
      // fetch_model_data.py) reloads alongside the other EC marine files
      // above, same optional:true (missing/failed fetch degrades gracefully,
      // doesn't block the rest of the refresh -- same reasoning as every
      // other optional file here).
      reloadScript("data/marine_forecasts.js", /* optional */ true),
    ]);
    const promotedPackageState = String(pipelineMetrics?.package?.state || "").toUpperCase();
    if (pipelineRanOk === false) {
      const failedText = partialFailureLines.join(" ").toLowerCase();
      const mapped = new Set();
      if (/current|salish|ciops/.test(failedText)) mapped.add("currents");
      if (/hrdps|wind/.test(failedText)) mapped.add("wind");
      if (/wave/.test(failedText)) mapped.add("waves");
      if (/tide|gate|curve/.test(failedText)) mapped.add("tides");
      if (/marine|weather|forecast|\bec\b/.test(failedText)) mapped.add("ec");
      lastRefreshFailedProducts = mapped;
      unattributedPipelineFailure = mapped.size === 0;
    } else if (promotedPackageState === "ESSENTIAL" || promotedPackageState === "BRIEFING") {
      const promotedProducts = new Set(promotedPackageState === "ESSENTIAL" ? ["ec", "tides"] : ["ec"]);
      lastRefreshFailedProducts = new Set(downloadPlan.products.filter((product) => !promotedProducts.has(product)));
      unattributedPipelineFailure = false;
    }
    activeDownloadProgress = null;
    // 2026-08-03: invalidate the point-query graphs' fixed-Y-axis caches
    // (currentSpeedRange()/waveHeightRange()) -- their whole reason to
    // cache is that they scan the entire field once, so a freshly reloaded
    // field (new min/max, possibly a different snapshot window entirely)
    // needs a forced recompute, not the stale range from page load.
    cachedCurrentSpeedRange = null;
    cachedWaveHeightRange = null;
    cachedWindSpeedRange = null;
    // 2026-08-06: DFO-gate nodes are built from three files this same
    // Promise.all reloads (gate_current_curve.js, gate_predictions.js,
    // current_field.js) -- without this reset, loadDfoGateRecords() would
    // keep serving a build derived from the PRE-refresh data all session.
    cachedDfoGateRecords = null;
    selectedFieldTime = null; // don't carry a scrubbed time over into a freshly reloaded field
    renderFieldTimeControl();
    renderDataFreshness();
    loadGateStations();
    loadTideStations();
    loadWindStations(); // re-runs after wind_field.js/wind_stations_obs.js reload above so its tooltip's model/obs comparison reflects the fresh snapshot, same reasoning as loadGateStations()/loadTideStations()
    renderCurrentArrowsOnMap();
    renderWindArrowsOnMap();
    renderCurrentHeatMap();
    renderWaveMap();
    renderMarineZonesOnMap(); // re-reads the freshly reloaded status/shapes files above
    renderMarineWeatherStatement(); // re-reads the freshly reloaded marine_weather_statement.js above
    renderMarineExtendedForecastMap();
    updateCurrentSourceAvailability(); // re-reads the freshly reloaded current_field.js above -- see that function's own comment
    redraw(); // legs, waypoint/leg tooltips, ground-track arrows, warnings

    const now = new Date().toLocaleTimeString();
    const elapsedSeconds = (performance.now() - refreshStartedAt) / 1000;
    recordDownloadTest(downloadPlan, elapsedSeconds, pipelineMetrics, pipelineRanOk === true);
    try {
      const timings = loadRefreshTimings();
      timings[refreshMode] = { seconds: elapsedSeconds, completedAt: new Date().toISOString() };
      localStorage.setItem(REFRESH_TIMINGS_KEY, JSON.stringify(timings));
    } catch (err) {
      // Timing remains visible for this run even if browser storage is unavailable.
    }
    if (timerEl) timerEl.textContent = `${refreshModeLabel(refreshMode)} completed in ${formatRefreshDuration(elapsedSeconds)}`;
    if (statusEl) {
      if (pipelineRanOk === true) {
        if (promotedPackageState === "ESSENTIAL" || promotedPackageState === "BRIEFING") {
          const retained = Array.from(lastRefreshFailedProducts);
          statusEl.textContent = `${promotedPackageState} fallback refreshed at ${now} after the ${pipelineMetrics.package.fallback_from || "primary"} download failed.${retained.length ? ` Previous ${retained.join(", ")} files were retained.` : ""}`;
        // partialFailureLines' own declaration (above) explains why this
        // still needs checking even though pipelineRanOk is true.
        } else if (partialFailureLines.length) {
          const stationOnly = partialFailureLines.every((line) => /station name|\(buoy\)/i.test(line));
          statusEl.textContent = stationOnly
            ? `All selected model products refreshed at ${now}. ${partialFailureLines.length} supplementary wind-observation station(s) were unavailable: ${partialFailureLines.map((line) => line.replace(/^\[FAILED\]\s*/, "").split(":")[0]).join(", ")}.`
            : `${cellular ? "Cellular refresh" : "Pipeline"} completed at ${now} with ${partialFailureLines.length} partial item(s): ${partialFailureLines.join(" ")}`;
        } else {
          statusEl.textContent = `${cellular ? "Cellular marine forecasts" : "Pipeline data"} refreshed at ${now}.`;
        }
      } else if (pipelineRanOk === false) {
        statusEl.textContent = `Pipeline run failed — reloaded existing files at ${now}. Check the "SAILVu Helper Server" window for details.`;
      } else {
        statusEl.textContent = `Reloaded existing files at ${now} (local helper server not running — start scripts/start_sailvu.bat for one-click pipeline refresh).`;
      }
    }
    // 2026-08-07, owner's request: "warning should appear on hovering over
    // refresh" -- native title attribute (browser's own hover tooltip, no
    // custom tooltip UI needed) on #refresh-btn itself, carrying the same
    // FAILED lines as #refresh-status above so they're visible even after
    // that status text gets overwritten by a later, unrelated action.
    // Cleared at the top of this function on every new run (see the
    // matching comment there) so a stale warning from 2 refreshes ago
    // can't linger past a clean one.
    if (btn) btn.title = partialFailureLines.length
      ? `${partialFailureLines.length} track(s) failed on the last refresh:\n${partialFailureLines.join("\n")}`
      : "";
    setRefreshButtonState(pipelineRanOk === false ? "failed" : "done");
  } catch (err) {
    console.error(err);
    lastRefreshFailedProducts = new Set();
    unattributedPipelineFailure = true;
    activeDownloadProgress = null;
    renderDownloadProductProgress();
    const failedElapsedSeconds = (performance.now() - refreshStartedAt) / 1000;
    recordDownloadTest(downloadPlan, failedElapsedSeconds, pipelineMetrics, false);
    if (timerEl) timerEl.textContent = `${refreshModeLabel(refreshMode)} failed after ${formatRefreshDuration(failedElapsedSeconds)}`;
    if (statusEl) {
      if (err?.name === "AbortError") statusEl.textContent = "Download stopped. Existing data were kept.";
      else
      statusEl.textContent = err && String(err.message || "").includes("helper server is too old")
        ? err.message
        : "Refresh failed — check the console, and that the pipeline has actually written new files.";
    }
    setRefreshButtonState("idle");
  } finally {
    if (progressTimer) clearInterval(progressTimer); // belt-and-suspenders vs. the inner finally above
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (btn) btn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    refreshAbortController = null;
    dataRefreshInProgress = false;
    // 2026-08-07: auto-dismiss the "Data Refresh" popup opened above,
    // success or failure. Caveat: closeInfoPopup() closes whichever info
    // popup is currently open (there's only ever one shared overlay, see
    // infoModalEl) -- if the owner opened a DIFFERENT About popup (Current
    // Field/Wind Field/etc.) while a refresh was still running, this would
    // close that one too, not just this one. Edge case, not fixed here.
    closeInfoPopup();
  }
  return pipelineRanOk === true;
}

// 2026-08-03, third pass: the horizontal tab bar (switchTab()/
// switchSubtab(), second restructure pass) is gone, replaced by a plain
// vertically-stacked, nested <details>/<summary> accordion -- the owner's
// explicit request, back to the same mechanism the very first version of
// this sidebar used, just applied to the newer About/Setup/Planning/Map
// grouping. Nesting <details> works natively in every browser with zero
// JS -- each one tracks its own open/closed state on its own, including
// nested ones, so unlike the removed switchTab()/switchSubtab() there is
// NO wiring code for the accordion itself anymore. The only sidebar-level
// JS left is toggleSidebar() below, for showing/hiding the whole panel.

// 2026-08-03: the sidebar now starts collapsed (class="sidebar-collapsed"
// is on #app in index.html from the start, not added by JS), and the
// "SAILVu" h1 that used to sit above the sections is gone -- it's now
// #sidebar-toggle-btn's permanent label instead, living on the map,
// clicking it opens the sidebar (showing every section's title, all
// closed, per the owner's request) or closes it again. #sidebar-toggle-
// btn's position is pure CSS (keyed to #sidebar's own 340px width, see
// style.css), so this function only needs to toggle one class --
// map.invalidateSize() is still required afterward, since Leaflet caches
// its container's pixel size at init and does not notice a CSS-only
// resize on its own; delayed to run after #sidebar's own 0.2s width
// transition finishes, not immediately, so Leaflet measures the *final*
// size, not a mid-transition one.
function toggleSidebar() {
  const appEl = document.getElementById("app");
  appEl.classList.toggle("sidebar-collapsed");
  if (!appEl.classList.contains("sidebar-collapsed")) {
    const kidsMenu = document.getElementById("kids-details");
    if (kidsMenu) kidsMenu.open = false;
  }
  if (map) {
    setTimeout(() => map.invalidateSize(), 220);
  }
}

// 2026-08-05: formats a Date as the plain "YYYY-MM-DDTHH:MM" string
// <input type="datetime-local"> expects, using the Date's own LOCAL wall-
// clock fields (getFullYear()/getMonth()/etc, not the UTC ones) -- matches
// how redraw() already treats this field elsewhere (new Date(departureInput)
// with no zone marker parses as local time), so defaulting it this way
// doesn't introduce a new timezone convention, just makes the existing one
// visible instead of leaving the field blank.
function formatDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

window.addEventListener("DOMContentLoaded", () => {
  // 2026-08-05: owner's request -- default #departure to "now" instead of
  // leaving it blank. redraw() already TREATED a blank field as "now"
  // internally (see its own cursorTime fallback), this just makes that
  // visible in the field itself rather than looking unset.
  document.getElementById("departure").value = formatDatetimeLocalValue(new Date());
  initMap();
  initializeMapDisplayTuning();
  initializeVesselIntegration();
  initializeOnboardChecks();
  initializeUpdatesAndFeedback();
  initializeConservationLayers();
  initializeMapPointTool();
  loadGateStations();
  initializeMakingGatePlanner();
  loadTideStations();
  loadWindStations();
  renderCurrentArrowsOnMap();
  renderWindArrowsOnMap();
  renderWaveMap();
  renderMarineZonesOnMap();
  renderMarineWeatherStatement();
  renderMarineExtendedForecastMap();
  renderDataFreshness();
  renderFieldTimeControl(); // 2026-08-05: floating time-scrubber + sidebar mirror, initial paint
  const fieldTimeNowBtn = document.getElementById("field-time-now-btn");
  if (fieldTimeNowBtn) fieldTimeNowBtn.addEventListener("click", resetFieldTimeToLive);
  // 2026-08-05: "Undo last point"/"Clear route" buttons removed from
  // index.html at the owner's request (replaced with a plain-text
  // reminder of the map gestures that do the same undo -- shift+click to
  // add, Backspace to remove the last point, both still wired below/in
  // the keydown handler, unchanged). No listeners to attach here anymore
  // -- see undoLast()/clearRoute() themselves for what's still reachable.
  // 2026-08-03: "About" buttons for the (now-flattened) Current Field/Wind
  // Field rows -- see index.html's own comment above those rows, and
  // showInfoPopup()'s comment above, for the background. Reads whatever is
  // currently in the hidden #current-field-info/#wind-field-info divs at
  // click time (kept fresh by renderCurrentArrowsOnMap()/
  // renderWindArrowsOnMap() on every redraw, unchanged from before), so the
  // popup always reflects the latest arrow-count/snapshot-time status, not
  // a stale copy taken once at page load.
  document.getElementById("current-field-about-btn").addEventListener("click", () => {
    showInfoPopup("Current Field", document.getElementById("current-field-info").innerHTML);
  });
  document.getElementById("wind-field-about-btn").addEventListener("click", () => {
    // 2026-08-06: EC marine-warnings link added here too -- see the
    // sidebar's own link (index.html, right below the Modelled winds
    // toggle) for the full "why."
    // 2026-08-06, later session (owner's request, "and source - is it
    // GRIB2?"): source stated explicitly now -- confirmed in
    // fetch_model_data.py, native ECCC HRDPS (2.5km) fetched as raw GRIB2
    // files from MSC Datamart, parsed with the bundled wgrib2.exe.
    const note =
      "<p style='font-size:12px;color:#666;'>10m wind, native ECCC HRDPS forecast (2.5km) — fetched as raw GRIB2 files from MSC Datamart, parsed with the bundled wgrib2.exe. Experimental, display only. Not applied to any leg's ETA or ground-track correction. Can miss a fjord/narrows' own localized in/outflow pattern that EC's forecasters flag as a real warning — check <a href='https://weather.gc.ca/marine/region_e.html?mapID=03' target='_blank' rel='noopener'>official EC marine warnings</a> before departure.</p>";
    showInfoPopup("Wind Field", note + document.getElementById("wind-field-info").innerHTML);
  });
  // 2026-08-06, later session (owner's request): the Tides sub-tab's
  // always-visible disclaimer moved behind a "?" button, same
  // showInfoPopup()/hidden-info-div pattern as the two buttons just above.
  const tideStationsAboutBtn = document.getElementById("tide-stations-about-btn");
  if (tideStationsAboutBtn) {
    tideStationsAboutBtn.addEventListener("click", () => {
      showInfoPopup("Tide Stations", document.getElementById("tide-stations-info").innerHTML);
    });
  }
  const interactionAboutBtn = document.getElementById("wind-current-interaction-about-btn");
  if (interactionAboutBtn) {
    interactionAboutBtn.addEventListener("click", () => {
      showInfoPopup("Wind/current opposition", document.getElementById("wind-current-interaction-info").innerHTML);
    });
  }
  // 2026-08-06, later session (owner's request): the two "?" help buttons
  // that used to be wired here (Weather section's "what is this zones
  // overlay" note and "Official EC marine warnings" link note) are
  // deleted outright, in index.html -- this wiring removed along with
  // them, not left as dead getElementById(null) code.
  // 2026-08-03: Backspace deletes the last waypoint, same as the "Undo last
  // point" button (undoLast() -- just waypoints.pop() + redraw()). Guarded
  // against firing while the user is typing in a text field (e.g. the
  // per-leg speed inputs, default-speed input) -- Backspace there must
  // still edit the field, not eat a route point. Also prevents the
  // browser's own default Backspace-navigates-back behavior only when the
  // route field guard doesn't apply.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace") return;
    const tag = document.activeElement && document.activeElement.tagName;
    const isEditable =
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable);
    if (isEditable) return;
    e.preventDefault();
    undoLast();
  });
  // 2026-08-04, extended to the full scoped scrubber 2026-08-05 -- keyboard
  // alternative to the floating control's own slider/buttons, covering
  // current (arrows + heat map), wind arrows, the wave map, and
  // gate/tide/wind station tooltips -- see selectedFieldTime's own comment.
  // PageDown steps forward one current-field snapshot, PageUp steps back,
  // Home returns to real "now". Same editable-field guard as the Backspace
  // handler above -- PageUp/PageDown/Home must not hijack normal
  // text-field navigation (this also means they're inert while the
  // floating control's own range-slider input is focused, since that's
  // also an <input> -- browsers already give a focused range slider its
  // own left/right arrow-key stepping, so this isn't a loss). preventDefault()
  // only when NOT in an editable field, for the same reason, and
  // specifically because PageUp/PageDown scroll the whole document by
  // default, which would fight this control.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "PageDown" && e.key !== "PageUp" && e.key !== "Home") return;
    const tag = document.activeElement && document.activeElement.tagName;
    const inputType = tag === "INPUT" ? String(document.activeElement.type || "text").toLowerCase() : "";
    const isEditable =
      (tag === "INPUT" && !["range", "checkbox", "radio", "button"].includes(inputType)) ||
      tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable);
    if (isEditable) return;
    e.preventDefault();
    if (e.key === "PageDown") stepFieldTime(1);
    else if (e.key === "PageUp") stepFieldTime(-1);
    else resetFieldTimeToLive();
  }, true);
  // 2026-08-06: Escape cancels current-verification grid-point picking
  // (startVerificationPick()) -- no editable-field guard needed like the
  // Backspace/PageUp handlers above, Escape doesn't collide with normal
  // text-field editing.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !verificationPickStationId) return;
    cancelVerificationPick();
  });
  // Escape dismisses the first-hover EC forecast tooltip without changing
  // the Environment Canada layer or requiring the pointer to leave the zone.
  document.addEventListener("keydown", (e) => {
    if ((e.key !== "Escape" && e.code !== "Escape") || !map) return;
    setMarineTooltipSuppressed(true);
    map.closeTooltip();
    [marineZoneLayer, marineExtendedMapLayer].forEach((group) => {
      if (!group || !group.eachLayer) return;
      group.eachLayer((layer) => {
        if (layer.closeTooltip) layer.closeTooltip();
      });
    });
  }, true);
  document.getElementById("admin-toggle-btn")?.addEventListener("click", () => {
    adminModeEnabled = !adminModeEnabled;
    renderAdminMode();
  });
  renderAdminMode();
  const kidsMapMenuButton = document.getElementById("kids-map-menu-btn");
  const kidsMapMenu = document.getElementById("kids-details");
  if (kidsMapMenuButton && kidsMapMenu) {
    document.body.append(kidsMapMenu);
    kidsMapMenu.classList.add("kids-map-menu");
    kidsMapMenuButton.addEventListener("click", () => {
      kidsMapMenu.open = !kidsMapMenu.open;
      kidsMapMenuButton.setAttribute("aria-expanded", String(kidsMapMenu.open));
    });
    kidsMapMenu.addEventListener("toggle", () => kidsMapMenuButton.setAttribute("aria-expanded", String(kidsMapMenu.open)));
    kidsMapMenuButton.setAttribute("aria-expanded", String(kidsMapMenu.open));
  }
  // Keep normal Setup simple. Map display tuning only opens deliberately with Shift+click.
  const setupDetails = document.getElementById("setup-details");
  const mapToolsDetails = document.getElementById("map-tools-details");
  if (setupDetails && mapToolsDetails) {
    mapToolsDetails.after(setupDetails);
    const mapSetup = document.createElement("details");
    mapSetup.className = "section-details";
    mapSetup.id = "setup-map-details";
    mapSetup.innerHTML = "<summary>Map</summary>";
    const baseMapRow = setupDetails.querySelector('label[for="basemap-select"]')?.closest(".field");
    const onlineMaps = setupDetails.querySelector(".online-basemaps-optin");
    const tuning = document.getElementById("map-display-tuning-details");
    [baseMapRow, onlineMaps, tuning].forEach((node) => { if (node) mapSetup.appendChild(node); });
    setupDetails.append(mapSetup);
    [mapSetup, setupDetails.querySelector("#data-readiness")?.closest("details"), document.getElementById("vessel-integration-details"), document.getElementById("kids-parental-details"), document.getElementById("updates-feedback-details")]
      .forEach((node) => { if (node) setupDetails.append(node); });
    const tuningSummary = tuning?.querySelector("summary");
    tuningSummary?.addEventListener("click", (event) => {
      if (!event.shiftKey) { event.preventDefault(); tuning.open = false; }
    });
  }
  const layoutRouteDetails = document.getElementById("layout-route-details");
  const queryRouteDetails = document.getElementById("query-route-details");
  if (layoutRouteDetails && queryRouteDetails) layoutRouteDetails.after(queryRouteDetails);
  document.getElementById("refresh-btn").addEventListener("click", refreshDataFiles);
  document.getElementById("refresh-stop-btn")?.addEventListener("click", stopDataRefresh);
  const refreshModeSelect = document.getElementById("refresh-mode-select");
  if (refreshModeSelect) {
    const updateRefreshModeUi = () => {
      const cellular = refreshModeSelect.value === "cellular";
      const note = document.getElementById("cellular-refresh-note");
      const windHourlyLabel = document.getElementById("wind-hourly-label");
      if (note) note.hidden = !cellular;
      if (windHourlyLabel) windHourlyLabel.hidden = true;
      const summary = document.getElementById("download-plan-summary");
      if (summary) {
        summary.textContent = refreshModeSelect.value === "full"
          ? "Use on southern Wi-Fi before heading north."
          : refreshModeSelect.value === "voyage"
            ? "Southern Strait through north Quadra; full resolution."
          : "EC forecasts/warnings only; keeps existing models.";
      }
      showLastRefreshTiming(refreshModeSelect.value);
    };
    refreshModeSelect.addEventListener("change", () => {
      applyDownloadPreset(refreshModeSelect.value);
      updateRefreshModeUi();
      refreshVoyageRegionDisplay();
    });
    if (!restoreDownloadPlan()) applyDownloadPreset(refreshModeSelect.value);
    updateRefreshModeUi();
    refreshVoyageRegionDisplay();
  }
  // Restore the saved download plan before checking whether today's
  // scheduled run is due, so an on-startup refresh uses the operator's
  // actual plan rather than the HTML default.
  initializeAutomaticRefresh();
  document.getElementById("download-plan-help")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showInfoPopup("Choosing a download plan", `
      <p><strong>Full Region:</strong> All model coverage. Use on southern Wi-Fi before heading north.</p>
      <p><strong>Voyage Region:</strong> Southern Strait through north Quadra Island. Full resolution, smaller download.</p>
      <p><strong>EC Only:</strong> Forecasts and warnings. Keeps existing models.</p>
      <p><strong>If a model download fails:</strong> Previous model files are kept; SAILVu falls back to EC/tides, then EC only.</p>
      <p><strong>Normal sequence:</strong> Full Region on Wi-Fi → EC Only on cellular.</p>
    `);
  });

  ["download-coverage-select", "download-hours-range", "download-resolution-range"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", renderDownloadPlanner);
  });
  const spatialPreviewInput = document.getElementById("download-resolution-range");
  if (spatialPreviewInput) spatialPreviewInput.addEventListener("change", renderSpatialPreviewLayers);
  const spatialCoverageInput = document.getElementById("download-coverage-select");
  if (spatialCoverageInput) spatialCoverageInput.addEventListener("change", renderSpatialPreviewLayers);
  document.querySelectorAll("[data-download-product]").forEach((input) => input.addEventListener("change", renderDownloadPlanner));
  document.querySelectorAll("[data-download-hours]").forEach((input) => input.addEventListener("change", renderDownloadPlanner));
  const downloadDrawAoiBtn = document.getElementById("download-draw-aoi-btn");
  if (downloadDrawAoiBtn) downloadDrawAoiBtn.addEventListener("click", startAoiDraw);
  const downloadCancelAoiBtn = document.getElementById("download-cancel-aoi-btn");
  const downloadClearAoiBtn = document.getElementById("download-clear-aoi-btn");
  if (downloadCancelAoiBtn) downloadCancelAoiBtn.addEventListener("click", cancelAoiDraw);
  if (downloadClearAoiBtn) downloadClearAoiBtn.addEventListener("click", clearAoi);
  if (map) map.on("moveend", () => {
    renderDownloadPlanner();
    if (document.getElementById("download-coverage-select")?.value === "view") renderSpatialPreviewLayers();
  });

  const drawAoiBtn = document.getElementById("draw-aoi-btn");
  const clearAoiBtn = document.getElementById("clear-aoi-btn");
  if (drawAoiBtn) drawAoiBtn.addEventListener("click", startAoiDraw);
  if (clearAoiBtn) clearAoiBtn.addEventListener("click", clearAoi);
  renderAoiInfo();

  // 2026-08-07, owner's request: "add a Basemap tab with three options" --
  // wires the Setup > Base Map <select> to the setBaseLayer() swap function
  // defined alongside window.BASE_LAYERS in initMap() above.
  const basemapSelect = document.getElementById("basemap-select");
  const onlineBasemapsToggle = document.getElementById("online-basemaps-toggle");
  if (basemapSelect) {
    basemapSelect.addEventListener("change", (e) => {
      window.setBaseLayer(e.target.value);
    });
  }
  if (basemapSelect && onlineBasemapsToggle) {
    const onlineKeys = new Set(["standard", "topo"]);
    onlineBasemapsToggle.addEventListener("change", () => {
      const enabled = onlineBasemapsToggle.checked;
      for (const option of basemapSelect.options) {
        if (!onlineKeys.has(option.value)) continue;
        option.hidden = !enabled;
        option.disabled = !enabled;
      }
      if (!enabled && onlineKeys.has(basemapSelect.value)) {
        basemapSelect.value = "canvecOffline";
        window.setBaseLayer("canvecOffline");
      }
    });
  }

  // 2026-08-07: a "Plain" grey/white basemap option (and, briefly, a
  // TEMP-PLAIN-TUNER live filter-tuning slider wired here) went through
  // several rounds this session -- none landed anywhere the owner was
  // happy with, and the option is REMOVED per the owner's own "we'll
  // fight with that another day" -- see window.BASE_LAYERS' own comment
  // in initMap() above for the short version, git history/CHANGELOG.md
  // for the full trail if this is picked back up.

  // Sidebar open/close (the accordion sections themselves need no JS --
  // see toggleSidebar()'s own comment).
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener("click", toggleSidebar);

  // 2026-08-01: the heat map is now pure Leaflet-core geometry (see
  // buildHeatMeshQuads()/renderCurrentHeatMap()) -- no CDN plugin to fail to
  // load, so unlike the old Leaflet.heat version this control is never
  // disabled.
  // 2026-08-06, later session (owner's request): replaces the old single
  // "Current arrows" checkbox's wiring -- see gateBoxesEnabled/
  // salishSeaCastArrowsEnabled/ciopsArrowsEnabled's own comments in app.js
  // and this section's own comment in index.html for the full reasoning.
  const gateBoxesToggle = document.getElementById("gate-boxes-toggle");
  if (gateBoxesToggle) {
    gateBoxesToggle.addEventListener("change", (e) => {
      gateBoxesEnabled = e.target.checked;
      loadGateStations();
      renderCurrentArrowsOnMap(); // DFO-gate arrows share this same flag -- see its own comment
    });
  }

  // 2026-08-06, later session (owner's request: "Delete the 'Current data
  // source' text and box - we now have buttons"): these two now do the
  // FULL re-render list (refreshAfterCurrentSourceChange(), same one the
  // deleted #current-source-select's setCurrentSourceMode() used to run),
  // not just renderCurrentArrowsOnMap() -- they're the sole source of
  // truth for which model(s) load at all now (loadCurrentField()'s own
  // filter), not just arrow-layer visibility as originally scoped.
  const currentSourceSalishSeaCastToggle = document.getElementById("current-source-salishseacast-toggle");
  if (currentSourceSalishSeaCastToggle) {
    currentSourceSalishSeaCastToggle.addEventListener("change", (e) => {
      salishSeaCastArrowsEnabled = e.target.checked;
      refreshAfterCurrentSourceChange();
    });
  }

  const currentSourceCiopsToggle = document.getElementById("current-source-ciops-toggle");
  if (currentSourceCiopsToggle) {
    currentSourceCiopsToggle.addEventListener("change", (e) => {
      ciopsArrowsEnabled = e.target.checked;
      refreshAfterCurrentSourceChange();
    });
  }

  const heatmapToggle = document.getElementById("heatmap-toggle");
  const heatmapGradientSelect = document.getElementById("heatmap-gradient");
  heatmapToggle.addEventListener("change", (e) => {
    heatMapEnabled = e.target.checked;
    renderCurrentHeatMap();
  });
  if (heatmapGradientSelect) {
    heatmapGradientSelect.value = heatMapGradientKey;
    heatmapGradientSelect.addEventListener("change", (e) => {
      heatMapGradientKey = e.target.value;
      renderCurrentHeatMap();
    });
  }

  const interactionToggle = document.getElementById("wind-current-interaction-toggle");
  const interactionSourceSelect = document.getElementById("wind-current-interaction-source");
  const interactionGradientSelect = document.getElementById("wind-current-interaction-gradient");
  if (interactionToggle) {
    interactionToggle.addEventListener("change", (e) => {
      windCurrentInteractionEnabled = e.target.checked;
      renderWindCurrentInteractionMap();
    });
  }
  if (interactionSourceSelect) {
    interactionSourceSelect.value = windCurrentInteractionSource;
    interactionSourceSelect.addEventListener("change", (e) => {
      windCurrentInteractionSource = e.target.value;
      renderWindCurrentInteractionMap();
    });
  }
  if (interactionGradientSelect) {
    interactionGradientSelect.value = windCurrentInteractionGradientKey;
    interactionGradientSelect.addEventListener("change", (e) => {
      windCurrentInteractionGradientKey = e.target.value;
      renderWindCurrentInteractionMap();
    });
  }

  const windToggle = document.getElementById("wind-toggle");
  if (windToggle) {
    windToggle.addEventListener("change", (e) => {
      windArrowsEnabled = e.target.checked;
      renderWindArrowsOnMap();
    });
  }

  const environmentCanadaToggle = document.getElementById("environment-canada-toggle");
  if (environmentCanadaToggle) {
    environmentCanadaToggle.addEventListener("change", (e) => {
      const enabled = e.target.checked;
      marineWarningTitleAcknowledged = true;
      // One unified EC wind tool: forecast-coloured zone fills and rich
      // hover text. Active warnings remain visible in the tooltip and as a
      // red outline, but do not replace the green/yellow/orange/red forecast
      // fill requested for every zone.
      marineZonesEnabled = enabled;
      marineExtendedMapEnabled = false;
      syncAoiRectangleVisibility();
      // The former status-only map must never remain underneath the combined
      // forecast/warning map when this single Environment Canada control is used.
      renderMarineZonesOnMap();
      renderMarineExtendedForecastMap();
    });
  }
  const synopsisToggle = document.getElementById("ec-marine-synopsis-toggle");
  if (synopsisToggle) synopsisToggle.addEventListener("change", (event) => {
    const content = document.getElementById("environment-canada-content");
    if (content) content.hidden = !event.target.checked;
    if (event.target.checked) renderMarineWeatherStatement();
  });
  const hourlyForecastToggle = document.getElementById("ec-hourly-forecast-toggle");
  if (hourlyForecastToggle) hourlyForecastToggle.addEventListener("change", (event) => {
    const links = document.getElementById("ec-hourly-forecast-links");
    if (links) links.hidden = !event.target.checked;
  });

  const marineZonesToggle = document.getElementById("marine-zones-toggle");
  if (marineZonesToggle) {
    marineZonesToggle.addEventListener("change", (e) => {
      marineZonesEnabled = e.target.checked;
      if (marineZonesEnabled && marineExtendedMapEnabled) {
        marineExtendedMapEnabled = false;
        const extendedToggle = document.getElementById("marine-extended-map-toggle");
        if (extendedToggle) extendedToggle.checked = false;
        renderMarineExtendedForecastMap();
      }
      // 2026-08-07: set BEFORE renderMarineZonesOnMap() so its own
      // updateEnvironmentCanadaWarningFlag() call sees it already true on
      // this very click -- see marineWarningTitleAcknowledged's own comment.
      marineWarningTitleAcknowledged = true;
      renderMarineZonesOnMap();
      // 2026-08-06, later session (owner's explicit choice of trigger):
      // every click of this checkbox (on OR off) also fires a live
      // freshness check of the Marine Weather Statement -- see that
      // function's own comment for why this, not a direct browser fetch.
      checkMarineWeatherStatementFreshness();
    });
    // 2026-08-07, owner's request: "Move the button to turn off the
    // Warning maps to the right of the Marine Weather Warnings title" --
    // this checkbox now lives inside that <summary> (index.html), so a
    // plain click on it would ALSO fire the browser's native
    // toggle-the-<details> behavior (any click that bubbles up to
    // <summary> does) unless stopped first -- same reasoning as
    // #verification-help-btn's own click listener elsewhere in this file.
    // stopPropagation() only, deliberately NOT preventDefault() -- unlike
    // that "?" button, this element's own default action (flipping its
    // checked state) is exactly the behavior to keep, not suppress.
    //
    // 2026-08-07, owner's follow-up bug report: "Clicking 'Marine warnings'
    // turns off red flashing Environment Canada title." Root cause: this
    // listener was on the <input> ELEMENT ONLY. A physical click on the
    // checkbox's own tiny box does land on that input, and the line above
    // stops it correctly -- but a click on the VISIBLE LABEL TEXT
    // ("Marine warnings", the natural place to click) lands on the
    // <label>/<span> instead. That click is a SEPARATE event that bubbles
    // straight from the label up through <summary> WITHOUT ever passing
    // through the input (the label's own default action -- forwarding an
    // activation to its associated control -- fires a second, independent
    // click on the input, which the line above does correctly stop, but by
    // then the FIRST event has already reached <summary> unimpeded),
    // collapsing marine-weather-warnings-details. Confirmed via code trace:
    // updateEnvironmentCanadaWarningFlag() itself is unconditional (see its
    // own comment) and reads only real MARINE_ZONE_STATUS_DATA, so the
    // checkbox/section-open state cannot flip the flash class directly --
    // this accidental collapse is the one real, reproducible side effect
    // clicking the label text has. Listening on the whole label (not just
    // the input) below stops BOTH that first label-targeted click and the
    // second input-targeted one with the same handler, since both
    // bubble through the label on their way up.
    const marineZonesToggleLabel = marineZonesToggle.closest(".checkbox-label");
    (marineZonesToggleLabel || marineZonesToggle).addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // 2026-08-07: zone picker for the per-zone Forecast/Extended Forecast/
  // Warning text block -- see renderMarineForecasts()'s own comment.
  // Re-runs the same render on change; that function reads the just-changed
  // <select>.value as its "previous selection" so the newly picked zone
  // stays selected.
  const marineExtendedMapToggle = document.getElementById("marine-extended-map-toggle");
  if (marineExtendedMapToggle) {
    marineExtendedMapToggle.addEventListener("change", (e) => {
      marineExtendedMapEnabled = e.target.checked;
      if (marineExtendedMapEnabled && marineZonesEnabled) {
        marineZonesEnabled = false;
        const warningToggle = document.getElementById("marine-zones-toggle");
        if (warningToggle) warningToggle.checked = false;
        renderMarineZonesOnMap();
      }
      renderMarineExtendedForecastMap();
    });
  }

  const windStationsToggle = document.getElementById("wind-stations-toggle");
  if (windStationsToggle) {
    windStationsToggle.addEventListener("change", (e) => {
      windStationsEnabled = e.target.checked;
      if (!windStationsEnabled) clearVerificationHighlight();
      loadWindStations();
    });
  }

  // 2026-08-07, owner's request: "Make EC weather zone outlines visible
  // when any EC tab is open" -- see isMarineZoneSectionOpen()'s own
  // comment for the full expand/collapse chain this checks. "toggle" is
  // the real native <details> event (fires on an element whenever ITS OWN
  // open/closed state changes -- does NOT bubble from a nested <details>
  // the way a click might seem to), so each of the four relevant elements
  // needs its own listener; a nested child's own toggle doesn't imply its
  // ancestor's state changed too, and vice versa. Also run once at startup
  // so marineZoneSectionOpen matches the DOM's actual initial open/closed
  // state (in case a browser restores previous <details> state on
  // back/forward navigation -- this app doesn't persist it itself).
  ["wind-weather-details", "environment-canada-details", "marine-synopsis-details", "marine-weather-warnings-details"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("toggle", updateMarineZoneSectionOpenState);
  });
  updateMarineZoneSectionOpenState();

  const tideHeightToggle = document.getElementById("tide-height-toggle");
  const tideHeightGradientSelect = document.getElementById("tide-height-gradient");
  const tideHeatMapGradientSelect = document.getElementById("tide-heatmap-gradient");
  if (tideHeightToggle) {
    tideHeightToggle.addEventListener("change", (e) => {
      tideHeightEnabled = e.target.checked;
      loadTideStations();
    });
  }
  if (tideHeightGradientSelect) {
    tideHeightGradientSelect.value = tideHeightGradientKey;
    tideHeightGradientSelect.addEventListener("change", (e) => {
      tideHeightGradientKey = e.target.value;
      if (tideHeatMapGradientSelect) tideHeatMapGradientSelect.value = tideHeightGradientKey;
      loadTideStations();
    });
  }
  if (tideHeatMapGradientSelect) {
    tideHeatMapGradientSelect.value = tideHeightGradientKey;
    tideHeatMapGradientSelect.addEventListener("change", (e) => {
      tideHeightGradientKey = e.target.value;
      if (tideHeightGradientSelect) tideHeightGradientSelect.value = tideHeightGradientKey;
      loadTideStations();
    });
  }
  const tideContoursToggle = document.getElementById("tide-contours-toggle");
  if (tideContoursToggle) {
    tideContoursToggle.addEventListener("change", (e) => {
      tideContoursEnabled = e.target.checked;
      loadTideStations();
    });
  }
  const tideHeatMapToggle = document.getElementById("tide-heatmap-toggle");
  if (tideHeatMapToggle) {
    tideHeatMapToggle.addEventListener("change", (e) => {
      tideHeatMapEnabled = e.target.checked;
      loadTideStations();
    });
  }

  const waveToggle = document.getElementById("wave-toggle");
  const waveGradientSelect = document.getElementById("wave-gradient");
  if (waveToggle) {
    waveToggle.addEventListener("change", (e) => {
      waveMapEnabled = e.target.checked;
      renderWaveMap();
    });
  }
  if (waveGradientSelect) {
    waveGradientSelect.value = waveMapGradientKey;
    waveGradientSelect.addEventListener("change", (e) => {
      waveMapGradientKey = e.target.value;
      renderWaveMap();
    });
  }

  // redraw(), not renderLegs(): the waypoint/leg-line hover tooltips are
  // built from legTimings too and would otherwise go stale after this.
  document.getElementById("speed").addEventListener("change", redraw);
  document.getElementById("departure").addEventListener("change", redraw);
  // 2026-08-05: leeway % (wind's now-folded-in contribution to the ETA/
  // ground-track correction) -- same redraw()-not-renderLegs() reasoning as
  // speed/departure above.
  document.getElementById("leeway-percent").addEventListener("change", redraw);

  // 2026-08-05: Query Route's whole-route conditions graph (current/wind/
  // combined) -- see showRouteConditionsGraph()'s own comment.
  const routeGraphBtn = document.getElementById("route-graph-btn");
  if (routeGraphBtn) routeGraphBtn.addEventListener("click", showRouteConditionsGraph);

  // 2026-08-05: Verification section (owner's "database of shore/buoy
  // station winds and currents ... XY plot ... vs the nearest Model point"
  // request) -- see showVerificationGraph()'s own header comment.
  const verificationParamSelect = document.getElementById("verification-param-select");
  const verificationStationCheckboxes = document.getElementById("verification-station-checkboxes");
  const verificationShowBtn = document.getElementById("verification-show-btn");
  const windComparisonDetails = document.getElementById("wind-comparison-details");
  const windComparisonToggle = document.getElementById("wind-comparison-toggle");
  if (windComparisonDetails && windComparisonToggle) {
    windComparisonToggle.closest("label")?.addEventListener("click", (event) => event.stopPropagation());
    windComparisonToggle.addEventListener("change", () => { windComparisonDetails.open = windComparisonToggle.checked; });
    windComparisonDetails.addEventListener("toggle", () => { windComparisonToggle.checked = windComparisonDetails.open; });
  }
  const sstScene=document.getElementById("sst-scene"),sstCatalog=Array.isArray(window.LANDSAT_SST_CATALOG)?window.LANDSAT_SST_CATALOG:[];
  if(sstScene){sstScene.innerHTML=sstCatalog.map(item=>`<option value="${mapPointEscape(item.scene_id)}">${mapPointEscape(sstSceneShortLabel(item))}</option>`).join("");}
  const savedSst=loadLandsatSstSettings();
  [["sst-scene","scene"],["sst-slope","slope"],["sst-offset","offset"],["sst-opacity","opacity"],["sst-calibration-hours","calibrationHours"]].forEach(([id,key])=>{const element=document.getElementById(id);if(element&&savedSst[key]!==undefined)element.value=savedSst[key];});
  updateSstSceneSelectionUi();
  ["sst-toggle","sst-opacity","sst-slope","sst-offset"].forEach(id=>document.getElementById(id)?.addEventListener("input",()=>{saveLandsatSstSettings();renderLandsatSst();}));
  sstScene?.addEventListener("change",()=>{updateSstSceneSelectionUi();saveLandsatSstSettings();renderLandsatSst();});
  document.getElementById("sst-calibration-plot")?.addEventListener("click",showSstCalibrationGraph);
  document.getElementById("sst-calibration-hours")?.addEventListener("change",saveLandsatSstSettings);
  renderLandsatSst();
  if (verificationParamSelect && verificationStationCheckboxes) {
    populateVerificationStationOptions();
    renderVerificationOverrideStatus();
    // 2026-08-06: both cancel any in-progress pick and refresh the override
    // row/status -- switching parameter/station out from under an active
    // pick would otherwise leave a stale "picking for station X" marker
    // layer on the map with no way back to it from the sidebar.
    verificationParamSelect.addEventListener("change", () => {
      populateVerificationStationOptions();
      cancelVerificationPick();
      clearVerificationHighlight();
      renderVerificationOverrideStatus();
    });
    // 2026-08-07: single delegated listener on the container, NOT one per
    // checkbox -- populateVerificationStationOptions() replaces the
    // container's innerHTML on every Parameter switch, which would drop
    // any listener attached to an individual checkbox; this survives that
    // since it's attached to the container itself (change events bubble).
    verificationStationCheckboxes.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || target.tagName !== "INPUT") return;
      const allToggle = document.getElementById("verification-station-all");
      const stationBoxes = verificationStationCheckboxes.querySelectorAll('input[type="checkbox"][value]');
      if (target.id === "verification-station-all") {
        // Bulk toggle -- check/uncheck every individual station checkbox to
        // match. Unlike the old <select>'s "all" option, this isn't a
        // separate mutually-exclusive filter value, just a convenience for
        // checking/unchecking everything at once.
        stationBoxes.forEach((cb) => {
          cb.checked = target.checked;
        });
      } else if (allToggle) {
        // An individual station checkbox changed -- keep "All stations" in
        // sync (checked only once every individual station is checked).
        allToggle.checked = [...stationBoxes].every((cb) => cb.checked);
      }
      cancelVerificationPick();
      renderVerificationOverrideStatus();
    });
  }
  if (verificationShowBtn) {
    verificationShowBtn.addEventListener("click", () => {
      showVerificationGraph(verificationParamSelect.value, getSelectedVerificationStationIds());
    });
  }
  const verificationHighlightBtn = document.getElementById("verification-highlight-btn");
  if (verificationHighlightBtn) {
    verificationHighlightBtn.addEventListener("click", () => {
      if (verificationHighlightLayer) {
        clearVerificationHighlight();
        return;
      }
      if (!windStationsEnabled) {
        windStationsEnabled = true;
        const stationToggle = document.getElementById("wind-stations-toggle");
        if (stationToggle) stationToggle.checked = true;
        loadWindStations();
      }
      highlightSelectedVerificationStations();
    });
  }
  // 2026-08-07, owner's request: "Remove the explanatory text to a
  // [ ? ]" -- see index.html's own comment on #verification-help-btn.
  // stopPropagation() so pressing "?" (it lives inside <summary>) doesn't
  // ALSO toggle the Verification section open/closed via the browser's
  // own native <summary> click-to-toggle behavior.
  const verificationHelpBtn = document.getElementById("verification-help-btn");
  const verificationNote = document.getElementById("verification-note");
  if (verificationHelpBtn && verificationNote) {
    verificationHelpBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      verificationNote.hidden = !verificationNote.hidden;
    });
  }
  // 2026-08-06: current-verification grid-point override -- see
  // buildCurrentVerificationPoints()'s own comment for the full story.
  const verificationPickBtn = document.getElementById("verification-pick-btn");
  if (verificationPickBtn) {
    verificationPickBtn.addEventListener("click", () => {
      // Defensive -- this row is only shown (renderVerificationOverrideStatus())
      // when exactly one station checkbox is checked, so this should always
      // find exactly one id here.
      const selected = getSelectedVerificationStationIds();
      if (selected.length !== 1) return;
      const stationId = selected[0];
      if (verificationPickStationId === stationId) cancelVerificationPick();
      else startVerificationPick(stationId);
    });
  }
  const verificationClearBtn = document.getElementById("verification-clear-override-btn");
  if (verificationClearBtn) {
    verificationClearBtn.addEventListener("click", () => {
      const selected = getSelectedVerificationStationIds();
      if (selected.length !== 1) return;
      clearVerificationOverride(selected[0]);
      renderVerificationOverrideStatus();
    });
  }

  // 2026-08-07, owner's request: "Add comment box under Verification, plus
  // Edit/Save." Two-state UI (readonly display / editable), same explicit
  // Edit-then-Save pattern as the override row above -- see
  // loadVerificationComment()/saveVerificationComment()'s own comment for
  // the persistence side.
  const verificationCommentTextarea = document.getElementById("verification-comment-textarea");
  const verificationCommentEditBtn = document.getElementById("verification-comment-edit-btn");
  const verificationCommentSaveBtn = document.getElementById("verification-comment-save-btn");
  const verificationCommentStatus = document.getElementById("verification-comment-status");
  if (verificationCommentTextarea) {
    verificationCommentTextarea.value = loadVerificationComment();
  }
  if (verificationCommentEditBtn && verificationCommentSaveBtn && verificationCommentTextarea) {
    verificationCommentEditBtn.addEventListener("click", () => {
      verificationCommentTextarea.readOnly = false;
      verificationCommentTextarea.focus();
      verificationCommentEditBtn.style.display = "none";
      verificationCommentSaveBtn.style.display = "";
      if (verificationCommentStatus) verificationCommentStatus.style.display = "none";
    });
    verificationCommentSaveBtn.addEventListener("click", () => {
      const ok = saveVerificationComment(verificationCommentTextarea.value);
      verificationCommentTextarea.readOnly = true;
      verificationCommentSaveBtn.style.display = "none";
      verificationCommentEditBtn.style.display = "";
      if (verificationCommentStatus) {
        verificationCommentStatus.textContent = ok
          ? "Saved."
          : "Couldn't save (browser storage unavailable) — note will be lost on reload.";
        verificationCommentStatus.style.display = "";
      }
    });
  }

  updateCurrentSourceAvailability(); // initial state on page load, from whatever data/current_field.js already loaded -- see that function's own comment
  redraw();
});
