import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// WeCom API limits text messages to 2048 bytes.
const MAX_MESSAGE_LENGTH = 2000;

// Access token expires in 7200s; refresh 5 min before expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface WeComAccessToken {
  token: string;
  expiresAt: number;
}

export interface WeComChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WeComChannel implements Channel {
  name = 'wecom';

  private corpId: string;
  private corpSecret: string;
  private agentId: string;
  private callbackToken: string;
  private callbackPort: number;

  private accessToken: WeComAccessToken | null = null;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private server: ReturnType<typeof createServer> | null = null;

  private opts: WeComChannelOpts;

  constructor(opts: WeComChannelOpts) {
    this.opts = opts;

    const env = readEnvFile([
      'WECOM_CORP_ID',
      'WECOM_CORP_SECRET',
      'WECOM_AGENT_ID',
      'WECOM_CALLBACK_TOKEN',
      'WECOM_CALLBACK_PORT',
    ]);

    this.corpId = env.WECOM_CORP_ID || '';
    this.corpSecret = env.WECOM_CORP_SECRET || '';
    this.agentId = env.WECOM_AGENT_ID || '';
    this.callbackToken = env.WECOM_CALLBACK_TOKEN || '';
    this.callbackPort = parseInt(env.WECOM_CALLBACK_PORT || '9880', 10);

    if (!this.corpId || !this.corpSecret || !this.agentId) {
      throw new Error(
        'WECOM_CORP_ID, WECOM_CORP_SECRET, and WECOM_AGENT_ID must be set in .env',
      );
    }
  }

