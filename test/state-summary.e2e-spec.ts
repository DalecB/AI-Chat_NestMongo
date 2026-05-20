import {
  CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT,
  CHAT_SUMMARY_MESSAGE_LIMIT,
  CHAT_SUMMARY_TRIGGER_INTERVAL,
} from "../src/common/chat-context";
import {
  closeE2eApp,
  createE2eApp,
  createPersona,
  createSession,
  E2eContext,
  postMessageAndCollectSse,
  registerAndLogin,
  RegisteredUser,
  resetDataBetweenTests,
} from "./utils/test-app";

describe("State summary (e2e)", () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  }, 120000);

  afterAll(async () => {
    await closeE2eApp(ctx);
  });

  beforeEach(async () => {
    await resetDataBetweenTests(ctx);
  });

  async function sendTurn(user: RegisteredUser, sessionId: string, content: string) {
    ctx.openAiMock.setStreamPlan({
      kind: "ok",
      chunks: ["reply"],
      usage: { prompt: 1, completion: 1, total: 2 },
    });
    return postMessageAndCollectSse(ctx, user, sessionId, content);
  }

  describe(`트리거 조건 (CHAT_SUMMARY_TRIGGER_INTERVAL=${CHAT_SUMMARY_TRIGGER_INTERVAL})`, () => {
    it("완료 메시지가 triggerInterval 미만이면 generateSessionSummary 호출 안 됨", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      // greeting(1) + user(1) + assistant(1) = 3 completed
      await sendTurn(user, sessionId, "msg1");

      expect(ctx.openAiMock.summaryCalls.length).toBe(0);
    });

    it("완료 메시지가 triggerInterval에 도달하는 턴에 summary 호출 발생", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      // greeting(1) → turn1: user+assistant (총 3) → turn2: 5 → turn3: 7 → 트리거(>=6) at turn3
      await sendTurn(user, sessionId, "msg1");
      expect(ctx.openAiMock.summaryCalls.length).toBe(0);
      await sendTurn(user, sessionId, "msg2");
      // 메시지 5건 → 아직 미달
      expect(ctx.openAiMock.summaryCalls.length).toBe(0);
      await sendTurn(user, sessionId, "msg3");
      // greeting부터 7개 completed → 트리거
      expect(ctx.openAiMock.summaryCalls.length).toBe(1);
    });
  });

  describe("summary 저장", () => {
    it("summary 성공 시 Session.stateSummary가 다음 메시지의 generateStream 인자에 포함", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setSummaryResponse("Location: cafe\nWhat: chat");
      for (let i = 0; i < 3; i += 1) {
        await sendTurn(user, sessionId, `msg-${i}`);
      }
      // 트리거 발생 후 다음 turn에서 stateSummary가 system prompt에 포함되었는지 확인
      ctx.openAiMock.streamCalls.length = 0;
      await sendTurn(user, sessionId, "after-summary");

      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(call?.options.sessionSummary).toMatch(/Location: cafe/);
    });

    it("첫 요약은 previousSummary=null, 이후 요약은 기존 summary 전달", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      // 첫 요약 발생
      ctx.openAiMock.setSummaryResponse("first summary");
      for (let i = 0; i < 3; i += 1) {
        await sendTurn(user, sessionId, `t1-${i}`);
      }
      expect(ctx.openAiMock.summaryCalls[0].previousSummary).toBeNull();

      // 두 번째 요약 trigger를 채우기 위해 추가 턴
      ctx.openAiMock.setSummaryResponse("second summary");
      for (let i = 0; i < 3; i += 1) {
        await sendTurn(user, sessionId, `t2-${i}`);
      }
      expect(ctx.openAiMock.summaryCalls.length).toBeGreaterThanOrEqual(2);
      expect(ctx.openAiMock.summaryCalls[1].previousSummary).toBe("first summary");
    });

    it("첫 요약은 initial limit, 이후 요약은 최신 message limit 후보를 전달", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, {
        greetingMessage: "greeting",
      });
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setSummaryResponse("first summary");
      for (let i = 0; i < 3; i += 1) {
        await sendTurn(user, sessionId, `t1-${i}`);
      }

      const firstSummaryMessages = ctx.openAiMock.summaryCalls[0].messages;
      expect(firstSummaryMessages.length).toBe(
        CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT,
      );
      expect(firstSummaryMessages.map((m) => m.content)).toContain("greeting");
      expect(firstSummaryMessages.map((m) => m.content)).toContain("t1-0");

      ctx.openAiMock.setSummaryResponse("second summary");
      for (let i = 0; i < 3; i += 1) {
        await sendTurn(user, sessionId, `t2-${i}`);
      }

      const secondSummaryMessages = ctx.openAiMock.summaryCalls[1].messages;
      const secondContents = secondSummaryMessages.map((m) => m.content);
      expect(secondSummaryMessages.length).toBe(CHAT_SUMMARY_MESSAGE_LIMIT);
      expect(secondContents).toContain("t2-2");
      expect(secondContents).not.toContain("greeting");
      expect(secondContents).not.toContain("t1-0");
    });
  });

  describe("실패 격리 (ADR-10 trade-off)", () => {
    it("generateSessionSummary throw 해도 채팅 SSE는 done까지 정상 완료", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setSummaryError(new Error("summary down"));
      let lastDone = false;
      for (let i = 0; i < 3; i += 1) {
        const result = await sendTurn(user, sessionId, `m${i}`);
        lastDone = result.events.map((e) => e.event).includes("done");
      }
      expect(lastDone).toBe(true);

      // 다음 턴에서 stateSummary 갱신 안 됨
      ctx.openAiMock.streamCalls.length = 0;
      await sendTurn(user, sessionId, "after-fail");
      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(
        call?.options.sessionSummary === null ||
          call?.options.sessionSummary === undefined,
      ).toBe(true);
    });
  });

  describe("프롬프트 주입. sessionSummary=null 케이스", () => {
    it("stateSummary가 set되기 전에는 generateStream 호출 인자의 sessionSummary가 null/undefined", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      await sendTurn(user, sessionId, "single");
      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(
        call?.options.sessionSummary === null ||
          call?.options.sessionSummary === undefined,
      ).toBe(true);
    });
  });
});
