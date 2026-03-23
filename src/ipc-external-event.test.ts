import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processExternalEvent } from './ipc.js';
import type { IpcDeps } from './ipc.js';
import type { NewMessage, RegisteredGroup } from './types.js';

function createMockDeps(groups: Record<string, RegisteredGroup> = {}) {
  const storeMessage = vi.fn<(msg: NewMessage) => void>();
  const enqueueExternalEvent = vi.fn<(chatJid: string) => void>();
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    storeMessage,
    enqueueExternalEvent,
  };
}

const TEST_GROUP: RegisteredGroup = {
  name: 'tentaclaw',
  folder: 'slack_tentaclaw',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00Z',
};

describe('processExternalEvent', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps({ 'slack:C123': TEST_GROUP });
  });

  it('injects event as synthetic message and enqueues', async () => {
    await processExternalEvent(
      { type: 'issues.opened', prompt: 'New Issue #42', timestamp: '2026-03-23T10:00:00Z' },
      'slack_tentaclaw',
      deps,
    );

    expect(deps.storeMessage).toHaveBeenCalledOnce();
    const msg = deps.storeMessage.mock.calls[0][0];
    expect(msg.chat_jid).toBe('slack:C123');
    expect(msg.sender).toBe('event-router');
    expect(msg.sender_name).toBe('EventRouter');
    expect(msg.content).toBe('New Issue #42');
    expect(msg.is_from_me).toBe(false);
    expect(msg.is_bot_message).toBe(false);
    expect(msg.id).toMatch(/^ext-/);

    expect(deps.enqueueExternalEvent).toHaveBeenCalledWith('slack:C123');
  });

  it('ignores event for unregistered group', async () => {
    await processExternalEvent(
      { type: 'issues.opened', prompt: 'test' },
      'unknown_group',
      deps,
    );

    expect(deps.storeMessage).not.toHaveBeenCalled();
    expect(deps.enqueueExternalEvent).not.toHaveBeenCalled();
  });

  it('truncates prompt exceeding max length', async () => {
    const longPrompt = 'x'.repeat(10000);
    await processExternalEvent(
      { type: 'push', prompt: longPrompt },
      'slack_tentaclaw',
      deps,
    );

    const msg = deps.storeMessage.mock.calls[0][0];
    expect(msg.content.length).toBeLessThanOrEqual(8000 + 20); // 8000 + truncation marker
    expect(msg.content).toContain('[... truncated]');
  });

  it('falls back to JSON.stringify when prompt is missing', async () => {
    await processExternalEvent(
      { type: 'issues.opened', event: { number: 42, title: 'Bug' } },
      'slack_tentaclaw',
      deps,
    );

    const msg = deps.storeMessage.mock.calls[0][0];
    expect(msg.content).toContain('"number":42');
    expect(msg.content).toContain('"title":"Bug"');
  });

  it('always uses current time regardless of input timestamp', async () => {
    const before = new Date().toISOString();
    await processExternalEvent(
      { type: 'push', prompt: 'test', timestamp: '2020-01-01T00:00:00Z' },
      'slack_tentaclaw',
      deps,
    );
    const after = new Date().toISOString();

    const msg = deps.storeMessage.mock.calls[0][0];
    // Should use current time, not the provided past timestamp
    expect(msg.timestamp >= before).toBe(true);
    expect(msg.timestamp <= after).toBe(true);
    expect(msg.timestamp).not.toBe('2020-01-01T00:00:00Z');
  });
});
