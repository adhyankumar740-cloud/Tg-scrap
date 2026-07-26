"use strict";
const { initAuth } = require("../modules/auth");
const { getDialogName } = require("../modules/dialoges");
const { textInput, booleanInput } = require("../utils/input-helper");
const { wait } = require("../utils/helper");
const logger = require("../utils/logger");

// Telegram allows forwarding at most 100 messages per API call
const BATCH_SIZE = 100;
// Chhota sa pause har batch ke baad, taaki Telegram flood-limit na lagaye
const DELAY_BETWEEN_BATCHES_SEC = 2;

/**
 * Ek channel ka pura content (saare messages/media) doosre channel me
 * forward karke "dump" karta hai.
 */
class CloneChannel {
  static description() {
    return "Ek channel ka sab kuch scrap karke doosre channel me dump karo";
  }

  /**
   * Ek source -> destination pair ko process karta hai.
   */
  async cloneOne(client, sourceId, destId) {
    const sourceEntity = await client.getEntity(sourceId);
    const destEntity = await client.getEntity(destId);

    const sourceName = await getDialogName(client, sourceId);
    const destName = await getDialogName(client, destId);

    logger.info(`🚀 "${sourceName}" se "${destName}" me dump shuru ho raha hai...`);

    let batch = [];
    let total = 0;

    const flushBatch = async () => {
      if (!batch.length) return;
      await client.forwardMessages(destEntity, {
        messages: batch,
        fromPeer: sourceEntity,
      });
      total += batch.length;
      logger.info(`   ...${total} messages dump ho chuke hain`);
      batch = [];
      await wait(DELAY_BETWEEN_BATCHES_SEC);
    };

    // reverse: true => sabse purane message se shuru, taaki order sahi rahe
    for await (const msg of client.iterMessages(sourceEntity, { reverse: true })) {
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
