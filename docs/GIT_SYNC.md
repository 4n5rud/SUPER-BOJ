# Git 동기화

Git을 설치하고 GitHub에서 접근 권한이 있는 저장소와 브랜치를 준비합니다. Git 커밋 이름과 이메일을 사용자 Git 설정에 저장합니다. HTTPS는 Git Credential Manager 또는 OS 자격 증명 도구, SSH는 기존 SSH 에이전트와 known_hosts 설정을 사용합니다. Chrome에서 시작한 호스트도 해당 인증 환경에 접근할 수 있어야 합니다. 동기화는 인증 프롬프트를 띄우지 않습니다. SSH를 사용한다면 터미널에서 GitHub 호스트 키를 확인하고 접속을 완료한 뒤 연결합니다.

## GitHub 로그인으로 연결

빌드에 GitHub App의 Client ID가 들어 있으면 GitHub 화면에 **GitHub로 연결** 버튼이 보입니다. 버튼을 누르고 표시된 코드를 GitHub에서 승인한 뒤, 쓰기 권한이 있는 저장소를 고릅니다. 저장소의 기본 브랜치에 연결합니다. 이 방식은 `https` 원격에만 적용됩니다.

Chrome에 `Only permissions specified in the manifest may be requested.`가 표시되면, 현재 확장이 요청한 권한을 Chrome이 로드된 매니페스트에서 찾지 못한 상태입니다. 개발 빌드라면 저장소 루트에서 `pnpm build`를 실행하고 `chrome://extensions`에서 SUPER_BOJ의 로드 경로가 `apps/extension/.output/chrome-mv3`인지 확인합니다. 다른 폴더가 등록되어 있으면 **압축해제된 확장 프로그램을 로드합니다**에서 해당 빌드 폴더를 선택합니다. 올바른 항목을 새로고침한 뒤 사이드패널을 닫고 다시 열어 **GitHub로 연결**을 누릅니다. 배포 ZIP을 사용한다면 최신 ZIP을 풀어 `manifest.json`이 있는 폴더를 로드합니다.

오류가 계속되면 현재 사이드패널의 개발자 도구 콘솔에서 `chrome.runtime.getManifest().optional_host_permissions`를 확인합니다. `https://github.com/*`와 `https://api.github.com/*`가 모두 있어야 합니다.

로그인 정보는 브라우저를 종료하면 사라집니다. 로그인이 없거나 만료되면 Git은 위에서 설명한 사용자 컴퓨터의 인증을 사용하므로, 그 인증이 없으면 푸시가 실패합니다. 다시 로그인한 뒤 재시도하세요. 실제 GitHub App으로 연결하고 푸시하는 과정은 아직 확인하지 않았습니다.

## 저장소 주소로 연결

Git 화면에서 `https://github.com/OWNER/REPO` 또는 `git@github.com:OWNER/REPO.git`, 이미 원격에 있는 대상 브랜치를 입력합니다. 관리 전용 clone은 운영체제별 SUPER_BOJ 데이터 디렉터리에 생성됩니다. 저장소 연결 이후 확인되는 제출이 동기화 대기열에 들어갑니다. 자동 동기화를 활성화하면 그 기록을 푸시할 수 있습니다. 자동 동기화를 끈 상태에서 수동으로 재시도하면 명시적 Push 동의가 필요합니다. 공개 저장소를 선택하면 소스와 메타데이터가 공개됩니다.

## 제출별 보존

문제 번호와 실제 제출 ID를 경로로 사용합니다.

```text
BOJ/1000/attempts/123456789/
├── main.rs      # Rust 제출 예시
└── metadata.json
```

소스 파일명은 언어별로 `main.rs`, `Main.c`, `Main.cc`, `Main.py`, `Main.java`를 사용합니다.

동일 문제에서 코드가 같은 여러 제출도 각각의 제출 ID로 보존합니다. 메타데이터에는 백준 문제 링크, 판정과 확인한 수치, 원본 소스의 SHA-256 해시가 저장됩니다. 계정 이름은 원격 메타데이터에 포함하지 않습니다. BOJ의 제출 ID가 동일한 경로에서 서로 다른 내용을 발견하면 충돌을 표시합니다.

## 복구

확정된 제출과 동기화 작업은 SQLite에 저장됩니다. 관리 clone에 기록할 경로만 스테이지하고, 최초 커밋의 식별자를 남깁니다. Push가 실패하면 이미 생성된 로컬 커밋을 재사용합니다. 재시작 시 저장 상태와 관리 clone을 대조하여 중단된 커밋 또는 Push를 재개합니다. 대기 중인 판정은 기본 300초 동안 기다리고, 그 뒤에 현재 상태로 최초 커밋을 생성할 수 있습니다. 최종 판정이 뒤늦게 확인되면 메타데이터만 바꾸는 후속 커밋을 생성합니다. 자동 재시도는 지연을 두고 최대 4회 시도합니다.

예상 외의 작업 트리 변경, 소스 해시 불일치, non-fast-forward 응답은 자동으로 덮어쓰거나 강제 푸시하지 않습니다. Git 화면에서 오류 상태를 검토하고 인증 또는 원격 상태를 바로잡은 후 수동으로 재시도합니다. Chrome과 호스트가 종료된 동안에는 동기화 작업도 중단됩니다. 연결할 저장소를 바꾸면 기존 제출과 작업은 보존되고, 그 작업은 원래 저장소를 다시 연결하면 재개됩니다.

[Git 인증](https://git-scm.com/docs/gitcredentials) · [Git Push](https://git-scm.com/docs/git-push)
