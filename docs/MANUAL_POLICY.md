# 오프라인 정책 파일 모드 (Chrome/Firefox)

사내 VPN이나 Private REST API Gateway에 연결할 수 없는 사용자에게 **확장 프로그램 설치 패키지와 계정별 Effective Tag Policy JSON 파일**을 제공하는 방식입니다. 파일을 읽고 드롭다운을 표시하는 과정에서 로그인 API, API Gateway, Lambda, AWS API로 요청하지 않습니다.

## 1. 정책 관리자: JSON 파일 생성

AWS CLI에 `organizations:DescribeEffectivePolicy` 권한이 있는 IAM 역할로 로그인한 뒤, **각 대상 계정에 적용된 최종 TAG_POLICY**를 내보냅니다.

```bash
aws organizations describe-effective-policy \
  --policy-type TAG_POLICY \
  --target-id 111122223333 \
  --output json > effective-tag-policy-111122223333.json
```

위 예시는 AWS Organizations 관리 계정에서 특정 계정의 정책을 조회합니다. 멤버 계정에서 자기 정책을 조회할 때는 해당 계정의 AWS 권한·조직 설정에 맞춰 `--target-id` 사용을 검토하세요.

- **전체 CLI 응답 JSON**을 그대로 배포하는 방식을 권장합니다. 내부 `EffectivePolicy.TargetId`를 통해 계정 불일치를 감지할 수 있습니다.
- `PolicyType=TAG_POLICY` 및 `PolicyContent`를 검증합니다.
- 원본 `describe-policy`/`list-policies` 응답은 정책 상속·병합 전 상태이므로 가져오지 않습니다.
- 정책 내용에 내부 조직 표준·계정별 정보가 있을 수 있으므로 사내 승인된 경로로만 배포합니다.
- 배포 전에 AWS 계정 ID, 키 목록, 최신 갱신 일자를 검증하고 가능하면 파일 무결성(서명·체크섬)을 별도 관리합니다.

AWS CLI 참고: [describe-effective-policy](https://docs.aws.amazon.com/cli/latest/reference/organizations/describe-effective-policy.html).

## 2. 사용자: 설치 및 파일 가져오기

1. Chrome 또는 Firefox에 사내에서 전달받은 확장 프로그램을 설치합니다.
2. 해당 AWS 계정의 **EC2 콘솔 탭**을 엽니다.
3. 확장 프로그램 팝업에서 **AWS 계정 ID(12자리)**를 입력하고 `조회 대상 계정 설정`을 클릭합니다.
4. `태그 정책 가져오기 방식`을 **정책 파일 직접 가져오기**로 변경합니다.
5. `Effective Tag Policy JSON 파일`에서 관리자가 전달한 JSON 파일을 선택합니다.
6. `파일 적용 완료` 메시지와 태그 키 수를 확인하고 EC2의 Tag Key 입력란에 포커스합니다.

파일을 가져온 후에는 정책 키 목록을 브라우저 확장의 로컬 저장소에 **AWS 계정별로 보관**합니다. 같은 계정에 새 파일을 가져오면 이전 파일을 덮어씁니다. 파일 모드는 JWT 로그인이 필요하지 않으며 사내망/VPN 연결 없이도 이미 열린 EC2 콘솔 화면에서 추천 키를 표시할 수 있습니다. 단, **EC2 콘솔 자체의 접근·AWS 작업에는 AWS 접속과 별도 로그인이 필요**합니다.

## 3. 지원 파일 형식

- AWS CLI `describe-effective-policy --output json`의 `EffectivePolicy.PolicyContent` 래퍼 (권장).
- 상속·병합이 완료된 원시 Effective Tag Policy의 `{"tags": {...}}` JSON.
- 백엔드가 생성하는 정규화 응답 `{"accountId":"...", "tagKeys":[...]}`.

최대 파일 크기는 128 KiB이며 최대 500개 키를 지원합니다. 원본 정책의 `@@assign` 같은 병합 연산자는 직접 해석하지 않습니다. `TargetId`나 `accountId`가 있을 경우 선택한 계정과 다른 파일은 거부합니다. ID가 없는 원시 `tags` JSON은 계정을 자동으로 확인할 수 없으므로 관리자가 배포 때 계정 일치를 보증해야 합니다.

## 4. 두 가지 모드의 차이

| 구분 | 서버 연동 | 정책 파일 가져오기 |
| --- | --- | --- |
| 네트워크 | VPN/사내망·VPCE 필수 | 정책 조회에는 불필요 |
| 인증 | 사내 RS256 JWT 필수 | 정책 열람에 JWT 불필요 |
| 데이터 출처 | API Gateway → Lambda → Organizations | 관리자가 제공한 Effective Tag Policy JSON |
| 갱신 | 서버 조회(5분 메모리 캐시) | 사용자 재가져오기 전까지 고정 |
| 계정 | 탭별 ID 선택, 서버가 사용자 인가 | 탭별 ID 선택, 계정별 로컬 저장 |
| 접근 통제 | VPCE 리소스 정책·JWT·계정 인가 | 전달된 파일의 접근·무결성은 배포 절차로 통제 |

## 5. 보안·운영 주의

- 파일 모드의 정책은 **추천 UI용 데이터**이며, 태그 정책 집행·AWS 권한을 부여하거나 검증하는 메커니즘이 아닙니다.
- 수동 파일은 복사·변조·오래된 상태로 재배포될 수 있습니다. 관리자 승인 및 갱신/폐기 주기를 정의하세요.
- 파일은 브라우저 확장 저장소에 평문으로 보관됩니다. 비밀이나 접근 토큰은 포함하지 마세요.
- 정책 파일은 Chrome/Firefox 외부로 자동 전송하지 않습니다. 반면 EC2 콘솔의 AWS 서비스 호출은 기존 AWS 화면의 동작을 따릅니다.
- 파일 모드로 바꾸더라도 이전 서버 로그인 JWT가 세션에 남아 있을 수 있습니다. 공유 PC에서는 별도로 **로그아웃**하고, 브라우저 프로필 접근을 통제하세요.
- 두 모드는 **EC2 콘솔 탭별로 선택**되며 서버 모드로 변경하면 다시 JWT 인증 및 Private API 네트워크 연결이 필요합니다.
