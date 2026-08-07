# 02 ADRs. Architecture Decision Records

데이터 모델링과 운영 결정의 근거를 기록한다. 각 ADR은 Context / 선택지 / 결정 / 근거 / Trade-off 형식을 따른다.

ADR 목록 (총 11개):

1. 메시지를 별도 컬렉션으로 분리
2. Persona 공개 후 잠금 정책
3. 컨텍스트 윈도우. separate query 방식 (Mongo 조회 전략)
4. 토큰 사용량 embedded
5. Session denormalize + transaction
6. LLM 스트리밍의 영속성 전략
7. **컨텍스트 윈도우. Redis 캐싱 + Mongo fallback** (Hot/Cold Path)
8. **같은 세션 동시 메시지. Redis 분산 락 (SET NX + Lua 안전 해제)**
9. **사용자 메모리 시스템. Phase 1 명시적 등록, Phase 2 자동 추출**
10. **세션 상태 요약. 장기 대화 컨텍스트 압축**
11. **LLM 통합 라이브러리. OpenAI SDK 직접 사용 (LangChain 미사용)**

---

## ADR-1: 메시지를 별도 컬렉션으로 분리

### Context

한 세션 안에서 user/assistant 메시지가 누적된다.

### 선택지

- A. `Session.messages: Message[]` (embedded array)
- B. 별도 `messages` 컬렉션 + `sessionId` reference

### 결정

**B (reference)**

### 근거

- Mongo document 16MB 한도. 메시지당 평균 200~500 bytes, 긴 응답 포함 시 1KB 이상. 수백 턴이 쌓이면 한도 위협
- "최근 N개 메시지만 조회"가 컨텍스트 윈도우용으로 빈번 (ADR-3)
- 메시지 단위 페이지네이션·삭제·아카이빙 유연성 필요
- 사용자별 토큰 통계는 messages aggregation으로 자연스러움 (ADR-4)

### Trade-off

- Embedded는 한 번에 다 가져올 수 있어 read 1회로 끝. 짧고 끝나는 대화에는 유리
- Reference는 추가 쿼리 발생. 그러나 인덱스 `(sessionId, createdAt desc)`로 비용 미미
- Embedded 한도 도달 시 마이그레이션 비용이 크다는 경험적 판단

### Chizu 비교

Chizu는 한 사용자-캐릭터 대화 전체를 `AIChat.content` 단일 컬럼에 JSON 문자열로 저장하고, `chatCount`·`tokenCount`를 행에 denormalize했다. 출시 속도에는 유리했지만 메시지 단위 조회·페이지네이션·토큰 집계가 불가능하고 컬럼이 무한 성장했다. 본 프로젝트는 이 한계를 보고 메시지를 별도 컬렉션으로 분리한다. 도구(RDB → Mongo)가 바뀌어서가 아니라, 같은 도메인에서 겪은 한계를 근거로 다른 결론을 내렸다는 게 핵심.

---

## ADR-2: Persona 공개 후 잠금 정책

### Context

사용자가 만든 공개 캐릭터는 다른 사용자도 대화할 수 있다. 공개 후 캐릭터의 핵심 설정이 바뀌면 이미 대화 중인 사용자 경험이 흔들릴 수 있다. 반대로 비공개 상태에서는 창작자가 캐릭터를 다듬을 수 있어야 한다.

### 선택지

- A. 공개/비공개와 무관하게 언제든 수정 가능
- B. 비공개 상태에서만 수정 가능, 공개 후에는 잠금
- C. 공개 후에도 수정 가능하되 기존 세션에는 별도 복사본 저장

### 결정

**B (비공개 상태에서만 수정 가능, 공개 후 잠금)**

### 근거

- 공개 캐릭터는 창작자 개인 초안이 아니라 다른 사용자가 소비하는 콘텐츠가 된다.
- 공개 후 이름, 성격, 말투, 시스템 프롬프트가 바뀌면 사용자 입장에서는 같은 캐릭터와 대화하고 있다는 신뢰가 깨진다.
- 비공개 상태에서는 자유롭게 수정 가능하게 두어 창작 단계의 마찰을 낮춘다.
- 공개 → 비공개 전환은 금지한다. 이미 공개 캐릭터로 대화하던 사용자의 접근 가능성이 갑자기 사라지는 것을 막기 위함이다.
- 이 정책을 선택하면 `Session`에 페르소나 복사본을 저장하지 않아도 캐릭터 일관성을 유지할 수 있다.

### Trade-off

- 공개 후 오타 수정 같은 사소한 변경도 일반 사용자 API로는 불가능하다.
- 운영상 강제 수정이 필요하면 admin-only batch나 moderation flow가 별도 필요하다.
- 페르소나 복사본을 저장하지 않기 때문에 세션 문서는 작고 단순하지만, 페르소나 조회가 메시지 전송 경로에 필요하다.

### Chizu 비교

Chizu는 personaId reference 기반으로 최신 페르소나를 조회했다. 본 프로젝트도 reference를 유지하되, 공개 후 잠금 정책으로 캐릭터 일관성 문제를 서비스 규칙에서 해결한다.

### Chizu 비교 — 정정 (2026-07-25, 원본 저장소 재확인)

위 서술의 **필드명이 틀렸다.** `personaId`라는 이름은 Chizu 저장소 어디에도 없다 (`.ts` / `.tsx` / `.prisma` 전수 검색 0건). 실제 FK는 `aiCharacterId`이고 참조 모델명은 `AICharacter`다. 원문은 기록으로 남기고 아래에 정정한다. **ADR-2의 결정과 근거는 바뀌지 않는다.**

