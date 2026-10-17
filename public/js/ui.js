// Shared dialog focus management and non-blocking feedback.
(() => {
  let toastTimer;
  let viewportFrame;
  const updateViewport = () => {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      // Let native pinch zoom pan freely; only adapt keyboard/browser chrome changes.
      if (viewport && Math.abs(viewport.scale - 1) > .05) return;
      const root = document.documentElement.style;
      root.setProperty('--visual-height', `${viewport?.height || innerHeight}px`);
      root.setProperty('--visual-top', `${viewport?.offsetTop || 0}px`);
      root.setProperty('--visual-left', `${viewport?.offsetLeft || 0}px`);
      root.setProperty('--visual-width', `${viewport?.width || innerWidth}px`);
    });
  };
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);
  window.addEventListener('resize', updateViewport);
  updateViewport();
  const toast = document.createElement('div');
  toast.className = 'ui-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);
  window.showNotice = (message, error = true) => {
    const modal = document.querySelector('.modal-overlay.active');
    if (modal && error) {
      let notice = modal.querySelector('.form-notice');
      if (!notice) {
        notice = document.createElement('p');
        notice.className = 'form-notice';
        notice.setAttribute('role', 'alert');
        notice.tabIndex = -1;
        modal.querySelector('.modal-body').prepend(notice);
      }
      notice.textContent = message;
      notice.hidden = false;
      notice.focus();
      return;
    }
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), error ? 6500 : 3500);
  };
  window.apiFetch = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try { return await fetch(url, { ...options, signal: options.signal || controller.signal }); }
    catch (err) { if (err.name === 'AbortError') throw new Error('요청 시간이 초과되었습니다. 연결 상태를 확인하고 다시 시도해 주세요.'); throw err; }
    finally { clearTimeout(timeout); }
  };
  window.setFormBusy = (form, busy) => {
    form.setAttribute('aria-busy', String(busy));
    form.querySelectorAll('[type="submit"]').forEach(button => {
      if (busy) button.dataset.originalText = button.textContent;
      button.disabled = busy;
      button.textContent = busy ? '처리 중…' : button.dataset.originalText || button.textContent;
    });
  };
  document.addEventListener('click', event => {
    document.querySelectorAll('.card-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.card-menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
  });
  const previousFocus = new WeakMap();
  const visible = new WeakMap();
  function updateDialog(modal) {
    const active = modal.classList.contains('active');
    modal.inert = !active;
    modal.setAttribute('aria-hidden', String(!active));
    if (visible.get(modal) === active) return;
    visible.set(modal, active);
    if (active) {
      previousFocus.set(modal, document.activeElement);
      modal.querySelectorAll('.form-notice').forEach(notice => { notice.hidden = true; });
      const body = modal.querySelector('.modal-body');
      if (body) body.scrollTop = 0;
      requestAnimationFrame(() => {
        if (!modal.classList.contains('active')) return;
        const target = [...modal.querySelectorAll('input:not([type="hidden"]), textarea, button, [tabindex="0"]')].find(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' && !el.disabled && !el.classList.contains('close-btn'));
        target?.focus({ preventScroll: true });
      });
    } else {
      const previous = previousFocus.get(modal);
      if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
    }
  }
  document.querySelectorAll('.modal-overlay').forEach((modal, index) => {
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const title = modal.querySelector('h2');
    if (title) { title.id ||= `dialog-title-${index}`; modal.setAttribute('aria-labelledby', title.id); }
    modal.querySelectorAll('.close-btn').forEach(button => button.setAttribute('aria-label', '대화상자 닫기'));
    updateDialog(modal);
    new MutationObserver(() => updateDialog(modal)).observe(modal, { attributes: true, attributeFilter: ['class'] });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal.id !== 'modal-login') {
        const close = modal.querySelector('.close-btn, [data-dialog-close]');
        if (close) { event.preventDefault(); event.stopPropagation(); close.click(); }
      }
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button, input, textarea, select, summary, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length && !el.disabled);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
    });
  });
})();
