import RFB from '/novnc/core/rfb.js';
import { TERMINAL_KEYS, terminalControlCharacter, sendRdpText } from './mobile-input.js';
import { setupRdpInputHandlers, sendRdpCtrlAltDel } from './rdp-input.js';

// 전역 상태
let serverList = [];
const sessions = new Map(); // tabId -> SessionData
let activeTabId = null;
let tabCounter = 0;
let rdpWasmModules = null;
let rdpWasmPromise = null;
const pendingTabs = new Map();

// DOM 엘리먼트
const sidebarEl = document.getElementById('viewer-sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnOpenSidebar = document.getElementById('btn-open-sidebar');
const sidebarSearchInput = document.getElementById('sidebar-search-input');
const sidebarServersList = document.getElementById('sidebar-servers-list');
const tabsContainer = document.getElementById('tabs-container');
const sessionsWorkspace = document.getElementById('sessions-workspace');
const emptyWorkspaceEl = document.getElementById('empty-workspace');

const tabStatusEl = document.getElementById('tab-status');
const btnCad = document.getElementById('btn-cad');
const btnScale = document.getElementById('btn-scale');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnReconnect = document.getElementById('btn-reconnect');

const sshFontControlsEl = document.getElementById('ssh-font-controls');
const btnFontDec = document.getElementById('btn-font-dec');
const btnFontInc = document.getElementById('btn-font-inc');
const fontSizeDisplay = document.getElementById('font-size-display');

const tabContextMenuEl = document.getElementById('tab-context-menu');
const ctxDuplicate = document.getElementById('ctx-duplicate');
const ctxReconnect = document.getElementById('ctx-reconnect');
const ctxFresh = document.getElementById('ctx-fresh');
const ctxClose = document.getElementById('ctx-close');
const ctxTerminate = document.getElementById('ctx-terminate');
const ctxCloseOthers = document.getElementById('ctx-close-others');

let terminalFontSize = parseInt(localStorage.getItem('remotehub_terminal_font_size'), 10) || 14;
let contextMenuTargetTabId = null;

const modalPassword = document.getElementById('modal-password');
const formPassword = document.getElementById('form-password');
const inputVncPw = document.getElementById('input-vnc-pw');
const btnCancelPw = document.getElementById('btn-cancel-pw');

let pendingPasswordTabId = null;

// 클립보드 UI 엘리먼트
const btnClipboard = document.getElementById('btn-clipboard');
const modalClipboard = document.getElementById('modal-clipboard');
const btnCloseClipboard = document.getElementById('btn-close-clipboard');
const clipboardTextarea = document.getElementById('clipboard-textarea');
const btnClipboardCopyLocal = document.getElementById('btn-clipboard-copy-local');
const btnClipboardClear = document.getElementById('btn-clipboard-clear');
const btnClipboardCopyRemote = document.getElementById('btn-clipboard-copy-remote');
const btnClipboardTypeRemote = document.getElementById('btn-clipboard-type-remote');
const clipboardToast = document.getElementById('clipboard-toast');
let toastTimer = null;

function showClipboardToast(message) {
  if (!clipboardToast) return;
  clipboardToast.textContent = message;
  clipboardToast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    clipboardToast.classList.remove('show');
  }, 2500);
}

const mobileInputBar = document.getElementById('mobile-input-bar');
const terminalKeys = document.getElementById('terminal-keys');
const ctrlButton = document.getElementById('btn-terminal-ctrl');
const keyboardButton = document.getElementById('btn-mobile-keyboard');
const sessionMenuButton = document.getElementById('btn-session-menu');
const rdpPanButton = document.getElementById('btn-rdp-pan');
rdpPanButton.addEventListener('click', () => {
  const session = getActiveSession();
  const canvas = session?.viewEl.querySelector('canvas');
  if (session?.engine !== 'rdp' || !canvas) return;
  session.rdpPan = !session.rdpPan;
  canvas.dataset.touchMode = session.rdpPan ? 'pan' : 'remote';
  rdpPanButton.setAttribute('aria-pressed', String(session.rdpPan));
  rdpPanButton.textContent = session.rdpPan ? '화면 이동 중 (원격 입력 꺼짐)' : '화면 이동 모드';
});
const rdpResolution = document.getElementById('rdp-resolution');
function resetControlKey() { ctrlButton.setAttribute('aria-pressed', 'false'); }
terminalKeys.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
terminalKeys.addEventListener('click', event => {
  const button = event.target.closest('button');
  const session = getActiveSession();
  if (!button || session?.engine !== 'ssh' || session.instance?.ws?.readyState !== WebSocket.OPEN) return;
  if (button === ctrlButton) { ctrlButton.setAttribute('aria-pressed', String(ctrlButton.getAttribute('aria-pressed') !== 'true')); return; }
  let key = TERMINAL_KEYS[button.dataset.terminalKey];
  if (key?.startsWith('\x1b[') && session.instance.term?.modes?.applicationCursorKeys) key = key.replace('[', 'O');
  if (key !== undefined) session.instance.ws.send(key);
  resetControlKey();
});
keyboardButton.addEventListener('click', () => {
  const session = getActiveSession();
  if (session?.engine === 'ssh') session.instance?.term?.focus();
  else if (session) openClipboardModal();
});
rdpResolution.addEventListener('change', () => {
  const session = getActiveSession();
  if (session?.engine !== 'rdp' || !session.instance) return;
  const [width, height] = rdpResolution.value.split('x').map(Number);
  try { session.instance.resize(width, height); session.rdpResolution = rdpResolution.value; }
  catch (err) { showNotice('해상도를 변경하지 못했습니다: ' + err.message); }
});

const compactViewport = window.matchMedia('(max-width: 900px)');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const viewerTools = document.getElementById('viewer-tools');

// 1. 사이드바 제어 (열기/닫기)
function setSidebarOpen(open) {
  if (open) {
    sidebarEl.classList.remove('closed');
    btnOpenSidebar.style.display = 'none';
  } else {
    sidebarEl.classList.add('closed');
    btnOpenSidebar.style.display = 'flex';
  }
  sidebarBackdrop.hidden = !open || !compactViewport.matches;
  sidebarEl.inert = !open;
  document.querySelector('.viewer-main').inert = open && compactViewport.matches;
  if (open && compactViewport.matches) { sidebarEl.setAttribute('role', 'dialog'); sidebarEl.setAttribute('aria-modal', 'true'); sidebarEl.setAttribute('aria-label', '원격 서버 목록'); }
  else { sidebarEl.removeAttribute('role'); sidebarEl.removeAttribute('aria-modal'); }
  sidebarEl.setAttribute('aria-hidden', String(!open));
  btnOpenSidebar.setAttribute('aria-expanded', String(open));
  btnOpenSidebar.setAttribute('aria-controls', 'viewer-sidebar');
  if (!compactViewport.matches) localStorage.setItem('remotehub_sidebar_open', open ? '1' : '0');
  // 터미널 또는 캔버스 리사이즈 트리거
  setTimeout(() => {
    const active = getActiveSession();
    if (active && active.engine === 'ssh' && active.instance?.fitAddon) {
      active.instance.fitAddon.fit();
    }
  }, 300);
}

