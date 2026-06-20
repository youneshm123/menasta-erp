/* MENASTA — Alerts notification bell (cheques due + low stock) */
(function () {
  if (!localStorage.getItem('fm_token')) return;

  const fmt = n => (parseFloat(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const ymd = d => d ? String(d).slice(0, 10) : '';

  const s = document.createElement('style');
  s.textContent = `
#al-bell{position:fixed;top:10px;right:62px;z-index:3000;width:40px;height:40px;border:none;border-radius:50%;
  background:linear-gradient(135deg,#F59E0B,#EF4444);color:#fff;font-size:18px;cursor:pointer;display:none;
  align-items:center;justify-content:center;box-shadow:0 3px 14px rgba(239,68,68,.45);transition:transform .15s;}
#al-bell:hover{transform:scale(1.08);filter:brightness(1.08);}
#al-bell .al-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;background:#DC2626;color:#fff;
  border-radius:10px;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid #fff;}
#al-bell.has-alerts{animation:alPulse 1.8s infinite;}
@keyframes alPulse{0%,100%{box-shadow:0 3px 14px rgba(239,68,68,.45)}50%{box-shadow:0 3px 22px rgba(239,68,68,.9)}}
#al-panel{position:fixed;top:58px;right:14px;width:380px;max-width:94vw;max-height:74vh;background:#fff;border-radius:16px;
  box-shadow:0 24px 64px rgba(15,23,42,.24);z-index:2999;display:flex;flex-direction:column;overflow:hidden;border:1px solid #E2E8F0;
  transform:scale(.94) translateY(-12px);opacity:0;pointer-events:none;transition:transform .2s cubic-bezier(.34,1.56,.64,1),opacity .16s;}
#al-panel.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}
.al-hd{background:#0F172A;color:#fff;padding:13px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;}
.al-hd-title{flex:1;font-size:14px;font-weight:800;}
.al-hd-btn{background:none;border:none;color:rgba(255,255,255,.5);font-size:20px;cursor:pointer;line-height:1;}
.al-body{flex:1;overflow-y:auto;padding:10px 12px;background:#F8FAFC;}
.al-sec-t{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#64748B;margin:12px 4px 6px;}
.al-item{display:block;background:#fff;border:1px solid #E8EDF4;border-left:3px solid #CBD5E1;border-radius:9px;padding:9px 12px;margin-bottom:6px;
  text-decoration:none;color:#1E293B;transition:box-shadow .12s;}
.al-item:hover{box-shadow:0 3px 10px rgba(0,0,0,.08);}
.al-item .t{font-size:13px;font-weight:700;}
.al-item .d{font-size:11.5px;color:#64748B;margin-top:2px;}
.al-item.red{border-left-color:#DC2626;}
.al-item.orange{border-left-color:#F59E0B;}
.al-empty{text-align:center;color:#16A34A;font-size:13px;font-weight:600;padding:30px 10px;}
`;
  document.head.appendChild(s);

  const bell = document.createElement('button');
  bell.id = 'al-bell';
  bell.innerHTML = '🔔';
  document.body.appendChild(bell);

  const panel = document.createElement('div');
  panel.id = 'al-panel';
  panel.innerHTML = `<div class="al-hd"><span style="font-size:18px">🔔</span><div class="al-hd-title">Notifications</div><button class="al-hd-btn" id="al-close">×</button></div><div class="al-body" id="al-body"></div>`;
  document.body.appendChild(panel);

  let isOpen = false;
  bell.onclick = () => { isOpen = !isOpen; panel.classList.toggle('open', isOpen); };
  document.getElementById('al-close').onclick = () => { isOpen = false; panel.classList.remove('open'); };

  function render(data) {
    const body = document.getElementById('al-body');
    let html = '';

    if (data.cheques && data.cheques.length) {
      html += '<div class="al-sec-t">⏰ Chèques à régler</div>';
      html += data.cheques.map(c => {
        const out = c.type === 'cheque_out';
        const when = c.overdue ? ('⚠️ En retard de ' + Math.abs(c.days_left) + ' j')
                  : c.days_left === 0 ? "Échéance aujourd'hui"
                  : ('Dans ' + c.days_left + ' j');
        return `<a class="al-item ${c.overdue ? 'red' : 'orange'}" href="/bank">
          <div class="t">${out ? '💳 Chèque émis' : '✅ Chèque reçu'} — ${fmt(c.amount)} MAD</div>
          <div class="d">${c.beneficiary ? c.beneficiary + ' · ' : ''}${c.check_number ? 'N° ' + c.check_number + ' · ' : ''}échéance ${ymd(c.due_date)} · <strong>${when}</strong></div>
        </a>`;
      }).join('');
    }

    if (data.fuel_stock && data.fuel_stock.length) {
      html += '<div class="al-sec-t">⛽ Carburant en stock</div>';
      html += data.fuel_stock.map(c => {
        const cls = c.empty_soon ? 'red' : (c.low ? 'orange' : '');
        const icon = (c.fuel || '').toLowerCase().includes('essence') ? '🟢' : '🔵';
        let when = '';
        if (c.level <= 0) {
          when = '❌ <strong>Vide / rupture probable</strong>';
        } else if (c.hours_to_empty != null) {
          const h = c.hours_to_empty;
          const txt = h <= 48 ? ('≈ ' + h + ' h') : ('≈ ' + Math.round(h / 24) + ' j');
          when = (c.empty_soon ? '⚠️ <strong>Se vide dans ' + txt + '</strong>' : 'Autonomie ' + txt)
               + (c.daily_liters ? ' · ' + fmt(c.daily_liters) + ' L/j' : '');
        } else {
          when = 'Consommation inconnue (pas de ventes récentes)';
        }
        const fresh = c.as_of_date ? ('maj ' + ymd(c.as_of_date)) : 'aucune lecture';
        return `<a class="al-item ${cls}" href="/cuves">
          <div class="t">${icon} ${c.fuel} — <strong>${fmt(c.level)} L</strong></div>
          <div class="d">${when}<br>seuil bas ${fmt(c.seuil)} L · ${fresh}</div></a>`;
      }).join('');
    }

    if (data.stock_produits && data.stock_produits.length) {
      html += '<div class="al-sec-t">📦 Stock huile bas</div>';
      html += data.stock_produits.map(p => {
        const out = p.stock_qty <= 0;
        return `<a class="al-item ${out ? 'red' : 'orange'}" href="/app">
          <div class="t">${p.name}</div>
          <div class="d">Stock : <strong>${fmt(p.stock_qty)} ${p.unit || ''}</strong> (min ${fmt(p.stock_min)})${out ? ' · ❌ Rupture' : ''}</div></a>`;
      }).join('');
    }

    if (data.stock_tabac && data.stock_tabac.length) {
      html += '<div class="al-sec-t">🚬 Stock tabac bas</div>';
      html += data.stock_tabac.map(t => {
        const out = t.stock_actuel <= 0;
        return `<a class="al-item ${out ? 'red' : 'orange'}" href="/tabac">
          <div class="t">${t.name}</div>
          <div class="d">Stock : <strong>${fmt(t.stock_actuel)}</strong>${out ? ' · ❌ Rupture' : ''}</div></a>`;
      }).join('');
    }

    if (!html) html = '<div class="al-empty">✅ Tout est en ordre — aucune alerte.</div>';
    body.innerHTML = html;
  }

  async function load() {
    try {
      const res = await fetch('/api/alerts', { headers: { Authorization: 'Bearer ' + localStorage.getItem('fm_token') } });
      if (!res.ok) return; // 403 for limited roles → no bell
      const data = await res.json();
      bell.style.display = 'flex';
      const old = bell.querySelector('.al-badge');
      if (old) old.remove();
      if (data.count > 0) {
        bell.classList.add('has-alerts');
        const b = document.createElement('span');
        b.className = 'al-badge';
        b.textContent = data.count > 99 ? '99+' : data.count;
        bell.appendChild(b);
      } else {
        bell.classList.remove('has-alerts');
      }
      render(data);
    } catch (_) { /* silent */ }
  }

  load();
  setInterval(load, 5 * 60 * 1000); // refresh every 5 min
})();
