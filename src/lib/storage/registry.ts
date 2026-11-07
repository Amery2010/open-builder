import { useConversationStore } from "../../store/conversation";
import { useMemoryStore } from "../../store/memory";
import { useMcpStore } from "../../store/mcp";
import { useProjectTemplateStore } from "../../store/project-templates";
import { useSettingsStore } from "../../store/settings";
import { useSkillsStore } from "../../store/skills";
import { useSnapshotStore } from "../../store/snapshot";
import { useDesignReviewStore } from "../../store/design-review";
import { useProjectDesignWorkspaceStore } from "../../store/project-design-workspace";
import {
  clearAttachmentStorage,
  estimateAttachmentStorage,
} from "../attachments/store";
import { clearPermissionActivity } from "../security/activity-log";
import {
  nativeSkillScriptRevocation,
  nativeSseRevocation,
} from "../security/native-execution-revocation";
import { resetSkillRegistryForTesting } from "../skills/instance";
import {
  beginMcpLifecycleRevocation,
  finishMcpLifecycleRevocation,
} from "../mcp/revocation";
import { redactStorageExport } from "./export-redaction";
import { createDefaultAgnesMcpSettings } from "../mcp/agnes/types";
import { stopAgnesVideoTasks } from "../mcp/agnes/video-task-manager";
import {
  clearProjectAssetStorage,
  estimateProjectAssetStorage,
  withProjectAssetOwnershipLock,
} from "../project-assets/core";
import { getDesignSystemRegistry } from "../design-systems/registry";

import {
  clearProjectArchiveStorage,
  estimateProjectArchiveStorage,
} from "../project-archives/service";
import { useProjectArchiveStore } from "../../store/project-archives";

export interface StorageEstimate {
  bytes: number;
  items: number;
  error?: string;
}

export interface StorageDomain {
  id:
    | "settings"
    | "conversations"
    | "designReviews"
    | "designWorkspace"
    | "snapshots"
    | "memories"
    | "templates"
    | "mcp"
    | "skills"
    | "designSystems"
    | "attachments"
    | "projectAssets"
    | "projectArchives";
  estimate(): Promise<StorageEstimate>;
  clear(): Promise<void>;
  export(): Promise<unknown>;
}

export interface StorageClearFailure {
  id: StorageDomain["id"];
  error: string;
}

export interface StorageClearSkip {
  id: StorageDomain["id"];
  reason: string;
}

export interface StorageClearResult {
  cleared: StorageDomain["id"][];
  failed: StorageClearFailure[];
  skipped: StorageClearSkip[];
}

export class StorageClearError extends Error {
  constructor(readonly result: StorageClearResult) {
    const details = [
      ...result.failed.map(
        ({ id, error }) => `Failed to clear storage domain "${id}": ${error}`,
      ),
      ...result.skipped.map(
        ({ id, reason }) => `Skipped storage domain "${id}": ${reason}`,
      ),
    ];
    super(details.join("; "));
    this.name = "StorageClearError";
  }
}

function jsonEstimate(value: unknown, items: number): StorageEstimate {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    items,
  };
}

async function clearPersistedStore(
  clearStorage: () => void | Promise<void>,
): Promise<void> {
  await Promise.resolve(clearStorage());
}

async function clearSkillFiles(): Promise<void> {
  const { createSkillFs, isSkillsAvailable } = await import("../skills/fs");
  if (!isSkillsAvailable()) return;
  const fs = createSkillFs();
  for (const entry of await fs.readDir("")) {
    if (entry.isDirectory) {
      await fs.remove(entry.name, { recursive: true });
    }
  }
  resetSkillRegistryForTesting();
}

