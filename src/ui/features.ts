import { getConfig } from "../settings";
import { applyMemoryGraph } from "./memory-inspector";
import { applySuperAnimated } from "../super-animated";


export function applyFeatureClasses() {
  const f = getConfig().features ?? {};
  document.body.classList.toggle("no-covers", f.showCovers === false);
  document.body.classList.toggle("no-anim", f.disableAnimations === true);
  applyMemoryGraph();
  applySuperAnimated();
}
