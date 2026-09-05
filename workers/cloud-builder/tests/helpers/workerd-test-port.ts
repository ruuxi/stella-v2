import { createServer } from "node:net";

/**
 * Ask the kernel for an unused loopback port, then release it immediately for
 * Wrangler. Wrangler 4.127.1 accepts `--inspector-port 0`, but its local R2
 * transport loses the connection when that value is used directly.
 */
export const allocateLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to allocate a loopback inspector port");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
};

export const allocateWorkerdInspectorPort = allocateLoopbackPort;
