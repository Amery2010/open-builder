import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";

const TYPE_DELAY_MS = 85;
const HOLD_DELAY_MS = 3_000;
const DELETE_DELAY_MS = 50;
const GAP_DELAY_MS = 200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function GeneratingIndicator() {
  const t = useT();
  const verbs = t.message.generatingVerbs;
  const [index, setIndex] = useState(0);
  const [visibleLength, setVisibleLength] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const target = `${verbs[index] ?? verbs[0] ?? ""}…`;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    setIndex(0);
    setVisibleLength(0);
    setDeleting(false);
  }, [verbs]);

  useEffect(() => {
    if (!target) return;
    if (reducedMotion) {
      setVisibleLength(target.length);
      setDeleting(false);
      return;
    }

    let delay = TYPE_DELAY_MS;
    let next: () => void;
    if (!deleting && visibleLength < target.length) {
      next = () => setVisibleLength((length) => length + 1);
    } else if (!deleting) {
      delay = HOLD_DELAY_MS;
      next = () => setDeleting(true);
    } else if (visibleLength > 0) {
      delay = DELETE_DELAY_MS;
      next = () => setVisibleLength((length) => length - 1);
    } else {
      delay = GAP_DELAY_MS;
      next = () => {
        setIndex(Math.floor(Math.random() * verbs.length));
        setDeleting(false);
      };
    }

    const timeout = window.setTimeout(next, delay);
    return () => window.clearTimeout(timeout);
  }, [deleting, reducedMotion, target, verbs.length, visibleLength]);

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 py-1 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      <span aria-hidden="true">{target.slice(0, visibleLength)}</span>
      <span className="sr-only">{target}</span>
    </div>
  );
}
