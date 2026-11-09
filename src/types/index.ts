import type { DesignSystemRef } from "@open-builder/core";
export type { DesignSystemSource, DesignSystemRef } from "@open-builder/core";
import type {
  Message as _Message,
  ProjectFiles as _ProjectFiles,
  StructuredGenerationErrorKind as _StructuredGenerationErrorKind,
  ToolExecutionOutput as _ToolExecutionOutput,
  AttachmentRef as _AttachmentRef,
  MessageMetadata as _MessageMetadata,
} from "../lib/ai/generator-types";
import type { LocalAgentProvider } from "../lib/local-agent/providers";

export type {
  ProjectFiles,
  ContentPart,
  Message,
  ToolCall,
  ToolDefinition,
  FileChange,
  GenerateResult,
  GeneratorRunState,
  GeneratorEvent,
  StructuredGenerationError,
  StructuredGenerationErrorKind,
  GeneratorOptions,
  GeneratorEvents,
  ToolExecutionContent,
  ToolExecutionContext,
  ToolExecutionOutput,
  McpToolExecutionIdentity,
  AttachmentRef,
  ResolvedAttachment,
  MessageMetadata,
  DesignSelectionContext,
} from "../lib/ai/generator-types";

export type {
  AISettings,
  WebSearchSettings,
  AssetSearchSettings,
} from "../store/settings";
export type { OpenAIClientConfig } from "../lib/ai/client";
export type { ApiType } from "../lib/ai/provider-config";

// ─── Chat UI types ────────────────────────────────────────────────────────────

/** Attachment in the input pipeline (before sending) */
export interface Attachment extends _AttachmentRef {
  /** Ephemeral object URL used only while the input is visible. */
  previewUrl?: string;
  /** Legacy inline content. New attachments are stored in the Blob domain. */
  content?: string;
}

export interface AttachmentConstraints {
  maxCount: number;
  maxImageBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export type AttachmentValidationCode =
  | "max_count"
  | "max_total_size"
  | "max_image_size"
  | "unsupported_type"
  | "max_file_size";

export type AttachmentValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: AttachmentValidationCode;
      reason: string;
      limit?: number;
      name?: string;
    };

export interface TextBlock {
  type: "text";
  content: string;
  id: string;
}

export interface ImageBlock {
  type: "image";
  url?: string;
  attachmentId?: string;
  name?: string;
  id: string;
}

export interface FileBlock {
  type: "file";
  name: string;
  content?: string;
  attachmentId?: string;
  mimeType?: string;
  /** Original file size in bytes */
  size: number;
  id: string;
}

export interface ThinkingBlock {
  type: "thinking";
  content: string;
  id: string;
}

export interface SkillLoadItem {
  name: string;
  referencePaths?: string[];
  status: "running" | "completed" | "failed" | "attention";
  error?: string;
}

export interface ToolBlock {
  type: "tool";
  toolName: string;
  title: string;
  path: string;
  paths?: string[];
  result: string;
  /** Persisted rich output and original MCP identity, when applicable. */
  toolOutput?: _ToolExecutionOutput;
  /** Tool call id used by the AI SDK — needed to correlate with pending UI prompts. */
  toolCallId: string;
  /** Raw parsed arguments the AI passed to the tool. Used by interactive tools
   *  (ask_user_question, exit_plan_mode) that render full args in the UI. */
  rawArgs?: Record<string, unknown>;
  /** Presentation-only summary used when list_skills/read_skill calls from one
   * assistant turn are rendered as a single expandable loading card. */
  skillLoads?: SkillLoadItem[];
  id: string;
}

export type Block =
  TextBlock | ImageBlock | FileBlock | ThinkingBlock | ToolBlock;

export interface MergedMessage {
  role: "user" | "assistant";
  blocks: Block[];
  id: string;
  /** Stable rendering identity while a submitted update moves into model history. */
  instructionId?: string;
  origin?: "auto_qa" | "design_review" | "design_auto_fix";
  reviewJobId?: string;
  reviewSummary?: NonNullable<_Message["metadata"]>["reviewSummary"];
  /** True when this assistant message was synthesized to report a local error
   *  (network failure, aborted retry, etc.). Drives the retry affordance in the
   *  UI without relying on string-prefix sniffing. */
  isError?: boolean;
  errorKind?: _StructuredGenerationErrorKind;
  errorRetryable?: boolean;
  errorStatus?: number;
  localCliFailure?: _Message["localCliFailure"];
  localCli?: _MessageMetadata["localCli"];
}

// ─── Snapshot types ─────────────────────────────────────────────────────────