```prisma
// chizu-backend/prisma/schema.prisma:1537-1538
aiCharacterId String?
aiCharacter   AICharacter? @relation(fields: [aiCharacterId], references: [id], onDelete: SetNull)
```

「reference 기반으로 최신 것을 조회했다」는 개념 자체는 코드와 일치한다. 근거 두 가지.

- `chizu-backend/src/graphql/comics/aiChat.resolver.ts:1274` — 필드 리졸버가 매 조회마다 `prisma.aIChat.findUnique({ where: { id: parent.id }, include: { aiCharacter: true } })`로 캐릭터를 join한다. 스냅샷을 읽는 게 아니다.
- `worldView`는 `AIChat` 행에 컬럼 자체가 없고 `AICharacter`(`schema.prisma:1510`)에만 있다. 캐릭터를 수정하면(`AIChatMutator.ts:838`) 과거 대화에서도 최신 worldView가 조회된다 — 이게 ADR-2가 「공개 후 잠금」으로 막으려는 바로 그 거동이다.

정정 후 문장: **Chizu는 `aiCharacterId`(→ `AICharacter`) FK reference 기반으로 매 조회 시 최신 캐릭터를 join해 가져왔다.**

---

## ADR-3: 컨텍스트 윈도우 조회 (Mongo). separate query

### Context

LLM 호출 직전, 컨텍스트로 보낼 최근 N개 메시지를 가져와야 한다. 본 프로젝트는 N=8 (user+assistant 4쌍)로 둔다.

본 ADR은 **Mongo만 사용하는 경우**의 조회 전략을 다룬다. Redis 캐싱 도입 결정은 ADR-7.

### 선택지

- A. Session 조회 시 `$slice`로 마지막 N개 메시지 함께 반환 (embedded라면 가능)
- B. 별도 messages 컬렉션 쿼리 (`.find({sessionId}).sort({createdAt: -1}).limit(N)`)

### 결정

**B (separate query)**

### 근거

- ADR-1에서 messages를 별도 컬렉션으로 결정. `$slice`는 embedded 전용
- `(sessionId, createdAt desc)` compound index로 매우 빠름
- N을 동적으로 조정 가능

### Trade-off

- Session 조회와 메시지 조회 2회. 그러나 컨텍스트 윈도우 조회는 LLM 호출 직전에만 발생, 빈도 낮음
- 가져온 메시지를 `createdAt desc` 순서에서 다시 ascending으로 뒤집어야 함

### Chizu 비교

Chizu는 대화를 `AIChat.content` JSON blob으로 저장해 메시지를 행으로 두지 않았고, LLM 컨텍스트는 프론트엔드 LangChain `BufferWindowMemory`가 들고 있었다. 즉 "최근 N개 메시지 조회"라는 쿼리 자체가 없었다. 메시지를 별도 컬렉션으로 분리(ADR-1)하면서 비로소 이 조회가 설계 대상이 됐다.

### Chizu 비교 — 정정 (2026-07-25, 원본 저장소 재확인)

위 서술 중 **「프론트엔드」와 「BufferWindowMemory가 들고 있었다」 두 곳이 부정확했다.** `AIChat.content` JSON blob 저장과 「최근 N개 조회 쿼리가 없었다」는 부분은 맞다. 원문은 기록으로 남기고 아래에 정정한다. **ADR-3의 결정과 근거는 바뀌지 않는다.**

#### 정정 1. 실행 위치는 프론트엔드가 아니라 서버

`chatGenerator.ts`는 `chizu-comics-frontend` 저장소 안에 있지만 경로가 `pages/api/ai/`다. Next.js에서 `pages/api/**`는 브라우저 코드가 아니라 Node 런타임의 서버 API 라우트다.

```ts
// chizu-comics-frontend/pages/api/ai/chatGenerator.ts:114-117
export default async function aiChatGenerator(
  req: NextApiRequest,
  res: NextApiResponse
) {
```

`export const config`로 edge/브라우저 런타임을 지정한 곳도 없다. 브라우저 쪽 코드는 `useChatAiGenerator.ts`이고 여기서는 `fetch("/api/ai/chatGenerator")`로 호출만 한다 — LangChain 객체를 들고 있지 않다. 저장소 분류(frontend repo)와 실행 위치(server)를 혼동한 서술이었다.

#### 정정 2. 컨텍스트를 실제로 들고 있던 건 메모리가 아니라 클라이언트가 매번 보낸 히스토리

```ts
// chatGenerator.ts:143-148
if (!instancesByUUID[ID] || history.length > 0) {
  if (history.length > 0 && instancesByUUID[ID]) {
    removeInstanceByID(ID);
  }
  await initAIChat(decryptWorldView, history ?? [], seedChat).then(
```

클라이언트는 매 요청마다 히스토리를 실어 보낸다 (`useChatAiGenerator.ts:36` — `history: chat.content ? JSON.parse(chat.content) : []`). 즉 `history.length > 0`이 거의 항상 참이므로, 기존 인스턴스는 **매 턴 파기되고 다시 만들어진다.** 새 `BufferWindowMemory`는 `history.slice(-16)`(68행)으로 그때그때 다시 채워진다.

따라서 컨텍스트의 실제 보관소는 서버 메모리가 아니라 **DB의 `AIChat.content` blob**이고, `instancesByUUID`는 컨텍스트 저장소가 아니라 히스토리 없이 연속 호출되는 짧은 구간용 성능 캐시에 가깝다. (이 캐시의 한계는 ADR-7에서 별도로 다룬다.)

