# AWS Tag Extension (Chrome + Firefox)

AWS EC2 콘솔의 Tag Key 입력란에 AWS Organizations **Effective Tag Policy** 기반 추천 목록을 표시하는 확장 프로그램의 MVP입니다.

> **개발 상태:** 초기 구현 및 단위 테스트 완료. 실제 사내 인증 API와 EC2 콘솔의 DOM/저장 동작은 미검증이며 운영 배포 전 통합 테스트가 필요합니다.

## 프로젝트 문서

- [기능 및 구현 설계](docs/DESIGN.md)
- [시스템 아키텍처](docs/ARCHITECTURE.md)
- [인증·보안 설계](docs/SECURITY.md)
- [배포·운영 체크리스트](docs/DEPLOYMENT.md)

## 구성

- `extension/`: 브라우저 공통 WebExtensions 코드. Chrome/Firefox Manifest V3 별도 빌드.
- `backend/authorizer.py`: 사내 RS256 JWT를 JWKS로 검증하는 API Gateway HTTP API Lambda Authorizer (payload 2.0 simple response).
- `backend/policy_api.py`: JWT 사용자 권한을 확인하고 계정별 AWS Organizations Effective Tag Policy 조회.
- `scripts/build.mjs`: `dist/chrome`, `dist/firefox` 패키지 생성.

## 로컬 빌드

Node.js 20+ 필요. `BUILD_LOGIN_URL`과 `BUILD_API_BASE_URL`은 브라우저 확장에 포함되는 **공개 엔드포인트**이며 비밀값을 넣으면 안 됩니다.

```bash
BUILD_LOGIN_URL=https://auth.company.example/api/login \
BUILD_API_BASE_URL=https://api.company.example \
node scripts/build.mjs
```

Chrome: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`.
Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`.

EC2 콘솔 탭에서 로그인 후 팝업에서 **조회할 AWS 계정 ID 12자리**를 설정합니다. 탭별로 서로 다른 계정 ID를 선택할 수 있으며, 실제 AWS 콘솔의 계정 ID와 일치하는지 사용자가 확인해야 합니다. 이 계정 선택은 UI 설정일 뿐이며 서버에서 별도로 인가합니다. 향후 콘솔 계정 식별 신뢰성을 검증한 후 자동 전환 기능을 추가할 수 있습니다.

실제 내부 인증 API 계약이 확정되면 `extension/background.js`의 `authenticate()` 요청/응답 매핑을 조정하세요. 현재는 `POST {username,password}` → `{access_token}`을 가정합니다. 비밀번호는 저장하지 않습니다. Access Token은 확장 세션 스토리지에만 보관합니다.

## 백엔드 구성

Python 3.12+, 배포 의존성: `backend/requirements.txt` (`boto3`, `PyJWT[crypto]`). Lambda와 의존성을 함께 패키징합니다.

**JWT Authorizer 환경변수**

| 변수 | 예시/용도 |
| --- | --- |
| `AUTH_ISSUER` | `https://auth.company.example` (`iss` 정확 일치) |
| `AUTH_AUDIENCE` | `aws-tag-extension-api` (`aud` 검증) |
| `AUTH_JWKS_URL` | `https://auth.company.example/.well-known/jwks.json` (HTTPS 필수) |
| `AUTH_REQUIRED_SCOPE` | `tag-policy:read` |

**Policy API 환경변수**

| 변수 | 용도 |
| --- | --- |
| `ACCOUNT_AUTHZ_JSON` | 서버 측 AWS 계정→허용 사용자/그룹/역할 ARN 매핑 (아래 예시) |

```json
{
  "111122223333": {
    "roleArn": "arn:aws:iam::111122223333:role/TagPolicyReadRole",
    "subjects": ["employee-12345"],
    "groups": ["cloud-security"]
  }
}
```

`subjects` 또는 `groups` 중 한 조건에 매칭돼야 접근할 수 있습니다. 둘 다 빈 배열이면 **접근 거부**입니다. 역할 ARN은 서버 설정에서만 선택하며 클라이언트 요청 값을 사용하지 않습니다. 실제 서비스에서는 대규모 매핑을 환경변수 대신 Parameter Store/DynamoDB 등으로 옮기세요.

**API Gateway**: HTTP API, `GET /v1/accounts/{accountId}/tag-policy` → `policy_api.lambda_handler`; Lambda Authorizer (REQUEST, payload format 2.0, simple response) → `authorizer.lambda_handler`; identity source `$request.header.Authorization`; JWT 인증 없는 공개 경로는 만들지 않습니다. Authorizer 캐시를 사용한다면 토큰 만료 및 권한 변경 지연을 고려해 TTL을 짧게 설정하세요.

**정책 조회 Lambda 역할**은 `sts:AssumeRole`을 지정한 대상 역할 ARN으로만 허용합니다. 각 대상 계정의 `TagPolicyReadRole` trust policy는 백엔드 실행 역할만 신뢰하도록 지정하고, 대상 역할에 `organizations:DescribeEffectivePolicy` (`TAG_POLICY` 조건) 읽기 권한을 부여합니다. 자세한 정책 예시는 `backend/iam-examples.md`.

사내 JWKS가 AWS 측에서 HTTPS로 접근 가능해야 합니다. 사내망 전용이라면 Lambda Authorizer 네트워크 연결/VPC 구성이 필요합니다.

## 보안 및 동작 정책

- 확장 프로그램은 AWS 콘솔의 쿠키/자격 증명을 읽지 않습니다.
- EC2 화면에는 태그 값만 입력하고 AWS 생성/수정 API는 직접 호출하지 않습니다.
- **JWT만 유효하다고 모든 계정에 접근할 수 없습니다.** 정책 Lambda가 `sub`, `groups` 및 서버 설정 매핑으로 계정별 인가를 검사합니다.
- 초기 UI는 추천형입니다. Tag Policy에 없는 키를 API 차원에서 차단하지 않습니다.
- 콘솔 DOM 구조는 바뀔 수 있으므로 실제 AWS EC2 인스턴스 생성/Manage tags 화면에서 선택·저장 E2E 검증이 필요합니다.
- `tag_value` 부재(모든 값 허용)와 빈 배열(모든 값 거부)을 구분합니다.

## 검증

```bash
python3 -m unittest discover -s backend/tests -v
node --test extension/tests/*.test.mjs
```

실제 사내 인증 서버, AWS 계정 및 EC2 콘솔에 연결한 통합 테스트는 아직 수행하지 않았습니다.
