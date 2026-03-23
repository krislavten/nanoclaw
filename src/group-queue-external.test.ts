import { describe, it, expect } from 'vitest';
import { GroupQueue } from './group-queue.js';

describe('GroupQueue external event counter', () => {
  it('starts with no external events', () => {
    const queue = new GroupQueue();
    expect(queue.hasExternalEvent('slack:C123')).toBe(false);
  });

  it('tracks a single external event', () => {
    const queue = new GroupQueue();
    queue.enqueueExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(true);
  });

  it('consumes event and clears flag', () => {
    const queue = new GroupQueue();
    queue.enqueueExternalEvent('slack:C123');
    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(false);
  });

  it('handles concurrent events with counter', () => {
    const queue = new GroupQueue();
    queue.enqueueExternalEvent('slack:C123');
    queue.enqueueExternalEvent('slack:C123');
    queue.enqueueExternalEvent('slack:C123');

    expect(queue.hasExternalEvent('slack:C123')).toBe(true);

    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(true);

    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(true);

    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(false);
  });

  it('consuming without prior enqueue does not go negative', () => {
    const queue = new GroupQueue();
    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(false);

    // Enqueue one, should still work normally
    queue.enqueueExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(true);
  });

  it('isolates counters per group', () => {
    const queue = new GroupQueue();
    queue.enqueueExternalEvent('slack:C123');
    queue.enqueueExternalEvent('slack:C456');

    expect(queue.hasExternalEvent('slack:C123')).toBe(true);
    expect(queue.hasExternalEvent('slack:C456')).toBe(true);

    queue.consumeExternalEvent('slack:C123');
    expect(queue.hasExternalEvent('slack:C123')).toBe(false);
    expect(queue.hasExternalEvent('slack:C456')).toBe(true);
  });
});
