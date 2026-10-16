# RemoteHub - 올인원 웹 원격 접속 게이트웨이 (VNC · RDP · SSH)

웹 브라우저 하나로 다수의 **VNC**, **RDP (Windows)**, **SSH 터미널** 서버를 등록하고 관리하며, 별도의 클라이언트 프로그램 설치 없이 즉시 접속할 수 있는 초경량 올인원 웹 게이트웨이 솔루션입니다.

---

## 🌟 주요 특징

### 1. 3대 원격 프로토콜 완벽 통합
- **🖥️ VNC**: noVNC(`@novnc/novnc`) 코어 기반의 초경량 RFB 원격 데스크톱
- **🪟 RDP**: WebAssembly 기반 `ironrdp-wasm` 엔진을 탑재하여 별도 데몬 없이 Windows 원격 데스크톱을 브라우저에서 직접 초고속 렌더링
- **💻 SSH Terminal**: `xterm.js` + `ssh2` 기반의 풀 기능 웹 터미널
  - **인증 방식**: 일반 패스워드 로그인뿐만 아니라 **SSH 개인키(PEM / OpenSSH Private Key)** 및 **패스프레이즈** 완벽 지원
  - **시작 시 자동 실행 명령 (Initial Command)**: 접속 시 `tmux`, `screen`, `bash`, `htop` 등 지정 명령 자동 실행

### 2. 멀티 탭 워크스페이스 & 좌측 사이드바 패널
- **브라우저 탭 스타일 멀티 세션**: 여러 대의 서버 또는 동일 서버의 복수 세션을 탭 형태로 동시에 열어두고 전환하며 작업 가능
- **접이식 좌측 사이드바 패널**: 화면을 가리지 않고 자유롭게 열고 닫을 수 있는 서버 목록 네비게이션 패널
- **탭 우클릭 컨텍스트 메뉴**:
  - `📋 세션 복제 (새 탭으로 열기)`: 현재 서버를 새 탭으로 즉시 추가 접속
  - `🔄 세션 재연결 (이어받기)`: 연결이 끊겼거나 일시 오류 시 기존 세션 이어받기
  - `🆕 세션 새로 시작 (신규 접속)`: 기존 세션을 갱신하고 완전 신규 세션으로 접속
  - `✕ 탭 닫기 (세션 종료)`: 탭을 닫고 백엔드 원격 세션까지 안전하게 완전 종료
  - `🧹 다른 탭 모두 닫기`
- **SSH 터미널 폰트 크기 조절**: 상단 툴바의 `A-`, `A+` 버튼 및 `Ctrl`+`+`/`-` 단축키 지원 (브라우저 로컬 저장소 영속화)

### 3. 그룹(Group) 분류 & 태그(Tags) 시스템
- **대시보드 그룹 필터 바**: 서버 등록 시 입력한 그룹별로 상단에 `[전체]`, `[📁 운영]`, `[📁 개발]`, `[기타/미분류]` 필터 탭 바 자동 생성
- **뷰어 사이드바 접이식 아코디언**: 좌측 패널에서 서버들이 그룹별 아코디언 섹션(`▼ 📁 그룹명 (N)`)으로 깔끔하게 분류되어 접고 펼치기 지원
- **다중 `#태그` 뱃지**: 쉼표로 자유롭게 입력한 태그가 하늘색 뱃지로 표시되며, 클릭 시 검색창에 자동 입력되어 즉시 필터링
- **실시간 통합 검색**: 서버 이름, 호스트 IP/도메인, 설명뿐만 아니라 그룹명 및 태그명(`db`, `#linux`)으로도 실시간 검색

### 4. 지능형 세션 영속성 (Session Retention & Reattach)
- **새로고침(F5) / 브라우저 재실행 시 세션 유지**: 브라우저 창을 닫거나 새로고침해도 원격 SSH 세션과 512KB 스크롤백 기록이 백엔드에 유지되어 작업 상태 그대로 복원
- **명시적 탭 닫기 처리**: 사용자가 직접 탭의 `[×]`를 눌러 닫으면 백엔드 원격 프로세스까지 즉시 완전 종료(`terminate`)되어 미사용 세션이 남거나 새로고침 시 부활하지 않음
- **TUI/터미널 질의 시퀀스 필터링**: `vi`, `vim` 등 전체화면 프로그램 사용 후 세션 복원 시에도 단말 질의 응답 코드가 쉘 프롬프트로 누출되지 않도록 완벽 차단

### 5. 초경량 단일 컨테이너 (No Heavy Daemons)
- Apache Guacamole처럼 별도의 무거운 C 언어 데몬(`guacd`)을 띄울 필요 없이, **순수 Node.js 단일 프로세스**로 VNC, RDP, SSH 웹 프록시를 모두 처리 (단일 포트 `8080`)
- 외부 데이터베이스 없이 `/conf.d/remotehub/config.json` 단일 파일로 모든 설정이 저장되어 백업 및 이전이 간편

