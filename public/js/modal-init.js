/* MENASTA — SAP Fiori Modal Manager
   Advanced behaviors: Escape, Enter submit, focus, validation,
   loading states, shake on error, success flash, confirm dialogs
*/
(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     1. Keyboard navigation
  ───────────────────────────────────────────── */

  // Escape closes top-most open overlay
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const opens = document.querySelectorAll('.overlay.open');
    if (!opens.length) return;
    const top = opens[opens.length - 1];
    // Skip if a confirm dialog is on top — confirm uses its own close logic
    top.classList.remove('open');
  });

  // Enter submits when not in textarea/button
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
    const overlay = e.target.closest('.overlay.open');
    if (!overlay) return;
    const primary = overlay.querySelector('.modal-ft .btn-p, .modal-ft .btn-s');
    if (primary && !primary.disabled && !primary.classList.contains('loading')) {
      e.preventDefault();
      primary.click();
    }
  });

  /* ─────────────────────────────────────────────
     2. Auto-focus first input on open
  ───────────────────────────────────────────── */

  const focusFirstInput = (overlay) => {
    setTimeout(() => {
      const first = overlay.querySelector(
        'input:not([type="hidden"]):not([readonly]):not([disabled]),' +
        'select:not([disabled]),textarea:not([disabled])'
      );
      if (first) {
        first.focus();
        if (first.tagName === 'INPUT' && (first.type === 'text' || first.type === 'number')) {
          first.select();
        }
      }
    }, 250);
  };

  const observer = new MutationObserver(muts => {
    muts.forEach(m => {
      if (m.attributeName !== 'class') return;
      if (m.target.classList.contains('overlay') && m.target.classList.contains('open')) {
        focusFirstInput(m.target);
        // Reset any error state from previous open
        m.target.querySelectorAll('.fg.error').forEach(el => el.classList.remove('error'));
        m.target.querySelectorAll('.fg-error').forEach(el => el.remove());
        m.target.querySelectorAll('.modal-msg').forEach(el => {
          if (el.dataset.transient) el.remove();
        });
      }
    });
  });

  function observeOverlays() {
    document.querySelectorAll('.overlay').forEach(o => {
      observer.observe(o, { attributes: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeOverlays);
  } else {
    observeOverlays();
  }

  /* ─────────────────────────────────────────────
     3. Clear error state when user edits field
  ───────────────────────────────────────────── */

  document.addEventListener('input', e => {
    const fg = e.target.closest('.fg.error');
    if (fg) {
      fg.classList.remove('error');
      const err = fg.querySelector('.fg-error');
      if (err) err.remove();
    }
  });

  /* ─────────────────────────────────────────────
     4. Public API on window
  ───────────────────────────────────────────── */

  // Show inline field error
  window.fieldError = (fieldId, message) => {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const fg = input.closest('.fg');
    if (!fg) return;
    fg.classList.add('error');
    let err = fg.querySelector('.fg-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'fg-error';
      fg.appendChild(err);
    }
    err.textContent = message;
    input.focus();
  };

  // Clear field error
  window.clearFieldError = (fieldId) => {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const fg = input.closest('.fg');
    if (!fg) return;
    fg.classList.remove('error');
    const err = fg.querySelector('.fg-error');
    if (err) err.remove();
  };

  // Mark field as successfully validated
  window.fieldSuccess = (fieldId) => {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const fg = input.closest('.fg');
    if (!fg) return;
    fg.classList.add('success');
    fg.classList.remove('error');
    const err = fg.querySelector('.fg-error');
    if (err) err.remove();
    setTimeout(() => fg.classList.remove('success'), 1500);
  };

  // Button loading state
  window.btnLoading = (btn, isLoading = true) => {
    if (typeof btn === 'string') btn = document.querySelector(btn);
    if (!btn) return;
    if (isLoading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  };

  // Shake the modal (validation error)
  window.shakeModal = (overlayId) => {
    const overlay = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
    if (!overlay) return;
    const modal = overlay.querySelector('.modal');
    if (!modal) return;
    modal.classList.add('shake');
    setTimeout(() => modal.classList.remove('shake'), 400);
  };

  // Success flash animation
  window.flashModalSuccess = (overlayId) => {
    const overlay = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
    if (!overlay) return;
    const modal = overlay.querySelector('.modal');
    if (!modal) return;
    modal.classList.add('flash-success');
    setTimeout(() => modal.classList.remove('flash-success'), 600);
  };

  // Inline message inside modal body (auto-prepended)
  window.modalMessage = (overlayId, type = 'info', message = '', transient = true) => {
    const overlay = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
    if (!overlay) return;
    const body = overlay.querySelector('.modal-body');
    if (!body) return;
    // Remove existing transient
    body.querySelectorAll('.modal-msg[data-transient]').forEach(el => el.remove());
    const msg = document.createElement('div');
    msg.className = 'modal-msg ' + type;
    msg.textContent = message;
    if (transient) msg.dataset.transient = '1';
    body.insertBefore(msg, body.firstChild);
    body.scrollTop = 0;
  };

  /* ─────────────────────────────────────────────
     5. Confirm dialog (replaces window.confirm)
  ───────────────────────────────────────────── */

  window.fioriConfirm = (options) => {
    return new Promise((resolve) => {
      const opts = Object.assign({
        title: 'Confirmation',
        message: 'Êtes-vous sûr ?',
        sub: '',
        type: 'warn',         // warn | danger | info
        icon: null,           // override icon
        okText: 'Confirmer',
        cancelText: 'Annuler',
        okClass: 'btn-p',     // btn-p | btn-d | btn-s
      }, options || {});

      const id = 'fiori-confirm-' + Date.now();
      const iconMap = { warn: '⚠', danger: '🗑', info: 'ⓘ' };
      const icon = opts.icon || iconMap[opts.type] || '⚠';

      const html = `
        <div class="overlay open" id="${id}">
          <div class="modal confirm">
            <div class="modal-hd">
              <span>${icon}</span>
              <h3>${opts.title}</h3>
              <button class="x" data-act="cancel">×</button>
            </div>
            <div class="modal-body">
              <div class="confirm-icon ${opts.type}">${icon}</div>
              <div class="confirm-msg">${opts.message}</div>
              ${opts.sub ? `<div class="confirm-sub">${opts.sub}</div>` : ''}
            </div>
            <div class="modal-ft">
              <button class="btn btn-g" data-act="cancel">${opts.cancelText}</button>
              <button class="btn ${opts.okClass}" data-act="ok">${opts.okText}</button>
            </div>
          </div>
        </div>
      `;
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const overlay = wrap.firstElementChild;
      document.body.appendChild(overlay);
      observer.observe(overlay, { attributes: true });
      focusFirstInput(overlay);

      const cleanup = (result) => {
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 220);
        resolve(result);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay) cleanup(false);
        const btn = e.target.closest('[data-act]');
        if (btn) cleanup(btn.dataset.act === 'ok');
      });
      // Focus the OK button by default
      setTimeout(() => {
        const okBtn = overlay.querySelector('[data-act="ok"]');
        if (okBtn) okBtn.focus();
      }, 250);
    });
  };

  /* ─────────────────────────────────────────────
     6. Wrap async submit handlers for auto loading
  ───────────────────────────────────────────── */

  window.handleSubmit = async (btnSelector, asyncFn) => {
    const btn = typeof btnSelector === 'string'
      ? document.querySelector(btnSelector)
      : btnSelector;
    window.btnLoading(btn, true);
    try {
      const result = await asyncFn();
      window.btnLoading(btn, false);
      return result;
    } catch (e) {
      window.btnLoading(btn, false);
      throw e;
    }
  };
})();
