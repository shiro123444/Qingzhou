import { motion, type MotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { type RefObject, useEffect, useState } from 'react';

import { springs } from './springs';
import { styles } from './style';

function LensBand({
  src,
  x,
  y,
  zoom,
  width,
  height,
  bend,
  mask,
}: {
  src: string;
  x: MotionValue<number>;
  y: MotionValue<number>;
  zoom: MotionValue<number>;
  width: number;
  height: number;
  bend: number;
  mask?: string;
}) {
  const position = useTransform(
    [x, y, zoom],
    ([px, py, z]) =>
      `${75 - Number(px) * Number(z) * bend}px ${75 - Number(py) * Number(z) * bend}px`,
  );
  const size = useTransform(zoom, (z) => `${width * z * bend}px ${height * z * bend}px`);
  return (
    <motion.div
      className={styles.lensImage}
      style={{
        backgroundImage: `url(${src})`,
        backgroundPosition: position,
        backgroundSize: size,
        maskImage: mask,
      }}
    />
  );
}

/** Magnifies only the authenticated image; never changes remote input coordinates. */
export function GlassLens({
  src,
  viewport,
  enabled,
}: {
  src: string;
  viewport: RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const reduced = useReducedMotion();
  const x = useSpring(0, springs.lensFollow),
    y = useSpring(0, springs.lensFollow);
  const zoom = useSpring(1.7, springs.lensZoom);
  const [inside, setInside] = useState(false),
    [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const element = viewport.current;
    if (!element || !enabled) return;
    const move = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      if (reduced) {
        x.jump(event.clientX - bounds.left);
        y.jump(event.clientY - bounds.top);
      } else {
        x.set(event.clientX - bounds.left);
        y.set(event.clientY - bounds.top);
      }
      setInside(true);
    };
    const leave = () => setInside(false),
      down = () => (reduced ? zoom.jump(2.4) : zoom.set(2.4)),
      up = () => (reduced ? zoom.jump(1.7) : zoom.set(1.7));
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    };
  }, [enabled, reduced, viewport, x, y, zoom]);
  const left = useTransform(x, (v) => v - 75),
    top = useTransform(y, (v) => v - 75);
  if (!enabled) return null;
  return (
    <motion.div
      aria-hidden
      data-glass-lens
      className={styles.lens}
      style={{ x: left, y: top, opacity: inside ? 1 : 0 }}
    >
      <LensBand
        bend={1}
        height={size.height}
        src={src}
        width={size.width}
        x={x}
        y={y}
        zoom={zoom}
      />
      <LensBand
        bend={1.05}
        height={size.height}
        mask="radial-gradient(circle, transparent 52%, #000 74%)"
        src={src}
        width={size.width}
        x={x}
        y={y}
        zoom={zoom}
      />
      <LensBand
        bend={1.12}
        height={size.height}
        mask="radial-gradient(circle, transparent 74%, #000 90%)"
        src={src}
        width={size.width}
        x={x}
        y={y}
        zoom={zoom}
      />
    </motion.div>
  );
}
