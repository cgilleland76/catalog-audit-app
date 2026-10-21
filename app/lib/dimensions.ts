// Packed product size (length × width × height), compared and fixed in inches.
// Shared by the server code and the pages.

export type Dims = { length: number; width: number; height: number };

/** Inches per Shopify length unit. */
export const TO_IN: Record<string, number> = {
  INCHES: 1,
  FEET: 12,
  YARDS: 36,
  CENTIMETERS: 1 / 2.54,
  MILLIMETERS: 1 / 25.4,
  METERS: 39.3700787,
};

/** Dims with every side above zero, else null (Shopify returns zeros when unset). */
export function validDims(d: Partial<Dims> | null | undefined): Dims | null {
  if (!d) return null;
  const { length, width, height } = d;
  return [length, width, height].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ? { length: length!, width: width!, height: height! }
    : null;
}

/** Converts Shopify's packed dimensions to inches; null when unset. */
export function inchesOf(d: { length: number; width: number; height: number; unit?: string | null } | null | undefined) {
  if (!d) return null;
  const k = TO_IN[d.unit ?? "INCHES"] ?? 1;
  return validDims({ length: d.length * k, width: d.width * k, height: d.height * k });
}

const hundredths = (n: number) => Math.round(n * 100);

/** Same size to the hundredth of an inch on every side. */
export const sameDims = (a: Dims | null, b: Dims | null) =>
  !a || !b
    ? a === b
    : hundredths(a.length) === hundredths(b.length) &&
      hundredths(a.width) === hundredths(b.width) &&
      hundredths(a.height) === hundredths(b.height);

const side = (n: number) => String(Number(n.toFixed(2)));

/** "11.5 × 7.6 × 3.45 in", or "—" when unset. */
export const formatDims = (d: Dims | null) =>
  d ? `${side(d.length)} × ${side(d.width)} × ${side(d.height)} in` : "—";
