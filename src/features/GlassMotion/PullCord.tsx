import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { springs } from './springs';
import { styles } from './style';

/** Reference rope: 12 links, 9px each, gravity 2600, 8 constraint passes. */
export function PullCord({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const reduced = useReducedMotion(),
    gradientId = useId();
  const [moving, setMoving] = useState(false);
  const swing = useSpring(0, springs.cordSwing),
    tug = useSpring(0, springs.cordTug),
    stretch = useSpring(1, springs.cordRelease);
  const points = useRef(Array.from({ length: 13 }, (_, i) => ({ x: 21, y: i * 9, vx: 0, vy: 0 })));
  const held = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const suppressClick = useRef(false),
    pulled = useRef(false);
  const path = useMotionValue('M21 0L21 108'),
    beadX = useMotionValue(0),
    beadY = useMotionValue(108);
  useEffect(() => {
    if (!moving || reduced) return;
    let raf = 0,
      previous = 0,
      settled = 0;
    const frame = (now: number) => {
      const dt = Math.min((now - (previous || now - 16)) / 1000, 1 / 30);
      previous = now;
      const pts = points.current,
        pin = held.current,
        end = pts[12];
      const ax = 21 + swing.get(),
        ay = tug.get();
      let px = end.x,
        py = end.y;
      if (pin) {
        const dx = pin.x - ax,
          dy = pin.y - ay,
          distance = Math.hypot(dx, dy) || 1;
        const give = 54 * (1 - Math.exp(-Math.max(0, distance - 108) / 70));
        const radius = Math.min(distance, 108) + give;
        px = ax + (dx / distance) * radius;
        py = ay + (dy / distance) * radius;
        stretch.jump(Math.max(1, radius / 108));
        tug.set(give * 0.22);
        swing.set(Math.max(-12, Math.min(12, (-dx / distance) * give * 0.25)));
      } else {
        stretch.set(1);
        tug.set(0);
        swing.set(0);
      }
      const before = pts.map((point) => [point.x, point.y]);
      for (let i = 1; i <= 12; i++) {
        const point = pts[i],
          damping = Math.exp(-(i === 12 ? 1.1 : 2.4) * dt);
        point.vy += 2600 * dt;
        point.vx *= damping;
        point.vy *= damping;
        const speed = Math.hypot(point.vx, point.vy);
        if (speed > 2600) {
          point.vx *= 2600 / speed;
          point.vy *= 2600 / speed;
        }
        point.x += point.vx * dt;
        point.y += point.vy * dt;
      }
      for (let iteration = 0; iteration < 8; iteration++) {
        pts[0].x = ax;
        pts[0].y = ay;
        if (pin) {
          end.x = px;
          end.y = py;
        }
        for (let i = 0; i < 12; i++) {
          const a = pts[i],
            b = pts[i + 1],
            dx = b.x - a.x,
            dy = b.y - a.y;
          const correction =
            (Math.hypot(dx, dy) - 9 * Math.max(1, stretch.get())) / (Math.hypot(dx, dy) || 1e-6);
          const wa = i === 0 ? 0 : 1,
            wb = i === 11 ? (pin ? 0 : 0.3) : 1,
            sum = wa + wb || 1;
          a.x += (dx * correction * wa) / sum;
          a.y += (dy * correction * wa) / sum;
          b.x -= (dx * correction * wb) / sum;
          b.y -= (dy * correction * wb) / sum;
        }
      }
      pts[0].x = ax;
      pts[0].y = ay;
      if (pin) {
        end.x = px;
        end.y = py;
      }
      let speed = 0;
      for (let i = 1; i <= 12; i++) {
        pts[i].vx = (pts[i].x - before[i][0]) / dt;
        pts[i].vy = (pts[i].y - before[i][1]) / dt;
        speed += Math.hypot(pts[i].vx, pts[i].vy);
      }
      path.set(
        pts
          .map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
          .join(' '),
      );
      beadX.set(end.x - 21);
      beadY.set(end.y);
      settled = !pin && speed < 3 ? settled + 1 : 0;
      if (settled < 20) raf = requestAnimationFrame(frame);
      else setMoving(false);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [moving, reduced, swing, tug, stretch, path, beadX, beadY]);
  const release = () => {
    const pin = held.current;
    if (!pin) return;
    if (pulled.current) {
      suppressClick.current = true;
      onToggle();
    }
    held.current = null;
    pulled.current = false;
  };
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className={styles.cord}
      title={label}
      type="button"
      onPointerUp={release}
      onClick={() => {
        if (!suppressClick.current) {
          tug.set(8);
          setMoving(true);
          onToggle();
        }
        suppressClick.current = false;
      }}
      onPointerCancel={() => {
        held.current = null;
        pulled.current = false;
        suppressClick.current = true;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        suppressClick.current = false;
        pulled.current = false;
        const end = points.current[12];
        held.current = { x: end.x, y: end.y, startX: event.clientX, startY: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setMoving(true);
      }}
      onPointerMove={(event) => {
        const pin = held.current;
        if (!pin) return;
        const dy = event.clientY - pin.startY;
        pin.x = 21 + event.clientX - pin.startX;
        pin.y = 108 + Math.max(0, dy);
        pulled.current = dy > 22;
      }}
    >
      <svg aria-hidden viewBox="0 0 42 132">
        <defs>
          <linearGradient id={gradientId} x2="1" y2="1">
            <stop stopColor="#e2efeb" />
            <stop offset=".5" stopColor="#8eaaa5" />
            <stop offset="1" stopColor="#48635e" />
          </linearGradient>
        </defs>
        <motion.path
          d={reduced ? 'M21 0V108' : path}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <motion.g style={{ x: reduced ? 0 : beadX, y: reduced ? 108 : beadY }}>
          <rect
            fill={`url(#${gradientId})`}
            height="20"
            rx="7"
            stroke="#ffffff80"
            width="14"
            x="14"
          />
          <path
            d={expanded ? 'M18 12l3-3 3 3' : 'M18 8l3 3 3-3'}
            fill="none"
            stroke="#fff"
            strokeLinecap="round"
          />
        </motion.g>
      </svg>
    </button>
  );
}
