// DOM 조작 유틸리티

/**
 * 엘리먼트 등장 대기 (폴링 방식)
 * @param {string} selector - CSS 셀렉터
 * @param {number} timeout - 최대 대기 시간 (ms)
 * @param {number} interval - 폴링 간격 (ms)
 * @param {Document} doc - 탐색할 document (기본: window.document)
 * @returns {Promise<Element>}
 */
async function waitForElement(selector, timeout = 10000, interval = 300, doc = document) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const poll = () => {
      const el = doc.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }
      if (Date.now() - startTime >= timeout) {
        reject(new Error(`waitForElement timeout: "${selector}"`));
        return;
      }
      setTimeout(poll, interval);
    };

    poll();
  });
}

/**
 * ms 단위 대기
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 안전한 클릭 (엘리먼트 존재 확인 후 클릭)
 * @param {string} selector
 * @param {Document} doc
 * @returns {boolean} 클릭 성공 여부
 */
function safeClick(selector, doc = document) {
  const el = doc.querySelector(selector);
  if (el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}

/**
 * iframe 내부 document 접근
 * @param {string} iframeSelector
 * @param {Document} doc
 * @returns {Document|null}
 */
function getIframeDocument(iframeSelector, doc = document) {
  const iframe = doc.querySelector(iframeSelector);
  if (!iframe) return null;
  try {
    return iframe.contentDocument || iframe.contentWindow.document;
  } catch (e) {
    return null;
  }
}

/**
 * 텍스트 포함 엘리먼트 탐색 (jQuery-like :contains)
 * @param {string} selector - 탐색할 엘리먼트 타입 (e.g. "span", "button")
 * @param {string} text - 포함할 텍스트
 * @param {Document} doc
 * @returns {Element|null}
 */
function findByText(selector, text, doc = document) {
  const elements = doc.querySelectorAll(selector);
  for (const el of elements) {
    if (el.textContent.trim() === text) {
      return el;
    }
  }
  return null;
}

/**
 * 텍스트 포함 엘리먼트 전체 탐색
 * @param {string} selector
 * @param {string} text
 * @param {Document} doc
 * @returns {Element[]}
 */
function findAllByText(selector, text, doc = document) {
  const elements = doc.querySelectorAll(selector);
  return Array.from(elements).filter(el => el.textContent.trim() === text);
}
