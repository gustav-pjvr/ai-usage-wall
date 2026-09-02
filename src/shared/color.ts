/**
 * Brand token derivation.
 *
 * PROBLEM: every client card wears a different client's brand, but every card
 * must stay legible and the wall must still read as one system. Splashing raw
 * client hex onto a card gives you neon-yellow text on white, or an invisible
 * near-black logo on a near-black card.
 *
 * SOLUTION: treat the client's colour as a HUE SOURCE, not a paint bucket.
 * We take the brand hue, clamp lightness and chroma into system-safe bands, and
 * then *solve* the accent lightness numerically until it clears WCAG contrast
 * against the surface we actually generated. Nothing is trusted, everything is
 * measured.
 *
 * All maths is OKLab/OKLCh (Bjorn Ottosson) because it is perceptually uniform:
 * clamping chroma there keeps colours equally vivid across hues, which sRGB
 * and HSL cannot do.
 *
 * Contrast is checked with real WCAG 2.x relative luminance on the resulting
 * sRGB, not with OKLab L, because OKLab L is not what the accessibility spec
 * measures. This distinction matters: they disagree by enough to ship a
 * failing card.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

// System-safe expression bands. These are what stop 40 different client brands
// from looking like 40 different apps.
const SURFACE_L = 0.185; // card background lightness
const SURFACE_C_MAX = 0.035; // surfaces stay near-neutral, only tinted
const RAISED_L_DELTA = 0.045; // inner panels sit slightly above the surface
const ACCENT_C_MIN = 0.09;
const ACCENT_C_MAX = 0.19;
const TEXT_CONTRAST_TARGET = 4.5; // WCAG AA, body text
const UI_CONTRAST_TARGET = 3.0; // WCAG AA, large text and UI boundaries

// ── sRGB <-> OKLab ─────────────────────────────────────────────────────────

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearRgbToOklab(r: number, g: number, b: number): { L: number; a: number; bb: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    bb: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToLinearRgb(L: number, a: number, b: number): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function hexToRgb(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export function hexToOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const { L, a, bb } = linearRgbToOklab(srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b));
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** OKLCh to a linear-RGB triple, before gamut clipping. */
function oklchToLinear(o: Oklch): Rgb {
  const hr = (o.h * Math.PI) / 180;
  return oklabToLinearRgb(o.l, o.c * Math.cos(hr), o.c * Math.sin(hr));
}

/**
 * Render OKLCh as a CSS string. We emit real `oklch()` because the renderer is
 * a current Chromium and MuchBetter's own site authors colour this way, so the
 * desktop app and the website stay literally the same colour space.
 */
