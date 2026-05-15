// Vanilla port of React-Bits ElasticSlider. Augments existing native
// <input type="range"> elements with elastic stretch behaviour: dragging
// past either edge pulls the track in that direction with sigmoid decay,
// and releasing snaps back via spring animation.
//
// Strategy: leave the original input intact (so existing event listeners,
// state-binding subscribers, etc. keep firing). We attach a wrapper +
// overlay track that handles the visual stretching, and forward pointer
// events back to the input so its `input`/`change` events still fire.

const ACTIVE_CLASS = "super-elastic";
const MAX_OVERFLOW = 50;

interface Wrapped {
  input: HTMLInputElement;
  wrapper: HTMLElement;
  cleanup: () => void;
}

const wrapped = new WeakMap<HTMLInputElement, Wrapped>();
let mutationObs: MutationObserver | null = null;
let active = false;

function decay(value: number, max: number): number {
  if (max === 0) return 0;
  const entry = value / max;
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
  return sigmoid * max;
}

function wrap(input: HTMLInputElement) {
  if (wrapped.has(input)) return;

  const wrapper = document.createElement("span");
  wrapper.className = "elastic-wrap";
  // Inherit the flex sizing the original <input> had — a bare span otherwise
  // collapses to its content width inside flex parents (volume row, EQ row,
  // etc.) and the elastic track becomes 0 px wide → invisible.
  const cs = getComputedStyle(input);
  const flex = cs.flex;
  if (flex && flex !== "0 1 auto") wrapper.style.flex = flex;
  if (cs.width && cs.width !== "auto") wrapper.style.width = cs.width;
  if (cs.maxWidth && cs.maxWidth !== "none") wrapper.style.maxWidth = cs.maxWidth;
  if (cs.minWidth && cs.minWidth !== "auto") wrapper.style.minWidth = cs.minWidth;
  input.parentNode?.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const fill = document.createElement("span");
  fill.className = "elastic-fill";
  wrapper.appendChild(fill);

  let overflow = 0;
  let dragging = false;
  let pointerDir: "left" | "right" | "middle" = "middle";

  const updateFill = () => {
    const min = parseFloat(input.min || "0");
    const max = parseFloat(input.max || "100");
    const val = parseFloat(input.value || "0");
    const range = max - min || 1;
    const pct = ((val - min) / range) * 100;

    let scaleX = 1;
    let originX: "left" | "right" = "left";
    if (overflow > 0) {
      const w = wrapper.getBoundingClientRect().width || 1;
      scaleX = 1 + overflow / w;
      originX = pointerDir === "left" ? "right" : "left";
    }
    const scaleY = 1 - (overflow / MAX_OVERFLOW) * 0.2;

    fill.style.width = `${pct}%`;
    wrapper.style.setProperty("--elastic-scale-x", String(scaleX));
    wrapper.style.setProperty("--elastic-scale-y", String(scaleY));
    wrapper.style.setProperty("--elastic-origin-x", originX);
  };

  const onInput = () => updateFill();

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    overflow = 0;
    pointerDir = "middle";
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    updateFill();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const rect = wrapper.getBoundingClientRect();
    if (e.clientX < rect.left) {
      pointerDir = "left";
      overflow = decay(rect.left - e.clientX, MAX_OVERFLOW);
    } else if (e.clientX > rect.right) {
      pointerDir = "right";
      overflow = decay(e.clientX - rect.right, MAX_OVERFLOW);
    } else {
      pointerDir = "middle";
      overflow = 0;
    }
    updateFill();
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    // Spring back via simple under-damped harmonic decay.
    const start = overflow;
    const t0 = performance.now();
    const dur = 360;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      // Critically-damped spring approximation.
      const s = Math.exp(-4 * t) * Math.cos(8 * t);
      overflow = start * s;
      updateFill();
      if (t < 1) requestAnimationFrame(tick);
      else { overflow = 0; updateFill(); }
    };
    requestAnimationFrame(tick);
  };

  input.addEventListener("input", onInput);
  input.addEventListener("pointerdown", onPointerDown);
  input.addEventListener("pointermove", onPointerMove);
  input.addEventListener("pointerup", release);
  input.addEventListener("pointercancel", release);
  input.addEventListener("lostpointercapture", release);

  updateFill();

  const cleanup = () => {
    input.removeEventListener("input", onInput);
    input.removeEventListener("pointerdown", onPointerDown);
    input.removeEventListener("pointermove", onPointerMove);
    input.removeEventListener("pointerup", release);
    input.removeEventListener("pointercancel", release);
    input.removeEventListener("lostpointercapture", release);
    // Move input back out of the wrapper, then remove wrapper.
    wrapper.parentNode?.insertBefore(input, wrapper);
    wrapper.remove();
    wrapped.delete(input);
  };
  wrapped.set(input, { input, wrapper, cleanup });
}

function unwrap(input: HTMLInputElement) {
  wrapped.get(input)?.cleanup();
}

function scanAndWrap() {
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input[type="range"]:not(.elastic-skip)'
  );
  inputs.forEach(wrap);
}

function scanAndUnwrap() {
  // WeakMap doesn't enumerate; query DOM for wrappers and unwrap their input.
  document.querySelectorAll<HTMLElement>(".elastic-wrap").forEach((w) => {
    const input = w.querySelector<HTMLInputElement>('input[type="range"]');
    if (input) unwrap(input);
  });
}

export function enableElasticSliders(): void {
  if (active) return;
  active = true;
  document.body.classList.add(ACTIVE_CLASS);
  scanAndWrap();
  // New range inputs added later (e.g. EQ panel mount, settings re-render)
  // need wrapping too — observe insertions.
  mutationObs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLInputElement && n.type === "range") wrap(n);
        else if (n instanceof Element) {
          n.querySelectorAll<HTMLInputElement>(
            'input[type="range"]:not(.elastic-skip)'
          ).forEach(wrap);
        }
      });
    }
  });
  mutationObs.observe(document.body, { childList: true, subtree: true });
}

export function disableElasticSliders(): void {
  if (!active) return;
  active = false;
  document.body.classList.remove(ACTIVE_CLASS);
  mutationObs?.disconnect();
  mutationObs = null;
  scanAndUnwrap();
}

export function isElasticActive(): boolean { return active; }
