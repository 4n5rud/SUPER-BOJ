# 기술 검증 기록

초기 작업은 기존 README만 있는 저장소에서 시작했습니다. 검증 환경은 Apple Silicon macOS이며, 운영 계정에서 백준 제출이나 GitHub Push는 수행하지 않았습니다.

| 항목 | 확인 결과 |
| --- | --- |
| BOJ 정책 | 공식 공지와 도움말 확인. 공식 화면 직접 제출과 현재 열린 페이지 읽기를 기준으로 연동을 설계했습니다. |
| BOJ 문제 및 상태 DOM | 1000번 문제의 제목과 예제 ID, 공개 상태 페이지의 결과 테이블을 확인했습니다. 로그인 후 제출 흐름은 미검증입니다. |
| Chrome API | Chrome 공식 문서에서 Side Panel과 Native Messaging 프로토콜을 확인했습니다. 확장 아이콘 동작은 Side Panel의 `openPanelOnActionClick` 설정을 사용합니다. |
| Native 프레임과 컴파일 | 실제 호스트 프로세스에 네이티브 바이트 순서의 PING 및 RUN 프레임을 전달했습니다. PONG을 받고 로컬 `rustc`로 표준 입력 `1 2`에 대해 `3`을 출력했습니다. |
| macOS 호스트 설치 | 한글 및 공백을 포함한 격리된 사용자 경로에서 설치 스크립트의 프레임 검증과 제거가 성공했습니다. |
| Git CLI | 임시 작업 저장소에서 파일을 커밋하고 로컬 bare 저장소의 `main`에 Push했습니다. 원격 ref가 커밋 SHA와 일치했습니다. GitHub 실제 인증은 미검증입니다. |
| 다른 OS | Linux와 Windows에서의 호스트 등록·제거는 CI에서 검증합니다. 현재 작업 환경에서는 macOS에서만 설치·제거를 실행했습니다. Windows x64 Rust 타입 검사는 SQLite 링크 없이 실행했으므로 Windows 설치 및 실제 실행 검증과는 범위가 다릅니다. |

## 2026-11-27 재검증

이 작업 트리에는 Rust Core, Chrome 확장, SQLite 제출 이력, Git 동기화, 설치 스크립트와 CI 워크플로가 이미 있었습니다. 기존 구현을 사용해 Phase 0의 기술 검증부터 다시 진행했습니다.

- 동일한 Rust 소스를 CLI에서 세 차례 실제로 컴파일·실행했습니다. 입력 `1 2`에 모두 `3`을 출력했습니다.
- Git CLI에서 macOS 키체인 자격 증명 도우미 설정과 프로젝트 원격의 `HEAD` 조회를 확인했습니다. 별도로 GitHub CLI의 인증 상태를 확인했습니다. Git 통합 테스트는 로컬 bare 저장소의 Push, Push 실패 후 커밋 재사용 및 커밋 복구를 검증합니다. GitHub 원격 쓰기 권한과 실제 Push는 미검증입니다.
- 병렬 Rust 테스트에서 Git 재시도의 일시적인 잠금 충돌을 확인했습니다. 중복 파일 디스크립터가 살아 있어도 작업 범위가 끝나면 잠금을 명시적으로 해제하도록 바꾸고 회귀 테스트를 추가했습니다.
- Chrome 환경에서 생성된 로컬 실행 파일의 Gatekeeper 차단을 macOS 로그와 파일 속성으로 재현했습니다. 발생 원인과 처리 범위를 별도로 기록했습니다. [macOS 실행 결정](decisions/0005-macos-local-compiler-output.md)
- 수정 후 Apple Silicon의 Chrome for Testing 159에서 한 차례 헤드리스 검증을 수행했습니다. 격리된 사용자 프로필에 호스트를 등록한 뒤 툴바 동작 설정, 사이드 패널 HTML과 Monaco 렌더링, 서비스 워커를 경유한 PING/PONG, 사용자 테스트 버튼에서 입력 `1 2`로 실제 로컬 컴파일·실행한 출력 `3`과 `PASSED` 표시를 확인했습니다. 툴바의 물리적 클릭과 실제 백준 페이지를 옆에 띄우는 동작은 이번 검증 범위에 포함되지 않았습니다.

## 남은 위험

- 로그인 상태와 소스 열람 권한에 따라 백준 DOM이 달라질 수 있습니다. 제출 ID 수동 연결 및 실제 제출 소스 대조를 유지합니다.
- 설치된 Rust의 버전·대상 운영체제가 백준 채점 환경과 다릅니다. 로컬 출력 비교 결과와 공식 채점 상태를 화면에서 구분합니다.
- Chrome에서 시작한 호스트의 PATH는 터미널과 다를 수 있습니다. 호스트의 경로 탐지와 `doctor`로 설치 환경을 확인하고, 브라우저 연결 후 검사 역시 별도로 수행합니다.
- GitHub 인증 도구와 원격 브랜치 상태는 사용자 환경에 따라 다릅니다. 로컬 커밋과 원격 Push 결과를 구분하여 복구할 수 있어야 합니다.

[Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) · [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) · [백준 언어 정보](https://help.acmicpc.net/language/info)