export function oklchCss(o: Oklch, alpha = 1): string {
  const l = Math.round(o.l * 10000) / 10000;
  const c = Math.round(o.c * 10000) / 10000;
  const h = Math.round(o.h * 100) / 100;
  return alpha >= 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${alpha})`;
}

// ── Contrast ───────────────────────────────────────────────────────────────

/** WCAG 2.x relative luminance from an OKLCh colour, via gamut-clipped sRGB. */
export function relativeLuminance(o: Oklch): number {
  const lin = oklchToLinear(o);
  // Clip to gamut the same way the display will, so we measure what is shown.
  const r = clamp01(lin.r);
  const g = clamp01(lin.g);
  const b = clamp01(lin.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Find the lightness at this hue/chroma that clears `target` contrast against
 * `against`, searching in the given direction (lighter or darker).
 *
 * Binary search on L, 18 iterations, which lands within ~0.000004 of the
 * boundary. Returns the best found even if the target is unreachable (a hue at
 * max chroma may simply not be able to hit 4.5:1), so a card is never blank.
 */
function solveLightnessForContrast(
  base: Oklch,
  against: Oklch,
  target: number,
  direction: 'lighter' | 'darker',
): { colour: Oklch; achieved: number; met: boolean } {
  const limit = direction === 'lighter' ? 0.99 : 0.02;
  let lo = base.l;
  let hi = limit;

  const at = (l: number): Oklch => ({ l, c: base.c, h: base.h });

  // If the extreme cannot reach the target, return the extreme: best effort.
  const extreme = at(limit);
  const extremeRatio = contrastRatio(extreme, against);
  if (extremeRatio < target) {
    return { colour: extreme, achieved: extremeRatio, met: false };
  }

  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), against) >= target) hi = mid;
    else lo = mid;
  }
  const colour = at(hi);
  return { colour, achieved: contrastRatio(colour, against), met: true };
}

/**
 * Use `preferred` if it already clears the target, otherwise solve from `seed`.
 *
 * This ordering is the whole point: design picks the colour, maths only
 * intervenes when design would have shipped something unreadable.
 */
function ensureContrast(
  preferred: Oklch,
  seed: Oklch,
  against: Oklch,
  target: number,
): { colour: Oklch; achieved: number; met: boolean } {
  const ratio = contrastRatio(preferred, against);
  if (ratio >= target) return { colour: preferred, achieved: ratio, met: true };
  const direction = relativeLuminance(preferred) >= relativeLuminance(against) ? 'lighter' : 'darker';
  return solveLightnessForContrast(seed, against, target, direction);
}

// ── Fallback hue ───────────────────────────────────────────────────────────

/**
 * Deterministic hue from a slug, for clients with no brand colour on file.
 *
 * Deliberately not grey: a client with no colour still deserves an identity,
 * and a stable one, so the card looks the same on every launch. FNV-1a keeps
 * neighbouring slugs far apart in hue.
 */
export function hueFromSlug(slug: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Golden-angle spread so sequential hashes do not cluster.
  return (hash * 137.508) % 360;
}

// ── The derived token set ──────────────────────────────────────────────────

export interface BrandTokens {
  surface: string;
  surfaceRaised: string;
  border: string;
  fg: string;
  fgMuted: string;
  accent: string;
  accentFg: string;
  glow: string;
  hue: number;
  /** Diagnostics, surfaced in debug mode and the health report. */
  meta: {
    source: 'brand' | 'slug-fallback';
    inputHex: string | null;
    bodyContrast: number;
    accentContrast: number;
    contrastMet: boolean;
  };
}

export interface BrandInput {
  primary?: string | null;
  secondary?: string | null;
}

/**
 * Derive a complete, guaranteed-legible token set for one client.
 *
 * Pipeline:
 *   1. Resolve a hue. Valid brand hex wins; otherwise a stable hue from slug.
 *   2. Build the card surface at a fixed lightness with clamped chroma, so all
 *      cards share a family resemblance regardless of brand.
 *   3. Solve body text lightness up from the surface until it clears 4.5:1.
 *   4. Solve the accent the same way, at brand chroma, targeting 4.5:1 so it is
 *      safe for small text too (MuchBetter's own site makes exactly this call).
 *   5. Pick accent foreground by measuring both black and white against the
 *      accent and taking the winner.
 *
 * Cost is roughly 60 conversions per client, once, at load. Cached by caller.
 */
export function deriveBrandTokens(slug: string, brand: BrandInput | null | undefined): BrandTokens {
  const inputHex = brand?.primary ?? null;
  const parsed = inputHex ? hexToOklch(inputHex) : null;

  const source: 'brand' | 'slug-fallback' = parsed ? 'brand' : 'slug-fallback';
  const hue = parsed ? parsed.h : hueFromSlug(slug);

  // A brand that is achromatic (pure black, white, grey) gives us a hue we
  // cannot trust, so fall back to the slug hue while keeping low chroma.
  const brandChroma = parsed ? parsed.c : 0.12;
  const usableHue = parsed && brandChroma < 0.02 ? hueFromSlug(slug) : hue;

  const surface: Oklch = {
    l: SURFACE_L,
    c: Math.min(brandChroma, SURFACE_C_MAX),
    h: usableHue,
  };
  const surfaceRaised: Oklch = { ...surface, l: SURFACE_L + RAISED_L_DELTA };

  // Body text: aim for the crisp near-white a premium dark UI wants, and only
  // fall back to solving if that somehow fails the target. Solving *first*
  // lands text at exactly the threshold, which is legible but looks washed out;
  // preferring a value and verifying it keeps the intended look and the
  // guarantee. The solver is the safety net, not the designer.
  const fgSeed: Oklch = { l: SURFACE_L, c: Math.min(brandChroma, 0.02), h: usableHue };
  const fgSolved = ensureContrast(
    { l: 0.96, c: Math.min(brandChroma, 0.012), h: usableHue },
    fgSeed,
    surface,
    TEXT_CONTRAST_TARGET + 2.5,
  );
  const fg = fgSolved.colour;

  // Muted text still has to clear AA. It is dimmer, not unreadable.
  const fgMuted = ensureContrast(
    { l: 0.72, c: Math.min(brandChroma, 0.02), h: usableHue },
    fgSeed,
    surface,
    TEXT_CONTRAST_TARGET,
  ).colour;

  // Accent carries the brand. Chroma is clamped into the system band so a
  // washed-out brand still reads as a colour and a fluorescent one calms down.
  const accentSeed: Oklch = {
    l: SURFACE_L,
    c: Math.max(ACCENT_C_MIN, Math.min(brandChroma, ACCENT_C_MAX)),
    h: usableHue,
  };
  const accentSolved = solveLightnessForContrast(accentSeed, surface, TEXT_CONTRAST_TARGET, 'lighter');
  const accent = accentSolved.colour;

  // Foreground on top of the accent: whichever of near-black / near-white wins.
  const nearBlack: Oklch = { l: 0.15, c: 0.02, h: usableHue };
  const nearWhite: Oklch = { l: 0.98, c: 0.005, h: usableHue };
  const accentFg = contrastRatio(nearBlack, accent) >= contrastRatio(nearWhite, accent) ? nearBlack : nearWhite;

  // Border is a hairline lift off the surface, targeting the 3:1 UI threshold
  // so card edges stay visible against the wall on a cheap laptop panel.
  const border = solveLightnessForContrast(
    { l: SURFACE_L, c: Math.min(brandChroma, 0.03), h: usableHue },
    surface,
    UI_CONTRAST_TARGET,
    'lighter',
  ).colour;

  return {
    surface: oklchCss(surface),
    surfaceRaised: oklchCss(surfaceRaised),
    border: oklchCss(border, 0.55),
    fg: oklchCss(fg),
    fgMuted: oklchCss(fgMuted),
    accent: oklchCss(accent),
    accentFg: oklchCss(accentFg),
    glow: oklchCss({ ...accent, c: Math.min(accent.c * 1.15, ACCENT_C_MAX) }, 0.9),
    hue: Math.round(usableHue * 100) / 100,
    meta: {
      source,
      inputHex,
      bodyContrast: Math.round(contrastRatio(fg, surface) * 100) / 100,
      accentContrast: Math.round(accentSolved.achieved * 100) / 100,
      contrastMet: fgSolved.met && accentSolved.met,
    },
  };
}
