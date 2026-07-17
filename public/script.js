const historyCanvas = document.getElementById("history");
const historyCtx = historyCanvas.getContext("2d");
const meterFill = document.getElementById("meterFill");
const dot = document.getElementById("dot");
const connLabel = document.getElementById("connLabel");
const secondsInput = document.getElementById("seconds");
const reloadButton = document.getElementById("reload");
const jumpNowButton = document.getElementById("jumpNow");
const audio = document.getElementById("a");
const reloadAudioButton = document.getElementById("reloadAudio");
const playSelectionButton = document.getElementById("playSelection");
const playLiveButton = document.getElementById("playLive");
const exportRangeButton = document.getElementById("exportRange");

let points = [];
let liveSource = null;
let archiveData = { from: Date.now() - (2 * 60 * 60 * 1000), to: Date.now(), levels: [], spans: [], selectedAt: null };
let drag = null;
let playbackState = { mode: null, startTs: null };
let latestLiveLevel = null;
let archiveRefreshTimer = null;
let archiveFetchSeq = 0;
let followLiveEdge = true;
let scrub = null;
let rangeSelect = null;

function connectAudio(autoplay) {
    const nextSrc = `/api/live-audio?ts=${Date.now()}`;
    const wasPlaying = autoplay || !audio.paused;
    const span = archiveData.to - archiveData.from;
    playbackState.mode = "live";
    playbackState.startTs = null;
    followLiveEdge = true;
    archiveData.to = Date.now();
    archiveData.from = archiveData.to - span;
    archiveData.selectedAt = archiveData.to;
    audio.src = nextSrc;
    audio.load();
    if (wasPlaying) {
        audio.play().catch(() => {
            connLabel.textContent = "audio blocked";
        });
    }
    syncMeterToPlayhead();
    drawHistory();
}

function setConnection(connected, label) {
    if (dot) dot.classList.toggle("live", connected);
    if (connLabel) connLabel.textContent = label;
}

function updateMeter(level) {
    if (meterFill) {
        meterFill.style.height = `${Math.max(0, Math.min(100, level.norm * 100))}%`;
    }
}

function clearMeter(ts) {
    updateMeter({ ts: ts ?? null, norm: 0, db: null, peakText: "--" });
}

function levelFromArchiveTs(ts) {
    const values = archiveData.levels || [];
    if (!values.length) return null;
    const span = archiveData.to - archiveData.from;
    if (span <= 0) return null;
    const frac = (ts - archiveData.from) / span;
    if (frac < 0 || frac > 1) return null;
    const index = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
    const norm = values[index] || 0;
    return {
        ts,
        norm,
        db: (norm * 60) - 60,
        peakText: `${Math.round(norm * 100)}%`,
    };
}

function trimLivePoints() {
    const cutoff = archiveData.from - (60 * 1000);
    points = points.filter((point) => point.ts >= cutoff);
}

function paintPointsIntoLevels() {
    const values = archiveData.levels || [];
    const span = archiveData.to - archiveData.from;
    if (!values.length || span <= 0) return;
    for (const point of points) {
        if (point.ts < archiveData.from || point.ts > archiveData.to) continue;
        const index = Math.max(0, Math.min(values.length - 1, Math.round(((point.ts - archiveData.from) / span) * (values.length - 1))));
        values[index] = Math.max(values[index] || 0, point.norm || 0);
    }
}

function advanceLiveWindow(nextTo) {
    const span = archiveData.to - archiveData.from;
    if (span <= 0) {
        archiveData.to = nextTo;
        return;
    }

    const values = archiveData.levels || [];
    const nextFrom = nextTo - span;
    const delta = Math.max(0, nextTo - archiveData.to);
    if (values.length && delta > 0) {
        const shift = Math.min(values.length, Math.round((delta / span) * values.length));
        if (shift > 0) {
            archiveData.levels = values.slice(shift);
            while (archiveData.levels.length < values.length) archiveData.levels.push(0);
        }
    }

    archiveData.to = nextTo;
    archiveData.from = nextFrom;
    trimLivePoints();
    paintPointsIntoLevels();
}

