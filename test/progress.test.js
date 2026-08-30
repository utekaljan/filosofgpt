'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formatDuration, ProgressTracker } = require('../src/lib/progress');

test('formats progress durations for terminal output', () => {
    assert.equal(formatDuration(12_000), '12s');
    assert.equal(formatDuration(125_000), '2m 5s');
    assert.equal(formatDuration(3_665_000), '1h 1m 5s');
    assert.equal(formatDuration(Number.NaN), 'unknown');
});

test('reports batch start, completion and totals', () => {
    const messages = [];
    const tracker = new ProgressTracker({ scope: 'test', total: 2, heartbeatMs: 60_000, writer: message => messages.push(message) });
    tracker.start('one', 1, 'batch-one');
    tracker.heartbeat();
    tracker.complete('one', 'saved');
    tracker.stop();
    assert.equal(tracker.completed, 1);
    assert.ok(messages.some(message => message.includes('START 1/2')));
    assert.ok(messages.some(message => message.includes('heartbeat') && message.includes('batch-one')));
    assert.ok(messages.some(message => message.includes('1/2 (50%)')));
});