btnToggleSidebar.addEventListener('click', () => { setSidebarOpen(false); btnOpenSidebar.focus(); });
btnOpenSidebar.addEventListener('click', () => { setSidebarOpen(true); sidebarEl.querySelector('input').focus(); });
sidebarBackdrop.addEventListener('click', () => { setSidebarOpen(false); btnOpenSidebar.focus(); });
compactViewport.addEventListener('change', () => setSidebarOpen(!compactViewport.matches && localStorage.getItem('remotehub_sidebar_open') !== '0'));
viewerTools.addEventListener('click', event => { if (event.target.closest('button') && !event.target.closest('.ssh-font-controls')) viewerTools.open = false; });
document.addEventListener('click', event => { if (!viewerTools.contains(event.target)) viewerTools.open = false; });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('.modal-overlay.active')) return;
  viewerTools.open = false;
  if (compactViewport.matches && !sidebarEl.classList.contains('closed')) { setSidebarOpen(false); btnOpenSidebar.focus(); }
});

sidebarEl.addEventListener('keydown', event => {
  if (event.key === 'Tab' && compactViewport.matches && !sidebarEl.classList.contains('closed')) {
    const controls = [...sidebarEl.querySelectorAll('button, input, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length && !el.disabled);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }
  if (['Enter', ' '].includes(event.key) && event.target.matches('[role="button"], .sidebar-group-header')) { event.preventDefault(); event.target.click(); }
});

// 2. 서버 목록 로드 및 사이드바 렌더링
async function loadServers() {
  try {
    const res = await apiFetch('/api/servers');
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      throw new Error('서버 목록 조회 실패');
    }
    serverList = await res.json();
    renderSidebarServers(serverList);
  } catch (err) {
    console.error('Failed to load server list:', err);
  }
}

const collapsedSidebarGroups = new Set();

window.toggleSidebarGroup = function(groupId) {
  if (collapsedSidebarGroups.has(groupId)) {
    collapsedSidebarGroups.delete(groupId);
  } else {
    collapsedSidebarGroups.add(groupId);
  }
  const el = document.getElementById(`group-items-${groupId}`);
  const arrow = document.getElementById(`group-arrow-${groupId}`);
  if (el) {
    const isCollapsed = collapsedSidebarGroups.has(groupId);
    el.style.display = isCollapsed ? 'none' : 'flex';
    if (arrow) arrow.textContent = isCollapsed ? '▶' : '▼';
  }
};

function renderSidebarServers(servers) {
  if (!servers || servers.length === 0) {
    sidebarServersList.innerHTML = `
      <div style="padding: 1.5rem 1rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
        검색 결과가 없습니다.
      </div>
    `;
    return;
  }

  function renderServerItemHtml(s) {
    const proto = s.protocol || 'vnc';
    const tagsHtml = (s.tags && s.tags.length > 0)
      ? `<div class="sidebar-item-tags">${s.tags.map(t => `<span class="tag-badge-sm">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    return `
      <div class="sidebar-server-item" data-id="${s.id}">
        <div class="sidebar-item-left" role="button" tabindex="0" onclick="onSidebarItemClick('${s.id}')">
          <span class="protocol-badge ${proto}">${proto}</span>
          <div class="sidebar-item-info">
            <div class="sidebar-item-name">${escapeHtml(s.name)}</div>
            <div class="sidebar-item-endpoint">${escapeHtml(s.host)}:${s.port}</div>
            ${tagsHtml}
          </div>
        </div>
        <button class="btn-icon" title="새 탭으로 열기" onclick="openNewTab('${s.id}', true, true)">+</button>
      </div>
    `;
  }

  const hasGroups = servers.some(s => s.group && s.group.trim());
  if (!hasGroups) {
    sidebarServersList.innerHTML = servers.map(renderServerItemHtml).join('');
    return;
  }

  // 그룹별로 분류
  const grouped = new Map();
  servers.forEach(s => {
    const groupName = (s.group && s.group.trim()) ? s.group.trim() : '기타/미분류';
    if (!grouped.has(groupName)) {
      grouped.set(groupName, []);
    }
    grouped.get(groupName).push(s);
  });

  let html = '';
  let groupIndex = 0;
  for (const [groupName, groupServers] of grouped.entries()) {
    groupIndex++;
    const groupId = 'grp-' + groupIndex;
    const isCollapsed = collapsedSidebarGroups.has(groupId);
    html += `
      <div class="sidebar-group">
        <div class="sidebar-group-header" role="button" tabindex="0" onclick="toggleSidebarGroup('${groupId}')">
          <span id="group-arrow-${groupId}" class="group-toggle-arrow">${isCollapsed ? '▶' : '▼'}</span>
          <span>📁 ${escapeHtml(groupName)}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted); margin-left: auto;">${groupServers.length}</span>
        </div>
        <div id="group-items-${groupId}" class="sidebar-group-items" style="display: ${isCollapsed ? 'none' : 'flex'};">
          ${groupServers.map(renderServerItemHtml).join('')}
        </div>
      </div>
    `;
  }

  sidebarServersList.innerHTML = html;
}

sidebarSearchInput.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const tagQuery = query.startsWith('#') ? query.slice(1).trim() : query;
  const filtered = serverList.filter(s => {
    const matchName = s.name && s.name.toLowerCase().includes(query);
    const matchHost = s.host && s.host.toLowerCase().includes(query);
    const matchDesc = s.description && s.description.toLowerCase().includes(query);
    const matchGroup = s.group && s.group.toLowerCase().includes(query);
    const matchTags = Array.isArray(s.tags) && s.tags.some(t =>
      t.toLowerCase().includes(tagQuery)
    );
    return matchName || matchHost || matchDesc || matchGroup || matchTags;
  });
  renderSidebarServers(filtered);
});

window.onSidebarItemClick = function(serverId) {
  if (compactViewport.matches) setSidebarOpen(false);
  // 이미 열린 탭이 있다면 해당 탭 활성화, 없으면 새로 열기
  for (const [tabId, session] of sessions.entries()) {
    if (session.serverId === serverId) {
      activateTab(tabId);
      return;
    }
  }
  openNewTab(serverId, true, false);
};

window.openNewTab = function(serverId, autoSwitch = true, isDuplicate = false) {
  if (compactViewport.matches) setSidebarOpen(false);
  createSessionTab(serverId, autoSwitch, null, isDuplicate);
};

