const state = {
  token: localStorage.getItem('aichat.token') || '',
  selectedPersonaId: localStorage.getItem('aichat.personaId') || '',
  selectedSessionId: localStorage.getItem('aichat.sessionId') || '',
  sessionCursor: null,
  messageCursor: null,
};

const $ = (id) => document.getElementById(id);

const fields = {
  apiBase: $('apiBase'),
  authId: $('authId'),
  authPassword: $('authPassword'),
  tokenPreview: $('tokenPreview'),
  memoryContent: $('memoryContent'),
  memoryList: $('memoryList'),
  personaSearch: $('personaSearch'),
  personaName: $('personaName'),
  personaDescription: $('personaDescription'),
  personaProfile: $('personaProfile'),
  personaPersonality: $('personaPersonality'),
  personaSpeakingStyle: $('personaSpeakingStyle'),
  personaScenario: $('personaScenario'),
  personaGreeting: $('personaGreeting'),
  personaPublic: $('personaPublic'),
  selectedPersonaId: $('selectedPersonaId'),
  personaList: $('personaList'),
  sessionTitle: $('sessionTitle'),
  selectedSessionId: $('selectedSessionId'),
  sessionList: $('sessionList'),
  moreSessionsButton: $('moreSessionsButton'),
  statsFrom: $('statsFrom'),
  statsTo: $('statsTo'),
  statsOutput: $('statsOutput'),
  messages: $('messages'),
  messageContent: $('messageContent'),
  moreMessagesButton: $('moreMessagesButton'),
  logOutput: $('logOutput'),
};

fields.apiBase.value = window.location.origin;

function apiBase() {
  return fields.apiBase.value.replace(/\/$/, '');
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
}

function jsonHeaders() {
  return authHeaders({ 'Content-Type': 'application/json' });
}

function setToken(token) {
  state.token = token || '';
  if (state.token) {
    localStorage.setItem('aichat.token', state.token);
  } else {
    localStorage.removeItem('aichat.token');
  }
  renderSelections();
}

function setPersona(id) {
  state.selectedPersonaId = id || '';
  if (id) {
    localStorage.setItem('aichat.personaId', id);
  } else {
    localStorage.removeItem('aichat.personaId');
  }
  renderSelections();
}

function setSession(id) {
  state.selectedSessionId = id || '';
  state.messageCursor = null;
  if (id) {
    localStorage.setItem('aichat.sessionId', id);
  } else {
    localStorage.removeItem('aichat.sessionId');
  }
  fields.messages.innerHTML = '';
  renderSelections();
}

function renderSelections() {
  fields.tokenPreview.textContent = state.token
    ? `${state.token.slice(0, 18)}...${state.token.slice(-10)}`
    : '없음';
  fields.selectedPersonaId.textContent = state.selectedPersonaId || '없음';
  fields.selectedSessionId.textContent = state.selectedSessionId || '없음';
}

function log(message, data) {
  const time = new Date().toLocaleTimeString();
  const body = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
  fields.logOutput.textContent = `[${time}] ${message}${body}\n\n${fields.logOutput.textContent}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase()}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(
      typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    );
  }

  return data;
}

function personaPayload() {
  return {
    name: fields.personaName.value.trim(),
    description: fields.personaDescription.value.trim(),
    profile: fields.personaProfile.value.trim(),
    personality: fields.personaPersonality.value.trim(),
    speakingStyle: fields.personaSpeakingStyle.value.trim(),
    scenario: fields.personaScenario.value.trim(),
    greetingMessage: fields.personaGreeting.value.trim(),
    isPublic: fields.personaPublic.checked,
  };
}

function renderPersonaList(personas) {
  fields.personaList.innerHTML = '';
  for (const persona of personas) {
    const item = document.createElement('div');
    item.className = `item ${persona.id === state.selectedPersonaId ? 'active' : ''}`;
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(persona.name)}</strong>
        <span class="item-meta">${persona.isPublic ? 'public' : 'private'}</span>
      </div>
      <div>${escapeHtml(persona.description || '')}</div>
      <div class="item-meta">${persona.id}</div>
      <div class="row">
        <button type="button" data-action="select">선택</button>
        <button type="button" data-action="fill" class="secondary">폼에 채우기</button>
      </div>
    `;
    item.querySelector('[data-action="select"]').addEventListener('click', () => {
      setPersona(persona.id);
      renderPersonaList(personas);
    });
    item.querySelector('[data-action="fill"]').addEventListener('click', () => {
      fillPersonaForm(persona);
    });
    fields.personaList.appendChild(item);
  }
}

function fillPersonaForm(persona) {
  setPersona(persona.id);
  fields.personaName.value = persona.name || '';
  fields.personaDescription.value = persona.description || '';
  fields.personaProfile.value = persona.profile || '';
  fields.personaPersonality.value = persona.personality || '';
  fields.personaSpeakingStyle.value = persona.speakingStyle || '';
  fields.personaScenario.value = persona.scenario || '';
  fields.personaGreeting.value = persona.greetingMessage || '';
  fields.personaPublic.checked = Boolean(persona.isPublic);
}

