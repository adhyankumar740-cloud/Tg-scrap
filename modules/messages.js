const { Api } = require("telegram");

/**
 * VK Music Bot se Audio / MP3 Messages extract karne ka function
 * @param {Object} client - GramJS Client instance
 * @param {string} botUsername - Target Bot Username (default: "vkmusic_bot")
 * @param {number} limit - Messages limit
 */
async function getVkMusicMessages(client, botUsername = "vkmusic_bot", limit = 100) {
    try {
        // Resolve entity for VK Music Bot
        const entity = await client.getEntity(botUsername);
        
        // Chat history se messages fetch karein
        const messages = await client.getMessages(entity, { limit: limit });

        // Sirf un messages ko filter karein jinme audio ya document media ho
        const audioMessages = messages.filter(msg => {
            if (!msg.media) return false;
            
            const isAudio = msg.media.audio;
            const isDocument = msg.media.document;
            
            // Check if document is an audio file
            const mimeType = isDocument?.mimeType || "";
            const isAudioMime = mimeType.startsWith("audio/") || mimeType.includes("mpeg");

            return isAudio || isAudioMime;
        });

        return { entity, audioMessages };
    } catch (error) {
        console.error("❌ Error fetching messages from VK Music Bot:", error.message);
        throw error;
    }
}

module.exports = {
    getVkMusicMessages
};