export const STORAGE_DOMAINS: readonly StorageDomain[] = [
  {
    id: "settings",
    estimate: async () => jsonEstimate(useSettingsStore.getState(), 1),
    clear: async () => {
      await clearPersistedStore(() => useSettingsStore.persist.clearStorage());
      useSettingsStore.getState().resetAll();
      clearPermissionActivity();
    },
    export: async () =>
      redactStorageExport({
        ai: useSettingsStore.getState().ai,
        webSearch: useSettingsStore.getState().webSearch,
        assetSearch: useSettingsStore.getState().assetSearch,
        system: useSettingsStore.getState().system,
      }),
  },
  {
    id: "designReviews",
    estimate: async () => {
      const runsByConversation =
        useDesignReviewStore.getState().runsByConversation;
      return jsonEstimate(
        runsByConversation,
        Object.values(runsByConversation).reduce(
          (count, runs) => count + runs.length,
          0,
        ),
      );
    },
    clear: async () => {
      const { designReviewJobRunner } =
        await import("../design/review-jobs/runner");
      designReviewJobRunner.clear();
      await clearPersistedStore(() =>
        useDesignReviewStore.persist.clearStorage(),
      );
      useDesignReviewStore.getState().reset();
      useDesignReviewStore.getState().clearRuns();
    },
    export: async () =>
      redactStorageExport(useDesignReviewStore.getState().runsByConversation),
  },
  {
    id: "designWorkspace",
    estimate: async () => {
      const layouts = useProjectDesignWorkspaceStore.getState().layouts;
      return jsonEstimate(layouts, Object.keys(layouts).length);
    },
    clear: async () => {
      useProjectDesignWorkspaceStore.getState().clearLayouts();
      await clearPersistedStore(() =>
        useProjectDesignWorkspaceStore.persist.clearStorage(),
      );
    },
    export: async () => useProjectDesignWorkspaceStore.getState().layouts,
  },
  {
    id: "conversations",
    estimate: async () => {
      const state = useConversationStore.getState();
      return jsonEstimate(
        state.conversations,
        Object.keys(state.conversations).length,
      );
    },
    clear: async () => {
      await clearPersistedStore(() =>
        useConversationStore.persist.clearStorage(),
      );
      useConversationStore.setState({ conversations: {}, activeId: null });
    },
    export: async () =>
      redactStorageExport(useConversationStore.getState().conversations),
  },
  {
    id: "snapshots",
    estimate: async () => {
      const snapshots = useSnapshotStore.getState().snapshots;
      return jsonEstimate(
        snapshots,
        Object.values(snapshots).reduce((sum, chain) => sum + chain.length, 0),
      );
    },
    clear: async () => {
      await clearPersistedStore(() => useSnapshotStore.persist.clearStorage());
      useSnapshotStore.setState({ snapshots: {} });
    },
    export: async () =>
      redactStorageExport(useSnapshotStore.getState().snapshots),
  },
  {
    id: "memories",
    estimate: async () => {
      const memories = useMemoryStore.getState().memories;
      return jsonEstimate(memories, memories.length);
    },
    clear: async () => {
      await clearPersistedStore(() => useMemoryStore.persist.clearStorage());
      useMemoryStore.setState({ memories: [] });
    },
    export: async () => redactStorageExport(useMemoryStore.getState().memories),
  },
  {
    id: "templates",
    estimate: async () => {
      const templates = useProjectTemplateStore.getState().templates;
      return jsonEstimate(templates, Object.keys(templates).length);
    },
    clear: async () => {
      await clearPersistedStore(() =>
        useProjectTemplateStore.persist.clearStorage(),
      );
      useProjectTemplateStore.setState({ templates: {} });
    },
    export: async () =>
      redactStorageExport(useProjectTemplateStore.getState().templates),
  },
  {
    id: "mcp",
    estimate: async () => {
      const { servers, agnes } = useMcpStore.getState();
      return jsonEstimate({ servers, agnes }, Object.keys(servers).length + 1);
    },
    clear: async () => {
      const { getMcpConnectionManager } =
        await import("../mcp/connection-manager");
      await getMcpConnectionManager().closeAll();
      stopAgnesVideoTasks();
      await clearPersistedStore(() => useMcpStore.persist.clearStorage());
      useMcpStore.setState({
        globalEnabled: true,
        agnes: createDefaultAgnesMcpSettings(),
        servers: {},
        runtime: {},
      });
    },
    export: async () => {
      const { servers, agnes } = useMcpStore.getState();
      return redactStorageExport({ servers, agnes });
    },
  },
  {
    id: "skills",
    estimate: async () => {
      const skills = useSkillsStore.getState().skills;
      return jsonEstimate(skills, Object.keys(skills).length);
    },
    clear: async () => {
      await clearSkillFiles();
      await clearPersistedStore(() => useSkillsStore.persist.clearStorage());
      useSkillsStore.setState({ skills: {}, _hasHydrated: true });
    },
    export: async () => redactStorageExport(useSkillsStore.getState().skills),
  },
  {
    id: "designSystems",
    estimate: async () => {
      const { count, bytes, invalid } =
        await getDesignSystemRegistry().estimateImportedStorage();
      return {
        items: count,
        bytes,
        ...(invalid > 0
          ? {
              error: `${invalid} imported Design system package(s) are incomplete.`,
            }
          : {}),
      };
    },
    clear: async () => getDesignSystemRegistry().clearImported(),
    export: async () => ({
      note: "Imported Design system files are excluded from generic storage export.",
      ...(await getDesignSystemRegistry().estimateImportedStorage()),
    }),
  },
  {
    id: "attachments",
    estimate: async () => {
      const { count, bytes } = await estimateAttachmentStorage();
      return { items: count, bytes };
    },
    clear: clearAttachmentStorage,
    export: async () => ({
      note: "Attachment blobs are intentionally excluded from generic export.",
      ...(await estimateAttachmentStorage()),
    }),
  },
  {
    id: "projectAssets",
    estimate: async () => {
      const { count, bytes, invalid } = await estimateProjectAssetStorage();
      return {
        items: count,
        bytes,
        ...(invalid > 0
          ? { error: `${invalid} stored project image value(s) are invalid.` }
          : {}),
      };
    },
    clear: clearProjectAssetStorage,
    export: async () => ({
      note: "Project asset blobs are exported with their projects, not generic storage metadata.",
      ...(await estimateProjectAssetStorage()),
    }),
  },
  {
    id: "projectArchives",
    estimate: estimateProjectArchiveStorage,
    clear: async () => {
      await clearProjectArchiveStorage();
      await clearPersistedStore(() =>
        useProjectArchiveStore.persist.clearStorage(),
      );
    },
    export: async () => ({
      note: "Project ZIP files are downloaded from their checkpoints; generic exports contain metadata only.",
      records: useProjectArchiveStore.getState().records,
      cleanup: useProjectArchiveStore.getState().cleanup,
    }),
  },
] as const;

