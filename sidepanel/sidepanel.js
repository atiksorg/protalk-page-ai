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
  // Не анализируем страницу сразу, ждем действий пользователя
  // loadSummaryForActivePage();
  // Вместо этого, загрузим текст страницы для отображения
  loadPageTextOnly();
});

// ── Смена страницы (сигнал от background) ──────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'pageChanged') {
    markAsStale();
  }
  if (request.action === 'prefillQuestion') {
    prefillQuestion(request.question);
  }
});

/**
 * Предзаполнение поля вопроса
 * @param {string} question 
 */
function prefillQuestion(question) {
  const questionInput = document.getElementById('questionInput');
  if (questionInput) {
    questionInput.value = question;
    // Фокусировка на поле ввода
    questionInput.focus();
    // Прокрутка к полю ввода
    questionInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

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
    pageText: 'statePageText', // Новое состояние
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
    try {
      pageUrl.textContent = state.pageUrl ? new URL(state.pageUrl).hostname : '';
    } catch {
      pageUrl.textContent = state.pageUrl || '';
    }
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
  const html = parseMarkdown(text);
  document.getElementById('answerText').innerHTML = html;
  
  // Добавляем обработчики для кнопок копирования
  document.querySelectorAll('.code-block-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const codeBlock = btn.closest('.code-block-wrapper').querySelector('.code-block-content');
      if (codeBlock) {
        navigator.clipboard.writeText(codeBlock.textContent).then(() => {
          const originalText = btn.textContent;
          btn.textContent = '✓ Скопировано!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 2000);
        }).catch(err => {
          console.error('Ошибка копирования: ', err);
        });
      }
    });
  });
}

/**
 * Парсинг Markdown текста с поддержкой блоков кода
 * @param {string} text 
 * @returns {string}
 */
function parseMarkdown(text) {
  // Сначала экранируем HTML
  let escaped = escapeHtml(text);
  
  // Парсим блоки кода ```language ... ```
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let result = '';
  let lastIndex = 0;
  let match;
  
  while ((match = codeBlockRegex.exec(escaped)) !== null) {
    // Добавляем текст до блока кода
    result += processInlineMarkdown(escaped.slice(lastIndex, match.index));
    
    const language = match[1] || 'text';
    const code = match[2];
    
    result += `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-block-language">${language}</span>
          <button class="code-block-copy-btn">Копировать</button>
        </div>
        <div class="code-block-content">${code}</div>
      </div>
    `;
    
    lastIndex = match.index + match[0].length;
  }
  
  // Добавляем оставшийся текст после последнего блока кода
  result += processInlineMarkdown(escaped.slice(lastIndex));
  
  return result;
}

/**
 * Обработка инлайн Markdown (жирный, курсив, инлайн код)
 * @param {string} text 
 * @returns {string}
 */
function processInlineMarkdown(text) {
  let result = text;
  
  // Инлайн код `...`
  result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  
  // Жирный **...**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Курсив *...*
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Заменяем переносы строк на <br>, но не внутри параграфов
  result = result.replace(/\n/g, '<br>');
  
  return result;
}

/**
 * Загрузка только текста страницы без анализа
 */
async function loadPageTextOnly() {
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

    // 3. Сохраняем текст и метаинформацию
    state.pageText = pageData.text;
    state.pageTitle = tab.title || '';
    state.pageUrl = tab.url || '';
    updatePageInfo();

    // 4. Отображаем текст страницы
    setState('pageText');
    renderPageText(pageData.text);

  } catch (err) {
    setState('error');
    showError(err.message);
  }
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

  // Получаем credentials
  const creds = await chrome.storage.local.get(['email', 'botId', 'botToken', 'model']);
  if (!creds.email || !creds.botId || !creds.botToken) {
    showAnswerError('Необходима авторизация в расширении');
    return;
  }

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
  } else if (state.status === 'idle' || state.status === 'error') {
    // Если ещё не загружали — загружаем сразу
    loadSummaryForActivePage();
  }
  // Если status === 'loading' — не прерываем текущий запрос
}

function renderPageText(text) {
  const el = document.getElementById('pageTextContent');
  if (el) {
    // Отображение текста в textarea
    el.value = text;
  }
  
  // Добавим обработчики для кнопок действий
  const copyBtn = document.getElementById('copyPageTextBtn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(text).then(() => {
        // Визуальная обратная связь
        const originalHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = originalHTML;
          copyBtn.classList.remove('copied');
        }, 2000);
      }).catch(err => {
        console.error('Ошибка копирования: ', err);
      });
    };
  }
  
  const summarizeBtn = document.getElementById('summarizePageBtn');
  if (summarizeBtn) {
    summarizeBtn.onclick = () => {
      loadSummaryForActivePage();
    };
  }
  
  // Добавим инлайн кнопки действий
  const actionsContainer = document.getElementById('pageTextQuickActions');
  if (actionsContainer) {
    actionsContainer.innerHTML = `
      <button id="actionSummarize" class="quick-action-btn">Резюме</button>
      <button id="actionKeyPoints" class="quick-action-btn">Ключевые моменты</button>
      <button id="actionTranslate" class="quick-action-btn">Перевод (EN→RU)</button>
    `;
    actionsContainer.classList.remove('hidden');
    
    document.getElementById('actionSummarize').onclick = () => {
      // Можно отправить специальный запрос к AI с инструкцией "сделай резюме"
      loadSummaryForActivePage();
    };
    
    document.getElementById('actionKeyPoints').onclick = async () => {
      setState('loading');
      try {
        const creds = await chrome.storage.local.get(['email', 'botId', 'botToken', 'model']);
        if (!creds.email || !creds.botId || !creds.botToken) {
          throw new Error('Необходима авторизация в расширении');
        }
        
        const result = await chrome.runtime.sendMessage({
          action: 'askAI',
          email: creds.email,
          authToken: `${creds.botId}_${creds.botToken}`,
          model: creds.model || 'x-ai/grok-4.1-fast',
          question: 'Выдели ключевые моменты и основные идеи из следующего текста:\n\n' + text,
          pageText: text
        });
        
        if (result?.ok) {
          state.summary = result.reply;
          setState('done');
          renderSummary(result.reply);
        } else {
          throw new Error(result?.error || 'Ошибка AI');
        }
      } catch (err) {
        setState('error');
        showError(err.message);
      }
    };
    
    document.getElementById('actionTranslate').onclick = async () => {
      setState('loading');
      try {
        const creds = await chrome.storage.local.get(['email', 'botId', 'botToken', 'model']);
        if (!creds.email || !creds.botId || !creds.botToken) {
          throw new Error('Необходима авторизация в расширении');
        }
        
        const result = await chrome.runtime.sendMessage({
          action: 'askAI',
          email: creds.email,
          authToken: `${creds.botId}_${creds.botToken}`,
          model: creds.model || 'x-ai/grok-4.1-fast',
          question: 'Переведи следующий текст с английского на русский:\n\n' + text,
          pageText: text
        });
        
        if (result?.ok) {
          state.summary = result.reply;
          setState('done');
          renderSummary(result.reply);
        } else {
          throw new Error(result?.error || 'Ошибка AI');
        }
      } catch (err) {
        setState('error');
        showError(err.message);
      }
    };
  }
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