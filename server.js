require("dotenv").config();
const express = require("express");
const { initAuth } = require("./modules/auth");
const DownloadChannel = require("./scripts/download-channel");
const { getAllDialogs } = require("./modules/dialoges");
const { searchMessages, downloadMessageMedia } = require("./modules/messages");
const { getMediaFileName, getMediaType } = require("./utils/helper");
const logger = require("./utils/logger");
const { EXPORT_DIR } = require("./utils/paths");
const path = require("path");
const fs = require("fs");

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

// Search your own channel/group for a file by name or caption text.
// GET /search?query=song%20name&channel=yourChannelUsernameOrId
// If "channel" is omitted, falls back to the first entry in the CHANNELS env var.
app.get("/search", requireSecret, async (req, res) => {
  try {
    const query = req.query.query;
    const channel =
      req.query.channel ||
      (process.env.CHANNELS ? process.env.CHANNELS.split(",")[0].trim() : null);

    if (!query) {
      return res.status(400).json({ error: "Pass ?query=filename or song name" });
    }
    if (!channel) {
      return res.status(400).json({ error: "Pass ?channel=... or set CHANNELS env var" });
    }

    const client = await getSharedClient();
    const messages = await searchMessages(client, channel, query, 20);

    const results = messages
      .filter((m) => m.media)
      .map((m) => ({
        messageId: m.id,
        fileName: getMediaFileName(m),
        mediaType: getMediaType(m),
        caption: m.message || "",
        date: m.date,
      }));

    res.json({ channel, query, count: results.length, results });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Download exactly one matched file by its message id (no zip, just the raw file).
// GET /file/:messageId?channel=yourChannelUsernameOrId
app.get("/file/:messageId", requireSecret, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId);
    const channel =
      req.query.channel ||
      (process.env.CHANNELS ? process.env.CHANNELS.split(",")[0].trim() : null);

    if (!channel) {
      return res.status(400).json({ error: "Pass ?channel=... or set CHANNELS env var" });
    }

    const client = await getSharedClient();
    const [message] = await client.getMessages(channel, { ids: [messageId] });

    if (!message || !message.media) {
      return res.status(404).json({ error: "No message/media found for that id" });
    }

    const fileName = getMediaFileName(message) || `${messageId}_file`;
    const tempDir = path.join(EXPORT_DIR, "_tmp_single");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, fileName);

    const ok = await downloadMessageMedia(client, message, tempPath);
    if (!ok || !fs.existsSync(tempPath)) {
      return res.status(500).json({ error: "Download failed" });
    }

    res.download(tempPath, fileName, (err) => {
      // Clean up the temp copy after it's been sent, so the free Render disk
      // doesn't fill up with one-off downloads.
      fs.unlink(tempPath, () => {});
      if (err) logger.error(`Error sending file: ${err.message}`);
    });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  logger.success(`Server listening on port ${PORT}`);
  logger.info(`Export directory: ${EXPORT_DIR}`);
});
