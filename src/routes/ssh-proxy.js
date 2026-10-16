'use strict';

const { Client } = require('ssh2');

// 인메모리 지속 세션 풀 (sessionKey -> PersistentSshSession)
const activeSshSessions = new Map();

// 터미널 질의(Device Attributes, CPR, OSC 색상 질의 등) 시퀀스 제거 헬퍼
// vi, vim 등이 터미널 기능 감지를 위해 보낸 escape query는 화면 출력용이 아니며,
// 재연결 시 xterm이 이에 자동 응답하여 프롬프트에 불필요한 응답 문자(0;276;0c, rgb:... 등)를 누출시키는 것을 방지
function stripTerminalQueries(text) {
  if (!text) return '';
  return text
    // 1. Device Attributes (DA): ESC [ c, ESC [ 0 c, ESC [ > c, ESC [ ? ... c
    .replace(/\x1b\[\??[0-9;]*c/g, '')
    .replace(/\x1b\[>[0-9;]*c/g, '')
    .replace(/\x1b\[=[0-9;]*c/g, '')
    // 2. Cursor Position Report (CPR) / DSR: ESC [ 6 n, ESC [ ? 6 n, ESC [ 5 n
    .replace(/\x1b\[\??[0-9;]*n/g, '')
    // 3. OSC 색상/타이틀 질의: ESC ] 10;? BEL, ESC ] 11;? ESC \ 등
    .replace(/\x1b\](?:10|11|12|4);[^\x07\x1b]*\?(?:[^\x07\x1b]*)(?:\x07|\x1b\\)/g, '')
    // 4. DECRQM 모드 질의: ESC [ ? ... $ p
    .replace(/\x1b\[\??[0-9]+(?:\;[0-9]+)*\$p/g, '')
    // 5. 창 크기 / 상태 질의: ESC [ ... t
    .replace(/\x1b\[(?:14|18|19|20|21)t/g, '');
}

class PersistentSshSession {
  constructor(key, server) {
    this.key = key;
    this.server = server;
    this.logPrefix = `[SSH:${server.name || server.host}][${key}]`;
    this.sshClient = new Client();
    this.sshStream = null;
    this.attachedWs = null;
    this.historyBuffer = '';
    this.maxBufferSize = 512 * 1024; // 512KB 화면 스크롤백 버퍼
    this.lastCols = 80;
    this.lastRows = 24;
    this.isReady = false;
    this.isDestroyed = false;
    this.disconnectTimer = null;
    // 브라우저가 끊어져도 24시간 동안 원격 세션 유지
    this.retentionTimeoutMs = 24 * 60 * 60 * 1000;
    this.createdAt = new Date().toISOString();
  }

  start(initialWs) {
    this.attachedWs = initialWs;
    console.log(`${this.logPrefix} Creating new persistent SSH session for ${this.server.host}:${this.server.port || 22}`);

    const connectConfig = {
      host: this.server.host,
      port: this.server.port || 22,
      username: this.server.username || 'root',
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3
    };

    if (this.server.authType === 'key' && this.server.privateKey) {
      connectConfig.privateKey = this.server.privateKey;
      if (this.server.passphrase) {
        connectConfig.passphrase = this.server.passphrase;
      }
    } else if (this.server.password) {
      connectConfig.password = this.server.password;
    }

    this.sshClient.on('ready', () => {
      console.log(`${this.logPrefix} SSH client authenticated and ready (cols: ${this.lastCols}, rows: ${this.lastRows})`);
      this.isReady = true;

      this.sshClient.shell({
        term: 'xterm-256color',
        cols: this.lastCols,
        rows: this.lastRows
      }, (err, stream) => {
        if (err) {
          console.error(`${this.logPrefix} Failed to open SSH shell:`, err.message);
          if (this.attachedWs && this.attachedWs.readyState === 1) {
            this.attachedWs.send(`\r\n\x1b[31m[RemoteHub] SSH Shell Error: ${err.message}\x1b[0m\r\n`);
            this.attachedWs.close(1011, 'SSH Shell Error');
          }
          this.destroy();
          return;
        }

        this.sshStream = stream;

        // PTY 윈도우 크기 동기화 확정
        try {
          this.sshStream.setWindow(this.lastRows, this.lastCols, 0, 0);
        } catch (_) {}

        // SSH -> History Buffer & WebSocket
        stream.on('data', (data) => {
          const text = data.toString('utf-8');
          // historyBuffer에는 화면 복원용 데이터만 누적 (단말 질의 시퀀스 제거)
          this.historyBuffer += stripTerminalQueries(text);
          if (this.historyBuffer.length > this.maxBufferSize) {
            this.historyBuffer = this.historyBuffer.slice(-Math.floor(this.maxBufferSize / 2));
          }

          if (this.attachedWs && this.attachedWs.readyState === 1) {
            try {
              this.attachedWs.send(text);
            } catch (e) {
              console.error(`${this.logPrefix} Error sending to WebSocket:`, e.message);
            }
          }
        });

        stream.on('close', () => {
          console.log(`${this.logPrefix} SSH shell stream closed (process exited)`);
          if (this.attachedWs && this.attachedWs.readyState === 1) {
            this.attachedWs.send('\r\n\x1b[33m[RemoteHub] SSH session closed.\x1b[0m\r\n');
            this.attachedWs.close(1000, 'SSH Session Closed');
          }
          this.destroy();
        });

        // 초기 시작 명령 (Initial Command / screen / tmux / termux 등) 실행
        if (this.server.initialCommand && this.server.initialCommand.trim()) {
          setTimeout(() => {
            if (this.sshStream && !this.sshStream.destroyed) {
              console.log(`${this.logPrefix} Executing initial command: ${this.server.initialCommand}`);
              this.sshStream.write(this.server.initialCommand.trim() + '\n');
            }
          }, 150);
        }
      });
    });

    this.sshClient.on('error', (err) => {
      console.error(`${this.logPrefix} SSH client error:`, err.message);
      if (this.attachedWs && this.attachedWs.readyState === 1) {
        this.attachedWs.send(`\r\n\x1b[31m[RemoteHub] SSH Connection Error: ${err.message}\x1b[0m\r\n`);
        this.attachedWs.close(1011, `SSH Error: ${err.message}`);
      }
      this.destroy();
    });

    this.sshClient.on('close', () => {
      console.log(`${this.logPrefix} SSH connection closed`);
      if (this.attachedWs && this.attachedWs.readyState === 1) {
        this.attachedWs.close(1000, 'SSH Closed');
      }
      this.destroy();
    });

    this.bindWs(initialWs);

    try {
      this.sshClient.connect(connectConfig);
    } catch (err) {
      console.error(`${this.logPrefix} Exception during sshClient.connect:`, err.message);
      if (initialWs.readyState === 1) {
        initialWs.send(`\r\n\x1b[31m[RemoteHub] Connection Initialization Failed: ${err.message}\x1b[0m\r\n`);
        initialWs.close(1011, err.message);
      }
      this.destroy();
    }
  }

  attach(newWs) {
    console.log(`${this.logPrefix} Reattaching WebSocket to existing persistent session`);
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    if (this.attachedWs && this.attachedWs !== newWs) {
      try {
        this.attachedWs.close(1000, 'Replaced by new connection');
      } catch (_) {}
    }

    this.attachedWs = newWs;
    this.bindWs(newWs);

    // 재연결 안내 메시지 및 이전 터미널 출력 버퍼 즉각 재생
    if (newWs.readyState === 1) {
      newWs.send('\r\n\x1b[32m[RemoteHub] 기존 원격 세션에 다시 연결되었습니다.\x1b[0m\r\n');
      if (this.historyBuffer) {
        newWs.send(stripTerminalQueries(this.historyBuffer));
      }
      if (this.sshStream) {
        try {
          this.sshStream.setWindow(this.lastRows, this.lastCols, 0, 0);
        } catch (_) {}
      }
    }
  }

  bindWs(ws) {
    ws.on('message', (msg) => {
      try {
        const text = msg.toString('utf-8');
        // 리사이즈 등 JSON 제어 메시지 확인
        if (text.startsWith('{') && text.endsWith('}')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
              const newCols = Number(parsed.cols) || 80;
              const newRows = Number(parsed.rows) || 24;
              if (newCols === this.lastCols && newRows === this.lastRows) {
                return;
              }
              this.lastCols = newCols;
              this.lastRows = newRows;
              if (this.sshStream) {
                try {
                  this.sshStream.setWindow(this.lastRows, this.lastCols, 0, 0);
                } catch (_) {}
              }
              return;
            } else if (parsed.type === 'terminate') {
              // 클라이언트의 명시적 세션 완전 종료 요청
              console.log(`${this.logPrefix} Session termination explicitly requested`);
              this.destroy();
              return;
            }
          } catch (_) {
            // JSON 파싱 실패 시 일반 텍스트로 폴백
          }
        }

        if (this.sshStream) {
          this.sshStream.write(msg);
        }
      } catch (e) {
        console.error(`${this.logPrefix} Error writing to SSH stream:`, e.message);
      }
    });

    ws.on('close', () => {
      if (this.attachedWs === ws) {
        this.attachedWs = null;
        console.log(`${this.logPrefix} WebSocket detached. Keeping SSH session alive in background.`);
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
        }
        this.disconnectTimer = setTimeout(() => {
          console.log(`${this.logPrefix} Retention timeout expired. Destroying session.`);
          this.destroy();
        }, this.retentionTimeoutMs);
      }
    });

    ws.on('error', (err) => {
      console.error(`${this.logPrefix} WebSocket error:`, err.message);
      if (this.attachedWs === ws) {
        this.attachedWs = null;
      }
    });
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    activeSshSessions.delete(this.key);

    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    if (this.attachedWs && this.attachedWs.readyState === 1) {
      try {
        this.attachedWs.send('\r\n\x1b[33m[RemoteHub] Session terminated by user.\x1b[0m\r\n');
        this.attachedWs.close(1000, 'Session Terminated');
      } catch (_) {}
    }
    this.attachedWs = null;

    try {
      if (this.sshStream) {
        this.sshStream.end();
        if (typeof this.sshStream.destroy === 'function') {
          this.sshStream.destroy();
        }
      }
    } catch (_) {}

    try {
      if (this.sshClient) {
        this.sshClient.end();
        if (typeof this.sshClient.destroy === 'function') {
          this.sshClient.destroy();
        }
      }
    } catch (_) {}

    console.log(`${this.logPrefix} Session fully destroyed.`);
  }
}

function handleSshConnection(ws, req, server) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  let sessionKey = parsedUrl.searchParams.get('sessionKey');
  const forceNew = parsedUrl.searchParams.get('forceNew') === '1' || parsedUrl.searchParams.get('forceNew') === 'true';

  if (!sessionKey) {
    if (!forceNew) {
      // 명시된 sessionKey가 없을 경우, 해당 서버의 분리(detached)된 세션이 있다면 자동 재연결
      for (const [key, sess] of activeSshSessions.entries()) {
        if (sess.server.id === server.id && !sess.isDestroyed && !sess.attachedWs) {
          sessionKey = key;
          break;
        }
      }
    }
    if (!sessionKey) {
      sessionKey = `session_${server.id}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    }
  }

  const existingSession = activeSshSessions.get(sessionKey);

  if (existingSession && !existingSession.isDestroyed) {
    if (forceNew) {
      console.log(`[SSH:${server.name}] forceNew requested. Terminating previous session ${sessionKey}`);
      existingSession.destroy();
    } else {
      existingSession.attach(ws);
      return;
    }
  }

  const session = new PersistentSshSession(sessionKey, server);
  activeSshSessions.set(sessionKey, session);
  session.start(ws);
}

module.exports = {
  handleSshConnection,
  activeSshSessions
};
