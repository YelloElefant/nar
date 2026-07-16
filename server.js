const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
const clients = new Set();

const PORT = Number(process.env.PORT || 3010);
const STREAM_URL = process.env.MTX_STREAM_URL || "rtsp://127.0.0.1:8554/scanner";
const PATH_NAME = process.env.MTX_PATH || decodeURIComponent(new URL(STREAM_URL).pathname.replace(/^\//, "") || "scanner");
const PLAYBACK_BASE = process.env.MTX_PLAYBACK_URL || "http://127.0.0.1:9996";
const SAMPLE_RATE = Number(process.env.LEVEL_SAMPLE_RATE || 8000);
const HZ = Number(process.env.LEVEL_HZ || 10);
const HISTORY_SECONDS = Number(process.env.LEVEL_HISTORY_SECONDS || 300);
const LEVEL_DIR = process.env.LEVEL_DIR || path.join(__dirname, "live-levels");
const RECONNECT_MS = Number(process.env.LEVEL_RECONNECT_MS || 2000);
const MAX_RECENT = Math.max(HZ * HISTORY_SECONDS, HZ * 30);

let recentLevels = [];
let spanCache = { at: 0, v: [] };
let status = {
    running: false,
    streamUrl: STREAM_URL,
    restartedAt: null,
    lastLevelAt: null,
    lastError: null,
};
let currentWriterHour = null;
let currentWriter = null;

function ensureRecentCapacity() {
    if (recentLevels.length > MAX_RECENT) {
        recentLevels = recentLevels.slice(-MAX_RECENT);
    }
}

function hourKey(ts) {
    return new Date(ts).toISOString().slice(0, 13);
}

function getPlaybackUrl(startMs, durationSec, format = "mp4") {
    const start = new Date(startMs).toISOString();
    return (
        `${PLAYBACK_BASE}/get?path=${encodeURIComponent(PATH_NAME)}` +
        `&start=${encodeURIComponent(start)}` +
        `&duration=${durationSec}&format=${format}`
    );
}

async function spans() {
    if (Date.now() - spanCache.at < 20_000) return spanCache.v;
    const response = await fetch(`${PLAYBACK_BASE}/list?path=${encodeURIComponent(PATH_NAME)}`);
    if (!response.ok) {
        throw new Error(`playback list failed: ${response.status}`);
    }
    const raw = await response.json();
    const v = raw
        .map((s) => {
            const st = +new Date(s.start);
            return { st, en: Math.min(st + s.duration * 1000, Date.now()) };
        })
        .sort((a, b) => a.st - b.st)
        .reduce((acc, s) => {
            const last = acc.at(-1);
            if (last && s.st <= last.en) last.en = Math.max(last.en, s.en);
            else acc.push(s);
            return acc;
        }, []);
    spanCache = { at: Date.now(), v };
    return v;
}

async function getWriter(ts) {
    const hour = hourKey(ts);
    if (currentWriter && currentWriterHour === hour) return currentWriter;
    if (currentWriter) {
        await new Promise((resolve) => currentWriter.end(resolve));
    }
    await fsp.mkdir(LEVEL_DIR, { recursive: true });
    currentWriterHour = hour;
    currentWriter = fs.createWriteStream(path.join(LEVEL_DIR, `${hour}.ndjson`), { flags: "a" });
    return currentWriter;
}

async function persistLevel(level) {
    const writer = await getWriter(level.ts);
    await new Promise((resolve, reject) => {
        writer.write(`${JSON.stringify(level)}\n`, (err) => (err ? reject(err) : resolve()));
    });
}

function broadcast(level) {
    const msg = `data: ${JSON.stringify(level)}\n\n`;
    for (const res of clients) {
        res.write(msg);
    }
}

function handleLevel(level) {
    recentLevels.push(level);
    ensureRecentCapacity();
    status.lastLevelAt = level.ts;
    status.lastError = null;
    broadcast(level);
    persistLevel(level).catch((err) => {
        status.lastError = err.message;
        console.error("persist level:", err.message);
    });
}

function parseBuckets(buffer, samplesPerBucket) {
    const levels = [];
    const bytesPerBucket = samplesPerBucket * 2;
    let offset = 0;

    while (buffer.length - offset >= bytesPerBucket) {
        let sum = 0;
        let peak = 0;

        for (let i = 0; i < bytesPerBucket; i += 2) {
            const sample = buffer.readInt16LE(offset + i);
            const abs = Math.abs(sample);
            sum += sample * sample;
            if (abs > peak) peak = abs;
        }

        const rms = Math.sqrt(sum / samplesPerBucket);
        const db = 20 * Math.log10(Math.max(rms, 1) / 32768);
        const norm = Math.max(0, Math.min(1, (db + 60) / 60));

        levels.push({
            ts: Date.now(),
            rms: Math.round(rms * 100) / 100,
            peak,
            db: Math.round(db * 100) / 100,
            norm: Math.round(norm * 1000) / 1000,
        });

        offset += bytesPerBucket;
    }

    return {
        levels,
        remainder: buffer.subarray(offset),
    };
}

function startLiveLevelLoop() {
    const samplesPerBucket = Math.max(1, Math.floor(SAMPLE_RATE / HZ));

    function spawnReader() {
        status.running = true;
        status.restartedAt = Date.now();

        const ff = spawn("ffmpeg", [
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", STREAM_URL,
            "-vn",
            "-ac", "1",
            "-ar", String(SAMPLE_RATE),
            "-f", "s16le",
            "-",
        ]);

        let pending = Buffer.alloc(0);

        ff.stdout.on("data", (chunk) => {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            const parsed = parseBuckets(pending, samplesPerBucket);
            pending = parsed.remainder;
            for (const level of parsed.levels) handleLevel(level);
        });

        ff.stderr.on("data", (chunk) => {
            const msg = String(chunk).trim();
            if (msg) status.lastError = msg;
        });

        ff.on("error", (err) => {
            status.running = false;
            status.lastError = err.message;
            console.error("ffmpeg spawn:", err.message);
        });

        ff.on("close", (code, signal) => {
            status.running = false;
            status.lastError = `ffmpeg exited code=${code} signal=${signal}`;
            setTimeout(spawnReader, RECONNECT_MS);
        });
    }

    spawnReader();
}

async function readRecentLevels(sinceTs) {
    const cutoffHour = hourKey(sinceTs);
    let files = [];
    try {
        files = (await fsp.readdir(LEVEL_DIR))
            .filter((name) => name.endsWith(".ndjson") && name.slice(0, 13) >= cutoffHour)
            .sort();
    } catch {
        return [];
    }

    const rows = [];
    for (const name of files) {
        const raw = await fsp.readFile(path.join(LEVEL_DIR, name), "utf8");
        for (const line of raw.split("\n")) {
            if (!line) continue;
            const row = JSON.parse(line);
            if (row.ts >= sinceTs) rows.push(row);
        }
    }
    return rows;
}

async function readLevelsRange(fromTs, toTs) {
    const fromHour = hourKey(fromTs);
    const toHour = hourKey(toTs);
    let files = [];
    try {
        files = (await fsp.readdir(LEVEL_DIR))
            .filter((name) => name.endsWith(".ndjson") && name.slice(0, 13) >= fromHour && name.slice(0, 13) <= toHour)
            .sort();
    } catch {
        return [];
    }

    const rows = [];
    for (const name of files) {
        const raw = await fsp.readFile(path.join(LEVEL_DIR, name), "utf8");
        for (const line of raw.split("\n")) {
            if (!line) continue;
            const row = JSON.parse(line);
            if (row.ts >= fromTs && row.ts <= toTs) rows.push(row);
        }
    }
    return rows;
}

function toPixels(levels, fromTs, toTs, px) {
    const out = new Array(px).fill(0);
    const span = Math.max(1, toTs - fromTs);
    for (const level of levels) {
        const p = Math.min(px - 1, Math.max(0, ((level.ts - fromTs) / span) * px | 0));
        if (level.norm > out[p]) out[p] = level.norm;
    }
    return out;
}

app.get("/api/live-levels", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    clients.add(res);
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);

    req.on("close", () => clients.delete(res));
});

