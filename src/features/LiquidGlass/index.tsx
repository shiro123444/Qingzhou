'use client';

import { memo, useEffect } from 'react';

import { mountLiquidGlass } from './runtime';
import { mountThreeGlass } from './three/runtime';

/** One compositor registry shared by the app and isolated component previews. */
export const LiquidGlass = memo(() => {
  useEffect(() => {
    const stopFallback = mountLiquidGlass();
    const stopThree = mountThreeGlass();
    return () => {
      stopThree();
      stopFallback();
    };
  }, []);

  return null;
});

export default LiquidGlass;