function renderSessionList(sessions, append = false) {
  if (!append) {
    fields.sessionList.innerHTML = '';
  }
  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = `item ${session.id === state.selectedSessionId ? 'active' : ''}`;
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(session.title || 'Untitled')}</strong>
        <span class="item-meta">${escapeHtml(session.lastMessageAt || 'no messages')}</span>
      </div>
      <div class="item-meta">persona: ${session.personaId}</div>
      <div class="item-meta">tokens: ${session.tokenUsage?.total ?? 0}</div>
      <div class="row">
        <button type="button" data-action="select">선택</button>
        <button type="button" data-action="delete" class="secondary">삭제</button>
      </div>
    `;
    item.querySelector('[data-action="select"]').addEventListener('click', () => {
      setSession(session.id);
      [...fields.sessionList.children].forEach((child) =>
        child.classList.remove('active'),
      );
      item.classList.add('active');
      run('메시지 목록', () => loadMessages(null, false));
    });
    item.querySelector('[data-action="delete"]').addEventListener('click', () => {
      run('세션 삭제', async () => {
        await request(`/sessions/${session.id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });

        if (state.selectedSessionId === session.id) {
          setSession('');
        }

        await loadSessions(null, false);
      });
    });
    fields.sessionList.appendChild(item);
  }
}

function renderMemories(memories) {
  fields.memoryList.innerHTML = '';
  for (const memory of memories) {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div>${escapeHtml(memory.content)}</div>
      <div class="item-meta">${memory.id}</div>
      <button type="button" class="secondary">삭제</button>
    `;
    item.querySelector('button').addEventListener('click', async () => {
      await run('메모리 삭제', async () => {
        await request(`/users/me/memories/${memory.id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        await loadMemories();
      });
    });
    fields.memoryList.appendChild(item);
  }
}

function renderMessages(messages, appendTop = false) {
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    fragment.appendChild(messageNode(message));
  }
  if (appendTop) {
    fields.messages.prepend(fragment);
  } else {
    fields.messages.innerHTML = '';
    fields.messages.appendChild(fragment);
    fields.messages.scrollTop = fields.messages.scrollHeight;
  }
}

function messageNode(message) {
  const item = document.createElement('div');
  item.className = `message ${message.role} ${message.streamStatus === 'failed' ? 'failed' : ''}`;
  item.dataset.messageId = message.id || '';
  item.textContent = message.content || '';
  return item;
}

async function run(label, action) {
  try {
    const result = await action();
    log(`${label} 성공`, result);
    return result;
  } catch (error) {
    log(`${label} 실패`, error.message);
    return null;
  }
}

async function loadMemories() {
  const memories = await request('/users/me/memories', {
    headers: authHeaders(),
  });
  renderMemories(memories);
  return memories;
}

async function loadPersonas() {
  const name = fields.personaSearch.value.trim();
  const path = name ? `/personas?name=${encodeURIComponent(name)}` : '/personas';
  const personas = await request(path, { headers: authHeaders() });
  renderPersonaList(personas);
  return personas;
}

async function loadSessions(cursor = null, append = false) {
  const path = cursor ? `/sessions?cursor=${cursor}` : '/sessions';
  const page = await request(path, { headers: authHeaders() });
  state.sessionCursor = page.nextCursor;
  fields.moreSessionsButton.classList.toggle('hidden', !page.nextCursor);
  renderSessionList(page.items, append);
  return page;
}

async function loadMessages(cursor = null, appendTop = false) {
  if (!state.selectedSessionId) {
    throw new Error('세션을 먼저 선택');
  }
  const path = cursor
    ? `/sessions/${state.selectedSessionId}/messages?cursor=${cursor}`
    : `/sessions/${state.selectedSessionId}/messages`;
  const page = await request(path, { headers: authHeaders() });
  state.messageCursor = page.nextCursor;
  fields.moreMessagesButton.classList.toggle('hidden', !page.nextCursor);
  renderMessages(page.items, appendTop);
  return page;
}

async function sendMessage() {
  if (!state.selectedSessionId) {
    throw new Error('세션을 먼저 선택');
  }

  const content = fields.messageContent.value.trim();
  if (!content) {
    throw new Error('메시지를 입력');
  }

  const response = await fetch(
    `${apiBase()}/sessions/${state.selectedSessionId}/messages`,
    {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }),
      body: JSON.stringify({ content }),
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  fields.messageContent.value = '';
  await readSse(response.body);
}

async function readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantNode = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const rawEvent of events) {
      const parsed = parseSse(rawEvent);
      if (!parsed) {
        continue;
      }

      if (parsed.event === 'user_message_saved') {
        fields.messages.appendChild(messageNode(parsed.data));
      }

      if (parsed.event === 'assistant_message_started') {
        assistantNode = messageNode(parsed.data);
        fields.messages.appendChild(assistantNode);
      }

      if (parsed.event === 'chunk' && assistantNode) {
        assistantNode.textContent += parsed.data.content || '';
      }

      if (parsed.event === 'assistant_message_failed' && assistantNode) {
        assistantNode.classList.add('failed');
      }

      if (parsed.event === 'assistant_message_completed') {
        log('assistant 완료', parsed.data);
      }

      if (parsed.event === 'error') {
        log('SSE error', parsed.data);
      }

      fields.messages.scrollTop = fields.messages.scrollHeight;
    }
  }
}

