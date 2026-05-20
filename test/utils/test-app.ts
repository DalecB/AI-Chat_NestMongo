import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { getConnectionToken } from "@nestjs/mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import RedisMock from "ioredis-mock";

import { AppModule } from "../../src/app.module";
import { OpenAiService } from "../../src/llm/openai.service";
import { REDIS_CLIENT } from "../../src/redis/redis.constants";

import { createOpenAiMock, OpenAiMock } from "./openai-mock";

export interface E2eContext {
  app: INestApplication;
  mongo: MongoMemoryReplSet;
  redis: InstanceType<typeof RedisMock>;
  openAiMock: OpenAiMock;
  jwtService: JwtService;
  connection: Connection;
}

const DEFAULT_ENV: Record<string, string> = {
  JWT_SECRET: "test-jwt-secret",
  JWT_EXPIRES_IN: "1h",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_MODEL: "mock-model",
  PORT: "0",
};

export async function createE2eApp(): Promise<E2eContext> {
  // ADR-5: deleteOwnedWithMessages가 multi-document transaction을 쓰므로 standalone이 아닌 replica set 필요.
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const mongoUri = mongo.getUri();
  const redis = new RedisMock();
  const openAiMock = createOpenAiMock();

  for (const [key, value] of Object.entries(DEFAULT_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  process.env.MONGO_URI = mongoUri;
  process.env.REDIS_URL = "redis://localhost:6379";

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(OpenAiService)
    .useValue(openAiMock)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .compile();

  // 실패 경로 테스트(ADR-6)가 의도적으로 LLM throw를 일으키면 Logger.error가 매번 stderr에 찍힌다.
  // 노이즈만 만들 뿐 검증에 영향 없으므로 e2e에서는 logger를 끈다.
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();

  const jwtService = app.get(JwtService);
  const connection = app.get<Connection>(getConnectionToken());

  return { app, mongo, redis, openAiMock, jwtService, connection };
}

export async function closeE2eApp(ctx: E2eContext): Promise<void> {
  await ctx.app.close();
  await ctx.mongo.stop();
  await ctx.redis.quit();
}

export async function resetDataBetweenTests(ctx: E2eContext): Promise<void> {
  const collections = await ctx.connection.db!.collections();

  for (const collection of collections) {
    await collection.deleteMany({});
  }

  await ctx.redis.flushall();
  ctx.openAiMock.reset();
}

export interface RegisteredUser {
  id: string;
  loginId: string;
  password: string;
  accessToken: string;
}

let userCounter = 0;

export async function registerAndLogin(
  ctx: E2eContext,
  overrides: { loginId?: string; password?: string } = {},
): Promise<RegisteredUser> {
  userCounter += 1;
  const loginId = overrides.loginId ?? `user-${Date.now()}-${userCounter}`;
  const password = overrides.password ?? "test-password-1234";

  const request = (await import("supertest")).default(
    ctx.app.getHttpServer(),
  );

  const registerResponse = await request
    .post("/auth/register")
    .send({ id: loginId, password })
    .expect(201);

  const loginResponse = await request
    .post("/auth/login")
    .send({ id: loginId, password })
    .expect(200);

  return {
    id: registerResponse.body.id as string,
    loginId,
    password,
    accessToken: loginResponse.body.accessToken as string,
  };
}

export interface CreatePersonaOptions {
  name?: string;
  isPublic?: boolean;
  greetingMessage?: string;
}

export async function createPersona(
  ctx: E2eContext,
  user: RegisteredUser,
  options: CreatePersonaOptions = {},
): Promise<{ id: string; isPublic: boolean }> {
  const request = (await import("supertest")).default(ctx.app.getHttpServer());
  const response = await request
    .post("/personas")
    .set("Authorization", `Bearer ${user.accessToken}`)
    .send({
      name: options.name ?? "Mock Persona",
      description: "test persona",
      profile: "test profile",
      personality: "test personality",
      speakingStyle: "casual",
      scenario: "test scenario",
      greetingMessage: options.greetingMessage ?? "hello",
      isPublic: options.isPublic ?? false,
    })
    .expect(201);

  return { id: response.body.id as string, isPublic: response.body.isPublic };
}

export async function createSession(
  ctx: E2eContext,
  user: RegisteredUser,
  personaId: string,
): Promise<string> {
  const request = (await import("supertest")).default(ctx.app.getHttpServer());
  const response = await request
    .post("/sessions")
    .set("Authorization", `Bearer ${user.accessToken}`)
    .send({ personaId })
    .expect(201);

  return response.body.id as string;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export async function postMessageAndCollectSse(
  ctx: E2eContext,
  user: RegisteredUser,
  sessionId: string,
  content: string,
): Promise<{ status: number; events: SseEvent[]; body: unknown }> {
  const request = (await import("supertest")).default(ctx.app.getHttpServer());
  const response = await request
    .post(`/sessions/${sessionId}/messages`)
    .set("Authorization", `Bearer ${user.accessToken}`)
    .set("Accept", "text/event-stream")
    .send({ content })
    .buffer(true)
    .parse((res, callback) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        chunks += chunk;
      });
      res.on("end", () => callback(null, chunks));
    });

  const contentType = response.headers["content-type"] ?? "";

  if (contentType.includes("event-stream")) {
    const text = typeof response.body === "string" ? response.body : "";
    return { status: response.status, events: parseSse(text), body: undefined };
  }

  return { status: response.status, events: [], body: response.body };
}

export function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = raw.split(/\n\n/).filter((block) => block.trim().length > 0);

  for (const block of blocks) {
    let event = "";
    let data = "";

    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        data += line.slice("data: ".length);
      }
    }

    if (!event) {
      continue;
    }

    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      // leave as raw string
    }

    events.push({ event, data: parsed });
  }

  return events;
}

// ConfigService 강제 override가 필요할 때 (테스트별로 환경변수 바꿔야 하는 경우)
export function getConfigService(ctx: E2eContext): ConfigService {
  return ctx.app.get(ConfigService);
}
