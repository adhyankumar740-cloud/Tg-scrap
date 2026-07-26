const readline = require("readline");
const { downloadVkMusic } = require("./scripts/download-vkmusic");
const CloneChannel = require("./scripts/clone-channel");
// Apne existing authentication module ko require karein
const { getClient } = require("./modules/auth");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
    console.log("==========================================");
    console.log("  🎵 TELEGRAM VK MUSIC BOT SCRAPER / EXTRACTOR ");
    console.log("==========================================\n");
    console.log("1. Extract Songs from VK Music Bot (@vkmusic_bot)");
    console.log("2. Ek channel scrap karke doosre channel me dump karo");
    console.log("3. Exit\n");

    const choice = await askQuestion("Option select karein (1-3): ");

    if (choice.trim() === "1") {
        const botUsername = await askQuestion("Bot Username enter karein (default: vkmusic_bot): ");
        const limitInput = await askQuestion("Kitne last messages check karne hain? (default: 100): ");

        const targetBot = botUsername.trim() || "vkmusic_bot";
        const limit = parseInt(limitInput.trim(), 10) || 100;

        console.log("\n🔄 Telegram client connect ho raha hai...");
        const client = await getClient();

        await downloadVkMusic(client, {
            botUsername: targetBot,
            limit: limit
        });

    } else if (choice.trim() === "2") {
        console.log("\n🔄 Telegram client connect ho raha hai...");
        const client = await getClient();

        rl.close(); // clone-channel apna khud ka inquirer prompt use karta hai

        const cloneChannel = new CloneChannel();
        await cloneChannel.handle({ client, exitProcess: true });
        return; // handle() khud process.exit karega

    } else {
        console.log("Exiting...");
    }

    rl.close();
    process.exit(0);
}

main().catch(console.error);