// 3. 멀티 세션 탭 생성
function createSessionTab(...args) {
  const deduplicate = !args[2] && !args[3];
  if (deduplicate && pendingTabs.has(args[0])) return pendingTabs.get(args[0]);
  const promise = createSessionTabImpl(...args).finally(() => { if (deduplicate) pendingTabs.delete(args[0]); });
  if (deduplicate) pendingTabs.set(args[0], promise);
  return promise;
}
async function createSessionTabImpl(serverId, autoSwitch = true, customTabId = null, isDuplicate = false, customSessionKey = null) {
  tabCounter++;
  const tabId = customTabId || `tab-${Date.now()}-${tabCounter}`;
  let sessionKey = customSessionKey;
  if (!sessionKey) {
    const hasExistingServerTab = Array.from(sessions.values()).some(s => s.serverId === serverId);
    if (hasExistingServerTab || isDuplicate) {
      // 이미 동일 서버 탭이 열려 있거나 추가 탭인 경우: 독립 세션 키로 동시 유지
      sessionKey = `session_${serverId}_${tabId}`;
    } else {
      // 첫 번째 탭: 기본 영구 세션 키 (기존 백그라운드 세션이 있다면 자동 이어받기)
      sessionKey = `session_${serverId}`;
    }
  }

  // 서버 상세 정보 가져오기
  let serverInfo = null;
  try {
    const res = await apiFetch(`/api/servers/${encodeURIComponent(serverId)}/connection`);
    if (!res.ok) throw new Error('서버 접속 정보를 불러올 수 없습니다.');
    serverInfo = await res.json();
  } catch (err) {
    showNotice('접속 정보 조회 실패: ' + err.message);
    return;
  }

  const proto = serverInfo.protocol || 'vnc';
  const icon = proto === 'ssh' ? '💻' : (proto === 'rdp' ? '🪟' : '🖥️');

  // 1) 탭 헤더 엘리먼트 생성
  const tabEl = document.createElement('div');
  tabEl.className = 'session-tab';
  tabEl.id = `tab-header-${tabId}`;
  tabEl.setAttribute('role', 'tab');
  tabEl.setAttribute('aria-selected', 'false');
  tabEl.tabIndex = -1;
  tabEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Enter', ' '].includes(event.key) || event.target.closest('button')) return;
    event.preventDefault();
    const ids = [...sessions.keys()];
    const index = ids.indexOf(tabId);
    if (event.key === 'Delete') { closeTab(tabId); return; }
    const next = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : event.key === 'ArrowLeft' ? ids[(index + ids.length - 1) % ids.length] : event.key === 'ArrowRight' ? ids[(index + 1) % ids.length] : tabId;
    activateTab(next);
    sessions.get(next)?.tabEl.focus();
  });
  tabEl.innerHTML = `
    <span>${icon}</span>
    <span class="tab-title-text" title="${escapeHtml(serverInfo.name)}">${escapeHtml(serverInfo.name)}</span>
    <span class="tab-status-dot connecting" id="tab-dot-${tabId}">●</span>
    <button class="tab-close-btn" aria-label="세션 종료 및 탭 닫기" title="세션 종료 및 탭 닫기">&times;</button>
  `;

  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close-btn')) return;
    activateTab(tabId);
  });

  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTabContextMenu(e.clientX, e.clientY, tabId);
  });

  tabEl.querySelector('.tab-close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId, true);
  });

  tabsContainer.appendChild(tabEl);

  // 2) 워크스페이스 세션 뷰 엘리먼트 생성
  const sessionView = document.createElement('div');
  sessionView.className = `session-view ${proto === 'ssh' ? 'ssh-view' : ''}`;
  sessionView.id = `session-view-${tabId}`;
  sessionView.setAttribute('role', 'tabpanel');
  sessionView.setAttribute('aria-labelledby', tabEl.id);
  tabEl.setAttribute('aria-controls', sessionView.id);
  sessionsWorkspace.appendChild(sessionView);

  // 3) 세션 객체 생성
  const sessionObj = {
    tabId,
    serverId,
    sessionKey,
    serverInfo,
    engine: proto,
    tabEl,
    viewEl: sessionView,
    status: 'connecting',
    scaleEnabled: true,
    instance: null,
    generation: 0,
    cleanupHandlers: [],
    forceNew: false
  };

  sessions.set(tabId, sessionObj);
  saveOpenTabs();

  if (emptyWorkspaceEl) {
    emptyWorkspaceEl.style.display = 'none';
  }

  // 4) 탭 활성화
  if (autoSwitch) {
    activateTab(tabId);
  }

  // 5) 프로토콜별 접속 개시
  if (proto === 'ssh') {
    await startSshSession(sessionObj);
  } else if (proto === 'rdp') {
    await startRdpSession(sessionObj);
  } else {
    await startVncSession(sessionObj);
  }
}

function saveOpenTabs() {
  try {
    const tabsData = [];
    for (const [tabId, session] of sessions.entries()) {
      tabsData.push({
        tabId,
        serverId: session.serverId,
        sessionKey: session.sessionKey
      });
    }
    localStorage.setItem('remotehub_open_tabs', JSON.stringify(tabsData));
    localStorage.setItem('remotehub_active_tab_id', activeTabId || '');
  } catch (_) {}
}

