'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const authSection = document.getElementById('authSection');
  const mainSection = document.getElementById('mainSection');
  const settingsSection = document.getElementById('settingsSection');
  const loading = document.getElementById('loading');
  
  const emailInput = document.getElementById('emailInput');
  const botIdInput = document.getElementById('botIdInput');
  const botTokenInput = document.getElementById('botTokenInput');
  const saveAuthBtn = document.getElementById('saveAuthBtn');
  
  const settingsBtn = document.getElementById('settingsBtn');
  const backBtn = document.getElementById('backBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  
  const currentModel = document.getElementById('currentModel');
  const tokenStat = document.getElementById('tokenStat');
  const modelSelect = document.getElementById('modelSelect');
  const totalTokens = document.getElementById('totalTokens');
  
  const questionInput = document.getElementById('questionInput');
  const pageTextPreview = document.getElementById('pageTextPreview');
  const askBtn = document.getElementById('askBtn');
  const responseSection = document.getElementById('responseSection');
  const responseText = document.getElementById('responseText');

  let currentPageText = '';

  // Загрузка сохраненных данных
  loadCredentials();
  loadSettings();
  loadPageText();

  function loadCredentials() {
    chrome.storage.local.get(['email', 'botId', 'botToken'], (result) => {
      if (result.email && result.botId && result.botToken) {
        emailInput.value = result.email;
        botIdInput.value = result.botId;
        botTokenInput.value = result.botToken;
        authSection.style.display = 'none';
        mainSection.style.display = 'block';
      } else {
        authSection.style.display = 'block';
        mainSection.style.display = 'none';
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['model', 'totalTokens'], (result) => {
      const model = result.model || 'x-ai/grok-4.1-fast';
      const tokens = result.totalTokens || 0;
      
      currentModel.textContent = model;
      modelSelect.value = model;
      tokenStat.textContent = `${tokens} токенов`;
      totalTokens.textContent = tokens;
    });
  }

  function loadPageText() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getPageText' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            pageTextPreview.textContent = 'Не удалось получить текст страницы';
            currentPageText = '';
            return;
          }
          currentPageText = response.text || '';
          const preview = currentPageText.length > 300 
            ? currentPageText.substring(0, 300) + '...' 
            : currentPageText;
          pageTextPreview.textContent = preview || 'Текст не найден';
        });
      }
    });
  }

  // Сохранение авторизации
  saveAuthBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    const botId = botIdInput.value.trim();
    const botToken = botTokenInput.value.trim();

    if (!email || !botId || !botToken) {
      alert('Заполните все поля');
      return;
    }

    chrome.storage.local.set({ email, botId, botToken }, () => {
      authSection.style.display = 'none';
      mainSection.style.display = 'block';
      loadPageText();
    });
  });

  // Навигация
  settingsBtn.addEventListener('click', () => {
    mainSection.style.display = 'none';
    settingsSection.style.display = 'block';
    loadSettings();
  });

  backBtn.addEventListener('click', () => {
    settingsSection.style.display = 'none';
    mainSection.style.display = 'block';
  });

  // Смена модели
  modelSelect.addEventListener('change', () => {
    const model = modelSelect.value;
    chrome.storage.local.set({ model }, () => {
      currentModel.textContent = model;
      loadSettings();
    });
  });

  // Выход
  logoutBtn.addEventListener('click', () => {
    chrome.storage.local.remove(['email', 'botId', 'botToken'], () => {
      authSection.style.display = 'block';
      mainSection.style.display = 'none';
      settingsSection.style.display = 'none';
      emailInput.value = '';
      botIdInput.value = '';
      botTokenInput.value = '';
    });
  });

  // Запрос к ИИ
  askBtn.addEventListener('click', () => {
    const question = questionInput.value.trim();
    if (!question) {
      alert('Введите вопрос');
      return;
    }

    if (!currentPageText) {
      alert('Не удалось получить текст страницы');
      return;
    }

    loading.style.display = 'block';
    responseSection.style.display = 'none';

    chrome.storage.local.get(['email', 'botId', 'botToken', 'model'], (creds) => {
      if (!creds.email || !creds.botId || !creds.botToken) {
        loading.style.display = 'none';
        alert('Необходимо авторизоваться');
        return;
      }

      // Формируем токен из bot_id и bot_token
      const authToken = `${creds.botId}_${creds.botToken}`;

      chrome.runtime.sendMessage({
        action: 'askAI',
        email: creds.email,
        authToken: authToken,
        model: creds.model || 'x-ai/grok-4.1-fast',
        question: question,
        pageText: currentPageText
      }, (response) => {
        loading.style.display = 'none';
        
        if (response && response.ok) {
          responseText.textContent = response.reply;
          responseSection.style.display = 'block';
          
          // Обновляем статистику токенов
          if (response.tokensUsed) {
            chrome.storage.local.get(['totalTokens'], (result) => {
              const newTotal = (result.totalTokens || 0) + response.tokensUsed;
              chrome.storage.local.set({ totalTokens: newTotal }, () => {
                loadSettings();
              });
            });
          }
        } else {
          responseText.textContent = 'Ошибка: ' + (response?.error || 'Неизвестная ошибка');
          responseSection.style.display = 'block';
        }
      });
    });
  });
});
