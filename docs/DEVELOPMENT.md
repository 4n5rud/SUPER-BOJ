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
