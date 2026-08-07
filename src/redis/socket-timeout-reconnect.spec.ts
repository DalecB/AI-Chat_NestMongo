import { AddressInfo, createServer, Server, Socket } from "net";
import Redis from "ioredis";

/**
 * ioredis socketTimeout 재연결 버그(issue #2147 / PR #2148) 회귀 테스트.
 *
 * 버그: socketTimeout 타이머가 발화 시 `this.stream`을 늦게 바인딩하고,
 * closeHandler가 타이머를 안 꺼서 → 연결이 끊겼다 재연결되면 옛 타이머가
 * 멀쩡한 새 스트림을 destroy한다.
 *
 * 이 테스트는 "수정된(=버그 없는) 거동"을 단언한다.
 *   - ioredis < 6.0.0 (설치된 5.10.1 포함): RED (옛 타이머가 새 연결을 죽임)
 *   - ioredis >= 6.0.0            : GREEN (closeHandler가 타이머를 끔)
 * 코드 변경 없이 ioredis 버전만 올리면 RED→GREEN.
 *
 * ioredis-mock가 아니라 raw TCP mock 서버를 쓴다 — 소켓 레벨 재연결은
 * ioredis-mock로 재현 불가. (ioredis 자신의 회귀 테스트와 동일한 방식)
 * 정본: test/functional/socketTimeout.ts @ ioredis v6.0.0.
 */

// 인바운드 RESP 명령에서 command 이름만 뽑는 최소 파서.
function commandName(chunk: Buffer): string {
  const lines = chunk.toString("utf8").split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] === "$") return (lines[i + 1] ?? "").toLowerCase();
  }
  return "";
}

describe("ioredis socketTimeout reconnect (issue #2147 / PR #2148)", () => {
  it("옛 소켓의 타임아웃이 재연결된 새 연결을 죽이지 않는다", async () => {
    let connectionCount = 0;
    let closeCount = 0;
    let firstSocket: Socket | undefined;
    const errors: string[] = [];
    const live: Socket[] = [];

    // 첫 소켓: ping에 응답하지 않고(hang) 20ms 뒤 소켓을 끊는다 → 재연결 유발.
    //          이때 250ms socketTimeout 타이머가 안 꺼진 채 pending으로 남는다.
    // 두 번째(교체) 소켓: ping에 +PONG로 정상 응답.
    const server: Server = createServer((socket) => {
      connectionCount += 1;
      firstSocket ??= socket;
      const isFirst = socket === firstSocket;
      live.push(socket);
      socket.on("error", () => undefined); // ECONNRESET 소음 억제
      socket.on("data", (data) => {
        if (commandName(data) !== "ping") {
          socket.write("+OK\r\n"); // 핸드셰이크 등 기타 명령은 무난히 통과
          return;
        }
        if (isFirst) {
          setTimeout(() => socket.destroy(), 20); // hang → kill
          return;
        }
        socket.write("+PONG\r\n");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const redis = new Redis({
      port,
      lazyConnect: true,
      enableReadyCheck: false,
      disableClientInfo: true, // 연결 시 CLIENT SETINFO 등 부가 명령 억제
      socketTimeout: 250,
    });
    redis.on("error", (e) => errors.push(e.message));
    redis.on("close", () => {
      closeCount += 1;
    });

    try {
      await redis.connect();
      // 첫 ping은 첫 소켓에서 hang→kill→재연결→교체 소켓이 PONG로 응답.
      expect(await redis.ping()).toBe("PONG");

      // 옛(250ms) 타이머가 발화할 시간을 준다.
      await new Promise((resolve) => setTimeout(resolve, 350));

      // 수정된 거동: 옛 타이머가 교체 소켓을 안 죽였다.
      expect(errors).toEqual([]); // 버그 시 "Socket timeout. ..." 유입
      expect(closeCount).toBe(1); // 버그 시 교체 소켓도 닫혀 2
      expect(connectionCount).toBe(2); // 버그 시 교체 소켓 재재연결로 3
      expect(redis.status).toBe("ready");
    } finally {
      redis.disconnect();
      live.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5000);
});
