# 03 API Spec

> 엔드포인트별 요청·응답·관련 인덱스·Redis 연산. Swagger 자동 생성과 별개로 결정 단위 명세.

## 인증 규약

- JWT Bearer token. 모든 인증 필요 엔드포인트는 `Authorization: Bearer <token>` 헤더
- JWT payload: `{ sub: userObjectId, iat, exp }`
- 만료: 24시간 (토이라 refresh token 없음)
- `JwtStrategy`는 `sub`로 User를 재조회한다. 토큰은 유효하지만 DB에 유저가 없으면 401.
- 서명 알고리즘은 HS256만 허용한다 (sign·verify 양쪽 고정).

### Rate limit

Redis 고정 윈도(60초) 카운터. 초과 시 429 + `Retry-After` 헤더.

| 대상 | 기준 | 한도 |
|---|---|---|
| `POST /auth/register`, `POST /auth/login` | IP (`req.ip`) | 10/분 |
| `POST /sessions/:id/messages` | 사용자 | 20/분 |
| `POST /personas`, `PATCH /personas/:id`, `POST /sessions`, `POST /users/me/memories` | 사용자 | 30/분 |

- Redis 장애 시 제한을 건너뛴다(fail-open). 메시지 전송은 세션 락이 Redis 장애 시 503으로 막는다.
- 로드밸런서·프록시 뒤에서는 Express `trust proxy`를 설정해야 클라이언트 IP별로 나뉜다. 설정하지 않으면 모든 요청이 프록시 IP 하나로 묶인다.

### 인증 플로우

```
1. POST /auth/register
   - id trim
   - loginId 중복 검사
   - bcrypt hash 저장
   - 동시 등록 race로 Mongo duplicate key가 발생해도 409 Conflict로 변환

2. POST /auth/login
   - id trim
   - User.passwordHash 포함 조회
   - bcrypt.compare 검증
   - JwtService.sign({ sub: user._id })

3. 인증 필요 API
   - JwtAuthGuard
   - Bearer token 추출
   - JWT_SECRET / exp 검증
   - JwtStrategy.validate(payload)
   - payload.sub로 User 조회
   - req.user에 UserDocument 주입
```

## 엔드포인트 목록

| 메서드 | 경로                     | 인증 | 설명                              |
| ------ | ------------------------ | ---- | --------------------------------- |
| POST   | `/auth/register`         | X    | 회원가입                          |
| POST   | `/auth/login`            | X    | 로그인 (JWT 발급)                 |
| GET    | `/users/me`              | O    | 현재 사용자 정보                  |
| POST   | `/users/me/memories`     | O    | 사용자 메모리 등록                |
| GET    | `/users/me/memories`     | O    | 사용자 메모리 목록                |
| DELETE | `/users/me/memories/:id` | O    | 사용자 메모리 삭제                |
| POST   | `/personas`              | O    | 페르소나 생성                     |
| PATCH  | `/personas/:id`          | O    | 비공개 페르소나 수정 / 공개 전환  |
| GET    | `/personas`              | O    | 공개 페르소나 목록                |
| GET    | `/personas/:id`          | O    | 페르소나 단건 조회                |
| POST   | `/sessions`              | O    | 세션 생성                         |
| GET    | `/sessions`              | O    | 세션 목록 (cursor 페이지네이션)   |
| GET    | `/sessions/:id`          | O    | 세션 단건 조회                    |
| DELETE | `/sessions/:id`          | O    | 세션 삭제 + 메시지 삭제           |
| POST   | `/sessions/:id/messages` | O    | 메시지 전송 + LLM 응답 (SSE)      |
| GET    | `/sessions/:id/messages` | O    | 메시지 이력 (cursor 페이지네이션) |
| GET    | `/stats/tokens`          | O    | 토큰 사용량 통계                  |

총 17개.

---

## 상세 명세

### POST /auth/register

```
Request: { "id": "...", "password": "..." }
Response 201: { "id": "...", "loginId": "..." }
```

### POST /auth/login

```
Request: { "id": "...", "password": "..." }
Response 200: { "accessToken": "eyJ..." }
```

---

### GET /users/me

```
Response 200:
{
  "id": "...",
  "loginId": "...",
  "createdAt": "..."
}
```

### POST /users/me/memories

사용자가 직접 등록하는 전역 메모리. 자동 추출은 Phase 2 범위.
사용자당 최대 100개. 넘으면 400. 공백뿐인 content는 400.

```
Request:
{
  "content": "사용자는 짧고 대화체에 가까운 답변을 선호한다."
}
Response 201:
{
  "id": "...",
  "content": "사용자는 짧고 대화체에 가까운 답변을 선호한다.",
  "createdAt": "...",
  "updatedAt": "..."
}
```

