declare module "node-app-attest" {
  export const verifyAttestation: (args: {
    attestation: Buffer;
    challenge: string;
    keyId: string;
    bundleIdentifier: string;
    teamIdentifier: string;
    allowDevelopmentEnvironment: boolean;
  }) => unknown;

  export const verifyAssertion: (args: {
    assertion: Buffer;
    payload: string;
    publicKey: string;
    bundleIdentifier: string;
    teamIdentifier: string;
    signCount: number;
  }) => unknown;
}
