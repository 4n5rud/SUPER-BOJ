# macOS에서 로컬 컴파일 결과 실행

Chrome이 시작한 Native Host 아래에서 `rustc`가 생성한 임시 실행 파일에 Chrome의 파일 격리 속성이 상속되는 현상을 확인했습니다. Apple Silicon macOS의 Chrome for Testing에서 Gatekeeper 경고가 나타났고, 실행 요청은 제한 시간 내에 완료되지 않았습니다. 같은 소스를 터미널의 CLI로 실행하면 정상 동작했습니다. [Apple Launch Services 키](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html)

macOS에서는 성공한 로컬 컴파일 직후, 해당 작업 전용 임시 디렉터리에서 코어가 지정한 실행 파일을 엽니다. 심볼릭 링크와 하드 링크를 거부하고, 해당 파일 디스크립터에서만 상속된 `com.apple.quarantine` 속성을 제거합니다. 파일에 속성이 없으면 그대로 실행합니다. Native Host와 컴파일러의 배포 파일, 사용자 경로, 기존 Git 데이터에는 이 처리를 적용하지 않습니다. 참조한 컴파일러와 실행 권한의 신뢰 범위는 [보안 문서](../SECURITY.md)를 따릅니다.
