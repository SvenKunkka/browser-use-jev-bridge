/**
 * Field-value generation.
 *
 * A separate, small, OpenAI-compatible model writes the text for TYPE_TEXT and
 * nothing else. It never chooses an operation, never sees the action space and
 * never receives a secret. Port of `field_context()` / `field_text()` in
 * jev_ultrafast/model.py (MIT).
 *
 * Two hard rules enforced here rather than in the prompt:
 *  - if no text model is configured, TYPE_TEXT fails loudly; the executor never
 *    invents, guesses or hardcodes a field value;
 *  - a credential-like field never reaches this model at all (the caller routes
 *    those to named secret injection, and the snapshot never exposes
 *    input[type=password] in the first place).
 */

import type { ActionRecord, JevRawAction, JevSnapshot } from '../types.js';
import { RunAbortedError } from '../errors.js';
import { TEXT_VALUE } from './questions.js';

export interface FieldContext {
  goal: string;
  field: { label?: string; role?: string; value?: string };
  page: { title: string; text: string };
  recent_actions: { action: string; text: string | null }[];
}

export interface TextModelResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: Record<string, unknown>;
}

export interface TextModelClient {
  readonly description: string;
  readonly model: string;
  complete(context: FieldContext, signal?: AbortSignal): Promise<TextModelResult>;
}

export class TextHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextHelperUnavailableError';
  }
}

export function fieldContext(
  goal: string,
  action: JevRawAction,
  page: JevSnapshot,
  history: ActionRecord[],
): FieldContext {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((record) => ({
      action: record.label,
      text: record.textSummary ?? null,
    })),
  };
}

export class HttpTextModelClient implements TextModelClient {
  readonly description: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly reasoning: 'none' | 'low' | 'provider-default' = 'provider-default',
    private readonly timeoutMs = 25_000,
  ) {
    this.description = `text model ${model} @ ${baseUrl}`;
  }

  private reasoningBody(): Record<string, unknown> {
    if (this.reasoning === 'none') return { reasoning: { enabled: false } };
    if (this.baseUrl.includes('api.deepseek.com')) return { thinking: { type: 'disabled' } };
    return { reasoning: { effort: 'low' } };
  }

  async complete(context: FieldContext, signal?: AbortSignal): Promise<TextModelResult> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        signal: composite,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          response_format: { type: 'json_object' },
          ...this.reasoningBody(),
          messages: [
            { role: 'system', content: TEXT_VALUE },
            { role: 'user', content: JSON.stringify(context) },
          ],
        }),
      });
    } catch (error) {
      if (signal?.aborted || composite.aborted) {
        throw new RunAbortedError('The run was aborted during a text-model request.');
      }
      if (error instanceof RunAbortedError) throw error;
      throw new TextHelperUnavailableError('Text model connection failed; nothing typed.');
    }
    if (!response.ok) {
      throw new TextHelperUnavailableError(`Text model returned HTTP ${response.status}; nothing typed.`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, unknown>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const value = parseFieldValue(content);
    const result: TextModelResult = { text: value, model: this.model, latencyMs: Date.now() - started };
    if (payload.usage !== undefined) result.usage = payload.usage;
    return result;
  }
}

/** Strict: exactly {"text": "<non-empty string ≤ 2000 chars>"}. */
export function parseFieldValue(content: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(content));
  } catch {
    throw new TextHelperUnavailableError('Text helper returned no valid field value; nothing typed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TextHelperUnavailableError('Text helper returned no valid field value; nothing typed.');
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  const value = (parsed as Record<string, unknown>)['text'];
  if (keys.length !== 1 || keys[0] !== 'text' || typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new TextHelperUnavailableError('Text helper returned no valid field value; nothing typed.');
  }
  return value;
}

/** Used when TYPE_TEXT is reachable but no text model is configured. */
export class MissingTextModelClient implements TextModelClient {
  readonly description = 'no text model configured';
  readonly model = 'none';
  async complete(): Promise<TextModelResult> {
    throw new TextHelperUnavailableError(
      'TYPE_TEXT needs TEXT_MODEL_API_KEY; no text is hardcoded or guessed by the executor.',
    );
  }
}
