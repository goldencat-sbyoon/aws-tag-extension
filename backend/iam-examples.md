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
