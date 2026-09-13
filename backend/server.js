require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const db = require("./db");
const agentToolsRouter = require("./routes/agent-tools");
const pwaApiRouter = require("./routes/pwa-api");
const notificationScheduler = require("./services/notification-scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Simple request log — useful while wiring up the ElevenLabs agent, since
// you'll want to see exactly which tool calls it's making and when.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: "connected", time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, db: "unreachable", error: err.message });
  }
});

// Tool webhooks the ElevenLabs agent calls mid-conversation
app.use("/", agentToolsRouter);

// REST API consumed by the PWA
app.use("/api", pwaApiRouter);

// Serve the PWA itself
app.use(express.static(path.join(__dirname, "..", "pwa")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal_error", message: err.message });
});

async function main() {
  console.log("[startup] connecting to Neon and ensuring schema...");
  await db.init();
  console.log("[startup] database ready.");

  app.listen(PORT, () => {
    console.log(`\n  Barbershop AI backend running on port ${PORT}`);
    console.log(`  - Agent tool webhooks under /tools/*`);
    console.log(`  - PWA API under /api/*`);
    console.log(`  - PWA served at /\n`);
    notificationScheduler.start();
  });
}

main().catch((err) => {
  console.error("[startup] fatal error:", err);
  process.exit(1);
});
