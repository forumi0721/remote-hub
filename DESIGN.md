# RemoteHub 시스템 설계서

## 1. 프로젝트 개요
- **목적**: 웹 브라우저에서 다수의 원격 서버(**VNC, RDP, SSH 터미널**)를 등록/정렬/관리하고 단일 포털에서 즉시 접속할 수 있는 초경량 올인원 웹 게이트웨이.
- **주요 특징**:
  - 단일 Docker 컨테이너 및 단일 포트(`:8080`) 서비스 (포털 UI + 뷰어 + VNC/RDP/SSH 웹 프록시 올인원).
  - 무거운 C 데몬(Apache Guacamole의 `guacd`) 없이, 순수 Node.js 스트림 및 WebAssembly 기반 클라이언트로 고성능 처리.
  - SSH 개인키(Key) 인증 및 브라우저 분리 후 최대 24시간 세션 유지(`activeSshSessions`)을 보장하는 스마트 세션 풀 지원.
  - 브라우저 탭 스타일 멀티 세션 워크스페이스 및 접이식 좌측 사이드바 패널.
  - 서버 그룹(Group) 분류 및 태그(Tags) 시스템 (상단 필터 바, 사이드바 아코디언, 통합 검색).
  - 서버 목록 출력 순서 변경 (드래그 앤 드롭 및 ▲/▼ 버튼).
  - 외부 DB 없이 로컬 JSON 파일(`/conf.d/remotehub/config.json`)을 통한 간편한 설정 영속화 및 백업.

---

## 2. 3대 원격 프로토콜 통합 아키텍처

| 구분 | VNC (RFB) | RDP (Remote Desktop) | SSH Terminal |
| :--- | :--- | :--- | :--- |
| **클라이언트 렌더러** | noVNC (`@novnc/novnc`) | `ironrdp-wasm` (Rust Core WASM) | `xterm.js` (`@xterm/xterm`) |
| **화면/입력 처리** | HTML5 Canvas (RFB) | HTML5 Canvas (WASM 디코딩) | xterm DOM 터미널 에뮬레이터 |
| **웹 브라우저 통신** | WebSocket (Binary 스트림) | WebSocket (RDCleanPath PDU) | WebSocket (TTY 입출력 & JSON Resize) |
| **백엔드 프록시 모듈** | `src/routes/proxy.js`<br>(Node.js `net.Socket`) | `src/routes/rdp-proxy.js`<br>(Node.js `net` + `tls` RDCleanPath) | `src/routes/ssh-proxy.js`<br>(Node.js `ssh2.Client` & 지속 세션 풀) |
| **대상 서버 포트** | TCP 5900 (기본) | TCP 3389 (기본) | TCP 22 (기본) |

---

## 3. 전체 시스템 구성도

```mermaid
flowchart TD
    subgraph Browser ["Client (Web Browser)"]
        UI["포털 대시보드 (서버 목록/그룹/태그/설정)"]
        VNCViewer["noVNC Viewer (Canvas)"]
        RDPViewer["IronRDP Viewer (WASM Canvas)"]
        SSHTerminal["xterm.js Web Terminal (Multi-Tab)"]
    end

    subgraph Container ["RemoteHub Container (:8080)"]
        HttpServer["Express HTTP Server\n- 정적 서빙 (/novnc, /ironrdp, /xterm)\n- REST API (/api/servers, /api/sessions, /api/auth)"]
        WsRouter["WebSocket Router (/ws?serverId=...&sessionKey=...)"]
        VncProxy["VNC Proxy (TCP Raw Relay)"]
        RdpProxy["RDP Proxy (TLS + RDCleanPath)"]
        SshProxy["SSH Proxy (ssh2 Shell & Session Pool)"]
        ConfigFile["설정 저장소 (/conf.d/remotehub/config.json)"]
    end

    subgraph Targets ["Remote Targets (사설망 / 클라우드 호스트)"]
        LinuxGUI["Linux Desktop (VNC :5900)"]
        WindowsRDP["Windows Server (RDP :3389)"]
        LinuxSSH["Linux / Termux Host (SSH :22)"]
    end

    UI -- "REST API (CRUD/Reorder/Group)" --> HttpServer
    HttpServer <--> ConfigFile
    
    VNCViewer -- "WebSocket" --> WsRouter
    RDPViewer -- "WebSocket" --> WsRouter
    SSHTerminal -- "WebSocket" --> WsRouter
    
    WsRouter <--> ConfigFile
    WsRouter -->|protocol == 'vnc'| VncProxy -->|TCP| LinuxGUI
    WsRouter -->|protocol == 'rdp'| RdpProxy -->|TLS| WindowsRDP
    WsRouter -->|protocol == 'ssh'| SshProxy -->|SSH2| LinuxSSH
```

