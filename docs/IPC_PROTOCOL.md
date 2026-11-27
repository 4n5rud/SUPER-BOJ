# Native Messaging 프로토콜

호스트 이름은 `com.superboj.core`입니다. 각 프레임은 시스템의 네이티브 바이트 순서로 표시한 4바이트 unsigned 길이와 UTF-8 JSON으로 이루어집니다. 양방향 최대 프레임 크기는 512 KiB입니다. 길이가 잘못되었거나 프레임이 잘리면 연결이 종료됩니다.

요청에는 프로토콜 버전 1, UUID 요청 ID, 요청 종류, payload 객체를 포함합니다.

```json
{"protocolVersion":1,"requestId":"55c6f721-b304-4a89-a4b5-5a2a746baa90","type":"PING","payload":{}}
```

응답은 대응하는 요청 ID와 성공 여부를 포함합니다.

```json
{"protocolVersion":1,"requestId":"55c6f721-b304-4a89-a4b5-5a2a746baa90","type":"RESPONSE","ok":true,"payload":{"status":"PONG"}}
```

오류 응답은 `ok:false`와 `error.code`, `error.message`, `error.retryable`을 전달합니다. 연결 시작 시 `HELLO`로 버전과 언어를 확인합니다. stdout은 프레임에만 사용합니다.

응답에 다른 정수 프로토콜 버전이 있으면 확장은 `PROTOCOL_VERSION_MISMATCH`로 연결을 종료합니다. 연결이 끊기면 대기 중인 요청을 실패 처리합니다. 이후 새 요청을 받으면 100ms부터 최대 2초까지 지수적으로 대기한 뒤 다시 연결하며, `HELLO` 성공 시 대기 시간을 초기화합니다.

| 메시지 | Payload |
| --- | --- |
| `HELLO`, `PING`, `GET_TOOLCHAINS` | 빈 객체 |
| `RUN` | `jobId`, `language:"rust"`, `source`, 선택적 `stdin`, `compileTimeoutMs`, `runTimeoutMs` |
| `RUN_TESTS` | `jobId`, `language:"rust"`, `source`, `cases`의 `input` 및 선택적 `expectedOutput`, 선택적 타임아웃 |
| `CANCEL` | `jobId` |
| `CREATE_SUBMISSION_INTENT` | `intentId`, `accountContext`, `problemId`, `problemTitle`, `source` |
| `CONFIRM_SUBMISSION` | `intentId`, `submissionId`, `accountContext`, `problemId`, `source`, 선택적 `rawVerdict`, `executionTimeMs`, `memoryKb`, `submittedAt` |
| `UPDATE_VERDICT` | `accountContext`, `submissionId`, `rawVerdict`, 선택적 `executionTimeMs`, `memoryKb` |
| `GET_PENDING_INTENTS` | `accountContext`, `problemId` |
| `GET_HISTORY` | `accountContext`, 선택적 `problemId`, `before`, `limit` |
| `GET_ATTEMPT` | `accountContext`, `submissionId` |
| `CONFIGURE_REPOSITORY` | `remoteUrl`, `branch`, `autoSync` |
| `GET_GIT_STATUS` | 빈 객체 |
| `RETRY_SYNC` | 선택적 `allowPush` |
| `GET_SETTINGS` | 빈 객체 |
| `UPDATE_SETTINGS` | `verdictWaitSeconds` (0–86,400) |

요청 제한은 실행 전체에 적용됩니다. 소스 최대 256 KiB, stdin 최대 64 KiB, stdout과 stderr 각각 최대 64 KiB입니다. JSON 직렬화 결과가 프레임 한도를 넘으면 오류를 반환합니다. 컴파일은 최대 30초, 테스트 케이스별 실행은 최대 3초입니다. 여러 케이스를 요청하면 한 번 컴파일한 뒤 각 케이스를 실행하고 완료된 결과를 반환합니다.

## 제출 및 이력 응답

- 준비 요청의 `accountContext`는 실제 계정을 모르는 경우 null입니다. 확인과 이력 조회에는 명시적인 계정을 전달합니다.
- `CREATE_SUBMISSION_INTENT`는 `{intentId, sourceHash}`를 반환합니다. `GET_PENDING_INTENTS`는 `{intents: [{intentId, sourceHash, createdAt}]}`을 반환합니다.
- `CONFIRM_SUBMISSION`은 `{submissionId, duplicate}`를 반환합니다. 준비 소스와 대조한 코드가 다르면 `SUBMISSION_MISMATCH` 오류를 반환합니다.
- `UPDATE_VERDICT`는 `{submissionId, updated}`를 반환합니다. 판정 원문은 `rawVerdict`로 보존합니다.
- `GET_HISTORY`는 `{attempts, nextCursor}`를 반환합니다. 다음 페이지에는 `nextCursor`를 `before`로 전달합니다. 목록의 기본 제한은 30건이며 1–100건 범위를 지원합니다.
- `GET_ATTEMPT`는 이력 항목과 당시의 `source`를 반환합니다. 이력 항목에는 `id`, `accountContext`, `problemId`, `problemTitle`, `problemUrl`, `submissionId`, `language`, `sourceHash`, `verdict`, `rawVerdict`, `executionTimeMs`, `memoryKb`, `submittedAt`, `createdAt`, `updatedAt`, `gitStatus`, `commitSha`, `commitUrl`이 포함됩니다.

`createdAt`과 `updatedAt`은 Unix epoch 기준 UTC 초입니다. 공식 제출 시각을 알면 RFC 3339 문자열로 기록하며, 검증하지 못한 시각과 실행 시간 및 메모리는 null입니다. `sourceHash`는 `sha256:` 접두사와 64자리 소문자 16진수를 사용합니다.

## 스키마와 호환성 테스트

공개 JSON Schema는 `packages/protocol/schema/`에 있습니다. 확장은 `apps/extension/adapters/protocol.ts`를 사용해 요청과 응답을 검증합니다. 해당 모듈 변경 시 저장소 루트에서 `node apps/extension/scripts/export-protocol.mjs`를 실행하여 JSON Schema를 갱신합니다.

Vitest와 Rust Native Host 통합 테스트는 같은 `packages/protocol/fixtures/v1-requests.json` 요청을 검사합니다. 문자열의 UTF-8 바이트 제한, 소스 일치 여부, SQLite 제약과 Git 상태는 실행 시에 검증합니다.
