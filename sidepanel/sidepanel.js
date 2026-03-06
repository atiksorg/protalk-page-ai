'use strict';

// ── Состояние ──────────────────────────────────────────
let state = {
  status: 'idle',         // idle | loading | done | error | stale
  summary: '',
  pageText: '',
  pageTitle: '',
  pageUrl: '',
  error: ''
};

// ── Инициализация ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  loadSummaryForActivePage();
});

// ── Смена страницы (сигнал от background) ──────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'pageChanged') {
    markAsStale();
  }
});

function bindUI() {
  document.getElementById('refreshBtn').addEventListener('click', loadSummaryForActivePage);
  document.getElementById('staleRefreshBtn').addEventListener('click', loadSummaryForActivePage);
  document.getElementById('retryBtn').addEventListener('click', loadSummaryForActivePage);
  
  const questionInput = document.getElementById('questionInput');
  const askBtn = document.getElementById('askBtn');
  
  askBtn.addEventListener('click', () => {
    const question = questionInput.value.trim();
    if (question) {
      askFollowUp(question);
    }
  });
  
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const question = questionInput.value.trim();
      if (question) {
        askFollowUp(question);
      }
    }
  });
}

function setState(newStatus) {
  state.status = newStatus;
  
  // Скрыть все состояния
  document.querySelectorAll('.state-block').forEach(el => {
    el.classList.add('hidden');
  });
  
  // Показать нужное
  const stateMap = {
    idle: 'stateIdle',
    loading: 'stateLoading',
    done: 'stateSummary',
    error: 'stateError',
    stale: 'stateSummary'
  };
  
  const el = document.getElementById(stateMap[newStatus]);
  if (el) {
    el.classList.remove('hidden');
  }
  
  // Управление баннером
  const staleBanner = document.getElementById('staleBanner');
  if (newStatus === 'stale') {
    staleBanner.classList.remove('hidden');
  } else {
    staleBanner.classList.add('hidden');
  }
  
  // Обновление информации о странице
  updatePageInfo();
}

function updatePageInfo() {
  const pageInfo = document.getElementById('pageInfo');
  const pageTitle = document.getElementById('pageTitle');
  const pageUrl = document.getElementById('pageUrl');
  
  if (state.pageTitle || state.pageUrl) {
    pageTitle.textContent = state.pageTitle || 'Без названия';
    pageUrl.textContent = state.pageUrl ? new URL(state.pageUrl).hostname : '';
    pageInfo.classList.remove('hidden');
  } else {
    pageInfo.classList.add('hidden');
  }
}

function showStaleBanner() {
  document.getElementById('staleBanner').classList.remove('hidden');
}

function showError(message) {
  state.error = message;
  document.getElementById('errorMessage').textContent = message;
}

function showAnswerError(message) {
  setAnswerState('error');
  document.getElementById('answerText').textContent = message;
}

function setAnswerState(status) {
  const answerArea = document.getElementById('answerArea');
  const answerLoading = document.getElementById('answerLoading');
  const answerText = document.getElementById('answerText');
  
  if (status === 'loading') {
    answerArea.classList.remove('hidden');
    answerLoading.classList.remove('hidden');
    answerText.classList.add('hidden');
  } else if (status === 'done') {
    answerLoading.classList.add('hidden');
    answerText.classList.remove('hidden');
  } else if (status === 'error') {
    answerLoading.classList.add('hidden');
    answerText.classList.remove('hidden');
  } else { // hidden
    answerArea.classList.add('hidden');
  }
}

function renderAnswer(text) {
  document.getElementById('answerText').innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
}

async function loadSummaryForActivePage() {
  setState('loading');

  try {
    // 1. Получаем активную вкладку
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Не удалось определить активную вкладку');

    // 2. Получаем текст страницы через content.js
    let pageData;
    try {
      pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageText' });
    } catch {
      throw new Error('Страница недоступна. Попробуйте обновить её.');
    }

    if (!pageData?.text?.trim()) {
      throw new Error('Страница не содержит текста для анализа');
    }

    // 3. Получаем credentials
    const creds = await chrome.storage.local.get(['email', 'botId', 'botToken', 'model']);
    if (!creds.email || !creds.botId || !creds.botToken) {
      throw new Error('Необходима авторизация в расширении');
    }

    // 4. Сохраняем контекст для уточняющих вопросов
    state.pageText = pageData.text;
    state.pageTitle = tab.title || '';
    state.pageUrl = tab.url || '';
    updatePageInfo();

    // 5. Запрашиваем резюме
    const result = await chrome.runtime.sendMessage({
      action: 'summarizePage',
      email: creds.email,
      authToken: `${creds.botId}_${creds.botToken}`,
      model: creds.model || 'x-ai/grok-4.1-fast',
      pageText: pageData.text
    });

    if (!result?.ok) throw new Error(result?.error || 'Ошибка AI');

    state.summary = result.summary;
    setState('done');
    renderSummary(result.summary);

  } catch (err) {
    setState('error');
    showError(err.message);
  }
}

async function askFollowUp(question) {
  if (!question.trim()) return;
  if (!state.pageText) {
    showAnswerError('Сначала загрузите резюме страницы');
    return;
  }

  setAnswerState('loading');

  const creds = await chrome.storage.local.get(['email', 'botId', 'botToken', 'model']);

  const result = await chrome.runtime.sendMessage({
    action: 'askAI',              // переиспользуем существующий handler
    email: creds.email,
    authToken: `${creds.botId}_${creds.botToken}`,
    model: creds.model || 'x-ai/grok-4.1-fast',
    question: question,
    pageText: state.pageText
  });

  if (result?.ok) {
    setAnswerState('done');
    renderAnswer(result.reply);
  } else {
    setAnswerState('error');
    showAnswerError(result?.error || 'Ошибка AI');
  }
}

function markAsStale() {
  // Не сбрасывать резюме сразу — показать баннер
  // Пользователь может захотеть дочитать текущее резюме
  if (state.status === 'done') {
    setState('stale');
    showStaleBanner();
  } else if (state.status === 'idle' || state.status === 'error') {
    // Если ещё не загружали — загружаем сразу
    loadSummaryForActivePage();
  }
  // Если status === 'loading' — не прерываем текущий запрос
}

function renderSummary(rawText) {
  const el = document.getElementById('summaryContent');

  // Разбиваем на секции по заголовкам **...**
  const sections = rawText.split(/\n(?=\*\*)/);

  el.innerHTML = sections.map(section => {
    // Заголовок секции
    const titleMatch = section.match(/^\*\*(.+?)\*\*\n?/);
    if (!titleMatch) return '';

    const title = titleMatch[1];
    const body = section.slice(titleMatch[0].length).trim();

    // Буллеты
    const bodyHtml = body
      .split('\n')
      .filter(l => l.trim())
      .map(line => {
        if (line.startsWith('•')) {
          return `<li>${escapeHtml(line.slice(1).trim())}</li>`;
        }
        return `<p>${escapeHtml(line)}</p>`;
      })
      .join('');

    const hasBullets = body.includes('•');

    return `
      <div class="summary-section">
        <h3 class="summary-section-title">${escapeHtml(title)}</h3>
        ${hasBullets ? `<ul class="summary-list">${bodyHtml}</ul>` : bodyHtml}
      </div>
    `;
  }).join('');
}

// XSS-защита для текста из AI
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}