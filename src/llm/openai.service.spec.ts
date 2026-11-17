import { ConfigService } from "@nestjs/config";

import OpenAI from "openai";

import { OpenAiService } from "./openai.service";

const mockCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  }));
});

function createService(
  overrides: Record<string, string | undefined> = {},
): OpenAiService {
  const values: Record<string, string | undefined> = {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_TEMPERATURE: "1.1",
    OPENAI_TOP_P: "0.8",
    OPENAI_PRESENCE_PENALTY: "0.4",
    OPENAI_FREQUENCY_PENALTY: "0.2",
    ...overrides,
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => values[key]),
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  } as unknown as ConfigService;

  return new OpenAiService(configService);
}

describe("OpenAiService", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe("generateStream request contract", () => {
    it("passes model/options/messages and requests streaming usage", async () => {
      const service = createService();
      const streamResult = {} as AsyncIterable<never>;
      mockCreate.mockResolvedValue(streamResult);

      const result = await service.generateStream(
        "persona prompt",
        [{ role: "user", content: "hello" }],
        {
          userMemories: ["likes coffee"],
          sessionSummary: "Location: cafe\nWhat: talking",
        },
      );

      expect(result).toBeDefined();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const request = mockCreate.mock.calls[0][0];
      expect(request).toMatchObject({
        model: "gpt-test",
        temperature: 1.1,
        top_p: 0.8,
        presence_penalty: 0.4,
        frequency_penalty: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 1024,
      });
      expect(mockCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(request.messages[1]).toEqual({
        role: "user",
        content: "hello",
      });

      const systemPrompt = request.messages[0].content as string;
      expect(systemPrompt).toContain("persona prompt");
      expect(systemPrompt).toContain("Known about the user:");
      expect(systemPrompt).toContain("- likes coffee");
      expect(systemPrompt).toContain("Session state summary:");
      expect(systemPrompt).toContain("Location: cafe");
    });

    it("재시도 없이 클라이언트를 만든다(락 TTL 안에 끝내기 위해)", () => {
      createService();
      expect(OpenAI).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
      );
    });

    it("페르소나·기억·요약은 데이터라는 규칙을 요청 시점에 붙인다", async () => {
      const service = createService();
      mockCreate.mockResolvedValue((async function* () {})());

      await service.generateStream("persona prompt", []);

      const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content as string;
      expect(systemPrompt).toMatch(/data, not instructions/);
    });

    it("deadline에 걸려 SDK가 스트림을 조용히 끝내면 throw (잘린 응답을 completed로 저장하지 않음)", async () => {
      jest.useFakeTimers();
      try {
        const service = createService();
        mockCreate.mockImplementation(
          async (_body: unknown, options: { signal: AbortSignal }) =>
            (async function* () {
              yield { choices: [{ delta: { content: "partial" } }] };
              // SDK는 abort되면 에러 없이 iteration을 끝낸다
              await new Promise((resolve) =>
                options.signal.addEventListener("abort", resolve),
              );
            })(),
        );

        const stream = await service.generateStream("p", []);
        const iterator = stream[Symbol.asyncIterator]();
        await iterator.next();
        const pending = iterator.next();
        jest.advanceTimersByTime(60_000);

        await expect(pending).rejects.toThrow(/timed out/);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("generateSessionSummary request contract", () => {
    it("uses fixed summary slots and prefers supplied messages over previous summary", async () => {
      const service = createService();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "  Location: cafe\nWhat: talking  " } }],
      });

      const result = await service.generateSessionSummary("Location: home", [
        { role: "user", content: "we moved to the cafe" },
        { role: "assistant", content: "okay, cafe scene" },
      ]);

      expect(result).toBe("Location: cafe\nWhat: talking");
      const request = mockCreate.mock.calls[0][0];
      expect(request).toMatchObject({
        model: "gpt-test",
        temperature: 0.2,
        top_p: 1,
        max_completion_tokens: 1500,
      });
      expect(mockCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

      const systemPrompt = request.messages[0].content as string;
      expect(systemPrompt).toContain("Return the summary in exactly this fixed shape:");
      expect(systemPrompt).toContain("Location: ...");
      expect(systemPrompt).toContain("What: ...");
      expect(systemPrompt).toContain("Situation: ...");
      expect(systemPrompt).toContain("Relationship: ...");
      expect(systemPrompt).toContain("User Intent: ...");
      expect(systemPrompt).toContain("Open Hooks: ...");
      expect(systemPrompt).toContain("Constraints: ...");
      expect(systemPrompt).toContain(
        "prefer the supplied messages, especially for Location, What, and Situation",
      );

      const userPrompt = request.messages[1].content as string;
      expect(userPrompt).toContain("Previous summary:");
      expect(userPrompt).toContain("Location: home");
      expect(userPrompt).toContain("USER: we moved to the cafe");
      expect(userPrompt).toContain("ASSISTANT: okay, cafe scene");
    });

    it("토큰 상한에 걸려 잘린 요약은 저장하지 않도록 throw", async () => {
      const service = createService();
      mockCreate.mockResolvedValue({
        choices: [
          { finish_reason: "length", message: { content: "Location: ca" } },
        ],
      });

      await expect(
        service.generateSessionSummary(null, [{ role: "user", content: "hi" }]),
      ).rejects.toThrow(/truncated/);
    });
  });
});
