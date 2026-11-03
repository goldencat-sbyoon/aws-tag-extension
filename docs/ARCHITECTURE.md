# 시스템 아키텍처

## 1. 컴포넌트 구성

```mermaid
flowchart TB
  subgraph Browser["사용자 브라우저"]
    P["확장 팝업: 로그인·계정·소스 선택, 파일 가져오기"]
    B["확장 백그라운드: 토큰·계정별 정책"]
    C["EC2 Content Script: 드롭다운"]
    F["로컬 저장소: 계정별 정책 JSON"]
    P <--> B
    C <--> B
    B <--> F
  end
  I["사내 인증 API: RS256 JWT 발급"]
  V["사내망/VPN → execute-api Interface VPCE"]
  G["Private REST API Gateway"]
  A["TOKEN Lambda Authorizer: JWKS·JWT 검증"]
  L["Policy API Lambda: 계정 접근 검사"]
  D["OU 탐색 Lambda: 허용된 계정 목록"]
  T["대상 계정 STS AssumeRole"]
  O["AWS Organizations Effective Tag Policy"]
  B --> I
  B -->|"서버 모드만"| V
  V --> G
  G --> A
  A --> L
  A --> D
  D --> O
  L --> T
  T --> O
```

실제 AWS 생성/수정 API 호출은 확장이 아니라 EC2 콘솔에서 이뤄진다. **파일 모드**는 P → B → F 경로만 사용하므로 사내 API 및 Lambda 네트워크가 필요 없다.

## 2. 로그인 시퀀스

```mermaid
sequenceDiagram
  participant U as 사용자
  participant E as 확장 프로그램
  participant I as 사내 인증 API
  U->>E: 로그인 정보 입력
  E->>I: HTTPS POST /login
  I-->>E: RS256 JWT Access Token
  E->>E: 세션 저장소에 토큰 보관
  E-->>U: 로그인 상태 표시
```

현재 구현은 자체 로그인 API에 `POST {username,password}` 후 `{access_token}`을 가정한다. 사내 API의 OAuth 리다이렉트/OTP/MFA 흐름은 연결 전 조정해야 한다.

## 3. 서버 모드 정책 조회 시퀀스

```mermaid
sequenceDiagram
  participant X as 확장 프로그램
  participant G as API Gateway
  participant A as JWT Authorizer
  participant L as Policy Lambda
  participant S as AWS STS
  participant O as Organizations
  X->>G: VPN/VPCE 경유 GET /accounts/{id}/tag-policy + JWT
  G->>A: Authorization 검사
  A->>A: RS256 서명/iss/aud/exp/scope 검증
  A-->>G: principalId + IAM Allow/Deny + sub/groups
  G->>L: 검증된 사용자·대상 계정
  L->>L: 서버 측 계정 접근 매핑 확인
  L->>S: 지정된 대상 역할 AssumeRole
  S-->>L: 임시 AWS 자격증명
  L->>O: DescribeEffectivePolicy(TAG_POLICY)
  O-->>L: Effective Policy JSON
  L-->>X: 정규화한 Tag Key 목록
```

## 4. AWS 계정 경계

- 백엔드 계정: API Gateway, Authorizer Lambda, 정책 Lambda.
- 대상 멤버 계정 A/B/C: 각각 `TagPolicyReadRole`을 생성.
- 백엔드 Lambda 실행 역할만 대상 역할을 AssumeRole할 수 있도록 제한.
- 각 대상 역할은 `organizations:DescribeEffectivePolicy` 읽기 권한만 가짐.
- 클라이언트는 AWS 역할 ARN을 전달할 수 없다. 계정→역할 ARN 매핑은 백엔드 서버가 보유.

## 5. 프라이빗 네트워크 경계

```mermaid
flowchart LR
  U["사용자 PC"] --> N["사내망 / VPN"]
  N --> R["VPC 라우팅 + DNS"]
  R --> E["execute-api Interface VPCE"]
  E --> G["Private REST API"]
  G --> J["JWT Authorizer + Policy Lambda"]
```

