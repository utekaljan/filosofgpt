'use strict';

function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function progressLog(scope, message, writer = console.error) {
    writer(`[${new Date().toISOString()}] [${scope}] ${message}`);
}

class ProgressTracker {
    constructor({
        scope,
        total,
        completed = 0,
        heartbeatMs = 30_000,
        percentStep = 5,
        writer = console.error
    }) {
        this.scope = scope;
        this.total = Math.max(0, total || 0);
        this.completed = Math.max(0, completed || 0);
        this.initialCompleted = this.completed;
        this.heartbeatMs = heartbeatMs;
        this.percentStep = Math.max(1, percentStep);
        this.writer = writer;
        this.startedAt = Date.now();
        this.lastEmissionAt = 0;
        this.lastPercent = -1;
        this.active = new Map();
        this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
        this.timer.unref?.();
    }

    phase(message) {
        progressLog(this.scope, message, this.writer);
        this.lastEmissionAt = Date.now();
    }

    start(id, ordinal, detail = '') {
        this.active.set(id, { ordinal, detail, startedAt: Date.now() });
        const suffix = detail ? ` — ${detail}` : '';
        this.phase(`START ${ordinal}/${this.total}${suffix}`);
    }

    complete(id, detail = '') {
        const active = this.active.get(id);
        this.active.delete(id);
        this.completed += 1;
        const itemElapsed = active ? `; item ${formatDuration(Date.now() - active.startedAt)}` : '';
        const suffix = detail ? `; ${detail}` : '';
        this.emit(`DONE ${active?.ordinal ?? this.completed}/${this.total}${itemElapsed}${suffix}`, true);
    }

    fail(id, error) {
        const active = this.active.get(id);
        this.active.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        this.emit(`FAILED ${active?.ordinal ?? '?'}/${this.total}: ${message}`, true);
    }

    advance(detail = '', force = false) {
        this.completed += 1;
        this.emit(detail, force);
    }

    heartbeat() {
        const active = [...this.active.values()]
            .sort((a, b) => a.ordinal - b.ordinal)
            .slice(0, 4)
            .map(item => `${item.ordinal}/${this.total} ${item.detail || 'running'} (${formatDuration(Date.now() - item.startedAt)})`);
        const activeText = active.length ? `; active: ${active.join(' | ')}` : '';
        this.emit(`heartbeat${activeText}`, true);
    }

    emit(detail = '', force = false) {
        const now = Date.now();
        const safeTotal = Math.max(1, this.total);
        const percent = Math.min(100, Math.floor((this.completed / safeTotal) * 100));
        const shouldEmit = force || this.completed >= this.total || percent >= this.lastPercent + this.percentStep || now - this.lastEmissionAt >= this.heartbeatMs;
        if (!shouldEmit) return;
        this.lastPercent = percent;
        this.lastEmissionAt = now;
        const processedThisRun = this.completed - this.initialCompleted;
        const elapsed = now - this.startedAt;
        const remaining = Math.max(0, this.total - this.completed);
        const eta = processedThisRun > 0 ? elapsed / processedThisRun * remaining : NaN;
        const suffix = detail ? `; ${detail}` : '';
        progressLog(
            this.scope,
            `${this.completed}/${this.total} (${percent}%); elapsed ${formatDuration(elapsed)}; ETA ${formatDuration(eta)}${suffix}`,
            this.writer
        );
    }

    stop(message = 'complete') {
        clearInterval(this.timer);
        this.emit(message, true);
    }

    dispose() {
        clearInterval(this.timer);
    }
}

module.exports = {
    formatDuration,
    progressLog,
    ProgressTracker
};
