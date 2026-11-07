import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "../../../i18n";
import type { ConversationIdentity } from "../../../lib/conversation/branches";

export type AttachmentIntakeResult =
  { ok: true } | { ok: false; error: string };

export type AttachmentIntake = (
  files: File[],
  identity?: ConversationIdentity,
  signal?: AbortSignal,
) => Promise<AttachmentIntakeResult>;

interface IntakeRegistration {
  intake: AttachmentIntake;
  available: boolean;
  busy: boolean;
}

const IntakeContext = createContext<
  | (IntakeRegistration & {
      register: (registration: IntakeRegistration) => () => void;
    })
  | null
>(null);

/** Connects sibling surfaces without taking ownership of the chat draft. */
export function AttachmentIntakeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const t = useT();
  const current = useRef<(IntakeRegistration & { token: symbol }) | null>(null);
  const [status, setStatus] = useState({ available: false, busy: false });
  const register = useCallback((registration: IntakeRegistration) => {
    const token = Symbol("attachment-intake");
    current.current = { ...registration, token };
    setStatus({ available: registration.available, busy: registration.busy });
    return () => {
      // An old input unmount must not unregister a newer input.
      if (current.current?.token !== token) return;
      current.current = null;
      setStatus({ available: false, busy: false });
    };
  }, []);
  const intake = useCallback<AttachmentIntake>(
    (files, identity, signal) => {
      const registered = current.current;
      if (!registered?.available) {
        return Promise.resolve({
          ok: false,
          error: t.chat.attachmentErrors.unavailable,
        });
      }
      return registered.intake(files, identity, signal);
    },
    [t],
  );
  const value = useMemo(
    () => ({ ...status, intake, register }),
    [status, intake, register],
  );
  return (
    <IntakeContext.Provider value={value}>{children}</IntakeContext.Provider>
  );
}

export function useAttachmentIntakeContext() {
  const context = useContext(IntakeContext);
  const t = useT();
  const unavailable = useCallback<AttachmentIntake>(
    async () => ({ ok: false, error: t.chat.attachmentErrors.unavailable }),
    [t],
  );
  return {
    available: context?.available ?? false,
    busy: context?.busy ?? false,
    intake: context?.intake ?? unavailable,
  };
}

export function useAttachmentIntakeRegistration() {
  return useContext(IntakeContext)?.register;
}
