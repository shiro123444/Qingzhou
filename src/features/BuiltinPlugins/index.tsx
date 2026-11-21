'use client';

import { type ComponentType, lazy, type PropsWithChildren, Suspense } from 'react';
import { Navigate } from 'react-router-dom';

import { type BuiltinPluginId } from '@/config/builtinPlugins';
import { useBuiltinPluginEnabled } from '@/hooks/useBuiltinPluginEnabled';
import { builtinPluginSelectors, useServerConfigStore } from '@/store/serverConfig';

export function BuiltinPluginBoundary({
  children,
  id,
}: PropsWithChildren<{ id: BuiltinPluginId }>) {
  const ready = useServerConfigStore(builtinPluginSelectors.ready);
  const enabled = useBuiltinPluginEnabled(id);
  if (!ready) return null;
  return enabled ? children : <Navigate replace to="/" />;
}

/** The lazy child is never rendered (and therefore never imported) when disabled. */
export const builtinPluginElement = (
  id: BuiltinPluginId,
  load: () => Promise<{ default: ComponentType }>,
  debugId?: string,
) => {
  const Page = lazy(load);
  return (
    <BuiltinPluginBoundary id={id}>
      <Suspense fallback={<span aria-busy="true" data-qz-plugin-loading={debugId ?? id} />}>
        <Page />
      </Suspense>
    </BuiltinPluginBoundary>
  );
};