function syncMeterToPlayhead() {
    const playheadTs = currentPlayheadTs();
    if (!playheadTs) {
        clearMeter(null);
        return;
    }

    if (playbackState.mode === "live" && latestLiveLevel) {
        updateMeter({
            ts: playheadTs,
            norm: latestLiveLevel.norm,
            db: latestLiveLevel.db,
            peak: latestLiveLevel.peak,
        });
        return;
    }

    const archiveLevel = levelFromArchiveTs(playheadTs);
    if (archiveLevel) {
        updateMeter(archiveLevel);
        return;
    }

    clearMeter(playheadTs);
}

function currentPlayheadTs() {
    if (playbackState.mode === "archive" && playbackState.startTs != null) {
        return playbackState.startTs + (audio.currentTime * 1000);
    }
    if (playbackState.mode === "live") {
        return archiveData.to;
    }
    return null;
}

function fmtCompactTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isMobileLayout() {
    return window.matchMedia("(max-width: 700px)").matches;
}

function chooseTickStep(spanMs, width) {
    const target = spanMs * (120 / Math.max(1, width));
    const steps = [
        60_000,
        5 * 60_000,
        10 * 60_000,
        15 * 60_000,
        30 * 60_000,
        60 * 60_000,
        2 * 60 * 60_000,
        4 * 60 * 60_000,
        6 * 60 * 60_000,
        12 * 60 * 60_000,
        24 * 60 * 60_000,
    ];
    return steps.find((step) => step >= target) || steps.at(-1);
}

