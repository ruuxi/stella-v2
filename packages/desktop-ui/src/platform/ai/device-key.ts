import {
  GATEWAY_DPOP_ALG_HEADER,
  GATEWAY_DPOP_HEADER,
  GATEWAY_DPOP_KEY_HEADER,
  GATEWAY_DPOP_TS_HEADER,
  base64UrlEncode,
  deviceKeyProofForExchange,
  deviceExchangeSigningInput,
  dpopHeaders,
  dpopSigningInput,
  exportRawPublicKey,
  expectedRawPublicKeyLength,
  generateDpopKeyPair,
  isDpopAlgorithm,
  signDpopInput,
  type DpopAlgorithm,
  type GatewayDeviceKeyProof,
} from "@stella/contracts/gateway/dpop";

export type DeviceSigner = {
  alg: DpopAlgorithm;
  rawPublicKey: Uint8Array;
  privateKey?: CryptoKey;
  sign(input: string): Promise<string>;
};

export const deviceKeyProofForSigner = async (args: {
  signer: DeviceSigner;
  ownerId: string;
  gatewayOrigin: string;
  now: number;
}): Promise<GatewayDeviceKeyProof> =>
  args.signer.privateKey
    ? await deviceKeyProofForExchange({
        alg: args.signer.alg,
        privateKey: args.signer.privateKey,
        rawPublicKey: args.signer.rawPublicKey,
        ownerId: args.ownerId,
        gatewayOrigin: args.gatewayOrigin,
        now: args.now,
      })
    : {
        alg: args.signer.alg,
        publicKey: base64UrlEncode(args.signer.rawPublicKey),
        signature: await args.signer.sign(
          deviceExchangeSigningInput({
            ownerId: args.ownerId,
            gatewayOrigin: args.gatewayOrigin,
            timestamp: args.now,
          }),
        ),
        timestamp: args.now,
      };

export const dpopHeadersForSigner = async (args: {
  signer: DeviceSigner;
  method: string;
  pathname: string;
  jti: string;
  requestId: string;
  now: number;
}): Promise<Record<string, string>> =>
  args.signer.privateKey
    ? await dpopHeaders({
        alg: args.signer.alg,
        privateKey: args.signer.privateKey,
        rawPublicKey: args.signer.rawPublicKey,
        method: args.method,
        pathname: args.pathname,
        jti: args.jti,
        requestId: args.requestId,
        now: args.now,
      })
    : {
        [GATEWAY_DPOP_HEADER]: await args.signer.sign(
          dpopSigningInput({
            method: args.method,
            pathname: args.pathname,
            jti: args.jti,
            requestId: args.requestId,
            timestamp: args.now,
          }),
        ),
        [GATEWAY_DPOP_KEY_HEADER]: base64UrlEncode(args.signer.rawPublicKey),
        [GATEWAY_DPOP_TS_HEADER]: String(args.now),
        [GATEWAY_DPOP_ALG_HEADER]: args.signer.alg,
      };

export type StoredDeviceKey = {
  alg: DpopAlgorithm;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

export type DeviceKeyStore = {
  load(): Promise<unknown>;
  save(key: StoredDeviceKey): Promise<void>;
};

const isCryptoKey = (value: unknown): value is CryptoKey => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CryptoKey>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.extractable === "boolean" &&
    Boolean(candidate.algorithm) &&
    Array.isArray(candidate.usages)
  );
};

const parseStoredDeviceKey = (value: unknown): StoredDeviceKey | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredDeviceKey>;
  if (
    !isDpopAlgorithm(candidate.alg) ||
    !isCryptoKey(candidate.publicKey) ||
    !isCryptoKey(candidate.privateKey) ||
    candidate.publicKey.type !== "public" ||
    candidate.privateKey.type !== "private" ||
    candidate.privateKey.extractable
  ) {
    return null;
  }
  return {
    alg: candidate.alg,
    publicKey: candidate.publicKey,
    privateKey: candidate.privateKey,
  };
};

export const createDeviceKeyManager = (store: DeviceKeyStore) => {
  let signerPromise: Promise<DeviceSigner> | null = null;

  const loadSigner = async (): Promise<DeviceSigner> => {
    let key = parseStoredDeviceKey(await store.load());
    if (!key) {
      const generated = await generateDpopKeyPair();
      key = {
        alg: generated.alg,
        publicKey: generated.keyPair.publicKey,
        privateKey: generated.keyPair.privateKey,
      };
      await store.save(key);
    }
    const rawPublicKey = await exportRawPublicKey(key.publicKey);
    if (rawPublicKey.byteLength !== expectedRawPublicKeyLength(key.alg)) {
      throw new Error("Stored Stella device public key is malformed.");
    }
    return {
      alg: key.alg,
      rawPublicKey,
      privateKey: key.privateKey,
      sign: async (input) =>
        await signDpopInput(key.alg, key.privateKey, input),
    };
  };

  return {
    getSigner(): Promise<DeviceSigner> {
      if (signerPromise) return signerPromise;
      const pending = loadSigner();
      signerPromise = pending;
      void pending.catch(() => {
        if (signerPromise === pending) signerPromise = null;
      });
      return pending;
    },
  };
};