  async connect(): Promise<void> {
    // Fetch initial access token
    await this.refreshAccessToken();

    // Start HTTP callback server for receiving messages
    await this.startCallbackServer();

    this.connected = true;
    logger.info({ corpId: this.corpId, agentId: this.agentId }, 'Connected to WeCom');

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'WeCom disconnected, message queued',
      );
      return;
    }

    try {
      const token = await this.getAccessToken();
      const { userId, chatId } = this.parseJid(jid);

      const chunks = this.splitByBytes(text, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.sendWeComMessage(token, userId, chatId, chunk);
      }
      logger.info({ jid, length: text.length, chunks: chunks.length }, 'WeCom message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send WeCom message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wecom:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // WeCom does not support typing indicators
  }

  async syncGroups(): Promise<void> {
    try {
      logger.info('Syncing department/user metadata from WeCom...');
      const token = await this.getAccessToken();

      // Fetch top-level department users
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/simplelist?access_token=${token}&department_id=1&fetch_child=1`,
      );
      const data = (await resp.json()) as {
        errcode: number;
        userlist?: Array<{ userid: string; name: string }>;
      };

      if (data.errcode === 0 && data.userlist) {
        for (const user of data.userlist) {
          this.userNameCache.set(user.userid, user.name);
          updateChatName(`wecom:${user.userid}@${this.corpId}`, user.name);
        }
        logger.info({ count: data.userlist.length }, 'WeCom user metadata synced');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to sync WeCom metadata');
    }
  }

  // --- Private helpers ---

  private parseJid(jid: string): { userId: string | null; chatId: string | null } {
    // Format: wecom:userid@corpid or wecom:chatid@corpid
    const stripped = jid.replace(/^wecom:/, '');
    const [id] = stripped.split('@');
    // Simple heuristic: group chat IDs are longer/prefixed
    if (id && id.length > 32) {
      return { userId: null, chatId: id };
    }
    return { userId: id || null, chatId: null };
  }

  private async sendWeComMessage(
    token: string,
    userId: string | null,
    chatId: string | null,
    text: string,
  ): Promise<void> {
    if (chatId) {
      // Group chat (appchat)
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatid: chatId,
            msgtype: 'text',
            text: { content: text },
          }),
        },
      );
      const result = (await resp.json()) as { errcode: number; errmsg: string };
      if (result.errcode !== 0) {
        throw new Error(`WeCom appchat/send failed: ${result.errmsg}`);
      }
    } else if (userId) {
      // Direct message
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: userId,
            msgtype: 'text',
            agentid: parseInt(this.agentId, 10),
            text: { content: text },
          }),
        },
      );
      const result = (await resp.json()) as { errcode: number; errmsg: string };
      if (result.errcode !== 0) {
        throw new Error(`WeCom message/send failed: ${result.errmsg}`);
      }
    }
  }

  private async getAccessToken(): Promise<string> {
    if (
      this.accessToken &&
      Date.now() < this.accessToken.expiresAt - TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.accessToken.token;
    }
    return this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<string> {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.corpSecret}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as {
      errcode: number;
      errmsg: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(
        `Failed to get WeCom access token: ${data.errmsg} (code: ${data.errcode})`,
      );
    }

    this.accessToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };

    logger.info('WeCom access token refreshed');
    return this.accessToken.token;
  }

  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleCallback(req, res).catch((err) => {
          logger.error({ err }, 'WeCom callback handler error');
          res.writeHead(500);
          res.end('error');
        });
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'WeCom callback server error');
        reject(err);
      });

      this.server.listen(this.callbackPort, () => {
        logger.info(
          { port: this.callbackPort },
          'WeCom callback server started',
        );
        resolve();
      });
    });
  }

  private async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.callbackPort}`);

    // WeCom URL verification (GET request)
    if (req.method === 'GET') {
      const msgSignature = url.searchParams.get('msg_signature') || '';
      const timestamp = url.searchParams.get('timestamp') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const echostr = url.searchParams.get('echostr') || '';

      if (this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
        // For simplicity, return echostr directly.
        // In production with EncodingAESKey, this should be decrypted first.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(echostr);
      } else {
        res.writeHead(403);
        res.end('invalid signature');
      }
      return;
    }

    // Message callback (POST request)
    if (req.method === 'POST') {
      // Verify signature on POST if callback token is configured
      const msgSignature = url.searchParams.get('msg_signature') || '';
      const sigTimestamp = url.searchParams.get('timestamp') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const body = await this.readBody(req);

      if (this.callbackToken && !this.verifyPostSignature(msgSignature, sigTimestamp, nonce, body)) {
        res.writeHead(403);
        res.end('invalid signature');
        return;
      }

      const message = this.parseXmlMessage(body);

      if (!message) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('success');
        return;
      }

      const fromUser = message.FromUserName || '';
      const content = message.Content || '';
      const msgId = message.MsgId || String(Date.now());
      const createTime = message.CreateTime || '';

      const jid = `wecom:${fromUser}@${this.corpId}`;
      const timestamp = createTime
        ? new Date(parseInt(createTime, 10) * 1000).toISOString()
        : new Date().toISOString();

      // Report metadata for discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'wecom', false);

      // Only process registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('success');
        return;
      }

      // Translate @mentions to trigger format
      let processedContent = content;
      if (!TRIGGER_PATTERN.test(processedContent)) {
        // If message doesn't already match trigger, check if it's directed at the bot
        processedContent = `@${ASSISTANT_NAME} ${processedContent}`;
      }

      const senderName =
        this.userNameCache.get(fromUser) ||
        (await this.resolveUserName(fromUser)) ||
        fromUser;

      this.opts.onMessage(jid, {
        id: msgId,
        chat_jid: jid,
        sender: fromUser,
        sender_name: senderName,
        content: processedContent,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');
      return;
    }

    res.writeHead(405);
    res.end('method not allowed');
  }

  private verifySignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): boolean {
    if (!this.callbackToken) return true; // Skip verification if no token configured

    const parts = [this.callbackToken, timestamp, nonce, echostr].sort();
    const hash = createHash('sha1').update(parts.join('')).digest('hex');
    return hash === msgSignature;
  }

  private verifyPostSignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    body: string,
  ): boolean {
    // For POST callbacks, WeCom signs with [token, timestamp, nonce, encrypt_msg]
    // In plaintext mode, use the raw body XML as the encrypt_msg component
    const parts = [this.callbackToken, timestamp, nonce, body].sort();
    const hash = createHash('sha1').update(parts.join('')).digest('hex');
    return hash === msgSignature;
  }

  private parseXmlMessage(
    xml: string,
  ): Record<string, string> | null {
    // Simple XML parser for WeCom callback messages.
    // WeCom sends XML like: <xml><ToUserName>...</ToUserName>...</xml>
    const result: Record<string, string> = {};
    const tagPattern = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g;
    let match: RegExpExecArray | null;

    while ((match = tagPattern.exec(xml)) !== null) {
      const key = match[1] || match[3];
      const value = match[2] ?? match[4];
      if (key && value !== undefined) {
        result[key] = value;
      }
    }

    // Only process text messages
    if (result.MsgType !== 'text') return null;

    return Object.keys(result).length > 0 ? result : null;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private async resolveUserName(
    userId: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${userId}`,
      );
      const data = (await resp.json()) as { errcode: number; name?: string };
      if (data.errcode === 0 && data.name) {
        this.userNameCache.set(userId, data.name);
        return data.name;
      }
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve WeCom user name');
    }
    return undefined;
  }

  /**
   * Split text into chunks that fit within a byte limit.
   * WeCom limits text messages to 2048 bytes; we use 2000 for safety margin.
   */
  private splitByBytes(text: string, maxBytes: number): string[] {
    if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return [text];

    const chunks: string[] = [];
    let current = '';
    for (const char of text) {
      const next = current + char;
      if (Buffer.byteLength(next, 'utf-8') > maxBytes) {
        chunks.push(current);
        current = char;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    const MAX_FLUSH_RETRIES = 3;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing WeCom outgoing queue',
      );
      let failures = 0;
      while (this.outgoingQueue.length > 0 && failures < MAX_FLUSH_RETRIES) {
        const item = this.outgoingQueue[0]!;
        try {
          const token = await this.getAccessToken();
          const { userId, chatId } = this.parseJid(item.jid);
          const chunks = this.splitByBytes(item.text, MAX_MESSAGE_LENGTH);
          for (const chunk of chunks) {
            await this.sendWeComMessage(token, userId, chatId, chunk);
          }
          this.outgoingQueue.shift(); // Remove on success
          failures = 0;
        } catch (err) {
          failures++;
          logger.warn(
            { jid: item.jid, failures, err },
            'WeCom flush: send failed, will retry',
          );
        }
      }
      if (failures >= MAX_FLUSH_RETRIES) {
        logger.error(
          { remaining: this.outgoingQueue.length },
          'WeCom flush: gave up after max retries, messages remain queued',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('wecom', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'WECOM_CORP_ID',
    'WECOM_CORP_SECRET',
    'WECOM_AGENT_ID',
  ]);
  if (!env.WECOM_CORP_ID || !env.WECOM_CORP_SECRET || !env.WECOM_AGENT_ID) {
    logger.warn('WeCom: WECOM_CORP_ID, WECOM_CORP_SECRET, or WECOM_AGENT_ID not set');
    return null;
  }
  return new WeComChannel(opts);
});