#### 정정 3. 「최근 N개 조회가 없었다」의 정확한 의미

쿼리가 없던 건 맞지만, 「최근 N개」 개념 자체는 있었다. 위치가 SQL이 아니라 애플리케이션 코드였을 뿐이다 — 한 행에 전체 히스토리가 들어 있으니 `LIMIT`/`ORDER BY`가 성립할 수 없고, 대신 파싱된 배열을 `slice(-16)`한 뒤 `BufferWindowMemory({ k: 8 })`가 다시 8턴으로 줄였다.

정정 후 문장: **Chizu는 대화를 `AIChat.content` 단일 JSON 컬럼에 저장해 메시지를 행으로 두지 않았고, 컨텍스트는 클라이언트가 매 요청 재전송하는 히스토리 blob을 서버 API 라우트(`pages/api/ai/chatGenerator.ts`)에서 `slice(-16)` → `BufferWindowMemory(k=8)`로 잘라 쓰는 방식이었다. DB 레벨의 「최근 N개 메시지 조회」 쿼리는 존재하지 않았다.**

---

## ADR-4: 토큰 사용량을 메시지에 embedded로 저장

### Context

각 LLM 응답마다 prompt tokens, completion tokens, total tokens가 기록되어야 한다. 통계(일별, 사용자별)를 뽑을 수 있어야 한다.

### 선택지

- A. `Message.tokenUsage` embedded
- B. 별도 `token_usages` 컬렉션, messageId reference
- C. Session에 totalTokensUsed만 누적 (메시지 단위 추적 X)

### 결정

**A (embedded)**

### 근거

- Message와 tokenUsage는 1:1. 분리할 이유 없음
- 통계는 messages 컬렉션 aggregation pipeline으로 바로 집계 가능
- C는 메시지별 분석 (어떤 페르소나가 토큰 많이 쓰는지 등) 불가능

### Trade-off

- assistant 메시지에만 tokenUsage가 의미 있음. user 메시지는 prompt 입력일 뿐. 일관성을 위해 user 메시지도 0으로 두고 같은 스키마 유지
- ADR-1과 대비. 메시지는 separate, tokenUsage는 embedded. **"무한 성장하는가 / 1:1 관계인가"가 핵심 판단 기준**

### Chizu 비교

Chizu는 메시지를 행으로 두지 않아 토큰을 메시지 단위로 기록하지 못했다. `AIChat.tokenCount`(대화 단위), `ComicUser.aiTokenUsage`(사용자 단위) 같은 denormalized 카운터만 있었다. 메시지를 행으로 분리(ADR-1)하면서 토큰 사용량을 메시지 단위 embedded로 기록할 수 있게 됐다.

OpenAI의 경우 streaming 모드에서 토큰 카운트는 응답 마지막에 `usage` 필드로 도착한다 (`stream_options: {include_usage: true}` 옵션 필요). 이 값을 placeholder update 시점에 같이 저장.

---

## ADR-5: Session의 denormalized 필드와 일관성 trade-off

### Context

세션 목록 조회 시 "최근 메시지 시각, 메시지 수, 총 토큰" 같은 정보를 빠르게 보여줘야 한다. 매번 messages aggregation을 돌리면 비용이 큼.

### 선택지

- A. 매번 aggregation으로 실시간 계산
- B. Session에 messageCount, totalTokensUsed, lastMessageAt을 denormalize하고 메시지 추가 시 함께 update

### 결정

**B (denormalize + transaction으로 동시 update)**

### 근거

- 세션 목록 조회 빈도가 매우 높음
- denormalized 필드는 list view 용도. 정확한 통계가 필요한 stats API는 항상 messages aggregation으로 재계산
- Mongo 4.0+ multi-document transaction으로 원자적 묶음

### Trade-off

- 트랜잭션 비용. Mongo replica set 필요. 토이에서는 single-node replica set으로 회피
- 트랜잭션 실패 시 일관성 깨질 수 있음. 정기 reconciliation job 필요 (범위 외)

### Chizu 비교

Chizu도 조회 성능을 위해 카운터·합계를 행에 denormalize했고(`chatCount`, `dailyChatCount`, `aiTokenUsage` 등), 그 갱신은 application 코드(mutator·scheduler)에서 처리했다. 본 프로젝트도 application 레이어에서 갱신하되 Mongo multi-document transaction으로 원자성을 확보한다. **DB가 달라도 "성능을 위해 일관성을 trade"한다는 결정 본질은 같다.**

---

## ADR-6: LLM 스트리밍 응답의 영속성 전략

### Context

OpenAI Chat Completions API는 SSE 기반 스트리밍을 지원한다 (`stream: true`). 백엔드는 응답을 DB에 저장해야 한다.

### 선택지

- A. 청크가 도착할 때마다 DB update
- B. 스트리밍 완료 후 한 번에 insert
- C. 빈 placeholder 메시지를 먼저 insert, 스트리밍 끝나면 content와 tokenUsage로 update

### 결정

**C (placeholder + final update)**

### 근거

- A는 Mongo write 폭발
- B는 클라이언트 중단 시 응답 손실
- C는 절충안. 응답 시작 즉시 `streamStatus: 'streaming'` insert, 완료 시 `completed`로 update

### 상태 머신

```
pending → streaming → completed
                   └→ failed
```

