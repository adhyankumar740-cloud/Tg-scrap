const { Api } = require("telegram");

// Main scraping function
async function fetchVKMusic(client, songName) {
    const botUsername = "@vkmusic_bot";
    
    try {
        console.log(`🎵 ${botUsername} par "${songName}" search kiya ja raha hai...`);
        
        // 1. Bot ko query send karna
        await client.sendMessage(botUsername, { message: songName });
        console.log(`📨 Bot ko query bhej di gayi hai: "${songName}"`);

        // 2. Button (Menu) ka wait karna (Max 15 seconds)
        let menuMessage = await waitForMessage(client, botUsername, 15000, (msg) => {
            return msg.replyMarkup && msg.replyMarkup.rows && msg.replyMarkup.rows.length > 0;
        });

        if (!menuMessage) {
            console.log(`⚠️ "${songName}" ke liye 15s tak wait kiya, koi button/menu nahi mila.`);
            return false;
        }

        console.log("✅ Search results aagaye hain. Pehle button par click kar rahe hain...");

        // 3. Pehle button par click karna (Row 0, Button 0)
        await menuMessage.click(0, 0);

        // 4. Ab Audio file aane ka wait karna (Max 30 seconds)
        console.log("⏳ Audio generate hone ka wait kar rahe hain...");
        let audioMessage = await waitForMessage(client, botUsername, 30000, (msg) => {
            return msg.media && (msg.media.document || msg.media.audio);
        });

        if (!audioMessage) {
            console.log("⚠️ Button click kiya, par 30s tak koi audio reply nahi mila.");
            return false;
        }

        // 5. Audio file download karna
        console.log("✅ Audio mil gaya! Downloading...");
        const buffer = await client.downloadMedia(audioMessage);
        
        // Yahan aap file ko FS (File System) use karke save kar sakte hain
        // const fs = require('fs');
        // fs.writeFileSync(`${songName}.mp3`, buffer);
        
        console.log(`✅ "${songName}" Successfully Downloaded!`);
        return true;

    } catch (error) {
        console.error("❌ Error aagaya VK Music extraction mein:", error);
        return false;
    }
}

// Helper Function: Custom Wait for specific message conditions
async function waitForMessage(client, chatId, timeoutMs, conditionCallback) {
    return new Promise((resolve) => {
        let isResolved = false;

        const timeout = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                client.removeEventHandler(messageHandler);
                resolve(null); // Timeout hone par null return karega
            }
        }, timeoutMs);

        const messageHandler = async (update) => {
            if (isResolved) return;
            
            // Check if it's a new message in our specific chat
            if (update.className === "UpdateNewMessage" && update.message) {
                const msg = update.message;
                const peerId = msg.peerId && (msg.peerId.userId || msg.peerId.channelId);
                
                // Note: Aapko yahan resolve karna hoga ki bot ka actual ID kya hai
                // For simplicity, just checking if condition matches
                if (conditionCallback(msg)) {
                    isResolved = true;
                    clearTimeout(timeout);
                    client.removeEventHandler(messageHandler);
                    resolve(msg);
                }
            }
        };

        client.addEventHandler(messageHandler, new Api.events.NewMessage({}));
    });
}

module.exports = { fetchVKMusic };
