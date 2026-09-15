/** Nickname state lives only in this module instance; reactions live in the board. */
export function installCommunication({ engine, forkBoard, onError = () => {}, onToast = () => {}, isBusy = () => false }) {
  const side = document.querySelector('.side-panel'), tabs = document.querySelector('.panel-tabs');
  if (!side || !tabs) throw new Error('Reaction controls require the side panel.');
  const create = (tag, className = '', text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className = 'button soft') => {
    const node = create('button', className, text); node.type = 'button'; return node;
  };
  const tab = button('반응', '');
  tab.id = 'tab-reactions'; tab.dataset.panel = 'reactions'; tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false'); tab.setAttribute('aria-controls', 'panel-reactions'); tabs.append(tab);
  const panel = create('section', 'panel-body'); panel.id = 'panel-reactions'; panel.hidden = true;
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
  side.insertBefore(panel, side.querySelector('.panel-footer'));
  panel.append(create('div', 'section-label', 'A SMALL SIGN OF APPRECIATION'), create('h2', '', '그림에 마음을\n남겨보세요.'));
  panel.append(create('p', 'muted', '로그인 없는 표시 이름 · 현재 탭에서만 기억해요.'));
  const label = create('label', 'small-label', '내 닉네임'); label.htmlFor = 'reaction-nickname';
  const input = create('input', 'text-input'); input.id = 'reaction-nickname'; input.maxLength = 100;
  input.placeholder = '닉네임을 먼저 정해주세요'; input.autocomplete = 'off';
  const chooseName = button('닉네임 정하기', 'button soft full'); chooseName.id = 'set-reaction-nickname';
  const identityStatus = create('p', 'small muted'); identityStatus.id = 'nickname-status';
  const reactionLabel = create('div', 'field-heading'); reactionLabel.append(create('strong', '', '이 그림에 반응하기'));
  const reactions = create('div', 'reaction-buttons'); reactions.id = 'board-reactions';
  reactions.setAttribute('aria-label', '그림 반응');
  const names = create('ul', 'reaction-people'); names.id = 'reaction-display-names';
  const snapshotNote = create('p', 'small muted', '반응과 표시 이름은 보드에 저장되어 공유 링크에 함께 담겨요. 새 링크를 주고받는 방식이며 실시간 집계는 아니에요.');
  const sourceNote = create('p', 'small muted'); sourceNote.id = 'reaction-source-hint';
  panel.append(label, input, chooseName, identityStatus, reactionLabel, reactions, names, snapshotNote, sourceNote);

  const dialog = create('dialog'); dialog.id = 'nickname-dialog';
  const form = create('form'); form.id = 'nickname-form';
  form.append(create('div', 'section-label', 'YOUR NAME FOR THIS TAB'), create('h2', '', '어떤 이름으로 남길까요?'));
  form.append(create('p', 'muted', '로그인 없이 사용할 표시 이름이에요. 이 탭을 새로 열면 다시 정할 수 있어요.'));
  const dialogLabel = create('label', 'small-label', '닉네임'); dialogLabel.htmlFor = 'nickname-dialog-input';
  const dialogInput = create('input', 'text-input'); dialogInput.id = 'nickname-dialog-input';
  dialogInput.maxLength = 100; dialogInput.required = true; dialogInput.autocomplete = 'off'; dialogInput.placeholder = '예: 보라';
  const actions = create('div', 'dialog-actions');
  const submit = button('이 이름 사용하기', 'button primary'); submit.type = 'submit'; submit.id = 'confirm-nickname';
  const cancel = button('나중에', 'button quiet'); cancel.id = 'cancel-nickname'; actions.append(submit, cancel);
  form.append(dialogLabel, dialogInput, actions); dialog.append(form); document.body.append(dialog);

  const emojis = ['👍', '❤️', '✨', '💡', '👏', '❓'];
  let nickname = '', pending = null, working = false, disposed = false;
  const readOnly = () => typeof engine.isReadOnly === 'function' ? engine.isReadOnly() : Boolean(engine.isReadOnly);
  const nicknameError = () => { const error = new Error('반응을 남기려면 이 탭에서 사용할 닉네임을 먼저 정해주세요.'); error.code = 'NICKNAME_REQUIRED'; return error; };
  const assertReady = () => {
    if (disposed) throw new Error('반응 패널이 닫혔어요.');
    if (isBusy()) { const error = new Error('보드를 여는 중이에요. 잠시 뒤 다시 시도해주세요.'); error.code = 'DOCUMENT_BUSY'; throw error; }
  };
  const checked = result => {
    if (!result?.ok) { const error = new Error(result?.error?.message || '반응을 저장하지 못했어요.'); error.code = result?.error?.code; throw error; }
    return result;
  };
  function finishNickname(value, error) {
    const request = pending; pending = null;
    if (dialog.open) dialog.close();
    if (request) { if (error) request.reject(error); else request.resolve(value); }
  }
  function setNickname(name) {
    if (disposed) throw new Error('반응 패널이 닫혔어요.');
    if (typeof name !== 'string' || name.length > 100 || !name.trim()) throw nicknameError();
    nickname = name.trim(); input.value = nickname;
    finishNickname(nickname); refresh(); return nickname;
  }
  function requestNickname() {
    if (disposed) return Promise.reject(new Error('반응 패널이 닫혔어요.'));
    if (nickname) return Promise.resolve(nickname);
    if (pending) return pending.promise;
    const request = {};
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    pending = request; dialogInput.value = input.value.trim(); dialog.showModal(); dialogInput.focus();
    return request.promise;
  }
  async function react(emoji) {
    if (working || disposed) return;
    working = true; refresh();
    try {
      assertReady(); const startingDocumentId = engine.getDocument().id;
      await requestNickname(); assertReady();
      if (engine.getDocument().id !== startingDocumentId) {
        const error = new Error('닉네임을 정하는 동안 보드가 바뀌었어요. 현재 그림에서 반응을 다시 선택해주세요.');
        error.code = 'STALE_DOCUMENT'; throw error;
      }
      if (readOnly()) { checked(await forkBoard({})); assertReady(); }
      if (!nickname) throw nicknameError();
      checked(engine.execute({ type: 'reaction_toggle', emoji, author: nickname }, { actor: 'human' }));
      onToast('반응을 이 보드에 저장했어요. 새 공유 링크에 함께 담겨요.');
    } catch (error) { onError(error); }
    finally { working = false; if (!disposed) refresh(); }
  }
  function refresh() {
    if (disposed) return;
    const current = engine.getDocument();
    identityStatus.textContent = nickname ? `지금은 ${nickname} 님으로 표시해요.` : '아직 닉네임을 정하지 않았어요.';
    chooseName.textContent = nickname ? '닉네임 바꾸기' : '닉네임 정하기';
    sourceNote.textContent = readOnly() ? '공유된 원본은 그대로 두고, 포크한 보드에 내 반응을 남겨요.' : '';
    reactions.replaceChildren(); names.replaceChildren();
    for (const emoji of emojis) {
      const entries = (current.reactions ?? []).filter(item => item.emoji === emoji);
      const pressed = Boolean(nickname) && entries.some(item => item.author === nickname);
      const reaction = button(`${emoji} ${entries.length}`, 'reaction-button');
      reaction.dataset.emoji = emoji; reaction.disabled = working;
      const displayNames = entries.slice(0, 12).map(item => item.author).join(', ');
      const description = `${displayNames}${entries.length > 12 ? ` 외 ${entries.length - 12}개 표시 이름` : ''}`;
      reaction.title = entries.length ? `${emoji} ${description}` : `${emoji} 첫 반응 남기기`;
      reaction.setAttribute('aria-pressed', String(pressed));
      reaction.setAttribute('aria-label', `${emoji} 반응 ${entries.length}개${pressed ? ', 내 반응 취소' : ', 반응 남기기'}`);
      reaction.addEventListener('click', () => react(emoji)); reactions.append(reaction);
      if (entries.length) names.append(create('li', 'small muted', `${emoji} ${description}`));
    }
  }
  tab.addEventListener('click', () => {
    for (const item of tabs.querySelectorAll('[data-panel]')) item.setAttribute('aria-selected', String(item === tab));
    for (const section of side.querySelectorAll('.panel-body')) section.hidden = section !== panel;
    refresh();
  });
  chooseName.addEventListener('click', async () => {
    try { if (input.value.trim()) setNickname(input.value); else await requestNickname(); }
    catch (error) { onError(error); }
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); try { setNickname(input.value); } catch (error) { onError(error); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    try { setNickname(dialogInput.value); }
    catch { dialogInput.setCustomValidity('닉네임을 1~100자로 적어주세요.'); dialogInput.reportValidity(); }
  });
  dialogInput.addEventListener('input', () => dialogInput.setCustomValidity(''));
  cancel.addEventListener('click', () => finishNickname(undefined, nicknameError()));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finishNickname(undefined, nicknameError()); });
  dialog.addEventListener('close', () => { if (pending) finishNickname(undefined, nicknameError()); });
  const unsubscribe = engine.subscribe(refresh); refresh();
  return { getNickname: () => nickname, setNickname, requestNickname, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; finishNickname(undefined, nicknameError()); unsubscribe();
      dialog.remove(); panel.remove(); tab.remove(); nickname = '';
    },
  };
}
