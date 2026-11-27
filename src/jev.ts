import * as Evaluator from '@smthrs/model/Evaluator';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import { Effect, Layer, Redacted } from 'effect';

export type JevQuestion = Evaluator.Question;

export type JevAskInput = {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
};

export type JevAskResult = {
  answers: Record<string, unknown>;
  confidence?: Record<string, number>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    modelId?: string;
    costUsd?: number;
  };
  latencyMs: number;
};

export type JevConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  script?: Evaluator.Script;
};

/**
 * Smithers Jev client wrapping `@smthrs/model/Evaluator` + `@smthrs/model/Classifier`.
 * Supports Vercel AI Gateway (typesafe-ai/jev) in production and scripted evaluators in tests.
 */
export class JevClient {
  private layer: Layer.Layer<Evaluator.Evaluator>;
  private configured: boolean;
  private model: string;

  constructor(config: JevConfig = {}) {
    this.model = config.model ?? process.env.DUB_JEV_MODEL ?? Evaluator.defaultModel;
    if (config.script) {
      this.layer = Evaluator.layerScripted(config.script);
      this.configured = true;
      return;
    }
    const apiKey =
      config.apiKey ??
      process.env.DUB_JEV_API_KEY ??
      process.env.AI_GATEWAY_API_KEY ??
      process.env.VERCEL_AI_GATEWAY_API_KEY;
    if (apiKey) {
      const gatewayLayer = Evaluator.layerVercelGateway({
        apiKey: Redacted.make(apiKey),
        model: this.model,
        ...(config.baseUrl ?? process.env.DUB_JEV_BASE_URL ? { baseUrl: config.baseUrl ?? process.env.DUB_JEV_BASE_URL } : {}),
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      });
      this.layer = Layer.provide(gatewayLayer, FetchHttpClient.layer);
      this.configured = true;
    } else {
      this.layer = Evaluator.layerUnavailable();
      this.configured = false;
    }
  }

  get isConfigured() {
    return this.configured;
  }

  get modelId() {
    return this.model;
  }

  configure(config: JevConfig) {
    const next = new JevClient(config);
    this.layer = next.layer;
    this.configured = next.configured;
    this.model = next.model;
  }

  async ask(input: JevAskInput): Promise<JevAskResult> {
    if (!input.questions || Object.keys(input.questions).length === 0) {
      throw new Error('jev.ask requires at least one question');
    }
    // Prefix each question instruction with its id, matching Smithers StandardFlows.jev (#3992).
    const namedQuestions: Record<string, Evaluator.Question> = Object.fromEntries(
      Object.entries(input.questions).map(([id, q]) => [
        id,
        { ...q, instructions: `${id}: ${q.instructions}` },
      ])
    );

    const program = Effect.gen(function* () {
      const evaluator = yield* Evaluator.Evaluator;
      const response = yield* evaluator.evaluate({
        state: input.state,
        questions: namedQuestions,
      });
      const answers: Record<string, unknown> = {};
      const probabilities: Record<string, number> = {};
      for (const [id, raw] of Object.entries(response.answers)) {
        if (raw.type === 'boolean') {
          answers[id] = raw.probability >= 0.5;
          probabilities[id] = raw.probability;
        } else if (raw.type === 'choice') {
          answers[id] = raw.choice;
        } else if (raw.type === 'score') {
          answers[id] = raw.score;
        }
      }
      return {
        answers,
        confidence: response.confidence ?? (Object.keys(probabilities).length > 0 ? probabilities : undefined),
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
        latencyMs: response.latencyMs,
      };
    }).pipe(Effect.provide(this.layer));

    return Effect.runPromise(program);
  }
}
