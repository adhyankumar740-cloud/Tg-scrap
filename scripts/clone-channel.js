"use strict";
const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const { getDialogName } = require("../modules/dialoges");
const { textInput, booleanInput } = require("../utils/input-helper");
const { wait, logMessage } = require("../utils/helper");
const { EXPORT_DIR } = require("../utils/paths");
const logger = require("../utils/logger");

// Telegram allows forwarding at most 100 messages per API call
const BATCH_SIZE = 100;
// Chhota sa pause har batch ke baad, taaki Telegram flood-limit na lagaye
const DELAY_BETWEEN_BATCHES_SEC = 5;
// Agar Telegram itni si der ke liye rukne bole (seconds), to khud wait karke retry kar lo.
// Isse zyada ho to fail ho jayega (progress saved rahegi) taaki server hang na ho.
const AUTO_RETRY_MAX_WAIT_SEC = 60;

const PROGRESS_FILE = path.join(EXPORT_DIR, "clone_progress.json");

/**
 * Ek channel ka pura content (saare messages/media) doosre channel me
 * forward karke "dump" karta hai. Resume-safe: beech me fail ho jaye
 * (jaise Telegram flood-wait) to agli baar wahi se aage badhta hai.
 */
class CloneChannel {
  static description() {
    return "Ek channel ka sab kuch scrap karke doosre channel me dump karo (resume-safe)";
  }

  progressKey(sourceId, destId) {
    return `${sourceId}__${destId}`;
  }

  readProgressStore() {
    try {
      if (!fs.existsSync(PROGRESS_FILE)) return {};
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch (err) {
      logMessage.error(`Progress file padhne me error, fresh se shuru: ${err.message}`);
      return {};
    }
  }

  writeProgressStore(store) {
    try {
      if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(store, null, 2), "utf8");
    } catch (err) {
      logMessage.error(`Progress file save karne me error: ${err.message}`);
    }
  }

  getSavedProgress(sourceId, destId) {
    const store = this.readProgressStore();
    return store[this.progressKey(sourceId, destId)] || { lastMsgId: 0, totalForwarded: 0 };
  }

  saveProgress(sourceId, destId, progress) {
    const store = this.readProgressStore();
    store[this.progressKey(sourceId, destId)] = progress;
    this.writeProgressStore(store);
  }

  /**
   * Ek source -> destination pair ko process karta hai. Resume-safe.
   */
  async cloneOne(client, sourceId, destId) {
    const sourceEntity = await client.getEntity(sourceId);
    const destEntity = await client.getEntity(destId);

    const sourceName = await getDialogName(client, sourceId);
    const destName = await getDialogName(client, destId);

    const saved = this.getSavedProgress(sourceId, destId);
    let total = saved.totalForwarded || 0;
    let lastMsgId = saved.lastMsgId || 0;

    if (lastMsgId > 0) {
      logger.info(`↻ Resume ho raha hai "${sourceName}" -> "${destName}" (pehle se ${total} messages dump ho chuke hain, message id ${lastMsgId} ke baad se aage)`);
    } else {
      logger.info(`🚀 "${sourceName}" se "${destName}" me dump shuru ho raha hai...`);
    }

    let batch = [];

    const flushBatch = async () => {
      if (!batch.length) return;

      const attemptForward = async () => {
        try {
          await client.forwardMessages(destEntity, {
            messages: batch,
            fromPeer: sourceEntity,
          });
        } catch (err) {
          const waitSeconds = err.seconds || (err.message && /A wait of (\d+) seconds/.exec(err.message)?.[1]);
          if (waitSeconds && Number(waitSeconds) <= AUTO_RETRY_MAX_WAIT_SEC) {
            logger.info(`⏳ Telegram ne ${waitSeconds}s rukne ko bola, wait karke retry kar rahe hain...`);
            await wait(Number(waitSeconds) + 1);
            return attemptForward();
          }
          if (waitSeconds) {
            // Progress already saved (pichla successful batch) - resume-friendly error
            const mins = Math.ceil(Number(waitSeconds) / 60);
            const resumeErr = new Error(
              `Telegram flood limit lag gaya: ${waitSeconds}s (~${mins} min) wait karna hoga. ` +
              `Ab tak ${total} messages "${sourceName}" se "${destName}" me dump ho chuke hain - progress safe hai. ` +
              `Wait khatam hone ke baad wahi source/dest ke saath dobara /clone-channel call karo, khud-ba-khud wahi se resume ho jayega.`
            );
            resumeErr.floodWaitSeconds = Number(waitSeconds);
            throw resumeErr;
          }
          throw err;
        }
      };

      await attemptForward();

      total += batch.length;
      lastMsgId = batch[batch.length - 1];
      this.saveProgress(sourceId, destId, { lastMsgId, totalForwarded: total });

      logger.info(`   ...${total} messages dump ho chuke hain`);
      batch = [];
      await wait(DELAY_BETWEEN_BATCHES_SEC);
    };

    // reverse: true => sabse purane message se shuru, taaki order sahi rahe
    // minId => sirf lastMsgId se aage ke messages (resume ke liye)
    const iterOptions = { reverse: true };
    if (lastMsgId > 0) iterOptions.minId = lastMsgId;

    for await (const msg of client.iterMessages(sourceEntity, iterOptions)) {
      // service messages (jaise "user joined") skip kar do, sirf real content forward karo
      if (msg.action) continue;
      batch.push(msg.id);
      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }
    await flushBatch();

    logger.success(
      `✅ Ho gaya! "${sourceName}" ka pura content (${total} messages) "${destName}" me dump ho gaya hai.`
    );

    return { sourceName, destName, total };
  }

  /**
   * options.pairs: [{ sourceId, destId }, ...]  -> non-interactive / server use ke liye
   * Agar options.pairs nahi diya, toh terminal me interactively poochega,
   * aur har channel ke baad "ek aur karna hai?" bhi poochega.
   */
  async handle(options = {}) {
    let client = options.client;
    const ownsClient = !client;
    const exitProcess = options.exitProcess !== false;

    try {
      if (!client) client = await initAuth();

      let pairs = options.pairs;
      const results = [];

      if (pairs && pairs.length) {
        // Programmatic / server mode: sab pairs ek ke baad ek process karo
        for (const { sourceId, destId } of pairs) {
          const result = await this.cloneOne(client, sourceId, destId);
          results.push(result);
        }
        return results;
      }

      // Interactive CLI mode
      let keepGoing = true;
      while (keepGoing) {
        const sourceId = await textInput("Source channel ID/username daalein (jispe se scrap karna hai): ");
        const destId = await textInput("Destination channel ID/username daalein (jaha dump karna hai): ");

        const result = await this.cloneOne(client, sourceId, destId);
        results.push(result);

        keepGoing = await booleanInput("Ek aur channel dump karna hai kya?");
      }

      logger.success(`🎉 Sab ho gaya! Total ${results.length} channel(s) dump kiye:`);
      results.forEach((r) => logger.info(`   - ${r.sourceName} -> ${r.destName} (${r.total} messages)`));

      return results;
    } catch (err) {
      logger.error("Kuch error aa gaya:");
      console.error(err);
      throw err;
    } finally {
      if (ownsClient && exitProcess) {
        if (client) await client.disconnect();
        process.exit(0);
      }
    }
  }
}

module.exports = CloneChannel;
