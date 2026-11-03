# 인증 및 보안 설계

## 신뢰 경계

1. **사내 인증 서버:** 사용자 인증 및 RS256 JWT 발급 책임.
2. **브라우저 확장:** 토큰을 보관하고 API 요청을 보냄. AWS 자격 증명을 읽지 않음.
3. **API Gateway Lambda Authorizer:** JWT 서명, `iss`, `aud`, `exp`, `iat`, `sub`, `scope` 검증.
4. **Policy Lambda:** `sub/groups`와 서버 측 계정 allowlist를 대조. 허용된 대상 IAM 역할만 AssumeRole.
5. **대상 계정:** AWS Organizations Effective Tag Policy 읽기만 허용.

## JWT 요구사항

| 변수 | 요구사항 |
| --- | --- |
| `AUTH_ISSUER` | 실제 토큰 `iss`와 정확 일치하는 HTTPS URL |
| `AUTH_AUDIENCE` | 정책 조회 API 전용 `aud` |
| `AUTH_JWKS_URL` | HTTPS JWKS 엔드포인트; 토큰 `kid`와 공개키 매칭 |
| `AUTH_REQUIRED_SCOPE` | `tag-policy:read` |

검증 알고리즘을 RS256 하나로 고정하여 알고리즘 혼동을 방지한다. JWT 원문은 로그에 기록하지 않는다. RSA 개인키는 브라우저나 Lambda에 복사하지 않으며 인증 서버에서만 관리한다.

## 세션과 자격 증명

- 브라우저 로그인 기본 구현은 자체 로그인 API에 사용자 ID/비밀번호를 직접 전송한다. MFA/SSO 요건과 실제 API 계약을 검토한 후 운영 적용한다.
- 사용자 비밀번호는 저장하지 않는다.
- Access Token은 `storage.session`에 저장하며 페이지 컨텐츠 스크립트에 전달하지 않는다.
- 로그아웃 시 저장된 토큰과 정책 캐시를 제거한다.
- 브라우저 종료 시 재인증이 필요할 수 있다. 별도의 Refresh Token 흐름은 구현하지 않았다.
- 클라이언트에서 JWT Payload를 디코딩해 만료 표시를 하지만 **신뢰할 수 있는 검증은 항상 서버에서 수행한다.**

## 계정 인가

- `ACCOUNT_AUTHZ_JSON`의 계정별 사용자/그룹 매핑으로 접근 허용.
- 매핑이 없거나 허용 사용자/그룹이 비어 있으면 기본 거부.
- 클라이언트가 지정한 계정 ID를 검증하되, 해당 계정의 ARN은 서버 매핑에서만 읽는다.
- AssumeRole 대상 ARN과 AWS 역할 신뢰 정책을 최소 권한으로 제한.
- 그룹 정보는 검증된 JWT 컨텍스트에서만 수신한다.

## 운영 권장사항

- HTTPS만 사용하고 엔드포인트·서명 키 변경을 관리한다.
- 인증 서버 JWKS 키 회전 시 기존·신규 공개키를 일정 기간 중복 제공한다.
- API Gateway 요청 제한 및 접근 로그를 적용하되 Authorization 헤더, 비밀번호, JWT는 기록하지 않는다.
- CloudWatch에서 401/403/5xx 급증 및 AssumeRole 거부를 감시한다.
- `ACCOUNT_AUTHZ_JSON`이 커지면 중앙 권한 저장소로 옮긴다.
- 브라우저 확장 업데이트, 콘솔 DOM 변화, 라이브러리 취약점 관리 절차를 마련한다.

## 비보장 사항

- 이 애드온은 AWS Tag Policy의 서버 측 강제 적용 기능을 대체하지 않는다.
- 아직 실 AWS 환경에서 인증 및 태그 저장 동작을 검증하지 않았다.
- `groups` 클레임 형태가 사내 JWT와 다르면 백엔드 매핑을 조정해야 한다.
