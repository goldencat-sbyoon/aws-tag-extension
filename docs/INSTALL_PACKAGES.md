# 설치 패키지 다운로드 · Chrome / Firefox

이 저장소의 `downloads/`에는 Node.js 없이 설치를 시험할 수 있는 **사전 빌드 ZIP**이 있습니다. 브라우저 스토어 서명/심사를 거친 정식 배포 패키지는 아닙니다. 실제 사내 AWS 정책 파일과 EC2 콘솔의 통합 동작은 별도로 검증해야 합니다.

| 파일 | 목적 | 설치 유형 |
| --- | --- | --- |
| `downloads/aws-tag-extension-chrome-v0.1.0-offline.zip` | Chrome | 압축을 해제한 폴더를 개발자 모드에서 로드 |
| `downloads/aws-tag-extension-firefox-v0.1.0-dev.zip` | Firefox | `about:debugging`에서 임시 설치 (재시작 시 사라짐) |
| `downloads/SHA256SUMS.txt` | 무결성 확인 | ZIP의 SHA-256 해시 |
| `samples/demo-effective-policy.json` | 기능 확인용 가상 계정·태그 | **운영 정책이 아님** |

## Chrome 설치

1. ZIP을 GitHub에서 다운로드하고 압축을 풉니다.
2. Chrome 주소창에 `chrome://extensions`를 입력합니다.
3. **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 압축을 푼 폴더 중 `manifest.json`이 **바로 들어 있는 폴더**를 선택합니다.
5. AWS EC2 콘솔 탭에서 확장 팝업을 열어 `정책 파일 직접 가져오기`를 선택합니다.

공식 안내: [Chrome Load unpacked](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).

## Firefox 임시 설치

1. Firefox 주소창에 `about:debugging`을 입력하고 `This Firefox`로 이동합니다.
2. `Load Temporary Add-on`을 클릭하고 **다운로드한 Firefox ZIP 파일**을 선택합니다. ZIP을 풀었다면 `manifest.json`을 선택해도 됩니다.
3. AWS EC2 콘솔 탭에서 확장 팝업을 열어 `정책 파일 직접 가져오기`를 선택합니다.

Firefox **정식 설치에는 Mozilla 서명된 XPI**가 필요합니다. 현재 ZIP은 미서명 개발용이며 Firefox 재시작 시 임시 설치가 해제됩니다. 서명/사내 관리형 배포 전까지 일반 직원 대상 영구 설치용으로 안내하지 마세요.

공식 안내: [Firefox Temporary Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## 정책 파일 모드 사용

1. EC2 콘솔에서 현재 AWS 계정 ID를 확인합니다.
2. 팝업에 12자리 계정 ID를 입력해 설정합니다.
3. `정책 파일 직접 가져오기`를 선택하고 관리자가 전달한 **해당 계정의 Effective Tag Policy JSON** 또는 **OU 묶음 파일**을 선택합니다.
4. OU 묶음을 가져왔다면 계정 목록에서 현재 계정을 선택합니다.
5. EC2 Tag Key 입력란을 클릭해 추천 목록을 확인합니다.

`samples/demo-effective-policy.json`은 설치 동작 확인에만 쓰세요. 파일의 가상 계정 ID `111122223333`을 팝업에서 선택하면 예제 태그 키가 나타날 수 있지만, 실제 계정의 적용 정책이나 저장 허용 여부를 나타내지 않습니다.

## 이번 사전 빌드의 제약

- **사내 로그인/Private REST API URL이 미설정**되어 `.invalid`로 끝나는 안전한 자리표시자 도메인을 사용합니다. 따라서 **서버 연동 모드는 동작하지 않습니다.** 해당 기능을 쓰려면 실제 사내 URL로 `scripts/build.mjs`를 다시 실행해 배포해야 합니다.
- JWT, 비밀번호, AWS Access Key, 개인키, 실제 고객 정책 파일은 ZIP에 포함되지 않습니다.
- EC2 콘솔 자체의 접근에는 AWS 로그인 및 네트워크 연결이 필요합니다. 이 확장은 별도로 AWS 인증을 제공하지 않습니다.
- Chrome/Firefox 브라우저 업데이트나 AWS 콘솔 DOM 변경 시 UI가 동작하지 않을 수 있으며 현재 실제 AWS 화면 E2E 검증은 완료되지 않았습니다.

## 재빌드·무결성 확인

Linux/macOS 등 Node.js 20 이상과 `zip`·`sha256sum`이 있는 환경에서:

```bash
bash scripts/package-offline.sh
cd downloads
sha256sum -c SHA256SUMS.txt
```

사내 서버 연동용 빌드는 [README](../README.md)의 실제 `BUILD_LOGIN_URL`/`BUILD_API_BASE_URL` 설정을 사용하세요. `.invalid` 값은 실제 서버 인증을 위해 사용할 수 없습니다.
