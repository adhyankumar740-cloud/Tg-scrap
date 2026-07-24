require("dotenv").config();
const express = require("express");
const { initAuth } = require("./modules/auth");
const DownloadChannel = require("./scripts/download-channel");
const { getAllDialogs } = require("./modules/dialoges");
const logger = require("./utils/logger");
const { EXPORT_DIR } = require("./utils/paths");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const APP_SECRET = process.env.APP_SECRET;

// All media types on by default, matching the original index.js.
const DOWNLOADABLE_FILES = {
  webpage: true,
  poll: true,
  geo: true,
  contact: true,
  venue: true,
  sticker: true,
  image: true,
  video: true,
  audio: true,
  pdf: true,
  document: true,
};

let sharedClient = null;
let currentJob = null;

async function getSharedClient() {
  if (!sharedClient) {
    sharedClient = await initAuth();
  }
  return sharedClient;
}

function requireSecret(req, res, next) {
  if (!APP_SECRET) {
    return res.status(500).json({ error: "APP_SECRET is not configured on the server" });
  }
  if (req.headers["x-api-key"] !== APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized. Pass the correct x-api-key header." });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Telegram channel downloader is running.", currentJob });
});

app.get("/status", (req, res) => {
  res.json({ currentJob });
});

// Optional: list all your channels/groups/users so you can find the right channelId/username.
// GET /dialogs  (requires x-api-key header)
app.get("/dialogs", requireSecret, async (req, res) => {
  try {
    const client = await getSharedClient();
    const dialogs = await getAllDialogs(client);
    res.json({ count: dialogs.length, dialogs });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start a download job for the channels configured in the CHANNELS env var,
// or pass a specific list in the request body: { "channels": ["chan1", "chan2"] }
// Each entry can be a @username, a public channel name, or a numeric chat id.
app.post("/download", requireSecret, async (req, res) => {
  if (currentJob && currentJob.status === "running") {
    return res.status(409).json({ error: "A download job is already running", currentJob });
  }

  const channels =
    (req.body && req.body.channels) ||
    (process.env.CHANNELS ? process.env.CHANNELS.split(",").map((c) => c.trim()).filter(Boolean) : []);

  if (!channels.length) {
    return res.status(400).json({ error: "No channels provided (set CHANNELS env var or pass channels in body)" });
  }

  currentJob = {
    status: "running",
    startedAt: new Date().toISOString(),
    channels,
    results: [],
  };

  res.json({ message: "Download job started", currentJob });

  runJob(channels).catch((err) => {
    logger.error(`Job failed: ${err.message}`);
    currentJob.status = "failed";
    currentJob.error = err.message;
  });
});

async function runJob(channels) {
  const client = await getSharedClient();

  for (const channelId of channels) {
    logger.info(`Starting channel: ${channelId}`);
    const downloader = new DownloadChannel();
    try {
      await downloader.handle({
        channelId,
        downloadableFiles: DOWNLOADABLE_FILES,
        client,
        exitProcess: false,
      });
      currentJob.results.push({ channel: channelId, status: "done" });
      logger.success(`Finished channel: ${channelId}`);
    } catch (err) {
      logger.error(`Failed channel ${channelId}: ${err.message}`);
      currentJob.results.push({ channel: channelId, status: "error", error: err.message });
    }
  }

  currentJob.status = "completed";
  currentJob.finishedAt = new Date().toISOString();
  logger.success("All channels processed.");
}

app.listen(PORT, () => {
  logger.success(`Server listening on port ${PORT}`);
  logger.info(`Export directory: ${EXPORT_DIR}`);
});
