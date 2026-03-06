'use strict';

// ============================================
// ФИЧА 1: Захват контента после финального рендера
// ============================================

/**
 * Ожидание стабилизации DOM (для SPA/React/Vue)
 * @param {number} timeout - Максимальное время ожидания (ms)
 * @param {number} quietPeriod - Период без мутаций для признания стабильности (ms)
 * @returns {Promise<void>}
 */
function waitForStableDOM(timeout = 3000, quietPeriod = 500) {
  return new Promise((resolve) => {
    let timer;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    };

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish();
      }, quietPeriod);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    // Абсолютный таймаут — не ждать бесконечно
    setTimeout(() => {
      finish();
    }, timeout);
  });
}

/**
 * Извлечение видимого текста из живого DOM
 * @returns {string}
 */
function extractVisibleText() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS']);
  
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;

        // Проверяем видимость по живому computed style
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const parts = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    if (text) parts.push(text);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Отслеживание SPA-навигации
 */
let lastUrl = location.href;
let spaNavigationObserver = null;

function initSPANavigationTracking() {
  spaNavigationObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ action: 'pageNavigated', url: lastUrl });
    }
  });
  spaNavigationObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================
// ФИЧА 2: Input Assistant
// ============================================

// Состояние Input Assistant
let inputAssistantEnabled = false;
const attachedFields = new WeakSet();
let fieldObserver = null;
const fieldCleanupMap = new WeakMap();
let activeMiniPopupCleanup = null;

/**
 * Проверка, нужно ли прикреплять иконку к полю
 * @param {Element} field 
 * @returns {boolean}
 */
function shouldAttachButton(field) {
  if (!field || !field.tagName) return false;
  
  const tagName = field.tagName.toLowerCase();
  if (!['input', 'textarea'].includes(tagName)) return false;
  
  const inputType = field.type?.toLowerCase() || 'text';
  
  // Исключения безопасности
  if (inputType === 'password') return false;
  if (inputType === 'hidden') return false;
  if (field.autocomplete?.startsWith('cc-')) return false;
  
  const name = (field.name || field.id || '').toLowerCase();
  const sensitiveNames = ['card', 'cvv', 'ssn', 'tax', 'credit', 'cvc'];
  if (sensitiveNames.some(s => name.includes(s))) return false;
  
  // Проверка на iframe другого домена
  if (field.closest('iframe')) return false;
  
  return true;
}

/**
 * Получение контекста поля
 * @param {Element} field 
 * @returns {Object}
 */
function getFieldContext(field) {
  const label =
    document.querySelector(`label[for="${field.id}"]`)?.textContent?.trim() ||
    field.getAttribute('aria-label') ||
    field.getAttribute('placeholder') ||
    field.closest('[class*="form-group"], [class*="field"]')
         ?.querySelector('label, .label, .title')?.textContent?.trim() ||
    null;

  return {
    label,
    placeholder: field.placeholder || null,
    type: field.type || field.tagName.toLowerCase(),
    name: field.name || field.id || null,
    currentValue: field.value || null,
    fieldIndex: getFieldIndex(field)
  };
}

/**
 * Получение индекса поля в форме
 * @param {Element} field 
 * @returns {number}
 */
function getFieldIndex(field) {
  const form = field.closest('form');
  if (!form) return 0;
  
  const fields = [...form.querySelectorAll('input, textarea, select')]
    .filter(f => f.type !== 'password' && f.type !== 'hidden');
  
  return fields.indexOf(field);
}

/**
 * Получение контекста всей формы
 * @param {Element} form 
 * @returns {Object}
 */
function getFormContext(form) {
  const fields = [...form.querySelectorAll('input, textarea, select')]
    .filter(f => f.type !== 'password' && f.type !== 'hidden')
    .map(f => ({
      ...getFieldContext(f),
      element: f
    }));

  return {
    formTitle: form.getAttribute('aria-label') ||
               document.querySelector('h1, h2')?.textContent?.trim() ||
               document.title,
    fields
  };
}

/**
 * Создание Shadow DOM контейнера для иконки
 * @returns {Object}
 */
