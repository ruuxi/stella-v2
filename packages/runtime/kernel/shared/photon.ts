export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type PhotonModule = typeof import("@silvia-odwyer/photon-node");

let photonModule: PhotonModule | null = null;
let loadPromise: Promise<PhotonModule | null> | null = null;

export const loadPhoton = async (): Promise<PhotonModule | null> => {
  if (photonModule) {
    return photonModule;
  }
  loadPromise ??= (async () => {
    try {
      photonModule = await import("@silvia-odwyer/photon-node");
      return photonModule;
    } catch {
      photonModule = null;
      return photonModule;
    }
  })();
  return loadPromise;
};