### 6. 편의 및 보안 기능
- **드래그 앤 드롭 순서 변경**: 메인 포털에서 카드 상단의 `▲` / `▼` 버튼 또는 마우스 드래그 앤 드롭으로 출력 순서 자유 정렬
- **실시간 포트 핑 (Healthcheck)**: 각 서버의 포트(5900, 3389, 22) 활성화 상태와 지연 시간(ms) 실시간 확인
- **선택적 보안 마스터 로그인**: 웹 포털 전체 접근을 보호하는 마스터 비밀번호 인증(ON/OFF) 내장

---

## 🚀 빠른 시작 (Docker Compose)

### 1. `docker-compose.yml` 실행
```bash
docker compose up -d --build
```

실행 후 브라우저에서 `http://localhost:8080`에 접속합니다.

---

## 🐳 Docker CLI 직접 실행

```bash
# 로컬의 config 디렉터리를 /conf.d/remotehub로 마운트
docker run -d \
  --name remotehub \
  -p 8080:8080 \
  -v $(pwd)/config:/conf.d/remotehub \
  --restart unless-stopped \
  remotehub
```

---

## 💻 로컬 개발 환경 실행

```bash
# 의존성 설치
npm install

# 테스트 슈트 실행 (7개 단위/통합 테스트)
npm test

# 로컬 개발 서버 실행 (기본 config 경로는 ./config/config.json)
CONFIG_PATH="./config/config.json" npm start
```

---

## ⚙️ 설정 파일 예시 (`config.json`)

```json
{
  "auth": {
    "enabled": false,
    "passwordHash": ""
  },
  "servers": [
    {
      "id": "srv-ubuntu-vnc",
      "name": "Ubuntu 개발 데스크톱",
      "protocol": "vnc",
      "group": "개발 (Dev)",
      "tags": ["linux", "desktop", "gui"],
      "host": "192.168.1.10",
      "port": 5900,
      "password": "vncpassword",
      "description": "개발용 리눅스 GUI 데스크톱"
    },
    {
      "id": "srv-win-rdp",
      "name": "Windows Server 2022",
      "protocol": "rdp",
      "group": "운영 (Prod)",
      "tags": ["windows", "rdp", "ad"],
      "host": "192.168.1.20",
      "port": 3389,
      "username": "Administrator",
      "domain": "CORP",
      "password": "windowspassword",
      "description": "WASM 고속 렌더링 윈도우 서버"
    },
    {
      "id": "srv-prod-ssh",
      "name": "운영 배포 서버",
      "protocol": "ssh",
      "group": "운영 (Prod)",
      "tags": ["linux", "deploy", "ssh"],
      "host": "192.168.1.30",
      "port": 22,
      "username": "ubuntu",
      "authType": "key",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
      "passphrase": "",
      "initialCommand": "tmux new -A -s remotehub",
      "description": "SSH Key 인증 및 tmux 자동 연결"
    }
  ]
}
```

---

## 📁 프로젝트 구조

```text
remotehub/
├── Dockerfile                   # Node 기반 초경량 도커 빌드 파일
├── docker-compose.yml           # 원클릭 실행 컴포즈 설정
├── package.json                 # Node.js 프로젝트 명세 및 의존성
├── DESIGN.md                    # 아키텍처 및 상세 기술 설계서
├── README.md                    # 사용자 가이드 및 기술 문서
├── src/
│   ├── server.js                # Express & WebSocket 통합 라우팅 진입점
│   ├── config.js                # 설정 파일 I/O, 그룹/태그 파싱, 서버 CRUD 및 순서 정렬
│   └── routes/
│       ├── api.js               # 서버 관리, 순서 변경, 세션 관리, 인증, TCP 핑 API
│       ├── proxy.js             # VNC용 WebSocket <-> TCP 프록시
│       ├── rdp-proxy.js         # RDP용 RDCleanPath & TLS WebSocket 프록시
│       └── ssh-proxy.js         # SSH 지속 세션 풀 관리 및 WebSocket <-> ssh2 터미널 프록시
├── public/
│   ├── index.html               # 원격 서버 관리 포털 UI (그룹 필터 바, 모달)
│   ├── viewer.html              # 통합 멀티 탭 뷰어 콘솔 (VNC / RDP / Terminal)
│   ├── js/
│   │   ├── app.js               # 포털 대시보드, 그룹/태그 필터링, 드래그앤드롭 정렬
│   │   ├── viewer.js            # 멀티 탭 워크스페이스, 접이식 사이드바, 세션 복원/종료 제어
│   │   └── rdp-input.js         # RDP 키보드/마우스/Scancode 이벤트 핸들러
│   └── css/
│       └── style.css            # 반응형 다크 테마 스타일시트 (그룹/태그/사이드바/탭)
└── test/
    └── api.test.js              # 단위 및 통합 E2E 테스트 슈트 (7개 테스트 통과)
```

---

## 📄 라이선스
MIT License
