import { config, configStatus } from "./config.js";
import { getPool } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { setDialer, startWorker } from "./scheduler.js";
import { placeOutboundCall } from "./twilio.js";

async function main() {
  const status = configStatus();
  console.log("JANET configuration:", status);
  if (!status.database) throw new Error("DATABASE_URL is required");
  await migrate();
  setDialer(placeOutboundCall);
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  const stopWorker = config.workerEnabled ? startWorker() : () => {};
  const shutdown = async () => {
    stopWorker();
    await app.close();
    await getPool().end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