// 4. 탭 활성화 (스위칭)
function activateTab(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;

  resetControlKey();
  activeTabId = tabId;

  // 헤더 active 클래스 토글
  document.querySelectorAll('.session-tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); el.tabIndex = -1; });
  session.tabEl.classList.add('active');
  session.tabEl.setAttribute('aria-selected', 'true');
  session.tabEl.tabIndex = 0;
  session.tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

  // 뷰 DOM active 토글
  document.querySelectorAll('.session-view').forEach(el => el.classList.remove('active'));
  session.viewEl.classList.add('active');

  // 사이드바 선택 아이템 표시
  document.querySelectorAll('.sidebar-server-item').forEach(el => {
    if (el.getAttribute('data-id') === session.serverId) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // 상단 툴바 상태 동기화
  updateToolbarForSession(session);

  // SSH 터미널 리사이즈 및 포커스
  if (session.engine === 'ssh' && session.instance) {
    setTimeout(() => {
      if (session.instance.fitAddon) {
        session.instance.fitAddon.fit();
      }
      if (session.instance.sendResize) {
        session.instance.sendResize();
      }
      if (session.instance.term) {
        session.instance.term.focus();
      }
    }, 50);
  }

  saveOpenTabs();
  document.title = `${session.serverInfo.name} - RemoteHub`;
}

// 상단 툴바 동기화
function updateToolbarForSession(session) {
  btnReconnect.disabled = !session || Boolean(session.reconnecting);
  sessionMenuButton.disabled = !session;
  mobileInputBar.hidden = !session;
  terminalKeys.hidden = session?.engine !== 'ssh';
  keyboardButton.textContent = session?.engine === 'ssh' ? '키보드' : '텍스트 입력';
  keyboardButton.disabled = !session || session.status !== 'connected';
  terminalKeys.querySelectorAll('button').forEach(button => { button.disabled = !session || session.status !== 'connected'; });
  document.getElementById('rdp-resolution-control').hidden = session?.engine !== 'rdp';
  document.getElementById('rdp-touch-hint').hidden = session?.engine !== 'rdp';
  rdpPanButton.hidden = session?.engine !== 'rdp';
  rdpPanButton.setAttribute('aria-pressed', String(Boolean(session?.rdpPan)));
  rdpPanButton.textContent = session?.rdpPan ? '화면 이동 중 (원격 입력 꺼짐)' : '화면 이동 모드';
  rdpResolution.disabled = session?.status !== 'connected';
  rdpResolution.value = session?.rdpResolution || '1280x720';
  if (!session) resetControlKey();
  if (!session) {
    tabStatusEl.style.display = 'none';
    btnCad.style.display = 'none';
    btnScale.style.display = 'none';
    if (btnClipboard) btnClipboard.style.display = 'none';
    if (sshFontControlsEl) sshFontControlsEl.style.display = 'none';
    return;
  }

  tabStatusEl.style.display = 'inline-flex';
  tabStatusEl.className = `status-indicator ${session.status}`;
  tabStatusEl.textContent = `● ${getStatusMessage(session.status)}`;

  if (btnClipboard) {
    btnClipboard.style.display = 'inline-flex';
  }

  if (session.engine === 'ssh') {
    btnCad.style.display = 'none';
    btnScale.style.display = 'none';
    if (sshFontControlsEl) {
      sshFontControlsEl.style.display = 'inline-flex';
      updateFontSizeDisplay();
    }
  } else {
    if (sshFontControlsEl) sshFontControlsEl.style.display = 'none';
    btnCad.style.display = 'inline-flex';
    btnScale.style.display = 'inline-flex';
    btnScale.textContent = session.scaleEnabled ? '📐 창 맞춤: ON' : '📐 창 맞춤: OFF';
  }
}

function updateSessionStatus(session, status, customMsg = null) {
  session.status = status;
  if (session.engine !== 'ssh') {
    let feedback = session.viewEl.querySelector('.session-feedback');
    if (!feedback) {
      feedback = document.createElement('div');
      feedback.className = 'session-feedback';
      const message = document.createElement('span');
      const retry = document.createElement('button');
      retry.className = 'btn btn-primary btn-sm';
      retry.textContent = '다시 연결';
      retry.addEventListener('click', () => reconnectSession(session.tabId));
      feedback.append(message, retry);
      session.viewEl.appendChild(feedback);
    }
    feedback.hidden = status === 'connected';
    feedback.setAttribute('role', status === 'disconnected' ? 'alert' : 'status');
    feedback.firstElementChild.textContent = customMsg || getStatusMessage(status);
    feedback.lastElementChild.hidden = status !== 'disconnected';
  }
  if (session.tabId === activeTabId) updateToolbarForSession(session);
  session.tabEl.setAttribute('aria-label', `${session.serverInfo.name} · ${customMsg || getStatusMessage(status)}`);
  session.tabEl.title = `${session.serverInfo.name} · ${customMsg || getStatusMessage(status)}`;
  const dot = document.getElementById(`tab-dot-${session.tabId}`);
  if (dot) {
    dot.className = `tab-status-dot ${status}`;
  }

  if (activeTabId === session.tabId) {
    tabStatusEl.className = `status-indicator ${status}`;
    tabStatusEl.textContent = `● ${customMsg || getStatusMessage(status)}`;
  }
}

function getStatusMessage(status) {
  if (status === 'connected') return '연결됨';
  if (status === 'connecting') return '연결 중...';
  return '연결 끊김';
}

// 5. 탭 닫기
function closeTab(tabId, terminateBackend = true) {
  const session = sessions.get(tabId);
  if (!session) return;
  session.userClosed = true;

  if (terminateBackend && session.engine === 'ssh') {
    // 1) WebSocket으로 세션 즉시 완전 종료 요청
    if (session.instance && session.instance.ws && session.instance.ws.readyState === WebSocket.OPEN) {
      try {
        session.instance.ws.send(JSON.stringify({ type: 'terminate' }));
      } catch (_) {}
    }
    // 2) REST API로도 백엔드 세션 제거 확실히 호출 (WS 상태와 무관하게 보장)
    if (session.sessionKey) {
      apiFetch(`/api/sessions/${encodeURIComponent(session.sessionKey)}`, { method: 'DELETE', keepalive: true }).then(response => { if (!response.ok) showNotice('세션 종료를 확인하지 못했습니다. 대시보드에서 다시 확인해 주세요.'); }).catch(() => showNotice('세션 종료 요청에 실패했습니다. 대시보드에서 다시 확인해 주세요.'));
    }
  }

  // 세션 정리
  destroySession(session);

  // DOM 제거
  session.tabEl.remove();
  session.viewEl.remove();
  sessions.delete(tabId);
  saveOpenTabs();

  // 활성 탭이 닫혔다면 다른 탭으로 자동 전환
  if (activeTabId === tabId) {
    if (sessions.size > 0) {
      const remainingTabIds = Array.from(sessions.keys());
      const nextTabId = remainingTabIds[remainingTabIds.length - 1];
      activateTab(nextTabId);
    } else {
      activeTabId = null;
      if (emptyWorkspaceEl) {
        emptyWorkspaceEl.style.display = 'flex';
      }
      updateToolbarForSession(null);
      document.title = 'RemoteHub Console';
    }
  }
}

function scheduleAutoReconnect(session) {
  if (!session || session.userClosed || session.shellExited) return;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
  const delay = Math.min(1000 * Math.pow(1.4, session.reconnectAttempts - 1), 5000);

  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;
    if (session.userClosed || session.shellExited) return;
    if (sessions.get(session.tabId) !== session) return;

    console.log(`[SSH:${session.serverInfo?.name}] Auto-reconnecting attempt #${session.reconnectAttempts}...`);
    await reconnectSession(session.tabId, false);
  }, delay);
}

function destroySession(session) {
  session.generation++;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (pendingPasswordTabId === session.tabId) closePasswordModal();
  session.cleanupHandlers.forEach(fn => {
    try { fn(); } catch (_) {}
  });
  session.cleanupHandlers = [];

  if (session.engine === 'vnc' && session.instance) {
    try { session.instance.disconnect(); } catch (_) {}
  } else if (session.engine === 'rdp' && session.instance) {
    try {
      session.instance.shutdown?.();
      if (typeof session.instance.free === 'function') {
        session.instance.free();
      }
    } catch (_) {}
  } else if (session.engine === 'ssh' && session.instance) {
    try {
      if (session.instance.ws) session.instance.ws.close();
      if (session.instance.term) session.instance.term.dispose();
    } catch (_) {}
  }

  session.instance = null;
}

// 6. SSH 세션 구동
async function startSshSession(session) {
  const generation = session.generation;
  const current = () => sessions.get(session.tabId) === session && session.generation === generation;
  const server = session.serverInfo;
  updateSessionStatus(session, 'connecting', '터미널 준비 중...');

  try {
    const { Terminal } = await import('/xterm/lib/xterm.mjs');
    const { FitAddon } = await import('/xterm-addon-fit/lib/addon-fit.mjs');
    if (!current()) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#0c0c0c',
        foreground: '#f8fafc',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56, 189, 248, 0.3)'
      },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.2
    });

    // Ctrl + / - 글꼴 크기 단축키 지원
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        setTerminalFontSize(terminalFontSize + 1);
        return false;
      }
      if (e.ctrlKey && (e.key === '-' || e.key === '_')) {
        setTerminalFontSize(terminalFontSize - 1);
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(session.viewEl);
    const terminalInput = session.viewEl.querySelector('textarea');
    if (terminalInput) { terminalInput.setAttribute('autocapitalize', 'off'); terminalInput.setAttribute('autocomplete', 'off'); terminalInput.spellcheck = false; }

    requestAnimationFrame(() => {
      if (current()) fitAddon.fit();
    });

    term.focus();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sessionKeyParam = encodeURIComponent(session.sessionKey || `server_${server.id}`);
    const forceNewParam = session.forceNew ? '&forceNew=true' : '';
    const wsUrl = `${protocol}//${window.location.host}/ws?serverId=${encodeURIComponent(server.id)}&sessionKey=${sessionKeyParam}${forceNewParam}`;
    session.forceNew = false;

    updateSessionStatus(session, 'connecting', `${server.name} 접속 중...`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let lastSentCols = 0;
    let lastSentRows = 0;
    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN && term) {
        if (term.cols === lastSentCols && term.rows === lastSentRows) return;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
    };

    // 20초마다 클라이언트 Heartbeat Ping 전송 (브라우저 백그라운드 절전 및 프록시 타임아웃 차단)
    const pingTimer = setInterval(() => {
      if (!current()) {
        clearInterval(pingTimer);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
    }, 20000);
    session.cleanupHandlers.push(() => clearInterval(pingTimer));

    ws.onopen = () => {
      if (!current()) { ws.close(); return; }
      session.reconnectAttempts = 0;
      updateSessionStatus(session, 'connecting', 'SSH 인증 중…');
      fitAddon.fit();
      sendResize();
    };

    let replaying = false;
    let firstDataReceived = false;
    ws.onmessage = (event) => {
      if (!current()) return;
      if (event.data === JSON.stringify({ type: 'pong' })) return;
      if (event.data === JSON.stringify({ type: 'exit' })) {
        session.shellExited = true;
        return;
      }
      if (event.data === JSON.stringify({ type: 'ready' })) {
        session.reconnectAttempts = 0;
        updateSessionStatus(session, 'connected', `연결됨: ${server.name}`);
        return;
      }
      if (event.data === JSON.stringify({ type: 'replay-start' })) { replaying = true; return; }
      if (event.data === JSON.stringify({ type: 'replay-end' })) {
        term.write('', () => { replaying = false; });
        return;
      }
      if (!firstDataReceived) {
        firstDataReceived = true;
        // SSH pty가 뜬 직후 창 크기 재확인 및 전달 (vim/htop 등 전체화면 출력 보장)
        fitAddon.fit();
        sendResize();
      }

      if (typeof event.data === 'string') {
        if (event.data.includes('[RemoteHub] SSH session closed.')) {
          session.shellExited = true;
        }
        term.write(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };

    term.onData((data) => {
      if (!current()) return;
      if (replaying) return;

      if (ws.readyState === WebSocket.OPEN) {
        if (session.tabId === activeTabId && ctrlButton.getAttribute('aria-pressed') === 'true') { data = terminalControlCharacter(data); resetControlKey(); }
        ws.send(data);
      }
    });

    ws.onclose = (event) => {
      if (!current()) return;
      clearInterval(pingTimer);

      // 1) 사용자가 탭을 닫았거나, 원격 셸이 명시적으로 종료(exit/logout 등)된 경우
      if (session.userClosed || session.shellExited || (event && event.code === 1000)) {
        updateSessionStatus(session, 'disconnected', '연결 종료');
        term.write('\r\n\x1b[33m[RemoteHub] Session closed.\x1b[0m\r\n');
        return;
      }

      // 2) 비정상 연결 끊김 (백그라운드 탭 절전, 네트워크 변경, 프록시 타임아웃 등)
      console.warn(`[SSH:${server.name}] WebSocket dropped unexpectedly (code=${event?.code}). Auto-reconnecting...`);
      updateSessionStatus(session, 'connecting', '네트워크 일시 단절 (세션 복원 중...)');
      term.write('\r\n\x1b[33m[RemoteHub] 네트워크 연결이 일시적으로 끊어졌습니다. 세션 복원 중...\x1b[0m\r\n');

      scheduleAutoReconnect(session);
    };

    ws.onerror = () => {
      if (!current()) return;
      if (session.userClosed || session.shellExited) {
        updateSessionStatus(session, 'disconnected', '연결 오류');
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (session.viewEl.classList.contains('active')) {
        fitAddon.fit();
        sendResize();
      }
    });
    resizeObserver.observe(session.viewEl);

    session.cleanupHandlers.push(() => resizeObserver.disconnect());
    session.instance = { term, fitAddon, ws, sendResize };

  } catch (err) {
    if (!current()) return;
    console.error('SSH start error:', err);
    updateSessionStatus(session, 'disconnected', '터미널 실패');
  }
}

// 7. VNC 세션 구동
async function startVncSession(session) {
  const generation = session.generation;
  const current = () => sessions.get(session.tabId) === session && session.generation === generation;
  const server = session.serverInfo;
  updateSessionStatus(session, 'connecting', `${server.name} 연결 중...`);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?serverId=${encodeURIComponent(server.id)}`;

  const options = {
    credentials: {
      password: server.password || ''
    },
    shared: true
  };

  try {
    const rfb = new RFB(session.viewEl, wsUrl, options);
    rfb.scaleViewport = session.scaleEnabled;
    rfb.resizeSession = false;

    rfb.addEventListener('connect', () => {
      if (!current()) return;
      updateSessionStatus(session, 'connected', `연결됨: ${server.name}`);
    });

    rfb.addEventListener('disconnect', (e) => {
      if (!current()) return;
      if (e.detail.clean) {
        updateSessionStatus(session, 'disconnected', '연결 정상 종료');
      } else {
        updateSessionStatus(session, 'disconnected', '연결 끊김');
      }
    });

    rfb.addEventListener('credentialsrequired', () => {
      if (!current()) return;
      updateSessionStatus(session, 'connecting', '비밀번호 대기 중');
      openPasswordModal(session.tabId, 'VNC 비밀번호 필요', '이 VNC 서버 접속에 비밀번호가 필요합니다.');
    });

    rfb.addEventListener('securityfailure', () => {
      if (!current()) return;
      updateSessionStatus(session, 'disconnected', '인증 실패');
      openPasswordModal(session.tabId, '비밀번호 오류', '비밀번호가 올바르지 않습니다. 다시 입력해 주세요.');
    });

    rfb.addEventListener('clipboard', (e) => {
      if (!current()) return;
      const text = e.detail && e.detail.text;
      if (text) {
        session.lastClipboardText = text;
        if (clipboardTextarea) {
          clipboardTextarea.value = text;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
        showClipboardToast('📋 원격지 클립보드가 동기화되었습니다');
      }
    });

    session.instance = rfb;

  } catch (err) {
    if (!current()) return;
    console.error('VNC init error:', err);
    updateSessionStatus(session, 'disconnected', '초기화 실패');
  }
}

// 8. RDP 세션 구동
async function startRdpSession(session) {
  const generation = session.generation;
  const current = () => sessions.get(session.tabId) === session && session.generation === generation;
  const server = session.serverInfo;
  updateSessionStatus(session, 'connecting', 'RDP 엔진 준비 중...');

  try {
    if (!rdpWasmModules) {
      if (!rdpWasmPromise) rdpWasmPromise = import('/ironrdp/pkg/rdp_client.js').then(async wasm => { await wasm.default(); return wasm; }).catch(err => { rdpWasmPromise = null; throw err; });
      rdpWasmModules = await rdpWasmPromise;
    }

    if (!current()) return;
    const {
      SessionBuilder,
      DesktopSize,
      Extension,
      DeviceEvent,
      InputTransaction,
      ClipboardData
    } = rdpWasmModules;

    updateSessionStatus(session, 'connecting', `${server.name} 접속 중...`);

    const canvas = document.createElement('canvas');
    const [desktopWidth, desktopHeight] = (session.rdpResolution || '1280x720').split('x').map(Number);
    canvas.width = desktopWidth;
    canvas.height = desktopHeight;
    canvas.classList.add('rdp-canvas');
    canvas.dataset.touchMode = session.rdpPan ? 'pan' : 'remote';
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';
    canvas.style.display = 'block';
    applyCanvasScale(canvas, session.scaleEnabled);
    session.viewEl.appendChild(canvas);
    canvas.focus();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const proxyAddress = `${protocol}//${window.location.host}/ws?serverId=${encodeURIComponent(server.id)}`;
    const destination = `${server.host}:${server.port || 3389}`;

    const builder = new SessionBuilder();
    builder.username(server.username || 'Administrator');
    builder.password(server.password || '');
    builder.serverDomain(server.domain || '');
    builder.destination(destination);
    builder.proxyAddress(proxyAddress);
    builder.authToken('none');
    builder.desktopSize(new DesktopSize(desktopWidth, desktopHeight));
    builder.renderCanvas(canvas);

    builder.extension(new Extension('enable_credssp', true));

    builder.setCursorStyleCallbackContext(canvas);
    builder.setCursorStyleCallback(function(style) {
      canvas.style.cursor = style || 'default';
    });

    const cleanupInput = setupRdpInputHandlers(canvas, () => session.instance, { DeviceEvent, InputTransaction });
    session.cleanupHandlers.push(cleanupInput);

    const rdpSession = await builder.connect();
    if (!current()) { rdpSession.shutdown?.(); rdpSession.free(); return; }
    session.instance = rdpSession;
    updateSessionStatus(session, 'connected', `연결됨: ${server.name}`);

    rdpSession.run().then(() => {
      if (!current()) return;
      updateSessionStatus(session, 'disconnected', '연결 종료');
    }).catch(err => {
      if (!current()) return;
      console.error('RDP session error:', err);
      updateSessionStatus(session, 'disconnected', '세션 오류');
    });

  } catch (err) {
    if (!current()) return;
    console.error('RDP error:', err);
    updateSessionStatus(session, 'disconnected', 'RDP 연결 실패');
  }
}

function applyCanvasScale(canvas, enabled) {
  if (!canvas) return;
  if (canvas.parentElement) { canvas.parentElement.style.alignItems = enabled ? 'center' : 'flex-start'; canvas.parentElement.style.justifyContent = enabled ? 'center' : 'flex-start'; }
  if (enabled) {
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.margin = 'auto';
  } else {
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
    canvas.style.objectFit = 'none';
    canvas.style.margin = '0';
  }
}

// 9. 패스워드 모달
function openPasswordModal(tabId, title, msg) {
  pendingPasswordTabId = tabId;
  document.getElementById('modal-password-title').textContent = title;
  document.getElementById('modal-password-msg').textContent = msg;
  inputVncPw.value = '';
  modalPassword.classList.add('active');
  inputVncPw.focus();
}

function closePasswordModal() {
  modalPassword.classList.remove('active');
  pendingPasswordTabId = null;
}

function cancelPasswordInput() {
  const session = sessions.get(pendingPasswordTabId);
  closePasswordModal();
  if (session) { destroySession(session); updateSessionStatus(session, 'disconnected', '인증 입력 취소'); }
}
btnCancelPw.addEventListener('click', cancelPasswordInput);
document.getElementById('btn-cancel-password').addEventListener('click', cancelPasswordInput);

formPassword.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = inputVncPw.value;
  const tabId = pendingPasswordTabId;
  closePasswordModal();

  const session = sessions.get(tabId);
  if (!session) return;

  if (session.engine === 'vnc' && session.instance) {
    if (session.serverInfo) {
      session.serverInfo.password = pw;
    }
    if (session.status === 'disconnected') {
      destroySession(session); session.viewEl.innerHTML = ''; startVncSession(session);
    } else { updateSessionStatus(session, 'connecting', '비밀번호 전송 중...'); session.instance.sendCredentials({ password: pw }); }
  } else if (session.engine === 'rdp') {
    session.serverInfo.password = pw;
    destroySession(session);
    session.viewEl.innerHTML = '';
    startRdpSession(session);
  }
});