/** Incremental project snapshot (git-like).
 *  Snapshots come in two flavours:
 *    - "patch" (default): records adds/patches/deletes relative to the prior snapshot
 *    - "checkpoint": records the full file tree, anchoring future replays so we
 *      don't have to walk the entire chain. Inserted automatically every
 *      CHECKPOINT_INTERVAL patches.
 */
export interface ProjectSnapshot {
  branchId?: string;
  /** Explicit ancestry for new snapshots; undefined identifies a legacy linear chain. */
  parentSnapshotId?: string | null;
  /** Diagnostic count only; message filtering can invalidate positional offsets. */
  messageCount?: number;
  /** Stable last retained message at publication, before later turns can append. */
  endMessageId?: string;
  /** Legacy positional links have been resolved once (including unlinked records). */
  messageLinkVersion?: 1;
  hidden?: boolean;
  projectState?: Pick<
    Conversation,
    | "template"
    | "previewMode"
    | "designState"
    | "activeFile"
    | "isProjectInitialized"
  >;
  id: string;
  /** The conversation this snapshot belongs to */
  conversationId: string;
  /** Associated MergedMessage ID (e.g. "assistant-0") */
  messageId: string;
  /** File path → unified diff patch (modified files only) */
  patches: Record<string, string>;
  /** Newly added files: path → full content */
  addedFiles: Record<string, string>;
  /** Paths of deleted files */
  deletedFiles: string[];
  createdAt: number;
  /** Snapshot type — older records lack this field and are implicitly "patch". */
  kind?: "patch" | "checkpoint";
  /** Optional user-facing label for the snapshot history panel. */
  label?: string;
  /** Full file tree at this point. Only present on checkpoint snapshots. */
  fullFiles?: _ProjectFiles;
  /** Binary project assets are stored out of line; snapshots retain only their
   * content-addressed references. Older snapshots implicitly contain none. */
  assets?: ProjectAssets;
}

// ─── Memory types ───────────────────────────────────────────────────────────

export interface MemoryItem {
  id: string;
  content: string;
  category: "preference" | "personal_info" | "instruction" | "fact" | "project";
  createdAt: number;
  updatedAt: number;
}

export interface MemoryOperation {
  action: "add" | "update" | "delete";
  /** Required for update and delete */
  id?: string;
  /** Required for add and update */
  content?: string;
  /** Required for add, optional for update */
  category?: MemoryItem["category"];
}

// ─── Conversation types ──────────────────────────────────────────────────────

/** Compressed context: summary text + the message index where compression starts */
export interface CompressedContext {
  summary: string;
  fromIndex: number;
}

export type { LocalAgentProvider } from "../lib/local-agent/providers";
export type {
  LocalAgentRunScope,
  LocalAgentRunScopeKind,
  LocalCliCatalogAuthority,
  LocalCliFailure,
  LocalCliFailureCode,
  LocalCliFailurePhase,
  LocalCliInspectionStatus,
  LocalCliPreparedMetadata,
  LocalCliRetryPolicy,
  LocalCliRunStatus,
  LocalCliUnavailableReason,
  LocalCliUsage,
  LocalCliHostToolOutcome,
  LocalToolAnnotations,
  LocalToolHostApproval,
} from "../lib/local-agent/types";

export interface LocalAgentSessionRef {
  provider: LocalAgentProvider;
  sessionId: string;
  transcriptFingerprint: string;
  model?: string;
  /** Compatibility material captured by the backend before a run starts. */
  compatibilityKey?: string;
  installationFingerprint?: string;
  actualModel?: string;
  actualEffort?: string;
  cliVersion: string;
  updatedAt: number;
}

export type ProjectPreviewMode = "sandpack" | "code-only";

/** Canonical preview device used for persisted preferences and evidence. */
export type PreviewView = "desktop" | "tablet" | "mobile";

export function isPreviewView(value: unknown): value is PreviewView {
  return value === "desktop" || value === "tablet" || value === "mobile";
}

/** Normalizes persisted or adapter-provided preview values fail-closed. */
export function normalizePreviewView(value: unknown): PreviewView {
  return isPreviewView(value) ? value : "desktop";
}

/** User-facing workflow mode. It is intentionally separate from the lower-level
 * execution modes used by the generator and local-agent protocol. */
export type WorkspaceMode = "auto" | "plan" | "design";

export type PlanReturnMode = Exclude<WorkspaceMode, "plan">;

export interface DesignRecommendation {
  systemId: string | null;
  reason: string;
  createdAt: number;
}