### OpenAI 스트리밍 특수 사항

- 청크 형식: `data: {"choices":[{"delta":{"content":"안녕"}, ...}], ...}` (SSE)
- 토큰 사용량: `stream_options: {include_usage: true}` 옵션 사용 시 마지막 청크에 `usage` 필드 포함
- 종료 신호: `data: [DONE]`

### Trade-off

- 클라이언트 중단 시 partial response 손실은 여전. 하지만 "응답이 있었다"는 흔적은 남음
- streamStatus 상태 머신 추가. 복잡도 증가
- OpenAI usage 필드가 마지막 청크에 오므로, 클라이언트가 일찍 끊으면 토큰 카운트 0으로 저장될 수 있음. 운영 회고 영역

### Chizu 비교

Chizu에서는 스트리밍 미도입. **이 ADR-6는 Chizu에 없던 새 결정**. 본 프로젝트의 차별화.

---

## ADR-7: 컨텍스트 윈도우. Redis 캐싱 + Mongo fallback (Hot/Cold Path)

### Context

ADR-3에서 컨텍스트 윈도우 조회를 Mongo `(sessionId, createdAt desc)` 인덱스로 처리하기로 결정했다. 인덱스 사용 시 빠르지만, **매 메시지마다 Mongo hit이 발생**한다. 라이브 트래픽에서는 이 hit이 누적 부하가 된다.

본 ADR은 Redis 캐싱을 통한 Hot/Cold Path 분리 결정.

### 선택지

- A. Mongo만 사용 (ADR-3 그대로)
- B. Redis만 사용 (메시지 컨텍스트를 Redis List로만 유지)
- C. Redis 캐싱 + Mongo source of truth (Hot/Cold Path 분리)

### 결정

**C (Redis 캐싱 + Mongo fallback)**

### 근거

- Redis는 메모리 기반, Mongo 인덱스 lookup 대비 1~2 order 빠름. 컨텍스트 조회는 메시지 1건당 1회 발생. write-heavy 환경에서 hit 줄이는 게 누적 효과 큼
- Redis 단독(B)은 영속성 부족. Mongo가 source of truth로 남아야 메시지 이력·통계가 살아있음
- Redis 장애 시 Mongo fallback으로 동작 계속 (사용자 응답 보호)

### Redis 데이터 구조

```
Key:   ctx:{sessionId}
Type:  List
Value: JSON-encoded message snippets (최신이 head)
TTL:   60분 (대화 휴면 시 자연 제거 + stale context 위험 축소)
크기:  N=8, 세션당 약 4KB
```

### 운영 흐름

**메시지 추가 시:**

1. user 메시지를 Mongo에 insert
2. Redis에 push: `LPUSH ctx:{sessionId} <user_msg_json>` + `LTRIM ctx:{sessionId} 0 7` + `EXPIRE ctx:{sessionId} 3600`
3. LLM 호출 후 assistant 메시지 완료 시 동일 패턴으로 Redis push

**컨텍스트 조회 시:**

1. `LRANGE ctx:{sessionId} 0 -1` (Redis hit)
2. Cache miss (LLEN == 0) → Mongo `(sessionId, createdAt desc).limit(8)` 조회 후 Redis 채움 (캐시 쓰기 실패는 무시)
3. Redis read 장애 → Mongo fallback만 수행하고 Redis 재적재는 시도하지 않음
4. Reverse → ascending 순서로 LLM에 전달

### Trade-off

- 캐시 일관성. Mongo write와 Redis write가 별도. 한쪽 실패 시 불일치 가능
  - **선택한 정책**: Mongo가 source of truth. Cache miss는 Mongo fallback 후 재적재하지만, Redis hit이 stale한 경우에는 TTL 60분 또는 이후 write로 자연 해소될 때까지 오래된 context가 사용될 수 있다.
  - 일부러 atomic하게 묶지 않음. Redis 실패가 사용자 응답을 막으면 안 됨
- 메모리 비용. 활성 세션 수 × 4KB. 1만 활성 세션 = 40MB. 무시 가능
- 코드 복잡도 증가. write 경로에 Redis push 1회 추가, read 경로에 fallback 분기 추가

### 테스트 보강

- `ContextCacheService` 단위 테스트로 cache hit, cache miss, Redis read 장애, stale cache limitation을 고정한다.
- stale hit은 fallback을 호출하지 않는다는 한계를 의도적으로 테스트해 운영상 trade-off를 숨기지 않는다.

### Chizu 비교

Chizu에서는 Next.js API route 안에 `Record<chatId, LangChainInstance>` 형태의 모듈 레벨 캐시를 두고 LangChain `chain`, `BufferWindowMemory(k=7)`, `model` 인스턴스를 묶어 12시간 TTL로 보관했다. 단일 프로세스 Next.js 서버에서는 동작했지만 두 가지 구조적 한계가 있었다.

1. **캐시 단위가 너무 크다.** 메시지 컨텍스트가 LangChain 인스턴스 안에 묶여 있어, 캐시를 잃으면 인스턴스 자체를 재구성해야 한다.
2. **수평 확장이 불가능하다.** 단일 Next.js 프로세스 가정 위에서 동작했고, 프로세스를 늘리면 같은 세션의 후속 요청이 다른 프로세스로 라우팅되어 캐시가 분리된다.

본 프로젝트는 캐시 단위를 LangChain 인스턴스가 아닌 **메시지 스냅샷**으로 낮추고, 보관 위치를 Redis로 옮겨 두 한계를 동시에 해결한다.