// 10. 상단 툴바 액션
function getActiveSession() {
  return activeTabId ? sessions.get(activeTabId) : null;
}

btnCad.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session) return;

  if (session.engine === 'vnc' && session.instance) {
    session.instance.sendCtrlAltDel();
  } else if (session.engine === 'rdp' && session.instance && rdpWasmModules) {
    sendRdpCtrlAltDel(session.instance, rdpWasmModules);
  }
});

btnScale.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session) return;

  session.scaleEnabled = !session.scaleEnabled;
  btnScale.textContent = session.scaleEnabled ? '📐 창 맞춤: ON' : '📐 창 맞춤: OFF';

  if (session.engine === 'vnc' && session.instance) {
    session.instance.scaleViewport = session.scaleEnabled;
  } else if (session.engine === 'rdp') {
    const canvas = session.viewEl.querySelector('canvas');
    applyCanvasScale(canvas, session.scaleEnabled);
  }
});

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (!document.documentElement.requestFullscreen) { showNotice('이 브라우저에서는 전체화면을 지원하지 않습니다.'); return; }
    document.documentElement.requestFullscreen().catch(() => showNotice('전체화면을 열지 못했습니다.'));
  } else {
    document.exitFullscreen?.();
  }
});

// 클립보드 모달 열기/닫기 및 액션
function openClipboardModal() {
  if (!modalClipboard) return;
  const activeSession = getActiveSession();
  if (activeSession && activeSession.lastClipboardText && clipboardTextarea && !clipboardTextarea.value) {
    clipboardTextarea.value = activeSession.lastClipboardText;
  }
  // 브라우저 로컬 클립보드 자동 읽기 시도 (HTTPS 또는 지원되는 브라우저 권한일 경우)
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      if (text && clipboardTextarea && !clipboardTextarea.value) {
        clipboardTextarea.value = text;
      }
    }).catch(() => {});
  }
  if (btnClipboardCopyRemote) btnClipboardCopyRemote.hidden = activeSession?.engine !== 'vnc';
  document.querySelector('.clipboard-secondary').open = false;
  modalClipboard.classList.add('active');
  if (clipboardTextarea) {
    setTimeout(() => clipboardTextarea.focus(), 50);
  }
}

