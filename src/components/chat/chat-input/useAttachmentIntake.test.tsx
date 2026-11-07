// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../../store/conversation";
import { useSettingsStore } from "../../../store/settings";
import { captureConversationIdentity } from "../../../lib/conversation/branches";
import type { Attachment } from "../../../types";
import {
  AttachmentIntakeProvider,
  useAttachmentIntakeContext,
  useAttachmentIntakeRegistration,
  type AttachmentIntakeResult,
} from "./AttachmentIntakeContext";
import { useAttachmentIntake } from "./useAttachmentIntake";

const mocks = vi.hoisted(() => ({
  compress: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../../lib/images", () => ({ compressLocalImage: mocks.compress }));
vi.mock("../../../lib/attachments/store", () => ({
  storeAttachmentFile: mocks.store,
  deleteAttachment: mocks.remove,
}));

function file(name = "annotation.png") {
  return new File(["image bytes"], name, { type: "image/png" });
}
function stored(input: File): Attachment {
  return {
    id: input.name,
    type: "image",
    name: input.name,
    size: input.size,
    mimeType: input.type,
    previewUrl: `blob:${input.name}`,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function currentIdentity() {
  const state = useConversationStore.getState();
  return captureConversationIdentity(state.conversations[state.activeId!]);
}
function wrapper({ children }: { children: ReactNode }) {
  return <AttachmentIntakeProvider>{children}</AttachmentIntakeProvider>;
}
function mount(initial: Attachment[] = []) {
  return renderHook(
    () => {
      const [attachments, setAttachments] = useState(initial);
      const [disabled, setDisabled] = useState(false);
      const input = useAttachmentIntake({
        attachments,
        onAttachmentsChange: setAttachments,
        disabled,
      });
      const external = useAttachmentIntakeContext();
      return { input, external, attachments, setAttachments, setDisabled };
    },
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({
    conversations: {},
    activeId: null,
    _hasHydrated: true,
  });
  useConversationStore.getState().createConversation();
  useSettingsStore.setState((state) => ({
    system: {
      ...state.system,
      language: "en",
      imageCompressionEnabled: true,
      imageCompressionQuality: 0.85,
    },
  }));
  mocks.compress.mockImplementation(async (input: File) => input);
  mocks.store.mockImplementation(async (input: File) => stored(input));
  mocks.remove.mockResolvedValue(undefined);
  URL.revokeObjectURL = vi.fn();
});

describe("shared attachment intake", () => {
  it("never replaces the first result when a second intake starts before React commits", async () => {
    const { result } = mount();
    await act(async () => {
      expect(
        await result.current.external.intake(
          [file("first.png")],
          currentIdentity(),
        ),
      ).toEqual({ ok: true });
      expect(
        await result.current.external.intake(
          [file("second.png")],
          currentIdentity(),
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("processed"),
      });
    });
    expect(
      result.current.attachments.some((entry) => entry.name === "first.png"),
    ).toBe(true);
    await act(async () => {
      expect(
        await result.current.external.intake(
          [file("second.png")],
          currentIdentity(),
        ),
      ).toEqual({ ok: true });
    });
    expect(result.current.attachments.map((entry) => entry.name)).toEqual([
      "first.png",
      "second.png",
    ]);
  });
  it("appends external images to the existing draft using the compression settings", async () => {
    const old = stored(file("existing.png"));
    const { result } = mount([old]);
    expect(result.current.external.available).toBe(true);
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toEqual({ ok: true });
    });
    expect(result.current.attachments.map((entry) => entry.name)).toEqual([
      "existing.png",
      "annotation.png",
    ]);
    expect(mocks.compress).toHaveBeenCalledWith(
      expect.any(File),
      { enabled: true, quality: 0.85 },
      expect.any(AbortSignal),
    );
    expect(result.current.external.busy).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("serializes file and annotation entry points and does not queue duplicate requests", async () => {
    const compress = deferred<File>();
    mocks.compress.mockReturnValueOnce(compress.promise);
    const { result } = mount();
    let first!: Promise<AttachmentIntakeResult>;
    await act(async () => {
      first = result.current.input.intake([file("upload.png")]);
    });
    expect(result.current.external.busy).toBe(true);
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("processed"),
      });
    });
    await act(async () => {
      compress.resolve(file("upload.png"));
      await first;
    });
    expect(result.current.attachments.map((entry) => entry.name)).toEqual([
      "upload.png",
    ]);
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("rejects an annotation from a stale branch before any processing", async () => {
    const identity = { ...currentIdentity(), checkoutEpoch: 42 };
    const { result } = mount();
    await act(async () => {
      expect(
        await result.current.external.intake([file()], identity),
      ).toMatchObject({ ok: false });
    });
    expect(mocks.compress).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(["branch", "checkout", "away-and-back"])(
    "permanently cancels compression after %s changes",
    async (change) => {
      const identity = currentIdentity();
      const compress = deferred<File>();
      mocks.compress.mockReturnValueOnce(compress.promise);
      const { result } = mount();
      let work!: Promise<AttachmentIntakeResult>;
      await act(async () => {
        work = result.current.external.intake([file()], identity);
        const state = useConversationStore.getState();
        const conversation = state.conversations[identity.conversationId];
        if (change === "away-and-back") {
          useConversationStore.setState({ activeId: null });
          useConversationStore.setState({ activeId: identity.conversationId });
        } else {
          useConversationStore.setState({
            conversations: {
              ...state.conversations,
              [conversation.id]: {
                ...conversation,
                ...(change === "branch"
                  ? { activeBranchId: "new-branch" }
                  : { checkoutEpoch: identity.checkoutEpoch + 1 }),
              },
            },
          });
        }
        compress.resolve(file());
        expect(await work).toMatchObject({ ok: false });
      });
      expect(mocks.store).not.toHaveBeenCalled();
      expect(result.current.attachments).toEqual([]);
    },
  );

  it("allows project file changes within the same conversation identity", async () => {
    const compress = deferred<File>();
    mocks.compress.mockReturnValueOnce(compress.promise);
    const { result } = mount();
    await act(async () => {
      const work = result.current.external.intake([file()], currentIdentity());
      const state = useConversationStore.getState();
      const id = state.activeId!;
      useConversationStore.setState({
        conversations: {
          ...state.conversations,
          [id]: { ...state.conversations[id], files: { "index.html": "new" } },
        },
      });
      compress.resolve(file());
      expect(await work).toEqual({ ok: true });
    });
    expect(result.current.attachments).toHaveLength(1);
  });

  it("removes a late stored blob and URL after external cancellation", async () => {
    const storage = deferred<Attachment>();
    mocks.store.mockReturnValueOnce(storage.promise);
    const { result } = mount();
    const controller = new AbortController();
    let work!: Promise<AttachmentIntakeResult>;
    await act(async () => {
      work = result.current.external.intake(
        [file()],
        currentIdentity(),
        controller.signal,
      );
    });
    expect(mocks.store).toHaveBeenCalledOnce();
    await act(async () => {
      controller.abort();
      storage.resolve(stored(file()));
      expect(await work).toMatchObject({ ok: false });
    });
    expect(result.current.attachments).toEqual([]);
    expect(mocks.remove).toHaveBeenCalledWith("annotation.png");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:annotation.png");
  });

  it("does not overwrite a draft restored while storage is pending", async () => {
    const storage = deferred<Attachment>();
    mocks.store.mockReturnValueOnce(storage.promise);
    const { result } = mount();
    let work!: Promise<AttachmentIntakeResult>;
    await act(async () => {
      work = result.current.external.intake([file()], currentIdentity());
    });
    act(() => result.current.setAttachments([stored(file("restored.png"))]));
    await act(async () => {
      storage.resolve(stored(file()));
      expect(await work).toMatchObject({ ok: false });
    });
    expect(result.current.attachments.map((entry) => entry.name)).toEqual([
      "restored.png",
    ]);
    expect(mocks.remove).toHaveBeenCalledWith("annotation.png");
  });

  it("rejects full drafts without storing and permits retry after removing an attachment", async () => {
    const { result } = mount(
      Array.from({ length: 8 }, (_, i) => stored(file(`${i}.png`))),
    );
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toMatchObject({ ok: false });
    });
    expect(mocks.store).not.toHaveBeenCalled();
    act(() =>
      result.current.setAttachments(result.current.attachments.slice(1)),
    );
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toEqual({ ok: true });
    });
    expect(result.current.attachments).toHaveLength(8);
  });

  it("reports storage failure without adding an attachment and permits retry", async () => {
    mocks.store.mockRejectedValueOnce(new Error("quota"));
    const { result } = mount();
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toMatchObject({ ok: false });
    });
    expect(result.current.attachments).toEqual([]);
    await act(async () => {
      expect(
        await result.current.external.intake([file()], currentIdentity()),
      ).toEqual({ ok: true });
    });
    expect(result.current.attachments).toHaveLength(1);
  });

  it("cleans late storage after unmount and makes saved context handles unavailable", async () => {
    const storage = deferred<Attachment>();
    mocks.store.mockReturnValueOnce(storage.promise);
    const { result, unmount } = mount();
    const external = result.current.external;
    let work!: Promise<AttachmentIntakeResult>;
    await act(async () => {
      work = external.intake([file()], currentIdentity());
    });
    unmount();
    await act(async () => {
      storage.resolve(stored(file()));
      expect(await work).toMatchObject({ ok: false });
    });
    expect(mocks.remove).toHaveBeenCalledWith("annotation.png");
    expect(await external.intake([file()], currentIdentity())).toMatchObject({
      ok: false,
    });
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("does not let an old registration cleanup unregister a newer input", async () => {
    const { result } = renderHook(
      () => ({
        register: useAttachmentIntakeRegistration()!,
        external: useAttachmentIntakeContext(),
      }),
      { wrapper },
    );
    const first = vi.fn(async () => ({ ok: true as const }));
    const second = vi.fn(async () => ({ ok: true as const }));
    act(() => {
      const cleanup = result.current.register({
        intake: first,
        available: true,
        busy: false,
      });
      result.current.register({ intake: second, available: true, busy: false });
      cleanup();
    });
    await result.current.external.intake([file()], currentIdentity());
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("returns an unavailable result when there is no input registered", async () => {
    const { result } = renderHook(useAttachmentIntakeContext, { wrapper });
    expect(result.current.available).toBe(false);
    expect(
      await result.current.intake([file()], currentIdentity()),
    ).toMatchObject({ ok: false });
  });
});
