# ADR 0006 · GitHub App Device Flow 로그인

## 맥락

사용자가 Git 자격 증명을 직접 설정하지 않고도 저장소를 연결할 수 있어야 합니다. 프로젝트에는 클라이언트 비밀값을 보관할 서버가 없습니다.

## 결정

확장이 GitHub App의 Device Flow로 접근 토큰을 받습니다. 기본 배포 빌드에는 공식 [SUPER-BOJ GitHub App](https://github.com/apps/super-boj)의 공개 Client ID와 설치 링크용 앱 이름을 넣습니다. 테스트용 앱은 빌드 환경 변수로 지정할 수 있습니다.

- 매니페스트와 런타임은 GitHub 인증과 API에 필요한 HTTPS 호스트 두 개를 공통 모듈에서 가져옵니다. 기존 두 호스트만 허용하는 빌드 검사를 두고, 사이드패널은 클릭 시 로드된 매니페스트를 확인한 뒤 Chrome에 선택 권한 동의를 요청합니다.
- 토큰은 `chrome.storage.session`에만 둡니다. GitHub가 만료 시간을 주지 않으면 8시간으로 간주합니다.
- Service Worker가 선택한 원격 주소와 함께 `SET_GITHUB_AUTH`로 Core에 전달합니다. Core는 프로세스 메모리에만 보관합니다.
- Core는 `clone`, `fetch`, `push`, `ls-remote`를 실행할 때만 인증을 붙입니다. 원격 주소가 일치하고 만료 전이어야 합니다.
- 인증은 명령 인자 대신 환경 변수(`GIT_CONFIG_*`)로 해당 원격의 `http.extraHeader`에 지정하고, 그 실행에서는 사용자 자격 증명 도구를 끕니다.
- 전용 clone, 브랜치 제한, 자동 동기화 동의는 [ADR 0003](0003-managed-repository.md)을 그대로 따릅니다.

## 결과

[ADR 0003](0003-managed-repository.md)의 사용자 Git 인증 방식은 계속 쓸 수 있고, 로그인이 없을 때 적용됩니다. 브라우저를 종료하면 다시 로그인해야 합니다. 실행 중인 `git` 프로세스의 환경 변수는 같은 사용자 계정의 다른 프로세스가 읽을 수 있습니다. 실제 GitHub App을 사용한 연결과 푸시, 토큰 갱신은 확인하지 않았습니다.

[GitHub Device Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
