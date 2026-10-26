import { createConnection } from "node:net";
import { WebSocketServer } from "ws";

export async function createPostgresProxy(databaseUrl: string) {
  const database = new URL(databaseUrl);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (websocket) => {
    const socket = createConnection({ host: database.hostname, port: Number(database.port || 5432) });
    websocket.on("message", (data) => {
      socket.write(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data);
    });
    socket.on("data", (data) => { websocket.send(data); });
    socket.on("error", () => { websocket.close(); });
    socket.on("close", () => { websocket.close(); });
    websocket.on("close", () => { socket.destroy(); });
    websocket.on("error", () => { socket.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  return {
    address: `127.0.0.1:${address.port}`,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    },
  };
}