### Chizu 비교 — 정정 (2026-07-25, 원본 저장소 재확인)

위 「Chizu 비교」는 기억에 의존해 작성했다. 이 서술을 이력서에 인용하기 전에 원본 저장소를 다시 열어 코드와 대조한 결과 두 곳이 부정확했다. 원문은 기록으로 남기고 아래에 정정한다. **ADR-7의 결정(C)과 근거는 바뀌지 않는다.**

대조한 파일:

- `chizu-comics-frontend/pages/api/ai/chatGenerator.ts` (재구성 지점)
- `chizu-comics-frontend/lib/hook/global/ai/useChatAiGenerator.ts` (전송 지점)
- `chizu-comics-frontend/pages/ai/chat.tsx` (히스토리 출처)
- `chizu-backend/src/comicsApp/controllers/community/mutators/AIChatMutator.ts` (저장 지점)

#### 정정 1. 메모리 파라미터 오기

`BufferWindowMemory(k=7)`이 아니라 `k: 8`이다. 재구성 시에는 `history.slice(-16)`, 즉 8턴(user/assistant 16건)을 재주입한다. ADR-11의 「Chizu 비교」에도 같은 오기가 있어 함께 정정했다.

#### 정정 2. "수평 확장이 불가능하다"는 과장

핸들러 진입부는 다음과 같다.

```ts
if (!instancesByUUID[ID] || history.length > 0) {
  if (history.length > 0 && instancesByUUID[ID]) {
    removeInstanceByID(ID);
  }
  await initAIChat(decryptWorldView, history ?? [], seedChat)...
```

`history`가 비어 있지 않으면 살아 있던 인스턴스를 **삭제하고 매 요청 재생성**한다. 프론트는 대화 전체를 매 요청 실어 보내므로, 기존 대화방 경로에서는 `history`가 항상 비어 있지 않다. 결과적으로 12시간 TTL 인스턴스 캐시는 그 경로에서 사실상 재사용되지 않았고, 프로세스를 늘려도 응답은 달라지지 않는다.

단일 프로세스 가정이 실제로 걸리는 지점은 **같은 페이지 세션에서 새로 만든 채팅방**(`history = []`) 하나뿐이다. 이 경우에만 대화 맥락이 프로세스 메모리에만 존재한다.

따라서 한계는 실재했지만 **잠재적**이었다. 프론트를 단일 프로세스로 운영했기 때문에 운영 중 발현된 적이 없고, "확장이 막혀 있었다"고 쓰면 지불한 적 없는 비용을 지불한 것처럼 읽힌다.

#### 정정 후 근거 — 실제로 매 턴 지불하던 비용

캐시가 재사용되지 않았다는 사실은 ADR-7의 근거를 약화시키는 대신 다른 근거로 대체한다. 대화 1턴마다 대화 전체가 세 번 움직이고 있었다.

1. **조회.** 백엔드가 대화 전체를 `AIChat.content` 단일 컬럼에 stringify해 보관하고, 조회 시 통째로 반환한다.
2. **전송.** 프론트가 그 문자열을 파싱해 매 메시지 POST body의 `history`로 다시 직렬화해 보낸다. API route는 그중 뒤 16건만 사용한다. N건을 보내 16건을 쓴다.
3. **저장.** `saveAIChat`이 매 턴 기존 content를 읽어 parse → concat → stringify → 전량 update 한다. 턴당 O(N) 재작성이다.

단, 무료 구간 경계인 5000 토큰을 넘으면 방별 잔여 토큰(`chatTokenLeft`)이 차감되고 잔량이 0이 되면 대화가 막히므로(`chat.tokenCount > 5000 && chat.chatTokenLeft <= 0`), 이 O(N)들에는 방마다 다른 상한이 있었다. 무한히 커지는 문제는 아니었다.

#### 결론 — ADR-7의 결정은 유지된다

`ctx:{sessionId}` List + N=8 + TTL 60분은 위 세 비용을 각각 없앤다. `LPUSH` + `LTRIM`은 대화 길이와 무관하게 O(1)이라 전량 재작성이 사라지고, 캐시 단위가 메시지 스냅샷이라 miss 시 재적재가 8건 조회로 끝나며, 보관 위치가 프로세스 밖이라 프로세스 수와 무관해진다.

정정 전 근거("확장 불가")보다 정정 후 근거("턴마다 반복되는 O(N) 3종")가 측정 가능하다는 점에서 더 강하다.

#### 부수 확인 사항 (본 프로젝트 설계에는 영향 없음, 기록용)

- 인스턴스를 재생성할 때마다 `setTimeout(..., 12 * 60 * 60 * 1000)`을 새로 걸면서 이전 타이머를 clear하지 않는다. 요청 수만큼 타이머가 누적된다.
- `saveAIChat` 뮤테이션에 `refetchQueries`가 없고 반환도 스칼라라 Apollo 캐시의 `getAIChatById`가 갱신되지 않는다. 그래서 전송되는 `history`는 **페이지 로드 시점 값에 고정**된다. 재생성이 항상 로드 시점 히스토리로 이뤄지므로, 새로고침 없이 이어간 대화에서는 그 세션 중 주고받은 턴이 모델 메모리에서 빠진다. 화면과 DB에는 남아 있어 드러나기 어려운 종류의 결함이다.


---

## ADR-8: 같은 세션 동시 메시지. Redis 분산 락

### Context

