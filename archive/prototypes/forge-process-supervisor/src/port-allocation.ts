import { createServer } from "node:net";
import type { PortProvider } from "./types.ts";

export const LOOPBACK_HOST = "127.0.0.1";

export const findCandidatePort: PortProvider = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine candidate port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });

export function isPortCollisionDiagnostic(message: string): boolean {
  return /EADDRINUSE|address already in use|only one usage of each socket address/iu.test(message);
}
