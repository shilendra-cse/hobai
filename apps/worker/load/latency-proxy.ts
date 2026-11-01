import net from "node:net";

export type LatencyProxy = { port: number; close(): Promise<void> };

/**
 * A TCP proxy that delays every chunk by the same time in each direction, so a local Postgres
 * answers about as slowly as one across the network. Equal delays keep the chunks in order.
 */
export async function startLatencyProxy(options: {
  target: { host: string; port: number };
  delayMs: number;
}): Promise<LatencyProxy> {
  const sockets = new Set<net.Socket>();
  const delayed = (to: net.Socket) => (chunk: Buffer) => {
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, options.delayMs);
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(options.target);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("data", delayed(upstream));
    upstream.on("data", delayed(client));
    const end = () => {
      setTimeout(() => {
        client.destroy();
        upstream.destroy();
      }, options.delayMs);
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The latency proxy isn't listening on a port.");
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