function tsToX(ts, start, span, width) {
    return ((ts - start) / span) * width;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function drawMobileScrubber(width, height, values, start, end, span) {
    const centerX = width * 0.5;
    const centerY = height * 0.52;
    const trackW = Math.min(132, width * 0.32);
    const trackH = height - 34;
    const trackX = centerX - trackW / 2;
    const trackY = (height - trackH) / 2;
    const playheadTs = currentPlayheadTs() ?? end;
    const slotCount = 9;
    const slotGap = trackH / (slotCount + 1);
    const msPerSlot = Math.max(5_000, span / 10);

    historyCtx.fillStyle = "rgba(255,255,255,0.02)";
    historyCtx.fillRect(0, 0, width, height);

    historyCtx.fillStyle = "rgba(5, 14, 22, 0.72)";
    drawRoundedRect(historyCtx, trackX, trackY, trackW, trackH, 28);
    historyCtx.fill();

    historyCtx.strokeStyle = "rgba(255,255,255,0.08)";
    historyCtx.lineWidth = 1;
    drawRoundedRect(historyCtx, trackX, trackY, trackW, trackH, 28);
    historyCtx.stroke();

    for (let i = -Math.floor(slotCount / 2); i <= Math.floor(slotCount / 2); i++) {
        const ts = playheadTs + (i * msPerSlot);
        const y = centerY + (i * slotGap);
        const level = playbackState.mode === "live" && i === 0 && latestLiveLevel
            ? latestLiveLevel
            : levelFromArchiveTs(ts);
        const norm = level?.norm || 0.08;
        const widthScale = i === 0 ? 0.82 : 0.25 + (norm * 0.55);
        const barW = trackW * widthScale;
        const barX = centerX - (barW / 2);
        const barH = i === 0 ? 18 : Math.max(8, 8 + norm * 12);
        const alpha = i === 0 ? 1 : Math.max(0.18, 0.72 - (Math.abs(i) * 0.12));
        historyCtx.fillStyle = i === 0
            ? (playbackState.mode === "live" ? "#6df2b7" : "#ff8f3d")
            : `rgba(110, 197, 255, ${alpha})`;
        drawRoundedRect(historyCtx, barX, y - barH / 2, barW, barH, 10);
        historyCtx.fill();

        if (i !== 0) {
            historyCtx.fillStyle = `rgba(142, 164, 184, ${Math.max(0.16, 0.56 - Math.abs(i) * 0.08)})`;
            historyCtx.font = "11px IBM Plex Mono, monospace";
            const label = fmtCompactTime(Math.max(start, Math.min(end, ts)));
            const tw = historyCtx.measureText(label).width;
            historyCtx.fillText(label, centerX - tw / 2, y + 20);
        }
    }

    historyCtx.strokeStyle = playbackState.mode === "live" ? "rgba(109, 242, 183, 0.9)" : "rgba(255, 143, 61, 0.9)";
    historyCtx.lineWidth = 2;
    historyCtx.beginPath();
    historyCtx.moveTo(trackX + 10, centerY);
    historyCtx.lineTo(trackX + trackW - 10, centerY);
    historyCtx.stroke();

    historyCtx.fillStyle = playbackState.mode === "live" ? "#6df2b7" : "#ff8f3d";
    const liveLabel = playbackState.mode === "live" ? "LIVE" : fmtCompactTime(playheadTs);
    const pillW = historyCtx.measureText(liveLabel).width + 26;
    drawRoundedRect(historyCtx, centerX - pillW / 2, 10, pillW, 26, 12);
    historyCtx.fill();
    historyCtx.fillStyle = "#08111a";
    historyCtx.font = "12px IBM Plex Mono, monospace";
    historyCtx.fillText(liveLabel, centerX - pillW / 2 + 13, 27);

    historyCtx.fillStyle = "#8ea4b8";
    historyCtx.fillText("pull down for earlier", 14, height - 12);
    const rightLabel = playbackState.mode === "live" ? "playing" : "release to play";
    const tw = historyCtx.measureText(rightLabel).width;
    historyCtx.fillText(rightLabel, width - tw - 14, height - 12);
}

function drawHistory() {
    const width = historyCanvas.clientWidth;
    const height = historyCanvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    historyCanvas.width = Math.round(width * ratio);
    historyCanvas.height = Math.round(height * ratio);
    historyCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    historyCtx.clearRect(0, 0, width, height);

    const values = archiveData.levels || [];
    const start = archiveData.from;
    const end = archiveData.to;
    const span = Math.max(1, end - start);
    const padX = 12;
    const topLaneY = 10;
    const topLaneH = 22;
    const detailTop = 40;
    const detailBottom = height - 28;
    const detailH = detailBottom - detailTop;
    const plotW = width - padX * 2;

    if (isMobileLayout()) {
        drawMobileScrubber(width, height, values, start, end, span);
        return;
    }

    historyCtx.fillStyle = "rgba(255,255,255,0.02)";
    historyCtx.fillRect(0, 0, width, height);

    historyCtx.fillStyle = "rgba(5, 14, 22, 0.55)";
    drawRoundedRect(historyCtx, padX, topLaneY, plotW, topLaneH, 10);
    historyCtx.fill();

    historyCtx.fillStyle = "rgba(5, 14, 22, 0.45)";
    drawRoundedRect(historyCtx, padX, detailTop, plotW, detailH, 12);
    historyCtx.fill();

    historyCtx.strokeStyle = "rgba(142, 164, 184, 0.10)";
    historyCtx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = detailTop + (detailH / 4) * i;
        historyCtx.beginPath();
        historyCtx.moveTo(padX, y);
        historyCtx.lineTo(width - padX, y);
        historyCtx.stroke();
    }

    const tickStep = chooseTickStep(span, plotW);
    const tickStart = Math.ceil(start / tickStep) * tickStep;
    historyCtx.strokeStyle = "rgba(142, 164, 184, 0.12)";
    historyCtx.fillStyle = "#8ea4b8";
    historyCtx.font = "10px IBM Plex Mono, monospace";
    for (let ts = tickStart; ts < end; ts += tickStep) {
        const x = padX + tsToX(ts, start, span, plotW);
        historyCtx.beginPath();
        historyCtx.moveTo(x, detailTop);
        historyCtx.lineTo(x, detailBottom);
        historyCtx.stroke();
        historyCtx.fillText(fmtCompactTime(ts), x + 4, detailTop - 6);
    }

    if (!values.length) {
        historyCtx.fillStyle = "#8ea4b8";
        historyCtx.font = "14px IBM Plex Mono, monospace";
        historyCtx.fillText("No saved points in this window", 24, detailTop + 24);
        return;
    }

    historyCtx.fillStyle = "rgba(255, 211, 110, 0.18)";
    for (const block of archiveData.spans || []) {
        const left = Math.max(padX, padX + tsToX(block.st, start, span, plotW));
        const right = Math.min(width - padX, padX + tsToX(block.en, start, span, plotW));
        if (right <= padX || left >= width - padX) continue;
        drawRoundedRect(historyCtx, left, topLaneY + 6, Math.max(2, right - left), 16, 6);
        historyCtx.fill();
    }

    const area = historyCtx.createLinearGradient(0, detailTop, 0, detailBottom);
    area.addColorStop(0, "rgba(110, 197, 255, 0.28)");
    area.addColorStop(1, "rgba(110, 197, 255, 0.02)");
    historyCtx.beginPath();
    values.forEach((value, index) => {
        const x = padX + (index / Math.max(1, values.length - 1)) * plotW;
        const y = detailBottom - (value * (detailH - 16)) - 8;
        if (index === 0) historyCtx.moveTo(x, y);
        else historyCtx.lineTo(x, y);
    });
    historyCtx.lineTo(width - padX, detailBottom);
    historyCtx.lineTo(padX, detailBottom);
    historyCtx.closePath();
    historyCtx.fillStyle = area;
    historyCtx.fill();

    historyCtx.strokeStyle = "#6ec5ff";
    historyCtx.lineWidth = 2;
    historyCtx.beginPath();
    values.forEach((value, index) => {
        const x = padX + (index / Math.max(1, values.length - 1)) * plotW;
        const y = detailBottom - (value * (detailH - 16)) - 8;
        if (index === 0) historyCtx.moveTo(x, y);
        else historyCtx.lineTo(x, y);
    });
    historyCtx.stroke();

    historyCtx.strokeStyle = "rgba(255, 143, 61, 0.7)";
    historyCtx.lineWidth = 1;
    values.forEach((value, index) => {
        const x = padX + (index / Math.max(1, values.length - 1)) * plotW;
        const top = detailBottom - (value * (detailH - 16)) - 8;
        historyCtx.beginPath();
        historyCtx.moveTo(x, detailBottom);
        historyCtx.lineTo(x, top);
        historyCtx.stroke();
    });

    const selectedRange = getSelectedRange();
    if (selectedRange) {
        const rangeLeft = padX + tsToX(selectedRange.from, start, span, plotW);
        const rangeRight = padX + tsToX(selectedRange.to, start, span, plotW);
        historyCtx.fillStyle = "rgba(255, 143, 61, 0.16)";
        drawRoundedRect(historyCtx, Math.max(padX, rangeLeft), detailTop, Math.max(4, rangeRight - rangeLeft), detailH, 10);
        historyCtx.fill();
        historyCtx.strokeStyle = "rgba(255, 143, 61, 0.60)";
        historyCtx.lineWidth = 2;
        drawRoundedRect(historyCtx, Math.max(padX, rangeLeft), detailTop, Math.max(4, rangeRight - rangeLeft), detailH, 10);
        historyCtx.stroke();
    }

    if (archiveData.selectedAt) {
        const x = padX + tsToX(archiveData.selectedAt, start, span, plotW);
        historyCtx.strokeStyle = "#ff8f3d";
        historyCtx.lineWidth = 2;
        historyCtx.beginPath();
        historyCtx.moveTo(x, detailTop - 8);
        historyCtx.lineTo(x, detailBottom + 10);
        historyCtx.stroke();
        historyCtx.fillStyle = "#ff8f3d";
        const selectedLabel = fmtCompactTime(archiveData.selectedAt);
        const labelPadding = 12;
        const labelW = Math.max(108, Math.ceil(historyCtx.measureText(selectedLabel).width + labelPadding * 2));
        const labelLeft = Math.max(padX, Math.min(x - labelW / 2, width - padX - labelW));
        drawRoundedRect(historyCtx, labelLeft, detailTop + 8, labelW, 20, 8);
        historyCtx.fill();
        historyCtx.fillStyle = "#08111a";
        historyCtx.fillText(selectedLabel, labelLeft + labelPadding, detailTop + 22);
    }

    const playheadTs = currentPlayheadTs();
    if (playheadTs && playheadTs >= start && playheadTs <= end) {
        const x = padX + tsToX(playheadTs, start, span, plotW);
        historyCtx.strokeStyle = playbackState.mode === "live" ? "#6df2b7" : "#8bf7ca";
        historyCtx.lineWidth = 3;
        historyCtx.beginPath();
        historyCtx.moveTo(x, topLaneY);
        historyCtx.lineTo(x, detailBottom + 10);
        historyCtx.stroke();
        historyCtx.fillStyle = playbackState.mode === "live" ? "#6df2b7" : "#8bf7ca";
        historyCtx.beginPath();
        historyCtx.arc(x, detailTop - 14, 6, 0, Math.PI * 2);
        historyCtx.fill();
    }

    historyCtx.fillStyle = "#8ea4b8";
    historyCtx.font = "12px IBM Plex Mono, monospace";
    historyCtx.fillText(new Date(start).toLocaleString(), padX, height - 10);
    const endLabel = new Date(end).toLocaleString();
    const textWidth = historyCtx.measureText(endLabel).width;
    historyCtx.fillText(endLabel, width - textWidth - padX, height - 10);
}