export async function estimateStorageDomains(): Promise<
  Record<StorageDomain["id"], StorageEstimate>
> {
  return Object.fromEntries(
    await Promise.all(
      STORAGE_DOMAINS.map(async (domain) => {
        try {
          return [domain.id, await domain.estimate()] as const;
        } catch (error) {
          return [
            domain.id,
            {
              items: 0,
              bytes: 0,
              error: error instanceof Error ? error.message : String(error),
            },
          ] as const;
        }
      }),
    ),
  ) as Record<StorageDomain["id"], StorageEstimate>;
}

export async function clearAllStorageDomains(): Promise<string[]> {
  // This synchronous gate is intentionally the first operation: any connect
  // already in flight becomes stale before cleanup performs its first await.
  const revocation = beginMcpLifecycleRevocation();
  const skillRevocation = nativeSkillScriptRevocation.begin();
  const sseRevocation = nativeSseRevocation.begin();
  try {
    const [
      { revokeNativeProxyPolicy },
      { clearTauriMcpRemotePolicies },
      { cancelAllNativeSkillScripts },
      { cancelAllNativeSseStreams },
    ] = await Promise.all([
      import("../infra/proxy"),
      import("../mcp/tauri-host"),
      import("../skills/script-executor-tauri"),
      import("../infra/sse-bridge"),
    ]);
    await Promise.all([
      revokeNativeProxyPolicy(),
      clearTauriMcpRemotePolicies(),
      cancelAllNativeSkillScripts(),
      cancelAllNativeSseStreams(),
    ]);

    return await withProjectAssetOwnershipLock(async () => {
      const result: StorageClearResult = {
        cleared: [],
        failed: [],
        skipped: [],
      };
      const failed = new Set<StorageDomain["id"]>();
      for (const domain of STORAGE_DOMAINS) {
        const requiredOwners =
          domain.id === "attachments"
            ? (["conversations"] as const)
            : domain.id === "projectAssets"
              ? (["conversations", "snapshots", "templates"] as const)
              : domain.id === "projectArchives"
                ? (["conversations", "snapshots"] as const)
                : ([] as const);
        const unavailableOwners = requiredOwners.filter((id) => failed.has(id));
        if (unavailableOwners.length > 0) {
          result.skipped.push({
            id: domain.id,
            reason: `owner domain(s) did not clear: ${unavailableOwners.join(", ")}`,
          });
          continue;
        }
        try {
          await domain.clear();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failed.add(domain.id);
          result.failed.push({ id: domain.id, error: detail });
          continue;
        }
        result.cleared.push(domain.id);
      }
      if (result.failed.length > 0 || result.skipped.length > 0) {
        throw new StorageClearError(result);
      }
      return result.cleared;
    });
  } finally {
    nativeSseRevocation.finish(sseRevocation);
    nativeSkillScriptRevocation.finish(skillRevocation);
    finishMcpLifecycleRevocation(revocation);
  }
}
