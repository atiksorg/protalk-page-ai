'use strict';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'askAI') {
    askAI(request).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // для асинхронного ответа
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
