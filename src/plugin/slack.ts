/**
 * Minimal Slack poster for the threaded digest and operator announcements.
 *
 * Plugin-internal, like `escalate()` — but unlike escalation this one IS
 * reachable from a tool, so the boundary needs stating precisely:
 *
 *   The destination is NEVER a parameter. It is resolved from the tenant map
 *   via the host-trusted `ctx.agentId`, exactly like the tenant id. The model
 *   chooses the text, never the channel.
 *
 * That keeps the real property intact. The concern is *cross-channel*
 * messaging — an agent speaking somewhere other than its bound channel.
 * Posting to the agent's own channel grants nothing new, because the agent's
 * ordinary reply already goes there.
 *
 * Uses `chat.postMessage` rather than an incoming webhook because a webhook
 * cannot thread: threading needs the parent's `ts`, which only the Web API
 * returns.
 */

export interface SlackPostResult {
  readonly ok: boolean;
  /** Message timestamp — the handle a threaded reply is posted against. */
  readonly ts?: string;
  readonly error?: string;
}

export interface SlackPosterOptions {
  readonly botToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SlackPoster {
  post(channel: string, text: string, threadTs?: string): Promise<SlackPostResult>;
  /**
   * Whether a channel is private.
   *
   * Used to authorise announcements: membership of the ops channel is what
   * grants the ability to broadcast, and that is only meaningful if the
   * channel cannot be self-joined. Returns undefined when Slack could not be
   * asked, so the caller can fail closed rather than guess.
   */
  isPrivateChannel(channel: string): Promise<boolean | undefined>;
}

export class WebApiSlackPoster implements SlackPoster {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: SlackPosterOptions) {
    if (options.botToken === "") throw new Error("slack bot token is required");
    this.#token = options.botToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async isPrivateChannel(channel: string): Promise<boolean | undefined> {
    try {
      const response = await this.#fetch(
        `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channel)}`,
        {
          headers: { Authorization: `Bearer ${this.#token}` },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        channel?: { is_private?: boolean };
      };
      if (body.ok !== true) return undefined;
      return body.channel?.is_private === true;
    } catch {
      return undefined;
    }
  }

  async post(channel: string, text: string, threadTs?: string): Promise<SlackPostResult> {
    try {
      const response = await this.#fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify({
          channel,
          text,
          // Never let Slack expand links in a customer channel unprompted.
          unfurl_links: false,
          unfurl_media: false,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      // Slack returns HTTP 200 with {ok:false, error:"..."} for API errors, so
      // the status alone tells you nothing.
      const body = (await response.json()) as {
        ok?: boolean;
        ts?: string;
        error?: string;
      };
      if (body.ok !== true) {
        return { ok: false, error: body.error ?? `http ${String(response.status)}` };
      }
      return { ok: true, ...(body.ts === undefined ? {} : { ts: body.ts }) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Records posts in memory. Used by tests and the local Gateway. */
export class RecordingSlackPoster implements SlackPoster {
  readonly posts: { channel: string; text: string; threadTs?: string }[] = [];
  /** Tests set this to model a public channel, or undefined for an API failure. */
  privateChannels: boolean | undefined = true;
  #next = 1;

  isPrivateChannel(): Promise<boolean | undefined> {
    return Promise.resolve(this.privateChannels);
  }

  post(channel: string, text: string, threadTs?: string): Promise<SlackPostResult> {
    this.posts.push({ channel, text, ...(threadTs === undefined ? {} : { threadTs }) });
    return Promise.resolve({ ok: true, ts: `1700000000.00000${String(this.#next++)}` });
  }
}
