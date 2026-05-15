// Central dispatcher for the "Super animated" feature group. Each toggle
// flips an isolated subsystem on or off — fully reversible without a
// reload. Called from applyFeatureClasses() in ui/app.ts whenever the
// feature flag set changes (and once on boot).

import { getConfig } from "../settings";
import {
  enableGalaxyBackground,
  disableGalaxyBackground,
  setGalaxyMouseInteraction,
  isGalaxyActive,
} from "./galaxy";
import { enableElasticSliders, disableElasticSliders, isElasticActive } from "./elastic-slider";

export function applySuperAnimated() {
  const cfg = getConfig();
  const f = cfg.features ?? {};
  const mouseOn = f.superBackgroundMouse !== false;

  if (f.superBackground && !isGalaxyActive()) enableGalaxyBackground({ mouse: mouseOn });
  else if (!f.superBackground && isGalaxyActive()) disableGalaxyBackground();
  else if (f.superBackground && isGalaxyActive()) setGalaxyMouseInteraction(mouseOn);

  if (f.superSliders && !isElasticActive()) enableElasticSliders();
  else if (!f.superSliders && isElasticActive()) disableElasticSliders();
}
