import Fastify from "fastify";
import { z } from "zod";

import { agentConfig } from "../shared/config.js";
import { log, logError } from "../shared/logging.js";
import { createSessionRequestSchema, sessionActivityStateSchema } from "../shared/types.js";
import { NodeAgent } from "./agent.js";
import { FirecrackerOrchestrator } from "./firecracker.js";

const fastify = Fastify({ logger: false });
const agent = new NodeAgent();
const agentCreateSessionSchema = createSessionRequestSchema.extend({
  sessionId: z.string().uuid(),
});
const agentSessionActivitySchema = z.object({
  activityState: sessionActivityStateSchema,
});

fastify.get("/health", async () => ({
  ok: true,
  hostId: agentConfig.hostId,
  mode: agentConfig.mode,
  ...agent.getHealthSnapshot(),
}));

fastify.post("/internal/sessions", async (request, reply) => {
  const parsed = agentCreateSessionSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  try {
    const result = await agent.launchSession(parsed.data);
    return reply.code(201).send(result);
  } catch (error) {
    logError("node-agent", "session-launch-failed", error, { sessionId: parsed.data.sessionId });
    return reply.code(503).send({ error: error instanceof Error ? error.message : "Launch failed." });
  }
});

fastify.delete("/internal/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  await agent.terminateSession(sessionId);
  return reply.code(204).send();
});

fastify.get("/internal/sessions/:sessionId/logs", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const logs = await agent.getSessionLogSnapshot(sessionId);
  if (!logs) {
    return reply.code(404).send({ error: "Session not found." });
  }
  return logs;
});

fastify.post("/internal/sessions/:sessionId/activity", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const parsed = agentSessionActivitySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const updated = await agent.markSessionActivity(sessionId, parsed.data.activityState);
  if (!updated) {
    return reply.code(404).send({ error: "Session not found." });
  }
  return reply.code(204).send();
});

async function main(): Promise<void> {
  try {
    if (agentConfig.mode === "firecracker") {
      FirecrackerOrchestrator.assertAssetsAvailable();
    }

    await agent.prepareRuntimeMode();

    await fastify.listen({
      port: agentConfig.port,
      host: "0.0.0.0",
    });

    await agent.register();
    await agent.sendHeartbeat();

    const heartbeatHandle = setInterval(() => {
      void agent.sendHeartbeat().catch((error) => {
        logError("node-agent", "heartbeat-failed", error);
      });
    }, agentConfig.heartbeatIntervalMs);
    heartbeatHandle.unref();

    const monitorHandle = setInterval(() => {
      void agent.monitorSessions().catch((error) => {
        logError("node-agent", "monitor-failed", error);
      });
    }, agentConfig.monitorIntervalMs);
    monitorHandle.unref();

    const warmPoolHandle = setInterval(() => {
      void agent.ensureWarmPool().catch((error) => {
        logError("node-agent", "warm-pool-fill-failed", error);
      });
    }, agentConfig.warmPoolMaintainIntervalMs);
    warmPoolHandle.unref();

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      clearInterval(heartbeatHandle);
      clearInterval(monitorHandle);
      clearInterval(warmPoolHandle);
      log("node-agent", "shutdown-started", { signal, hostId: agentConfig.hostId });
      try {
        await agent.shutdown();
      } finally {
        await fastify.close().catch(() => undefined);
      }
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT").finally(() => {
        process.exit(0);
      });
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM").finally(() => {
        process.exit(0);
      });
    });

    void agent.ensureWarmPool().catch((error) => {
      logError("node-agent", "warm-pool-fill-failed", error);
    });

    log("node-agent", "registered", {
      hostId: agentConfig.hostId,
      mode: agentConfig.mode,
    });
    log("node-agent", "listening", { port: agentConfig.port });
  } catch (error) {
    logError("node-agent", "startup-failed", error);
    process.exitCode = 1;
  }
}

void main();