### GET /users/me/memories

```
Response 200:
[
  {
    "id": "...",
    "content": "사용자는 짧고 대화체에 가까운 답변을 선호한다.",
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

**관련 인덱스**: `{ userId: 1, createdAt: -1 }`

### DELETE /users/me/memories/:id

```
Response 204
```

본인 메모리만 삭제 가능하다. 존재하지 않거나 소유자가 다르면 404.

---

### POST /personas

```
Request:
{
  "name": "Sherlock",
  "description": "차가운 명탐정",
  "profile": "런던에서 활동하는 예리한 추리 전문가.",
  "personality": "냉정하고 논리적이며 관찰력이 뛰어남.",
  "speakingStyle": "짧고 단정하게 말하며, 가끔 날카로운 농담을 섞음.",
  "scenario": "사용자는 사건 상담을 위해 셜록의 하숙집을 방문했다.",
  "greetingMessage": "어서 오게. 문 앞에서 망설인 이유부터 말해보게.",
  "isPublic": true
}
Response 201:
{
  "id": "...",
  "name": "Sherlock",
  "description": "차가운 명탐정",
  "profile": "...",
  "personality": "...",
  "speakingStyle": "...",
  "scenario": "...",
  "greetingMessage": "...",
  "isPublic": true,
  "createdAt": "..."
}
```

`systemPrompt`는 요청으로 받지 않는다. 서버가 base prompt harness와 구조화 필드를 조합해 생성하고 내부 필드로 저장한다.

`isPublic: true`로 생성하면 즉시 공개 상태가 되며 이후 수정할 수 없다.

### PATCH /personas/:id

비공개 페르소나 수정. 작성자만 가능하다.

```
Request:
{
  "name": "Sherlock",
  "description": "차가운 명탐정",
  "profile": "런던에서 활동하는 예리한 추리 전문가.",
  "personality": "냉정하고 논리적이며 관찰력이 뛰어남.",
  "speakingStyle": "짧고 단정하게 말하며, 가끔 날카로운 농담을 섞음.",
  "scenario": "사용자는 사건 상담을 위해 셜록의 하숙집을 방문했다.",
  "greetingMessage": "어서 오게. 문 앞에서 망설인 이유부터 말해보게.",
  "isPublic": true
}
```

요청 필드는 모두 선택값이다. 비공개 상태에서는 캐릭터 필드를 수정할 수 있고, 수정 시 `systemPrompt`를 다시 생성한다.

정책:

- 비공개 → 공개 가능
- 공개 → 비공개 불가
- 공개 후 수정 불가

### GET /personas

공개 페르소나 최신순 목록. 최신 50개까지 반환한다. 정의되지 않은 쿼리 파라미터는 400.

**관련 인덱스**: `{ isPublic: 1, createdAt: -1 }`

### GET /personas?name=Sherlock

공개 페르소나 이름 검색(정확히 일치). 최신 50개까지. `name`은 문자열 1개, 50자 이하. 페이지네이션은 현재 의도적으로 제외.

**관련 인덱스**: `{ isPublic: 1, name: 1, createdAt: -1 }`

### GET /personas/:id

공개 페르소나 또는 본인이 만든 비공개 페르소나 단건 조회. 접근 불가한 비공개 페르소나는 404.

---

### POST /sessions

공개 페르소나 또는 본인이 만든 비공개 페르소나로만 세션 생성 가능하다.
세션 생성 시 페르소나의 `greetingMessage`를 assistant 메시지로 함께 저장한다.

```
Request: { "personaId": "...", "title": "선택, 100자 이하" }
Response 201:
{
  "id": "...",
  "personaId": "...",
  "title": null,
  "lastMessageAt": "2026-05-18T01:15:40.141Z",
  "tokenUsage": { "prompt": 0, "completion": 0, "total": 0 },
  ...
}
```

초기 greeting 메시지는 `role: "assistant"`, `streamStatus: "completed"`, `tokenUsage: null`로 `messages` 컬렉션에 저장된다.

### GET /sessions

```
Query: ?cursor=<sessionId>
Response 200: { "items": [...], "nextCursor": "..." }
```

페이지 크기는 고정 20개. `cursor`는 직전 응답의 마지막 session id다.

**관련 인덱스**: `{ userId: 1, lastMessageAt: -1, createdAt: -1, _id: -1 }`. cursor tie-break 키까지 포함해 정렬을 인덱스로 처리

### GET /sessions/:id

본인 세션 단건 조회. 다른 사용자의 세션은 404.

### DELETE /sessions/:id

본인 세션만 삭제 가능하다. 삭제 시 같은 트랜잭션 안에서 해당 세션의 `messages`도 함께 삭제하고, 커밋 뒤 Redis 컨텍스트 캐시(`ctx:{sessionId}`)를 지운다.
메시지 전송과 같은 세션 락을 잡는다. 응답 생성 중이면 429, Redis 장애로 락을 못 잡으면 503.

```
Response 204
```

---

### POST /sessions/:id/messages ⭐ 핵심

현재 구현은 SSE 스트리밍 버전이다. 같은 세션 동시 메시지는 Redis 분산 락으로 직렬화하고, LLM 컨텍스트 윈도우는 Redis List 캐시 + Mongo fallback으로 조회한다.

#### 현재 처리 흐름

```
1. Auth 검증 + Session 소유자 확인
2. Persona 접근 가능 여부 확인
   - 공개 persona 또는 본인이 만든 persona만 사용 가능
