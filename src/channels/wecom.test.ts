import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import http from 'node:http';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    WECOM_CORP_ID: 'corp123',
    WECOM_CORP_SECRET: 'secret456',
    WECOM_AGENT_ID: '1000001',
    WECOM_CALLBACK_TOKEN: 'callbacktoken789',
    WECOM_CALLBACK_PORT: '0', // Use port 0 for random available port
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { WeComChannel, WeComChannelOpts } from './wecom.js';
import { readEnvFile } from '../env.js';
import { updateChatName } from '../db.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<WeComChannelOpts>,
): WeComChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'wecom:zhangsan@corp123': {
        name: 'Test User',
        folder: 'test-user',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

/** Mock fetch to return a successful access token response */
function mockAccessTokenSuccess() {
  mockFetch.mockResolvedValueOnce({
    json: async () => ({
      errcode: 0,
      errmsg: 'ok',
      access_token: 'test_access_token_abc',
      expires_in: 7200,
    }),
  });
}

/** Mock fetch for a successful message send */
function mockMessageSendSuccess() {
  mockFetch.mockResolvedValueOnce({
    json: async () => ({ errcode: 0, errmsg: 'ok' }),
  });
}

/** Get the actual listening port from the channel's internal server */
function getServerPort(channel: WeComChannel): number {
  // Access private server field for testing
  const server = (channel as any).server;
  if (!server) throw new Error('Server not started');
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('Unexpected address type');
  return addr.port;
}

/** Compute WeCom callback signature for testing */
function computeSignature(
  token: string,
  timestamp: string,
  nonce: string,
  echostr: string,
): string {
  const parts = [token, timestamp, nonce, echostr].sort();
  return createHash('sha1').update(parts.join('')).digest('hex');
}

/** Compute WeCom POST signature for callback verification */
function computePostSignature(token: string, timestamp: string, nonce: string, body: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const parts = [token, timestamp, nonce, body].sort();
  return createHash('sha1').update(parts.join('')).digest('hex');
}

/** Build a signed POST path for WeCom callback */
function signedPostPath(token: string, body: string): string {
  const ts = '1704067200';
  const nonce = 'testnonce';
  const sig = computePostSignature(token, ts, nonce, body);
  return `/?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`;
}

/** Send HTTP request to the callback server using node:http (bypasses mocked fetch) */
function sendCallbackRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/xml' } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Tests ---

describe('WeComChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('throws when WECOM_CORP_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        WECOM_CORP_ID: '',
        WECOM_CORP_SECRET: 'secret456',
        WECOM_AGENT_ID: '1000001',
        WECOM_CALLBACK_TOKEN: 'callbacktoken789',
        WECOM_CALLBACK_PORT: '0',
      });

      expect(() => new WeComChannel(createTestOpts())).toThrow(
        'WECOM_CORP_ID, WECOM_CORP_SECRET, and WECOM_AGENT_ID must be set in .env',
      );
    });

    it('throws when WECOM_CORP_SECRET is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        WECOM_CORP_ID: 'corp123',
        WECOM_CORP_SECRET: '',
        WECOM_AGENT_ID: '1000001',
        WECOM_CALLBACK_TOKEN: 'callbacktoken789',
        WECOM_CALLBACK_PORT: '0',
      });

      expect(() => new WeComChannel(createTestOpts())).toThrow(
        'WECOM_CORP_ID, WECOM_CORP_SECRET, and WECOM_AGENT_ID must be set in .env',
      );
    });

    it('throws when WECOM_AGENT_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        WECOM_CORP_ID: 'corp123',
        WECOM_CORP_SECRET: 'secret456',
        WECOM_AGENT_ID: '',
        WECOM_CALLBACK_TOKEN: 'callbacktoken789',
        WECOM_CALLBACK_PORT: '0',
      });

      expect(() => new WeComChannel(createTestOpts())).toThrow(
        'WECOM_CORP_ID, WECOM_CORP_SECRET, and WECOM_AGENT_ID must be set in .env',
      );
    });

    it('constructs successfully with all required credentials', () => {
      expect(() => new WeComChannel(createTestOpts())).not.toThrow();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns wecom: JIDs', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('wecom:zhangsan@corp123')).toBe(true);
    });

    it('owns wecom: group JIDs', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('wecom:abcdef1234567890abcdef1234567890abc@corp123')).toBe(true);
    });

    it('does not own slack: JIDs', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own telegram JIDs', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
    });

    it('returns false after disconnect', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('refreshes access token on connect', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();

      await channel.connect();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('qyapi.weixin.qq.com/cgi-bin/gettoken'),
      );

      await channel.disconnect();
    });

    it('starts HTTP callback server on connect', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();

      await channel.connect();

      const port = getServerPort(channel);
      expect(port).toBeGreaterThan(0);

      await channel.disconnect();
    });

    it('disconnect closes HTTP server', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();

      await channel.connect();
      const server = (channel as any).server;
      expect(server).not.toBeNull();

      await channel.disconnect();
      expect((channel as any).server).toBeNull();
    });

    it('throws when access token fetch fails', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          errcode: 40013,
          errmsg: 'invalid corpid',
        }),
      });

      await expect(channel.connect()).rejects.toThrow('Failed to get WeCom access token');
    });

    it('flushes queued messages on connect', async () => {
      const channel = new WeComChannel(createTestOpts());

      // Queue messages while disconnected
      await channel.sendMessage('wecom:zhangsan@corp123', 'First queued');
      await channel.sendMessage('wecom:zhangsan@corp123', 'Second queued');

      // Connect: 1 call for token + 2 calls for the queued messages
      mockAccessTokenSuccess();
      mockMessageSendSuccess();
      mockMessageSendSuccess();

      await channel.connect();

      // Token fetch + 2 message sends = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);

      await channel.disconnect();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via WeCom API when connected', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      mockMessageSendSuccess();
      await channel.sendMessage('wecom:zhangsan@corp123', 'Hello');

      // Last fetch call should be the message send
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toContain('message/send');
      const body = JSON.parse(lastCall[1].body);
      expect(body.touser).toBe('zhangsan');
      expect(body.text.content).toBe('Hello');
      expect(body.msgtype).toBe('text');

      await channel.disconnect();
    });

    it('sends to appchat endpoint for group chat IDs (long IDs)', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      // A chatId longer than 32 chars triggers the appchat path
      const longChatId = 'a'.repeat(33);
      mockMessageSendSuccess();
      await channel.sendMessage(`wecom:${longChatId}@corp123`, 'Group msg');

      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toContain('appchat/send');
      const body = JSON.parse(lastCall[1].body);
      expect(body.chatid).toBe(longChatId);
      expect(body.text.content).toBe('Group msg');

      await channel.disconnect();
    });

    it('queues message when disconnected', async () => {
      const channel = new WeComChannel(createTestOpts());

      await channel.sendMessage('wecom:zhangsan@corp123', 'Queued message');

      // Only the readEnvFile mock would have been called, not fetch for sending
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('splits long messages at 2000 character boundary', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      const longText = 'A'.repeat(4500);
      mockMessageSendSuccess();
      mockMessageSendSuccess();
      mockMessageSendSuccess();
      await channel.sendMessage('wecom:zhangsan@corp123', longText);

      // 4500 / 2000 = 3 chunks (2000 + 2000 + 500)
      // mockFetch calls: 1 (token) + 3 (messages) = 4
      const messageCalls = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('message/send'),
      );
      expect(messageCalls).toHaveLength(3);

      const firstBody = JSON.parse(messageCalls[0][1].body);
      expect(firstBody.text.content).toHaveLength(2000);

      const secondBody = JSON.parse(messageCalls[1][1].body);
      expect(secondBody.text.content).toHaveLength(2000);

      const thirdBody = JSON.parse(messageCalls[2][1].body);
      expect(thirdBody.text.content).toHaveLength(500);

      await channel.disconnect();
    });

    it('sends exactly-2000-char messages as a single message', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      const text = 'B'.repeat(2000);
      mockMessageSendSuccess();
      await channel.sendMessage('wecom:zhangsan@corp123', text);

      const messageCalls = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('message/send'),
      );
      expect(messageCalls).toHaveLength(1);
      const body = JSON.parse(messageCalls[0][1].body);
      expect(body.text.content).toHaveLength(2000);

      await channel.disconnect();
    });

    it('queues message on send failure', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      // Make the message send fail
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 40014, errmsg: 'invalid access_token' }),
      });

      // Should not throw
      await expect(
        channel.sendMessage('wecom:zhangsan@corp123', 'Will fail'),
      ).resolves.toBeUndefined();

      await channel.disconnect();
    });
  });

  // --- XML parsing ---

  describe('XML parsing', () => {
    it('parses CDATA-wrapped XML message', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      // Replace opts to capture callbacks
      (channel as any).opts = opts;

      // Register the JID so onMessage fires
      vi.mocked(opts.registeredGroups).mockReturnValue({
        'wecom:zhangsan@corp123': {
          name: 'Test User',
          folder: 'test-user',
          trigger: '@Jonesy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      // Mock the user name resolution fetch
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, name: 'Zhang San' }),
      });

      const xml = `<xml>
        <ToUserName><![CDATA[corp123]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[Hello bot]]></Content>
        <MsgId>12345</MsgId>
      </xml>`;

      const resp = await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('success');

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'wecom:zhangsan@corp123',
        expect.any(String),
        undefined,
        'wecom',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'wecom:zhangsan@corp123',
        expect.objectContaining({
          id: '12345',
          chat_jid: 'wecom:zhangsan@corp123',
          sender: 'zhangsan',
          content: expect.stringContaining('Hello bot'),
          is_from_me: false,
          is_bot_message: false,
        }),
      );

      await channel.disconnect();
    });

    it('parses plain (non-CDATA) XML fields', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      (channel as any).opts = opts;
      vi.mocked(opts.registeredGroups).mockReturnValue({
        'wecom:lisi@corp123': {
          name: 'Li Si',
          folder: 'li-si',
          trigger: '@Jonesy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, name: 'Li Si' }),
      });

      const xml = `<xml>
        <ToUserName>corp123</ToUserName>
        <FromUserName>lisi</FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType>text</MsgType>
        <Content>Plain text</Content>
        <MsgId>67890</MsgId>
      </xml>`;

      const resp = await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);
      expect(resp.status).toBe(200);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'wecom:lisi@corp123',
        expect.objectContaining({
          id: '67890',
          content: expect.stringContaining('Plain text'),
        }),
      );

      await channel.disconnect();
    });

    it('ignores non-text message types', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      (channel as any).opts = opts;

      const xml = `<xml>
        <ToUserName><![CDATA[corp123]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType><![CDATA[image]]></MsgType>
        <PicUrl><![CDATA[http://example.com/pic.jpg]]></PicUrl>
        <MsgId>99999</MsgId>
      </xml>`;

      const resp = await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('success');

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('skips messages from unregistered groups', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      (channel as any).opts = opts;

      // Return empty registered groups
      vi.mocked(opts.registeredGroups).mockReturnValue({});

      const xml = `<xml>
        <ToUserName><![CDATA[corp123]]></ToUserName>
        <FromUserName><![CDATA[unknown_user]]></FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[Hello]]></Content>
        <MsgId>11111</MsgId>
      </xml>`;

      const resp = await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);
      expect(resp.status).toBe(200);

      // Metadata is still reported
      expect(opts.onChatMetadata).toHaveBeenCalled();
      // But no message delivered
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });
  });

  // --- Signature verification ---

  describe('signature verification', () => {
    it('returns echostr for valid GET verification request', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);

      const timestamp = '1704067200';
      const nonce = 'nonce123';
      const echostr = 'echostr_value_456';
      const signature = computeSignature('callbacktoken789', timestamp, nonce, echostr);

      const resp = await sendCallbackRequest(
        port,
        'GET',
        `/?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${echostr}`,
      );

      expect(resp.status).toBe(200);
      expect(resp.body).toBe(echostr);

      await channel.disconnect();
    });

    it('rejects invalid signature with 403', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);

      const resp = await sendCallbackRequest(
        port,
        'GET',
        '/?msg_signature=invalid_sig&timestamp=123&nonce=abc&echostr=hello',
      );

      expect(resp.status).toBe(403);
      expect(resp.body).toBe('invalid signature');

      await channel.disconnect();
    });

    it('skips signature verification when callbackToken is empty', async () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        WECOM_CORP_ID: 'corp123',
        WECOM_CORP_SECRET: 'secret456',
        WECOM_AGENT_ID: '1000001',
        WECOM_CALLBACK_TOKEN: '',
        WECOM_CALLBACK_PORT: '0',
      });

      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);

      // Any signature should pass when token is empty
      const resp = await sendCallbackRequest(
        port,
        'GET',
        '/?msg_signature=anything&timestamp=123&nonce=abc&echostr=hello',
      );

      expect(resp.status).toBe(200);
      expect(resp.body).toBe('hello');

      await channel.disconnect();
    });
  });

  // --- HTTP callback server ---

  describe('HTTP callback server', () => {
    it('rejects unsupported HTTP methods with 405', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);

      const resp = await sendCallbackRequest(port, 'PUT', '/');

      expect(resp.status).toBe(405);
      expect(resp.body).toBe('method not allowed');

      await channel.disconnect();
    });

    it('prepends trigger pattern when message does not match', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      (channel as any).opts = opts;
      vi.mocked(opts.registeredGroups).mockReturnValue({
        'wecom:zhangsan@corp123': {
          name: 'Test User',
          folder: 'test-user',
          trigger: '@Jonesy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, name: 'Zhang San' }),
      });

      const xml = `<xml>
        <ToUserName><![CDATA[corp123]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[Hello there]]></Content>
        <MsgId>22222</MsgId>
      </xml>`;

      await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'wecom:zhangsan@corp123',
        expect.objectContaining({
          content: '@Jonesy Hello there',
        }),
      );

      await channel.disconnect();
    });

    it('does not double-prepend trigger when message already matches', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();
      const port = getServerPort(channel);
      const opts = createTestOpts();
      (channel as any).opts = opts;
      vi.mocked(opts.registeredGroups).mockReturnValue({
        'wecom:zhangsan@corp123': {
          name: 'Test User',
          folder: 'test-user',
          trigger: '@Jonesy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, name: 'Zhang San' }),
      });

      const xml = `<xml>
        <ToUserName><![CDATA[corp123]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1704067200</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[@Jonesy do something]]></Content>
        <MsgId>33333</MsgId>
      </xml>`;

      await sendCallbackRequest(port, 'POST', signedPostPath('callbacktoken789', xml), xml);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'wecom:zhangsan@corp123',
        expect.objectContaining({
          content: '@Jonesy do something',
        }),
      );

      await channel.disconnect();
    });
  });

  // --- syncGroups ---

  describe('syncGroups', () => {
    it('fetches users and updates chat names', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      // Mock the user list API
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          userlist: [
            { userid: 'zhangsan', name: 'Zhang San' },
            { userid: 'lisi', name: 'Li Si' },
          ],
        }),
      });

      await channel.syncGroups();

      expect(updateChatName).toHaveBeenCalledWith('wecom:zhangsan@corp123', 'Zhang San');
      expect(updateChatName).toHaveBeenCalledWith('wecom:lisi@corp123', 'Li Si');

      await channel.disconnect();
    });

    it('handles API errors gracefully', async () => {
      const channel = new WeComChannel(createTestOpts());
      mockAccessTokenSuccess();
      await channel.connect();

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(channel.syncGroups()).resolves.toBeUndefined();

      await channel.disconnect();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const channel = new WeComChannel(createTestOpts());

      await expect(
        channel.setTyping('wecom:zhangsan@corp123', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const channel = new WeComChannel(createTestOpts());

      await expect(
        channel.setTyping('wecom:zhangsan@corp123', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "wecom"', () => {
      const channel = new WeComChannel(createTestOpts());
      expect(channel.name).toBe('wecom');
    });
  });
});
