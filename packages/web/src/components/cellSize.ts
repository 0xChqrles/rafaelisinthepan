// The page's graph-paper cell size — the ONE value behind the body grid, the
// BackgroundWaves field and the CellDigits watermark. CSS owns it (--cell in
// index.css, smaller under the mobile breakpoint); the canvases read it live on
// every draw/resize so a breakpoint crossing re-syncs all three renderers.
export function cellSize(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell'));
  return Number.isFinite(v) && v > 0 ? v : 24;
}