function createShadowButton() {
  const wrapper = document.createElement('div');
  wrapper.className = 'protalk-input-assistant-wrapper';
  wrapper.style.cssText = `
    position: absolute;
    pointer-events: none;
    z-index: 2147483647;
  `;
  
  const shadow = wrapper.attachShadow({ mode: 'open' });
  
  const style = document.createElement('style');
  style.textContent = `
    .protalk-trigger {
      position: absolute;
      left: 2px;
      top: 2px;
      width: 20px;
      height: 20px;
      border: none;
      border-radius: 3px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      font-size: 12px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.2s ease;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      animation: fadeInScale 0.3s ease-out;
    }
    @keyframes fadeInScale {
      0% { opacity: 0; transform: scale(0.8); }
      100% { opacity: 1; transform: scale(1); }
    }
    .protalk-trigger:hover {
      opacity: 1 !important;
      transform: scale(1.15);
    }
    .protalk-trigger:active {
      transform: scale(0.9);
    }
  `;
  
  const btn = document.createElement('button');
  btn.className = 'protalk-trigger';
  btn.textContent = '✨';
  btn.type = 'button';
  btn.tabIndex = -1;
  
  shadow.appendChild(style);
  shadow.appendChild(btn);
  
  return { wrapper, btn };
}

/**
 * Позиционирование иконки относительно поля
 * @param {Element} wrapper 
 * @param {Element} field 
 */
function positionButton(wrapper, field) {
  const rect = field.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  
  wrapper.style.top = `${rect.top + scrollTop}px`;
  wrapper.style.left = `${rect.left + scrollLeft}px`;
  wrapper.style.height = `${rect.height}px`;
}

/**
 * Создание мини-попапа в Shadow DOM (тёмная тема)
 * @returns {Object}
 */
function createMiniPopup() {
  const popup = document.createElement('div');
  popup.className = 'protalk-mini-popup-wrapper';
  popup.style.cssText = `
    position: absolute;
    z-index: 2147483647;
  `;
  
  const shadow = popup.attachShadow({ mode: 'open' });
  
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
    }
    
    .mini-popup {
      background: linear-gradient(135deg, #1a1a24 0%, #0f0f13 100%);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(99, 102, 241, 0.2);
      min-width: 260px;
      max-width: 320px;
      overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      animation: popupSlideIn 0.2s ease-out;
    }
    
    @keyframes popupSlideIn {
      from {
        opacity: 0;
        transform: translateY(-8px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    
    .mini-popup-header {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .mini-popup-header-icon {
      width: 20px;
      height: 20px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }
    
    .mini-popup-header-title {
      color: #f8f8fa;
      font-weight: 600;
      font-size: 13px;
    }
    
    .mini-popup-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      cursor: pointer;
      transition: all 0.15s ease;
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
      font-size: 14px;
      position: relative;
      overflow: hidden;
    }
    
    .mini-popup-item::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%);
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    
    .mini-popup-item:hover::before {
      opacity: 1;
    }
    
    .mini-popup-item:hover {
      background: rgba(99, 102, 241, 0.1);
    }
    
    .mini-popup-item:active {
      background: rgba(99, 102, 241, 0.2);
    }
    
    .mini-popup-item:not(:last-child) {
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    
    .mini-popup-icon {
      font-size: 18px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }
    
    .mini-popup-label {
      color: #f8f8fa;
      font-weight: 500;
      position: relative;
      z-index: 1;
    }
    
    .mini-popup-label-hint {
      color: #9ca3af;
      font-size: 11px;
      font-weight: 400;
      display: block;
      margin-top: 2px;
    }
    
    .mini-popup-loading {
      padding: 20px;
      text-align: center;
      color: #9ca3af;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    
    .mini-popup-loading-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(99, 102, 241, 0.3);
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .mini-popup-error {
      padding: 14px;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.15);
      border-top: 1px solid rgba(239, 68, 68, 0.3);
      font-size: 13px;
    }
    
    .mini-popup-input-wrapper {
      padding: 14px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    
    .mini-popup-input {
      width: 100%;
      padding: 10px 12px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: #f8f8fa;
      font-size: 13px;
      font-family: inherit;
      transition: all 0.2s ease;
      box-sizing: border-box;
    }
    
    .mini-popup-input:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    
    .mini-popup-input::placeholder {
      color: #6b7280;
    }
    
    .mini-popup-submit {
      width: 100%;
      margin-top: 10px;
      padding: 10px 16px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    
    .mini-popup-submit:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }
    
    .mini-popup-submit:active {
      transform: translateY(0);
    }
  `;
  
  shadow.appendChild(style);
  
  const container = document.createElement('div');
  container.className = 'mini-popup';
  shadow.appendChild(container);

  let closed = false;
  let closeHandler = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (closeHandler) {
      document.removeEventListener('mousedown', closeHandler);
    }
    if (activeMiniPopupCleanup === cleanup) {
      activeMiniPopupCleanup = null;
    }
    popup.remove();
  };
  
  return {
    popup,
    container,
    shadow,
    setCloseHandler(handler) {
      closeHandler = handler;
    },
    cleanup
  };
}

/**
 * Рендер элементов мини-попапа (тёмная тема)
 * @param {Element} container 
 * @param {Array} items 
 */
function renderMiniPopupItems(container, items) {
  container.innerHTML = '';
  
  items.forEach(item => {
    if (item.type === 'input') {
      // Специальный случай для поля ввода с улучшенным UI
      const wrapper = document.createElement('div');
      wrapper.className = 'mini-popup-input-wrapper';
      
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mini-popup-input';
      input.placeholder = item.placeholder || 'Опишите задачу для ИИ...';
      
      const submitBtn = document.createElement('button');
      submitBtn.className = 'mini-popup-submit';
      submitBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
        </svg>
        Заполнить с ИИ
      `;
      
      submitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (input.value.trim()) {
          item.action(input.value);
        }
      });
      
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          item.action(input.value);
        }
      });
      
      wrapper.appendChild(input);
      wrapper.appendChild(submitBtn);
      container.appendChild(wrapper);
      
      // Фокус на поле ввода
      setTimeout(() => input.focus(), 50);
    } else {
      // Обычный пункт меню
      const btn = document.createElement('button');
      btn.className = 'mini-popup-item';
      
      const iconSpan = document.createElement('span');
      iconSpan.className = 'mini-popup-icon';
      iconSpan.textContent = item.icon;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'mini-popup-label';
      labelSpan.textContent = item.label;

      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);
      
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.action();
      });
      container.appendChild(btn);
    }
  });
}

