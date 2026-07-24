const path = require("path");
const fs = require("fs");
const { getVkMusicMessages } = require("../modules/messages");
const { ensureDirExists } = require("../utils/file-helper");

/**
 * VK Music Bot se Audio Tracks download karne ka main runner
 */
async function downloadVkMusic(client, options = {}) {
    const botUsername = options.botUsername || "vkmusic_bot";
    const limit = options.limit || 100;
    const outputDir = path.join(process.cwd(), "downloads", "VK_Music");

    ensureDirExists(outputDir);

    console.log(`\n🎵 VK Music Bot (@${botUsername}) se audio tracks fetch kiye ja rahe hain...`);

    try {
        const { audioMessages } = await getVkMusicMessages(client, botUsername, limit);

        if (!audioMessages || audioMessages.length === 0) {
            console.log("⚠️ VK Music Bot chat mein koi audio files nahi mili.");
            return;
        }

        console.log(`\n🔍 Total ${audioMessages.length} audio tracks mile. Download shuru ho raha hai...\n`);

        for (let i = 0; i < audioMessages.length; i++) {
            const msg = audioMessages[i];
            const media = msg.media;
            const document = media.document || media.audio;

            // Audio Metadata (Artist & Title) Extract karein
            let fileName = `Track_${msg.id}.mp3`;
            
            if (document && document.attributes) {
                const audioAttr = document.attributes.find(
                    (attr) => attr.className === "DocumentAttributeAudio" || attr.title || attr.performer
                );
                
                if (audioAttr) {
                    const artist = audioAttr.performer 
                        ? audioAttr.performer.replace(/[\\/:*?"<>|]/g, "").trim() 
                        : "Unknown Artist";
                    const title = audioAttr.title 
                        ? audioAttr.title.replace(/[\\/:*?"<>|]/g, "").trim() 
                        : `Track_${msg.id}`;
                        
                    fileName = `${artist} - ${title}.mp3`;
                }
            }

            const filePath = path.join(outputDir, fileName);

            // Agar song pehle se downloaded hai to skip karein
            if (fs.existsSync(filePath)) {
                console.log(`[${i + 1}/${audioMessages.length}] ⏩ Skip (Already Exists): ${fileName}`);
                continue;
            }

            console.log(`[${i + 1}/${audioMessages.length}] 📥 Downloading: ${fileName}...`);
            
            await client.downloadMedia(msg, {
                outputFile: filePath,
                progressCallback: (downloaded, total) => {
                    const percent = ((downloaded / total) * 100).toFixed(1);
                    process.stdout.write(`   Progress: ${percent}%\r`);
                }
            });

            console.log(`\n✅ Downloaded: ${fileName}`);
        }

        console.log(`\n🎉 Process Complete! Sabhi songs yahan save ho gaye hain:\n📁 ${outputDir}\n`);

    } catch (err) {
        console.error("❌ Downloading mein error aaya:", err.message);
    }
}

module.exports = { downloadVkMusic };
