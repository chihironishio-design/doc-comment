/* =====================================================
   DocComment — script.js
===================================================== */
/* global PROMPTS, MODEL_OPTIONS, SECTION_HEADERS */

// ---- State ----
const state = {
  title:          '',
  content:        '',
  markdownSource: '',   // 現在表示中の台本のMarkdownソース（AI追記時に更新）
  comments:       [],
  apiKey:         '',   // session-only: never persisted
  formatModel:    'gemini-2.5-flash',
  assistModel:    'gemini-2.5-flash',
  pendingRange:   null,
  pendingSnapshot: null,
};

const OWNED_KEY = 'doccomment_owned_ids';

// ---- LocalStorage helpers ----
function getOwnedIds() {
  try { return JSON.parse(localStorage.getItem(OWNED_KEY) || '[]'); }
  catch { return []; }
}
function saveOwnedId(id) {
  const ids = getOwnedIds();
  ids.push(id);
  localStorage.setItem(OWNED_KEY, JSON.stringify(ids));
}
function isOwned(id) { return getOwnedIds().includes(id); }

// ---- Utils ----
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function formatTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Screen switching ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---- Model select population ----
function populateModelSelects() {
  ['format-model-select', 'assist-model-select'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '';
    MODEL_OPTIONS.forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    });
  });
}