export interface ConversationDesignState {
  /** The current choice. Empty projects retain it until initialization; an
   * initialized project applies it through the canonical package writer. */
  selectedSystem?: DesignSystemRef;
  /** The package whose canonical DESIGN.md and tokens.css are in the project. */
  appliedSystem?: DesignSystemRef;
  recommendation?: DesignRecommendation;
  /** A failed automatic decision remains retryable on the next request. */
  autoSelectionError?: boolean;
}

export interface PendingUserInstruction {
  id: string;
  conversationId: string;
  runId: string;
  sequence: number;
  /** Display boundary in canonical history when this message was submitted. */
  afterMessageIndex?: number;
  content: string;
  attachments: _AttachmentRef[];
  forcedSkillIds: string[];
  status: "queued" | "delivering" | "cancelled" | "failed" | "uncertain";
}

export interface ConversationBranchState {
  messages: _Message[];
  files: _ProjectFiles;
  assets?: ProjectAssets;
  template: string;
  previewMode?: ProjectPreviewMode;
  isProjectInitialized: boolean;
  designState?: ConversationDesignState;
  activeFile?: string;
  compressedContext?: CompressedContext;
}

export interface ConversationBranch {
  id: string;
  name: string;
  parentBranchId?: string;
  forkMessageId?: string;
  forkSnapshotId?: string;
  headSnapshotId?: string;
  createdAt: number;
  updatedAt: number;
  state: ConversationBranchState;
}

export interface ConversationCheckout {
  branchId: string;
  snapshotId: string;
  messageId: string;
}

export interface Conversation {
  activeBranchId?: string;
  checkoutEpoch?: number;
  branches?: Record<string, ConversationBranch>;
  checkout?: ConversationCheckout;
  id: string;
  title: string;
  messages: _Message[];
  pendingUserInstructions?: PendingUserInstruction[];
  files: _ProjectFiles;
  /** Binary project assets keyed by their project-relative path. */
  assets?: ProjectAssets;
  template: string;
  previewMode?: ProjectPreviewMode;
  /** Project preference for the initial preview device. Manual device changes
   * are intentionally kept as a mount-local UI override. */
  defaultPreviewView?: PreviewView;
  isProjectInitialized: boolean;
  workspaceMode?: WorkspaceMode;
  /** Where approval should return when Plan was entered from another mode. */
  planReturnMode?: PlanReturnMode;
  designState?: ConversationDesignState;
  compressedContext?: CompressedContext;
  localAgentSessions?: Partial<
    Record<LocalAgentProvider, LocalAgentSessionRef>
  >;
  activeFile?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Read-only provenance for conversations materialized from a starter. */
  templateOrigin?: {
    templateId: string;
    templateName: string;
    contentDigest: string;
    createdAt: number;
  };
  createdAt: number;
  updatedAt: number;
}

export type ProjectAssetMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/x-icon"
  | "image/avif"
  | "font/woff"
  | "font/woff2"
  | "font/ttf"
  | "font/otf";

export interface ProjectAsset {
  /** Project-relative export path, for example public/generated/hero.png. */
  path: string;
  /** Content-addressed key in the project asset Blob store. */
  blobRef: string;
  mimeType: ProjectAssetMimeType;
  size: number;
  /** Lower-case SHA-256 digest of the original asset bytes. */
  digest: string;
  /** Managed text module that application source can import. */
  modulePath: string;
  /** Absolute browser URL for public/ assets; source-imported assets use "". */
  publicPath: string;
}

export type ProjectAssets = Record<string, ProjectAsset>;

// ─── Project template types ─────────────────────────────────────────────────

export interface ProjectTemplate {
  id: string;
  name: string;
  description?: string;
  files: _ProjectFiles;
  /** Binary asset references owned by this Starter. Schema v3 records include
   * this table in their content digest; older records implicitly contain none. */
  assets?: ProjectAssets;
  template: string;
  previewMode?: ProjectPreviewMode;
  /** Presentation metadata only; intentionally excluded from contentDigest. */
  defaultPreviewView?: PreviewView;
  sourceConversationId?: string;
  tags: string[];
  /** Records without this field are retained v1 templates. */
  schemaVersion?: 1 | 2 | 3;
  contentDigest?: string;
  activeFile?: string;
  designState?: ConversationDesignState;
  analysis?: {
    framework: string;
    language: string;
    tests: string[];
    designSystem?: string;
    autoTags: string[];
  };
  safety?: {
    status: "safe" | "pending-upgrade";
    excludedPaths: string[];
    redactedPaths: string[];
    preparedAt?: number;
  };
  sourceUpdatedAt?: number;
  lastUsedAt?: number;
  useCount?: number;
  createdAt: number;
  updatedAt: number;
}