function closeClipboardModal() {
  if (modalClipboard) {
    modalClipboard.classList.remove('active');
  }
}

if (btnClipboard) {
  btnClipboard.addEventListener('click', openClipboardModal);
}
if (btnCloseClipboard) {
  btnCloseClipboard.addEventListener('click', closeClipboardModal);
}
if (btnClipboardClear) {
  btnClipboardClear.addEventListener('click', () => {
    if (clipboardTextarea) {
      clipboardTextarea.value = '';
      clipboardTextarea.focus();
    }
  });
}
if (btnClipboardCopyLocal) {
  btnClipboardCopyLocal.addEventListener('click', () => {
    if (!clipboardTextarea) return;
    const text = clipboardTextarea.value;
    if (!text) {
      showClipboardToast('복사할 내용이 없습니다');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showClipboardToast('📥 내 PC 클립보드로 복사되었습니다');
      }).catch(() => {
        clipboardTextarea.select();
        document.execCommand('copy');
        showClipboardToast('📥 내 PC 클립보드로 복사되었습니다');
      });
    } else {
      clipboardTextarea.select();
      document.execCommand('copy');
      showClipboardToast('📥 내 PC 클립보드로 복사되었습니다');
    }
  });
}
// VNC 화면으로 텍스트를 키보드 타이핑하듯 직접 전송 (QEMU 가상머신, 클립보드 데몬 없는 X11 환경 완벽 지원)
async function sendKeystrokesToVnc(rfb, text) {
  if (!rfb || typeof rfb.sendKey !== 'function') return;

  const shiftSymbols = {
    '~': { code: 'Backquote', sym: 0x7e },
    '!': { code: 'Digit1', sym: 0x21 },
    '@': { code: 'Digit2', sym: 0x40 },
    '#': { code: 'Digit3', sym: 0x23 },
    '$': { code: 'Digit4', sym: 0x24 },
    '%': { code: 'Digit5', sym: 0x25 },
    '^': { code: 'Digit6', sym: 0x5e },
    '&': { code: 'Digit7', sym: 0x26 },
    '*': { code: 'Digit8', sym: 0x2a },
    '(': { code: 'Digit9', sym: 0x28 },
    ')': { code: 'Digit0', sym: 0x29 },
    '_': { code: 'Minus', sym: 0x5f },
    '+': { code: 'Equal', sym: 0x2b },
    '{': { code: 'BracketLeft', sym: 0x7b },
    '}': { code: 'BracketRight', sym: 0x7d },
    '|': { code: 'Backslash', sym: 0x7c },
    ':': { code: 'Semicolon', sym: 0x3a },
    '"': { code: 'Quote', sym: 0x22 },
    '<': { code: 'Comma', sym: 0x3c },
    '>': { code: 'Period', sym: 0x3e },
    '?': { code: 'Slash', sym: 0x3f }
  };

  const normalSymbols = {
    '`': { code: 'Backquote', sym: 0x60 },
    '-': { code: 'Minus', sym: 0x2d },
    '=': { code: 'Equal', sym: 0x3d },
    '[': { code: 'BracketLeft', sym: 0x5b },
    ']': { code: 'BracketRight', sym: 0x5d },
    '\\': { code: 'Backslash', sym: 0x5c },
    ';': { code: 'Semicolon', sym: 0x3b },
    "'": { code: 'Quote', sym: 0x27 },
    ',': { code: 'Comma', sym: 0x2c },
    '.': { code: 'Period', sym: 0x2e },
    '/': { code: 'Slash', sym: 0x2f }
  };

  for (const char of text) {
    if (char === '\r') continue;

    if (char === '\n') {
      rfb.sendKey(0xff0d, 'Enter', true);
      rfb.sendKey(0xff0d, 'Enter', false);
    } else if (char === '\t') {
      rfb.sendKey(0xff09, 'Tab', true);
      rfb.sendKey(0xff09, 'Tab', false);
    } else if (char === ' ') {
      rfb.sendKey(0x20, 'Space', true);
      rfb.sendKey(0x20, 'Space', false);
    } else if (char >= 'a' && char <= 'z') {
      const code = 'Key' + char.toUpperCase();
      const sym = char.charCodeAt(0);
      rfb.sendKey(sym, code, true);
      rfb.sendKey(sym, code, false);
    } else if (char >= 'A' && char <= 'Z') {
      const code = 'Key' + char;
      const sym = char.charCodeAt(0);
      rfb.sendKey(0xffe1, 'ShiftLeft', true);
      rfb.sendKey(sym, code, true);
      rfb.sendKey(sym, code, false);
      rfb.sendKey(0xffe1, 'ShiftLeft', false);
    } else if (char >= '0' && char <= '9') {
      const code = 'Digit' + char;
      const sym = char.charCodeAt(0);
      rfb.sendKey(sym, code, true);
      rfb.sendKey(sym, code, false);
    } else if (shiftSymbols[char]) {
      const { code, sym } = shiftSymbols[char];
      rfb.sendKey(0xffe1, 'ShiftLeft', true);
      rfb.sendKey(sym, code, true);
      rfb.sendKey(sym, code, false);
      rfb.sendKey(0xffe1, 'ShiftLeft', false);
    } else if (normalSymbols[char]) {
      const { code, sym } = normalSymbols[char];
      rfb.sendKey(sym, code, true);
      rfb.sendKey(sym, code, false);
    } else {
      const codePoint = char.codePointAt(0);
      const sym = 0x01000000 | codePoint;
      rfb.sendKey(sym, undefined, true);
      rfb.sendKey(sym, undefined, false);
    }

    // 약간의 딜레이로 원격 가상 키보드 버퍼 수신 보장
    await new Promise(r => setTimeout(r, 10));
  }
}

