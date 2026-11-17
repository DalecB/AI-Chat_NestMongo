import type {
  ChatCompletionChunk,
  ChatCompletion,
} from "openai/resources/chat/completions";

import type {
  GenerateOptions,
  LlmMessage,
} from "../../src/llm/openai.service";

export interface StreamCallCapture {
  systemPrompt: string;
  messages: LlmMessage[];
  options: GenerateOptions;
}

export interface SummaryCallCapture {
  previousSummary: string | null;
  messages: LlmMessage[];
}

export type StreamPlan =
  | {
      kind: "ok";
      chunks: string[];
      usage?: { prompt: number; completion: number; total: number };
      // 청크 사이 지연. 클라이언트 이탈처럼 스트림 도중 상황을 만들 때 쓴다.
      chunkDelayMs?: number;
    }
  | {
      kind: "throw";
      afterChunkIndex: number;
      error: Error;
    };

export interface OpenAiMock {
  readonly streamCalls: StreamCallCapture[];
  readonly summaryCalls: SummaryCallCapture[];
  readonly streamState: { closedEarly: number };
  setStreamPlan(plan: StreamPlan): void;
  setSummaryResponse(summary: string): void;
  setSummaryError(error: Error): void;
  generate(
    systemPrompt: string,
    messages: LlmMessage[],
    options?: GenerateOptions,
  ): Promise<{ content: string; usage: ChatCompletion["usage"] }>;
  generateStream(
    systemPrompt: string,
    messages: LlmMessage[],
    options?: GenerateOptions,
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
  generateSessionSummary(
    previousSummary: string | null,
    messages: LlmMessage[],
  ): Promise<string>;
  reset(): void;
}

export function createOpenAiMock(): OpenAiMock {
  let streamPlan: StreamPlan = { kind: "ok", chunks: ["hello"] };
  let summaryMode:
    | { kind: "ok"; summary: string }
    | { kind: "throw"; error: Error } = {
    kind: "ok",
    summary: "Location: none\nWhat: none\nSituation: none\nRelationship: none\nUser Intent: none\nOpen Hooks: none\nConstraints: none",
  };
  const streamCalls: StreamCallCapture[] = [];
  const summaryCalls: SummaryCallCapture[] = [];
  const streamState = { closedEarly: 0 };

  function makeChunk(content: string): ChatCompletionChunk {
    return {
      id: "chunk-id",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        } as ChatCompletionChunk.Choice,
      ],
    } as ChatCompletionChunk;
  }

  function makeUsageChunk(usage: {
    prompt: number;
    completion: number;
    total: number;
  }): ChatCompletionChunk {
    return {
      id: "chunk-usage",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        } as ChatCompletionChunk.Choice,
      ],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.total,
      },
    } as ChatCompletionChunk;
  }

  return {
    streamCalls,
    summaryCalls,
    streamState,
    setStreamPlan(plan) {
      streamPlan = plan;
    },
    setSummaryResponse(summary) {
      summaryMode = { kind: "ok", summary };
    },
    setSummaryError(error) {
      summaryMode = { kind: "throw", error };
    },
    reset() {
      streamCalls.length = 0;
      summaryCalls.length = 0;
      streamState.closedEarly = 0;
      streamPlan = { kind: "ok", chunks: ["hello"] };
      summaryMode = {
        kind: "ok",
        summary:
          "Location: none\nWhat: none\nSituation: none\nRelationship: none\nUser Intent: none\nOpen Hooks: none\nConstraints: none",
      };
    },

    async generate(systemPrompt, messages, options = {}) {
      streamCalls.push({ systemPrompt, messages, options });
      const fullContent =
        streamPlan.kind === "ok" ? streamPlan.chunks.join("") : "";
      return {
        content: fullContent,
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        } as ChatCompletion["usage"],
      };
    },

    async generateStream(systemPrompt, messages, options = {}) {
      streamCalls.push({ systemPrompt, messages, options });
      const plan = streamPlan;

      async function* iter(): AsyncIterable<ChatCompletionChunk> {
        if (plan.kind === "throw") {
          for (let i = 0; i < plan.afterChunkIndex; i += 1) {
            yield makeChunk("x");
          }
          throw plan.error;
        }

        let finished = false;
        try {
          for (const content of plan.chunks) {
            if (plan.chunkDelayMs) {
              await new Promise((resolve) =>
                setTimeout(resolve, plan.chunkDelayMs),
              );
            }
            yield makeChunk(content);
          }

          if (plan.usage) {
            yield makeUsageChunk(plan.usage);
          }
          finished = true;
        } finally {
          // 실제 SDK는 소비자가 중간에 끊으면(return) HTTP 요청을 abort한다.
          if (!finished) {
            streamState.closedEarly += 1;
          }
        }
      }

      return iter();
    },

    async generateSessionSummary(previousSummary, messages) {
      summaryCalls.push({ previousSummary, messages });

      if (summaryMode.kind === "throw") {
        throw summaryMode.error;
      }

      return summaryMode.summary;
    },
  };
}
