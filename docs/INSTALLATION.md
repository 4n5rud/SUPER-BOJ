# Native Core 설치와 제거

Chrome 웹 스토어에서 설치한 확장은 처음 실행할 때 OS에 맞는 Core 다운로드를 제공합니다. 설치 파일을 열어 실행한 뒤 Chrome으로 돌아오면 확장이 연결을 확인합니다. 선택한 언어의 컴파일러와 인터프리터는 Core와 별도로 설치합니다.

릴리스 설치 파일은 macOS arm64·Intel용 `.pkg`, Windows x64용 `.exe`, Ubuntu 24.04 등 glibc 2.39 이상 Debian 계열 Linux x64용 `.deb`입니다. macOS와 Linux 패키지는 시스템에 Chrome Native Messaging 호스트를 등록하므로 설치 시 OS 승인이 필요합니다. Windows 설치 파일은 현재 사용자 계정에 등록합니다. 설치 파일의 서명 및 출시 환경 검증이 완료되기 전에는 개발용 수동 설치를 사용합니다.

## 개발용 수동 설치

GitHub Actions의 `super-boj-pre-alpha` 아티팩트에는 Chrome ZIP, 설치 스크립트 ZIP, 운영체제 및 CPU별 바이너리, `SHA256SUMS`가 들어갑니다. 소스에서 직접 빌드한 경우 아래 바이너리 인수에 `target/release/super-boj-core` 또는 `target/release/super-boj-core.exe`를 지정합니다.

다운로드한 파일의 SHA-256을 `SHA256SUMS`와 비교합니다. Linux에서는 `sha256sum -c SHA256SUMS`, macOS에서는 `shasum -a 256 -c SHA256SUMS`, Windows에서는 `Get-FileHash -Algorithm SHA256 -LiteralPath <파일>`로 확인할 수 있습니다.

설치 명령의 `EXTENSION_ID`는 Chrome의 확장 프로그램 관리 화면에 표시되는 a–p 범위의 영문 32자입니다. 설치 과정은 관리자 권한 없이 현재 사용자의 Chrome에 Native Host를 등록합니다.

## macOS

Bash와 Python 3이 필요합니다. `uname -m`이 `arm64`면 `super-boj-core-macos-aarch64`, `x86_64`면 `super-boj-core-macos-x86_64`를 사용합니다.

```sh
bash installers/macos/install.sh EXTENSION_ID ./super-boj-core-macos-aarch64
# 제거
bash installers/macos/uninstall.sh
```

Chrome 등록 파일은 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.superboj.core.json`에 생성됩니다. 바이너리는 `~/Library/Application Support/SUPER_BOJ/bin/super-boj-core`에 설치됩니다.

## Linux

Bash와 Python 3이 필요합니다. x86-64 Google Chrome 기준입니다.

```sh
bash installers/linux/install.sh EXTENSION_ID ./super-boj-core-linux-x86_64
# 제거
bash installers/linux/uninstall.sh
```

등록 기본 경로는 `~/.config/google-chrome/NativeMessagingHosts/com.superboj.core.json`입니다. 환경에서 `XDG_CONFIG_HOME`을 지정했다면 Chrome과 설치 스크립트에 동일하게 적용합니다. 바이너리는 `$XDG_DATA_HOME/SUPER_BOJ/bin` 또는 `~/.local/share/SUPER_BOJ/bin`에 설치됩니다.

## Windows

x64용 바이너리를 준비하고 PowerShell에서 실행합니다.

```powershell
& .\installers\windows\install.ps1 -ExtensionId EXTENSION_ID -Binary .\super-boj-core-windows-x86_64.exe
# 제거
& .\installers\windows\uninstall.ps1
```

등록 키는 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.superboj.core`입니다. 바이너리와 manifest는 `%LOCALAPPDATA%\SUPER_BOJ` 아래에 설치됩니다.

## 연결 확인

설치 후 확장을 다시 로드하고 사이드 패널에서 연결을 확인합니다. 설치 스크립트는 호스트 실행과 등록을 확인하며, Chrome에서 실제로 연결할 때 프로토콜 버전과 컴파일러를 한 번 더 확인합니다. 오류가 나면 등록된 확장 ID, Chrome 사용자 프로필, 바이너리 아키텍처, `doctor`의 컴파일러 탐지 결과를 확인합니다.

제거 스크립트는 Chrome 등록과 호스트 바이너리를 제거합니다. SQLite, 관리 Git clone, 확장에 저장된 Draft는 별도 데이터입니다.

[Chrome Native Messaging 등록 문서](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
