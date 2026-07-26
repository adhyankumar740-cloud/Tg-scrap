const express = require('express');
const path = require('path');
const fs = require('fs');
const { getClient } = require('./modules/auth');
const { downloadVkMusic } = require('./scripts/download-vkmusic');
const CloneChannel = require('./scripts/clone-channel');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve downloaded mp3 files: GET /downloads/<filename>.mp3
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Global Scraper State
let isScrapingRunning = false;
let lastScrapingStatus = {
    status: 'idle',
    message: 'No extraction task has run yet.',
    timestamp: null
};

// Global Clone (channel -> channel dump) State — separate lock from the VK job above
let isCloneRunning = false;
let lastCloneStatus = {
    status: 'idle',
    message: 'No clone/dump task has run yet.',
    timestamp: null
};

/**
 * 1. Health Check & Ping Endpoint (UptimeRobot / Cron Jobs ke liye)
 */
app.get('/', (req, res) => {
    res.json({
        service: 'Telegram VK Music Extractor',
        status: 'online',
        isScrapingRunning: isScrapingRunning,
        lastStatus: lastScrapingStatus
    });
});

/**
 * 2. Status Endpoint - Current Job ka Status dekhne ke liye
 */
app.get('/status', (req, res) => {
    res.json({
        isRunning: isScrapingRunning,
        details: lastScrapingStatus
    });
});

/**
 * 3. Extract VK Music Trigger Endpoint
 * Query Params:
 *  - limit: Number of messages to fetch (Default: 20)
 *  - bot: Target Bot username without @ (Default: vkmusic_bot)
 * Example: /extract-vk?limit=50&bot=vkmusic_bot
 */
app.get('/extract-vk', async (req, res) => {
    // Prevent overlapping extraction jobs
    if (isScrapingRunning) {
        return res.status(409).json({
            status: 'busy',
            message: 'An extraction job is already in progress. Please wait for it to finish.',
            lastStatus: lastScrapingStatus
        });
    }

    const limit = parseInt(req.query.limit, 10) || 20;
    const botUsername = req.query.bot ? req.query.bot.trim() : 'vkmusic_bot';
    const song = req.query.song ? req.query.song.trim() : '';

    // Lock job status
    isScrapingRunning = true;
    lastScrapingStatus = {
        status: 'running',
        targetBot: botUsername,
        limit: limit,
        query: song || undefined,
        startedAt: new Date().toISOString()
    };

    // Immediate response to browser/HTTP client
    res.json({
        status: 'initiated',
        message: song
            ? `VK Music search started for "${song}" on @${botUsername}. Check Render Dashboard Logs for live progress!`
            : `VK Music extraction started for @${botUsername} (Last ${limit} messages). Check Render Dashboard Logs for live progress!`,
        timestamp: new Date().toISOString()
    });

    // Background Async Runner
    (async () => {
        try {
            console.log(`\n========================================`);
            console.log(`🚀 Starting VK Music Job for @${botUsername}`);
            console.log(`========================================\n`);

            const client = await getClient();

            const result = await downloadVkMusic(client, {
                botUsername: botUsername,
                limit: limit,
                query: song
            });

            lastScrapingStatus = {
                status: result && result.success ? 'completed' : 'failed',
                targetBot: botUsername,
                limit: limit,
                query: song || undefined,
                fileName: result ? result.fileName : undefined,
                downloadUrl: result && result.fileName ? `/downloads/${result.fileName}` : undefined,
                error: result && !result.success ? result.error : undefined,
                completedAt: new Date().toISOString()
            };
            console.log(`\n✅ VK Music Extraction Job Completed Successfully.\n`);
        } catch (error) {
            console.error(`\n❌ VK Music Extraction Job Failed:`, error.message);
            lastScrapingStatus = {
                status: 'failed',
                targetBot: botUsername,
                error: error.message,
                failedAt: new Date().toISOString()
            };
        } finally {
            isScrapingRunning = false;
        }
    })();
});