---

## 4. 데이터 스키마 (`config.json`)

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
      "description": "VNC 원격 데스크톱",
      "createdAt": "2026-10-02T07:00:00.000Z"
    },
    {
      "id": "srv-windows-rdp",
      "name": "Windows Server 2022",
      "protocol": "rdp",
      "group": "운영 (Prod)",
      "tags": ["windows", "rdp", "ad"],
      "host": "192.168.1.20",
      "port": 3389,
      "username": "Administrator",
      "domain": "CORP",
      "password": "windowsPassword",
      "description": "WASM 고속 렌더링",
      "createdAt": "2026-10-02T07:05:00.000Z"
    },
    {
      "id": "srv-prod-ssh",
      "name": "운영 배포 서버",
      "protocol": "ssh",
      "group": "운영 (Prod)",
      "tags": ["linux", "deploy", "ssh"],
      "host": "192.168.1.30",
      "port": 22,
      "username": "root",
      "authType": "key",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
      "passphrase": "",
      "initialCommand": "tmux new -A -s remotehub",
      "description": "tmux 세션 자동 연결",
      "createdAt": "2026-10-02T07:10:00.000Z"
    }
  ]
}
```

---

## 5. 핵심 엔드포인트 명세

### REST API
- `GET /api/status`: 포털 상태 및 인증 요구 여부
- `POST /api/auth/login`: 마스터 패스워드 로그인
- `POST /api/auth/logout`: 로그아웃
- `PUT /api/auth/settings`: 마스터 패스워드 설정 변경
- `GET /api/servers`: 등록된 서버 목록 (비밀번호 및 개인키 마스킹, group, tags 포함)
- `PUT /api/servers/reorder`: 서버 순서 재배치 (`{ serverIds: string[] }`)
- `GET /api/servers/:id/connection`: 특정 서버 접속 상세 정보 (SSH 비밀값 제외)
- `POST /api/servers`: 새 서버 등록
- `PUT /api/servers/:id`: 서버 정보 수정
- `DELETE /api/servers/:id`: 서버 삭제
- `GET /api/servers/:id/ping`: TCP 헬스 체크 및 레이턴시 측정
- `GET /api/sessions`: 현재 실행 중인 백엔드 영구 세션 목록 조회
- `DELETE /api/sessions/:key`: 특정 백엔드 세션 즉시 완전 종료

### WebSocket
- `/ws?serverId=<id>&sessionKey=<key>&forceNew=<bool>`:
  - `serverId`: 대상 원격 서버 ID
  - `sessionKey`: 백엔드 영구 세션 식별 키 (생략 시 분리된 SSH 세션 자동 복원)
  - `forceNew`: 기존 백그라운드 세션 무시 및 완전 신규 세션 강제 생성
  - 대상 서버의 프로토콜에 따라 VNC, RDP, SSH 프록시로 자동 디스패치

## 보안 및 세션 수명

SSH 세션과 출력 기록은 프로세스 메모리에 저장되며 재시작 시 소실됩니다. VNC/RDP 연결은 브라우저 연결 종료 시 함께 종료됩니다. 서버 삭제 시 해당 SSH 세션도 종료합니다. 설정 읽기 실패는 접근을 차단하며 설정 파일을 덮어쓰지 않습니다. SSH 호스트 키와 RDP 인증서는 최초 접속 시 SHA-256 지문을 저장하고 이후 비교하는 TOFU 방식을 사용합니다. 최초 접속 보장 및 지문 교체 절차는 README의 운영 항목을 참고하세요.
