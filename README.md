# SUPER_BOJ

**백준 문제 옆에 나만의 에디터를 열고, 제출 기록을 GitHub에 모아보세요.**

SUPER_BOJ는 백준을 풀 때 사용하는 Chrome 확장 프로그램입니다. 사이드 패널에서 초안을 작성하고, 제출한 풀이와 채점 결과를 다시 볼 수 있습니다.

- **에디터**에서 작성한 코드가 자동 저장됩니다. 패널을 열면 바로 편집을 시작할 수 있습니다.
- **제출 이력**에서는 확인한 제출을 하나씩 보존합니다. 같은 문제에 여러 번 도전해도 이전 소스가 남습니다.
- **GitHub**에서 저장소를 연결하고 자동 동기화를 켜면 확인한 제출이 그 저장소에 기록됩니다.

현재는 Pre-alpha 버전입니다. 확장 빌드와 설치는 아래 순서로 진행합니다. 로컬 실행, 제출 이력 연결, GitHub 동기화에는 로컬 연결 도구가 필요합니다.

## 소스에서 설치하기

소스에서 확장을 빌드하려면 Chrome 116 이상, Node.js 24 이상, 프로젝트에서 지정한 pnpm이 필요합니다.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Chrome에서 `chrome://extensions`를 열고 개발자 모드를 켭니다. **압축해제된 확장 프로그램을 로드합니다**를 선택해 `apps/extension/.output/chrome-mv3` 폴더를 지정합니다. macOS 폴더 선택 창에서 `.output`이 숨겨져 있으면 **⌘ + ⇧ + .**을 누릅니다.

## 사용 방법

1. 백준 문제를 열고 SUPER_BOJ 아이콘을 클릭합니다. **에디터**에서 초안을 작성하거나 복사할 수 있습니다.
2. **제출 준비**를 누르면 코드가 복사되고 공식 백준 제출 화면이 열립니다. 거기서 붙여넣고 직접 제출한 뒤, 채점 현황이나 제출 ID로 실제 제출을 연결합니다. **제출 이력**에서 소스와 채점 결과를 확인할 수 있습니다. [백준 제출 연동](docs/BOJ_INTEGRATION.md)
3. **GitHub**에서 저장소 주소를 입력하고 **저장소 연결**을 누릅니다. 원하는 경우 자동 동기화를 켭니다. 공개 저장소를 연결하면 동기화된 코드도 공개됩니다. [GitHub 연결과 인증](docs/GIT_SYNC.md)

### 로컬 실행과 동기화 활성화

패널의 **설정 → 로컬 실행**에서 설치 방법을 열거나, 운영체제에 맞는 설치 절차를 따르세요. 소스에서 연결 도구를 빌드할 때는 Rust stable이 필요합니다. 설치한 뒤 패널에서 **연결 테스트**를 누릅니다. [운영체제별 설치](docs/INSTALLATION.md)

로컬 실행은 현재 Rust를 지원합니다. **테스트 케이스**를 펼치면 백준 예제나 직접 입력한 테스트를 실행할 수 있습니다. 실행 코드는 사용자 계정 권한으로 동작하므로 직접 작성하고 신뢰하는 코드만 실행하세요. [보안 범위](docs/SECURITY.md)

## 검증 방법

Apple Silicon macOS의 Chrome for Testing에서 확장과 로컬 연결 도구가 통신하고 코드를 실행하는 것을 확인했습니다. 제출별 보존과 동기화 복구는 자동화 테스트로 확인했습니다. 공식 백준 계정에서의 제출과 이력 연결, 앱의 실제 GitHub 자동 푸시, Windows·Linux 실행은 이번 검증 범위에 포함되지 않았습니다. [기술 검증 기록](docs/FEASIBILITY.md)

아래 로컬 검증용 코드를 패널에 붙여넣고 **사용자 테스트 실행**을 누릅니다. 입력에 `1 2`, 예상 출력에 `3`을 넣으면 실제 출력에 `3`과 함께 `PASSED`가 표시되어야 합니다. 백준 제출이나 GitHub 연결 없이 이 검증을 수행할 수 있습니다.

```rust
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut numbers = input.split_whitespace().map(|n| n.parse::<i32>().unwrap());
    println!("{}", numbers.next().unwrap() + numbers.next().unwrap());
}
```

터미널에서는 같은 코드를 `main.rs`로 저장해 다음처럼 확인할 수 있습니다.

```sh
cargo run --locked -- doctor
printf '1 2\n' | cargo run --locked -- run main.rs
```

저장소 전체를 검증하려면 아래 명령을 실행합니다.

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cargo build --locked
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## 개발

- [아키텍처](docs/ARCHITECTURE.md)
- [빌드와 테스트](docs/DEVELOPMENT.md)
- [기술 검증 기록](docs/FEASIBILITY.md)
- [IPC 프로토콜](docs/IPC_PROTOCOL.md)
- [기여 안내](CONTRIBUTING.md)
- [MIT 라이선스](LICENSE)
