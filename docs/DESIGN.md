# 기능 및 상세 구현 설계

## 1. 목적과 범위

AWS EC2 콘솔에서 Tag Key 입력란에 AWS Organizations Effective Tag Policy가 정의한 키를 검색·선택할 수 있도록 제공한다. Chrome과 Firefox를 동시에 지원하고 기존 사내 JWT 및 AWS 다중 계정을 지원한다.

### MVP 범위

| 기능 | 구현 상태 | 비고 |
| --- | --- | --- |
| Chrome/Firefox MV3 빌드 | 구현 | 브라우저별 Manifest 생성 |
| 사용자 ID/비밀번호 기반 사내 로그인 API 어댑터 | 구현 | 실제 API 계약에 맞게 수정 필요 |
| RS256 JWT 검증 | 구현 | JWKS 이용, Lambda Authorizer |
| 계정별 사용자/그룹 인가 | 구현 | 서버 측 allowlist |
| STS AssumeRole 후 Effective Tag Policy 조회 | 구현 | 대상 계정 역할 필요 |
| EC2 Tag Key 입력란 탐지 및 추천 UI | 초기 구현 | 실제 콘솔 DOM 테스트 필요 |
| 태그 값 제약 UI | 미구현 | API 응답에는 값 제약 정보 포함 |
| 임의 태그 키 입력 차단 | 미구현 | AWS 정책 수준의 차단과 별개 |

## 2. 사용자 흐름

1. Chrome 또는 Firefox에 확장을 설치한다.
2. 확장 팝업에서 사내 계정으로 로그인한다. 토큰은 확장 세션 스토리지에 저장한다.
3. EC2 콘솔 탭에서 확장 팝업을 열어 현재 탭에서 사용할 AWS 계정 ID 12자리를 선택한다.
4. EC2의 Tag Key 입력란에 포커스하면 확장에서 정책 API에 인증 요청을 보낸다.
5. 백엔드가 해당 사용자의 계정 접근 권한을 확인하고 계정별 Effective Policy를 반환한다.
6. 확장이 키 목록을 표시하고, 선택한 키를 AWS 기본 입력란에 전달한다.
7. 이후 리소스 생성·수정·저장은 AWS 콘솔의 기본 동작으로 수행한다.

### UX 정책

- 기존 AWS 입력란을 제거하지 않고 추천 UI만 덧붙인다.
- 정책 호출 실패 또는 태그 입력란 미검출 시 기본 AWS 화면을 정상 유지한다.
- 입력한 문자열을 기준으로 추천 키를 필터링한다.
- `valueMode=deny` 태그 키는 추천 목록에서 제외한다.
- API 응답을 계정별로 5분 캐싱한다. 로그인·로그아웃 시 캐시를 삭제한다.
- 다른 탭에서 다른 계정을 선택할 수 있으나 **실제 콘솔의 계정 ID와 사용자 선택의 일치 여부는 현재 자동 검증하지 못한다.**

## 3. 브라우저 아키텍처

| 파일 | 책임 |
| --- | --- |
| `extension/background.js` | 로그인 API 요청, JWT 보관, 계정 선택, API 호출 및 캐시 |
| `extension/popup.html/js/css` | 사용자 로그인과 탭별 계정 선택 UI |
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

## 6. 후속 개발

1. EC2 생성 및 Manage tags 화면의 DOM 셀렉터 실측 후 안정화.
2. 실제 사내 로그인 API 요청·응답 스키마 연결 및 MFA/SSO 요구 확인.
3. 계정 ID 자동 식별: 콘솔 UI 탐지의 신뢰성을 검증하고 탭별 수동 선택과 대조.
4. 태그 값 자동완성 및 와일드카드 제약 표시.
5. 중복 키·접근성·키보드 탐색·사용자 알림 강화.
6. 정책 조회 감사로그·모니터링·성능 테스트.
