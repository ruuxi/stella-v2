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
