import mongoose, { Types } from "mongoose";

import {
  InMemoryMongo,
  startInMemoryMongo,
  stopInMemoryMongo,
} from "../../../test/utils/in-memory-mongo";
import { Message, MessageSchema } from "../../messages/schemas/message.schema";
import { Session, SessionSchema } from "../../sessions/schemas/session.schema";

// 커서 페이지네이션 쿼리가 인덱스 순서만으로 정렬되는지 확인한다.
// winning plan에 SORT 단계가 있으면 매 요청마다 세션/메시지 전체를 메모리에서 정렬한다.
function stagesOf(plan: Record<string, unknown>): string[] {
  const stages = [plan.stage as string];
  const children = [plan.inputStage, ...((plan.inputStages as unknown[]) ?? [])];
  for (const child of children) {
    if (child) {
      stages.push(...stagesOf(child as Record<string, unknown>));
    }
  }
  return stages;
}

describe("query plans", () => {
  let mongo: InMemoryMongo;
  const MessageModel = mongoose.model(Message.name, MessageSchema);
  const SessionModel = mongoose.model(Session.name, SessionSchema);

  beforeAll(async () => {
    mongo = await startInMemoryMongo();
    await MessageModel.syncIndexes();
    await SessionModel.syncIndexes();
  });

  afterAll(async () => {
    await stopInMemoryMongo(mongo);
  });

  async function winningStages(
    query: mongoose.Query<unknown, unknown>,
  ): Promise<string[]> {
    const explained = (await query.explain("queryPlanner")) as {
      queryPlanner: { winningPlan: Record<string, unknown> };
    };
    return stagesOf(explained.queryPlanner.winningPlan);
  }

  it("메시지 페이지: sessionId + createdAt/_id desc 정렬을 인덱스로 처리", async () => {
    const stages = await winningStages(
      MessageModel.find({ sessionId: new Types.ObjectId() })
        .sort({ createdAt: -1, _id: -1 })
        .limit(101),
    );

    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("SORT");
  });

  it("메시지 페이지 cursor($or tie-break)도 인덱스 정렬", async () => {
    const at = new Date();
    const stages = await winningStages(
      MessageModel.find({
        sessionId: new Types.ObjectId(),
        $or: [
          { createdAt: { $lt: at } },
          { createdAt: at, _id: { $lt: new Types.ObjectId() } },
        ],
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(101),
    );

    expect(stages).not.toContain("SORT");
  });

  it("세션 목록 cursor($or tie-break)도 인덱스 정렬", async () => {
    const at = new Date();
    const stages = await winningStages(
      SessionModel.find({
        userId: new Types.ObjectId(),
        $or: [
          { lastMessageAt: { $lt: at } },
          { lastMessageAt: null },
          { lastMessageAt: at, createdAt: { $lt: at } },
          { lastMessageAt: at, createdAt: at, _id: { $lt: new Types.ObjectId() } },
        ],
      })
        .sort({ lastMessageAt: -1, createdAt: -1, _id: -1 })
        .limit(21),
    );

    expect(stages).not.toContain("SORT");
  });

  it("요약 후보: completed 메시지 createdAt/_id asc 정렬을 인덱스로 처리", async () => {
    const stages = await winningStages(
      MessageModel.find({
        sessionId: new Types.ObjectId(),
        streamStatus: "completed",
      })
        .sort({ createdAt: 1, _id: 1 })
        .limit(6),
    );

    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("SORT");
  });

  it("세션 목록: userId + lastMessageAt/createdAt/_id desc 정렬을 인덱스로 처리", async () => {
    const stages = await winningStages(
      SessionModel.find({ userId: new Types.ObjectId() })
        .sort({ lastMessageAt: -1, createdAt: -1, _id: -1 })
        .limit(21),
    );

    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("SORT");
  });
});