- Private REST API는 승인된 `aws:SourceVpce`를 제외한 호출을 명시적으로 거부한다.
- VPCE Security Group은 승인된 사내망/VPN CIDR에서 TCP 443을 허용한다.
- 사내 DNS는 Route 53 Resolver Inbound Endpoint/조건부 전달 또는 검증된 VPCE 전용 DNS 방식을 사용한다.
- 사내 PC/VPN의 라우팅 테이블은 VPC Interface Endpoint의 사설 IP에 도달할 수 있어야 한다.
- VPCE에서 TLS 연결 가능 여부와 REST API/스테이지/리소스 경로 응답을 별도로 검증한다.
- Private REST API는 퍼블릭 API와 달리 VPC Endpoint 경유 연결을 요구한다. DNS와 VPN만 구성하고 VPCE 연결을 누락하면 호출할 수 없다.
- 확장 프로그램의 **백그라운드 스크립트**가 Private REST API를 직접 호출하고, Content Script는 `runtime.sendMessage`로 응답을 받는다. JWT는 Content Script에 전달하지 않는다.

## 6. 브라우저별 차이

| 항목 | Chrome | Firefox |
| --- | --- | --- |
| Manifest | MV3 | MV3 |
| 백그라운드 | Service Worker | Background Scripts |
| 공통 기능 코드 | 동일 | 동일 |
| 패키징 | `dist/chrome` | `dist/firefox` |
| 배포 | Chrome Web Store/사내 배포 | Mozilla Add-ons/사내 배포 |

## 7. 장애 및 제한

- 인증 서버·JWKS 불가: 로그인 또는 JWT 검증 실패.
- 권한 부족/역할 부재: 해당 계정 정책 조회 실패.
- AWS 콘솔 DOM 변경: 드롭다운 미표시 가능. 원래 입력은 유지.
- 확장 프로그램은 사용자 선택 계정과 콘솔 계정이 실제로 같은지 자동 입증하지 않음.
- 실제 AWS 리소스 생성 동작 및 API 응답의 E2E 검증은 별도 필요.
- VPN 미연결, DNS 미설정, VPCE SG 차단 시 확장에서 API 요청이 실패한다.
- 파일 모드는 Private API와 인증 서버에 연결하지 않는다. 대신 관리자가 배포한 파일이 오래되거나 변조될 수 있고, 확장 저장소에서 계정별로 유지된다.
- 파일 모드에서도 EC2 콘솔을 로드하고 실제 AWS 변경을 수행하려면 AWS 자체 접속·로그인이 필요하다.

## 8. 오프라인 파일 모드

```mermaid
flowchart TB
  A["정책 관리자: 계정별 Effective Tag Policy 추출"] --> F["JSON 파일 사내 배포"]
  F --> P["확장 팝업: 계정 선택 및 파일 가져오기"]
  P --> S["확장 storage.local: 계정별 보관"]
  S --> C["EC2 태그 키 추천 드롭다운"]
```

원본 Organizations Tag Policy는 병합 전 정책이므로 수동 입력으로 사용하지 않는다. 상세 절차는 [수동 정책 파일 가이드](MANUAL_POLICY.md) 참고.

## 9. OU ID/이름 기반 조회

```mermaid
flowchart TD
  U["팝업 OU ID/이름 선택"] --> D["OU 탐색 Lambda"]
  D --> A["조직 하위 OU·활성 계정 탐색"]
  A --> G["JWT 계정 인가 필터링"]
  G --> P["기존 계정별 Policy Lambda 호출"]
  P --> R["계정별 최종 Effective Policy"]
```

- OU 조회 Lambda는 Organizations 탐색 전용 관리 계정 역할을 사용합니다. 정책 읽기는 계정별 역할/인가를 유지합니다.
- 이름 중복은 **접근 허용된 OU만** 경로·ID 후보로 표시합니다.
- 파일 모드는 관리자가 동일한 OU를 재귀 조회하여 생성한 JSON 묶음을 계정별로 저장합니다. 서버 호출 없이 정책을 표시합니다.
- 대규모 OU에서는 API Gateway 타임아웃/Browser 백그라운드 수명 문제가 있을 수 있어 비동기 Job 도입을 후속 과제로 남깁니다.

[OU 상세 가이드](OU_POLICY.md)
