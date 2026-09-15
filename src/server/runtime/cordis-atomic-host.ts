/**
 * QZ-CORDIS-C — CordisAtomicHost.
 *
 * Lets {@link AtomicRuntime}-style plugin manifests (which register tools) mount
 * onto the *real* upstream Cordis Context/Fiber, while the existing
 * {@link ToolRegistry} keeps owning registration, staging and execution.
 *
 * No Fiber state machine, EventBus or DI container is reimplemented here: every
 * lifecycle concern is delegated to the vendored Cordis foundation
 * (`packages/cordis-foundation`, re-exporting `@deepseek-ai/cordis` 4.0.2).
 */

import * as Cordis from '../../../packages/cordis-foundation/src';
import { ToolRegistry } from '../../../packages/cordis-kernel/src';
import type {
  Disposable,
  Effect,
  Fiber as KernelFiber,
  FiberState as KernelFiberState,
  Listener,
  RuntimeContext,
  RuntimePluginManifest,
  ScopeKey,
} from '../../../packages/cordis-kernel/src/types';

type NativeContext = Cordis.Context;
type NativeFiber = Cordis.Fiber;

/**
 * Ordinal mapping of the vendored `FiberState`
 * (`packages/cordis-foundation/vendor/cordis/src/fiber.ts`, PENDING, LOADING,
 * ACTIVE, FAILED, DISPOSED, UNLOADING). The enum is a `const enum` whose runtime
 * shape is not guaranteed once re-exported across packages, so the ordinals are
 * mirrored here instead of importing the member values.
 */
const NATIVE_FIBER_STATE: Record<number, KernelFiberState> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

const mapFiberState = (state: unknown): KernelFiberState =>
  typeof state === 'number' ? (NATIVE_FIBER_STATE[state] ?? 'pending') : 'pending';

/**
 * The single isolated read of upstream's private `_error` field. Upstream
 * exposes no public fiber-error accessor; keep every such read here.
 */
const readNativeFiberError = (fiber: NativeFiber | undefined): unknown =>
  (fiber as unknown as { _error?: unknown } | undefined)?._error;

export interface CordisAtomicHostOptions {
  /** Injected for tests; defaults to a fresh root context. */
  readonly native?: NativeContext;
  /** Names isolated by withScope(); all other services remain host-wide. */
  readonly scopedServices?: readonly string[];
  readonly tools?: ToolRegistry;
}

/** Extend this map when a platform service gains a stable public contract. */
export interface CordisHostServices {
  'cordis.tools': ToolRegistry;
}

export interface CordisServiceContext extends RuntimeContext {
  get: (<K extends keyof CordisHostServices>(name: K) => CordisHostServices[K] | undefined) &
    (<T = unknown>(name: string) => T | undefined);
  has: (name: string) => boolean;
  plugin: (
    manifest: CordisServicePluginManifest,
    config?: unknown,
    isStaging?: boolean,
  ) => Promise<KernelFiber>;
  readonly root: CordisServiceContext;
  withScope: (scope: ScopeKey) => CordisServiceContext;
}

export interface CordisServicePluginManifest extends Omit<RuntimePluginManifest, 'apply'> {
  apply: (
    context: CordisServiceContext,
    config?: unknown,
  ) => ReturnType<RuntimePluginManifest['apply']>;
}

export interface CordisAtomicInstance {
  readonly context: CordisServiceContext;
  dispose: () => Promise<void>;
  readonly error: unknown;
  readonly fiber: KernelFiber;
  readonly id: string;
  readonly state: KernelFiberState;
  readonly version: string;
}

/**
 * Lightweight owner object handed to {@link ToolRegistry}. It is not a second
 * lifecycle implementation: `collect` delegates straight to the real Cordis
 * fiber's `effect()`, `state`/`dispose` read the real fiber, and `getChildren`
 * projects the real registry's parent/child relation.
 */
class CordisFiberOwner implements KernelFiber {
  private disposal?: Promise<void>;

  constructor(
    private readonly host: CordisAtomicHost,
    readonly native: NativeFiber,
    private readonly isRootOwner: boolean,
  ) {}

  get name(): string {
    return this.native.name ?? 'cordis';
  }

  get state(): KernelFiberState {
    return mapFiberState(this.native.state);
  }

  get error(): unknown {
    return readNativeFiberError(this.native);
  }

