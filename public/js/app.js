// 상태 저장
let serversData = [];
let currentGroupFilter = 'ALL';
let appStatus = {
  authEnabled: false,
  isAuthenticated: false
};

// 헬퍼: 모달 열기/닫기
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// 1. 앱 초기 상태 확인
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    appStatus = await res.json();

    const btnLogout = document.getElementById('btn-logout');
    if (appStatus.authEnabled && appStatus.isAuthenticated) {
      btnLogout.style.display = 'inline-flex';
    } else {
      btnLogout.style.display = 'none';
    }

    if (appStatus.authEnabled && !appStatus.isAuthenticated) {
      openModal('modal-login');
      return false;
    } else {
      closeModal('modal-login');
      return true;
    }
  } catch (err) {
    console.error('Failed to check status:', err);
    return false;
  }
}

// 2. 서버 목록 로드
async function loadServers() {
  const ok = await checkStatus();
  if (!ok) return;

  try {
    const res = await fetch('/api/servers');
    if (res.status === 401) {
      openModal('modal-login');
      return;
    }
    serversData = await res.json();
    updateGroupUI();
    filterAndRenderServers();
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

// 그룹 UI 갱신 (상단 필터 바 및 모달 datalist)
function updateGroupUI() {
  // 모달 그룹 입력창용 datalist 채우기
  const groupDatalist = document.getElementById('group-datalist');
  const groups = new Set();
  serversData.forEach(s => {
    if (s.group && s.group.trim()) {
      groups.add(s.group.trim());
    }
  });

  if (groupDatalist) {
    groupDatalist.innerHTML = Array.from(groups).sort()
      .map(g => `<option value="${escapeHtml(g)}">`)
      .join('');
  }

  // 상단 그룹 필터 탭 바 렌더링
  const filterBar = document.getElementById('group-filter-bar');
  if (!filterBar) return;

  if (groups.size === 0) {
    filterBar.style.display = 'none';
    filterBar.innerHTML = '';
    return;
  }

  filterBar.style.display = 'flex';

  const groupCounts = {};
  let ungroupedCount = 0;
  serversData.forEach(s => {
    const g = s.group ? s.group.trim() : '';
    if (g) {
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    } else {
      ungroupedCount++;
    }
  });

  let html = `
    <button type="button" class="group-filter-btn ${currentGroupFilter === 'ALL' ? 'active' : ''}" onclick="selectGroupFilter('ALL')">
      전체 (${serversData.length})
    </button>
  `;

  Array.from(groups).sort().forEach(g => {
    const isActive = currentGroupFilter === g ? 'active' : '';
    html += `
      <button type="button" class="group-filter-btn ${isActive}" onclick="selectGroupFilter('${escapeHtml(g)}')">
        📁 ${escapeHtml(g)} (${groupCounts[g] || 0})
      </button>
    `;
  });

  if (ungroupedCount > 0) {
    const isActive = currentGroupFilter === '__UNGROUPED__' ? 'active' : '';
    html += `
      <button type="button" class="group-filter-btn ${isActive}" onclick="selectGroupFilter('__UNGROUPED__')">
        기타/미분류 (${ungroupedCount})
      </button>
    `;
  }

  filterBar.innerHTML = html;
}

window.selectGroupFilter = function(groupName) {
  currentGroupFilter = groupName;
  updateGroupUI();
  filterAndRenderServers();
};

window.filterByTag = function(tag) {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = '#' + tag;
    filterAndRenderServers();
  }
};

function filterAndRenderServers() {
  const searchInput = document.getElementById('search-input');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  const filtered = serversData.filter(s => {
    // 1. 그룹 필터링
    if (currentGroupFilter !== 'ALL') {
      if (currentGroupFilter === '__UNGROUPED__') {
        if (s.group && s.group.trim()) return false;
      } else {
        if (!s.group || s.group.trim() !== currentGroupFilter) return false;
      }
    }

    // 2. 검색어 필터링
    if (query) {
      const matchName = s.name && s.name.toLowerCase().includes(query);
      const matchHost = s.host && s.host.toLowerCase().includes(query);
      const matchDesc = s.description && s.description.toLowerCase().includes(query);
      const matchGroup = s.group && s.group.toLowerCase().includes(query);
      const tagQuery = query.startsWith('#') ? query.slice(1).trim() : query;
      const matchTags = Array.isArray(s.tags) && s.tags.some(t => 
        t.toLowerCase().includes(tagQuery)
      );
      if (!matchName && !matchHost && !matchDesc && !matchGroup && !matchTags) {
        return false;
      }
    }

    return true;
  });

  renderServers(filtered);
  filtered.forEach(s => checkServerPing(s.id));
}

let draggedServerId = null;

// 3. 서버 카드 렌더링
function renderServers(servers) {
  const grid = document.getElementById('servers-grid');
  if (!servers || servers.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>해당하는 원격 서버가 없습니다.</h3>
        <p>검색 조건이나 선택된 그룹을 확인해 보세요.</p>
        <button class="btn btn-primary" onclick="openAddServerModal()">새 서버 추가하기</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = servers.map((s, index) => {
    const protocol = s.protocol || 'vnc';
    const isFirst = index === 0;
    const isLast = index === servers.length - 1;
    const authNote = protocol === 'ssh' ? (s.authType === 'key' ? '🔑 Key' : '🔒 PW') : '';
    const endpointText = `${s.host}:${s.port}${s.username ? ` (${s.username})` : ''} ${authNote}`;
    const connectLabel = protocol === 'ssh' ? '💻 터미널 접속' : '🖥️ 접속하기';
    const groupBadge = s.group ? `<span class="group-badge">📁 ${escapeHtml(s.group)}</span>` : '';
    const tagsHtml = (s.tags && s.tags.length > 0)
      ? `<div class="tags-container">${s.tags.map(t => `<span class="tag-badge" onclick="event.stopPropagation(); filterByTag('${escapeHtml(t)}')" style="cursor: pointer;" title="'#${escapeHtml(t)}' 태그 검색">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const initialCmdBadge = (protocol === 'ssh' && s.initialCommand) 
      ? `<div style="font-family: monospace; font-size: 0.75rem; color: #34d399; margin-top: 4px;">⚡ ${escapeHtml(s.initialCommand)}</div>`
      : '';

    return `
      <div class="server-card" id="card-${s.id}" draggable="true" data-id="${s.id}" data-index="${index}">
        <div>
          <div class="card-header">
            <div class="card-title-row">
              <span class="protocol-badge ${protocol}">${protocol}</span>
              ${groupBadge}
              <h3 class="card-title">${escapeHtml(s.name)}</h3>
            </div>
            <div class="card-top-actions">
              <div class="order-controls">
                <button type="button" class="btn-icon" title="위로 이동" onclick="moveServerOrder(${index}, -1)" ${isFirst ? 'disabled' : ''}>▲</button>
                <button type="button" class="btn-icon" title="아래로 이동" onclick="moveServerOrder(${index}, 1)" ${isLast ? 'disabled' : ''}>▼</button>
              </div>
              <span class="status-badge checking" id="badge-${s.id}">
                <span class="dot">●</span> 확인 중
              </span>
            </div>
          </div>
          <div class="card-body">
            <div class="server-endpoint">${escapeHtml(endpointText)}</div>
            ${initialCmdBadge}
            <div class="server-desc">${escapeHtml(s.description || '등록된 설명이 없습니다.')}</div>
            ${tagsHtml}
          </div>
        </div>
        <div class="card-footer">
          <a href="/viewer.html?id=${s.id}" class="btn btn-primary btn-sm">
            ${connectLabel}
          </a>
          <div class="card-actions-right">
            <button class="btn btn-secondary btn-sm" onclick="openEditServerModal('${s.id}')">
              수정
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteServer('${s.id}', '${escapeHtml(s.name)}')">
              삭제
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  setupDragAndDrop();
}

// 드래그 앤 드롭 순서 변경 설정
function setupDragAndDrop() {
  const cards = document.querySelectorAll('.server-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedServerId = card.getAttribute('data-id');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedServerId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cards.forEach(c => c.classList.remove('drag-over'));
      draggedServerId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = card.getAttribute('data-id');
      if (!draggedServerId || draggedServerId === targetId) return;

      const fromIndex = serversData.findIndex(s => s.id === draggedServerId);
      const toIndex = serversData.findIndex(s => s.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return;

      const newServers = [...serversData];
      const [moved] = newServers.splice(fromIndex, 1);
      newServers.splice(toIndex, 0, moved);

      await saveServerOrder(newServers.map(s => s.id));
    });
  });
}

// 화살표 버튼으로 순서 이동
async function moveServerOrder(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= serversData.length) return;

  const newServers = [...serversData];
  const temp = newServers[index];
  newServers[index] = newServers[targetIndex];
  newServers[targetIndex] = temp;

  await saveServerOrder(newServers.map(s => s.id));
}

// 서버 순서 서버에 저장
async function saveServerOrder(serverIds) {
  try {
    const res = await fetch('/api/servers/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverIds })
    });

    if (!res.ok) {
      const err = await res.json();
      alert('순서 저장 실패: ' + (err.error || '알 수 없는 오류'));
      return;
    }

    serversData = await res.json();
    updateGroupUI();
    filterAndRenderServers();
  } catch (err) {
    console.error('Failed to save server order:', err);
    alert('순서 변경 중 오류 발생: ' + err.message);
  }
}

// 4. 각 서버 포트 핑 체크
async function checkServerPing(id) {
  const badge = document.getElementById(`badge-${id}`);
  if (!badge) return;

  try {
    const res = await fetch(`/api/servers/${id}/ping`);
    const data = await res.json();
    if (data.online) {
      badge.className = 'status-badge online';
      badge.innerHTML = `● 온라인 (${data.latency}ms)`;
    } else {
      badge.className = 'status-badge offline';
      badge.innerHTML = `● 오프라인`;
    }
  } catch (err) {
    badge.className = 'status-badge offline';
    badge.innerHTML = `● 확인 불가`;
  }
}

function checkAllServersPing() {
  serversData.forEach(s => checkServerPing(s.id));
}

// 프리셋 명령어 채우기 헬퍼
window.setCmdPreset = function(cmd) {
  const input = document.getElementById('server-initial-cmd');
  if (input) input.value = cmd;
};

// 키 파일 읽기 이벤트 리스너
const inputKeyFile = document.getElementById('input-key-file');
if (inputKeyFile) {
  inputKeyFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      document.getElementById('server-private-key').value = evt.target.result;
    };
    reader.readAsText(file);
  });
}

// 프로토콜 폼 변경 핸들러
function handleProtocolChange(protocol) {
  const portInput = document.getElementById('server-port');
  const userGroup = document.getElementById('credential-user-group');
  const userLabel = document.getElementById('label-server-username');
  const domainGroup = document.getElementById('group-server-domain');
  const sshAuthGroup = document.getElementById('ssh-auth-type-group');
  const sshKeyFields = document.getElementById('ssh-key-fields');
  const sshStartupFields = document.getElementById('ssh-startup-fields');
  const pwGroup = document.getElementById('group-server-password');
  const pwLabel = document.getElementById('label-server-password');

  const authType = document.querySelector('input[name="ssh-auth-type"]:checked')?.value || 'password';

  if (protocol === 'ssh') {
    if (portInput.value === '5900' || portInput.value === '3389') {
      portInput.value = '22';
    }
    userGroup.style.display = 'block';
    userLabel.textContent = 'SSH 사용자 이름 (Username)';
    domainGroup.style.display = 'none';
    sshAuthGroup.style.display = 'block';
    sshStartupFields.style.display = 'block';

    if (authType === 'key') {
      pwGroup.style.display = 'none';
      sshKeyFields.style.display = 'block';
    } else {
      pwGroup.style.display = 'block';
      pwLabel.textContent = 'SSH 비밀번호 (선택사항)';
      sshKeyFields.style.display = 'none';
    }
  } else if (protocol === 'rdp') {
    if (portInput.value === '5900' || portInput.value === '22') {
      portInput.value = '3389';
    }
    userGroup.style.display = 'block';
    userLabel.textContent = 'RDP 사용자 이름 (Username)';
    domainGroup.style.display = 'block';
    sshAuthGroup.style.display = 'none';
    sshKeyFields.style.display = 'none';
    sshStartupFields.style.display = 'none';
    pwGroup.style.display = 'block';
    pwLabel.textContent = 'RDP 비밀번호 (선택사항)';
  } else {
    // VNC
    if (portInput.value === '3389' || portInput.value === '22') {
      portInput.value = '5900';
    }
    userGroup.style.display = 'none';
    domainGroup.style.display = 'none';
    sshAuthGroup.style.display = 'none';
    sshKeyFields.style.display = 'none';
    sshStartupFields.style.display = 'none';
    pwGroup.style.display = 'block';
    pwLabel.textContent = 'VNC 비밀번호 (선택사항)';
  }
}

// SSH 인증방식(비밀번호 vs 키) 라디오 이벤트 리스너
document.querySelectorAll('input[name="ssh-auth-type"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const protocol = document.querySelector('input[name="server-protocol"]:checked')?.value;
    if (protocol === 'ssh') {
      handleProtocolChange('ssh');
    }
  });
});

// 5. 서버 추가 모달 열기
function openAddServerModal() {
  document.getElementById('modal-server-title').textContent = '새 원격 서버 추가';
  document.getElementById('server-id').value = '';
  document.getElementById('server-name').value = '';
  document.getElementById('server-host').value = '';
  document.getElementById('server-port').value = '5900';
  document.getElementById('server-username').value = '';
  document.getElementById('server-domain').value = '';
  document.getElementById('server-password').value = '';
  document.getElementById('server-private-key').value = '';
  document.getElementById('server-passphrase').value = '';
  document.getElementById('server-initial-cmd').value = '';
  document.getElementById('server-group').value = '';
  document.getElementById('server-tags').value = '';
  document.getElementById('server-desc').value = '';
  document.getElementById('server-pw-hint').style.display = 'none';
  document.getElementById('server-key-hint').style.display = 'none';

  const radioVnc = document.querySelector('input[name="server-protocol"][value="vnc"]');
  if (radioVnc) radioVnc.checked = true;

  const radioAuthPw = document.querySelector('input[name="ssh-auth-type"][value="password"]');
  if (radioAuthPw) radioAuthPw.checked = true;

  handleProtocolChange('vnc');
  openModal('modal-server');
}

// 6. 서버 수정 모달 열기
function openEditServerModal(id) {
  const server = serversData.find(s => s.id === id);
  if (!server) return;

  const protocol = server.protocol || 'vnc';
  const authType = server.authType || 'password';

  document.getElementById('modal-server-title').textContent = '원격 서버 정보 수정';
  document.getElementById('server-id').value = server.id;
  document.getElementById('server-name').value = server.name;
  document.getElementById('server-host').value = server.host;
  document.getElementById('server-port').value = server.port;
  document.getElementById('server-username').value = server.username || '';
  document.getElementById('server-domain').value = server.domain || '';
  document.getElementById('server-password').value = '';
  document.getElementById('server-private-key').value = '';
  document.getElementById('server-passphrase').value = '';
  document.getElementById('server-initial-cmd').value = server.initialCommand || '';
  document.getElementById('server-group').value = server.group || '';
  document.getElementById('server-tags').value = (server.tags || []).join(', ');
  document.getElementById('server-desc').value = server.description || '';
  
  const radio = document.querySelector(`input[name="server-protocol"][value="${protocol}"]`);
  if (radio) radio.checked = true;

  const authRadio = document.querySelector(`input[name="ssh-auth-type"][value="${authType}"]`);
  if (authRadio) authRadio.checked = true;

  handleProtocolChange(protocol);

  const pwHint = document.getElementById('server-pw-hint');
  pwHint.style.display = server.hasPassword ? 'block' : 'none';

  const keyHint = document.getElementById('server-key-hint');
  keyHint.style.display = server.hasPrivateKey ? 'block' : 'none';

  openModal('modal-server');
}

// 7. 서버 저장 (추가/수정)
document.getElementById('form-server').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('server-id').value;
  const protocol = document.querySelector('input[name="server-protocol"]:checked')?.value || 'vnc';
  const authType = document.querySelector('input[name="ssh-auth-type"]:checked')?.value || 'password';
  const name = document.getElementById('server-name').value.trim();
  const host = document.getElementById('server-host').value.trim();
  const port = parseInt(document.getElementById('server-port').value, 10);
  const username = document.getElementById('server-username').value.trim();
  const domain = document.getElementById('server-domain').value.trim();
  const password = document.getElementById('server-password').value;
  const privateKey = document.getElementById('server-private-key').value.trim();
  const passphrase = document.getElementById('server-passphrase').value;
  const initialCommand = document.getElementById('server-initial-cmd').value.trim();
  const group = document.getElementById('server-group').value.trim();
  const tags = document.getElementById('server-tags').value.trim();
  const description = document.getElementById('server-desc').value.trim();

  const payload = {
    protocol,
    authType,
    name,
    host,
    port,
    username,
    domain,
    initialCommand,
    group,
    tags,
    description
  };

  // 비밀번호 입력 처리
  if (password || (!id && authType === 'password')) {
    payload.password = password;
  }
  // 개인키 입력 처리
  if (privateKey || (!id && authType === 'key')) {
    payload.privateKey = privateKey;
    payload.passphrase = passphrase;
  } else if (passphrase) {
    payload.passphrase = passphrase;
  }

  try {
    let res;
    if (id) {
      res = await fetch(`/api/servers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || '저장에 실패했습니다.');
      return;
    }

    closeModal('modal-server');
    loadServers();
  } catch (err) {
    alert('요청 중 오류가 발생했습니다: ' + err.message);
  }
});

