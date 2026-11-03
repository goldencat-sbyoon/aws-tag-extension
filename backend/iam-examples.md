# IAM 예시 — 배포 전 ARN을 실제 환경에 맞게 제한

`ACCOUNT_AUTHZ_JSON`에 나열된 대상 계정마다 다음을 구성합니다.

**대상 계정의 `TagPolicyReadRole` 권한 정책:**

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "organizations:DescribeEffectivePolicy",
    "Resource": "*",
    "Condition": {"StringEquals": {"organizations:PolicyType": "TAG_POLICY"}}
  }]
}
```

**대상 계정 역할 Trust Policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::BACKEND_ACCOUNT_ID:role/PolicyApiLambdaRole"},
    "Action": "sts:AssumeRole"
  }]
}
```

**백엔드 Lambda 실행 역할의 추가 권한:**

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "sts:AssumeRole",
    "Resource": [
      "arn:aws:iam::111122223333:role/TagPolicyReadRole",
      "arn:aws:iam::444455556666:role/TagPolicyReadRole"
    ]
  }]
}
```

실제 환경에서는 역할 이름, 계정, 조직 조건, 로그 권한 등도 점검해야 합니다. 각 대상 역할에서 `DescribeEffectivePolicy`를 자기 계정 기준으로 호출합니다.

## OU 탐색 기능의 관리 계정 전용 역할

Private API의 `ou_api.lambda_handler`는 `ORG_DISCOVERY_ROLE_ARN`에 설정한 역할을 AssumeRole합니다. OU 목록·하위 계정 탐색을 위해 **AWS Organizations 관리 계정**에 다음 탐색 전용 역할을 생성합니다. 사내 JWT 계정 인가 목록에 없는 계정은 API 응답에서 제외됩니다.

역할 권한 정책 예시:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "organizations:ListRoots",
      "organizations:ListOrganizationalUnitsForParent",
      "organizations:ListAccountsForParent",
      "organizations:DescribeOrganizationalUnit"
    ],
    "Resource": "*"
  }]
}
```

역할의 신뢰 정책(실제 Lambda 실행 역할 ARN으로 변경):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::BACKEND_ACCOUNT_ID:role/OUDiscoveryLambdaRole"},
    "Action": "sts:AssumeRole"
  }]
}
```

OU 탐색 Lambda 실행 역할에는 **이 역할의 ARN만** `sts:AssumeRole` 허용합니다. `OU` 탐색 역할에는 `DescribeEffectivePolicy` 권한을 부여하지 않아도 됩니다. 최종 정책은 계정별 Policy Lambda의 기존 역할에서 읽습니다.

단, `scripts/export_ou_policies.py`는 AWS 관리 계정에서 운영자가 실행하며 조직의 하위 계정에 대해 `organizations:DescribeEffectivePolicy`도 필요합니다. 이 내보내기 권한을 확장 프로그램/정책 조회 Lambda에 부여할 필요는 없습니다.
