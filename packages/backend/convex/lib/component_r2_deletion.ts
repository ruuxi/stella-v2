import { makeFunctionReference } from "convex/server";

export type ComponentR2DeleteObject = {
  locatorId: string;
  r2Key: string;
};

export type ComponentR2DeleteResult = {
  confirmedLocatorIds: string[];
  failedLocatorIds: string[];
};

/**
 * Node-action boundary for component-backed R2 deletion. The component's own
 * delete mutation removes metadata synchronously but delegates physical R2
 * deletion to an ActionRetrier, so privacy-sensitive callers must cross this
 * direct-delete boundary before they acknowledge their last durable locator.
 */
export const deleteComponentR2ObjectsRef = makeFunctionReference<
  "action",
  { objects: ComponentR2DeleteObject[] },
  ComponentR2DeleteResult
>("component_r2_deletion:deleteComponentR2ObjectsInternal");
