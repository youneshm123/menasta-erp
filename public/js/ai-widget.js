(function () {
  if (!localStorage.getItem('fm_token')) return;

  /* ── Styles ── */
  const s = document.createElement('style');
  s.textContent = `
#ai-fab{position:fixed;top:9px;right:14px;z-index:3000;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;border-radius:22px;padding:7px 16px 7px 12px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:7px;box-shadow:0 3px 12px rgba(37,99,235,.45);transition:all .15s;letter-spacing:.2px;}
#ai-fab:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 5px 18px rgba(37,99,235,.5);}
#ai-fab .ai-dot{width:7px;height:7px;background:#4ADE80;border-radius:50%;animation:aiPulse 2s infinite;}
@keyframes aiPulse{0%,100%{opacity:1}50%{opacity:.3}}
#ai-panel{position:fixed;top:52px;right:12px;width:370px;height:520px;background:#fff;border-radius:18px;box-shadow:0 24px 64px rgba(15,23,42,.22);z-index:2999;display:flex;flex-direction:column;overflow:hidden;border:1px solid #E2E8F0;transform:scale(.94) translateY(-12px);opacity:0;pointer-events:none;transition:transform .22s cubic-bezier(.34,1.56,.64,1),opacity .18s;}
#ai-panel.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}
.aiw-hd{background:#0F172A;color:#fff;padding:13px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;}
.aiw-hd-title{flex:1;font-size:13.5px;font-weight:800;letter-spacing:.3px;}
.aiw-hd-sub{font-size:10px;color:rgba(255,255,255,.4);font-weight:400;}
.aiw-hd-btn{background:none;border:none;color:rgba(255,255,255,.4);font-size:20px;cursor:pointer;padding:2px 6px;border-radius:5px;line-height:1;transition:all .1s;}
.aiw-hd-btn:hover{color:#fff;background:rgba(255,255,255,.1);}
.aiw-msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;background:#F8FAFC;}
.aiw-msgs::-webkit-scrollbar{width:4px}.aiw-msgs::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:4px}
.aiw-bubble{max-width:86%;padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.55;word-break:break-word;}
.aiw-bubble.user{align-self:flex-end;background:linear-gradient(135deg,#2563EB,#1D4ED8);color:#fff;border-bottom-right-radius:3px;}
.aiw-bubble.ai{align-self:flex-start;background:#fff;color:#1E293B;border:1px solid #E8EDF4;border-bottom-left-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.07);}
.aiw-bubble.ai a{color:#2563EB}.aiw-bubble.ai strong{font-weight:700}.aiw-bubble.ai em{font-style:italic}
.aiw-bubble.ai ul,.aiw-bubble.ai ol{padding-left:18px;margin:4px 0;}
.aiw-bubble.ai p{margin:3px 0;}
.aiw-bubble.err{align-self:flex-start;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-bottom-left-radius:3px;font-size:12.5px;}
.aiw-typing{align-self:flex-start;padding:10px 16px;background:#fff;border:1px solid #E8EDF4;border-radius:14px;border-bottom-left-radius:3px;}
.aiw-typing span{display:inline-block;width:6px;height:6px;background:#94A3B8;border-radius:50%;margin:0 2px;animation:aiBounce 1.2s infinite;}
.aiw-typing span:nth-child(2){animation-delay:.2s}.aiw-typing span:nth-child(3){animation-delay:.4s}
@keyframes aiBounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}
.aiw-ft{padding:10px 10px;border-top:1px solid #E8EDF4;display:flex;gap:7px;background:#fff;flex-shrink:0;align-items:center;}
.aiw-input{flex:1;padding:9px 13px;border:1.5px solid #CBD5E1;border-radius:12px;font-size:13px;font-family:inherit;outline:none;resize:none;line-height:1.4;max-height:80px;background:#F8FAFC;}
.aiw-input:focus{border-color:#2563EB;background:#fff;box-shadow:0 0 0 3px rgba(37,99,235,.1);}
.aiw-send{width:36px;height:36px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
.aiw-send:hover{background:#1D4ED8;}.aiw-send:disabled{background:#CBD5E1;cursor:default;}
`;
  document.head.appendChild(s);

  /* ── FAB button ── */
  const fab = document.createElement('button');
  fab.id = 'ai-fab';
  fab.innerHTML = '<span class="ai-dot"></span> MENASTA AI';
  fab.onclick = toggle;
  document.body.appendChild(fab);

  /* ── Panel ── */
  const panel = document.createElement('div');
  panel.id = 'ai-panel';
  panel.innerHTML = `
    <div class="aiw-hd">
      <span style="font-size:20px">🤖</span>
      <div style="flex:1"><div class="aiw-hd-title">MENASTA AI</div><div class="aiw-hd-sub">Assistant intelligent</div></div>
      <button class="aiw-hd-btn" onclick="window._aiToggle()">×</button>
    </div>
    <div class="aiw-msgs" id="aiw-msgs">
      <div class="aiw-bubble ai">👋 Bonjour ! Je suis <strong>MENASTA AI</strong>.<br>Posez-moi n'importe quelle question sur votre station.</div>
    </div>
    <div class="aiw-ft">
      <textarea class="aiw-input" id="aiw-input" placeholder="Votre message…" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){window._aiSend();event.preventDefault();}"></textarea>
      <button class="aiw-send" id="aiw-send" onclick="window._aiSend()">&#8593;</button>
    </div>`;
  document.body.appendChild(panel);

  /* ── Auto-resize textarea ── */
  document.getElementById('aiw-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  let isOpen = false;
  let chatHistory = [];
  let busy = false;

  function toggle() { isOpen ? close() : open(); }
  function open()  { isOpen = true;  panel.classList.add('open');    setTimeout(() => document.getElementById('aiw-input').focus(), 200); }
  function close() { isOpen = false; panel.classList.remove('open'); }
  window._aiToggle = toggle;

  function addErr(msgs, txt) {
    const eb = document.createElement('div');
    eb.className = 'aiw-bubble err';
    eb.textContent = txt;
    msgs.appendChild(eb);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function md(t) {
    return t
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/`(.+?)`/g,'<code>$1</code>')
      .replace(/^#+\s+(.+)$/gm,'<strong>$1</strong>')
      .replace(/\n/g,'<br>');
  }

  window._aiSend = async function () {
    if (busy) return;
    const input = document.getElementById('aiw-input');
    const msgs  = document.getElementById('aiw-msgs');
    const text  = input.value.trim();
    if (!text) return;
    input.value = ''; input.style.height = 'auto';

    /* user bubble */
    const ub = document.createElement('div');
    ub.className = 'aiw-bubble user'; ub.textContent = text;
    msgs.appendChild(ub);
    msgs.scrollTop = msgs.scrollHeight;

    /* typing indicator */
    const tp = document.createElement('div');
    tp.className = 'aiw-typing';
    tp.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(tp);
    msgs.scrollTop = msgs.scrollHeight;

    busy = true;
    document.getElementById('aiw-send').disabled = true;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('fm_token') },
        body: JSON.stringify({ message: text, history: chatHistory.slice(-10), language: 'fr' })
      });

      tp.remove();

      if (res.status === 401) {
        localStorage.clear();
        window.location.href = '/';
        return;
      }

      if (!res.ok) {
        let errMsg = 'Erreur serveur (' + res.status + ')';
        try { const j = await res.json(); errMsg = j.error || errMsg; } catch(_) {}
        addErr(msgs, '⚠️ ' + errMsg);
        return;
      }

      const ab = document.createElement('div'); ab.className = 'aiw-bubble ai';
      msgs.appendChild(ab);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', full = '', hasError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const p = JSON.parse(raw);
            if (p.text) {
              full += p.text;
              ab.innerHTML = md(full);
              msgs.scrollTop = msgs.scrollHeight;
            } else if (p.error) {
              hasError = true;
              ab.remove();
              addErr(msgs, '⚠️ ' + p.error);
            } else if (p.pdf) {
              window.open('/api/ai/pdf/' + p.pdf + '?token=' + localStorage.getItem('fm_token'), '_blank');
            }
          } catch (_) {}
        }
      }

      if (!hasError) {
        if (!full) {
          ab.remove();
          addErr(msgs, '⚠️ Aucune réponse reçue. Réessayez.');
        } else {
          chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: full });
          if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
        }
      }

      msgs.scrollTop = msgs.scrollHeight;

    } catch (e) {
      if (document.getElementById('aiw-msgs').contains(document.querySelector('.aiw-typing'))) {
        try { document.querySelector('.aiw-typing').remove(); } catch(_) {}
      }
      addErr(msgs, '⚠️ Connexion impossible. Vérifiez votre réseau.');
    } finally {
      busy = false;
      const sendBtn = document.getElementById('aiw-send');
      if (sendBtn) sendBtn.disabled = false;
      const inp = document.getElementById('aiw-input');
      if (inp) inp.focus();
    }
  };
})();