사용자가 같은 세션에 빠르게 두 번 메시지를 전송할 수 있다 (실수, 더블 클릭, 클라이언트 retry). 두 요청이 동시에 처리되면:

1. 두 요청이 같은 컨텍스트 윈도우를 조회
2. LLM 호출 결과가 꼬임 (응답이 같은 컨텍스트 기반이라 사용자 입장에서 헷갈림)
3. assistant 메시지 순서·streamStatus 상태가 race condition

### 선택지

- A. Mongo unique index로 직렬화 (예: `(sessionId, expectedSeqNumber)` unique)
- B. Mongo 트랜잭션으로 세션 row 잠금
- C. Redis 분산 락 (`SET NX EX` + Lua 안전 해제)

### 결정

**C (Redis 분산 락)**

### 근거

- A는 schema에 sequence 필드 추가 + race 시 retry 로직 필요. 복잡도 큼
- B는 Mongo 트랜잭션을 LLM 호출 전체 시간 동안 유지. 트랜잭션이 수십 초 이상 길게 잡혀 다른 작업까지 영향. 안티패턴
- C는 락 도구를 LLM 호출 범위에만 한정. Redis가 동시성 제어 전용으로 사용됨

### Redis 데이터 구조

```
Key:   lock:session:{sessionId}
Type:  String
Value: <ownerId> (uuid v4, 소유권 검증용)
TTL:   60초 (LLM 응답 평균 5~30초 + 여유)
```

### 운영 흐름

```
1. ownerId = uuid()
2. acquired = SET lock:session:{sessionId} ownerId NX EX 60
3. if not acquired:
     return 429 Too Many Requests (다른 요청 처리 중)
4. try:
     - user 메시지 insert
     - 컨텍스트 조회 + LLM 스트리밍
     - assistant 메시지 finalize
5. finally:
     - Lua script로 안전 해제 (자기 소유 확인 후 DEL)
```

### 안전 해제 Lua script

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

이유: TTL 만료 후 다른 요청이 락을 새로 획득한 상태에서, 원 소유자가 늦게 DEL 호출하면 남의 락을 풀어버리는 사고. 소유권 검증 후 DEL로 방지.

### Trade-off

- 락 만료 위험. 스트리밍 응답이 60초를 넘으면 락 만료, 다른 요청이 들어올 수 있음
  - **1차 단순화**: TTL 60초로 시작
  - **2차 (필요 시)**: Watchdog 패턴. 락 획득 후 20초마다 `EXPIRE` 갱신. 본 프로젝트는 1차 단순화로 시작, README "개선 여지"에 watchdog 명시
- 사용자 경험. 429 응답을 받은 클라이언트가 retry해야 함. 백엔드 단순화 vs 클라이언트 복잡도 trade
- Redis 장애 시 락 자체가 비활성. 이 경우 Mongo unique index fallback 옵션 있지만 본 프로젝트는 단순화 위해 미적용. README "개선 여지"에 명시
- half-open 소켓 위험. 배포 재시작·네트워크 파티션·LB idle drop으로 FIN 없이 죽은 연결에서는 `maxRetriesPerRequest=1`(close/error 이벤트 기반)이 작동하지 않아 `acquire()`의 `SET NX`가 무한 hang → 503도 못 던지고 요청이 멈춘다. `socketTimeout=5s`로 벽시계 상한을 걸어 fail-fast를 완성한다(Redis 명령은 sub-ms 응답이라 5s는 순수 안전 마진)
- 단, `socketTimeout`은 **ioredis>=6.0.0에서만 안전**하다. 5.x는 재연결 시 옛 타이머가 새 스트림을 destroy하는 #2148 버그가 있어, 이 옵션을 켠 채 다운그레이드하면 재연결마다 정상 연결을 죽인다. 회귀 테스트 `src/redis/socket-timeout-reconnect.spec.ts`로 고정

### Chizu 비교

Chizu에서는 분산 락을 도입하지 않았다. AI 채팅 트래픽 특성상 사용자당 동시 요청이 거의 없어 필요성이 낮았다. 본 프로젝트는 같은 사용자의 동시 요청도 안전하게 직렬화하는 동작을 명시적으로 확보하기 위해 도입한다.

---

## ADR-9: 사용자 메모리 시스템. Phase 1 명시적 등록, Phase 2 자동 추출

### Context

캐릭터 채팅 품질은 단일 세션의 최근 대화뿐 아니라 사용자 선호와 장기 맥락을 기억할 때 개선된다. 이 구조는 ChatGPT Memory, Claude Projects, RAG 기반 개인화와 같은 방향이다.

다만 캐릭터 채팅은 상황극이 많다. 사용자가 "나는 기사단장이다", "내 이름은 오늘부터 카인이다" 같은 세션 한정 설정을 말했을 때, 이를 전역 사용자 메모리로 저장하면 이후 다른 캐릭터 대화가 오염된다.

### 선택지

- A. 모든 사용자 메시지에서 자동으로 메모리 후보를 추출하고 저장
- B. 사용자가 직접 등록한 메모리만 저장
- C. Phase 1은 명시적 등록만 구현하고, Phase 2에서 자동 추출 + 사용자 확인 흐름 도입

### 결정

**C. 본 프로젝트에서는 Phase 1만 구현**

### 근거

- 자동 추출은 추가 LLM 호출이 필요해 비용이 증가한다.
- 상황극, 농담, 임시 설정, 민감 정보가 전역 메모리로 오염될 위험이 크다.
- Phase 1만으로도 "저장 → 조회 → 삭제 → 프롬프트 주입"이라는 메모리 시스템의 핵심 골격을 검증할 수 있다.
- 사용자가 직접 등록한 메모리는 이미 confirmed 상태이므로 `pending/status/source/confidence` 상태 머신을 초기 구현에 넣지 않는다.

