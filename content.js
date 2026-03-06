'use strict';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageText') {
    const text = getPageText();
    sendResponse({ text: text });
  }
  return true;
});

function getPageText() {
  // Удаляем скрипты, стили и другие невидимые элементы
  const clone = document.cloneNode(true);
  const scripts = clone.querySelectorAll('script, style, noscript, iframe, svg, canvas');
  scripts.forEach(el => el.remove());
  
  // Удаляем элементы с display:none или visibility:hidden
  const hidden = clone.querySelectorAll('*');
  hidden.forEach(el => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      el.remove();
    }
  });
  
  // Получаем текст из body
  const text = clone.body ? clone.body.innerText : clone.innerText;
  
  // Очищаем от лишних пробелов и пустых строк
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
  
  return cleaned;
}