/**
 * Получение краткого описания поля для отображения в UI
 * @param {Element} field 
 * @returns {string}
 */
function getFieldLabelForUI(field) {
  return document.querySelector(`label[for="${field.id}"]`)?.textContent?.trim() ||
    field.getAttribute('aria-label') ||
    field.placeholder ||
    'поле';
}

/**
 * Показ мини-попапа с полем ввода задачи
 * @param {Element} field 
 * @param {Element} anchorBtn 
 */
function showMiniPopupWithInput(field, anchorBtn) {
  // Удаляем предыдущий попап если есть
  if (activeMiniPopupCleanup) {
    activeMiniPopupCleanup();
  }
  
  const { popup, container, cleanup, setCloseHandler } = createMiniPopup();
  activeMiniPopupCleanup = cleanup;
  
  const items = [
    {
      type: 'input',
      placeholder: 'Опишите, как заполнить это поле...',
      action: (userPrompt) => assistWithCustomPrompt(field, userPrompt, popup, cleanup)
    }
  ];
  
  renderMiniPopupItems(container, items);
  positionPopupNear(popup, anchorBtn);
  document.body.appendChild(popup);
  
  // Закрытие при клике вне
  const closeHandler = (e) => {
    if (!popup.contains(e.target)) {
      cleanup();
    }
  };
  setCloseHandler(closeHandler);
  document.addEventListener('mousedown', closeHandler);
}

/**
 * Позиционирование попапа
 * @param {Element} popup 
 * @param {Element} anchor 
 */
function positionPopupNear(popup, anchor) {
  const rect = anchor.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  
  popup.style.top = `${rect.bottom + scrollTop + 4}px`;
  popup.style.left = `${rect.left + scrollLeft}px`;
}

/**
 * Установка значения в поле с триггером событий (для React/Vue)
 * @param {Element} field 
 * @param {string} value 
 */
function setNativeValue(field, value) {
  if (field.tagName === 'SELECT') {
    field.value = value;
    return;
  }

  const prototype = field.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;

  const nativeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  
  if (nativeValueSetter) {
    nativeValueSetter.call(field, value);
  } else {
    field.value = value;
  }
}

/**
 * Показ мини-попапа
 * @param {Element} field 
 * @param {Element} anchorBtn 
 */
