'use strict';

function incrementTokens(tokensUsed) {
  if (!tokensUsed) return;

  chrome.storage.local.get(['totalTokens'], (result) => {
    const newTotal = (result.totalTokens || 0) + tokensUsed;
    chrome.storage.local.set({ totalTokens: newTotal });
  });
}

// Дебаунс — не спамить запросами на активных SPA
let navTimer = null;
function notifySidePanel({ reason, tabId }) {
  clearTimeout(navTimer);
  const delay = reason === 'SPA_NAVIGATED' ? 1500 : 400;
  navTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'pageChanged', reason, tabId }).catch(() => {});
  }, delay);
}

// Слушатель смены активной вкладки
chrome.tabs.onActivated.addListener(({ tabId }) => {
  notifySidePanel({ reason: 'TAB_CHANGED', tabId });
});

// Слушатель завершения загрузки страницы
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id === tabId) {
      notifySidePanel({ reason: 'PAGE_LOADED', tabId });
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'askAI') {
    askAI(request).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // для асинхронного ответа
  }
  
  if (request.action === 'assistField') {
    assistField(request).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
  
  if (request.action === 'pageNavigated') {
    notifySidePanel({ reason: 'SPA_NAVIGATED', tabId: sender.tab.id });
    return false;
  }
  
  if (request.action === 'summarizePage') {
    summarizePage(request)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  
  if (request.action === 'openSidePanel') {
    // Открываем боковую панель для текущей вкладки
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
    sendResponse({ ok: true });
    return true;
  }
  
  if (request.action === 'openSidePanelWithQuestion') {
    // Открываем боковую панель и предзаполняем вопрос
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(() => {
      // Небольшая задержка, чтобы панель успела открыться
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'prefillQuestion',
          question: request.question
        }).catch(() => {});
      }, 300);
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function askAI({ email, authToken, model, question, pageText }) {
  const url = 'https://ai.pro-talk.ru/api/router';
  
  const payload = {
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    platform: 'ProTalk',
    user_email: email,
    model: model,
    messages: [
      {
        role: 'user',
        content: `Контекст (текст страницы):\n\n${pageText}\n\nВопрос пользователя: ${question}`
      }
    ],
    temperature: 0.3,
    max_tokens: 1024,
    stream: false
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    if (data.choices && data.choices.length > 0) {
      const message = data.choices[0].message;
      const reply = message.content || 'Нет ответа';
      
      // Подсчет токенов (примерный)
      let tokensUsed = 0;
      if (data.usage) {
        tokensUsed = (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      incrementTokens(tokensUsed);

      return {
        ok: true,
        reply: reply,
        tokensUsed: tokensUsed
      };
    } else {
      throw new Error('Нет ответов от модели');
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function buildSummaryPrompt(pageText) {
  return `
Проанализируй текст страницы и дай структурированное резюме.

Текст страницы:
${pageText.slice(0, 4000)}

Ответь СТРОГО в следующем формате (используй именно эти заголовки):

**О чём страница:**
[одно предложение — суть материала]

**Ключевые моменты:**
• [пункт 1]
• [пункт 2]
• [пункт 3]
• [пункт 4 — если есть]
• [пункт 5 — если есть]

**Вывод:**
[одно предложение — зачем это читать или что с этим делать]

Правила:
- Каждый пункт — максимум одно предложение
- Без вводных слов типа "Данная статья..."
- Если страница — не статья (форма, приложение, 404) — напиши об этом кратко
  `.trim();
}

/**
 * Функция резюмирования страницы
 * @param {Object} request 
 * @returns {Promise<Object>}
 */
async function summarizePage({ email, authToken, model, pageText }) {
  const url = 'https://ai.pro-talk.ru/api/router';

  const payload = {
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    platform: 'ProTalk',
    user_email: email,
    model: model,
    stream: false,
    max_tokens: 600,
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: buildSummaryPrompt(pageText)
    }]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  const reply = data.choices?.[0]?.message?.content || '';
  const tokensUsed = (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);

  incrementTokens(tokensUsed);

  return { ok: true, summary: reply, tokensUsed };
}

/**
 * Обработчик для Input Assistant
 * @param {Object} request 
 * @returns {Promise<Object>}
 */
async function assistField({ email, authToken, model, prompt }) {
  const url = 'https://ai.pro-talk.ru/api/router';
  
  const payload = {
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    platform: 'ProTalk',
    user_email: email,
    model: model,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.5,
    max_tokens: 512,
    stream: false
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    if (data.choices && data.choices.length > 0) {
      const message = data.choices[0].message;
      const reply = message.content || '';
      
      // Подсчет токенов
      let tokensUsed = 0;
      if (data.usage) {
        tokensUsed = (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      incrementTokens(tokensUsed);

      return {
        ok: true,
        reply: reply,
        tokensUsed: tokensUsed
      };
    } else {
      throw new Error('Нет ответов от модели');
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}