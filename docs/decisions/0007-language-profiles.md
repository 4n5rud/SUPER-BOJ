# ADR 0007 · 실행 언어 프로필과 환경 변수 허용 목록

## 맥락

Rust 외의 백준 제출 언어를 로컬에서 실행하면서, 임의 명령을 실행하지 않아야 합니다.

## 결정

언어별 도구 이름, 소스 파일 이름, 인자를 Core에 고정합니다. 도구는 왼쪽부터 찾습니다.

| 언어 | 도구 | 파일 | 컴파일 | 실행 |
| --- | --- | --- | --- | --- |
| `rust` | `rustc` | `main.rs` | `--edition=2021 -O` | 생성한 실행 파일 |
| `c` | `gcc-11`, `gcc`, `clang` | `Main.c` | `-O2 -Wall -std=gnu11 -DONLINE_JUDGE -DBOJ -lm` | 생성한 실행 파일 |
| `cpp` | `g++-11`, `g++`, `clang++` | `Main.cc` | `-O2 -Wall -std=gnu++17 -DONLINE_JUDGE -DBOJ -lm` | 생성한 실행 파일 |
| `python` | `python3.13`, `python3` | `Main.py` | `-W ignore -m py_compile` | `-W ignore Main.py` |
| `java` | `JAVA_HOME` 또는 PATH의 `javac`와 같은 폴더의 `java` | `Main.java` | `--release 11 -encoding UTF-8` | `-Dfile.encoding=UTF-8 -XX:+UseSerialGC -DONLINE_JUDGE=1 -DBOJ=1 -cp . Main` |

자식 프로세스에는 `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TMPDIR`, `TEMP`, `TMP`, `RUSTUP_HOME`, `CARGO_HOME`, `SDKROOT`, `SystemDrive`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`만 전달하고, 실행 단계에는 `NO_COLOR=1`을 더합니다. Windows 폴더 변수가 없으면 `rustc`가 MSVC 링커를 찾지 못해 PATH의 다른 `link.exe`를 실행했습니다.

## 결과

로컬 도구의 버전은 백준 채점 환경과 다를 수 있습니다. 예를 들어 macOS의 `gcc`는 Clang입니다. 시간 제한은 모든 언어에 같은 값을 적용합니다. 제출 준비와 이력 연결은 Rust만 지원합니다. [ADR 0001](0001-local-native-execution.md)의 로컬 컴파일 설명은 Rust 프로필에 해당합니다.
