# 00 Overview

AI 캐릭터 채팅 세션을 관리하는 NestJS + MongoDB + Redis 백엔드. 사용자가 페르소나를 설정한 캐릭터와 대화하고, 메시지 이력과 컨텍스트 윈도우, 토큰 사용량이 관리된다. LLM 응답은 SSE 스트리밍으로 전달하고, 컨텍스트 윈도우는 Redis로 캐싱하며, 같은 세션의 동시 메시지는 Redis 분산 락으로 직렬화한다.

## Background

이전에 PostgreSQL + Prisma + Express 스택으로 인터랙티브 웹툰 + AI 캐릭터 채팅 서비스를 운영했었다.

이 프로젝트는 AI 채팅 도메인만을 분리해 NestJS + MongoDB + Mongoose + Redis 스택으로 다시 설계해 구조적으로 다룬다. 새 기능을 늘리는 것보다 데이터 모델링과 운영 결정을 ADR 단위로 정리하는 것이 목표다.

## Scope

### 포함

- JWT 회원가입/로그인
- 공개/비공개 페르소나, 공개 후 잠금 정책
- 세션 생성/조회/삭제와 cursor 페이지네이션
- 메시지 이력 cursor 페이지네이션
- OpenAI Chat Completions SSE 스트리밍
- Redis 컨텍스트 캐시 + MongoDB fallback
- Redis 분산 락 (`SET NX EX` + Lua atomic release)
- 사용자 메모리 명시 등록 (Phase 1)
- 장기 대화 상태 요약 (`stateSummary`)
- 일자별 토큰 사용량 aggregation

### 제외

- WebSocket: 본 도메인은 단방향 응답이라 SSE로 충분
- 자동 사용자 메모리 추출: 상황극 오염 위험이 있어 Phase 2로 분리
- Refresh token, rate limiting, CI/CD, 분산 락 watchdog
- 모니터링, 메시지 큐, MSA: 별도 인프라 의존성이라 본 프로젝트에서는 다루지 않음

## Tech Stack

- Backend: NestJS 11, TypeScript
- Database: MongoDB (single-node replica set, transaction 지원), Mongoose 8
- Cache / Concurrency: Redis 7, ioredis
- Auth: JWT, Passport
- LLM: OpenAI Chat Completions API (`gpt-4.1-mini` 기본, env로 교체 가능)
- Streaming: Server-Sent Events
- Docs: Swagger UI (`/api`), ADR
- Test: Jest, supertest, `mongodb-memory-server`, `ioredis-mock`

## Document Map

| 문서              | 용도                                             |
| ----------------- | ------------------------------------------------ |
| `00_Overview.md`  | 프로젝트 정체성과 범위                           |
| `01_DataModel.md` | MongoDB / Mongoose 스키마, 인덱스, Redis 키 구조 |
| `02_ADRs.md`      | Architecture Decision Records                    |
| `03_API_Spec.md`  | API 엔드포인트와 처리 흐름                       |
