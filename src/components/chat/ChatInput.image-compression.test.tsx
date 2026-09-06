// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useConversationStore } from "../../store/conversation";
import { useDesignSelectionStore } from "../../store/design-selection";
import { useSettingsStore } from "../../store/settings";
import { useSkillsStore } from "../../store/skills";
import { ChatInput } from "./ChatInput";
import type { Attachment } from "../../types";

const imageCompressionMocks = vi.hoisted(() => ({
  compressLocalImage: vi.fn(),
}));

const attachmentStoreMocks = vi.hoisted(() => ({
  deleteAttachment: vi.fn(),
  storeAttachmentFile: vi.fn(),
}));

vi.mock("../../lib/images", () => imageCompressionMocks);
vi.mock("../../lib/attachments/store", () => ({
  deleteAttachment: attachmentStoreMocks.deleteAttachment,
  storeAttachmentFile: attachmentStoreMocks.storeAttachmentFile,
}));

function renderInput(onAttachmentsChange = vi.fn()) {
  return render(
    <TooltipProvider>
      <ChatInput
        input=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isGenerating={false}
        messages={[]}
        attachments={[]}
        onAttachmentsChange={onAttachmentsChange}
        onImportProject={vi.fn(() => ({ ok: true as const }))}
        hasExistingProject
        onSlashCommand={vi.fn()}
        forcedSkillIds={[]}
        onForcedSkillIdsChange={vi.fn()}
        onApplyDesignSystem={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("ChatInput image compression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    useConversationStore.setState({
      conversations: {},
      activeId: null,
      _hasHydrated: true,
      legacyPlanModeMigrated: true,
    });
    useDesignSelectionStore.setState({ selections: {} });
    useSkillsStore.setState({ skills: {}, _hasHydrated: true });
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        language: "en",
        imageCompressionEnabled: true,
        imageCompressionQuality: 0.85,
      },
    }));
    attachmentStoreMocks.deleteAttachment.mockResolvedValue(undefined);
    attachmentStoreMocks.storeAttachmentFile.mockImplementation(
      async (file: File, type: Attachment["type"]) => ({
        id: `attachment-${file.name}`,
        type,
        name: file.name,
        mimeType: file.type,
        size: file.size,
      }),
    );
    imageCompressionMocks.compressLocalImage.mockImplementation(
      async (file: File) => file,
    );
  });

  it("compresses selected images with a fixed settings snapshot and blocks duplicate input", async () => {
    let resolveCompression!: (file: File) => void;
    imageCompressionMocks.compressLocalImage.mockImplementationOnce(
      (file: File, settings: { enabled: boolean; quality: number }) => {
        expect(settings).toEqual({ enabled: true, quality: 0.85 });
        return new Promise<File>((resolve) => {
          resolveCompression = () => resolve(file);
        });
      },
    );
    const onAttachmentsChange = vi.fn();
    const { container } = renderInput(onAttachmentsChange);
    const imageInput = container.querySelector(
      'input[type="file"][accept="image/*"]',
    );
    expect(imageInput).not.toBeNull();
    const file = new File([new Uint8Array([1, 2, 3])], "hero.png", {
      type: "image/png",
    });

    fireEvent.change(imageInput!, { target: { files: [file] } });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Processing images…",
    );
    expect(imageCompressionMocks.compressLocalImage).toHaveBeenCalledOnce();

    // The input remains guarded until the first batch has finished.
    fireEvent.change(imageInput!, { target: { files: [file] } });
    expect(imageCompressionMocks.compressLocalImage).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await act(async () => {
      resolveCompression(file);
    });

    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "hero.png", type: "image" }),
    ]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("passes disabled compression settings through without creating a worker", async () => {
    useSettingsStore.setState((state) => ({
      system: {
        ...state.system,
        imageCompressionEnabled: false,
        imageCompressionQuality: 0.42,
      },
    }));
    const onAttachmentsChange = vi.fn();
    const { container } = renderInput(onAttachmentsChange);
    const imageInput = container.querySelector(
      'input[type="file"][accept="image/*"]',
    );
    const file = new File([new Uint8Array([1, 2, 3])], "original.jpg", {
      type: "image/jpeg",
    });

    fireEvent.change(imageInput!, { target: { files: [file] } });

    await vi.waitFor(() => expect(onAttachmentsChange).toHaveBeenCalled());
    expect(imageCompressionMocks.compressLocalImage).toHaveBeenCalledWith(
      file,
      { enabled: false, quality: 0.42 },
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({ size: file.size }),
    ]);
  });

  it("stores the validated original when compression fails", async () => {
    imageCompressionMocks.compressLocalImage.mockRejectedValueOnce(
      new Error("canvas unavailable"),
    );
    const onAttachmentsChange = vi.fn();
    const { container } = renderInput(onAttachmentsChange);
    const imageInput = container.querySelector(
      'input[type="file"][accept="image/*"]',
    );
    const file = new File([new Uint8Array([1, 2, 3])], "fallback.png", {
      type: "image/png",
    });

    fireEvent.change(imageInput!, { target: { files: [file] } });

    await vi.waitFor(() =>
      expect(attachmentStoreMocks.storeAttachmentFile).toHaveBeenCalledWith(
        file,
        "image",
      ),
    );
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "fallback.png" }),
    ]);
  });

  it("cleans stored results when the active conversation changes before attachment commit", async () => {
    const initialConversation = useConversationStore
      .getState()
      .createConversation();
    const nextConversation = useConversationStore
      .getState()
      .createConversation();
    useConversationStore.getState().switchConversation(initialConversation);
    attachmentStoreMocks.storeAttachmentFile.mockImplementationOnce(
      async (file: File, type: Attachment["type"]) => {
        const attachment = {
          id: `attachment-${file.name}`,
          type,
          name: file.name,
          mimeType: file.type,
          size: file.size,
        };
        useConversationStore.getState().switchConversation(nextConversation);
        return attachment;
      },
    );
    const onAttachmentsChange = vi.fn();
    const { container } = renderInput(onAttachmentsChange);
    const imageInput = container.querySelector(
      'input[type="file"][accept="image/*"]',
    );
    const file = new File([new Uint8Array([1, 2, 3])], "stale.webp", {
      type: "image/webp",
    });
    fireEvent.change(imageInput!, { target: { files: [file] } });

    await vi.waitFor(() =>
      expect(attachmentStoreMocks.deleteAttachment).toHaveBeenCalledWith(
        "attachment-stale.webp",
      ),
    );

    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});