app.get("/api/levels/recent", async (req, res) => {
    const seconds = Math.max(1, Math.min(86400, Number(req.query.seconds || HISTORY_SECONDS)));
    const since = Date.now() - (seconds * 1000);
    const inMemory = recentLevels.filter((level) => level.ts >= since);
    if (inMemory.length) {
        res.json({ since, streamUrl: STREAM_URL, levels: inMemory });
        return;
    }
    res.json({ since, streamUrl: STREAM_URL, levels: await readRecentLevels(since) });
});

app.get("/api/levels/status", (_req, res) => {
    res.json({
        ...status,
        hz: HZ,
        sampleRate: SAMPLE_RATE,
        levelDir: LEVEL_DIR,
        pathName: PATH_NAME,
        playbackBase: PLAYBACK_BASE,
        recentCount: recentLevels.length,
    });
});

app.get("/api/archive/view", async (req, res) => {
    const from = +new Date(req.query.from);
    const to = +new Date(req.query.to);
    const px = Math.min(4000, Math.max(50, Number(req.query.px || 1200)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        res.status(400).json({ error: "invalid range" });
        return;
    }

    try {
        const [levels, availability] = await Promise.all([
            readLevelsRange(from, to),
            spans().catch(() => []),
        ]);
        res.json({
            from,
            to,
            px,
            levels: toPixels(levels, from, to, px),
            count: levels.length,
            spans: availability,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/archive/audio", async (req, res) => {
    const start = +new Date(req.query.start);
    const duration = Math.min(1800, Math.max(5, Number(req.query.duration || 120)));
    if (!Number.isFinite(start)) {
        res.status(400).json({ error: "invalid start" });
        return;
    }

    try {
        const response = await fetch(getPlaybackUrl(start, duration, "mp4"));
        res.status(response.status);
        res.set("content-type", response.headers.get("content-type") || "video/mp4");
        if (req.query.download === "1") {
            const stamp = new Date(start).toISOString().replace(/[:.]/g, "-");
            res.set("content-disposition", `attachment; filename="${PATH_NAME}-${stamp}-${duration}s.mp4"`);
        }
        if (!response.body) {
            res.end();
            return;
        }
        Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/live-audio", (req, res) => {
    res.status(200);
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "no-store");
    res.setHeader("connection", "keep-alive");

    const ff = spawn("ffmpeg", [
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-i", STREAM_URL,
        "-vn",
        "-ac", "1",
        "-ar", "22050",
        "-b:a", "64k",
        "-f", "mp3",
        "-",
    ]);

    ff.stdout.pipe(res);

    ff.stderr.on("data", (chunk) => {
        const msg = String(chunk).trim();
        if (msg) console.error("live audio:", msg);
    });

    const stop = () => {
        ff.stdout.unpipe(res);
        if (!ff.killed) ff.kill("SIGTERM");
    };

    req.on("close", stop);
    res.on("close", stop);

    ff.on("error", (err) => {
        console.error("live audio spawn:", err.message);
        if (!res.headersSent) res.status(500).end(err.message);
        else res.end();
    });

    ff.on("close", () => {
        res.end();
    });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
    console.log(`live levels on http://localhost:${PORT}`);
    console.log(`stream source: ${STREAM_URL}`);
});

startLiveLevelLoop();