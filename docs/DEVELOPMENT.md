# 개발 환경

Rust stable, Node.js 24 이상, 프로젝트 `packageManager` 필드에 지정된 pnpm, Chrome, Git이 필요합니다. Unix 네이티브 설치 검증에는 Bash와 Python 3을 사용합니다.

```sh
cargo build --locked --release
pnpm install --frozen-lockfile
pnpm build
```

`chrome://extensions`에서 개발자 모드를 활성화하고 `apps/extension/.output/chrome-mv3`를 불러옵니다. 그 화면에서 ID를 확인한 뒤 [호스트 등록](INSTALLATION.md)을 진행합니다.

Chrome은 unpacked 확장의 설치 경로에 따라 ID를 정할 수 있습니다. 같은 경로를 계속 사용하거나, 조직에서 관리하는 공개 키의 Base64 DER을 빌드 환경의 `SUPER_BOJ_EXTENSION_KEY`로 제공해 ID를 고정합니다. Chrome Web Store 배포에 사용하는 개발용 빌드에는 해당 등록 항목의 공개 키를 사용합니다. 개인 키는 저장소에 포함하지 않습니다. [Chrome manifest key 문서](https://developer.chrome.com/docs/extensions/reference/manifest/key)

## 검증

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

수동 연결은 새 Chrome 테스트 프로필에서 수행합니다. 사용자가 작성한 간단한 프로그램을 편집기에 입력하고 예제를 실행합니다. 공식 제출 버튼 클릭과 운영 GitHub 푸시는 테스트용 계정과 저장소를 명시적으로 준비한 환경에서 확인합니다.

## 릴리즈 빌드

`Pre-alpha artifacts` 워크플로는 수동 실행 또는 `v*` 태그 푸시로 실행됩니다. OS별 CI와 확장 CI를 통과한 상태에서 바이너리, 확장 ZIP, 설치 스크립트 ZIP을 생성하고 SHA-256 검사를 수행합니다. 결과는 실행 화면의 Actions 아티팩트에 저장됩니다. Chrome Web Store 배포에는 스토어 계정과 별도 검수가 필요합니다.

## GitHub 로그인 빌드 설정

확장을 빌드할 때 아래 환경 변수를 주면 GitHub 로그인이 켜집니다. 값이 없으면 로그인 화면을 숨깁니다. 두 값 모두 공개해도 되는 식별자이며, 클라이언트 비밀값은 사용하지 않습니다.

기본 빌드는 공식 [SUPER-BOJ GitHub App](https://github.com/apps/super-boj)의 공개 Client ID와 앱 이름을 사용합니다. 별도 GitHub App으로 테스트할 때는 아래 두 값을 함께 지정합니다.

- `SUPER_BOJ_GITHUB_CLIENT_ID`: GitHub App의 Client ID
- `SUPER_BOJ_GITHUB_APP_SLUG`: GitHub App의 URL 이름(저장소 추가 링크에 사용)

GitHub App에는 Device Flow를 켜고 저장소 내용의 쓰기 권한을 줍니다. 릴리스 워크플로는 같은 이름의 저장소 변수를 읽습니다. 실제 App으로는 아직 확인하지 않았습니다.


## 웹 스토어용 Core 배포

Chrome 웹 스토어 개발자 대시보드에서 확인한 32자 확장 ID를 GitHub Actions 저장소 변수 `SUPER_BOJ_STORE_EXTENSION_ID`로 설정합니다. 릴리스 워크플로는 이 ID로 각 설치 파일의 Native Messaging 허용 대상을 고정하고 확장 빌드에 같은 값을 전달합니다. 설치 링크는 이 ID로 실행되는 확장에 표시됩니다. `v*` 태그 빌드가 성공하면 결과물이 GitHub Release에 올라갑니다. 작업 실행으로 패키지를 먼저 만들어 비공개 테스트에 사용할 수 있습니다.

공개 배포 전 macOS 설치 파일의 서명과 공증, Windows 설치 파일의 서명, 각 운영체제의 새 Chrome 프로필에서 설치 및 자동 연결을 확인합니다.
