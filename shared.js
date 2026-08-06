function fmt(n, d) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => { t.className = 'toast'; }, 2800);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const NAV_ITEMS = [
  { key: 'production', href: '/production', icon: '✎', label: 'บันทึก' },
  { key: 'stock', href: '/stock', icon: '◎', label: 'สต็อก' },
  { key: 'import', href: '/import', icon: '▤', label: 'นำเข้า' },
  { key: 'settings', href: '/settings', icon: '⚙', label: 'ตั้งค่า' }
];

function renderNav(activeKey) {
  const navbar = document.getElementById('navbar');
  if (navbar) {
    navbar.innerHTML = NAV_ITEMS.map((item) => `
      <a href="${item.href}" class="${item.key === activeKey ? 'active' : ''}">
        <span class="icon">${item.icon}</span>${item.label}
      </a>
    `).join('');
  }
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    const labels = { production: 'บันทึกประจำวัน', stock: 'สต็อกคงเหลือ', import: 'นำเข้าวัสดุ', settings: 'ตั้งค่า' };
    sidebar.innerHTML = `
      <div class="brand">
        <p class="eyebrow">กันทรลักษ์ไทยนต์</p>
        <h1>แพล้นยาง</h1>
      </div>
      ${NAV_ITEMS.map((item) => `
        <a href="${item.href}" class="${item.key === activeKey ? 'active' : ''}">
          <span class="icon">${item.icon}</span>${labels[item.key]}
        </a>
      `).join('')}
    `;
  }
}

// ---------- Canvas-based image export (no external library) ----------
function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function buildReceiptCanvas(title, heroLabel, heroValue, sections, footer) {
  const W = 680, PAD = 40;
  const rowH = 38;
  const sectionPadTop = 16, sectionPadBottom = 14, sectionGap = 16, sectionHeaderH = 26;

  const heroBlockH = heroValue ? (88 + 22) : 6;
  let sectionsH = 0;
  sections.forEach((sec) => {
    sectionsH += sectionHeaderH + sectionPadTop + sec.rows.length * rowH + sectionPadBottom + sectionGap;
  });
  const H = 116 + heroBlockH + sectionsH + 70;

  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#FFC93C';
  ctx.fillRect(0, 0, W, 6);

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#A29C93';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('KANTHRALAK THAIYON  ·  ASPHALT PLANT', PAD, 32);

  ctx.fillStyle = '#1C1B19';
  ctx.font = '800 25px sans-serif';
  ctx.fillText(title, PAD, 52);

  ctx.fillStyle = '#6B6660';
  ctx.font = '500 13px sans-serif';
  ctx.fillText(new Date().toLocaleDateString('th-TH', { day: '2-digit', month: 'long', year: 'numeric' }), PAD, 84);

  let y = 116;

  if (heroValue) {
    drawRoundedRect(ctx, PAD, y, W - PAD * 2, 88, 18);
    ctx.fillStyle = '#FFF6DE';
    ctx.fill();
    ctx.fillStyle = '#C98A1F';
    ctx.font = '700 11px sans-serif';
    ctx.fillText(heroLabel.toUpperCase(), PAD + 22, y + 18);
    ctx.fillStyle = '#1C1B19';
    ctx.font = '800 42px sans-serif';
    ctx.fillText(heroValue, PAD + 22, y + 36);
    y += 88 + 22;
  } else {
    y += 6;
  }

  sections.forEach((sec) => {
    ctx.fillStyle = '#C98A1F';
    ctx.font = '700 11px sans-serif';
    ctx.fillText(sec.heading.toUpperCase(), PAD, y);
    y += sectionHeaderH;

    const boxH = sec.rows.length * rowH + sectionPadTop + sectionPadBottom;
    drawRoundedRect(ctx, PAD, y, W - PAD * 2, boxH, 14);
    ctx.fillStyle = '#FBF9F5';
    ctx.fill();

    let ry = y + sectionPadTop + 6;
    sec.rows.forEach(([k, v], i) => {
      ctx.fillStyle = '#6B6660';
      ctx.font = '500 14px sans-serif';
      ctx.fillText(k, PAD + 20, ry);
      ctx.fillStyle = '#1C1B19';
      ctx.font = '700 14px sans-serif';
      const vw = ctx.measureText(v).width;
      ctx.fillText(v, W - PAD - 20 - vw, ry);
      if (i < sec.rows.length - 1) {
        ctx.strokeStyle = 'rgba(28,27,25,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD + 20, ry + 26);
        ctx.lineTo(W - PAD - 20, ry + 26);
        ctx.stroke();
      }
      ry += rowH;
    });

    y += boxH + sectionGap;
  });

  y += 6;
  ctx.strokeStyle = 'rgba(28,27,25,0.1)';
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  y += 20;
  ctx.fillStyle = '#A29C93';
  ctx.font = '600 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(footer, W / 2, y);
  ctx.textAlign = 'left';

  return canvas;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function triggerDownload(canvas, filename) {
  const dataUrl = canvas.toDataURL('image/png');

  if (isIOS()) {
    // iOS Safari ไม่รองรับการดาวน์โหลดอัตโนมัติผ่าน <a download> กับ data URL
    // เปิดรูปเต็มจอแทน ให้ผู้ใช้กดค้างแล้วเลือก "บันทึกลงรูปภาพ" เอง
    const win = window.open();
    if (win) {
      win.document.write(
        '<html><head><title>' + filename + '</title></head>' +
        '<body style="margin:0;background:#1C1B19;display:flex;align-items:center;justify-content:center;min-height:100vh;">' +
        '<img src="' + dataUrl + '" style="max-width:100%;height:auto;display:block;">' +
        '</body></html>'
      );
      showToast('กดค้างที่รูปแล้วเลือก "บันทึกลงรูปภาพ"');
    } else {
      showToast('เปิดหน้าต่างไม่สำเร็จ ลองอนุญาต pop-up แล้วลองใหม่');
    }
    return;
  }

  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('ดาวน์โหลดรูปสรุปแล้ว');
}

// ---------- API helper ----------
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}
