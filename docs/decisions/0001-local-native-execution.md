# ADR 0001 · Chrome Native Messaging을 통한 로컬 실행

## 맥락

Chrome에서 문제를 보면서 일반 사용자 권한으로 설치된 로컬 컴파일러를 실행해야 합니다. 확장 및 Core가 수집하는 코드와 시도 정보의 보관 위치를 사용자가 통제합니다.

## 결정

Chrome Side Panel과 Native Messaging을 사용합니다. Rust 호스트는 표준 입출력으로 프레임을 처리합니다. 최대 프레임은 양방향 512 KiB로 제한하고 동시 실행 작업은 한 건으로 제한합니다. 진단과 단일 파일 실행은 같은 바이너리의 명시적 CLI 하위 명령으로 제공하며, Chrome은 등록한 바이너리를 바로 실행합니다.

로컬 컴파일은 임시 디렉터리에서 `rustc --edition=2021`을 실행합니다. 백준의 Rust 채점 버전과 옵션은 별개의 실행 환경입니다. 출력 비교는 CRLF를 LF로 바꾸고 마지막 LF 하나를 제거한 후 비교합니다. 내부 공백은 보존합니다.

## 결과

Chrome 세션과 로컬 저장소의 수명은 다릅니다. 중요한 상태는 SQLite 또는 Chrome Storage에 적시에 저장합니다. 실행 중인 자식 프로세스 정리는 OS별로 검증합니다. 별도의 설치 절차를 통해 Chrome Native Host와 정확한 확장 ID를 연결합니다.

[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