  collect(disposer: Disposable): Disposable {
    // The root owner is an adapted entry point: once the host is closed it must
    // not accept new resources, even though upstream root dispose is a restart.
    // Plugin owners keep upstream's own INACTIVE_EFFECT check.
    if (this.isRootOwner) this.host.assertOpen();
    // Delegate ownership to the real fiber: the tool-removal closure becomes a
    // Cordis effect and unloads with the plugin.
    return this.native.effect(() => disposer);
  }

  /**
   * Project child fibers from the real registry (`child.parent.fiber`), so
   * nested staged candidates are committed/discarded with their parent. No
   * separate lifecycle tree is maintained.
   */
  getChildren(): readonly CordisFiberOwner[] {
    const children: CordisFiberOwner[] = [];
    for (const runtime of this.native.ctx.registry.values()) {
      for (const child of runtime.fibers) {
        if (child !== this.native && child.parent.fiber === this.native) {
          children.push(this.host.ownerFor(child));
        }
      }
    }
    return children;
  }

  dispose(): Promise<void> {
    // The root owner must not bypass the host's closed flag: route through
    // host.dispose(), which memoizes and calls the native root directly.
    if (this.isRootOwner) return this.host.dispose();
    this.disposal ??= Promise.resolve().then(() => this.native.dispose());
    return this.disposal;
  }
}

interface AdaptedContextOptions {
  readonly isRoot: boolean;
  readonly scope?: ScopeKey;
}

/**
 * Compatibility layer translating the kernel's {@link RuntimeContext} onto a
 * real Cordis context. It carries the trusted `scope` metadata that
 * {@link ToolRegistry} reads and delegates every operation upstream.
 */
class CordisRuntimeContext implements CordisServiceContext {
  readonly isRoot: boolean;
  readonly scope?: ScopeKey;

  constructor(
    private readonly host: CordisAtomicHost,
    private readonly native: NativeContext,
    options: AdaptedContextOptions,
  ) {
    this.isRoot = options.isRoot;
    this.scope = options.scope;
  }

  get fiber(): KernelFiber {
    return this.host.ownerFor(this.native.fiber);
  }

  get root(): CordisServiceContext {
    return this.host.context;
  }

  /**
   * Live view of the host's staging set: a committed candidate (and its
   * descendants) stop being staging, so tools registered afterwards are
   * immediately live instead of silently hidden.
   */
  get isStaging(): boolean {
    return this.host.isStagingFiber(this.native.fiber);
  }

  dispose(): Promise<void> {
    // Root joins host disposal (which also closes the host to new mounts);
    // every plugin joins the owner's single unload promise.
    if (this.isRoot) return this.host.dispose();
    return this.host.ownerFor(this.native.fiber).dispose();
  }

  effect(factory: () => Effect | void): Disposable {
    this.host.assertOpen();
    // Upstream `Effect` and the kernel `Effect` differ only in promise/void
    // nesting; runtime shapes are identical. Narrow bridge, one cast, and the
    // receiver is preserved so upstream `this.assertActive()` still runs.
    const effect = this.native.fiber.effect as unknown as (
      execute: () => Effect | void,
    ) => Disposable;
    return effect.call(this.native.fiber, factory);
  }

  on(event: string, listener: Listener): Disposable {
    this.host.assertOpen();
    // Narrow bridge: upstream `on` is typed over `keyof Events`, the kernel
    // seam accepts dynamic event names. `.call` keeps the context receiver the
    // mixed-in wrapper needs.
    const on = this.native.on as unknown as (name: string, callback: Listener) => () => void;
    return on.call(this.native, event, listener);
  }

  provide<T>(name: string, service: T): Disposable {
    this.host.assertOpen();
    if (this.isStaging) {
      throw Object.assign(new Error('Staged tool candidates cannot publish services'), {
        code: 'CORDIS_STAGED_SERVICE_UNSUPPORTED',
      });
    }
    return this.native.provide(name, service);
  }

  get<K extends keyof CordisHostServices>(name: K): CordisHostServices[K] | undefined;
  get<T = unknown>(name: string): T | undefined;
  get<T = unknown>(name: string): T | undefined {
    this.host.assertOpen();
    return this.native.get(name);
  }

  has(name: string): boolean {
    this.host.assertOpen();
    // Presence differs from get() for an active provider whose value is
    // undefined. Read the native public reflection record, not a second map.
    const label = this.native[Cordis.Context.isolate][name];
    const implementation = label && this.native.reflect.store[label];
    return Boolean(implementation && mapFiberState(implementation.fiber.state) === 'active');
  }

