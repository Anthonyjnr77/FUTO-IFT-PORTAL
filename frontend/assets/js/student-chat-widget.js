(function() {
  var user = window.Auth && window.Auth.get();
  if (!user || !user.isLoggedIn || user.role !== 'student') return;

  var styles = document.createElement('style');
  styles.textContent = [
    '.student-chat-launcher{position:fixed;right:18px;bottom:18px;z-index:9998;border:0;border-radius:999px;padding:13px 17px;background:#0d9488;color:#fff;font:700 14px Inter,system-ui,sans-serif;box-shadow:0 8px 26px #0f172a44;cursor:pointer}',
    '.student-chat-panel{position:fixed;right:18px;bottom:82px;z-index:9999;display:none;flex-direction:column;width:min(370px,calc(100vw - 28px));height:min(500px,calc(100vh - 112px));overflow:hidden;border:1px solid #cbd5e1;border-radius:16px;background:#fff;color:#0f172a;box-shadow:0 16px 48px #0f172a33;font-family:Inter,system-ui,sans-serif}',
    '.student-chat-panel.is-open{display:flex}',
    '.student-chat-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0b1c3a;color:#fff}',
    '.student-chat-head strong{font-size:14px}.student-chat-close{border:0;background:transparent;color:#fff;font-size:22px;cursor:pointer}',
    '.student-chat-log{display:flex;flex:1;flex-direction:column;gap:10px;overflow:auto;padding:14px;background:#f8fafc}',
    '.student-chat-message{max-width:90%;margin:0;padding:10px 12px;border-radius:12px;background:#e2e8f0;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.student-chat-message.is-user{align-self:flex-end;background:#ccfbf1}.student-chat-message.is-error{background:#fee2e2;color:#991b1b}',
    '.student-chat-message a{display:block;margin-top:7px;color:#0f766e;font-weight:700}',
    '.student-chat-form{display:flex;gap:8px;padding:12px;border-top:1px solid #e2e8f0}',
    '.student-chat-input{min-width:0;flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:9px;font:inherit;font-size:13px}',
    '.student-chat-send{border:0;border-radius:9px;padding:0 13px;background:#0d9488;color:#fff;font-weight:700;cursor:pointer}',
    '.student-chat-send:disabled{opacity:.55;cursor:wait}',
    '@media(max-width:480px){.student-chat-launcher{right:12px;bottom:12px}.student-chat-panel{right:10px;bottom:76px;height:min(480px,calc(100vh - 96px))}'
  ].join('');
  document.head.appendChild(styles);

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'student-chat-launcher';
  launcher.textContent = 'Ask the course helper';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'studentChatPanel');

  var panel = document.createElement('section');
  panel.className = 'student-chat-panel';
  panel.id = 'studentChatPanel';
  panel.setAttribute('aria-label', 'Course resource helper');
  var header = document.createElement('div');
  header.className = 'student-chat-head';
  var title = document.createElement('strong');
  title.textContent = 'Course resource helper';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'student-chat-close';
  close.setAttribute('aria-label', 'Close course helper');
  close.textContent = '×';
  header.append(title, close);

  var log = document.createElement('div');
  log.className = 'student-chat-log';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  var welcome = document.createElement('p');
  welcome.className = 'student-chat-message';
  welcome.textContent = 'Ask a question about your course PDFs, request a summary, or include a course code such as IFT 512.';
  log.appendChild(welcome);
  var lastMaterialId = '';

  var form = document.createElement('form');
  form.className = 'student-chat-form';
  var input = document.createElement('input');
  input.className = 'student-chat-input';
  input.type = 'text';
  input.maxLength = 500;
  input.required = true;
  input.placeholder = 'Ask a course question or request a summary';
  input.setAttribute('aria-label', 'Ask a course question or request a summary');
  var send = document.createElement('button');
  send.className = 'student-chat-send';
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(input, send);
  panel.append(header, log, form);
  document.body.append(launcher, panel);

  function addMessage(text, role, resource) {
    var message = document.createElement('p');
    message.className = 'student-chat-message' + (role ? ' is-' + role : '');
    message.textContent = text;
    if (resource && resource.courseUrl) {
      var link = document.createElement('a');
      link.href = resource.courseUrl;
      link.textContent = resource.resourceType === 'video' ? 'Open course page to watch the video' : 'Open the recommended course resource';
      message.appendChild(link);
    }
    log.appendChild(message);
    log.scrollTop = log.scrollHeight;
  }

  function setOpen(isOpen) {
    panel.classList.toggle('is-open', isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) input.focus();
  }

  launcher.addEventListener('click', function() {
    setOpen(!panel.classList.contains('is-open'));
  });
  close.addEventListener('click', function() {
    setOpen(false);
    launcher.focus();
  });
  form.addEventListener('submit', async function(event) {
    event.preventDefault();
    var query = input.value.trim();
    if (!query) return;
    addMessage(query, 'user');
    input.value = '';
    send.disabled = true;
    try {
      var params = new URLSearchParams(window.location.search);
      var courseId = window.location.pathname.endsWith('/course.html') || window.location.pathname.endsWith('course.html')
        ? params.get('id')
        : '';
      var result = await window.Auth.request('/student/chat', {
        method: 'POST',
        body: JSON.stringify({
          query: query,
          ...(courseId ? { courseId: courseId } : {}),
          ...(lastMaterialId ? { materialId: lastMaterialId } : {})
        })
      });
      if (result.resource && result.resource.id) lastMaterialId = result.resource.id;
      addMessage(result.answer, '', result.resource);
    } catch (error) {
      addMessage('Resource search failed: ' + error.message, 'error');
    } finally {
      send.disabled = false;
      input.focus();
    }
  });
})();
