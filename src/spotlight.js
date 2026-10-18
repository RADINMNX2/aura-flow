// flow. - cursor spotlight. Writes --mx/--my on the hovered .spotlight host, once per frame.

import { raf } from "./util.js";

const paint = raf((x, y, host) => {
  const r = host.getBoundingClientRect();
  host.style.setProperty("--mx", `${x - r.left}px`);
  host.style.setProperty("--my", `${y - r.top}px`);
});

export function initSpotlight() {
  document.addEventListener("pointermove", (e) => {
    const host = e.target.closest?.(".spotlight");
    if (host) paint(e.clientX, e.clientY, host);
  }, { passive: true });
}