// 1) 원격 OS 클립보드로 전송 (원격지에서 Ctrl+V 또는 우클릭 붙여넣기 사용)
if (btnClipboardCopyRemote) {
  btnClipboardCopyRemote.addEventListener('click', () => {
    if (!clipboardTextarea) return;
    const text = clipboardTextarea.value;
    const activeSession = getActiveSession();
    if (!activeSession) return;

    if (activeSession.engine === 'vnc' && activeSession.instance) {
      activeSession.instance.clipboardPasteFrom(text);
      activeSession.lastClipboardText = text;
      showClipboardToast(`📋 원격 클립보드로 복사되었습니다. 원격지에서 Ctrl+V로 붙여넣으세요 (${text.length}자)`);
      closeClipboardModal();
    } else if (activeSession.engine === 'ssh' && activeSession.instance && activeSession.instance.ws) {
      if (activeSession.instance.ws.readyState === WebSocket.OPEN) {
        activeSession.instance.ws.send(text);
        showClipboardToast(`📤 터미널로 텍스트가 전송되었습니다 (${text.length}자)`);
        closeClipboardModal();
      }
    }
  });
}

// 2) 원격 화면에 직접 타이핑 입력 (QEMU 가상머신, 클립보드 데몬 없는 환경 커서 위치 즉시 입력)
if (btnClipboardTypeRemote) {
  btnClipboardTypeRemote.addEventListener('click', async () => {
    if (!clipboardTextarea) return;
    const text = clipboardTextarea.value;
    const activeSession = getActiveSession();
    if (!activeSession) return;

    closeClipboardModal();

    if (activeSession.engine === 'vnc' && activeSession.instance) {
      showClipboardToast(`⌨️ 원격 화면으로 타이핑 입력 중... (${text.length}자)`);
      const canvas = activeSession.viewEl.querySelector('canvas');
      if (canvas) canvas.focus();

      // 클립보드 버퍼에도 복사해 두고
      try { activeSession.instance.clipboardPasteFrom(text); } catch (_) {}
      activeSession.lastClipboardText = text;

      // 화면에 직접 키스트로크 타이핑 전송!
      await sendKeystrokesToVnc(activeSession.instance, text);
      showClipboardToast(`⌨️ 화면 타이핑 입력 완료 (${text.length}자)`);
    } else if (activeSession.engine === 'rdp' && activeSession.instance && rdpWasmModules) {
      try { sendRdpText(activeSession.instance, text, rdpWasmModules); showClipboardToast(`원격 화면에 텍스트를 입력했습니다 (${text.length}자)`); }
      catch (err) { showNotice('텍스트 입력 실패: ' + err.message); }
    } else if (activeSession.engine === 'ssh' && activeSession.instance && activeSession.instance.ws) {
      if (activeSession.instance.ws.readyState === WebSocket.OPEN) {
        activeSession.instance.ws.send(text);
        if (activeSession.instance.term) activeSession.instance.term.focus();
        showClipboardToast(`⌨️ 터미널로 텍스트 입력 완료 (${text.length}자)`);
      }
    }
  });
}

// 뷰어 화면에서 Ctrl+V 붙여넣기 시 원격지로 자동 전송
window.addEventListener('paste', (e) => {
  // 모달 입력창이나 textarea, 일반 input에서 붙여넣는 중이라면 가로채지 않음
  if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  const activeSession = getActiveSession();
  if (activeSession && activeSession.engine === 'vnc' && activeSession.instance) {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text) {
      activeSession.instance.clipboardPasteFrom(text);
      activeSession.lastClipboardText = text;
      if (clipboardTextarea) {
        clipboardTextarea.value = text;
      }
      showClipboardToast(`📋 클립보드가 원격지로 전송되었습니다 (${text.length}자)`);
    }
  }
});

async function reconnectSession(tabId, forceNew = false) {
  const session = sessions.get(tabId);
  if (!session || session.reconnecting) return;
  session.reconnecting = true;
  btnReconnect.disabled = true;
  try {
    const response = await apiFetch(`/api/servers/${encodeURIComponent(session.serverId)}/connection`);
    const info = await response.json();
    if (!response.ok) throw new Error(info.error || '접속 정보를 확인하지 못했습니다.');
    if (sessions.get(tabId) !== session) return;
    destroySession(session);
    session.serverInfo = info;
    session.engine = info.protocol || 'vnc';
    session.tabEl.querySelector('.tab-title-text').textContent = info.name;
    session.tabEl.firstElementChild.textContent = session.engine === 'ssh' ? '💻' : session.engine === 'rdp' ? '🪟' : '🖥️';
    session.viewEl.removeAttribute('style');
    session.viewEl.classList.toggle('ssh-view', session.engine === 'ssh');
    session.viewEl.innerHTML = '';
    session.forceNew = forceNew;
    if (session.engine === 'ssh') await startSshSession(session);
    else if (session.engine === 'rdp') await startRdpSession(session);
    else await startVncSession(session);
  } catch (err) { showNotice('재연결 실패: ' + err.message); }
  finally {
    session.reconnecting = false;
    updateToolbarForSession(getActiveSession());
  }
}