function showMiniPopup(field, anchorBtn) {
  // Удаляем предыдущий попап если есть
  if (activeMiniPopupCleanup) {
    activeMiniPopupCleanup();
  }
  
  const { popup, container, cleanup, setCloseHandler } = createMiniPopup();
  activeMiniPopupCleanup = cleanup;
  
  const form = field.closest('form');
  const fieldLabel = getFieldLabelForUI(field);
  
  const items = [
    {
      icon: '⚡',
      label: 'Автозаполнение',
      action: () => assistSingleField(field, popup, cleanup)
    },
    {
      icon: '💬',
      label: 'Спросить ИИ',
      action: () => openSidePanelWithQuestion(field)
    }
  ];
  
  // Кнопка "Улучшить" будет добавляться динамически
  if (field.value?.trim().length > 0) {
    items.push({
      icon: '✏️',
      label: 'Улучшить текст',
      action: () => improveFieldText(field, popup, cleanup)
    });
  }
  
  if (form) {
    items.push({
      icon: '📋',
      label: 'Заполнить всю форму',
      action: () => assistWholeForm(form, popup, cleanup)
    });
  }
  
  renderMiniPopupItems(container, items);
  positionPopupNear(popup, anchorBtn);
  document.body.appendChild(popup);
  
  // Закрытие при клике вне
  const closeHandler = (e) => {
    if (!popup.contains(e.target)) {
      cleanup();
    }
  };
  setCloseHandler(closeHandler);
  document.addEventListener('mousedown', closeHandler);
}

/**
 * Открытие боковой панели с предзаполненным вопросом
 * @param {Element} field 
 */
async function openSidePanelWithQuestion(field) {
  const ctx = getFieldContext(field);
  const fieldName = ctx.label || ctx.placeholder || ctx.name || 'это поле';
  
  // Закрываем текущий попап
  if (activeMiniPopupCleanup) {
    activeMiniPopupCleanup();
  }
  
  // Отправляем сообщение в background для открытия панели и предзаполнения
  await chrome.runtime.sendMessage({
    action: 'openSidePanelWithQuestion',
    question: `Как заполнить поле "${fieldName}"?`
  });
}

/**
 * Запрос к AI через background
 * @param {string} prompt 
 * @returns {Promise<string>}
 */
async function sendToAI(prompt) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['email', 'botId', 'botToken', 'model'], (creds) => {
      if (!creds.email || !creds.botId || !creds.botToken) {
        reject(new Error('Необходима авторизация'));
        return;
      }
      
      const authToken = `${creds.botId}_${creds.botToken}`;
      
      chrome.runtime.sendMessage({
        action: 'assistField',
        email: creds.email,
        authToken: authToken,
        model: creds.model || 'x-ai/grok-4.1-fast',
        prompt: prompt
      }, (response) => {
        if (response && response.ok) {
          resolve(response.reply);
        } else {
          reject(new Error(response?.error || 'Ошибка AI'));
        }
      });
    });
  });
}

/**
 * Помощь в заполнении одного поля по пользовательскому запросу
 * @param {Element} field 
 * @param {string} userPrompt 
 * @param {Element} popup 
 * @param {Function} closePopup 
 */
async function assistWithCustomPrompt(field, userPrompt, popup, closePopup) {
  const container = popup.shadowRoot?.querySelector('.mini-popup');
  if (!container) return;

  container.innerHTML = '<div class="mini-popup-loading"><div class="mini-popup-loading-spinner"></div>Генерация...</div>';
  
  try {
    const ctx = getFieldContext(field);
    const pageText = extractVisibleText();
    
    const prompt = `
Страница: ${document.title}
URL: ${location.href}
Контекст страницы: ${pageText.slice(0, 2000)}

Заполни поле формы по следующему запросу пользователя: "${userPrompt}"
Поле: "${ctx.label || ctx.placeholder || ctx.name || 'без названия'}"
Тип: ${ctx.type}
Текущее значение: ${ctx.currentValue || '(пусто)'}

Ответь ТОЛЬКО текстом для вставки в поле, без пояснений.
    `.trim();
    
    const result = await sendToAI(prompt);
    
    setNativeValue(field, result);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    
    closePopup();
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'mini-popup-error';
    errDiv.textContent = `❌ ${err.message}`;
    container.replaceChildren(errDiv);
    setTimeout(() => closePopup(), 2000);
  }
}

/**
 * Помощь в заполнении одного поля
 * @param {Element} field 
 * @param {Object} ctx 
 * @param {Element} popup 
 */
