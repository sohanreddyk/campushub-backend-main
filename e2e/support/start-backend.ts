/**
 * E2E backend launcher (Lab 9).
 *
 * Starts the compiled CampusHub API (dist/, so run `npm run build` first) on
 * an in-memory MongoDB seeded with known resources, so every Playwright run
 * starts from the same data and never touches a developer's real database.
 *
 * It also opens a tiny test-only control server on 127.0.0.1:3100:
 *   POST /reset  ->  204, wipes reservations and re-seeds the resources.
 * The specs call it before each test so tests do not affect one another.
 *
 * Run directly by Node 24 (built-in TypeScript type stripping):
 *   node e2e/support/start-backend.ts
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { createApp } from "../../dist/app.js";
import { connectDatabase } from "../../dist/config/database.js";

const API_PORT = 3000;
const CONTROL_PORT = 3100;

interface SeedResource {
  name: string;
  type: "ROOM" | "EQUIPMENT" | "LAB";
  location: string;
  isAvailable: boolean;
}

const SEED_RESOURCES: readonly SeedResource[] = [
  {
    name: "Study Room 302",
    type: "ROOM",
    location: "Library - Third Floor",
    isAvailable: true,
  },
  {
    name: "Study Room 101",
    type: "ROOM",
    location: "Library - First Floor",
    isAvailable: true,
  },
  {
    name: "Projector 201",
    type: "EQUIPMENT",
    location: "Media Services",
    isAvailable: true,
  },
  {
    name: "3D Printer A",
    type: "EQUIPMENT",
    location: "Makerspace",
    isAvailable: true,
  },
  {
    name: "Computer Lab A",
    type: "LAB",
    location: "Engineering Building",
    isAvailable: true,
  },
];

/** Remove all reservations and restore the seeded resources. */
async function resetDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (db === undefined) {
    throw new Error("The database connection is not open.");
  }
  await db.collection("reservations").deleteMany({});
  await db.collection("resources").deleteMany({});
  await db
    .collection("resources")
    .insertMany(SEED_RESOURCES.map((resource: SeedResource) => ({ ...resource })));
}

function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method === "POST" && req.url === "/reset") {
    resetDatabase().then(
      (): void => {
        res.writeHead(204);
        res.end();
      },
      (err: unknown): void => {
        console.error("E2E reset failed:", err);
        res.writeHead(500);
        res.end();
      },
    );
    return;
  }
  res.writeHead(404);
  res.end();
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  await connectDatabase(mongod.getUri("campushub"));
  await resetDatabase();

  const control: Server = createServer(handleControlRequest);
  control.listen(CONTROL_PORT, "127.0.0.1");

  const api: Server = createApp().listen(API_PORT, (): void => {
    console.log(`CampusHub E2E backend listening on port ${API_PORT}`);
  });

  async function shutdown(): Promise<void> {
    control.close();
    api.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  }
  process.on("SIGINT", (): void => {
    void shutdown();
  });
  process.on("SIGTERM", (): void => {
    void shutdown();
  });
}

main().catch((err: unknown): void => {
  console.error("Failed to start the E2E backend:", err);
  process.exit(1);
});