/* =====================================================
   Gemini API — 共通呼び出し関数
===================================================== */
async function callGeminiAPI(prompt, apiKey, model, temperature = 0.4) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTPエラー ${res.status}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('APIレスポンスに本文が含まれていませんでした');
  // コードブロック記法の外側ラッパーを除去
  let cleaned = text.trim();
  if (/^```(?:markdown|md)?\n/.test(cleaned)) {
    cleaned = cleaned.slice(cleaned.indexOf('\n') + 1);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trimEnd();
  }
  return cleaned.trim();
}


/* =====================================================
   Markdown rendering
===================================================== */
function renderMarkdown(text) {
  const rawHtml = marked.parse(text, { gfm: true });
  return DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
}


/* =====================================================
   Document rendering (viewer)
===================================================== */
function renderDocument() {
  document.getElementById('document-content').innerHTML = renderMarkdown(state.markdownSource);
  document.querySelectorAll('.highlight').forEach(attachHighlightListeners);
}


/* =====================================================
   AI Assist — セクション追記（同一ヘッダーは上書き）
===================================================== */
function appendSection(header, newContent) {
  let src = state.markdownSource;
  const idx = src.indexOf(header);
  if (idx !== -1) {
    // 前にある `---` 区切り線ごと削除して差し替え
    const before = src.slice(0, idx);
    const sepIdx = before.lastIndexOf('\n---\n');
    const cutAt = sepIdx !== -1 ? sepIdx : idx;
    src = src.slice(0, cutAt).trimEnd();
  }
  state.markdownSource = `${src}\n\n---\n\n${header}\n\n${newContent}`;
}


/* =====================================================
   AI Assist — ボタンのローディング制御
===================================================== */
function setAssistBtnLoading(btn, loading) {
  if (loading) {
    btn.dataset.original = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span><span>生成中...</span>';
    btn.classList.add('loading');
  } else {
    btn.innerHTML = btn.dataset.original || btn.innerHTML;
    btn.classList.remove('loading');
    delete btn.dataset.original;
  }
}


/* =====================================================
   AI Assist — ツールバーの有効/無効切り替え
===================================================== */
function updateAssistToolbar() {
  const notice = document.getElementById('no-apikey-notice');
  const btns   = document.querySelectorAll('.ai-assist-btn');
  if (!state.apiKey) {
    notice.classList.remove('hidden');
    btns.forEach(b => { b.disabled = true; });
  } else {
    notice.classList.add('hidden');
    btns.forEach(b => { b.disabled = false; });
  }
}


/* =====================================================
   AI Assist — 実行ロジック（3アクション共通）
===================================================== */
async function runAiAssist(action) {
  if (!state.apiKey) {
    showToast('APIキーが設定されていません。セットアップ画面で入力してください。', 'error');
    return;
  }
  if (!state.markdownSource) {
    showToast('台本が読み込まれていません。', 'error');
    return;
  }

  // 既存コメントがある場合は警告
  if (state.comments.length > 0) {
    const ok = confirm(
      'AIによる追記を行うと、既存のコメントハイライトがすべてリセットされます。\n続行しますか？'
    );
    if (!ok) return;
  }

  const allBtns = document.querySelectorAll('.ai-assist-btn');
  const thisBtn = document.getElementById(`btn-${action}`);
  allBtns.forEach(b => { b.disabled = true; });
  setAssistBtnLoading(thisBtn, true);

  try {
    // hookは法規制遵守を優先するため温度を低く設定
    const temperature = action === 'hook' ? 0.4 : 0.7;
    const prompt = PROMPTS[action](state.markdownSource);
    const result = await callGeminiAPI(prompt, state.apiKey, state.assistModel, temperature);

    if (action === 'scene') {
      // 既存テーブルの「想定カット」列を直接埋めるので全文置き換え
      state.markdownSource = result;
    } else {
      appendSection(SECTION_HEADERS[action], result);
    }
    renderDocument();

    // コメントをリセット
    state.comments = [];
    renderComments();

    showToast('AI提案を台本末尾に追記しました ✨', 'success');
  } catch (err) {
    showToast(`エラー: ${err.message}`, 'error');
  } finally {
    allBtns.forEach(b => { b.disabled = !state.apiKey; });
    setAssistBtnLoading(thisBtn, false);
  }
}


/* =====================================================
   Toast notification
===================================================== */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}


/* =====================================================
   Highlight: wrap selected range in <span> tags
===================================================== */
function wrapRangeInHighlight(range, commentId) {
  const docContent = document.getElementById('document-content');
  const snapshot = docContent.innerHTML;

  // Strategy 1: surroundContents (single-element selection)
  try {
    const span = document.createElement('span');
    span.className = 'highlight';
    span.dataset.commentId = commentId;
    range.surroundContents(span);
    attachHighlightListeners(span);
    return true;
  } catch (_) {
    // Cross-element selection — fall through
  }

  // Strategy 2: TreeWalker — wrap each text node individually
  try {
    const startNode = range.startContainer;
    const endNode   = range.endContainer;
    const startOff  = range.startOffset;
    const endOff    = range.endOffset;

    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }

    if (textNodes.length === 0) return false;

    for (const textNode of textNodes) {
      let from = 0;
      let to   = textNode.length;
      if (textNode === startNode) from = startOff;
      if (textNode === endNode)   to   = endOff;
      if (from >= to) continue;

      let target = textNode;
      if (from > 0) {
        target = textNode.splitText(from);
        to -= from;
      }
      if (to < target.length) target.splitText(to);

      const span = document.createElement('span');
      span.className = 'highlight';
      span.dataset.commentId = commentId;
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      attachHighlightListeners(span);
    }
    return true;
  } catch (err) {
    console.error('Highlight failed, rolling back:', err);
    docContent.innerHTML = snapshot;
    document.querySelectorAll('.highlight').forEach(attachHighlightListeners);
    return false;
  }
}

function removeHighlightsByCommentId(commentId) {
  const spans = document.querySelectorAll(`.highlight[data-comment-id="${commentId}"]`);
  spans.forEach(span => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

function attachHighlightListeners(span) {
  span.addEventListener('mouseenter', () => {
    const id = span.dataset.commentId;
    setActiveHighlight(id, true);
    setActiveComment(id, true, true);
  });
  span.addEventListener('mouseleave', () => {
    const id = span.dataset.commentId;
    setActiveHighlight(id, false);
    setActiveComment(id, false);
  });
}

function setActiveHighlight(commentId, active) {
  document.querySelectorAll(`.highlight[data-comment-id="${commentId}"]`)
    .forEach(el => el.classList.toggle('active', active));
}

function setActiveComment(commentId, active, scroll = false) {
  const card = document.querySelector(`.comment-card[data-comment-id="${commentId}"]`);
  if (!card) return;
  card.classList.toggle('active', active);
  if (active && scroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}


/* =====================================================
   Comments rendering
===================================================== */
function renderComments() {
  const list  = document.getElementById('comments-list');
  const badge = document.getElementById('comment-count');
  badge.textContent = state.comments.length;

  if (state.comments.length === 0) {
    list.innerHTML = '<p class="no-comments-msg">テキストを選択してコメントを追加できます</p>';
    return;
  }

  list.innerHTML = '';
  state.comments.forEach(c => list.appendChild(createCommentCard(c)));
}

function createCommentCard(comment) {
  const owned = isOwned(comment.id);
  const card  = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.commentId = comment.id;

  const actionsHtml = owned
    ? `<div class="comment-actions">
         <button class="comment-action-btn edit" title="編集" data-id="${comment.id}">✏️</button>
         <button class="comment-action-btn delete" title="削除" data-id="${comment.id}">🗑️</button>
       </div>`
    : '';

  card.innerHTML = `
    <div class="comment-header">
      <div class="comment-meta">
        <span class="commenter-name">${escapeHtml(comment.name || '匿名')}</span>
        <span class="comment-time">${formatTime(comment.ts)}</span>
      </div>
      ${actionsHtml}
    </div>
    <div class="comment-body" data-id="${comment.id}">${escapeHtml(comment.text)}</div>
  `;

  card.addEventListener('mouseenter', () => {
    setActiveHighlight(comment.id, true);
    card.classList.add('active');
  });
  card.addEventListener('mouseleave', () => {
    setActiveHighlight(comment.id, false);
    card.classList.remove('active');
  });

  if (owned) {
    card.querySelector('.comment-action-btn.edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditForm(card, comment);
    });
    card.querySelector('.comment-action-btn.delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteComment(comment.id);
    });
  }

  return card;
}

function openEditForm(card, comment) {
  const existing = card.querySelector('.comment-edit-form');
  if (existing) existing.remove();

  const body = card.querySelector('.comment-body');
  body.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'comment-edit-form';
  form.innerHTML = `
    <textarea class="edit-textarea" rows="3"></textarea>
    <div class="edit-actions">
      <button class="btn-cancel-edit">キャンセル</button>
      <button class="btn-save-edit">保存</button>
    </div>
  `;

  const textarea = form.querySelector('.edit-textarea');
  textarea.value = comment.text;

  form.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    form.remove();
    body.style.display = '';
  });
  form.querySelector('.btn-save-edit').addEventListener('click', () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    comment.text = newText;
    form.remove();
    body.style.display = '';
    body.textContent = newText;
  });

  card.appendChild(form);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function deleteComment(commentId) {
  if (!confirm('このコメントを削除しますか？')) return;
  state.comments = state.comments.filter(c => c.id !== commentId);
  removeHighlightsByCommentId(commentId);
  renderComments();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* =====================================================
   Selection Popover
===================================================== */
function showPopover(rect) {
  const popover  = document.getElementById('selection-popover');
  const popoverW = 180;
  const scrollX  = window.scrollX || window.pageXOffset;
  const scrollY  = window.scrollY || window.pageYOffset;

  let left = rect.left + rect.width / 2 - popoverW / 2 + scrollX;
  let top  = rect.top - 46 + scrollY;
  left = Math.max(8, Math.min(left, window.innerWidth - popoverW - 8 + scrollX));

  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;
  popover.classList.remove('hidden');
}

function hidePopover() {
  document.getElementById('selection-popover').classList.add('hidden');
}


/* =====================================================
   Comment Modal
===================================================== */
function openCommentModal() {
  document.getElementById('commenter-name').value = '';
  document.getElementById('comment-text').value   = '';
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('comment-text').focus(), 50);
}

function closeCommentModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  state.pendingRange    = null;
  state.pendingSnapshot = null;
  window.getSelection()?.removeAllRanges();
}

function submitComment() {
  const name = document.getElementById('commenter-name').value.trim();
  const text = document.getElementById('comment-text').value.trim();
  if (!text) { document.getElementById('comment-text').focus(); return; }

  const id      = uid();
  const comment = { id, name, text, ts: Date.now() };

  if (state.pendingRange) {
    const ok = wrapRangeInHighlight(state.pendingRange, id);
    if (!ok) {
      alert('選択範囲のハイライト処理に失敗しました。もう一度選択してください。');
      closeCommentModal();
      return;
    }
  }

  state.comments.push(comment);
  saveOwnedId(id);
  state.pendingRange    = null;
  state.pendingSnapshot = null;
  window.getSelection()?.removeAllRanges();

  document.getElementById('modal-overlay').classList.add('hidden');
  renderComments();
}


/* =====================================================
   Viewer — Setup
===================================================== */
function launchViewer() {
  const title   = document.getElementById('doc-title').value.trim() || '無題のドキュメント';
  const content = document.getElementById('formatted-input').value.trim();

  if (!content) {
    alert('STEP 2 に内容を入力してください。');
    return;
  }

  // 状態をキャッシュ（APIキーは入力されていれば更新）
  const apiKey = document.getElementById('api-key').value.trim();
  if (apiKey) state.apiKey = apiKey;

  state.title          = title;
  state.markdownSource = content;
  state.content        = content;
  state.formatModel    = document.getElementById('format-model-select').value;
  state.assistModel    = document.getElementById('assist-model-select').value;
  state.comments       = [];

  document.getElementById('viewer-title').textContent = title;
  renderDocument();
  renderComments();
  updateAssistToolbar();
  window.getSelection()?.removeAllRanges();

  showScreen('viewer-screen');
}


/* =====================================================
   Event listeners
===================================================== */
document.addEventListener('DOMContentLoaded', () => {

  // モデルセレクトをMODEL_OPTIONSから動的生成
  populateModelSelects();


  // ---- Setup screen ----

  document.getElementById('ai-format-btn').addEventListener('click', async () => {
    const rawText = document.getElementById('raw-input').value.trim();
    const apiKey  = document.getElementById('api-key').value.trim();
    const errBox  = document.getElementById('ai-error');
    const btn     = document.getElementById('ai-format-btn');

    errBox.classList.add('hidden');
    if (!rawText) { errBox.textContent = '元テキストを貼り付けてください。'; errBox.classList.remove('hidden'); return; }
    if (!apiKey)  { errBox.textContent = 'Gemini API Key を入力してください。'; errBox.classList.remove('hidden'); return; }

    state.apiKey = apiKey;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span class="ai-btn-text">整形中...</span>';

    try {
      const model  = document.getElementById('format-model-select').value;
      const result = await callGeminiAPI(PROMPTS.format(rawText), apiKey, model, 0.1);
      document.getElementById('formatted-input').value = result;
    } catch (err) {
      errBox.textContent = `エラー: ${err.message}`;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="ai-btn-icon" aria-hidden="true">✨</span><span class="ai-btn-text">AI 自動整形</span>';
    }
  });

  document.getElementById('publish-btn').addEventListener('click', launchViewer);


  // ---- Viewer screen ----

  document.getElementById('back-btn').addEventListener('click', () => showScreen('setup-screen'));

  document.getElementById('share-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(
      () => showToast('URLをコピーしました（プロトタイプ：固有URLは Firebase 連携後に生成されます）', 'success'),
      () => showToast('クリップボードへのアクセスが拒否されました', 'error')
    );
  });

  // ---- AI Assist buttons ----
  document.getElementById('btn-hook').addEventListener('click',       () => runAiAssist('hook'));
  document.getElementById('btn-scene').addEventListener('click',      () => runAiAssist('scene'));
  document.getElementById('btn-regulation').addEventListener('click', () => runAiAssist('regulation'));


  // ---- Text Selection ----

  const docArea = document.querySelector('.viewer-body');

  docArea.addEventListener('mouseup', e => {
    if (e.target.closest('#selection-popover') || e.target.closest('#modal-overlay')) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.toString().trim() === '') {
      hidePopover();
      return;
    }

    const range      = selection.getRangeAt(0);
    const docContent = document.getElementById('document-content');
    if (!docContent.contains(range.commonAncestorContainer)) { hidePopover(); return; }

    state.pendingRange = range.cloneRange();
    showPopover(range.getBoundingClientRect());
  });

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#selection-popover') && !e.target.closest('#modal-overlay')) {
      hidePopover();
    }
  });


  // ---- Add comment flow ----

  document.getElementById('add-comment-btn').addEventListener('click', () => {
    hidePopover();
    if (!state.pendingRange) return;
    openCommentModal();
  });

  document.getElementById('submit-comment-btn').addEventListener('click', submitComment);
  document.getElementById('cancel-comment-btn').addEventListener('click', closeCommentModal);

  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeCommentModal();
  });

  document.getElementById('comment-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCommentModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment();
  });
});