/**
 * 4. Clone/Dump Trigger Endpoint
 * Ek ya zyada channel(s) ka pura content doosre channel(s) me forward-dump karta hai.
 *
 * Optional auth: agar APP_SECRET env var set hai, to header "x-api-key" match hona chahiye.
 *
 * Body (JSON):
 *  - single pair:  { "source": "channel1", "dest": "channel2" }
 *  - multiple:      { "pairs": [ { "source": "channel1", "dest": "channel2" },
 *                                { "source": "channel3", "dest": "channel4" } ] }
 *
 * Example:
 * curl -X POST https://your-service.onrender.com/clone-channel \
 *   -H "Content-Type: application/json" \
 *   -H "x-api-key: your-app-secret" \
 *   -d '{"source":"@old_channel","dest":"@new_channel"}'
 */
app.post('/clone-channel', async (req, res) => {
    const appSecret = process.env.APP_SECRET;
    if (appSecret && req.headers['x-api-key'] !== appSecret) {
        return res.status(401).json({ status: 'unauthorized', message: 'Invalid or missing x-api-key header.' });
    }

    if (isCloneRunning) {
        return res.status(409).json({
            status: 'busy',
            message: 'A clone/dump job is already in progress. Please wait for it to finish.',
            lastStatus: lastCloneStatus
        });
    }

    let pairs = req.body?.pairs;
    if (!pairs || !pairs.length) {
        const source = req.body?.source || req.query.source;
        const dest = req.body?.dest || req.query.dest;
        if (!source || !dest) {
            return res.status(400).json({
                status: 'error',
                message: 'Provide either { "source", "dest" } or { "pairs": [{ "source", "dest" }, ...] } in the request body.'
            });
        }
        pairs = [{ source, dest }];
    }
    // CloneChannel expects { sourceId, destId }
    const normalizedPairs = pairs.map((p) => ({ sourceId: p.source, destId: p.dest }));

    isCloneRunning = true;
    lastCloneStatus = {
        status: 'running',
        pairs: pairs,
        startedAt: new Date().toISOString()
    };

    // Turant response bhej do, kaam background me chalega
    res.json({
        status: 'initiated',
        message: `Cloning started for ${normalizedPairs.length} channel(s). Poll GET /clone-status for progress; each channel's completion is logged there and in the Render logs.`,
        pairs: pairs,
        timestamp: new Date().toISOString()
    });

    // Background Async Runner
    (async () => {
        try {
            console.log(`\n========================================`);
            console.log(`🚀 Starting Clone Job: ${normalizedPairs.length} channel(s)`);
            console.log(`========================================\n`);

            const client = await getClient();
            const cloneChannel = new CloneChannel();

            const results = await cloneChannel.handle({
                client,
                exitProcess: false, // web service process ko zinda rakho
                pairs: normalizedPairs
            });

            lastCloneStatus = {
                status: 'completed',
                message: `Sab ho gaya! ${results.length} channel(s) dump ho chuke hain.`,
                results: results, // [{ sourceName, destName, total }, ...]
                completedAt: new Date().toISOString()
            };
            console.log(`\n✅ Clone Job Completed Successfully.\n`);
        } catch (error) {
            console.error(`\n❌ Clone Job Failed:`, error.message);
            lastCloneStatus = {
                status: 'failed',
                error: error.message,
                retryAfterSeconds: error.floodWaitSeconds || undefined,
                failedAt: new Date().toISOString()
            };
        } finally {
            isCloneRunning = false;
        }
    })();
});

/**
 * 5. Clone Status Endpoint - clone/dump job ka current status
 */
app.get('/clone-status', (req, res) => {
    res.json({
        isRunning: isCloneRunning,
        details: lastCloneStatus
    });
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 Telegram Scraper Server running on port ${PORT}`);
    console.log(`🌐 Base URL: http://localhost:${PORT}/`);
    console.log(`🎵 Trigger URL: http://localhost:${PORT}/extract-vk?limit=20`);
    console.log(`=================================================`);
});

// Global Handlers (Render crashes se bachne ke liye)
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error);
});