3. Redis 세션 락 획득
   - `SET lock:session:{sessionId} <ownerId> NX EX 60`
   - 획득 실패 시 429 반환
   - 락 획득 뒤 Session을 다시 읽는다. 소유권 확인과 락 획득 사이 삭제됐으면 404, 직전 턴의 stateSummary 갱신도 여기서 반영
4. user 메시지 Mongo insert
5. Session.lastMessageAt을 user 메시지 시각으로 갱신
6. 최근 메시지 8개 조회
   - Redis `LRANGE ctx:{sessionId} 0 7`
   - cache miss 시 Mongo에서 `streamStatus: 'completed'` 메시지만 `{ sessionId, createdAt: -1 }`로 조회 후 Redis 갱신. 갱신 실패는 무시.
   - Redis read 장애 시 Mongo fallback만 수행하고 캐시 갱신은 건너뜀
   - Redis hit은 TTL 60분 동안 사용. stale hit 가능성은 ADR-7에 기록.
   - cache hit에 현재 user 메시지가 없으면 현재 요청에서 append 후 Redis push. 실패는 무시.
7. 사용자 메모리 최대 20개 조회
8. assistant placeholder Mongo insert
   - content: ''
   - streamStatus: 'streaming'
9. SSE 헤더 전송
10. user_message_saved / assistant_message_started 이벤트 전송
11. OpenAI Chat Completions API 스트리밍 호출
    - stream: true
    - stream_options: { include_usage: true }
    - systemPrompt + userMemories + session.stateSummary + recentMessages 사용
    - `max_completion_tokens` 1024 (`OPENAI_MAX_COMPLETION_TOKENS`), 재시도 없음, 35초 deadline
12. chunk 이벤트 반복 전송
    - 클라이언트 연결이 끊기면 다음 이벤트 시점에 중단: LLM 요청 abort, assistant 메시지 `failed`, 락 해제
13. 스트림 완료 시 assistant 메시지 final update
    - content: 누적 텍스트
    - tokenUsage: 마지막 usage chunk
    - streamStatus: 'completed'
14. Session.tokenUsage를 assistant usage 기준으로 $inc
15. assistant 완료 메시지를 Redis context cache에 push. 실패는 무시.
16. summaryCursorMessageId 이후 completed 메시지가 `contextWindowSize - 2`개 이상이면 Session.stateSummary 갱신
    - `max_completion_tokens` 1500 (`OPENAI_SUMMARY_MAX_COMPLETION_TOKENS`), 20초 deadline. 토큰 상한으로 잘린 요약은 저장하지 않음. 4000자로 잘라 저장
    - 응답 35초 + 요약 20초가 락 TTL 60초 안에 들어오도록 잡은 예산 (ADR-8)
