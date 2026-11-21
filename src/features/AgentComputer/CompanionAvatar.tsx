import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { type MotionValue, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { Component, type PropsWithChildren, useEffect, useMemo, useRef } from 'react';
import type { Group } from 'three';
import { CatmullRomCurve3, LatheGeometry, Vector2, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { springs } from '@/features/GlassMotion/springs';

import type { CompanionState } from './companionState';

export interface CompanionGaze {
  x: MotionValue<number>;
  y: MotionValue<number>;
}

/** A single turned ceramic shell: full cheeks, a narrow crown, soft foot. */
function Figure({
  state,
  reduced,
  gaze,
  tracking,
}: {
  state: CompanionState;
  reduced: boolean;
  gaze?: CompanionGaze;
  tracking: boolean;
}) {
  const upper = useRef<Group>(null),
    eyes = useRef<Group>(null),
    torso = useRef<Group>(null);
  const zero = useMotionValue(0);
  const hx = useSpring(gaze?.x ?? zero, springs.trail),
    hy = useSpring(gaze?.y ?? zero, springs.trail);
  const ex = useSpring(gaze?.x ?? zero, springs.lead),
    ey = useSpring(gaze?.y ?? zero, springs.lead);
  const blink = useSpring(1, springs.lead),
    breath = useSpring(0, { stiffness: 28, damping: 10 });
  const sleepy = state === 'sleeping' || state === 'unavailable';
  const curious = state === 'approval' || state === 'queued';
  const focused = state === 'thinking' || state === 'working';
  const shape = useMemo(() => {
    const curve = new CatmullRomCurve3(
      [
        [0, -0.59],
        [0.42, -0.55],
        [0.64, -0.31],
        [0.68, 0.02],
        [0.6, 0.36],
        [0.4, 0.57],
        [0, 0.65],
      ].map(([x, y]) => new Vector3(x, y, 0)),
    );
    return new LatheGeometry(
      curve.getPoints(48).map(({ x, y }) => new Vector2(Math.max(0, x), y)),
      64,
    );
  }, []);
  const pill = useMemo(() => new RoundedBoxGeometry(1, 1, 1, 6, 0.42), []);
  useEffect(
    () => () => {
      shape.dispose();
      pill.dispose();
    },
    [shape, pill],
  );
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const stops = [hx, hy, ex, ey, blink, breath].map((v) => v.on('change', invalidate));
    return () => stops.forEach((stop) => stop());
  }, [hx, hy, ex, ey, blink, breath, invalidate]);
  useEffect(() => {
    let next: ReturnType<typeof setTimeout>,
      release: ReturnType<typeof setTimeout>,
      settle: ReturnType<typeof setTimeout>;
    const cycle = () => {
      next = setTimeout(
        () => {
          if (!document.hidden) {
            blink.set(0.03);
            release = setTimeout(() => blink.set(1), 105);
            breath.set(1);
            settle = setTimeout(() => breath.set(0), 780);
          }
          cycle();
        },
        2800 + Math.random() * 2200,
      );
    };
    if (tracking && !reduced) cycle();
    else {
      blink.jump(1);
      breath.jump(0);
    }
    invalidate();
    return () => {
      clearTimeout(next);
      clearTimeout(release);
      clearTimeout(settle);
    };
  }, [tracking, reduced, blink, breath, invalidate]);
  useFrame(() => {
    const follow = tracking && !reduced,
      x = follow ? hx.get() : 0,
      y = follow ? hy.get() : 0,
      b = follow ? breath.get() : 0;
    upper.current!.rotation.set(
      0.055 + y * 0.22 + (sleepy ? 0.14 : 0),
      -0.09 + x * 0.39,
      (curious ? 0.12 : 0.035) - x * 0.09,
    );
    upper.current!.position.y = 0.39 + b * 0.035;
    torso.current!.rotation.y = x * 0.13;
    torso.current!.scale.y = 1 + b * 0.026;
    eyes.current!.position.set((follow ? ex.get() : 0) * 0.07, (follow ? -ey.get() : 0) * 0.046, 0);
  });
  const lid = useRef<Group>(null);
  useFrame(() => {
    lid.current!.scale.y = (reduced ? 1 : blink.get()) * (sleepy ? 0.45 : focused ? 0.83 : 1);
  });
  return (
    <group position={[0, 0.02, 0]}>
      <group position={[0, -0.39, 0]} ref={torso}>
        <mesh geometry={shape} scale={[0.66, 0.8, 0.56]}>
          <meshPhysicalMaterial
            clearcoat={0.72}
            clearcoatRoughness={0.22}
            color="#72a79a"
            roughness={0.38}
          />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh
            geometry={pill}
            key={side}
            position={[side * 0.429, -0.01, 0.085]}
            rotation={[0.16, 0, side * 0.27]}
            scale={[0.205, 0.45, 0.25]}
          >
            <meshPhysicalMaterial clearcoat={0.68} color="#9ec5b6" roughness={0.36} />
          </mesh>
        ))}
      </group>
      {[-1, 1].map((side) => (
        <mesh
          geometry={pill}
          key={side}
          position={[side * 0.214, -0.83, 0.09]}
          scale={[0.34, 0.22, 0.46]}
        >
          <meshStandardMaterial color="#729587" roughness={0.38} />
        </mesh>
      ))}
      <group position={[0, 0.39, 0]} ref={upper}>
        <mesh geometry={shape} scale={[1, 1, 0.85]}>
          <meshPhysicalMaterial
            clearcoat={0.86}
            clearcoatRoughness={0.18}
            color="#a4cfc0"
            roughness={0.32}
          />
        </mesh>
        <mesh position={[0, -0.025, 0.422]} scale={[0.559, 0.439, 0.215]}>
          <sphereGeometry args={[1, 48, 32]} />
          <meshPhysicalMaterial clearcoat={0.23} color="#f3e7ca" roughness={0.54} />
        </mesh>
        <group ref={eyes}>
          <group ref={lid}>
            {[-1, 1].map((side) => (
              <group
                key={side}
                position={[side * 0.207, 0.049, 0.627]}
                rotation={[0, side * 0.13, 0]}
              >
                <mesh scale={[0.061, 0.084, 0.034]}>
                  <sphereGeometry args={[1, 24, 16]} />
                  <meshPhysicalMaterial clearcoat={1} color="#112e2a" roughness={0.18} />
                </mesh>
                <mesh position={[-0.018, 0.027, 0.029]} scale={[0.017, 0.019, 0.009]}>
                  <sphereGeometry args={[1, 12, 8]} />
                  <meshBasicMaterial color="#ffffeb" />
                </mesh>
              </group>
            ))}
          </group>
        </group>
        <mesh position={[0, -0.1, 0.638]} rotation={[0, 0, Math.PI * 1.15]}>
          <torusGeometry args={[curious ? 0.044 : 0.068, 0.012, 8, 32, Math.PI * 0.7]} />
          <meshStandardMaterial color="#564238" />
        </mesh>
      </group>
    </group>
  );
}

class CanvasBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <span aria-hidden style={{ fontSize: 36 }}>
        ◈
      </span>
    ) : (
      this.props.children
    );
  }
}

export default function CompanionAvatar({
  state,
  gaze,
  tracking = true,
}: {
  state: CompanionState;
  gaze?: CompanionGaze;
  tracking?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <CanvasBoundary>
      <Canvas
        aria-hidden
        camera={{ position: [0, 0.4, 5], fov: 34 }}
        dpr={[1, 1.5]}
        frameloop="demand"
        gl={{ alpha: true, antialias: true }}
      >
        <hemisphereLight args={['#fff4dc', '#608c82', 1.8]} />
        <directionalLight color="#ffeedb" intensity={2.8} position={[-3, 5, 4]} />
        <directionalLight color="#d5eadf" intensity={1.8} position={[3, 3, -2]} />
        <Figure
          gaze={gaze}
          reduced={!!reduced}

          state={state}
          tracking={tracking}
        />
      </Canvas>
    </CanvasBoundary>
  );
}