async function assistSingleField(field, popup, closePopup) {
  const container = popup.shadowRoot?.querySelector('.mini-popup');
  if (!container) return;

  container.innerHTML = '<div class="mini-popup-loading"><div class="mini-popup-loading-spinner"></div>Генерация...</div>';
  
  try {
    const ctx = getFieldContext(field);
    const pageText = extractVisibleText();
    
    const prompt = `
Страница: ${document.title}
URL: ${location.href}
Текст страницы: ${pageText.slice(0, 2000)}

Заполни поле формы.
Поле: "${ctx.label || ctx.placeholder || ctx.name || 'без названия'}"
Тип: ${ctx.type}
Текущее значение: ${ctx.currentValue || '(пусто)'}

Ответь ТОЛЬКО текстом для вставки в поле, без пояснений.
    `.trim();
    
    const result = await sendToAI(prompt);
    
    setNativeValue(field, result);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    
    closePopup();
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'mini-popup-error';
    errDiv.textContent = `❌ ${err.message}`;
    container.replaceChildren(errDiv);
    setTimeout(() => closePopup(), 2000);
  }
}

/**
 * Улучшение текста в поле
 * @param {Element} field 
 * @param {Object} ctx 
 * @param {Element} popup 
 */
async function improveFieldText(field, popup, closePopup) {
  const container = popup.shadowRoot?.querySelector('.mini-popup');
  if (!container) return;

  container.innerHTML = '<div class="mini-popup-loading"><div class="mini-popup-loading-spinner"></div>Улучшение...</div>';
  
  try {
    const ctx = getFieldContext(field);
    const pageText = extractVisibleText();
    
    const prompt = `
Страница: ${document.title}
URL: ${location.href}
Контекст страницы: ${pageText.slice(0, 1500)}

Улучшь текст в поле формы.
Поле: "${ctx.label || ctx.placeholder || ctx.name || 'без названия'}"
Текущий текст: "${ctx.currentValue}"

Улучши текст: исправь ошибки, сделай более профессиональным, добавь детали если уместно.
Ответь ТОЛЬКО улучшенным текстом, без пояснений.
    `.trim();
    
    const result = await sendToAI(prompt);
    
    setNativeValue(field, result);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    
    closePopup();
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'mini-popup-error';
    errDiv.textContent = `❌ ${err.message}`;
    container.replaceChildren(errDiv);
    setTimeout(() => closePopup(), 2000);
  }
}

/**
 * Заполнение всей формы
 * @param {Element} form 
 * @param {Element} popup 
 */
