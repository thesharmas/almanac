/**
 * Escalation to the error channel.
 *
 * Deliberately **not** a registered tool. Giving the model a general
 * send-message capability would undo the property that an agent only ever
 * speaks in its bound channel — so this is a plugin-internal function
 * reachable only from code paths the model cannot name. It cannot choose the
 * destination and cannot use it to say anything.
 *
 * One channel carries everything, so severity has to be scannable: categories
 * needing a human now are prefixed distinctly from the routine stream.
 */

export type EscalationReason =
  // Needs a human now.
  | "tool_failure"
  | "drift_alert"
  | "tenant_resolution_failure"
  | "missed_digest"
  | "health_check_failure"
  | "rate_anomaly"
  // Routine; reviewed periodically as catalog demand signal.
  | "out_of_scope"
  | "probing"
  /**
   * Routine audit trail: an operator announcement went out. Not a failure.
   *
   * This category exists because without it the success path reported itself
   * as `tool_failure`, so every working announcement raised a red alarm —
   * which both cried wolf and made real send failures unscannable.
   */
  | "announcement";

const URGENT: ReadonlySet<EscalationReason> = new Set([
  "tool_failure",
  "drift_alert",
  "tenant_resolution_failure",
  "missed_digest",
  "health_check_failure",
  "rate_anomaly",
]);

export interface Escalation {
  readonly reason: EscalationReason;
  /** Operator-facing detail. Never the text shown to a customer. */
  readonly detail: string;
  readonly agentId?: string | undefined;
  readonly tenant?: string | undefined;
  readonly channel?: string | undefined;
  readonly senderId?: string | undefined;
  readonly permalink?: string | undefined;
}

export interface Escalator {
  escalate(escalation: Escalation): Promise<void>;
}

export function isUrgent(reason: EscalationReason): boolean {
  return URGENT.has(reason);
}

/** Render for Slack. Urgent categories are visually distinct at a glance. */
export function formatEscalation(e: Escalation): string {
  const marker = isUrgent(e.reason) ? "🔴 *" : "· ";
  const suffix = isUrgent(e.reason) ? "*" : "";
  const fields = [
    e.agentId === undefined ? null : `agent: \`${e.agentId}\``,
    e.tenant === undefined ? null : `tenant: \`${e.tenant}\``,
    e.channel === undefined ? null : `channel: \`${e.channel}\``,
    e.senderId === undefined ? null : `sender: \`${e.senderId}\``,
    e.permalink === undefined ? null : e.permalink,
  ].filter((f): f is string => f !== null);

  return `${marker}${e.reason}${suffix}\n${e.detail}${fields.length > 0 ? `\n${fields.join(" · ")}` : ""}`;
}

export interface WebhookEscalatorOptions {
  readonly webhookUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Called when the webhook itself fails; escalation must never throw. */
  readonly onFailure?: (error: unknown, escalation: Escalation) => void;
}

/**
 * Posts to a Slack incoming webhook.
 *
 * Never throws. An escalation is already a failure path, and letting it throw
 * would replace a reported problem with an unreported one — the customer-facing
 * turn must still complete and say something honest.
 */
export class WebhookEscalator implements Escalator {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #onFailure: (error: unknown, escalation: Escalation) => void;

  constructor(options: WebhookEscalatorOptions) {
    if (options.webhookUrl === "") throw new Error("escalation webhook url is required");
    this.#url = options.webhookUrl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#onFailure = options.onFailure ?? (() => undefined);
  }

  async escalate(escalation: Escalation): Promise<void> {
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: formatEscalation(escalation) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        this.#onFailure(
          new Error(`webhook returned ${String(response.status)}`),
          escalation,
        );
      }
    } catch (error) {
      this.#onFailure(error, escalation);
    }
  }
}

/** Collects escalations in memory. Used by tests and the local Gateway. */
export class RecordingEscalator implements Escalator {
  readonly sent: Escalation[] = [];

  escalate(escalation: Escalation): Promise<void> {
    this.sent.push(escalation);
    return Promise.resolve();
  }
}
