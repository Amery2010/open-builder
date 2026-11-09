import type { DesignSystemPackage } from "./validation";
import { getDesignSystemRegistry } from "./registry";

export {
  applyDesignSystemPackage,
  type AppliedDesignSystemPackage,
} from "@open-builder/core/design-apply";

export function loadDesignSystemPackage(
  id: string,
): Promise<DesignSystemPackage> {
  return getDesignSystemRegistry().load(id);
}