### Phase 1 범위

```
POST   /users/me/memories
GET    /users/me/memories
DELETE /users/me/memories/:id
```

데이터 모델:

```typescript
UserMemory {
  _id: ObjectId,
  userId: ObjectId,
  content: string,
  createdAt: Date,
  updatedAt: Date,
}
```

LLM 호출 시 최근 사용자 메모리 최대 20개를 system prompt에 추가한다.

```
Known about the user:
- ...
- ...

Use this information only when it is relevant to the conversation.
Do not mention that you are using stored memory.
```

### Phase 2 범위

- 자동 추출: 사용자 메시지마다 또는 N턴마다 저비용 모델로 메모리 후보 추출
- 사용자 확인: `pending → confirmed/rejected/deleted` 상태 머신
- 상황극 보호: 세션 한정 설정과 전역 사용자 선호 분리
- 민감 정보 보호: 개인정보, 건강, 정치, 종교 등은 자동 저장 제외
- 검색 최적화: 메모리 수가 커지면 vector search 또는 keyword filter 도입

### Trade-off

- Phase 1은 UX가 덜 자연스럽다. 사용자가 직접 API/UI로 등록해야 한다.
- 대신 비용이 증가하지 않고, 잘못된 자동 저장으로 인한 신뢰 손상을 피한다.
- 삭제 API를 필수로 제공해 사용자가 메모리 통제권을 가진다.

### Chizu 비교

Chizu에는 장기 사용자 메모리 시스템이 없었다. 대화 맥락은 해당 대화의 최근 메시지(LangChain 윈도우)에만 의존했다. 이번 설계는 캐릭터 채팅을 "메모리 기반 개인화 에이전트 백엔드"로 확장할 수 있는 기반을 만든다.

---

## ADR-10: 세션 상태 요약. 장기 대화 컨텍스트 압축

### Context

현재 LLM 컨텍스트는 최근 메시지 8개만 사용한다. 사용자가 장소를 옮기거나 관계·상황이 변해도 오래된 메시지가 밀려나면 모델이 이를 잊는다. 또한 Persona의 `scenario`는 system prompt에 계속 남아 있어, 초기 장소가 현재 장소처럼 다시 덮어씌워지는 문제가 생긴다.

### 선택지

- A. 최근 메시지 윈도우를 8개에서 크게 늘린다
- B. 모든 메시지를 매번 프롬프트에 넣는다
- C. 세션별 `stateSummary`를 저장하고, 최근 메시지 윈도우와 함께 주입한다
- D. Vector DB/RAG로 과거 메시지를 검색한다

### 결정

**C. Session embedded `stateSummary` + `summaryCursorMessageId`**

### 저장 텀

컨텍스트 윈도우는 8개다. 요약은 `contextWindowSize - 2` 기준으로 수행한다.

```typescript
const contextWindowSize = 8;
const summaryBufferSize = 2;
const summaryTriggerInterval = contextWindowSize - summaryBufferSize; // 6
const summaryInitialMessageLimit = summaryTriggerInterval;
const summaryMessageLimit = contextWindowSize; // 8
```

단순 `messageCount % 6`이 아니라 `summaryCursorMessageId` 이후 completed 메시지가 `summaryTriggerInterval` 이상 쌓였는지 본다. 실제 구현은 `CHAT_SUMMARY_TRIGGER_INTERVAL`, `CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT`, `CHAT_SUMMARY_MESSAGE_LIMIT` 상수로 고정해 컨텍스트 윈도우 크기 변경 시 테스트와 코드가 같이 움직이게 한다.

```
1. assistant 응답 completed 저장
2. summaryCursorMessageId 이후 completed 메시지 조회
3. summaryTriggerInterval 미만이면 skip
4. 첫 요약이면 새 메시지 summaryInitialMessageLimit개를 요약 LLM에 전달
5. 이후 요약이면 기존 stateSummary + 최신 completed 메시지 summaryMessageLimit개를 요약 LLM에 전달
6. Session.stateSummary / summaryCursorMessageId / summaryUpdatedAt 갱신
```

요약 출력은 자유 문장이 아니라 고정 슬롯을 강제한다.

```
Location:
What:
Situation:
Relationship:
User Intent:
Open Hooks:
Constraints:
```

### 근거

- 최근 메시지가 컨텍스트에서 밀려나기 전에 핵심 상태를 요약으로 흡수한다.
- 매 턴 요약보다 비용이 낮다. `summaryTriggerInterval`마다 1회만 추가 호출한다.
- `summaryCursorMessageId`가 있어 실패/삭제/재시도 상황에서도 어디까지 요약했는지 명확하다.
- `stateSummary`는 세션에 종속된 상태라 별도 컬렉션보다 `Session` embedded field가 적절하다.
- Persona `scenario`는 초기 설정으로만 취급하고, 현재 장소·상황은 `stateSummary`를 우선한다.
- 장소, 무엇을 하는지, 현재 상황은 최신 completed 메시지 8개가 기존 summary보다 우선한다.

### 테스트 보강

