import { useEffect, useRef, useState } from "react";

// Measured container width for fluid SVG charts (index-chart-polish spec §1.4): the svg
// renders at the column's real CSS-pixel width so type/dots/strokes never scale with it.
// happy-dom has no ResizeObserver — the fallback keeps test renders deterministic.
const FALLBACK_WIDTH = 320;
const MIN_WIDTH = 260;

export function useContainerWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(MIN_WIDTH, Math.round(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
