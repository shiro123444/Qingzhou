'use client';

import { memo, useEffect } from 'react';

import { mountLiquidGlass } from './runtime';

/** One compositor registry shared by the app and isolated component previews. */
export const LiquidGlass = memo(() => {
  useEffect(() => mountLiquidGlass(), []);

  return null;
});

export default LiquidGlass;