- `OpenAiService` 단위 테스트로 OpenAI request contract를 고정한다: `stream: true`, `stream_options.include_usage`, 모델/temperature/top_p/penalty, user memory, session summary 주입 여부.
- `state-summary.e2e-spec`는 첫 요약이 initial limit을 사용하고, 이후 요약이 최신 message limit 후보를 사용한다는 summary window contract를 검증한다.
- `auth.e2e-spec`는 duplicate registration race에서 Mongo duplicate key `11000`이 500이 아니라 409로 변환되는지 검증한다.
- `sessions-messages.e2e-spec`는 타인의 세션 삭제 시도가 403으로 끝나고 세션/메시지가 삭제되지 않는 route-level forbidden delete를 검증한다.

### 예상 비용

현재 `.env` 기본 모델은 `gpt-4.1-mini`다. 공식 가격 기준 `input $0.40 / 1M`, `output $1.60 / 1M` tokens.

요약 1회가 대략 입력 1,200 tokens + 출력 250 tokens라면:

```
input  1,200 * 0.40 / 1,000,000 = $0.00048
output   250 * 1.60 / 1,000,000 = $0.00040
합계 ≈ $0.00088 / summary
```

요약은 completed 메시지 6개마다 1회다. user+assistant 왕복 3턴마다 1회라고 보면 된다.

```
30턴 대화 = 메시지 약 61개(초기 greeting 포함)
요약 약 10회
추가 비용 ≈ $0.0088
```

대화 생성 비용 자체가 더 크고, 세션 요약 비용은 `gpt-4.1-mini` 기준으로 낮은 편이다.

### Trade-off

- assistant 응답 완료 후 요약 호출이 추가되어, 요약 타이밍에는 `done` 이벤트가 약간 늦어질 수 있다.
- 요약 LLM이 잘못 요약하면 이후 대화에 잘못된 상태가 주입될 수 있다. 그래서 filler, 농담, raw dialogue는 저장하지 말라고 별도 요약 프롬프트를 사용한다.
- 요약 업데이트 실패는 채팅 실패로 처리하지 않고 warn log 후 skip한다. MongoDB messages가 source of truth이므로 다음 턴에서 다시 시도 가능하다.
- Vector DB/RAG보다 특정 과거 사건 검색 능력은 약하지만, 현재 장소·상황·관계 유지에는 summary가 더 비용 효율적이다.

---

## ADR-11: LLM 통합 라이브러리. OpenAI SDK 직접 사용 (LangChain 미사용)

### Context

이 프로젝트는 OpenAI Chat Completions API를 사용해 LLM 응답을 생성한다. LangChain 같은 LLM 통합 라이브러리를 채택할지, OpenAI 공식 SDK를 직접 사용할지 결정해야 한다.

### 선택지

- A. LangChain (`ChatPromptTemplate`, `BufferWindowMemory`, `LLMChain`)
- B. OpenAI 공식 SDK 직접 사용 (`openai` 패키지)
- C. 두 방식 혼용

### 결정

**B. OpenAI 공식 SDK 직접 사용**

### 근거

본 프로젝트의 LLM 호출 경로에는 다음과 같은 명시적 결정이 들어 있다.

1. **컨텍스트 윈도우 관리**는 ADR-3과 ADR-7에서 Mongo + Redis로 정의했다. 메시지 단위 캐시, 인덱스 조회, fallback 정책이 모두 코드에 노출되어 있어야 한다.
2. **토큰 사용량 영속화**는 ADR-4에서 `stream_options.include_usage`로 마지막 청크의 usage 필드를 받아 메시지에 embedded로 저장한다. OpenAI 응답을 1:1로 다뤄야 한다.
3. **스트리밍 응답 상태 머신**은 ADR-6에서 placeholder insert → final update로 정의했다. SSE 청크 처리와 DB write를 직접 묶어야 한다.
4. **세션 상태 요약**(ADR-10)과 **사용자 메모리 주입**(ADR-9)은 system prompt에 fixed-shape 블록을 추가하는 도메인 고유 로직이다.

LangChain의 `BufferWindowMemory`, `LLMChain`, `ChatPromptTemplate`은 위 결정들을 모두 라이브러리 내부로 흡수하는 방향으로 만들어져 있다. 본 프로젝트는 그 결정들을 ADR 단위로 노출하는 것이 목적이므로, 추상화를 한 단계 걷어내는 것이 일관된다.

### Trade-off

- 컨텍스트 윈도우 관리, prompt 조립, 토큰 집계 코드를 직접 작성해야 한다. 보일러플레이트가 늘어난다.
- LangChain이 제공하는 community 통합(다른 LLM provider, vector store, retriever 등)은 사용할 수 없다. 본 프로젝트는 OpenAI 단일 provider에 한정되므로 손실이 작다.
- LangChain 버전업에 따른 breaking change 추적 비용은 없어진다.

### Chizu 비교

Chizu의 채팅 생성기는 LangChain을 사용했다 (`ChatOpenAI`, `BufferWindowMemory(k=8)`, `LLMChain`, `ChatPromptTemplate`). (초안에 `k=7`로 적었던 것은 오기이며 2026-07-25 원본 저장소 대조로 정정했다. ADR-7의 「Chizu 비교 — 정정」 참고.) 단일 프로세스 Next.js 환경에서 빠른 프로토타이핑에는 적합했지만, 컨텍스트 캐시 단위가 LangChain 인스턴스에 묶이는 ADR-7의 첫 번째 한계가 여기서 나왔다. 본 프로젝트는 같은 도메인을 직접 다루면서 LangChain을 걷어내고, 메시지 단위 캐시·persistence·prompt 조립을 모두 가시화한다.

---
