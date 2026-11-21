/** Visual lens width is independent from the closed volume's Z thickness. */
export const lensWidth = (width: number, height: number, radius: number) =>
  Math.min(
    Math.max(10, Math.min(24, Math.min(width, height) * 0.08)),
    Math.min(width, height) / 2,
    radius || Infinity,
  );

/** Quintic shoulder: finite slope and zero curvature at both ends of the lens band. */
export const lensProfile = (depth: number, width: number) => {
  const t = Math.max(0, Math.min(1, depth / width));
  return {
    height: 0.35 + 0.65 * t * t * t * (t * (t * 6 - 15) + 10),
    slope: (0.65 * 30 * t * t * (1 - t) * (1 - t)) / width,
  };
};
