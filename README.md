# SUPER_BOJ

**Every attempt is a commit.**

Chrome에서 백준 문제를 보면서 Rust 코드를 작성하고, 사용자의 컴퓨터에 설치된 `rustc`로 예제와 직접 입력한 테스트를 실행하는 알고리즘 개발 도구입니다. 확인된 제출은 각각의 스냅샷으로 보존하고, 자동 동기화를 켜면 사용자가 연결한 GitHub 저장소에 기록합니다.

## 현재 상태

Pre-alpha 개발 버전입니다. Apple Silicon macOS의 Chrome for Testing에서 Native Host 연결과 로컬 Rust 실행을 검증했습니다. 제출별 스냅샷 보존, 중복 처리, Git Push 실패 후 재시도와 복구는 자동화 테스트로 검증했습니다. 공식 백준 계정에서의 수동 제출과 이력 연결, 실제 GitHub Push, Windows·Linux 실행은 이번 검증 범위에 포함되지 않았습니다. [기술 검증 기록](docs/FEASIBILITY.md)

## 소스에서 설치하기

Chrome 116 이상, Rust stable, Node.js 24 이상, `package.json`에 지정된 pnpm을 준비합니다. GitHub 동기화를 사용하려면 Git과 GitHub 인증도 준비합니다.

```sh
cargo build --locked --release
pnpm install --frozen-lockfile
pnpm build
```

1. `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 선택합니다. 저장소의 `apps/extension/.output/chrome-mv3`를 지정하고 표시된 확장 ID를 복사합니다.
2. macOS에서는 저장소 루트에서 아래 명령의 자리표시자를 확장 ID로 바꿔 실행합니다. Linux와 Windows 명령은 [Native Core 설치 문서](docs/INSTALLATION.md)를 참고하세요.

   ```sh
   bash installers/macos/install.sh '여기에_확장_ID' ./target/release/super-boj-core
   ```

3. Chrome에서 확장을 다시 로드합니다. 백준 문제 페이지를 열고 SUPER_BOJ 아이콘을 클릭합니다. 패널의 **Settings**에서 **연결 테스트**를 눌러 연결 상태와 `rustc` 버전을 확인합니다.

## 사용 방법

1. 백준 문제를 열고 **Editor**에서 Rust 코드를 작성합니다. 초안은 문제·계정 컨텍스트·언어별로 자동 저장됩니다.
2. **전체 실행**으로 예제를 실행하거나 **사용자 입력**과 **예상 출력**을 입력한 뒤 **사용자 테스트 실행**을 누릅니다. 예상 출력을 비워 두면 실행 결과만 표시됩니다. 실행 중에는 **중단**을 누를 수 있습니다.
3. **제출 준비**를 누르면 코드가 복사되고 공식 백준 제출 화면이 열립니다. 사용자가 붙여넣고 직접 제출합니다. 이후 채점 현황에서 본인 제출을 선택하거나 제출 ID를 수동으로 입력하고, 실제 제출 소스와 준비 기록을 대조해 연결합니다.
4. **History**에서 백준 계정으로 조회해 이전 제출의 채점 결과와 소스를 확인합니다. **Git**에서는 동기화할 GitHub 저장소와 브랜치를 지정하고 자동 동기화에 동의할 수 있습니다. 공개 저장소로 푸시된 소스는 누구나 볼 수 있습니다. [백준 제출 연동](docs/BOJ_INTEGRATION.md) · [Git 동기화](docs/GIT_SYNC.md)

실행 코드는 사용자 계정 권한으로 동작합니다. 로컬 실행에는 직접 작성하고 신뢰하는 코드만 사용하세요. [보안 범위](docs/SECURITY.md)

## 검증 방법

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