function parseSse(rawEvent) {
  const lines = rawEvent.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLine = lines.find((line) => line.startsWith('data:'));

  if (!eventLine || !dataLine) {
    return null;
  }

  return {
    event: eventLine.slice(6).trim(),
    data: JSON.parse(dataLine.slice(5).trim()),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function bindEvents() {
  $('registerButton').addEventListener('click', () =>
    run('회원가입', () =>
      request('/auth/register', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          id: fields.authId.value,
          password: fields.authPassword.value,
        }),
      }),
    ),
  );

  $('loginButton').addEventListener('click', () =>
    run('로그인', async () => {
      const result = await request('/auth/login', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          id: fields.authId.value,
          password: fields.authPassword.value,
        }),
      });
      setToken(result.accessToken);
      return result;
    }),
  );

  $('logoutButton').addEventListener('click', () => {
    setToken('');
    log('로그아웃');
  });

  $('meButton').addEventListener('click', () =>
    run('내 정보', () => request('/users/me', { headers: authHeaders() })),
  );

  $('createMemoryButton').addEventListener('click', () =>
    run('메모리 등록', async () => {
      const memory = await request('/users/me/memories', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ content: fields.memoryContent.value }),
      });
      await loadMemories();
      return memory;
    }),
  );

  $('loadMemoriesButton').addEventListener('click', () =>
    run('메모리 목록', loadMemories),
  );

  $('createPersonaButton').addEventListener('click', () =>
    run('페르소나 생성', async () => {
      const persona = await request('/personas', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(personaPayload()),
      });
      setPersona(persona.id);
      await loadPersonas();
      return persona;
    }),
  );

  $('updatePersonaButton').addEventListener('click', () =>
    run('페르소나 수정', async () => {
      if (!state.selectedPersonaId) {
        throw new Error('페르소나를 먼저 선택');
      }
      const persona = await request(`/personas/${state.selectedPersonaId}`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify(personaPayload()),
      });
      await loadPersonas();
      return persona;
    }),
  );

  $('loadPersonasButton').addEventListener('click', () =>
    run('페르소나 목록', loadPersonas),
  );

  $('loadPersonaButton').addEventListener('click', () =>
    run('페르소나 단건', async () => {
      if (!state.selectedPersonaId) {
        throw new Error('페르소나를 먼저 선택');
      }
      const persona = await request(`/personas/${state.selectedPersonaId}`, {
        headers: authHeaders(),
      });
      fillPersonaForm(persona);
      return persona;
    }),
  );

  $('createSessionButton').addEventListener('click', () =>
    run('세션 생성', async () => {
      if (!state.selectedPersonaId) {
        throw new Error('페르소나를 먼저 선택');
      }
      const session = await request('/sessions', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          personaId: state.selectedPersonaId,
          title: fields.sessionTitle.value || undefined,
        }),
      });
      setSession(session.id);
      await loadSessions();
      await loadMessages(null, false);
      return session;
    }),
  );

  $('loadSessionsButton').addEventListener('click', () =>
    run('세션 목록', () => loadSessions(null, false)),
  );

  $('moreSessionsButton').addEventListener('click', () =>
    run('다음 세션', () => loadSessions(state.sessionCursor, true)),
  );

  $('loadSessionButton').addEventListener('click', () =>
    run('세션 단건', () => {
      if (!state.selectedSessionId) {
        throw new Error('세션을 먼저 선택');
      }
      return request(`/sessions/${state.selectedSessionId}`, {
        headers: authHeaders(),
      });
    }),
  );

  $('deleteSessionButton').addEventListener('click', () =>
    run('세션 삭제', async () => {
      if (!state.selectedSessionId) {
        throw new Error('세션을 먼저 선택');
      }

      await request(`/sessions/${state.selectedSessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      setSession('');
      await loadSessions(null, false);
    }),
  );

  $('loadMessagesButton').addEventListener('click', () =>
    run('메시지 목록', () => loadMessages(null, false)),
  );

  $('moreMessagesButton').addEventListener('click', () =>
    run('이전 메시지', () => loadMessages(state.messageCursor, true)),
  );

  $('sendMessageButton').addEventListener('click', () =>
    run('메시지 전송', sendMessage),
  );

  $('loadStatsButton').addEventListener('click', () =>
    run('토큰 통계', async () => {
      const params = new URLSearchParams();
      if (fields.statsFrom.value) {
        params.set('from', fields.statsFrom.value);
      }
      if (fields.statsTo.value) {
        params.set('to', fields.statsTo.value);
      }
      const query = params.toString();
      const stats = await request(`/stats/tokens${query ? `?${query}` : ''}`, {
        headers: authHeaders(),
      });
      fields.statsOutput.textContent = JSON.stringify(stats, null, 2);
      return stats;
    }),
  );

  $('clearLogButton').addEventListener('click', () => {
    fields.logOutput.textContent = '';
  });
}

bindEvents();
renderSelections();
