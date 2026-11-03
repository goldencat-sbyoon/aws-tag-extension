# 배포 및 운영 가이드

## 1. 사전 준비

- 사내 로그인 API의 HTTPS URL, 요청·응답 JSON 계약 및 MFA 여부.
- JWT의 `iss`, `aud`, `scope`, `sub`, `groups`, `kid` 확인.
- JWKS URL에서 해당 RSA 공개키를 조회할 수 있는지 확인.
- AWS 백엔드 계정 및 조회 대상 계정 목록 확정.
- 사내망/VPN과 API VPC 사이의 연결, 라우팅, DNS 확인.
- `com.amazonaws.<region>.execute-api` Interface VPC Endpoint 및 승인 CIDR 확보.
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

## 3. Private REST API Gateway

REST API를 **Private** Endpoint Type으로 생성하고 다음을 설정한다.

- Authorizer: **TOKEN** Lambda Authorizer, Token source `Authorization`.
- Authorizer Result TTL: **0초** (반환 IAM 정책이 요청의 `methodArn`에 한정됨).
- Resource: `/v1/accounts/{accountId}/tag-policy`, Method: `GET`.
- Integration: **Lambda Proxy Integration**, Policy Lambda.
- Method Authorization: **Custom Lambda Authorizer**.
- Endpoint: **Private** (Regional/Edge 최적화 아님).
- `backend/private-api-resource-policy.example.json`의 VPCE ID를 변경하고 API Resource Policy에 적용.
- API를 원하는 스테이지(예: `prod`)로 배포하고 확장 빌드 URL에 `/prod`를 포함.
- CORS는 확장 백그라운드 요청 방식에 맞춰 검증하고 인증을 우회할 수 있는 공개 메서드를 만들지 않음.

### 3-1. Interface VPC Endpoint

1. API VPC에 서비스 이름 `com.amazonaws.<region>.execute-api`, 유형 **Interface**의 VPC Endpoint를 생성.
2. VPCE의 Security Group에서 승인된 사내망/VPN 네트워크로부터 HTTPS(443)를 허용.
3. API Resource Policy에 `aws:SourceVpce` 조건으로 **해당 Endpoint ID만 허용**.
4. Private DNS 활성화 여부 및 일반 공개 execute-api 도메인에 미치는 영향을 검토.
5. 사내망에서 VPC로 연결되는 Site-to-Site VPN/Direct Connect 또는 승인된 내부 네트워크 경로와 방화벽을 구성.
6. 사내 DNS에 Route 53 Resolver Inbound Endpoint를 통한 조건부 전달 또는 검증된 VPCE DNS 경로를 구성.
7. 사내 PC에서 DNS가 사설 IP로 해석되고 VPCE에 TCP 443 연결되는지 확인.

AWS 공식 문서:

- [Private REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-apis.html)
- [Invoke a private API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-api-test-invoke-url.html)
- [REST Lambda Authorizer output](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html)

### 3-2. API 테스트

VPN 또는 사내망에서 아래와 같이 호출하여 정상 JWT로 200이 반환되는지 확인:

```bash
curl --fail-with-body -H "Authorization: Bearer <JWT>" \
  "https://<private-api-host>/<stage>/v1/accounts/<account-id>/tag-policy"
```

다음도 반드시 확인한다:

- VPN을 끈 외부 인터넷에서는 API에 접근할 수 없음.
- 승인되지 않은 VPCE에서는 접근 거부.
- 승인된 VPCE에서도 잘못된 JWT는 403 또는 Unauthorized 응답.
- 사용 권한이 없는 AWS 계정은 정책 Lambda가 403 반환.

## 4. 브라우저 확장 빌드

```bash
BUILD_LOGIN_URL=https://auth.company.example/api/login \
BUILD_API_BASE_URL=https://private-api.company.example/prod \
BUILD_FIREFOX_ID=aws-tag-extension@company.example \
node scripts/build.mjs
```

- Chrome: `dist/chrome`을 개발자 모드에서 로드.
- Firefox: `dist/firefox/manifest.json`을 임시 설치. 정식 배포 시 Mozilla 서명/사내 배포 정책 확인.
- 빌드에 토큰·비밀번호·AWS 액세스 키를 포함하지 않는다.

## 5. 검증 체크리스트

- [ ] 올바른 RS256 JWT는 통과, 변조 JWT는 거부.
- [ ] REST TOKEN Authorizer의 IAM 정책과 `principalId` 반환 확인.
- [ ] REST Lambda Proxy의 `requestContext.authorizer`에서 `sub/groups` 확인.
- [ ] VPN 미연결 상태에서 Private API 직접 호출 불가.
- [ ] 승인 VPCE만 허용하는 Resource Policy 검증.
- [ ] VPCE Security Group, 사내 DNS 및 VPN 라우팅 확인.
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