async function loadRecent() {
    const requestSeq = ++archiveFetchSeq;
    const viewFrom = archiveData.from;
    const viewTo = archiveData.to;
    const response = await fetch(`/api/archive/view?from=${encodeURIComponent(new Date(viewFrom).toISOString())}&to=${encodeURIComponent(new Date(viewTo).toISOString())}&px=${Math.max(400, Math.floor(historyCanvas.clientWidth || 1000))}`);
    const payload = await response.json();
    if (requestSeq !== archiveFetchSeq) return;
    archiveData.levels = payload.levels || [];
    archiveData.spans = payload.spans || [];
    paintPointsIntoLevels();
    syncMeterToPlayhead();
    drawHistory();
}

async function refreshArchiveWindow() {
    if (drag) return;
    await loadRecent();
}

function scheduleArchiveRefresh(delay = 120) {
    if (archiveRefreshTimer) clearTimeout(archiveRefreshTimer);
    archiveRefreshTimer = setTimeout(() => {
        archiveRefreshTimer = null;
        refreshArchiveWindow().catch(() => { });
    }, delay);
}

function historyTsForClientX(clientX) {
    const rect = historyCanvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return archiveData.from + frac * (archiveData.to - archiveData.from);
}

function laneForPointer(clientY) {
    if (isMobileLayout()) return "detail";
    const y = clientY - historyCanvas.getBoundingClientRect().top;
    const height = historyCanvas.clientHeight;
    if (y >= 32 && y <= height - 22) return "detail";
    return "other";
}