btnReconnect.addEventListener('click', () => {
  if (activeTabId) {
    reconnectSession(activeTabId, false);
  }
});

// 11. 터미널 폰트 크기 제어
function updateFontSizeDisplay() {
  if (fontSizeDisplay) {
    fontSizeDisplay.textContent = `${terminalFontSize}px`;
  }
}

function setTerminalFontSize(newSize) {
  const clamped = Math.max(10, Math.min(28, newSize));
  terminalFontSize = clamped;
  localStorage.setItem('remotehub_terminal_font_size', terminalFontSize);
  updateFontSizeDisplay();

  // 열려 있는 SSH 세션에 폰트 크기 및 화면 맞춤 즉각 반영
  for (const session of sessions.values()) {
    if (session.engine === 'ssh' && session.instance && session.instance.term) {
      session.instance.term.options.fontSize = terminalFontSize;
      if (session.tabId === activeTabId && session.instance.fitAddon) {
        session.instance.fitAddon.fit();
        if (session.instance.sendResize) {
          session.instance.sendResize();
        }
      }
    }
  }
}

if (btnFontDec) {
  btnFontDec.addEventListener('click', () => setTerminalFontSize(terminalFontSize - 1));
}
if (btnFontInc) {
  btnFontInc.addEventListener('click', () => setTerminalFontSize(terminalFontSize + 1));
}

sessionMenuButton.addEventListener('click', () => {
  if (!activeTabId) return;
  const rect = sessionMenuButton.getBoundingClientRect();
  showTabContextMenu(rect.left, rect.bottom, activeTabId);
  tabContextMenuEl.querySelector('button')?.focus();
});

// 12. 탭 우클릭 컨텍스트 메뉴 (창 복제 / 재연결 / 닫기)
function showTabContextMenu(x, y, tabId) {
  if (!tabContextMenuEl) return;
  contextMenuTargetTabId = tabId;
  tabContextMenuEl.style.display = 'block';

  // 창 경계 초과 방지
  const menuWidth = tabContextMenuEl.offsetWidth;
  const menuHeight = tabContextMenuEl.offsetHeight;
  const posX = (x + menuWidth > window.innerWidth) ? Math.max(10, window.innerWidth - menuWidth - 10) : x;
  const posY = (y + menuHeight > window.innerHeight) ? Math.max(10, window.innerHeight - menuHeight - 10) : y;

  tabContextMenuEl.style.left = `${posX}px`;
  tabContextMenuEl.style.top = `${posY}px`;
}

function hideTabContextMenu() {
  if (tabContextMenuEl) {
    const hadFocus = tabContextMenuEl.contains(document.activeElement);
    tabContextMenuEl.style.display = 'none';
    if (hadFocus) document.querySelector('#viewer-tools > summary')?.focus();
  }
  contextMenuTargetTabId = null;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#tab-context-menu, #btn-session-menu')) {
    hideTabContextMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideTabContextMenu();
  }
});

if (ctxDuplicate) {
  ctxDuplicate.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    const session = sessions.get(tabId);
    if (session) {
      // 탭 복제: 동일한 서버 세션을 새 독립 세션 탭으로 생성
      openNewTab(session.serverId, true, true);
    }
  });
}

if (ctxReconnect) {
  ctxReconnect.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    reconnectSession(tabId, false);
  });
}

if (ctxFresh) {
  ctxFresh.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    if (confirm('기존 백그라운드 세션을 종료하고 새 세션으로 시작하시겠습니까?')) {
      reconnectSession(tabId, true);
    }
  });
}

if (ctxClose) {
  ctxClose.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    closeTab(tabId, true);
  });
}

if (ctxTerminate) {
  ctxTerminate.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    closeTab(tabId, true);
  });
}

if (ctxCloseOthers) {
  ctxCloseOthers.addEventListener('click', () => {
    const tabId = contextMenuTargetTabId;
    hideTabContextMenu();
    if (!tabId) return;
    for (const id of Array.from(sessions.keys())) {
      if (id !== tabId) {
        closeTab(id, true);
      }
    }
  });
}

// 유틸: escapeHtml
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 11. 초기화 실행
async function initViewer() {
  // 사이드바 상태 복원
  const savedSidebar = localStorage.getItem('remotehub_sidebar_open');
  if (compactViewport.matches || savedSidebar === '0') {
    setSidebarOpen(false);
  } else {
    setSidebarOpen(true);
  }

  await loadServers();

  // URL 파라미터 체크 (?id=..., ?forceNew=...)
  const urlParams = new URLSearchParams(window.location.search);
  const targetId = urlParams.get('id');
  const forceNew = urlParams.get('forceNew') === '1' || urlParams.get('forceNew') === 'true';

  // 주소창에서 ?id=...를 정리하여 새로고침 시 기존 탭 목록이 지워지지 않도록 방지
  if (targetId) {
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch (_) {}
  }

  // 1. 브라우저 로컬 저장소 탭 목록 복원 (새로고침 / 브라우저 재실행 시 유지)
  const savedTabsRaw = localStorage.getItem('remotehub_open_tabs');
  const savedActiveTabId = localStorage.getItem('remotehub_active_tab_id');
  let restored = false;

  if (savedTabsRaw) {
    try {
      const savedTabs = JSON.parse(savedTabsRaw);
      if (Array.isArray(savedTabs) && savedTabs.length > 0) {
        for (const t of savedTabs) {
          if (serverList.some(s => s.id === t.serverId)) {
            await createSessionTab(t.serverId, false, t.tabId, false, t.sessionKey);
            restored = true;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to restore saved tabs:', e);
    }
  }

  // 2. URL로 특정 서버 접속이 요청된 경우 활성화 또는 생성
  if (targetId) {
    let foundTabId = null;
    if (!forceNew) {
      for (const [tabId, session] of sessions.entries()) {
        if (session.serverId === targetId) {
          foundTabId = tabId;
          break;
        }
      }
    }
    if (foundTabId) {
      activateTab(foundTabId);
    } else {
      await createSessionTab(targetId, true, null, forceNew);
    }
  } else if (restored) {
    if (savedActiveTabId && sessions.has(savedActiveTabId)) {
      activateTab(savedActiveTabId);
    } else if (sessions.size > 0) {
      activateTab(Array.from(sessions.keys())[0]);
    }
  } else if (savedTabsRaw === null && serverList.length > 0) {
    // 최초 접속 시(저장된 탭 기록이 아예 없는 경우)에만 첫 번째 서버 자동 오픈
    await createSessionTab(serverList[0].id, true);
  } else {
    // 사용자가 모든 탭을 닫아 비어있는 상태인 경우: 빈 화면 유지
    if (emptyWorkspaceEl) {
      emptyWorkspaceEl.style.display = 'flex';
    }
    updateToolbarForSession(null);
  }
}

// 브라우저 백그라운드 절전 복귀 시 단절된 세션 자동 즉시 복원
function checkAndRestoreDroppedSessions() {
  for (const session of sessions.values()) {
    if (session.userClosed || session.shellExited) continue;
    if (session.engine === 'ssh') {
      const ws = session.instance?.ws;
      if (!ws || ws.readyState >= WebSocket.CLOSING) {
        console.log(`[RemoteHub] Tab active: restoring dropped SSH session (${session.serverInfo?.name})`);
        reconnectSession(session.tabId, false);
      }
    } else if (session.status === 'disconnected') {
      console.log(`[RemoteHub] Tab active: restoring dropped session (${session.serverInfo?.name})`);
      reconnectSession(session.tabId, false);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkAndRestoreDroppedSessions();
  }
});

window.addEventListener('focus', checkAndRestoreDroppedSessions);

initViewer();