  async plugin(
    manifest: CordisServicePluginManifest,
    config?: unknown,
    isStaging = false,
  ): Promise<KernelFiber> {
    const { owner } = await this.host.attachNative(
      this.native,
      manifest,
      isStaging || this.isStaging,
      config,
      this.scope,
    );
    return owner;
  }

  /**
   * Always a fresh object: callers (e.g. per-invocation
   * `host.context.withScope(scopeKey)`) may safely attach call-local fields
   * without polluting concurrent calls.
   */
  withScope(scope: ScopeKey): CordisServiceContext {
    return new CordisRuntimeContext(this.host, this.host.scopeContext(this.native, scope), {
      isRoot: this.isRoot,
      scope,
    });
  }
}

class CordisAtomicInstanceImpl implements CordisAtomicInstance {
  constructor(
    readonly id: string,
    readonly version: string,
    readonly context: CordisServiceContext,
    private readonly owner: CordisFiberOwner,
  ) {}

  get fiber(): KernelFiber {
    return this.owner;
  }

  get state(): KernelFiberState {
    return this.owner.state;
  }

  get error(): unknown {
    return this.owner.error;
  }

  dispose(): Promise<void> {
    return this.owner.dispose();
  }
}

export class CordisAtomicHost {
  /** Root adapted context; `withScope()` returns a fresh object each call. */
  readonly context: CordisServiceContext;
  readonly native: NativeContext;
  readonly tools: ToolRegistry;

  private readonly owners = new WeakMap<NativeFiber, CordisFiberOwner>();
  private readonly stagedFibers = new WeakSet<NativeFiber>();
  private readonly scopedServices: readonly string[];
  private readonly scopeLabels = new Map<ScopeKey, Map<string, symbol>>();
  /** Captured once so root-owner detection does not depend on read identity. */
  private readonly rootNativeFiber: NativeFiber;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(options: CordisAtomicHostOptions = {}) {
    this.scopedServices = [...new Set(options.scopedServices ?? [])];
    if (this.scopedServices.some((name) => !name.trim() || name === 'cordis.tools')) {
      throw new Error('Scoped services must have non-empty names; cordis.tools is host-wide');
    }
    this.native = options.native ?? new Cordis.Context();
    this.rootNativeFiber = this.native.fiber;
    this.tools = options.tools ?? new ToolRegistry();
    this.context = new CordisRuntimeContext(this, this.native, {
      isRoot: true,
      scope: undefined,
    });
    this.native.provide('cordis.tools', this.tools);
  }

  /** Native isolation labels route service lookup; no second service store. */
  scopeContext(parent: NativeContext, scope: ScopeKey): NativeContext {
    this.assertOpen();
    let context = parent;
    if (!this.scopedServices.length) return context;
    let labels = this.scopeLabels.get(scope);
    if (!labels) {
      labels = new Map();
      this.scopeLabels.set(scope, labels);
    }
    for (const name of this.scopedServices) {
      let label = labels.get(name);
      if (!label) {
        label = Symbol(name);
        labels.set(name, label);
      }
      context = context.isolate(name, label);
    }
    return context;
  }

  ownerFor(fiber: NativeFiber): CordisFiberOwner {
    let owner = this.owners.get(fiber);
    if (!owner) {
      owner = new CordisFiberOwner(this, fiber, fiber === this.rootNativeFiber);
      this.owners.set(fiber, owner);
    }
    return owner;
  }

  isStagingFiber(fiber: NativeFiber): boolean {
    return this.stagedFibers.has(fiber);
  }

  async mount(
    manifest: CordisServicePluginManifest,
    staged = false,
  ): Promise<CordisAtomicInstance> {
    this.assertOpen();
    const { context, owner } = await this.attachNative(
      this.native,
      manifest,
      staged,
      undefined,
      undefined,
    );
    return new CordisAtomicInstanceImpl(manifest.id, manifest.version, context, owner);
  }

