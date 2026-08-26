/**
 * The one mascot Stella ships with.
 *
 * The sprite sheet is bundled under `desktop-ui/public/pets/stella.webp`, so
 * the floating overlay and onboarding always render synchronously — offline,
 * signed out, and before any network request. There is no catalog, no
 * selection, and no remote resolution: this descriptor is the whole surface.
 */
export type BuiltInPet = {
  id: string;
  displayName: string;
  spritesheetUrl: string;
};

export const resolveBundledPetAssetUrl = (
  assetPath: string,
  baseUrl = import.meta.env.BASE_URL,
): string => `${baseUrl}${assetPath.replace(/^\/+/, "")}`;

export const BUILT_IN_PET: BuiltInPet = {
  id: "stella",
  displayName: "Stella",
  spritesheetUrl: resolveBundledPetAssetUrl("pets/stella.webp"),
};