17. assistant_message_completed / done 이벤트 전송
18. Lua 스크립트로 락 owner 검증 후 해제
```

#### LLM 호출 (OpenAI SDK)

`OpenAIService`가 LLM 모듈을 담당. 환경변수 `OPENAI_MODEL`로 모델 교체 가능 (기본 `gpt-4.1-mini`).

사용자 메모리는 `UserMemoriesService.findPromptMemories(userId)`로 최근 최대 20개를 조회하고 `appendUserMemories()`를 통해 system prompt 뒤에 붙인다. Phase 1에서는 사용자가 직접 등록한 메모리만 사용하며, 메시지에서 자동 추출하지 않는다.

세션 장기 맥락은 `Session.stateSummary`로 관리한다. Persona `scenario`는 초기 설정으로만 취급하고, 현재 장소·상황·관계가 `stateSummary`와 충돌하면 `stateSummary`를 우선한다.
요약 출력은 `Location / What / Situation / Relationship / User Intent / Open Hooks / Constraints` 고정 형태를 사용한다.

```typescript
async generateStream(
  systemPrompt: string,
  messages: Message[],
  options?: { userMemories?: string[]; sessionSummary?: string | null },
): Promise<AsyncIterable<ChatCompletionChunk>> {
  return this.client.chat.completions.create({
    model: this.config.openaiModel, // gpt-4.1-mini
    messages: [
      { role: 'system', content: buildFinalSystemPrompt(systemPrompt, options) },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
}
```

#### 에러 처리

- Session 없음 → 404
- Session 소유자 불일치 → 403
- Persona 없음 또는 접근 불가 → 404
- 같은 세션에서 이미 메시지 처리 중 → 429
- Redis 락 획득 불가 → 503
- Redis 컨텍스트 캐싱 실패 → Mongo fallback 또는 cache write skip 후 계속 진행
- Redis context stale hit → request는 성공하되 LLM context가 오래될 수 있음. Mongo data integrity에는 영향 없음
- OpenAI API 에러·deadline 초과 → assistant 메시지를 `streamStatus: 'failed'`로 update 후 SSE error 이벤트 전송
  - error 이벤트 data는 `{ "message": "LLM stream failed" }`뿐이다. 에러 원문은 서버 로그에만 남긴다
- 클라이언트 이탈 → assistant 메시지 `failed`, 이벤트 없음
- 사용자당 분당 20회 초과 → 429 (Rate limit 참고)
- 마지막 usage chunk를 받지 못하면 tokenUsage는 `{ prompt: 0, completion: 0, total: 0 }`

#### Request / Response

```
Request: { "content": "안녕" }
Response: text/event-stream

event: user_message_saved
data: {"id":"...","role":"user","content":"안녕",...}

event: assistant_message_started
data: {"id":"...","role":"assistant","content":"","streamStatus":"streaming",...}

event: chunk
data: {"content":"안"}

event: chunk
data: {"content":"녕"}

event: assistant_message_completed
data: {"id":"...","role":"assistant","content":"안녕...","streamStatus":"completed",...}

event: done
data: {}
```

**관련 인덱스**:

- `{ sessionId: 1, createdAt: -1, _id: -1 }`. 최근 메시지 8개 조회, 요약 후보 조회
- `{ userId: 1, createdAt: -1 }`. 사용자 메모리 조회

---

### GET /sessions/:id/messages

```
Query: ?cursor=<messageId>
Response 200:
{
  "items": [
    {
      "id": "...",
      "sessionId": "...",
      "role": "user",
      "content": "...",
      "tokenUsage": null,
      "streamStatus": "completed",
      "createdAt": "..."
    }
  ],
  "nextCursor": "..."
}
```

페이지 크기는 고정 100개. 기준은 user 메시지와 assistant 메시지를 합산한 `messages` 개수.

- 첫 페이지: `cursor` 생략
- 다음 페이지: 직전 응답의 `nextCursor`를 `cursor`로 전달
- 정렬: 조회는 최신순 인덱스로 가져오고, 응답은 화면 렌더링을 위해 오래된 메시지 → 최신 메시지 순서
- 잘못된 cursor 또는 다른 세션의 message id는 400

**관련 인덱스**: `{ sessionId: 1, createdAt: -1, _id: -1 }`. sort `{ createdAt: -1, _id: -1 }`를 인덱스 순서로 처리

---

### GET /stats/tokens

```
Query: ?from=2026-05-01&to=2026-05-13&groupBy=day
  - to가 날짜만(YYYY-MM-DD)이면 그날 23:59:59.999Z까지 포함
  - Date로 해석되지 않는 ISO 형식(주 단위 등)은 400
Response 200:
[
  { "_id": "2026-05-13", "totalTokens": 12345, "messageCount": 50 },
  ...
]
```

**구현**: messages 컬렉션 aggregation pipeline

```typescript
db.messages.aggregate([
  {
    $match: { userId, createdAt: { $gte: from, $lte: to }, role: "assistant" },
  },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      totalTokens: { $sum: "$tokenUsage.total" },
      messageCount: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
]);
```

**관련 인덱스**: `{ userId: 1, createdAt: -1 }`

---

## DTO·Validation

NestJS `class-validator`. 화이트리스트 적용 (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`).

- 스키마가 trim하는 문자열(loginId, persona 필드, memory content)은 DTO에서 먼저 trim한 뒤 길이를 검사한다. 공백뿐인 값은 400
- 가입 비밀번호는 72바이트 이하 (bcrypt가 72바이트 이후를 무시)
- persona `name`은 한 줄 (system prompt 섹션 위조 방지)

---

## Swagger

NestJS `@nestjs/swagger`로 자동 생성.
`http://localhost:3000/api`. `NODE_ENV=production`이면 노출하지 않는다.