  /** Promote a staged candidate's tools (and its staged descendants') to live. */
  commit(instance: CordisAtomicInstance): void {
    this.assertOpen();
    const state = instance.state;
    if (state !== 'active') {
      const error = new Error(
        `Cannot commit a ${state} candidate: ${instance.id}@${instance.version}`,
      ) as Error & { code: string; state: KernelFiberState };
      error.code = 'CORDIS_ATOMIC_COMMIT_INACTIVE';
      error.state = state;
      throw error;
    }
    this.tools.commitStaging(instance.fiber);
    this.clearStaged(instance.fiber as CordisFiberOwner);
  }

  /** Drop a candidate's staged tools (and descendants') without touching live ones. */
  discard(instance: CordisAtomicInstance): void {
    this.tools.discardStaging(instance.fiber);
    this.clearStaged(instance.fiber as CordisFiberOwner);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = Promise.resolve()
      .then(() => this.native.fiber.dispose())
      .finally(() => this.scopeLabels.clear());
    return this.disposal;
  }

  /**
   * Mount a manifest onto a native context. Resolves only once the real fiber
   * settled *and* is active; a pending, failed or disposed fiber is rejected
   * rather than silently accepted.
   */
  async attachNative(
    parent: NativeContext,
    manifest: CordisServicePluginManifest,
    staged: boolean,
    config: unknown,
    scope: ScopeKey | undefined,
  ): Promise<{ context: CordisServiceContext; owner: CordisFiberOwner }> {
    this.assertOpen();

    let capturedFiber: NativeFiber | undefined;
    let capturedContext: CordisRuntimeContext | undefined;
    let firstActivation = true;

    const pluginObject = {
      name: `${manifest.id}@${manifest.version}`,
      inject: manifest.inject,
      apply: (nativeContext: NativeContext, applyConfig?: unknown) => {
        capturedFiber = nativeContext.fiber;
        // A dependency restart reuses this closure. A committed tool plugin
        // must remain live when Cordis reactivates it later.
        if (firstActivation && staged) this.stagedFibers.add(nativeContext.fiber);
        firstActivation = false;
        capturedContext = new CordisRuntimeContext(this, nativeContext, {
          isRoot: false,
          scope,
        });
        return manifest.apply(capturedContext, applyConfig);
      },
    };

    let mounted: (NativeFiber & PromiseLike<NativeFiber>) | undefined;
    try {
      mounted = parent.plugin(pluginObject, config);
      await mounted.await();
    } catch (error) {
      await this.cleanupFailedMount(mounted, capturedFiber);
      // Preserve the original failure (identity and its own `cause` chain).
      throw error instanceof Error ? error : new Error(String(error), { cause: error });
    }

    const realFiber = capturedFiber ?? mounted;
    const state = realFiber ? mapFiberState(realFiber.state) : 'pending';
    if (!realFiber || state !== 'active') {
      await this.cleanupFailedMount(mounted, capturedFiber);
      const error = new Error(
        `Cordis fiber did not activate: ${manifest.id}@${manifest.version} (${state})`,
        { cause: readNativeFiberError(realFiber) },
      ) as Error & { code: string; state: KernelFiberState };
      error.code = 'CORDIS_ATOMIC_MOUNT_INACTIVE';
      error.state = state;
      throw error;
    }

    const owner = this.ownerFor(realFiber);
    const context =
      capturedContext ?? new CordisRuntimeContext(this, parent, { isRoot: false, scope });
    return { context, owner };
  }

  /** Uniform guard for every adapted mutation entry point. */
  assertOpen(): void {
    if (this.disposed) {
      const error = new Error('CordisAtomicHost is disposed') as Error & { code: string };
      error.code = 'CORDIS_ATOMIC_HOST_DISPOSED';
      throw error;
    }
  }

  /** Stop hiding a candidate (and its staged descendants) in the staging set. */
  private clearStaged(owner: CordisFiberOwner): void {
    this.stagedFibers.delete(owner.native);
    for (const child of owner.getChildren()) this.clearStaged(child);
  }

  private async cleanupFailedMount(
    mounted: NativeFiber | undefined,
    captured: NativeFiber | undefined,
  ): Promise<void> {
    const realFiber = captured ?? mounted;
    if (realFiber) {
      this.stagedFibers.delete(realFiber);
      const owner = this.owners.get(realFiber);
      if (owner) {
        this.tools.discardStaging(owner);
        this.owners.delete(realFiber);
      }
    }
    if (mounted) {
      try {
        await mounted.dispose();
      } catch {
        // The real fiber already rolled back; a failed rollback must not mask
        // the original mount error.
      }
    }
  }
}
