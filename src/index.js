// --- ДИНАМИЧЕСКОЕ ЛОББИ ---
async function loadLobby() {
  if (!window.__currentUser) return;
  try {
    const res = await fetch(API + '/api/lobby/me', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tf_token') }
    });
    const data = await res.json();
    renderLobby(data.lobby, data.membersData || []);
  } catch(e) {
    console.error('Ошибка загрузки лобби:', e);
  }
}

function renderLobby(lobby, members) {
  const slotsEl = document.getElementById('lobby-slots');
  const rightEl = document.getElementById('lobby-members-right');
  const titleEl = document.getElementById('lobby-title');
  const metaEl = document.getElementById('lobby-meta');
  const slotsTitleEl = document.getElementById('lobby-slots-title');
  const modeBadgeEl = document.getElementById('lobby-mode-badge');

  if (!slotsEl || !rightEl) return;

  if (!lobby) {
    titleEl.textContent = 'Лобби не найдено';
    metaEl.innerHTML = '<span class="lm">0/5</span>';
    slotsTitleEl.textContent = 'Слоты (0/5)';
    slotsEl.innerHTML = '<div style="opacity:0.5; margin-top:1rem;">Вы не состоите в лобби.</div>';
    rightEl.innerHTML = '<div class="ptl">В лобби — 0</div>';
    return;
  }

  const currentUserId = window.__currentUser?.steamid;
  const membersCount = members.length;

  titleEl.textContent = `Лобби #${String(lobby._id).slice(-4)}`;
  modeBadgeEl.textContent = `⚡ ${lobby.gameMode || 'Premier'} Squad`;
  metaEl.innerHTML = `
    <span class="lm">${membersCount}/5</span>
    <span class="lm">${lobby.gameMode || 'Premier'}</span>
  `;
  slotsTitleEl.textContent = `Слоты (${membersCount}/5)`;

  slotsEl.innerHTML = '';
  rightEl.innerHTML = `<div class="ptl">В лобби — ${membersCount}</div>`;

  // Рендер реальных игроков
  members.forEach(member => {
    const isHost = lobby.ownerId === member.steamid;
    const isMe = currentUserId === member.steamid;
    const initials = (member.name || 'U').slice(0,2).toUpperCase();
    
    // Показываем реальную аватарку, если есть
    const avatarHtml = member.avatar 
      ? `<img src="${member.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` 
      : initials;

    slotsEl.innerHTML += `
      <div class="slt ${isHost ? 'host' : ''}">
        <div class="sa" style="${member.avatar ? 'background:transparent;' : 'background:linear-gradient(135deg,#ff7a2b,#8a7dff)'}">
          ${avatarHtml}
        </div>
        <div class="si2">
          <strong>${isMe ? 'Вы' : (member.name || 'Игрок')} ${isHost ? '<span style="color:var(--tf);font-size:9px">HOST</span>' : ''}</strong>
          <span>${member.mmrank || 'Без ранга'} · ${member.role || 'Any'}</span>
        </div>
      </div>
    `;

    rightEl.innerHTML += `
      <div class="mrow">
        <div class="sa" style="width:32px;height:32px; ${member.avatar ? 'background:transparent;' : ''}">${avatarHtml}</div>
        <div class="mi">
          <strong>${isMe ? 'Вы' : (member.name || 'Игрок')} ${isHost ? '<span style="color:var(--tf);font-size:9px">HOST</span>' : ''}</strong>
          <span>${member.mmrank || 'Без ранга'} · ${member.role || 'Any'}</span>
        </div>
      </div>
    `;
  });

  // Рендер пустых слотов
  for(let i = membersCount; i < 5; i++){
    slotsEl.innerHTML += `
      <div class="slt empty">
        <div class="sa">+</div>
        <div class="si2">
          <strong>Открытый слот</strong>
          <span><button class="btn bs bsm" onclick="navigate('search')">Найти игроков</button></span>
        </div>
      </div>
    `;
  }
}

// Перехватываем смену вкладок, чтобы обновлять лобби при заходе на страницу лобби
const originalNavigateFunction = navigate;
navigate = function(to) {
  originalNavigateFunction(to);
  if (to === 'lobby') {
    loadLobby();
  }
};

// Функция МОМЕНТАЛЬНОГО добавления в лобби
async function addToLobby(targetId) {
  try {
    const res = await fetch(API + '/api/lobby/add-member', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + localStorage.getItem('tf_token'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ targetId })
    });

    const data = await res.json();
    if (!res.ok) {
      return toast(data.error || 'Ошибка добавления', 'var(--tf)');
    }

    toast('Игрок успешно добавлен в лобби!', 'var(--ok)');
    loadLobby(); // Обновляем экран
  } catch(e) {
    toast('Ошибка сети', 'var(--tf)');
  }
}
