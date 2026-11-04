# Private REST API 직접 호출 테스트

이 문서는 Chrome/Firefox 확장이 **백그라운드 컨텍스트에서 사내 JWT를 첨부하여 Private REST API Gateway에 직접 HTTPS GET 요청**을 보내는 방식을 검증합니다. AWS Organizations API 자체를 브라우저에서 직접 호출하지는 않습니다.

## 1. 테스트 전제

- 사용자 PC가 사내망 또는 승인된 VPN에 접속되어 있음.
- AWS VPC의 `execute-api` Interface VPC Endpoint 보안 그룹이 사내망/VPN 출발지의 TCP 443을 허용.
- Private REST API Resource Policy가 해당 `aws:SourceVpce`만 허용.
- 사내 DNS가 API FQDN을 VPC Endpoint로 라우팅 가능한 사설 IP에 해석하도록 구성됨.
- Lambda TOKEN Authorizer가 사내 RS256 JWT를 검증하고, Policy Lambda가 계정 접근 권한을 검증.
- 실제 API URL에 **스테이지 경로가 포함**되어 있음. 예: `https://private-api.company.example/prod`.

## 2. VPN 연결 상태에서 네트워크 확인

1. 사내 VPN에 접속합니다.
2. API FQDN의 DNS 조회 결과가 승인된 내부 경로의 사설 IP인지 확인합니다.
3. TLS 연결이 성공하는지 확인합니다. 인증서의 호스트 이름이 API 도메인과 일치해야 합니다.
4. 사내 라우팅/방화벽 정책이 VPCE까지의 경로를 허용하는지 네트워크 담당자와 검증합니다.

```bash
nslookup private-api.company.example
curl --head --silent --show-error --max-time 10 https://private-api.company.example/prod/
```

루트 경로에 HEAD 메서드가 없으면 HTTP 403/404가 반환될 수 있습니다. **이 명령은 단순 연결 확인이며, 실제 API 정상 호출 여부는 아래 GET 테스트로 판단합니다.** `curl -k`로 TLS 검증을 우회하지 마세요.

## 3. Private REST API 직접 GET 테스트

실제 테스트 PC에서 사내 JWT를 준비합니다. 토큰 원문을 터미널 히스토리, 문서, 이슈, CloudWatch에 기록하지 마세요.

```bash
read -rs JWT_ACCESS_TOKEN
curl --silent --show-error --max-time 10 \
  --output /dev/null --write-out 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer ${JWT_ACCESS_TOKEN}" \
  "https://private-api.company.example/prod/v1/accounts/111122223333/tag-policy"
unset JWT_ACCESS_TOKEN
```

예시 계정 ID, API 호스트, 스테이지는 테스트 환경에 맞게 변경합니다. 정상 인증·인가와 정책 조회가 가능하면 HTTP 200이 기대됩니다.

## 4. 확장 프로그램에서 직접 테스트

1. Chrome 또는 Firefox를 사내망/VPN 연결 상태에서 실행합니다.
2. 빌드 시 `BUILD_API_BASE_URL`에 **Private REST API + 스테이지** 주소를 전달합니다.
3. 확장 프로그램을 로드하고 EC2 콘솔 탭을 엽니다.
4. 확장 팝업에서 **API 연동**을 선택하고 사내 JWT 로그인 API로 로그인합니다.
5. **AWS 계정 ID** 조회를 선택하고 현재 콘솔 계정과 동일한 ID(12자리)를 입력합니다.
6. **계정 정책 가져오기**를 클릭하면 실제 Private REST API를 호출합니다.
7. 성공 시 `계정 ...: 태그 키 N개를 가져왔습니다`가 표시됩니다.
8. EC2 Tag Key 입력란을 클릭해 정책 키 추천 목록이 표시되는지 확인합니다.

Chrome 개발자 도구에서는 `chrome://extensions` → 확장 프로그램 Service Worker **Inspect**를 사용할 수 있습니다. Firefox는 `about:debugging`에서 확장 **Inspect**로 진단합니다. 토큰·비밀번호를 로그에 출력하지 마세요.

## 5. 진단 메시지

| 오류 코드 | 주요 원인 | 조치 |
| --- | --- | --- |
| `PRIVATE_API_UNREACHABLE` | VPN 미연결, DNS, VPCE/방화벽, TLS | 내부 DNS/라우팅/보안 그룹 확인 |
| `API_TIMEOUT` | 10초 내 연결/응답 없음 | VPN 상태, 라우팅 및 API 지연 확인 |
| `API_GATEWAY_FORBIDDEN` | Resource Policy, SourceVpce, TOKEN Authorizer 거부 | API Gateway 실행 로그와 JWT 설정 확인 |
| `ACCOUNT_ACCESS_DENIED` | JWT 사용자/그룹의 대상 계정 권한 없음 | `ACCOUNT_AUTHZ_JSON` 검사 |
| `API_ROUTE_NOT_FOUND` | 잘못된 URL/스테이지/메서드 | `BUILD_API_BASE_URL` 및 API 배포 확인 |
| `TAG_POLICY_NOT_FOUND` | 대상 계정에 유효 Tag Policy 없음 | AWS Organizations 정책 확인 |
| `LOGIN_REQUIRED` | JWT 만료/로그인 누락 | 사내 계정 재로그인 |

HTTP 403은 API Gateway Resource Policy·Authorizer·백엔드 인가 모두에서 발생할 수 있습니다. 기본 응답 메시지와 백엔드의 `ACCOUNT_ACCESS_DENIED` 오류 코드를 구분하되, 정확한 원인은 API Gateway/Lambda 로그에서 확인해야 합니다.

## 6. 보안 검증

- [ ] VPN 연결 상태에서 정상 JWT + 허용 계정 → HTTP 200.
- [ ] VPN 연결 해제 시 API 접근 실패.
- [ ] 다른 VPCE를 통한 요청 → 접근 거부.
- [ ] 서명 변조/만료 JWT → API Gateway 거부.
- [ ] 정상 JWT지만 허용되지 않은 계정 → 403 `ACCOUNT_ACCESS_DENIED`.
- [ ] API 연동에서 새 계정 ID를 입력해 실제 GET 요청 및 응답 확인.
- [ ] JWT 원문이 UI/콘솔 로그/네트워크 오류 메시지에 노출되지 않음.

Private REST API의 사내망 호출은 VPN만 설치한다고 되는 것이 아닙니다. DNS 및 AWS Interface VPCE까지의 사설 라우팅이 선행되어야 합니다.
