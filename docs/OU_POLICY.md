# OU ID/이름 기반 최종 Effective Tag Policy 조회

`DescribeEffectivePolicy`는 OU를 대상 ID로 받을 수 없습니다. 따라서 OU 및 하위 OU의 **활성 계정**을 탐색한 뒤 **계정별 최종 TAG_POLICY**를 개별 조회합니다. OU에 직접 붙은 `ListPoliciesForTarget` 결과를 최종 정책으로 사용하지 않습니다.

## 서버 모드: Private REST API → Lambda → Organizations

1. EC2 콘솔에서 확장 팝업을 열어 사내 RS256 JWT 로그인 후 `서버 연동`을 선택합니다.
2. `OU ID 또는 OU 이름`에 `ou-xxxx-yyyyyyyy` 또는 `Production`처럼 정확한 이름을 입력합니다.
3. `OU 하위 모든 계정 정책 조회`를 누릅니다.
4. 중복 OU 이름이 있을 때는 **전체 경로와 OU ID 목록**에서 선택합니다.
5. 백그라운드가 허용된 모든 활성 하위 계정의 Effective Policy를 조회합니다. 반환된 목록에서 현재 AWS 콘솔 계정을 고릅니다.
6. EC2 Tag Key 필드를 클릭하면 **선택한 해당 계정의 정책**에 맞춘 키가 표시됩니다.

### 새 API Gateway REST 경로

```text
GET /v1/organizational-units/accounts?ouId=ou-xxxx-yyyyyyyy
GET /v1/organizational-units/accounts?ouName=Production
Authorization: Bearer <RS256 JWT>
```

- `GET` + TOKEN Authorizer + Lambda Proxy 통합, `ou_api.lambda_handler`에 연결.
- 해당 Lambda 환경변수: `ACCOUNT_AUTHZ_JSON`, `ORG_DISCOVERY_ROLE_ARN`.
- OU 트리 탐색에 필요한 Organizations 호출은 **별도 발견 전용 역할**로 수행합니다.
- 응답에는 JWT의 검증된 `sub/groups`를 기반으로 서버 계정 allowlist가 허용한 계정만 포함합니다. 검색 결과에 권한 없는 OU가 노출되지 않습니다.
- 동일한 이름의 접근 가능한 OU가 두 개 이상이면 `409 OU_NAME_AMBIGUOUS`로 `matches: [{id,name,path}]`를 반환합니다.
- 계정 정책은 기존의 `GET /v1/accounts/{accountId}/tag-policy`로 **계정별 개별 JWT/권한 검증** 후 읽습니다. 팝업 백그라운드는 동시 요청을 3개로 제한합니다.
- 조회 결과 계정 목록에는 모든 활성 하위 OU의 **접근 허용된 계정**이 포함됩니다. `TAG_POLICY_NOT_FOUND` 계정은 키가 0개로 표시합니다. 하나라도 권한·AWS 오류가 발생하면 전체 완료로 보고하지 않습니다.

응답 예시 (허용된 계정에 한함):

```json
{
  "ou": {"id": "ou-abcd-12345678", "name": "Production"},
  "accounts": [
    {"accountId": "111122223333", "accountName": "App-A"},
    {"accountId": "444455556666", "accountName": "App-B"}
  ]
}
```

### 운영 시 제약

- 이름 조회는 조직 루트부터 재귀 탐색합니다. 매우 큰 조직에서는 시간이 오래 걸릴 수 있습니다. 백엔드는 안전 제한(`MAX_DISCOVERY=10000` OU/계정)을 넘으면 조용히 잘라내지 않고 `OU_DISCOVERY_LIMIT` 오류를 반환합니다.
- 대규모 OU에서는 Private REST 통합 타임아웃이나 브라우저 응답 대기 시간이 문제가 될 수 있습니다. 운영 확장이 필요하면 큐/비동기 Job + 진행 상태 API로 전환해야 합니다.
- 계정별 역할 및 `ACCOUNT_AUTHZ_JSON` 등록이 되어 있지 않다면 해당 계정은 서버 조회 목록에서 제외됩니다. 모든 조직 계정을 조회할 관리자용 내보내기 기능과 서버 사용자 조회의 인가 범위는 다릅니다.
- OU의 모든 계정을 선택하더라도 실제 AWS 콘솔 탭의 계정 일치 여부는 사용자가 확인해야 합니다. 애드온이 AWS 콘솔의 로그인 자격을 제어하지는 않습니다.

## 파일 모드: OU 전체 JSON 묶음 내보내기

AWS Organizations 관리 계정의 승인된 AWS CLI 자격 증명(또는 해당 관리 권한을 가진 역할)을 사용합니다.

```bash
# OU ID로 조회
python3 scripts/export_ou_policies.py \
  --ou-id ou-abcd-12345678 \
  --output production-ou-policies.json

# OU 이름으로 조회. 이름이 중복되면 경로/ID를 보여주고 중단합니다.
python3 scripts/export_ou_policies.py \
  --ou-name Production \
  --output production-ou-policies.json
```

AWS CLI Profile을 사용한다면 `--profile <profile-name>`을 추가할 수 있습니다. 스크립트는 `boto3`를 사용하며 `backend/requirements.txt`로 의존성을 설치합니다.

생성 파일의 구조:

```json
{
  "bundleType": "aws-tag-extension-ou-effective-policy-v1",
  "policyType": "TAG_POLICY",
  "ou": {"id": "ou-abcd-12345678", "name": "Production"},
  "generatedAt": "2026-11-04T00:00:00+00:00",
  "accounts": [
    {"accountId": "111122223333", "accountName": "App-A", "policyStatus": "ok",
     "policyUpdatedAt": null,
     "tagKeys": [{"key": "Environment", "valueMode": "allowed", "values": ["prod"], "enforcedFor": []}]}
  ]
}
```

확장 프로그램의 **파일 모드 → JSON 가져오기**에서 이 파일을 선택하면 계정별 정책을 로컬에 저장하고 계정 선택 목록을 보여줍니다. 읽기·추천에 JWT/Private API 연결은 필요 없습니다. 단, EC2 콘솔 자체는 AWS 네트워크/인증이 필요합니다.

### 무결성 및 한계

- 생성 스크립트는 각 활성 계정에 대해 `DescribeEffectivePolicy(PolicyType=TAG_POLICY, TargetId=...)`를 수행합니다. 유효 정책이 없는 계정은 `not_found`/빈 키 목록으로 표시하고, 권한 거부 같은 실패는 **내보내기를 중단**합니다.
- 파일 모드의 묶음 파일 크기는 2MiB이며 계정별 정책은 128KiB/500개 키 제한입니다. 정책이 이보다 크면 현재 구현은 가져오지 않습니다.
- 오프라인 묶음은 배포 당시 정책의 **스냅샷**입니다. 정기 재배포/서명 검증·내부 승인 경로를 운영 절차로 관리하세요.
- AWS 계정의 최종 Effective Policy는 같은 OU 내부에서도 서로 다를 수 있습니다. 모든 계정 키를 하나로 합쳐 단일 정책인 것처럼 표시하지 않습니다.

공식 API: [DescribeEffectivePolicy](https://docs.aws.amazon.com/cli/latest/reference/organizations/describe-effective-policy.html), [ListAccountsForParent](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccountsForParent.html), [ListOrganizationalUnitsForParent](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListOrganizationalUnitsForParent.html).
