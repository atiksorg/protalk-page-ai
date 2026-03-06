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

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
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
      observer.disconnect();
      resolve();
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

function initSPANavigationTracking() {
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ action: 'pageNavigated', url: lastUrl });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ============================================
// ФИЧА 2: Input Assistant
// ============================================

// Состояние Input Assistant
let inputAssistantEnabled = false;
const attachedFields = new WeakSet();

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
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      font-size: 14px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .protalk-trigger:hover {
      opacity: 1 !important;
      transform: translateY(-50%) scale(1.1);
    }
    .protalk-trigger:active {
      transform: translateY(-50%) scale(0.95);
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
  wrapper.style.left = `${rect.right - 32 + scrollLeft}px`;
  wrapper.style.height = `${rect.height}px`;
}

/**
 * Создание мини-попапа в Shadow DOM
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
    .mini-popup {
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      min-width: 200px;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
    }
    .mini-popup-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      cursor: pointer;
      transition: background 0.15s ease;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-size: inherit;
    }
    .mini-popup-item:hover {
      background: #f5f5f5;
    }
    .mini-popup-item:active {
      background: #e8e8e8;
    }
    .mini-popup-item:not(:last-child) {
      border-bottom: 1px solid #eee;
    }
    .mini-popup-icon {
      font-size: 16px;
    }
    .mini-popup-label {
      color: #333;
    }
    .mini-popup-loading {
      padding: 16px;
      text-align: center;
      color: #666;
    }
    .mini-popup-error {
      padding: 12px;
      color: #d32f2f;
      background: #ffebee;
    }
  `;
  
  shadow.appendChild(style);
  
  const container = document.createElement('div');
  container.className = 'mini-popup';
  shadow.appendChild(container);
  
  return { popup, container, shadow };
}

/**
 * Рендер элементов мини-попапа
 * @param {Element} container 
 * @param {Array} items 
 */
function renderMiniPopupItems(container, items) {
  container.innerHTML = '';
  
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'mini-popup-item';
    btn.innerHTML = `
      <span class="mini-popup-icon">${item.icon}</span>
      <span class="mini-popup-label">${item.label}</span>
    `;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.action();
    });
    container.appendChild(btn);
  });
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
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(field, value);
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
  const existing = document.querySelector('.protalk-mini-popup-wrapper');
  if (existing) existing.remove();
  
  const { popup, container } = createMiniPopup();
  
  const ctx = getFieldContext(field);
  const form = field.closest('form');
  const hasValue = field.value?.trim().length > 0;
  
  const items = [
    {
      icon: '💡',
      label: `Заполнить: ${ctx.label || ctx.placeholder || 'это поле'}`,
      action: () => assistSingleField(field, ctx, popup)
    }
  ];
  
  if (hasValue) {
    items.push({
      icon: '✏️',
      label: 'Улучшить текст',
      action: () => improveFieldText(field, ctx, popup)
    });
  }
  
  if (form) {
    items.push({
      icon: '📋',
      label: 'Заполнить всю форму',
      action: () => assistWholeForm(form, popup)
    });
  }
  
  renderMiniPopupItems(container, items);
  positionPopupNear(popup, anchorBtn);
  document.body.appendChild(popup);
  
  // Закрытие при клике вне
  const closeHandler = (e) => {
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener('mousedown', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
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
 * Помощь в заполнении одного поля
 * @param {Element} field 
 * @param {Object} ctx 
 * @param {Element} popup 
 */
async function assistSingleField(field, ctx, popup) {
  const container = popup.shadowRoot.querySelector('.mini-popup');
  container.innerHTML = '<div class="mini-popup-loading">⏳ Генерация...</div>';
  
  try {
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
    
    popup.remove();
  } catch (err) {
    container.innerHTML = `<div class="mini-popup-error">❌ ${err.message}</div>`;
    setTimeout(() => popup.remove(), 2000);
  }
}

/**
 * Улучшение текста в поле
 * @param {Element} field 
 * @param {Object} ctx 
 * @param {Element} popup 
 */
async function improveFieldText(field, ctx, popup) {
  const container = popup.shadowRoot.querySelector('.mini-popup');
  container.innerHTML = '<div class="mini-popup-loading">⏳ Улучшение...</div>';
  
  try {
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
    
    popup.remove();
  } catch (err) {
    container.innerHTML = `<div class="mini-popup-error">❌ ${err.message}</div>`;
    setTimeout(() => popup.remove(), 2000);
  }
}

/**
 * Заполнение всей формы
 * @param {Element} form 
 * @param {Element} popup 
 */
async function assistWholeForm(form, popup) {
  const container = popup.shadowRoot.querySelector('.mini-popup');
  container.innerHTML = '<div class="mini-popup-loading">⏳ Анализ формы...</div>';
  
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
  `${i + 1}. ${f.label || f.name || f.placeholder || 'поле без названия'} (тип: ${f.type})`
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
    
    popup.remove();
  } catch (err) {
    container.innerHTML = `<div class="mini-popup-error">❌ ${err.message}</div>`;
    setTimeout(() => popup.remove(), 2000);
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
  
  // Показывать только при фокусе
  field.addEventListener('focus', () => {
    btn.style.opacity = '1';
    positionButton(wrapper, field);
  });
  
  field.addEventListener('blur', () => {
    setTimeout(() => {
      // Не скрывать если попап открыт
      const popup = document.querySelector('.protalk-mini-popup-wrapper');
      if (!popup) {
        btn.style.opacity = '0';
      }
    }, 200);
  });
  
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMiniPopup(field, btn);
  });
  
  document.body.appendChild(wrapper);
  attachedFields.add(field);
  
  // Обновление позиции при скролле/ресайзе
  const updatePosition = () => positionButton(wrapper, field);
  window.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);
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
  
  // Сканируем существующие поля
  scanFields();
  
  // Отслеживаем новые поля (SPA)
  const fieldObserver = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
          attachButton(node);
        }
        
        node.querySelectorAll('input, textarea').forEach(field => {
          attachButton(field);
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
      // Удаляем все иконки
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
  inputAssistantEnabled = result.inputAssistantEnabled || false;
  if (inputAssistantEnabled) {
    initInputAssistant();
  }
});

// Отслеживание SPA-навигации
initSPANavigationTracking();