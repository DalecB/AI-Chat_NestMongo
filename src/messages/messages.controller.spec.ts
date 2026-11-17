import { Types } from "mongoose";

import { UserDocument } from "../users/schemas/user.schema";
import { ChatOrchestratorService } from "./chat-orchestrator.service";
import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";
import { SessionsService } from "../sessions/sessions.service";

describe("MessagesController.create (SSE)", () => {
  it("응답 소켓이 닫히면 generator를 중단한다 (LLM 스트림·락 정리는 generator finally가 맡음)", async () => {
    const state = { yielded: 0, finished: false };
    const orchestrator = {
      async *streamMessage() {
        try {
          for (let i = 0; i < 100; i += 1) {
            state.yielded += 1;
            yield { event: "chunk", data: { content: `c${i}` } };
          }
        } finally {
          state.finished = true;
        }
      },
    };
    const response = {
      destroyed: false,
      writes: 0,
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write() {
        this.writes += 1;
        // 첫 이벤트를 쓴 뒤 클라이언트가 끊긴 상황
        this.destroyed = true;
        return true;
      },
      end: jest.fn(),
    };
    const controller = new MessagesController(
      {} as MessagesService,
      {} as SessionsService,
      orchestrator as unknown as ChatOrchestratorService,
    );

    await controller.create(
      { _id: new Types.ObjectId() } as UserDocument,
      new Types.ObjectId().toString(),
      { content: "hi" },
      response as never,
    );

    expect(state.finished).toBe(true);
    expect(state.yielded).toBeLessThanOrEqual(2);
  });
});