function clampArchiveWindow() {
    const maxSpan = 7 * 24 * 60 * 60 * 1000;
    const minSpan = 60 * 1000;
    let span = archiveData.to - archiveData.from;
    span = Math.max(minSpan, Math.min(maxSpan, span));
    if (archiveData.to > Date.now()) {
        archiveData.to = Date.now();
        archiveData.from = archiveData.to - span;
    }
}

function setSelection(ts) {
    followLiveEdge = false;
    archiveData.selectedAt = Math.max(archiveData.from, Math.min(ts, archiveData.to));
    drawHistory();
}

function getSelectedRange() {
    if (!rangeSelect?.startTs || !rangeSelect?.endTs) return null;
    const from = Math.max(archiveData.from, Math.min(rangeSelect.startTs, rangeSelect.endTs));
    const to = Math.min(archiveData.to, Math.max(rangeSelect.startTs, rangeSelect.endTs));
    if (to - from < 1000) return null;
    return { from, to, duration: Math.ceil((to - from) / 1000) };
}

function updateRangeLabel() {
    const selectedRange = getSelectedRange();
    if (selectedRange) {
        exportRangeButton.disabled = false;
        return;
    }
    exportRangeButton.disabled = true;
}

function setScrubPlayhead(ts) {
    setSelection(ts);
    playbackState.mode = "archive";
    playbackState.startTs = archiveData.selectedAt;
    syncMeterToPlayhead();
}

