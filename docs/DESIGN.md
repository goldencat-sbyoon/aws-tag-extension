# 기능 및 상세 구현 설계

## 1. 목적과 범위

AWS EC2 콘솔에서 Tag Key 입력란에 AWS Organizations Effective Tag Policy가 정의한 키를 검색·선택할 수 있도록 제공한다. Chrome과 Firefox를 동시에 지원하고 기존 사내 JWT 및 AWS 다중 계정을 지원한다.

### MVP 범위

| 기능 | 구현 상태 | 비고 |
| --- | --- | --- |
| Chrome/Firefox MV3 빌드 | 구현 | 브라우저별 Manifest 생성 |
| 사용자 ID/비밀번호 기반 사내 로그인 API 어댑터 | 구현 | 실제 API 계약에 맞게 수정 필요 |
| RS256 JWT 검증 | 구현 | JWKS 이용, REST TOKEN Lambda Authorizer |
| 계정별 사용자/그룹 인가 | 구현 | 서버 측 allowlist |
| STS AssumeRole 후 Effective Tag Policy 조회 | 구현 | 대상 계정 역할 필요 |
| 오프라인 Effective Tag Policy JSON 가져오기 | 구현 | JWT·Private API 없이 계정별 로컬 저장 |
| 정책 소스 선택 | 구현 | EC2 콘솔 탭별 서버/파일 모드 선택 |
| OU ID/이름 탐색 및 하위 계정 정책 조회 | 구현 | 서버 모드: JWT 계정 인가, 계정별 정책 로드 |
| OU 전체 정책 JSON 내보내기·가져오기 | 구현 | 파일 모드: 관리자가 내보낸 계정별 묶음 JSON |
| EC2 Tag Key 입력란 탐지 및 추천 UI | 초기 구현 | 실제 콘솔 DOM 테스트 필요 |
| 태그 값 제약 UI | 미구현 | API 응답에는 값 제약 정보 포함 |
| 임의 태그 키 입력 차단 | 미구현 | AWS 정책 수준의 차단과 별개 |

## 2. 사용자 흐름

1. Chrome 또는 Firefox에 확장을 설치하고 EC2 콘솔에서 팝업을 연다.
2. 첫 화면에서 **정책 파일 / API 연동** 중 하나를 선택한다. 다른 입력란은 접는다.
3. API 연동은 사내 로그인 후 **AWS 계정 ID / OU 이름·ID** 중 하나를 선택한다. 계정 ID는 해당 계정 정책을 즉시 가져오고, OU는 모든 하위 계정 정책을 조회한 다음 적용 계정을 선택한다.
4. 파일 모드는 Effective Tag Policy 또는 OU 묶음 JSON을 가져온다. 포함된 계정 ID를 자동 인식하고, 정보 없는 원시 JSON에서만 ID를 입력한다. 로그인/정책 서버 연결 없이 로컬 정책을 읽는다.
5. EC2의 Tag Key 입력란에 포커스하면 선택한 소스의 키 목록을 드롭다운으로 표시한다.
6. 선택한 키를 AWS 기본 입력란에 전달하고 실제 저장은 AWS 콘솔에서 수행한다.

### UX 정책

- 기존 AWS 입력란을 제거하지 않고 추천 UI만 덧붙인다.
- 정책 호출 실패 또는 태그 입력란 미검출 시 기본 AWS 화면을 정상 유지한다.
- 입력한 문자열을 기준으로 추천 키를 필터링한다.
- `valueMode=deny` 태그 키는 추천 목록에서 제외한다.
- API 응답을 계정별로 5분 캐싱한다. 로그인·로그아웃 시 캐시를 삭제한다.
- 팝업의 진단 전용 버튼은 없애고 `계정 정책 가져오기` 성공 시 태그 키 개수를 표시한다. 백그라운드의 `TEST_CONNECTION` 진단 호출은 개발·테스트용으로 유지한다.
- Private REST API 호출은 10초 타임아웃을 사용한다. 네트워크 실패·Gateway 거부·계정 인가 실패를 구분한다.
- 다른 탭에서 다른 계정을 선택할 수 있으나 **실제 콘솔의 계정 ID와 사용자 선택의 일치 여부는 현재 자동 검증하지 못한다.**
- 파일 모드는 계정별 로컬 정책을 사용하며 128KiB·500키 제한, 원본 병합 연산자 미지원. 최신 정책은 사용자가 다시 가져와야 한다.
- AWS CLI 응답의 `EffectivePolicy.TargetId` 또는 `accountId`를 자동 인식해 현재 탭의 선택 계정으로 설정한다. 순수 `tags` JSON에는 계정 정보가 없어 사용자에게 ID 입력을 요청한다. 사용자가 명시한 ID와 파일 내부 ID가 충돌하면 거부한다.
- OU를 직접 `DescribeEffectivePolicy` 대상으로 사용하지 않는다. 활성 하위 계정마다 최종 정책을 읽고 UI에서 현재 계정을 선택한다. 이름 중복 시 OU 경로·ID를 표시한다.

