# AI Chat Backend

Chizu Comics에서 운영했던 AI 캐릭터 채팅 도메인을 NestJS, MongoDB, Mongoose, Redis, OpenAI API로 재구성한 백엔드 프로젝트입니다.

목적은 기능을 많이 붙이는 것이 아니라, AI 채팅 백엔드에서 반복적으로 발생하는 데이터 모델링, 컨텍스트 조회, 스트리밍 영속성, 동시성 제어 결정을 코드와 ADR로 설명하는 것입니다.

## 구현 범위

- JWT 회원가입/로그인
- 공개/비공개 페르소나 생성, 조회, 수정
- 공개 후 페르소나 잠금 정책
- 세션 생성, 단건 조회, cursor 페이지네이션 목록
- 메시지 이력 100개 단위 cursor 페이지네이션
- OpenAI Chat Completions SSE 스트리밍
- Redis context window cache + MongoDB fallback
- Redis session lock (`SET NX EX` + Lua 안전 해제)
- 사용자 메모리 Phase 1: 명시 등록/조회/삭제, 프롬프트 주입
- 세션 상태 요약으로 장기 대화의 현재 장소·상황 유지
- 토큰 사용량 통계 aggregation
- Swagger UI (`/api`)

## 기술 스택

- Backend: NestJS, TypeScript
- Database: MongoDB, Mongoose
- Cache/Concurrency: Redis, ioredis
- Auth: JWT, Passport
- LLM: OpenAI API
- Streaming: Server-Sent Events
- Docs: Swagger, ADR

## 빠른 시작

```bash
cp .env.example .env
npm install
docker compose up -d
npm run start:dev
```

`.env`의 `OPENAI_API_KEY`는 실제 키로 교체해야 메시지 SSE 호출까지 동작합니다.

```bash
curl http://localhost:3000/healthz
```

Swagger:

```text
http://localhost:3000/api
```

테스트 클라이언트:

```text
http://localhost:3000/web
```

이 클라이언트에서 회원가입, 로그인, 사용자 메모리, 페르소나, 세션, 메시지 SSE, 토큰 통계를 한 화면에서 테스트할 수 있습니다.

## API 흐름 예시

회원가입:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"id":"jay1","password":"jay12345"}'
```

로그인:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"id":"jay1","password":"jay12345"}' | jq -r .accessToken)
```

페르소나 생성:

```bash
PERSONA_ID=$(curl -s -X POST http://localhost:3000/personas \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sherlock",
    "description": "차가운 명탐정",
    "profile": "런던에서 활동하는 예리한 추리 전문가.",
    "personality": "냉정하고 논리적이며 관찰력이 뛰어남.",
    "speakingStyle": "짧고 단정하게 말하며, 가끔 날카로운 농담을 섞음.",
    "scenario": "사용자는 사건 상담을 위해 셜록의 하숙집을 방문했다.",
    "greetingMessage": "어서 오게. 문 앞에서 망설인 이유부터 말해보게.",
    "isPublic": true
  }' | jq -r .id)
```

세션 생성:

```bash
SESSION_ID=$(curl -s -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"personaId\":\"$PERSONA_ID\"}" | jq -r .id)
```

세션 생성 시 페르소나의 `greetingMessage`가 assistant 메시지로 저장된다.

세션 삭제:

```bash
curl -X DELETE "http://localhost:3000/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

세션 삭제 시 해당 세션의 메시지도 함께 삭제된다.

장기 대화 컨텍스트:

- LLM에는 최근 메시지 8개를 넣는다.
- 마지막 요약 이후 completed 메시지가 `contextWindowSize - 2`개 이상 쌓이면 `Session.stateSummary`를 갱신한다.
- 첫 요약은 `CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT`, 이후 요약은 기존 summary와 최신 `CHAT_SUMMARY_MESSAGE_LIMIT`개 completed 메시지를 사용한다.
- `stateSummary`는 현재 장소·상황·관계·중요 사건을 압축해서 다음 응답 프롬프트에 계속 주입한다.
- summary 출력은 `Location / What / Situation / Relationship / User Intent / Open Hooks / Constraints` 고정 형태를 사용한다.
- Persona `scenario`는 초기 설정이며, 현재 상태는 `stateSummary`를 우선한다.

메시지 전송:

```bash
curl -N -X POST "http://localhost:3000/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"content":"안녕. 사건을 하나 가져왔어."}'
```

## 핵심 의사결정

- 메시지는 `Session`에 embed하지 않고 `messages` 컬렉션으로 분리합니다.
- 페르소나는 비공개 상태에서만 수정 가능하고, 공개 후에는 이름/설정/프롬프트 일관성을 위해 잠급니다.
- 컨텍스트 윈도우는 MongoDB를 source of truth로 두고 Redis List로 캐싱합니다.
- Redis context cache가 비면 MongoDB 인덱스 조회로 fallback 후 Redis를 다시 채우고, Redis read 자체가 실패하면 MongoDB fallback만 수행합니다.
- Redis hit은 TTL 60분 동안 신뢰하므로 stale cache 가능성이 있습니다. 데이터 정합성은 MongoDB가 보장하고, cache는 짧은 TTL과 이후 write로 자연 해소합니다.
- 같은 세션의 동시 메시지는 Redis `SET NX EX` 기반 락과 Lua owner 검증 해제로 직렬화합니다.
- LLM 응답은 SSE로 스트리밍하고, assistant placeholder 메시지를 먼저 저장한 뒤 완료 시 final update합니다.
- 사용자 메모리는 Phase 1에서 명시 등록만 허용하고, 자동 추출은 상황극 오염 위험 때문에 Phase 2로 분리합니다.

## 문서

| 문서 | 용도 |
| --- | --- |
| `docs/00_Overview.md` | 프로젝트 정체성과 범위 |
| `docs/01_DataModel.md` | MongoDB / Mongoose 데이터 모델, 인덱스, Redis 키 구조 |
| `docs/02_ADRs.md` | Architecture Decision Records |
| `docs/03_API_Spec.md` | API 엔드포인트와 처리 흐름 |

## 검증

```bash
npm run build
npm run lint
npm run typecheck
npm run test
npm run test:e2e
```

- 단위 테스트는 `src/**/*.spec.ts`, e2e는 `test/*.e2e-spec.ts`.
- e2e는 `mongodb-memory-server` + `ioredis-mock` + OpenAI mock으로 격리. 외부 의존성 없이 동작.
- 핵심 contract 테스트: OpenAI request contract, summary window contract, duplicate registration race, route-level forbidden delete, Redis stale-cache limitation.

## Scope Boundaries

본 프로젝트가 다루지 않는 항목과 이유를 명시한다.

- **Refresh token**: JWT 만료 후 재발급 흐름은 본 프로젝트 범위 밖.
- **WebSocket**: 채팅 응답이 단방향이라 SSE로 충분.
- **자동 사용자 메모리 추출**: 상황극 오염 위험이 있어 Phase 2로 분리. Phase 1은 명시 등록만.
- **Redis lock watchdog**: TTL 60초로 단순화. 장시간 LLM 응답이 잦으면 도입 고려.
- **Redis lock의 Mongo unique index fallback**: Redis 장애 시 503 fail-fast. fallback은 단순화 위해 미적용.
- **Rate limiting**: 본 프로젝트 범위 밖. 인프라 레이어 또는 별도 모듈에서 처리하는 것이 적절.
- **CI/CD**: 로컬 검증에 집중. 배포 파이프라인은 본 프로젝트 범위 밖.
