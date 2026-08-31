import { useEffect, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  getCurrentConfirmation,
  registerConfirmationHost,
  settleConfirmation,
  subscribeToConfirmations,
} from "../lib/confirmation";

const EMPTY_CONFIRMATION = null;

export function ConfirmationDialogHost() {
  const confirmation = useSyncExternalStore(
    subscribeToConfirmations,
    getCurrentConfirmation,
    () => EMPTY_CONFIRMATION,
  );

  useEffect(() => registerConfirmationHost(), []);

  if (!confirmation) return null;

  const {
    id,
    title = "Confirm action",
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
  } = confirmation;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) settleConfirmation(id, false);
      }}
    >
      <AlertDialogContent
        key={id}
        data-testid="confirmation-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (!(event.currentTarget instanceof HTMLElement)) return;
          event.currentTarget
            .querySelector<HTMLElement>('[data-slot="alert-dialog-cancel"]')
            ?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap break-words">
            {message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settleConfirmation(id, false)}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => settleConfirmation(id, true)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