function exportSelectedRange() {
    const selectedRange = getSelectedRange();
    if (!selectedRange) return;
    const url = `/api/archive/audio?start=${encodeURIComponent(new Date(selectedRange.from).toISOString())}&duration=${selectedRange.duration}&download=1`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

function playArchiveSelection() {
    const clipSeconds = Math.max(10, Math.min(1800, Number(secondsInput.value || 120)));
    const start = archiveData.selectedAt || (archiveData.to - clipSeconds * 1000);
    playbackState.mode = "archive";
    playbackState.startTs = start;
    followLiveEdge = false;
    audio.src = `/api/archive/audio?start=${encodeURIComponent(new Date(start).toISOString())}&duration=${clipSeconds}`;
    audio.load();
    audio.play().catch(() => {
        connLabel.textContent = "audio blocked";
    });
    syncMeterToPlayhead();
    drawHistory();
}

function connectLive() {
    if (liveSource) liveSource.close();
    liveSource = new EventSource("/api/live-levels");
    setConnection(false, "connecting");

    liveSource.addEventListener("open", () => {
        setConnection(true, "live");
    });

    liveSource.addEventListener("error", () => {
        setConnection(false, "reconnecting");
    });

    liveSource.onmessage = (event) => {
        const level = JSON.parse(event.data);
        points.push(level);
        trimLivePoints();
        latestLiveLevel = level;
        if (followLiveEdge) {
            advanceLiveWindow(Date.now());
        } else {
            paintPointsIntoLevels();
        }
        syncMeterToPlayhead();
        drawHistory();
    };
}

reloadButton.addEventListener("click", async () => {
    await loadRecent();
});

playSelectionButton.addEventListener("click", () => {
    playArchiveSelection();
});

playLiveButton.addEventListener("click", () => {
    connectAudio(true);
});

exportRangeButton.addEventListener("click", () => {
    exportSelectedRange();
});

jumpNowButton.addEventListener("click", async () => {
    const span = archiveData.to - archiveData.from;
    followLiveEdge = true;
    archiveData.to = Date.now();
    archiveData.from = archiveData.to - span;
    archiveData.selectedAt = archiveData.to;
    await loadRecent();
    syncMeterToPlayhead();
    drawHistory();
});

addEventListener("resize", drawHistory);

historyCanvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
});

historyCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
});

historyCanvas.addEventListener("wheel", async (event) => {
    event.preventDefault();
    followLiveEdge = false;
    const anchor = historyTsForClientX(event.clientX);
    const span = archiveData.to - archiveData.from;
    const scale = Math.exp(event.deltaY * 0.0015);
    const nextSpan = Math.max(60 * 1000, Math.min(7 * 24 * 60 * 60 * 1000, span * scale));
    const frac = (anchor - archiveData.from) / span;
    archiveData.from = anchor - frac * nextSpan;
    archiveData.to = archiveData.from + nextSpan;
    clampArchiveWindow();
    scheduleArchiveRefresh(80);
    drawHistory();
}, { passive: false });

historyCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 2 && event.button !== 1 && event.button !== 0) return;
    if (event.button === 2) {
        rangeSelect = {
            pointerId: event.pointerId,
            startTs: historyTsForClientX(event.clientX),
            endTs: historyTsForClientX(event.clientX),
        };
        followLiveEdge = false;
        updateRangeLabel();
        historyCanvas.setPointerCapture(event.pointerId);
        drawHistory();
        return;
    }
    if (event.button === 0 && laneForPointer(event.clientY) === "detail") {
        scrub = {
            pointerId: event.pointerId,
            wasPaused: audio.paused,
            vertical: isMobileLayout(),
            startY: event.clientY,
            startTs: currentPlayheadTs() ?? archiveData.selectedAt ?? archiveData.to,
        };
        followLiveEdge = false;
        historyCanvas.classList.add("scrubbing");
        setScrubPlayhead(scrub.vertical ? scrub.startTs : historyTsForClientX(event.clientX));
        historyCanvas.setPointerCapture(event.pointerId);
        return;
    }
    drag = {
        button: event.button,
        x: event.clientX,
        from: archiveData.from,
        to: archiveData.to,
        moved: false,
    };
    if (event.button === 1) {
        event.preventDefault();
        followLiveEdge = false;
        historyCanvas.classList.add("panning");
    }
    historyCanvas.setPointerCapture(event.pointerId);
});

historyCanvas.addEventListener("pointermove", (event) => {
    if (rangeSelect && rangeSelect.pointerId === event.pointerId) {
        rangeSelect.endTs = historyTsForClientX(event.clientX);
        updateRangeLabel();
        drawHistory();
        return;
    }
    if (scrub && scrub.pointerId === event.pointerId) {
        if (scrub.vertical) {
            const span = archiveData.to - archiveData.from;
            const msPerPx = Math.max(250, span / Math.max(120, historyCanvas.clientHeight * 2.4));
            const nextTs = scrub.startTs - ((event.clientY - scrub.startY) * msPerPx);
            setScrubPlayhead(nextTs);
        } else {
            setScrubPlayhead(historyTsForClientX(event.clientX));
        }
        return;
    }
    if (!drag) return;
    if (drag.button !== 1) return;
    const rect = historyCanvas.getBoundingClientRect();
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    const span = drag.to - drag.from;
    const delta = (dx / rect.width) * span;
    archiveData.from = drag.from - delta;
    archiveData.to = drag.to - delta;
    clampArchiveWindow();
    scheduleArchiveRefresh(80);
    drawHistory();
});

historyCanvas.addEventListener("pointerup", async (event) => {
    if (rangeSelect && rangeSelect.pointerId === event.pointerId) {
        rangeSelect = {
            startTs: rangeSelect.startTs,
            endTs: rangeSelect.endTs,
        };
        updateRangeLabel();
        drawHistory();
        return;
    }
    if (scrub && scrub.pointerId === event.pointerId) {
        const activeScrub = scrub;
        scrub = null;
        historyCanvas.classList.remove("scrubbing");
        playArchiveSelection();
        if (activeScrub.wasPaused && !activeScrub.vertical) {
            audio.pause();
            syncMeterToPlayhead();
            drawHistory();
        }
        return;
    }
    const activeDrag = drag;
    drag = null;
    historyCanvas.classList.remove("panning");
    if (!activeDrag) return;
    if (activeDrag.button === 1) {
        scheduleArchiveRefresh(0);
        return;
    }
    setSelection(historyTsForClientX(event.clientX));
    playArchiveSelection();
});

historyCanvas.addEventListener("pointercancel", () => {
    drag = null;
    scrub = null;
    rangeSelect = null;
    historyCanvas.classList.remove("panning");
    historyCanvas.classList.remove("scrubbing");
});

audio.addEventListener("timeupdate", () => {
    syncMeterToPlayhead();
    drawHistory();
});

audio.addEventListener("play", () => {
    syncMeterToPlayhead();
    drawHistory();
});

audio.addEventListener("pause", () => {
    syncMeterToPlayhead();
    drawHistory();
});

(async function boot() {
    archiveData.selectedAt = archiveData.to - 60_000;
    updateRangeLabel();
    await loadRecent();
    connectLive();
    connectAudio(false);
    drawHistory();
    setInterval(() => {
        if (followLiveEdge) {
            advanceLiveWindow(Date.now());
            drawHistory();
            refreshArchiveWindow().catch(() => { });
        }
    }, 15_000);
})().catch((err) => {
    console.error(err);
    setConnection(false, "error");
});