// 프로토콜 라디오 버튼 이벤트 등록
document.querySelectorAll('input[name="server-protocol"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    handleProtocolChange(e.target.value);
  });
});

// 8. 서버 삭제
async function deleteServer(id, name) {
  if (!confirm(`정말 "${name}" 서버를 삭제하시겠습니까?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || '삭제 실패');
      return;
    }
    loadServers();
  } catch (err) {
    alert('삭제 중 오류 발생: ' + err.message);
  }
}

// 9. 환경설정 모달 열기
document.getElementById('btn-open-settings').addEventListener('click', async () => {
  await checkStatus();
  const authCheckbox = document.getElementById('setting-auth-enabled');
  const authFields = document.getElementById('auth-fields');
  const groupCurrent = document.getElementById('group-current-password');

  authCheckbox.checked = appStatus.authEnabled;
  authFields.style.display = appStatus.authEnabled ? 'block' : 'none';
  groupCurrent.style.display = appStatus.authEnabled ? 'block' : 'none';

  document.getElementById('setting-current-password').value = '';
  document.getElementById('setting-new-password').value = '';
  document.getElementById('setting-confirm-password').value = '';

  openModal('modal-settings');
});

// 환경설정 체크박스 토글
document.getElementById('setting-auth-enabled').addEventListener('change', (e) => {
  const authFields = document.getElementById('auth-fields');
  authFields.style.display = e.target.checked ? 'block' : 'none';
});

// 환경설정 폼 제출
document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = document.getElementById('setting-auth-enabled').checked;
  const currentPassword = document.getElementById('setting-current-password').value;
  const newPassword = document.getElementById('setting-new-password').value;
  const confirmPassword = document.getElementById('setting-confirm-password').value;

  if (enabled && newPassword && newPassword !== confirmPassword) {
    alert('새 마스터 비밀번호가 일치하지 않습니다.');
    return;
  }

  try {
    const res = await fetch('/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || '설정 저장 실패');
      return;
    }

    alert('설정이 성공적으로 저장되었습니다.');
    closeModal('modal-settings');
    loadServers();
  } catch (err) {
    alert('설정 저장 중 오류: ' + err.message);
  }
});

// 10. 로그인 폼 제출
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errorBox = document.getElementById('login-error');
  errorBox.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorBox.textContent = data.error || '로그인 실패';
      errorBox.style.display = 'block';
      return;
    }

    closeModal('modal-login');
    document.getElementById('login-password').value = '';
    loadServers();
  } catch (err) {
    errorBox.textContent = '로그인 요청 중 오류 발생: ' + err.message;
    errorBox.style.display = 'block';
  }
});

// 11. 로그아웃
document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('로그아웃 하시겠습니까?')) return;
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
});

// 12. 검색 필터
document.getElementById('search-input').addEventListener('input', () => {
  filterAndRenderServers();
});

// 유틸: HTML escape
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 이벤트 리스너 등록
document.getElementById('btn-open-add-server').addEventListener('click', openAddServerModal);

// 초기 실행
loadServers();
