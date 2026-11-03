# 배포 및 운영 가이드

## 1. 사전 준비

- 사내 로그인 API의 HTTPS URL, 요청·응답 JSON 계약 및 MFA 여부.
- JWT의 `iss`, `aud`, `scope`, `sub`, `groups`, `kid` 확인.
- JWKS URL에서 해당 RSA 공개키를 조회할 수 있는지 확인.
- AWS 백엔드 계정 및 조회 대상 계정 목록 확정.
- 대상 계정별 `TagPolicyReadRole` 준비.
- 실제 EC2 콘솔에서 확장 UI/저장 동작 검증할 테스트 계정.

## 2. Lambda 배포

`backend/requirements.txt` 의존성을 Lambda 배포 패키지에 포함한다.

- JWT Authorizer 핸들러: `authorizer.lambda_handler`
- 정책 API 핸들러: `policy_api.lambda_handler`
- 두 함수에 서로 다른 실행 역할을 부여하는 것을 권장.
- `AUTH_*`는 Authorizer Lambda에, `ACCOUNT_AUTHZ_JSON`은 정책 Lambda에 설정.
- JWT Authorizer가 JWKS에 HTTPS 접근할 수 있어야 함.

환경변수 예시 (실제 값으로 대체):

```dotenv
AUTH_ISSUER=https://auth.company.example
AUTH_AUDIENCE=aws-tag-extension-api
AUTH_JWKS_URL=https://auth.company.example/.well-known/jwks.json
AUTH_REQUIRED_SCOPE=tag-policy:read
ACCOUNT_AUTHZ_JSON={"111122223333":{"roleArn":"arn:aws:iam::111122223333:role/TagPolicyReadRole","subjects":[],"groups":["cloud-security"]}}
```

## 3. API Gateway

HTTP API를 생성하고 다음을 설정한다.

- Lambda Authorizer: REQUEST, payload format `2.0`, simple responses enabled.
- Identity source: `$request.header.Authorization`.
- 라우트: `GET /v1/accounts/{accountId}/tag-policy`.
- Integration: Policy Lambda.
- Authorizer 적용: 위 GET 라우트.
- CORS는 확장 백그라운드 요청 방식에 맞춰 검증. API 인증 우회 목적으로 `*`를 허용하지 않음.

## 4. 브라우저 확장 빌드

```bash
BUILD_LOGIN_URL=https://auth.company.example/api/login \
BUILD_API_BASE_URL=https://api.company.example \
BUILD_FIREFOX_ID=aws-tag-extension@company.example \
node scripts/build.mjs
```

- Chrome: `dist/chrome`을 개발자 모드에서 로드.
- Firefox: `dist/firefox/manifest.json`을 임시 설치. 정식 배포 시 Mozilla 서명/사내 배포 정책 확인.
- 빌드에 토큰·비밀번호·AWS 액세스 키를 포함하지 않는다.

## 5. 검증 체크리스트

- [ ] 올바른 RS256 JWT는 통과, 변조 JWT는 거부.
- [ ] 만료·잘못된 `iss/aud/scope`는 거부.
- [ ] 계정 매핑에 없는 사용자·그룹의 요청은 403.
- [ ] 대상 역할 ARN은 사용자 입력에 의해 변경되지 않음.
- [ ] 대상 계정 A/B에서 각각 Effective Tag Policy 반환.
- [ ] Chrome/Firefox에서 로그인 및 팝업 계정 선택.
- [ ] EC2 인스턴스 생성 화면의 Key 필드에 드롭다운 표시.
- [ ] 선택한 키가 실제 EC2 생성 요청/태그에 반영.
- [ ] 네트워크 오류 시 기본 AWS 콘솔이 정상 동작.
- [ ] 브라우저·계정 탭별 정책 캐시 분리.

## 6. 자동화 테스트

```bash
python3 -m pip install -r backend/requirements.txt
python3 -m unittest discover -s backend/tests -v
BUILD_LOGIN_URL=https://auth.company.example/api/login \
BUILD_API_BASE_URL=https://api.company.example node scripts/build.mjs
node --test extension/tests/*.test.mjs
```

자동화 단위 테스트만으로 실제 AWS DOM/인증 시스템 동작이 검증되지는 않는다.
