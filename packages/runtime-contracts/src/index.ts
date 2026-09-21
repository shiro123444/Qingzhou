/** The wire protocol version shared by RuntimeFacade and its clients. */
export const RUNTIME_PROTOCOL_VERSION = 'runtime.v1' as const;

/** PPTX templates can legitimately carry high-resolution media and embedded video. */
export const PRESENTATION_PPTX_MAX_UPLOAD_MIB = 100;
export const PRESENTATION_PPTX_MAX_UPLOAD_BYTES = PRESENTATION_PPTX_MAX_UPLOAD_MIB * 1024 * 1024;

/** Keep the broader attachment surface bounded independently from native PPTX imports. */
export const PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB = 32;
export const PRESENTATION_ATTACHMENT_MAX_UPLOAD_BYTES =
  PRESENTATION_ATTACHMENT_MAX_UPLOAD_MIB * 1024 * 1024;

export const PLUGIN_KINDS = ['kernel', 'capability', 'agent-strategy', 'ui'] as const;
export type RuntimePluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_RUNTIME_STATES = [
  'installed',
  'pending',
  'active',
  'failed',
  'unloading',
  'disabled',
] as const;
export type PluginRuntimeState = (typeof PLUGIN_RUNTIME_STATES)[number];

export const RUN_STATES = [
  'created',
  'queued',
  'running',
  'waiting_tool',
  'waiting_human',
  'waiting_child',
  'retrying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export type FiberState = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed';

export interface Disposer {
  (): void | Promise<void>;
}

export type Disposable = Disposer;
export type Effect =
  | Disposable
  | Iterable<Disposable>
  | AsyncIterable<Disposable>
  | Promise<Effect | void>;

export interface Fiber {
  collect: (disposer: Disposer) => Disposable;
  dispose: () => Promise<void>;
  readonly name: string;
  readonly state: FiberState;
}

/** The intentionally small surface exposed to plugin manifests. */
export interface RuntimeContext {
  dispose: () => Promise<void>;
  readonly fiber: Fiber;
  on: (event: string, listener: (...args: unknown[]) => unknown) => Disposable;
  provide: <T>(name: string, service: T) => Disposable;
  readonly root: RuntimeContext;
  withScope: (scope: string | symbol) => RuntimeContext;
}

export interface PermissionManifest {
  device?: string[];
  filesystem?: string[];
  network?: string[];
  tools?: string[];
  uiSlots?: string[];
}

export interface RuntimePluginManifest {
  apply: (ctx: RuntimeContext, config?: unknown) => Effect | Promise<Effect | void> | void;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  permissions?: PermissionManifest;
  version: string;
}

export interface PluginDescriptor {
  description?: string;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  name?: string;
  permissions?: PermissionManifest;
  source?: 'builtin' | 'mcp-http' | 'mcp-stdio' | 'remote-adapter' | 'worker';
  state?: PluginRuntimeState;
  version: string;
}

export interface ExternalCapabilityManifest {
  capabilities: string[];
  id: string;
  inject?: string[];
  permissions?: PermissionManifest;
  source: 'builtin' | 'process' | 'http' | 'mcp' | 'worker';
  version: string;
}

export interface CapabilityDescriptor {
  capabilities?: string[];
  description?: string;
  id: string;
  source?: ExternalCapabilityManifest['source'];
  version?: string;
}

export interface CapabilityExecutionContext {
  readonly [key: string]: unknown;
  readonly scope?: string | symbol;
}

export interface CapabilityPort {
  readonly descriptor?: CapabilityDescriptor;
  readonly dispose?: () => void | Promise<void>;
  execute: (command: unknown, context: CapabilityExecutionContext) => Promise<unknown>;
  readonly id: string;
}

export interface StartRunInput {
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  profileId: string;
  sessionId: string;
  strategyPluginId?: string;
  toolAllowlist?: string[];
  userContext?: Record<string, unknown>;
  userMessage: string;
}

export interface ResumeRunInput {
  input: string;
  metadata?: Record<string, unknown>;
}

export interface RunError {
  code: string;
  details?: unknown;
  message: string;
}

export interface RunSnapshot {
  createdAt: string;
  error?: RunError;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  profileId?: string;
  result?: unknown;
  runId: string;
  sessionId: string;
  state: RunState;
  strategyPluginId?: string;
  updatedAt: string;
}

export interface RuntimeEvent {
  data: unknown;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  run_id?: string;
  seq: number;
  session_id: string;
  type: string;
}

export interface CommandEnvelope {
  command: string;
  payload: Record<string, unknown>;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  request_id: string;
}

export interface AgentProfile {
  enabledCapabilities: string[];
  id: string;
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  strategyPluginId: string;
  systemPrompt?: string;
}

export type ArtifactStatus = 'pending' | 'ready' | 'failed';

export interface ArtifactSnapshot {
  artifactId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  status: ArtifactStatus;
  type: string;
  updatedAt?: string;
  uri?: string;
}

/** Wire-safe artifact input; server adapters may use a Uint8Array variant. */
export interface ArtifactInput {
  artifactId: string;
  bytes: readonly number[];
  metadata?: Record<string, unknown>;
  mimeType: string;
  name: string;
  type: string;
}

/** Wire-safe artifact projection; binary bytes are represented as numbers. */
export interface StoredArtifact extends ArtifactSnapshot {
  bytes: readonly number[];
}

export interface PresentationJobInput {
  aspectRatio?: string;
  language?: string;
  notebookId: string;
  options?: Record<string, unknown>;
  prompt?: string;
  slideCount?: number;
  sourceVersionIds: string[];
  template?: string;
  title: string;
}

export interface PresentationSlidePlan {
  metadata?: Record<string, unknown>;
  notes?: string;
  order: number;
  slideId: string;
  svg: string;
}

export interface PresentationPlan {
  aspectRatio: string;
  designSpec?: Record<string, unknown>;
  planId: string;
  slides: readonly PresentationSlidePlan[];
  sourceVersionIds: readonly string[];
  title: string;
}

export interface PlannerContext {
  readonly [key: string]: unknown;
}

export interface PresentationPlanner {
  plan: (input: PresentationJobInput, context: PlannerContext) => Promise<PresentationPlan>;
}

export type PresentationJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PresentationAnnotation {
  baseSvgHash: string;
  elementIndices: number[];
  expectedVersionId: string;
  region: { x: number; y: number; width: number; height: number };
  slideId: string;
}

export interface PresentationMessageInput {
  annotation?: PresentationAnnotation;
  content: string;
  patch?: { slideId: string; svg: string; notes?: string; expectedVersionId?: string };
  requestId: string;
  target: { type: 'deck' } | { type: 'slide'; slideNumber: number };
  template?: { templateId: string; versionId?: string };
}

export interface PresentationMessage extends PresentationMessageInput {
  createdAt: string;
  error?: string;
  status: 'queued' | 'applying' | 'applied' | 'failed';
  versionId?: string;
}

export interface PresentationRevision {
  artifactIds: string[];
  createdAt: string;
  versionId: string;
}

export interface PresentationJob {
  artifactIds?: string[];
  aspectRatio?: string;
  createdAt: string;
  error?: RunError;
  jobId: string;
  messages?: PresentationMessage[];
  projectId?: string;
  revisions?: PresentationRevision[];
  slideCount?: number;
  state: PresentationJobState;
  title?: string;
  updatedAt: string;
  versionId?: string;
}

export type PresentationExportFormat = 'pptx' | 'svg' | 'pdf' | 'quality-report';

export interface ExportResult {
  artifactId: string;
  format: PresentationExportFormat;
  mimeType?: string;
  uri?: string;
}

export interface PresentationPort {
  cancelJob: (jobId: string) => Promise<PresentationJob>;
  createJob: (input: PresentationJobInput) => Promise<PresentationJob>;
  exportArtifact: (artifactId: string, format: PresentationExportFormat) => Promise<ExportResult>;
  getArtifact: (artifactId: string) => Promise<ArtifactSnapshot | null>;
  getJob: (jobId: string) => Promise<PresentationJob | null>;
  retryJob: (jobId: string) => Promise<PresentationJob>;
}

export const PRESENTATION_OPERATIONS = [
  'create',
  'inspect',
  'edit',
  'preview',
  'export',
  'retry',
  'cancel',
] as const;
export type PresentationOperation = (typeof PRESENTATION_OPERATIONS)[number];

export interface PresentationCapabilityMetadata {
  annotation?: string;
  elementId?: string;
  parentVersionId?: string;
  slideId?: string;
}

export interface PresentationCapabilityCommand {
  artifactId?: string;
  format?: PresentationExportFormat;
  input?: PresentationJobInput;
  jobId?: string;
  metadata?: PresentationCapabilityMetadata;
  operation: PresentationOperation;
}

export interface PresentationCapabilityResult {
  artifact?: ArtifactSnapshot | null;
  export?: ExportResult;
  job?: PresentationJob | null;
  operation: PresentationOperation;
}

export interface RunHandle {
  cancel: () => Promise<void>;
  runId: string;
  snapshot: () => Promise<RunSnapshot | null>;
}

export interface RuntimeScope {
  readonly sessionId: string;
  readonly userId: string;
}

export type PresentationVersionKind = 'source' | 'design-spec' | 'slide' | 'artifact' | 'composite';

export interface PresentationVersion {
  artifactIds: string[];
  createdAt: string;
  id: string;
  kind: PresentationVersionKind;
  metadata?: Record<string, unknown>;
  parentVersionId?: string;
}

export interface PresentationVersionInput {
  artifactIds?: string[];
  id?: string;
  kind?: PresentationVersionKind;
  metadata?: Record<string, unknown>;
  parentVersionId?: string;
}

export interface PresentationProjectInput {
  artifactVersions?: PresentationVersionInput[];
  currentVersion?: string;
  designSpecVersion?: PresentationVersionInput;
  metadata?: Record<string, unknown>;
  slideVersions?: PresentationVersionInput[];
  sourceVersion: PresentationVersionInput;
  title?: string;
}

export interface PresentationProject {
  artifactVersions: PresentationVersion[];
  createdAt: string;
  currentVersion: string;
  designSpecVersion: PresentationVersion;
  id: string;
  metadata?: Record<string, unknown>;
  slideVersions: PresentationVersion[];
  sourceVersion: PresentationVersion;
  title?: string;
  updatedAt: string;
}

export interface PresentationProjectStore {
  appendVersion: (
    scope: RuntimeScope,
    projectId: string,
    version: PresentationVersionInput,
  ) => Promise<PresentationProject>;
  create: (scope: RuntimeScope, input: PresentationProjectInput) => Promise<PresentationProject>;
  get: (scope: RuntimeScope, projectId: string) => Promise<PresentationProject | null>;
  selectVersion: (
    scope: RuntimeScope,
    projectId: string,
    versionId: string,
  ) => Promise<PresentationProject>;
}

/* ------------------------------------------------------------------------- *
 * Image generation contract (C-81). Wire-safe request/result shapes and a
 * provider-agnostic port for image generation. Binary data never crosses the
 * wire as `Uint8Array`: results reference assets by `AssetRef`, and providers
 * resolve those refs through their own injected storage ports. No vendor SDK,
 * env access, process spawn or filesystem knowledge belongs at this seam.
 * ------------------------------------------------------------------------ */

/**
 * Stable error codes for image generation. Providers must map their vendor
 * errors onto one of these codes inside a `RunError`-shaped `ImageGenerationError`.
 */
export const IMAGE_GENERATION_ERROR_CODES = [
  /** The request shape/limits were invalid before any provider call. */
  'IMAGE_REQUEST_INVALID',
  /** The provider rejected the request (auth, content policy, rate limit...). */
  'IMAGE_PROVIDER_REJECTED',
  /** The injected budget (time/size/count) was exhausted. */
  'IMAGE_BUDGET_EXCEEDED',
  /** The caller cancelled the request via the injected signal. */
  'IMAGE_CANCELLED',
  /** The provider returned a response that cannot be projected to an AssetRef. */
  'IMAGE_PAYLOAD_INVALID',
  /** Any failure that cannot be classified more specifically. */
  'IMAGE_UNAVAILABLE',
] as const;

export type ImageGenerationErrorCode = (typeof IMAGE_GENERATION_ERROR_CODES)[number];

/** RunError-shaped failure with a stable image-generation code. */
export interface ImageGenerationError {
  code: ImageGenerationErrorCode;
  details?: Record<string, unknown>;
  message: string;
}

/**
 * A vendor-neutral reference to one generated asset. `ref` is an opaque,
 * provider-resolvable handle — never raw bytes, never a local filesystem path.
 */
export interface AssetRef {
  /** Free-form projection metadata; must not carry binary payloads. */
  metadata?: Record<string, unknown>;
  /** Opaque handle the generating provider can resolve (uri, key, id...). */
  ref: string;
}

/** Wire-safe projection of one generated image: descriptive fields only. */
export interface AssetMetadata {
  /** Optional stable identifier the provider assigns to the asset. */
  assetId?: string;
  /** Creation timestamp (ISO 8601) as projected by the provider. */
  createdAt: string;
  /** Canonical mimeType, e.g. `image/png`. */
  mimeType: string;
  /** Non-secret provider response headers/metadata, defensively projected. */
  providerMetadata?: Record<string, unknown>;
  /** Declared byte size when the provider reports one (never the payload). */
  sizeBytes?: number;
}

/** One image-generation output: a resolvable ref plus its wire-safe metadata. */
export interface ImageGenerationResult {
  /** The resolvable asset handle produced by the provider. */
  asset: AssetRef;
  /** Index of the image within the request (0-based, matches `count` order). */
  index: number;
  /** Wire-safe descriptive metadata; binary data must never appear here. */
  metadata: AssetMetadata;
}

/** Request for a batch of images. All values are JSON-serializable. */
export interface ImageGenerationRequest {
  /** Number of images requested (>= 1). Providers may clamp and report. */
  count?: number;
  /** Caller-supplied stable key; identical keys may be served idempotently. */
  idempotencyKey?: string;
  /** Optional negative guidance, passed through verbatim to the provider. */
  negativePrompt?: string;
  /** Free-form wire-safe options; provider-specific, never binary. */
  options?: Record<string, unknown>;
  /** How the caller identifies the requesting subject (prompt, scene...). */
  prompt: string;
  /** Opaque vendor-neutral style/quality hint (e.g. `standard` | `hd`). */
  quality?: string;
  /** Requested pixel size as `WIDTHxHEIGHT` (e.g. `1024x1024`), if supported. */
  size?: string;
}

/** Deterministic context injected by the host for one generation call. */
export interface ImageGenerationContext {
  /** Authenticated subject; implementations must fail closed without one. */
  readonly scope: RuntimeScope;
  /** Cooperative cancellation; aborting rejects with `IMAGE_CANCELLED`. */
  readonly signal?: AbortSignal;
  /** Hard wall-clock budget in milliseconds; omit for provider default. */
  readonly timeoutMs?: number;
  /** Optional caller trace id for observability (never a secret). */
  readonly traceId?: string;
}

/**
 * Provider-agnostic image generation port. Implementations resolve vendor SDKs
 * and asset storage themselves; the port only freezes the wire-safe contract.
 */
export interface ImageGenerationPort {
  /** Generates `count` images; resolves refs, never raw binary payloads. */
  generate: (
    request: ImageGenerationRequest,
    context: ImageGenerationContext,
  ) => Promise<ImageGenerationResult[]>;
  /** Structured manifest of capabilities/limits for routing and UI hints. */
  readonly manifest: ImageProviderManifest;
  /** Stable provider manifest entry (e.g. `ppt-master.image`). */
  readonly providerId: string;
  /** Resolves a previously produced ref back to wire-safe metadata. */
  resolveAsset: (scope: RuntimeScope, ref: AssetRef) => Promise<AssetMetadata | null>;
}

/** Declarative provider manifest consumed by routing/composition layers. */
export interface ImageProviderManifest {
  /** Human-readable display name (non-secret). */
  displayName: string;
  /** Inclusive maximum images per request; omit when unconstrained. */
  maxImagesPerRequest?: number;
  /** Stable identifier matching `ImageGenerationPort.providerId`. */
  providerId: string;
  /** MIME types this provider can emit (e.g. `image/png`). */
  supportedMimeTypes: readonly string[];
  /** Provider default/requested quality tokens, if any. */
  supportedQualities?: readonly string[];
  /** Supported request size tokens; omit when unconstrained/unknown. */
  supportedSizes?: readonly string[];
  /** Whether the port honours `idempotencyKey` for duplicate requests. */
  supportsIdempotency: boolean;
}

/* ------------------------------------------------------------------------- *
 * Slide scene-graph contract (C-83). A wire-safe, vendor-neutral scene graph
 * for one presentation slide: consumable by SVG/PPTX renderers and by the
 * frontend editor alike. Nodes reference binary assets through `AssetRef`
 * (C-81) — bytes, buffers and vendor renderers never enter this seam.
 * ------------------------------------------------------------------------ */

/** Stable error codes for slide-scene validation. */
export const SLIDE_SCENE_ERROR_CODES = [
  /** The scene shape was invalid (missing fields, wrong kinds...). */
  'SCENE_INVALID',
  /** A node id is missing, empty or duplicated within the scene. */
  'SCENE_NODE_ID_INVALID',
  /** Node coordinates/size are negative, non-finite or exceed the canvas budget. */
  'SCENE_GEOMETRY_INVALID',
] as const;

export type SlideSceneErrorCode = (typeof SLIDE_SCENE_ERROR_CODES)[number];

/** RunError-shaped failure with a stable slide-scene code. */
export interface SlideSceneError {
  code: SlideSceneErrorCode;
  details?: Record<string, unknown>;
  message: string;
}

/**
 * Default canvas budget for slide scenes: coordinates/sizes are non-negative
 * and must stay inside this box (CSS pixels, 16:9 production slide size).
 */
export const SLIDE_SCENE_CANVAS = {
  /** Inclusive maximum width in CSS pixels. */
  maxWidth: 4096,
  /** Inclusive maximum height in CSS pixels. */
  maxHeight: 4096,
} as const;

/** Wire-safe 2D geometry. All values are finite, non-negative CSS pixels. */
export interface SceneRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** Axis-aligned crop window in source-asset pixels (non-negative). */
export interface SceneCrop {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** Clockwise rotation in degrees; normalised to the `[0, 360)` interval. */
export type SceneRotation = number;

/** Common fields shared by every scene node. */
export interface SceneNodeBase {
  /** Axis-aligned crop window for image/texture content, when cropped. */
  crop?: SceneCrop;
  /** Unique, non-empty, stable identifier within one scene. */
  id: string;
  /** Locked nodes stay visible but reject editor mutations. */
  locked?: boolean;
  /** Free-form wire-safe annotations (never binary). */
  metadata?: Record<string, unknown>;
  /** Axis-aligned layout box; non-negative and inside the canvas budget. */
  rect: SceneRect;
  /** Clockwise rotation in degrees around the node centre. */
  rotation?: SceneRotation;
  /** Paint order: higher zIndex renders above lower ones. */
  zIndex: number;
}

/** An image node rendering an existing asset through its `AssetRef`. */
export interface SceneImageNode extends SceneNodeBase {
  /** Optional wire-safe alt text for accessibility. */
  alt?: string;
  /** Reference to the binary payload resolved outside this seam (C-81). */
  asset: AssetRef;
  /** `fit` preserves aspect ratio inside the rect; `fill` stretches. */
  fit?: 'fill' | 'fit';
  kind: 'image';
}

/** A text node; content is plain wire-safe text, never embedded markup. */
export interface SceneTextNode extends SceneNodeBase {
  kind: 'text';
  /** Wire-safe style hints renderers may honour or ignore. */
  style?: {
    align?: 'center' | 'justify' | 'left' | 'right';
    bold?: boolean;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
    italic?: boolean;
    underline?: boolean;
  };
  /** Plain text content — no HTML/Markup/script is allowed here. */
  text: string;
}

/** A primitive vector shape node. */
export interface SceneShapeNode extends SceneNodeBase {
  /** Fill color as CSS color string; `transparent` is allowed. */
  fill?: string;
  kind: 'shape';
  /** Primitive shape vocabulary renderers must support. */
  shape: 'circle' | 'ellipse' | 'line' | 'polygon' | 'rect';
  /** Stroke color as CSS color string. */
  stroke?: string;
  /** Stroke width in CSS pixels. */
  strokeWidth?: number;
}

/** A tabular node with wire-safe plain-text cells. */
export interface SceneTableNode extends SceneNodeBase {
  /** Optional first row/column header hints for renderers. */
  header?: { column?: boolean; row?: boolean };
  kind: 'table';
  /** Rows of plain-text cells; rows may be ragged but never binary. */
  rows: readonly (readonly string[])[];
}

/**
 * A chart node. Data is declarative and wire-safe; the visual encoding is the
 * renderer's job — this seam never embeds chart images or vendor payloads.
 */
export interface SceneChartNode extends SceneNodeBase {
  /** Chart vocabulary renderers must support. */
  chartType: 'bar' | 'line' | 'pie';
  kind: 'chart';
  /** Series with plain-text labels and finite numeric values. */
  series: readonly {
    /** Plain-text series name. */
    name: string;
    /** Plain-text category labels, aligned with `values` by index. */
    labels: readonly string[];
    /** Finite numeric values, aligned with `labels` by index. */
    values: readonly number[];
  }[];
}

/** A container node grouping child nodes; children may themselves be groups. */
export interface SceneGroupNode extends SceneNodeBase {
  /** Child nodes; the group does not clip or transform children. */
  children: readonly SceneNode[];
  kind: 'group';
}

/** Discriminated union of all scene nodes. */
export type SceneNode =
  | SceneChartNode
  | SceneGroupNode
  | SceneImageNode
  | SceneShapeNode
  | SceneTableNode
  | SceneTextNode;

/** One slide scene: the editable, vendor-neutral projection of a slide. */
export interface SlideScene {
  /** Canvas size in CSS pixels; nodes must fit inside this box. */
  canvas: { height: number; width: number };
  /** Optional wire-safe scene-level metadata. */
  metadata?: Record<string, unknown>;
  /** Root nodes in paint order; nested nodes live inside groups. */
  nodes: readonly SceneNode[];
  /** Optional reference image for regeneration comparisons (C-81 AssetRef). */
  referenceImage?: AssetRef;
  /** Stable scene identifier (e.g. the slide id from a C-51 plan). */
  sceneId: string;
}

/**
 * Editor semantics marker: scenes/nodes are data — every node exposes its
 * `id` and geometry so the frontend editor can select, move and restack it.
 * `locked` nodes remain visible but reject mutations in the editor.
 */

/** Validation result: either the scene data or one stable `SlideSceneError`. */
export type SlideSceneValidation =
  | { ok: true; scene: SlideScene }
  | { ok: false; error: SlideSceneError };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isWireRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const collectNodeIds = (nodes: readonly SceneNode[], into: Set<string>): boolean => {
  for (const node of nodes) {
    if (!isWireRecord(node)) return false;
    const id = (node as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) return false;
    if (into.has(id)) return false;
    into.add(id);
    if ((node as { kind?: unknown }).kind === 'group') {
      const children = (node as { children?: unknown }).children;
      if (!Array.isArray(children)) return false;
      if (!collectNodeIds(children as SceneNode[], into)) return false;
    }
  }
  return true;
};

/**
 * Structural scene validation (C-83): unique non-empty node ids (recursive
 * through groups), finite non-negative geometry inside the canvas budget and
 * positive canvas dimensions. Pure data in, stable error out — no rendering,
 * no env access, no side effects.
 */
export const validateSlideScene = (scene: unknown): SlideSceneValidation => {
  if (!isWireRecord(scene)) {
    return { error: { code: 'SCENE_INVALID', message: 'Scene must be an object.' }, ok: false };
  }

  const canvas = scene.canvas as { height?: unknown; width?: unknown } | undefined;
  if (
    !canvas ||
    !isWireRecord(canvas) ||
    !isFiniteNumber(canvas.width) ||
    !isFiniteNumber(canvas.height) ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    return {
      error: { code: 'SCENE_INVALID', message: 'Scene canvas must have positive dimensions.' },
      ok: false,
    };
  }
  if (!Array.isArray(scene.nodes)) {
    return {
      error: { code: 'SCENE_INVALID', message: 'Scene nodes must be an array.' },
      ok: false,
    };
  }

  const ids = new Set<string>();
  if (!collectNodeIds(scene.nodes as SceneNode[], ids)) {
    return {
      error: { code: 'SCENE_NODE_ID_INVALID', message: 'Node ids must be unique and non-empty.' },
      ok: false,
    };
  }

  const withinBudget = (value: number, max: number): boolean =>
    value >= 0 && value <= max && Number.isFinite(value);

  const checkGeometry = (
    nodes: readonly SceneNode[],
    canvas: { height: number; width: number },
  ): boolean => {
    for (const node of nodes) {
      if (!isWireRecord(node)) return false;
      const rect = (node as { rect?: unknown }).rect;
      if (
        !isWireRecord(rect) ||
        !isFiniteNumber(rect.x) ||
        !isFiniteNumber(rect.y) ||
        !isFiniteNumber(rect.width) ||
        !isFiniteNumber(rect.height)
      ) {
        return false;
      }
      if (
        !withinBudget(rect.x, canvas.width) ||
        !withinBudget(rect.y, canvas.height) ||
        !withinBudget(rect.width, canvas.width) ||
        !withinBudget(rect.height, canvas.height)
      ) {
        return false;
      }
      const crop = (node as { crop?: unknown }).crop as SceneCrop | undefined;
      if (
        crop !== undefined &&
        (!isWireRecord(crop) ||
          !isFiniteNumber(crop.x) ||
          !isFiniteNumber(crop.y) ||
          !isFiniteNumber(crop.width) ||
          !isFiniteNumber(crop.height) ||
          crop.x < 0 ||
          crop.y < 0 ||
          crop.width < 0 ||
          crop.height < 0)
      ) {
        return false;
      }
      if ((node as { kind?: unknown }).kind === 'group') {
        const children = (node as { children?: unknown }).children;
        if (!Array.isArray(children) || !checkGeometry(children as SceneNode[], canvas)) {
          return false;
        }
      }
    }
    return true;
  };

  if (
    !checkGeometry(scene.nodes as SceneNode[], {
      height: canvas.height,
      width: canvas.width,
    })
  ) {
    return {
      error: {
        code: 'SCENE_GEOMETRY_INVALID',
        message: 'Node geometry must be finite, non-negative and inside the canvas budget.',
      },
      ok: false,
    };
  }

  return { ok: true, scene: scene as unknown as SlideScene };
};

/* ------------------------------------------------------------------------- *
 * Asset composition contract (C-105). A wire-safe, vendor-neutral port that
 * rasterises several existing assets (C-81 `AssetRef`) into one new asset.
 * Layers carry only geometry and opaque refs; bytes, paths, workspaces and
 * provider credentials never cross this seam. Real compositors (Sharp,
 * ImageMagick, remote services...) implement the port behind injected
 * storage — nothing here spawns, reads env or touches a filesystem.
 * ------------------------------------------------------------------------ */

/** Stable error codes for asset composition. */
export const ASSET_COMPOSITION_ERROR_CODES = [
  /** The request shape/canvas/output was invalid before any compositor call. */
  'COMPOSITION_REQUEST_INVALID',
  /** The scope was missing/incomplete or a layer asset belongs to another scope. */
  'COMPOSITION_SCOPE_MISMATCH',
  /** A layer id, geometry, order or asset ref was invalid. */
  'COMPOSITION_LAYER_INVALID',
  /** A layer asset could not be resolved inside the caller's scope. */
  'COMPOSITION_ASSET_NOT_FOUND',
  /** The idempotency key is already bound to a different request. */
  'COMPOSITION_IDEMPOTENCY_CONFLICT',
  /** The injected budget (time/size/layer count) was exhausted. */
  'COMPOSITION_BUDGET_EXCEEDED',
  /** The caller cancelled via the injected signal. */
  'COMPOSITION_CANCELLED',
  /** No compositor is configured or the compositor is unreachable. */
  'COMPOSITION_UNAVAILABLE',
  /** The compositor ran but failed; `details` may carry a sanitised cause. */
  'COMPOSITION_FAILED',
] as const;

export type AssetCompositionErrorCode = (typeof ASSET_COMPOSITION_ERROR_CODES)[number];

/** RunError-shaped failure with a stable asset-composition code. */
export interface AssetCompositionError {
  code: AssetCompositionErrorCode;
  details?: Record<string, unknown>;
  message: string;
}

/**
 * Lifecycle of one composition (and of each layer inside it). The frontend
 * must render these distinctly and never collapse them into "completed".
 */
export const ASSET_COMPOSITION_STATES = [
  'planned',
  'composing',
  'composed',
  'failed',
  'cancelled',
] as const;

export type AssetCompositionState = (typeof ASSET_COMPOSITION_STATES)[number];

/** Default canvas/layer budget for compositions (output pixels). */
export const ASSET_COMPOSITION_CANVAS = {
  /** Inclusive maximum output width in pixels. */
  maxWidth: 8192,
  /** Inclusive maximum output height in pixels. */
  maxHeight: 8192,
  /** Inclusive maximum number of layers per request. */
  maxLayers: 32,
} as const;

/**
 * One raster layer. Geometry reuses the C-83 vocabulary; `zIndex` defines the
 * paint order (ties are broken by array position). `asset` is an opaque ref
 * that the compositor resolves inside the caller's scope.
 */
export interface AssetCompositionLayer {
  /** Opaque source asset; must already exist inside the caller's scope. */
  asset: AssetRef;
  /** Optional source crop window in source-asset pixels. */
  crop?: SceneCrop;
  /** `fit` preserves aspect ratio inside the rect; `fill` stretches. */
  fit?: 'fill' | 'fit';
  /** Unique, non-empty, stable identifier within one request. */
  layerId: string;
  /** Free-form wire-safe annotations (never binary). */
  metadata?: Record<string, unknown>;
  /** Layer opacity in `[0, 1]`; defaults to 1. */
  opacity?: number;
  /** Destination box on the output canvas (finite, non-negative, in-bounds). */
  rect: SceneRect;
  /** Optional clockwise rotation in degrees around the rect centre. */
  rotation?: SceneRotation;
  /** Paint order: higher zIndex renders above lower ones. */
  zIndex: number;
}

/** Requested output encoding; the compositor may clamp and report. */
export interface AssetCompositionOutput {
  /** Canonical mimeType, e.g. `image/png`. */
  mimeType: string;
  /** Optional encoder quality hint in `[1, 100]` for lossy formats. */
  quality?: number;
}

/** Request for one composition. All values are JSON-serializable. */
export interface AssetCompositionRequest {
  /** Optional CSS background color; `transparent` when omitted. */
  background?: string;
  /** Output canvas in pixels; positive and inside the composition budget. */
  canvas: { height: number; width: number };
  /** Caller-supplied stable key; identical keys may be served idempotently. */
  idempotencyKey?: string;
  /** Layers to paint; at least one, ordered by `zIndex` then position. */
  layers: readonly AssetCompositionLayer[];
  /** Free-form wire-safe options; compositor-specific, never binary. */
  options?: Record<string, unknown>;
  /** Requested output encoding. */
  output: AssetCompositionOutput;
}

/** Deterministic context injected by the host for one composition call. */
export interface AssetCompositionContext {
  /** Authenticated subject; implementations must fail closed without one. */
  readonly scope: RuntimeScope;
  /** Cooperative cancellation; aborting rejects with `COMPOSITION_CANCELLED`. */
  readonly signal?: AbortSignal;
  /** Hard wall-clock budget in milliseconds; omit for compositor default. */
  readonly timeoutMs?: number;
  /** Optional caller trace id for observability (never a secret). */
  readonly traceId?: string;
}

/** Per-layer outcome inside a composition result (source provenance). */
export interface AssetCompositionLayerResult {
  /** The source asset that was painted (opaque ref, never bytes). */
  asset: AssetRef;
  error?: AssetCompositionError;
  layerId: string;
  state: AssetCompositionState;
}

/** One composition output: the new asset plus provenance for each layer. */
export interface AssetCompositionResult {
  /** The new opaque asset produced by the compositor. */
  asset: AssetRef;
  /** Present only when `state` is `failed` or `cancelled`. */
  error?: AssetCompositionError;
  /** Echo of the request key when the compositor honoured idempotency. */
  idempotencyKey?: string;
  /** Provenance for each requested layer, in paint order. */
  layers: readonly AssetCompositionLayerResult[];
  /** Wire-safe descriptive metadata of the produced asset. */
  metadata: AssetMetadata;
  /** Terminal state of the composition; never `planned`/`composing` here. */
  state: AssetCompositionState;
}

/** Declarative compositor manifest consumed by routing/composition layers. */
export interface AssetCompositionManifest {
  /** Human-readable display name (non-secret). */
  displayName: string;
  /** Inclusive maximum layers per request; omit for the default budget. */
  maxLayers?: number;
  /** Stable identifier matching `AssetCompositionPort.providerId`. */
  providerId: string;
  /** Source MIME types the compositor can decode. */
  supportedInputMimeTypes: readonly string[];
  /** Output MIME types the compositor can encode. */
  supportedOutputMimeTypes: readonly string[];
  /** Whether the port honours `idempotencyKey` for duplicate requests. */
  supportsIdempotency: boolean;
  /** Whether `rotation` is honoured (otherwise it must be rejected, not ignored). */
  supportsRotation: boolean;
}

/**
 * Vendor-neutral asset composition port. Implementations resolve source assets
 * and persist the output themselves; the port only freezes the wire contract.
 * Optional at every composition seam: absence means `COMPOSITION_UNAVAILABLE`.
 */
export interface AssetCompositionPort {
  /** Composes the layers into one new asset; resolves refs, never bytes. */
  compose: (
    request: AssetCompositionRequest,
    context: AssetCompositionContext,
  ) => Promise<AssetCompositionResult>;
  /** Structured manifest of capabilities/limits for routing and UI hints. */
  readonly manifest: AssetCompositionManifest;
  /** Stable provider manifest entry (e.g. `sharp.composition`). */
  readonly providerId: string;
  /** Resolves a previously produced ref back to wire-safe metadata. */
  resolveAsset: (scope: RuntimeScope, ref: AssetRef) => Promise<AssetMetadata | null>;
}