## 3. 브라우저 아키텍처

| 파일 | 책임 |
| --- | --- |
| `extension/background.js` | 로그인 API 요청, JWT 보관, 계정·소스 선택, OU 계정 정책 조회 및 로컬 파일 정책 관리 |
| `backend/ou_api.py` | 별도 탐색 역할로 OU 재귀 탐색, 허용된 계정만 반환 |
| `scripts/export_ou_policies.py` | 전체 활성 OU 계정의 Effective Policy JSON 묶음 생성 |
| `extension/popup.html/js/css` | 로그인, 계정·소스 선택, JSON 파일 가져오기 UI |
| `extension/content.js` | EC2 입력란 감지, 드롭다운 부착, 기본 입력값 업데이트 |
| `scripts/build.mjs` | Chrome/Firefox 개별 Manifest·설정 생성 |

Chrome은 MV3 Service Worker, Firefox는 MV3 Background Scripts를 사용한다. API 호출을 백그라운드 컨텍스트로 제한하여 AWS 페이지에서 JWT를 직접 취급하지 않는다.

## 4. 정책 데이터 계약

요청: `GET /v1/accounts/{accountId}/tag-policy`, `Authorization: Bearer <access_token>`.

응답 예시:

```json
{
  "accountId": "111122223333",
  "policyUpdatedAt": "2026-11-04T01:00:00+00:00",
  "tagKeys": [
    {"key": "CostCenter", "valueMode": "any", "values": [], "enforcedFor": []},
    {"key": "Environment", "valueMode": "allowed", "values": ["dev", "prod"], "enforcedFor": ["ec2:instance"]}
  ]
}
```

| 필드 | 의미 |
| --- | --- |
| `accountId` | 조회 대상 계정 |
| `policyUpdatedAt` | AWS가 반환한 정책 변경 시각. 없을 수 있음 |
| `tagKeys[].key` | 정확한 태그 키 대소문자 |
| `valueMode=any` | 태그 값 목록이 정의되지 않음 |
| `valueMode=allowed` | 지정된 허용 값 또는 패턴 존재 |
| `valueMode=deny` | 빈 태그 값 목록으로 해당 키의 값이 모두 부적합 |
| `enforcedFor` | AWS 정책의 적용 대상 리소스 배열 |

Effective Policy는 상속·병합된 결과이므로 `@@assign` 같은 원본 정책 연산자를 다시 병합하지 않는다. 같은 이름의 태그 키라도 대소문자를 정확히 보존한다. 정책은 **정의된 키에 대한 표준화 규칙**이며, 여기에 없는 다른 키의 사용이 자동으로 금지되지는 않는다.

## 5. HTTP 오류 계약

| 상태 | 오류 코드 | 클라이언트 UX |
| --- | --- | --- |
| 200 | - | 태그 키 목록 표시 |
| 400 | `INVALID_ACCOUNT_ID` | 12자리 계정 ID 확인 |
| 401 | Authorizer 단계 거부 | 다시 로그인 |
| 403 | `ACCOUNT_ACCESS_DENIED` | 선택 계정 접근 불가 |
| 404 | `TAG_POLICY_NOT_FOUND` | 기본 AWS 입력 유지 |
| 502 | `AWS_POLICY_UNAVAILABLE`, `POLICY_ROLE_ACCESS_DENIED` | 기본 AWS 입력 유지, 운영 로그 확인 |

## 5-1. REST API 전환에 따른 요청 구조

- TOKEN Authorizer 입력: `event.authorizationToken` 및 `event.methodArn`.
- TOKEN Authorizer 출력: `principalId`, `policyDocument`(Allow/Deny), `context`(sub, groups).
- 정책 Lambda 입력: `event.requestContext.authorizer.sub/groups`와 `event.pathParameters.accountId`.
- API Gateway REST API Endpoint Type은 Private로, 허용된 VPCE만 접근하도록 Resource Policy에서 통제.
- 확장 프로그램의 요청 URL에는 REST API 스테이지 경로를 포함.

## 6. 후속 개발

1. EC2 생성 및 Manage tags 화면의 DOM 셀렉터 실측 후 안정화.
2. 실제 사내 로그인 API 요청·응답 스키마 연결 및 MFA/SSO 요구 확인.
3. 계정 ID 자동 식별: 콘솔 UI 탐지의 신뢰성을 검증하고 탭별 수동 선택과 대조.
4. 태그 값 자동완성 및 와일드카드 제약 표시.
5. 중복 키·접근성·키보드 탐색·사용자 알림 강화.
6. 정책 조회 감사로그·모니터링·성능 테스트.

실제 VPN 경유 호출 절차는 [Private API 테스트 가이드](PRIVATE_API_TESTING.md)를 참고.
오프라인 배포·파일 가져오기는 [수동 정책 파일 가이드](MANUAL_POLICY.md)를 참고.
OU ID/이름과 하위 계정 정책 조회는 [OU 가이드](OU_POLICY.md)를 참고.
