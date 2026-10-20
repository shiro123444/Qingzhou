import { z } from 'zod';

const point = z.tuple([z.number().finite(), z.number().finite()]);
export const quadraticPlotSchema = z
  .object({
    type: z.literal('quadratic'),
    // f(x,y) = (a*x²+b*y²)/2. Positive diagonal Hessian.
    a: z.number().positive().max(1e6),
    b: z.number().positive().max(1e6),
    levels: z.array(z.number().positive().max(1e8)).min(1).max(3),
    start: point,
    learningRate: z.number().positive().max(10),
    momentum: z.number().min(0).max(0.999).default(0.9),
    steps: z.number().int().min(1).max(100).default(20),
    methods: z
      .array(z.enum(['gradient', 'momentum', 'nesterov']))
      .min(1)
      .max(3),
  })
  .strict();

export const taylorPlotSchema = z
  .object({
    type: z.literal('taylor'),
    coefficients: z.array(z.number().finite()).min(2).max(7),
    at: z.number().finite(),
    xRange: point.refine(([a, b]) => b > a),
  })
  .strict();

type Series = {
  label: string;
  points: [number, number][];
  polynomial?: never;
  color?: string;
  arrowEnd?: boolean;
};
const evaluate = (c: number[], x: number) => c.reduceRight((y, a) => y * x + a, 0);
const derivative = (c: number[]) => c.slice(1).map((a, i) => a * (i + 1));
const polynomialLabel = (coefficients: number[]): string => {
  const terms = coefficients.flatMap((value, power) => {
    if (value === 0) return [];
    const variable = power === 0 ? '' : power === 1 ? 'x' : `x${'⁰¹²³⁴⁵⁶'[power] ?? `^${power}`}`;
    return [`${value}${variable}`];
  });
  return terms.length ? terms.join(' + ').replaceAll('+ -', '- ') : '0';
};

/** Reproducible recipes, not model-authored point clouds masquerading as experiments. */
export function computeScientificPlot(
  raw: z.input<typeof quadraticPlotSchema> | z.input<typeof taylorPlotSchema>,
) {
  const series: Series[] = [];
  let caption: string;
  let equalAspect = false;
  if (raw.type === 'quadratic') {
    const s = quadraticPlotSchema.parse(raw);
    equalAspect = true;
    for (const level of s.levels) {
      series.push({
        label: `L=${level}`,
        color: '#94a3b8',
        points: Array.from({ length: 121 }, (_, i) => {
          const angle = (i * 2 * Math.PI) / 120;
          return [
            Math.sqrt((2 * level) / s.a) * Math.cos(angle),
            Math.sqrt((2 * level) / s.b) * Math.sin(angle),
          ];
        }),
      });
    }
    for (const method of new Set(s.methods)) {
      let [x, y] = s.start;
      let vx = 0,
        vy = 0;
      const points: [number, number][] = [[x, y]];
      for (let step = 0; step < s.steps; step++) {
        const lookX = method === 'nesterov' ? x - s.learningRate * s.momentum * vx : x;
        const lookY = method === 'nesterov' ? y - s.learningRate * s.momentum * vy : y;
        vx = (method === 'gradient' ? 0 : s.momentum * vx) + s.a * lookX;
        vy = (method === 'gradient' ? 0 : s.momentum * vy) + s.b * lookY;
        x -= s.learningRate * vx;
        y -= s.learningRate * vy;
        if (![x, y].every((v) => Number.isFinite(v) && Math.abs(v) < 1e8))
          throw new Error(
            'Simulation diverges beyond a readable range; choose fewer steps or explicitly explain instability.',
          );
        points.push([x, y]);
      }
      series.push({
        label: method === 'gradient' ? 'GD' : method === 'momentum' ? 'Polyak' : 'NAG',
        points,
        arrowEnd: true,
      });
    }
    caption = `计算示例：L=(${s.a}x²+${s.b}y²)/2；η=${s.learningRate}${s.methods.some((method) => method !== 'gradient') ? `；β=${s.momentum}` : ''}；${s.steps}步`;
  } else {
    const s = taylorPlotSchema.parse(raw);
    const f = evaluate(s.coefficients, s.at);
    const df = evaluate(derivative(s.coefficients), s.at);
    const ddf = evaluate(derivative(derivative(s.coefficients)), s.at);
    // A quadratic equals its second-order Taylor polynomial exactly. Drawing
    // both on top of each other hides the original curve while showing a
    // misleading extra legend entry.
    const visibleOrders = s.coefficients.slice(3).every((coefficient) => coefficient === 0)
      ? ([0, 1] as const)
      : ([0, 1, 2] as const);
    for (const order of visibleOrders) {
      const label = ['f(x)', 'T₁(x)', 'T₂(x)'][order];
      series.push({
        label,
        points: Array.from({ length: 121 }, (_, i) => {
          const x = s.xRange[0] + ((s.xRange[1] - s.xRange[0]) * i) / 120;
          const dx = x - s.at;
          return [
            x,
            order === 0
              ? evaluate(s.coefficients, x)
              : f + df * dx + (order === 2 ? (ddf * dx * dx) / 2 : 0),
          ];
        }),
      });
    }
    caption = `计算示例：f(x)=${polynomialLabel(s.coefficients)}；展开点 x=${s.at}`;
  }
  const points = series.flatMap((s) => s.points);
  if (points.some((p) => p.some((v) => !Number.isFinite(v))))
    throw new Error('Non-finite computed plot');
  const range = (axis: number): [number, number] => {
    const min = Math.min(...points.map((p) => p[axis])),
      max = Math.max(...points.map((p) => p[axis]));
    const margin = Math.max((max - min) * 0.08, 0.1);
    return [min - margin, max + margin];
  };
  return {
    type: 'plot' as const,
    xRange: range(0),
    yRange: range(1),
    xLabel: 'x',
    yLabel: 'y',
    equalAspect,
    series,
    caption,
  };
}