async function assistWholeForm(form, popup, closePopup) {
  const container = popup.shadowRoot?.querySelector('.mini-popup');
  if (!container) return;
  container.innerHTML = '<div class="mini-popup-loading"><div class="mini-popup-loading-spinner"></div>Анализ формы...</div>';
  
  try {
    const ctx = getFormContext(form);
    const pageText = extractVisibleText();
    
    const prompt = `
Форма: "${ctx.formTitle}"
Страница: ${document.title}
URL: ${location.href}
Контекст страницы: ${pageText.slice(0, 2000)}

Поля формы:
${ctx.fields.map((f, i) =>
  `${i + 1}. ${f.label || f.name || f.placeholder || 'поле без названия'} (тип: ${f.type}, текущее значение: ${JSON.stringify(f.currentValue || '')})`
).join('\n')}

Верни JSON массив строк — по одному значению для каждого поля в том же порядке.
Только JSON, без markdown-блоков, без пояснений.
Пример: ["значение1", "значение2", "значение3"]
    `.trim();
    
    const raw = await sendToAI(prompt);
    
    // Парсим JSON
    let values;
    try {
      // Убираем возможные markdown блоки
      const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
      values = JSON.parse(cleaned);
    } catch {
      throw new Error('Некорректный ответ AI');
    }
    
    if (!Array.isArray(values)) {
      throw new Error('AI вернул не массив');
    }
    
    ctx.fields.forEach((f, i) => {
      if (values[i] !== undefined && values[i] !== null) {
        setNativeValue(f.element, String(values[i]));
        f.element.dispatchEvent(new Event('input', { bubbles: true }));
        f.element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    
    closePopup();
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'mini-popup-error';
    errDiv.textContent = `❌ ${err.message}`;
    container.replaceChildren(errDiv);
    setTimeout(() => closePopup(), 2000);
  }
}

/**
 * Прикрепление иконки к полю
 * @param {Element} field 
 */
function attachButton(field) {
  if (attachedFields.has(field)) return;
  if (!shouldAttachButton(field)) return;
  
  const { wrapper, btn } = createShadowButton();
  const controller = new AbortController();
  const { signal } = controller;
  
  // Показывать только при фокусе
  field.addEventListener('focus', () => {
    btn.style.opacity = '1';
    positionButton(wrapper, field);
  }, { signal });
  
  field.addEventListener('blur', () => {
    setTimeout(() => {
      // Не скрывать если попап открыт
      const popup = document.querySelector('.protalk-mini-popup-wrapper');
      if (!popup) {
        btn.style.opacity = '0';
      }
    }, 200);
  }, { signal });
  
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMiniPopup(field, btn);
  }, { signal });
  
  document.body.appendChild(wrapper);
  attachedFields.add(field);
  
  // Обновление позиции при скролле/ресайзе
  const updatePosition = () => {
    if (!field.isConnected) {
      cleanup();
      return;
    }
    positionButton(wrapper, field);
  };

  window.addEventListener('scroll', updatePosition, { capture: true, signal });
  window.addEventListener('resize', updatePosition, { signal });

  const cleanup = () => {
    if (!fieldCleanupMap.has(field)) return;
    controller.abort();
    wrapper.remove();
    fieldCleanupMap.delete(field);
    attachedFields.delete(field);
  };

  fieldCleanupMap.set(field, cleanup);
}

/**
 * Сканирование полей на странице
 */
function scanFields() {
  if (!inputAssistantEnabled) return;
  
  document.querySelectorAll('input, textarea').forEach(field => {
    attachButton(field);
  });
}

/**
 * Инициализация Input Assistant
 */
function initInputAssistant() {
  if (!inputAssistantEnabled) return;
  if (fieldObserver) return;
  
  // Сканируем существующие поля
  scanFields();
  
  // Отслеживаем новые поля (SPA)
  fieldObserver = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
          attachButton(node);
        }
        
        node.querySelectorAll?.('input, textarea').forEach(field => {
          attachButton(field);
        });
      });

      m.removedNodes.forEach(node => {
        if (node.nodeType !== 1) return;

        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
          fieldCleanupMap.get(node)?.();
        }

        node.querySelectorAll?.('input, textarea').forEach(field => {
          fieldCleanupMap.get(field)?.();
        });
      });
    });
  });
  
  fieldObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================
// ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageText') {
    waitForStableDOM().then(() => {
      const text = extractVisibleText();
      sendResponse({ text, readyAt: Date.now() });
    }).catch(() => {
      // Fallback если waitForStableDOM не сработал
      const text = extractVisibleText();
      sendResponse({ text, readyAt: Date.now() });
    });
    return true; // async response
  }
  
  if (request.action === 'setInputAssistant') {
    inputAssistantEnabled = request.enabled;
    if (inputAssistantEnabled) {
      initInputAssistant();
    } else {
      if (fieldObserver) {
        fieldObserver.disconnect();
        fieldObserver = null;
      }
      if (activeMiniPopupCleanup) {
        activeMiniPopupCleanup();
      }
      document.querySelectorAll('input, textarea').forEach(field => {
        fieldCleanupMap.get(field)?.();
      });
      document.querySelectorAll('.protalk-input-assistant-wrapper').forEach(el => el.remove());
    }
    sendResponse({ ok: true });
    return true;
  }
  
  if (request.action === 'getInputAssistant') {
    sendResponse({ enabled: inputAssistantEnabled });
    return true;
  }
});

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

// Загрузка настроек Input Assistant
chrome.storage.local.get(['inputAssistantEnabled'], (result) => {
  // Включаем по умолчанию
  inputAssistantEnabled = result.inputAssistantEnabled !== undefined ? result.inputAssistantEnabled : true;
  if (inputAssistantEnabled) {
    initInputAssistant();
    // Для проверки: покажем количество полей ввода
    setTimeout(() => {
      const fields = document.querySelectorAll('input, textarea');
      const count = Array.from(fields).filter(shouldAttachButton).length;
      console.log(`[ProTalk AI] Input Assistant активен. Найдено полей для ввода: ${count}`);
      // В будущем можно добавить UI-индикатор в панель
    }, 1000); // Небольшая задержка, чтобы страница точно загрузилась
  }
});

// Отслеживание SPA-навигации
initSPANavigationTracking();