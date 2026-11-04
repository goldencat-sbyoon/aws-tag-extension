# AWS Tag Extension (Chrome + Firefox)

AWS EC2 콘솔의 Tag Key 입력란에 AWS Organizations **Effective Tag Policy** 기반 추천 목록을 표시하는 확장 프로그램의 MVP입니다. **사내 Private REST API 조회**와 **정책 JSON 파일 직접 가져오기** 중 하나를 선택할 수 있습니다.

> **개발 상태:** 초기 구현 및 단위 테스트 완료. 실제 사내 인증 API와 EC2 콘솔의 DOM/저장 동작은 미검증이며 운영 배포 전 통합 테스트가 필요합니다.

## 프로젝트 문서

- [바로 다운로드할 Chrome/Firefox 설치 패키지](docs/INSTALL_PACKAGES.md)
- [기능 및 구현 설계](docs/DESIGN.md)
- [시스템 아키텍처](docs/ARCHITECTURE.md)
- [인증·보안 설계](docs/SECURITY.md)
- [배포·운영 체크리스트](docs/DEPLOYMENT.md)
- [오프라인 정책 파일 가져오기](docs/MANUAL_POLICY.md)
- [Private REST API 직접 호출 테스트](docs/PRIVATE_API_TESTING.md)
- [OU ID/이름 및 하위 계정 최종 정책 조회](docs/OU_POLICY.md)

## 구성

- `extension/`: 브라우저 공통 WebExtensions 코드. Chrome/Firefox Manifest V3 별도 빌드.
- `backend/authorizer.py`: 사내 RS256 JWT를 JWKS로 검증하는 **Private REST API** TOKEN Lambda Authorizer (IAM Policy 응답).
- `backend/policy_api.py`: JWT 사용자 권한을 확인하고 계정별 AWS Organizations Effective Tag Policy 조회.
- `backend/ou_api.py`, `backend/org_core.py`: OU ID/이름 탐색 및 하위 활성 계정 조회. JWT 계정 권한에 따라 결과 필터링.
- `scripts/export_ou_policies.py`: 관리자가 OU의 모든 활성 계정 최종 정책을 하나의 오프라인 JSON으로 추출.
- `scripts/build.mjs`: `dist/chrome`, `dist/firefox` 패키지 생성.

## 로컬 빌드

Node.js 20+ 필요. `BUILD_LOGIN_URL`과 `BUILD_API_BASE_URL`은 브라우저 확장에 포함되는 **공개 엔드포인트**이며 비밀값을 넣으면 안 됩니다.

**정책 파일 모드만 사용한다면** 미리 빌드된 `downloads/` ZIP을 사용할 수 있습니다. [설치 안내](docs/INSTALL_PACKAGES.md)를 참고하세요. 이 ZIP은 서버 URL이 `.invalid`인 개발·테스트용이므로 사내 JWT/Private API 로그인은 작동하지 않습니다.

```bash
BUILD_LOGIN_URL=https://auth.company.example/api/login \
BUILD_API_BASE_URL=https://private-api.company.example/prod \
node scripts/build.mjs
```

Chrome: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`.
Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`.

EC2 콘솔에서 팝업을 열고 상단에서 **정책 파일** 또는 **API 연동** 중 하나만 선택합니다. 선택한 방식에 필요한 입력란만 나타납니다. 탭별로 서로 다른 계정 및 정책 소스를 선택할 수 있으며, 실제 AWS 콘솔 계정과 일치하는지 확인해야 합니다. 이 선택은 UI 설정일 뿐이며 **API 모드에서는 백엔드가 별도로 계정별 인가를 수행**합니다.

**API 연동 모드:** 사내 로그인 API로 인증하고 JWT를 사용해 Private REST API Gateway를 호출합니다. 로그인 뒤 **AWS 계정 ID** 또는 **OU 이름/ID** 조회 중 하나를 선택합니다. 계정 ID는 즉시 해당 계정의 최종 정책을 조회하고, OU는 하위 계정별 최종 정책을 조회한 뒤 적용할 계정을 선택합니다. 사내망/VPN과 VPCE 연결이 필요합니다.

**정책 파일 모드:** 사내 담당자가 AWS Organizations에서 내려받은 **계정별 Effective Tag Policy JSON** 또는 OU 묶음을 선택합니다. JSON에 계정 ID가 있으면 **자동으로 식별·적용**하며, ID 없는 원시 `tags` JSON에서만 12자리 계정 ID를 추가로 입력합니다. 정책 키 조회에 **VPN·API Gateway·JWT가 필요하지 않으며**, 파일은 확장 로컬 저장소에 계정별로 저장됩니다. [정책 파일 추출 및 배포 안내](docs/MANUAL_POLICY.md)를 참조하세요.

**OU ID 또는 이름 조회:** API 모드의 `OU 이름 / ID`를 선택해 조회하면 계정별 권한을 확인하고 최종 정책을 모두 가져온 뒤 계정을 선택할 수 있습니다. 파일 모드에서는 관리자가 `scripts/export_ou_policies.py --ou-id ... --output ...` 또는 `--ou-name ...`으로 OU 전체 JSON 묶음을 생성하여 전달합니다. OU는 `DescribeEffectivePolicy`에 직접 지정할 수 없어 하위 계정마다 조회합니다. [OU 가이드](docs/OU_POLICY.md)를 참고하세요.

간소화된 팝업에서는 진단용 버튼을 숨겼습니다. **API 연동 → AWS 계정 ID → 계정 정책 가져오기**가 실제 Private API 호출 테스트 역할도 합니다. 별도 직접 GET·네트워크 진단은 [실제 호출 테스트 가이드](docs/PRIVATE_API_TESTING.md)를 참고하세요.

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

**API Gateway**: REST API (`Endpoint Type=PRIVATE`), `GET /v1/accounts/{accountId}/tag-policy` → Lambda Proxy Integration `policy_api.lambda_handler`; TOKEN Lambda Authorizer → `authorizer.lambda_handler`; Token source `Authorization`. `backend/private-api-resource-policy.example.json`의 `aws:SourceVpce` 조건을 실제 VPCE ID로 변경하여 리소스 정책을 적용합니다. REST TOKEN Authorizer가 요청별 `methodArn`에 대한 IAM 정책을 반환하므로 **Authorizer 결과 캐싱 TTL은 0초**로 구성합니다. JWT 인증 없는 공개 경로는 만들지 않습니다.

OU 기능을 위해 `GET /v1/organizational-units/accounts` → `ou_api.lambda_handler`를 같은 Private REST API 및 TOKEN Authorizer 아래 추가합니다. 별도 `ORG_DISCOVERY_ROLE_ARN`(관리 계정의 OU 탐색 전용 역할)이 필요하며 역할의 IAM/배포 방법은 [OU 가이드](docs/OU_POLICY.md) 및 [IAM 예시](backend/iam-examples.md)를 참고하세요.

사용자 PC는 사내망/VPN에 연결되어 있어야 하고, 사내 DNS와 네트워크가 `execute-api` Interface VPC Endpoint를 올바르게 해석·라우팅해야 합니다. Private API는 인터넷에서 직접 호출할 수 없으며, 사내망/VPN 연결만으로 통신이 자동 보장되는 것도 아닙니다. 네트워크 구성은 [배포 가이드](docs/DEPLOYMENT.md)를 참고하세요.

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
