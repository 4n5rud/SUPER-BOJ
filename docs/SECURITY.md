# 보안과 개인정보

로컬 실행은 직접 작성하고 신뢰하는 소스를 대상으로 합니다. 솔루션은 사용자 계정 권한으로 실행되며 시스템의 파일과 네트워크에 접근할 수 있습니다. 임시 작업 디렉터리, 실행 시간·출력 제한, 자식 프로세스 정리는 실행을 관리하기 위한 장치입니다. OS 샌드박스는 적용되지 않습니다. Unix에서는 프로세스 그룹을 종료하고 Windows에서는 자식의 초기 스레드를 시작하기 전에 Job Object에 등록합니다. Windows는 마지막 Job Object 핸들이 닫히면 남은 자식을 정리합니다.

macOS에서 Chrome의 파일 격리가 상속된 경우, 해당 작업에서 코어가 컴파일한 임시 실행 파일에만 별도 처리를 적용합니다. [macOS 실행 결정](decisions/0005-macos-local-compiler-output.md)

IPC는 Chrome Native Messaging의 표준 입출력으로 연결됩니다. 호스트 등록 파일은 하나의 확장 ID origin을 허용합니다. 호스트는 버전, 요청 ID, 허용 요청, 크기를 검증합니다. 실행 명령과 인자는 Core가 언어별로 구성합니다. 임의의 실행 명령이나 환경 변수를 IPC로 전달할 수 없습니다. 자식 프로세스는 명시한 환경 변수만 상속합니다.

확장은 Manifest V3에서 등록한 백준 HTTPS 호스트와 Chrome API를 사용합니다. Monaco 스크립트와 Worker는 확장에 번들됩니다. 백준 로그인 쿠키나 비밀번호에는 접근할 필요가 없습니다.

Git 동기화가 활성화된 경우 사용자가 승인한 원격 브랜치에 실제 제출 소스와 메타데이터가 전송됩니다. 공개 GitHub 저장소의 내용은 누구나 열람할 수 있습니다. 토큰과 비밀번호는 확장 및 SQLite에서 수집하지 않습니다. 프로젝트에는 자체 수집 서버와 원격 컴파일 API가 없습니다.

[Chrome 확장 보안 지침](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

[Microsoft Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
