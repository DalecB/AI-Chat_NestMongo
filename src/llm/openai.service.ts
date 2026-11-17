import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import { ChatCompletionChunk } from "openai/resources/chat/completions";

import {
  appendDataBoundaryRule,
  appendSessionSummary,
  appendUserMemories,
} from "./prompt-harness";

// 세션 락 TTL(60s, SessionLockService) 안에 응답 스트림과 요약이 모두 끝나도록 잡은 예산.
// 35s + 20s + DB 왕복 < 60s. 재시도(maxRetries)는 예산을 깨므로 0이다.
const CHAT_STREAM_DEADLINE_MS = 35_000;
const SUMMARY_DEADLINE_MS = 20_000;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  userMemories?: string[];
  sessionSummary?: string | null;
}

@Injectable()
export class OpenAiService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly presencePenalty: number;
  private readonly frequencyPenalty: number;
  private readonly maxCompletionTokens: number;
  private readonly summaryMaxCompletionTokens: number;

  constructor(configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: configService.getOrThrow<string>("OPENAI_API_KEY"),
      maxRetries: 0,
    });
    this.model = configService.get<string>("OPENAI_MODEL", "gpt-4.1-mini");
    // temperature(0~2): 다음 토큰 선택의 무작위성. 낮을수록 안정적/반복적, 높을수록 표현이 다양하고 예측 불가능해짐.
    this.temperature = this.readNumberConfig(
      configService,
      "OPENAI_TEMPERATURE",
      0.9,
    );
    // topP(0~1): 후보 토큰 누적 확률 컷. 낮을수록 안전한 후보만 사용, 높을수록 더 넓은 표현 후보를 허용.
    this.topP = this.readNumberConfig(configService, "OPENAI_TOP_P", 0.95);
    // presencePenalty(-2~2): 이미 나온 주제/표현에서 벗어나 새 내용을 꺼내도록 미는 값. 높을수록 화제 확장이 강해짐.
    this.presencePenalty = this.readNumberConfig(
      configService,
      "OPENAI_PRESENCE_PENALTY",
      0.35,
    );
    // frequencyPenalty(-2~2): 같은 단어/문장 패턴 반복을 줄이는 값. 높을수록 말버릇 반복은 줄지만 캐릭터 고유 말투도 약해질 수 있음.
    this.frequencyPenalty = this.readNumberConfig(
      configService,
      "OPENAI_FREQUENCY_PENALTY",
      0.25,
    );
    // 응답 1건의 비용 상한. 넘으면 응답이 잘린다.
    this.maxCompletionTokens = this.readNumberConfig(
      configService,
      "OPENAI_MAX_COMPLETION_TOKENS",
      1024,
    );
    this.summaryMaxCompletionTokens = this.readNumberConfig(
      configService,
      "OPENAI_SUMMARY_MAX_COMPLETION_TOKENS",
      1500,
    );
  }

  async generate(
    systemPrompt: string,
    messages: LlmMessage[],
    options: GenerateOptions = {},
  ) {
    const finalSystemPrompt = this.buildFinalSystemPrompt(
      systemPrompt,
      options,
    );

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      top_p: this.topP,
      presence_penalty: this.presencePenalty,
      frequency_penalty: this.frequencyPenalty,
      messages: [
        { role: "system", content: finalSystemPrompt },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    });

    return {
      content: response.choices[0]?.message.content ?? "",
      usage: response.usage,
    };
  }

  async generateStream(
    systemPrompt: string,
    messages: LlmMessage[],
    options: GenerateOptions = {},
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const finalSystemPrompt = this.buildFinalSystemPrompt(
      systemPrompt,
      options,
    );

    const signal = this.deadline(CHAT_STREAM_DEADLINE_MS);
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: this.temperature,
        top_p: this.topP,
        presence_penalty: this.presencePenalty,
        frequency_penalty: this.frequencyPenalty,
        max_completion_tokens: this.maxCompletionTokens,
        messages: [
          { role: "system", content: finalSystemPrompt },
          ...messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
        stream: true,
        // include_usage 없이는 streaming 응답에 token usage가 포함되지 않는다. 마지막 청크에 usage가 도착.
        stream_options: { include_usage: true },
      },
      { signal },
    );

    return this.throwIfAborted(stream, signal);
  }

  async generateSessionSummary(
    previousSummary: string | null,
    messages: LlmMessage[],
  ): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: 0.2,
        top_p: 1,
        max_completion_tokens: this.summaryMaxCompletionTokens,
        messages: [
          {
            role: "system",
            content: [
              "You maintain a compact state summary for an ongoing character chat session.",
              "Update the previous summary using the supplied messages.",
              "Return the summary in exactly this fixed shape:",
              "Location: ...",
              "What: ...",
              "Situation: ...",
              "Relationship: ...",
              "User Intent: ...",
              "Open Hooks: ...",
              "Constraints: ...",
              "Location must contain the current place. What must contain what the user and persona are currently doing. Situation must contain the current scene state.",
              "If the previous summary conflicts with the supplied messages, prefer the supplied messages, especially for Location, What, and Situation.",
              "If the location or situation changed in the supplied messages, overwrite the older state.",
              "Use 'none' only when a slot has no durable information.",
              "Do not store filler, raw dialogue, repeated greetings, jokes, or temporary wording unless it changed the session state.",
              "Return only the updated summary in Korean. Keep it under 1200 Korean characters.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              "Previous summary:",
              previousSummary || "(none)",
              "",
              "New completed messages:",
              ...messages.map(
                (message) =>
                  `${message.role.toUpperCase()}: ${message.content}`,
              ),
            ].join("\n"),
          },
        ],
      },
      { signal: this.deadline(SUMMARY_DEADLINE_MS) },
    );
    const choice = response.choices[0];

    // 잘린 요약을 저장하면 고정 슬롯 형식이 깨진다. throw하면 orchestrator가 이번 갱신을 건너뛴다.
    if (choice?.finish_reason === "length") {
      throw new Error("Session summary truncated by token limit");
    }

    return choice?.message.content?.trim() ?? "";
  }

  private buildFinalSystemPrompt(
    systemPrompt: string,
    options: GenerateOptions,
  ): string {
    const withMemories = appendUserMemories(
      systemPrompt,
      options.userMemories ?? [],
    );

    return appendDataBoundaryRule(
      appendSessionSummary(withMemories, options.sessionSummary),
    );
  }

  // AbortSignal.timeout 대신 setTimeout을 쓰는 건 테스트의 fake timer로 제어하기 위해서다.
  private deadline(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms).unref();
    return controller.signal;
  }

  // SDK는 abort된 스트림을 에러 없이 끝낸다. 그대로 두면 잘린 응답이 completed로 저장된다.
  private async *throwIfAborted(
    stream: AsyncIterable<ChatCompletionChunk>,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    yield* stream;

    if (signal.aborted) {
      throw new Error("LLM stream timed out");
    }
  }

  private readNumberConfig(
    configService: ConfigService,
    key: string,
    fallback: number,
  ): number {
    const value = configService.get<string>(key);

    if (value === undefined) {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
