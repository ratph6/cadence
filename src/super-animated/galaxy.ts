import { Renderer, Program, Mesh, Color, Triangle } from "ogl";

// Vanilla port of the React-Bits Galaxy component. Renders an animated
// star-field via a single fullscreen fragment shader. Mounted as a
// fixed-position canvas behind the entire UI when the `superBackground`
// feature flag is on.

const VERTEX = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const FRAGMENT = `
precision highp float;
uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform float uAutoCenterRepulsion;
uniform bool uTransparent;
varying vec2 vUv;

#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float Hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}
float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float Star(vec2 uv, float flare) {
  float d = length(uv);
  float m = (0.05 * uGlowIntensity) / d;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * 0.3 * flare * uGlowIntensity;
  m *= smoothstep(1.0, 0.2, d);
  return m;
}
vec3 StarLayer(vec2 uv) {
  vec3 col = vec3(0.0);
  vec2 gv = fract(uv) - 0.5;
  vec2 id = floor(uv);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 si = id + vec2(float(x), float(y));
      float seed = Hash21(si);
      float size = fract(seed * 345.32);
      float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;
      float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 1.0)) + STAR_COLOR_CUTOFF;
      float blu = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 3.0)) + STAR_COLOR_CUTOFF;
      float grn = min(red, blu) * seed;
      vec3 base = vec3(red, grn, blu);
      float hue = atan(base.g - base.r, base.b - base.r) / (2.0 * 3.14159) + 0.5;
      hue = fract(hue + uHueShift / 360.0);
      float sat = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * uSaturation;
      float val = max(max(base.r, base.g), base.b);
      base = hsv2rgb(vec3(hue, sat, val));
      vec2 pad = vec2(tris(seed * 34.0 + uTime * uSpeed / 10.0), tris(seed * 38.0 + uTime * uSpeed / 30.0)) - 0.5;
      float star = Star(gv - offset - pad, flareSize);
      vec3 color = base;
      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      twinkle = mix(1.0, twinkle, uTwinkleIntensity);
      star *= twinkle;
      col += star * size * color;
    }
  }
  return col;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;
  vec2 mouseNorm = uMouse - vec2(0.5);
  if (uAutoCenterRepulsion > 0.0) {
    vec2 centerUV = vec2(0.0, 0.0);
    float centerDist = length(uv - centerUV);
    vec2 repulsion = normalize(uv - centerUV) * (uAutoCenterRepulsion / (centerDist + 0.1));
    uv += repulsion * 0.05;
  } else if (uMouseRepulsion) {
    vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    float mouseDist = length(uv - mousePosUV);
    vec2 repulsion = normalize(uv - mousePosUV) * (uRepulsionStrength / (mouseDist + 0.1));
    uv += repulsion * 0.05 * uMouseActiveFactor;
  } else {
    vec2 mouseOffset = mouseNorm * 0.1 * uMouseActiveFactor;
    uv += mouseOffset;
  }
  float autoRotAngle = uTime * uRotationSpeed;
  mat2 autoRot = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle));
  uv = autoRot * uv;
  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;
  vec3 col = vec3(0.0);
  for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
    float depth = fract(i + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    col += StarLayer(uv * scale + i * 453.32) * fade;
  }
  if (uTransparent) {
    float alpha = length(col);
    alpha = smoothstep(0.0, 0.3, alpha);
    alpha = min(alpha, 1.0);
    gl_FragColor = vec4(col, alpha);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}
`;

interface Handle {
  destroy(): void;
  setMouseEnabled(on: boolean): void;
}

let handle: Handle | null = null;