const DEVICE_KEY_DATABASE = "stella-device-key";
const DEVICE_KEY_STORE = "stella-device-key";
const DEVICE_KEY_RECORD = "device";

const openDeviceKeyDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(DEVICE_KEY_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        database.createObjectStore(DEVICE_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the device key store."));
    request.onblocked = () =>
      reject(new Error("The device key store is blocked by another Stella tab."));
  });

export const createIndexedDbDeviceKeyStore = (
  factory: IDBFactory,
): DeviceKeyStore => ({
  async load(): Promise<unknown> {
    const database = await openDeviceKeyDatabase(factory);
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(DEVICE_KEY_STORE, "readonly");
        const request = transaction.objectStore(DEVICE_KEY_STORE).get(DEVICE_KEY_RECORD);
        request.onsuccess = () => resolve(request.result as unknown);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read the device key."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Could not read the device key."));
      });
    } finally {
      database.close();
    }
  },

  async save(key): Promise<void> {
    const database = await openDeviceKeyDatabase(factory);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(DEVICE_KEY_STORE, "readwrite");
        transaction.objectStore(DEVICE_KEY_STORE).put(key, DEVICE_KEY_RECORD);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not save the device key."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Could not save the device key."));
      });
    } finally {
      database.close();
    }
  },
});

type ElectronDeviceSignature = {
  alg: DpopAlgorithm;
  rawPublicKey: Uint8Array;
  signature: string;
};

const parseElectronDeviceSignature = (
  value: unknown,
): ElectronDeviceSignature | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    alg?: unknown;
    rawPublicKey?: unknown;
    signature?: unknown;
  };
  if (
    !isDpopAlgorithm(candidate.alg) ||
    !Array.isArray(candidate.rawPublicKey) ||
    !candidate.rawPublicKey.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    ) ||
    typeof candidate.signature !== "string" ||
    !candidate.signature
  ) {
    return null;
  }
  const rawPublicKey = Uint8Array.from(candidate.rawPublicKey);
  if (rawPublicKey.byteLength !== expectedRawPublicKeyLength(candidate.alg)) {
    return null;
  }
  return { alg: candidate.alg, rawPublicKey, signature: candidate.signature };
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

let electronSignerPromise: Promise<DeviceSigner> | null = null;
let browserKeyManager: ReturnType<typeof createDeviceKeyManager> | null = null;

const getElectronDeviceSigner = (): Promise<DeviceSigner> | null => {
  if (typeof window === "undefined") return null;
  const electronApi = window.electronAPI;
  if (!electronApi) return null;
  const signDevice = electronApi.system.signDevice;
  if (typeof signDevice !== "function") {
    return Promise.reject(
      new Error("Electron device signing is not available."),
    );
  }
  if (electronSignerPromise) return electronSignerPromise;
  const pending = (async (): Promise<DeviceSigner> => {
    const initial = parseElectronDeviceSignature(
      await signDevice("stella-device-key-probe"),
    );
    if (!initial) throw new Error("Electron returned an invalid Stella device key.");
    return {
      alg: initial.alg,
      rawPublicKey: initial.rawPublicKey,
      sign: async (input) => {
        const signed = parseElectronDeviceSignature(await signDevice(input));
        if (
          !signed ||
          signed.alg !== initial.alg ||
          !sameBytes(signed.rawPublicKey, initial.rawPublicKey)
        ) {
          throw new Error("The Stella device key changed while signing.");
        }
        return signed.signature;
      },
    };
  })();
  electronSignerPromise = pending;
  void pending.catch(() => {
    if (electronSignerPromise === pending) electronSignerPromise = null;
  });
  return pending;
};

export const getRendererDeviceSigner = async (): Promise<DeviceSigner> => {
  const electronSigner = getElectronDeviceSigner();
  if (electronSigner) return await electronSigner;
  if (!browserKeyManager) {
    if (typeof indexedDB === "undefined") {
      throw new Error("This browser cannot store the Stella device key.");
    }
    browserKeyManager = createDeviceKeyManager(
      createIndexedDbDeviceKeyStore(indexedDB),
    );
  }
  return await browserKeyManager.getSigner();
};

export const resetDeviceKeyStateForTests = (): void => {
  electronSignerPromise = null;
  browserKeyManager = null;
};