export function enableGalaxyBackground(opts: { mouse?: boolean } = {}): void {
  if (handle) {
    if (opts.mouse !== undefined) handle.setMouseEnabled(opts.mouse);
    return;
  }
  const mouseEnabled = opts.mouse !== false;

  const host = document.createElement("div");
  host.id = "galaxy-bg";
  // Sit behind the app root. The body.super-bg CSS gives .app a positive
  // stacking context so it paints above this canvas. Without that override
  // a fixed canvas with z-index:0 paints over non-positioned descendants.
  host.style.cssText = `
    position: fixed; inset: 0; z-index: 0;
    pointer-events: none;
  `;
  // Insert as the first child of body so it sits *behind* every UI layer.
  // The app root (#app) sits above with its own background painted from
  // CSS variables — when this is on, we make #app's chrome translucent
  // so the stars show through.
  document.body.insertBefore(host, document.body.firstChild);
  document.body.classList.add("super-bg");

  // Cap the renderer's DPR. The fragment shader is procedural noise — there's
  // no fine detail that benefits from a 2-3x framebuffer on a 4K monitor, and
  // each doubling of DPR quadruples GPU memory + per-frame work. Capping at
  // 1.5 keeps stars crisp while shaving 50-70 % of the framebuffer footprint
  // on high-DPI displays.
  const renderer = new Renderer({
    alpha: true,
    premultipliedAlpha: false,
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
  });
  const gl = renderer.gl;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const canvas = gl.canvas as HTMLCanvasElement;
  canvas.style.cssText = "display:block; width:100%; height:100%;";
  host.appendChild(canvas);

  const targetMouse = { x: 0.5, y: 0.5 };
  const smoothMouse = { x: 0.5, y: 0.5 };
  let targetMouseActive = 0;
  let smoothMouseActive = 0;

  const geometry = new Triangle(gl);
  const program = new Program(gl, {
    vertex: VERTEX,
    fragment: FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uResolution: {
        value: new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height),
      },
      uFocal: { value: new Float32Array([0.5, 0.5]) },
      uRotation: { value: new Float32Array([1.0, 0.0]) },
      uStarSpeed: { value: 0.3 },
      uDensity: { value: 1.2 },
      uHueShift: { value: 240 },
      uSpeed: { value: 0.6 },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uGlowIntensity: { value: 0.4 },
      uSaturation: { value: 0.4 },
      uMouseRepulsion: { value: true },
      uTwinkleIntensity: { value: 0.4 },
      uRotationSpeed: { value: 0.06 },
      uRepulsionStrength: { value: 1.5 },
      uMouseActiveFactor: { value: 0.0 },
      uAutoCenterRepulsion: { value: 0 },
      // Opaque scene: shader writes black where there are no stars. With
      // `uTransparent: true` the canvas was alpha-blended against whatever
      // sits behind it — and the body's `super-bg` style is transparent, so
      // the Tauri webview's default white background bled through, painting
      // the whole galaxy white.
      uTransparent: { value: false },
    },
  });
  const mesh = new Mesh(gl, { geometry, program });

  function resize() {
    const w = host.offsetWidth || window.innerWidth;
    const h = host.offsetHeight || window.innerHeight;
    renderer.setSize(w, h);
    program.uniforms.uResolution.value = new Color(
      gl.canvas.width,
      gl.canvas.height,
      gl.canvas.width / gl.canvas.height,
    );
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  function tick(t: number) {
    raf = requestAnimationFrame(tick);
    program.uniforms.uTime.value = t * 0.001;
    program.uniforms.uStarSpeed.value = (t * 0.001 * 0.3) / 10.0;
    const lerp = 0.05;
    smoothMouse.x += (targetMouse.x - smoothMouse.x) * lerp;
    smoothMouse.y += (targetMouse.y - smoothMouse.y) * lerp;
    smoothMouseActive += (targetMouseActive - smoothMouseActive) * lerp;
    program.uniforms.uMouse.value[0] = smoothMouse.x;
    program.uniforms.uMouse.value[1] = smoothMouse.y;
    program.uniforms.uMouseActiveFactor.value = smoothMouseActive;
    renderer.render({ scene: mesh });
  }
  function startLoop() {
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }
  startLoop();

  // Pause the shader entirely when the document is hidden (window minimized,
  // tab not focused on macOS, system sleep, etc.). Browsers already throttle
  // rAF to ~1 Hz when hidden but the GPU framebuffer + shader still run on
  // every wake-up — explicitly cancelling kills wasted GPU + CPU work.
  function onVisibilityChange() {
    if (document.hidden) stopLoop(); else startLoop();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  function onMouseMove(e: MouseEvent) {
    const rect = host.getBoundingClientRect();
    targetMouse.x = (e.clientX - rect.left) / rect.width;
    targetMouse.y = 1.0 - (e.clientY - rect.top) / rect.height;
    targetMouseActive = 1.0;
  }
  function onMouseLeave() {
    targetMouseActive = 0.0;
  }
  let mouseAttached = false;
  function setMouseEnabled(on: boolean) {
    if (on === mouseAttached) return;
    if (on) {
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseleave", onMouseLeave);
      mouseAttached = true;
    } else {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseleave", onMouseLeave);
      mouseAttached = false;
      // Force-zero the mouse-active factor so the field settles to
      // its un-warped state instead of holding the last position.
      targetMouseActive = 0.0;
      targetMouse.x = 0.5;
      targetMouse.y = 0.5;
    }
  }
  if (mouseEnabled) setMouseEnabled(true);

  handle = {
    setMouseEnabled,
    destroy() {
      stopLoop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setMouseEnabled(false);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      host.remove();
      document.body.classList.remove("super-bg");
    },
  };
}

export function disableGalaxyBackground(): void {
  handle?.destroy();
  handle = null;
}

export function setGalaxyMouseInteraction(on: boolean): void {
  handle?.setMouseEnabled(on);
}

export function isGalaxyActive(): boolean {
  return handle !== null;
}
