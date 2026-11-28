/* Borsa Defteri — kişisel ABD borsası takibi (PWA).
 * Puanlar, hedefler ve takvim kendi yöntemimizdir; yatırım tavsiyesi değildir.
 * Mantık Google Sheets sürümüyle aynıdır (apps-script/, builders/analiz.py).
 */
'use strict';

// Her yayında artırın; sw.js'deki SURUM ('defter-vN') ile aynı numara olmalı.
const UYGULAMA_SURUM = { no: 11, tarih: '28.11.2026' };
// ORB taraması: bilgisayardaki orb_tarama.ps1 sonuçları bu Apps Script web uygulamasına gönderir; uygulama buradan okur.
const ORB_ADRES = 'https://script.google.com/macros/s/AKfycbws4zN12Rf-z-nSgukF_r9ng7J_OMvJ030WTArtojJMgU0DIkP6osCOyyYVZhre8MXIPQ/exec';

// ---------------------------------------------------------------- depolama
const ON = 'bd.';
const depo = {
  al(k, d) { try { const v = localStorage.getItem(ON + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  koy(k, v) { try { localStorage.setItem(ON + k, JSON.stringify(v)); return true; } catch { return false; } },
  sil(k) { try { localStorage.removeItem(ON + k); } catch { /* yok */ } }
};
const VARSAYILAN_AYAR = { agirlik: { Kalite: 25, 'Değer': 25, 'Büyüme': 25, Risk: 25 }, ustSinir: 30, fkKaynak: 'ttm',
  iskonto: 10, kalici: 3, yil: 10, hatirlatGun: 7, demo: false, tema: 'auto', senAgirlik: { kot: 20, baz: 60, iyi: 20 } };
function ayarlar() { const a = depo.al('ayar', {}); return { ...VARSAYILAN_AYAR, ...a, agirlik: { ...VARSAYILAN_AYAR.agirlik, ...(a.agirlik || {}) }, senAgirlik: { ...VARSAYILAN_AYAR.senAgirlik, ...(a.senAgirlik || {}) } }; }
function ayarKaydet(degisen) { const a = { ...ayarlar(), ...degisen }; depo.koy('ayar', a); return a; }
function anahtar() { return depo.al('anahtar', ''); }
function pozisyonlar() { return depo.al('poz', []); }
function pozKaydet(p) { depo.koy('poz', p); }

// ---------------------------------------------------------------- yardımcılar
const $ = (s, k = document) => k.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sayiMi = v => typeof v === 'number' && Number.isFinite(v);
const kod = t => String(t || '').trim().toUpperCase();
const nf = (d = 2) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v, d = 2) => sayiMi(v) ? (v < 0 ? '−$' : '$') + nf(d).format(Math.abs(v)) : '—';
const usdIsaretli = (v, d = 0) => sayiMi(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + nf(d).format(Math.abs(v)) : '—';
const yuzde = (v, d = 1, isaret = true) => sayiMi(v) ? (isaret && v > 0 ? '+' : v < 0 ? '−' : '') + '%' + nf(d).format(Math.abs(v * 100)) : '—';
const sayi = (v, d = 1) => sayiMi(v) ? (v < 0 ? '−' : '') + nf(d).format(Math.abs(v)) : '—';
const renk = v => sayiMi(v) ? (v > 0 ? 'arti' : v < 0 ? 'eksi' : '') : '';
const bugunStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function gunEkle(s, n) { const [y, m, g] = s.split('-').map(Number); const d = new Date(y, m - 1, g + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function kalanGun(s) { const [y, m, g] = s.split('-').map(Number); const [by, bm, bg] = bugunStr().split('-').map(Number); return Math.round((Date.UTC(y, m - 1, g) - Date.UTC(by, bm - 1, bg)) / 864e5); }
const tarihTR = s => { const [y, m, g] = String(s).split('-'); return `${g}.${m}.${y}`; };
const SAAT = { bmo: 'Açılış öncesi', amc: 'Kapanış sonrası', dmh: 'Seans içi' };

function bildir(m) {
  const b = $('#bildirim'); b.textContent = m; b.hidden = false;
  clearTimeout(bildir.z); bildir.z = setTimeout(() => { b.hidden = true; }, 3200);
}

// ---------------------------------------------------------------- Finnhub
const SURE = { quote: 60e3, metric: 6 * 36e5, profile: 24 * 36e5, earnings: 6 * 36e5, calendar: 6 * 36e5, insider: 6 * 36e5 };
const bellek = new Map();
let kuyruk = Promise.resolve();
let sonIstek = 0;

function onbellekAl(k) {
  const m = bellek.get(k); if (m && m.son > Date.now()) return m.v;
  const d = depo.al('c:' + k, null); if (d && d.son > Date.now()) { bellek.set(k, d); return d.v; }
  return undefined;
}
function onbellekKoy(k, v, ms) {
  const kayit = { v, son: Date.now() + ms }; bellek.set(k, kayit);
  if (ms > 60e3) { if (!depo.koy('c:' + k, kayit)) onbellekBudama(true), depo.koy('c:' + k, kayit); }
}
function onbellekBudama(hepsi = false) {
  try {
    const sil = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith(ON + 'c:')) continue;
      if (hepsi) { sil.push(k); continue; }
      try { if (!(JSON.parse(localStorage.getItem(k)).son > Date.now())) sil.push(k); } catch { sil.push(k); }
    }
    sil.forEach(k => localStorage.removeItem(k));
  } catch { /* depolama yok */ }
}

/** Finnhub isteği: önbellekli, sıralı (dakikada ~60 sınırına saygı), örnek veri modunu destekler. */
function fh(yol, param, sure, yenile = false) {
  const qs = new URLSearchParams(Object.keys(param).sort().map(k => [k, param[k]])).toString();
  const ck = (ayarlar().demo ? 'demo:' : '') + yol + '?' + qs;
  if (!yenile) { const c = onbellekAl(ck); if (c !== undefined) return Promise.resolve(c); }
  if (ayarlar().demo) { const v = ornekVeri(yol, param); onbellekKoy(ck, v, sure); return Promise.resolve(v); }
  const key = anahtar();
  if (!key) return Promise.reject(new Error('ANAHTAR'));
  const is = kuyruk.then(async () => {
    const bekle = 1100 - (Date.now() - sonIstek); if (bekle > 0) await new Promise(r => setTimeout(r, bekle));
    sonIstek = Date.now();
    let r;
    try { r = await fetch(`https://finnhub.io/api/v1${yol}?${qs}&token=${encodeURIComponent(key)}`); }
    catch { throw new Error('Finnhub\'a ulaşılamadı (bağlantı ya da dakikalık sınır). Biraz sonra ↻ ile yenileyin.'); }
    if (r.status === 429) throw new Error('Finnhub dakikalık sınır aşıldı; 1 dakika sonra yenileyin.');
    if (r.status === 401 || r.status === 403) throw new Error(yol.includes('congress') ? 'Ücretli uç nokta.' : 'Finnhub anahtarı geçersiz ya da bu veri ücretli (HTTP ' + r.status + ').');
    if (!r.ok) throw new Error('Finnhub hatası: HTTP ' + r.status);
    const v = await r.json(); onbellekKoy(ck, v, sure); return v;
  });
  kuyruk = is.catch(() => {});
  return is;
}

const api = {
  fiyat: (t, y) => fh('/quote', { symbol: t }, SURE.quote, y),
  metrik: (t, y) => fh('/stock/metric', { symbol: t, metric: 'all' }, SURE.metric, y).then(r => (r && r.metric) ? { ...r.metric, _seri: r.series || {} } : {}),
  profil: (t, y) => fh('/stock/profile2', { symbol: t }, SURE.profile, y),
  kazanc: (t, y) => fh('/stock/earnings', { symbol: t }, SURE.earnings, y),
  takvim: (t, y) => fh('/calendar/earnings', { symbol: t, from: bugunStr(), to: gunEkle(bugunStr(), 90) }, SURE.calendar, y)
    .then(r => ((r && r.earningsCalendar) || []).filter(e => e.date && e.date >= bugunStr()).sort((a, b) => a.date.localeCompare(b.date))[0] || null),
  insider: (t, y) => fh('/stock/insider-transactions', { symbol: t, from: gunEkle(bugunStr(), -90) }, SURE.insider, y).then(insiderOzet)
};

/** Yalnızca açık piyasa işlemleri: Form 4 kodu P (alım) ve S (satış). Ödül, opsiyon kullanımı, vergi stopajı hariç. */
function insiderOzet(r) {
  const from = gunEkle(bugunStr(), -90);
  const o = { alim: 0, satis: 0, alimUsd: 0, satisUsd: 0, alanlar: new Set(), sonAlim: '', islemler: [] };
  ((r && r.data) || []).forEach(x => {
    if (x.isDerivative) return;
    const tarih = x.transactionDate || x.filingDate || ''; if (tarih < from) return;
    const deger = Math.abs(Number(x.change) || 0) * (Number(x.transactionPrice) || 0);
    if (x.transactionCode === 'P') { o.alim++; o.alimUsd += deger; o.alanlar.add(x.name); if (tarih > o.sonAlim) o.sonAlim = tarih; }
    else if (x.transactionCode === 'S') { o.satis++; o.satisUsd += deger; }
    else return;
    o.islemler.push({ ad: x.name, tarih, kod: x.transactionCode, adet: Number(x.change) || 0, fiyat: Number(x.transactionPrice) || 0, deger });
  });
  o.alanSayisi = o.alanlar.size; o.net = o.alimUsd - o.satisUsd; o.kume = o.alanSayisi >= 2;
  o.islemler.sort((a, b) => b.tarih.localeCompare(a.tarih));
  return o;
}

// ---------------------------------------------------------------- puanlama (kendi yöntemimiz)
const ilk = (m, anahtarlar) => { for (const k of anahtarlar) if (sayiMi(m[k])) return m[k]; return null; };
const METRIKLER = [
  ['Kalite', 'ROE (%)', m => ilk(m, ['roeTTM', 'roeRfy']), 5, 30, 'Hayır'],
  ['Kalite', 'ROA (%)', m => ilk(m, ['roaTTM', 'roaRfy']), 2, 15, 'Hayır'],
  ['Kalite', 'Brüt marj (%)', m => ilk(m, ['grossMarginTTM', 'grossMarginAnnual']), 20, 65, 'Hayır'],
  ['Kalite', 'Net marj (%)', m => ilk(m, ['netProfitMarginTTM', 'netProfitMarginAnnual']), 0, 25, 'Hayır'],
  ['Kalite', 'ROIC (%)', (m, x) => x.t && sayiMi(x.t.roic) ? x.t.roic * 100 : null, 9, 25, 'Hayır'],
  ['Kalite', 'Nakit dönüşümü (FCF / net kâr)', (m, x) => x.t ? x.t.nakitDon : null, 0.5, 0.9, 'Hayır'],
  ['Kalite', 'Borç / özkaynak', m => ilk(m, ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual']), 2, 0, 'Hayır'],
  ['Kalite', 'Cari oran', m => ilk(m, ['currentRatioQuarterly', 'currentRatioAnnual']), 0.8, 2.5, 'Hayır'],
  // Net kâr faaliyet kârını belirgin aşıyorsa (faaliyet dışı kazanç) F/K, faaliyet kârına dayalı düzeltilmiş F/K ile puanlanır.
  ['Değer', 'F/K', (m, x) => x.t && x.t.fkDuzeltildi ? x.t.duzFk : ilk(m, ['peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peInclExtraTTM']), 45, 12, 'Evet'],
  ['Değer', 'Fiyat / satış', m => ilk(m, ['psTTM', 'psAnnual']), 12, 1.5, 'Evet'],
  ['Değer', 'PD/DD', m => ilk(m, ['pbQuarterly', 'pbAnnual']), 12, 1.5, 'Evet'],
  ['Değer', 'Fiyat / FCF', m => ilk(m, ['pfcfShareTTM', 'pfcfShareAnnual']), 50, 12, 'Evet'],
  ['Değer', 'Temettü verimi (%)', m => ilk(m, ['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual']), 0, 4, 'Hariç'],
  ['Büyüme', 'Gelir büyümesi 3Y (%)', m => ilk(m, ['revenueGrowth3Y']), 0, 25, 'Hayır'],
  ['Büyüme', 'Gelir büyümesi yıllık (%)', m => ilk(m, ['revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy']), 0, 30, 'Hayır'],
  ['Büyüme', 'EPS büyümesi 3Y (%)', m => ilk(m, ['epsGrowth3Y']), 0, 25, 'Hayır'],
  ['Büyüme', 'EPS büyümesi yıllık (%)', m => ilk(m, ['epsGrowthTTMYoy', 'epsGrowthQuarterlyYoy']), 0, 30, 'Hayır'],
  ['Risk', 'Beta', m => ilk(m, ['beta']), 2, 0.8, 'Hayır'],
  ['Risk', '52H zirveye yakınlık', (m, x) => sayiMi(x.fiyat) && sayiMi(m['52WeekHigh']) && m['52WeekHigh'] > 0 ? x.fiyat / m['52WeekHigh'] : null, 0.6, 1, 'Hayır'],
  ['Risk', 'Net borç / FAVÖK', (m, x) => x.t ? x.t.ndFavok : null, 4, 1, 'Hayır'],
  ['Risk', 'Faiz karşılama oranı', m => ilk(m, ['netInterestCoverageTTM', 'netInterestCoverageAnnual']), 2, 5, 'Hayır'],
  ['Risk', 'Pozitif kâr sürprizi oranı', (m, x) => { const s = (x.kazanc || []).slice(0, 4).map(r => r.surprisePercent).filter(sayiMi); return s.length ? s.filter(v => v > 0).length / s.length : null; }, 0.25, 1, 'Hayır']
];
const BOYUTLAR = ['Kalite', 'Değer', 'Büyüme', 'Risk'];

function puanla(m, ek, agirlik) {
  const satirlar = METRIKLER.map(([boyut, ad, f, kotu, iyi, negatif]) => {
    const v = f(m, ek); let p = null;
    if (sayiMi(v)) {
      if (negatif === 'Hariç' && v <= 0) p = null;
      else if (negatif === 'Evet' && v <= 0) p = 0;
      else p = Math.round(Math.max(0, Math.min(100, (v - kotu) / (iyi - kotu) * 100)));
    }
    return { boyut, ad, v, kotu, iyi, p };
  });
  const boyut = {};
  BOYUTLAR.forEach(b => { const ps = satirlar.filter(s => s.boyut === b && s.p !== null).map(s => s.p); boyut[b] = ps.length ? Math.round(ps.reduce((a, c) => a + c, 0) / ps.length) : null; });
  let pay = 0, payda = 0;
  BOYUTLAR.forEach(b => { if (boyut[b] !== null) { pay += boyut[b] * (agirlik[b] || 0); payda += agirlik[b] || 0; } });
  return { satirlar, boyut, bilesik: payda ? Math.round(pay / payda) : null };
}
const yorum = p => p === null ? 'Veri yok' : p >= 70 ? 'Güçlü' : p >= 40 ? 'Orta' : 'Zayıf';

/** Senaryolu hedef: EPS × (1 + büyüme) × F/K. Baz büyüme = MIN(EPS 3Y, gelir 3Y), üst sınır ayarlardan. */
function senaryolar(m, fiyat, a) {
  const eps = ilk(m, ['epsTTM', 'epsExclExtraItemsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM']);
  const fkTtm = ilk(m, ['peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peInclExtraTTM']);
  const fkIleri = ilk(m, ['forwardPE']);
  const g3 = [m.epsGrowth3Y, m.revenueGrowth3Y].filter(sayiMi);
  const gHam = g3.length ? Math.min(...g3) / 100 : null;
  const gKaynak = sayiMi(m.epsGrowth3Y) && sayiMi(m.revenueGrowth3Y) ? (m.epsGrowth3Y <= m.revenueGrowth3Y ? 'EPS 3Y (gelirden düşük)' : 'gelir 3Y (EPS\'ten düşük)')
    : sayiMi(m.revenueGrowth3Y) ? 'yalnızca gelir 3Y — EPS 3Y verisi yok' : sayiMi(m.epsGrowth3Y) ? 'yalnızca EPS 3Y — gelir 3Y verisi yok' : 'büyüme verisi yok — %0 varsayıldı';
  const g = sayiMi(gHam) ? Math.max(-0.3, Math.min(a.ustSinir / 100, gHam)) : 0;
  const fk = a.fkKaynak === 'ileri' && sayiMi(fkIleri) && fkIleri > 0 ? fkIleri : fkTtm;
  const satir = (ad, b, carpan) => {
    const hEps = sayiMi(eps) && eps > 0 ? eps * (1 + b) : null;
    const hFk = sayiMi(fk) && fk > 0 ? fk * carpan : null;
    const hedef = hEps !== null && hFk !== null ? hEps * hFk : null;
    return { ad, b, fk: hFk, eps: hEps, hedef, pot: hedef !== null && sayiMi(fiyat) ? hedef / fiyat - 1 : null };
  };
  const satirlar = [satir('🐻 Kötümser', g - 0.1, 0.75), satir('⚖️ Baz', g, 1), satir('🐂 İyimser', g + 0.1, 1.2)];
  // Beklenen değer: senaryoların ağırlıklı ortalaması (ağırlıklar Ayarlar'dan; varsayılan 20/60/20).
  const w = [a.senAgirlik.kot, a.senAgirlik.baz, a.senAgirlik.iyi].map(Number);
  const wt = w.reduce((x, y) => x + (y > 0 ? y : 0), 0);
  const beklenen = satirlar.every(s => s.hedef !== null) && wt > 0 ? satirlar.reduce((x, s, i) => x + s.hedef * Math.max(0, w[i]), 0) / wt : null;
  return { eps, fkTtm, fkIleri, gHam, g, gKaynak, fk, satirlar, beklenen, beklenenPot: beklenen !== null && sayiMi(fiyat) ? beklenen / fiyat - 1 : null };
}

/**
 * Basit DCF ile hisse başı değer (kendi yöntemimiz): FCF, `yil` boyunca
 * MIN(gelir 3Y, üst sınır) hızında büyür, sonra kalıcı büyüme. Firma değerinden
 * net borç (EV − piyasa değeri) düşülür, hisse başına çevrilir.
 */
function basitDcf(m, fiyat, ev, pd, fcf, a) {
  if (!sayiMi(fcf) || !(fcf > 0) || !(pd > 0) || !sayiMi(fiyat) || !(a.iskonto > a.kalici)) return null;
  const gr = sayiMi(m.revenueGrowth3Y) ? m.revenueGrowth3Y / 100 : 0;
  const g = Math.max(-0.1, Math.min(a.ustSinir / 100, gr));
  const firma = dcfDeger(fcf, g, a.iskonto / 100, a.kalici / 100, a.yil);
  const ozkaynak = firma - ((ev ?? pd) - pd);
  return { g, hisseBasi: ozkaynak / pd * fiyat };
}

/**
 * Veri kontrolü (kendi kurallarımız): Finnhub verisi kendi içinde çelişiyorsa nedenleri döndürür.
 * F/K 3'ün altında · FCF piyasa değerinden büyük · DCF değeri fiyatın 10 katından fazla.
 */
function veriKontrol(fkTtm, pd, fcf, dcf, fiyat) {
  const n = [];
  if (sayiMi(fkTtm) && fkTtm > 0 && fkTtm < 3) n.push('F/K 3\'ün altında (' + sayi(fkTtm) + ')');
  if (sayiMi(fcf) && sayiMi(pd) && pd > 0 && fcf > pd) n.push('serbest nakit akışı piyasa değerinden büyük');
  if (dcf && sayiMi(dcf.hisseBasi) && sayiMi(fiyat) && fiyat > 0 && dcf.hisseBasi > 10 * fiyat) n.push('nakit akışına dayalı değer fiyatın 10 katından fazla');
  return n;
}

/** Tutarlılık: F/K'ya dayalı baz hedef ile nakit akışına dayalı değer ne kadar uyuşuyor? */
function tutarlilik(baz, dcf) {
  if (!sayiMi(baz) || !dcf || !sayiMi(dcf.hisseBasi)) return { seviye: 'Belirsiz', sinif: '', aciklama: 'İki yöntemi karşılaştırmak için yeterli veri yok (FCF negatif ya da F/K yok).' };
  if (dcf.hisseBasi <= 0) return { seviye: 'Düşük', sinif: 'kirmizi', oran: null, aciklama: 'Nakit akışına dayalı değer sıfırın altında; F/K hedefi tek başına yanıltıcı olabilir.' };
  // Kat farkı (yön bağımsız): 1,5 kata kadar yüksek, 2,5 kata kadar orta, üstü düşük tutarlılık.
  const oran = baz / dcf.hisseBasi;
  const kat = oran >= 1 ? oran : 1 / oran;
  const yon = 'F/K hedefi (' + usd(baz) + '), nakit akışına dayalı değerin (' + usd(dcf.hisseBasi) + ') ' + nf(1).format(kat) + ' katı ' + (oran >= 1 ? 'üstünde' : 'altında');
  if (kat <= 1.5) return { seviye: 'Yüksek', sinif: 'yesil', oran, aciklama: 'İki yöntem birbirine yakın: ' + yon + '.' };
  if (kat <= 2.5) return { seviye: 'Orta', sinif: 'sari', oran, aciklama: 'Yöntemler kısmen ayrışıyor: ' + yon + '.' };
  return { seviye: 'Düşük', sinif: 'kirmizi', oran, aciklama: 'Yöntemler çok ayrışıyor: ' + yon + '. Hedefleri temkinli okuyun.' };
}

// ---------------------------------------------------------------- eleme akışı ve kırmızı bayraklar (kendi uyarlamamız)
// Kaynak: temel analiz rehberindeki 8 adımlı eleme akışı ve 14 kırmızı bayrak. Eşikler başlangıç noktasıdır, kural değil.
const SERMAYE_MALIYETI = 0.09;
const FINANS_SEKTORU = /bank|insurance|sigorta/i;

/** Finnhub yıllık serisi, yeniden eskiye. Oranlar kesir olarak döner (yüzde gelirse çevrilir). */
function seri(m, ad, oran = true, esik = 1.5) {
  const s = (((m && m._seri) || {}).annual || {})[ad];
  if (!Array.isArray(s)) return [];
  const v = s.filter(x => x && sayiMi(x.v)).sort((a, b) => String(b.period).localeCompare(String(a.period))).map(x => x.v);
  // Birim tespiti yalnız son 5 yıla ve çoğunluğa göre: eski uç değerler (ör. TSLA'nın ilk yıllarındaki −%200 marj) tüm seriyi 100'e böldürmesin.
  const son = v.slice(0, 5);
  return oran && son.length && son.filter(x => Math.abs(x) > esik).length * 2 > son.length ? v.map(x => x / 100) : v;
}

/** Ham Finnhub verisinden rehberin istediği büyüklükleri türetir (milyar $). */
function turet(m, fiyat, ev, pd, fcf, sektor) {
  const t = { finans: FINANS_SEKTORU.test(sektor || '') };
  const ps = ilk(m, ['psTTM', 'psAnnual']);
  t.gelir = pd > 0 && ps > 0 ? pd / ps : null;
  const opm = ilk(m, ['operatingMarginTTM', 'operatingMarginAnnual']);
  const npm = ilk(m, ['netProfitMarginTTM', 'netProfitMarginAnnual']);
  const pe = ilk(m, ['peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peInclExtraTTM']);
  t.faaliyet = t.gelir !== null && sayiMi(opm) ? t.gelir * opm / 100 : null;
  t.netKar = t.gelir !== null && sayiMi(npm) ? t.gelir * npm / 100 : pd > 0 && pe > 0 ? pd / pe : null;
  // Düzeltilmiş F/K: piyasa değeri / (faaliyet kârı × (1 − %21 vergi)). Faaliyet dışı kazançları (ör. özel şirket payı değerlemesi) ayıklar.
  t.duzFk = t.faaliyet > 0 && pd > 0 ? pd / (t.faaliyet * 0.79) : null;
  t.nkOrani = t.faaliyet > 0 && sayiMi(t.netKar) ? t.netKar / t.faaliyet : null;
  t.fkDuzeltildi = sayiMi(t.nkOrani) && t.nkOrani > 1.2 && sayiMi(t.duzFk);
  t.nakitDon = sayiMi(fcf) && t.netKar > 0 ? fcf / t.netKar : null;
  const evE = ilk(m, ['evEbitdaTTM']);
  t.favok = ev !== null && sayiMi(evE) && evE > 0 ? ev / evE : null;
  t.netBorc = ev !== null && pd !== null ? ev - pd : null;
  t.ndFavok = t.favok > 0 && sayiMi(t.netBorc) ? t.netBorc / t.favok : null;
  t.kapsama = ilk(m, ['netInterestCoverageTTM', 'netInterestCoverageAnnual']);
  // Kriz senaryosu: FAVÖK yarıya iner, amortisman aynı kalır → faaliyet kârı = faaliyet − FAVÖK/2; faiz gideri aynı.
  const faiz = sayiMi(t.kapsama) && t.kapsama > 0 && t.faaliyet > 0 ? t.faaliyet / t.kapsama : null;
  t.krizKapsama = faiz && t.favok > 0 ? (t.faaliyet - t.favok / 2) / faiz : null;
  t.krizNd = t.favok > 0 && sayiMi(t.netBorc) ? t.netBorc / (t.favok / 2) : null;
  // Hisse sayısının 5 yıllık yıllık değişimi ≈ (1 + gelir büyümesi) / (1 + hisse başı gelir büyümesi) − 1.
  const rg = m.revenueGrowth5Y, rs = m.revenueShareGrowth5Y;
  t.sulanma = sayiMi(rg) && sayiMi(rs) && rs > -100 ? (1 + rg / 100) / (1 + rs / 100) - 1 : null;
  const dy = ilk(m, ['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual']);
  t.temettuFcf = sayiMi(dy) && dy > 0 && pd > 0 ? (sayiMi(fcf) && fcf > 0 ? dy / 100 * pd / fcf : Infinity) : null;
  const roicS = seri(m, 'roic', true, 3);
  t.roicSeri = roicS.length ? roicS : seri(m, 'roicTTM', true, 3);
  t.roic = t.roicSeri.length ? t.roicSeri[0] : sayiMi(m.roiTTM) ? m.roiTTM / 100 : null;
  t.omSeri = seri(m, 'operatingMargin');
  return t;
}

const DURUM = { gecti: ['✅', 'yesil', 'Geçti'], dikkat: ['⚠️', 'sari', 'Dikkat'], elendi: ['⛔', 'kirmizi', 'Elendi'], yok: ['—', '', 'Veri yok'], elle: ['✍️', '', 'Elle'] };

/** 8 adımlı eleme akışı. Her adım: { ad, durum, deger, not }. */
function elemeAkisi(m, t, sen, rd) {
  const a = [];
  const ek = (ad, durum, deger, not) => a.push({ ad, durum, deger, not });
  const finansNotu = 'Banka ve sigortada FCF, ROIC ve FAVÖK anlamlı değil; sektör ölçütlerine (NIM, takipteki kredi, birleşik rasyo) bakın.';

  // 1) Gelir ve büyüme
  const g5 = sayiMi(m.revenueGrowth5Y) ? m.revenueGrowth5Y / 100 : null, g3 = sayiMi(m.revenueGrowth3Y) ? m.revenueGrowth3Y / 100 : null;
  const g = g5 ?? g3;
  if (g === null) ek('Gelir büyümesi', 'yok', '—', '');
  else ek('Gelir büyümesi', g < 0 ? 'elendi' : 'gecti', (g5 !== null ? '5Y' : '3Y') + ' yıllık ' + yuzde(g),
    g < 0 ? 'Gelir yıllardır küçülüyor. Bilinçli portföy temizliği değilse elenir.' : 'Organik büyüme ile satın alma/kur etkisini 10-K\'dan ayırın.');

  // 2) Marj trendi
  const om = t.omSeri;
  if (om.length >= 2) {
    let dusus = 0; for (let i = 0; i + 1 < om.length && om[i] < om[i + 1]; i++) dusus++;
    const k = Math.min(3, om.length - 1), fark = om[0] - om[k];
    const durum = dusus >= 3 && (g3 ?? g ?? 0) > 0 ? 'elendi' : fark < -0.02 ? 'dikkat' : 'gecti';
    ek('Faaliyet marjı trendi', durum, yuzde(om[0], 1, false) + ' (' + k + ' yıl önce ' + yuzde(om[k], 1, false) + ')',
      durum === 'elendi' ? 'Gelir artarken marj ' + dusus + ' yıldır düşüyor: büyüme "satın alınmış" olabilir. Yönetimin açıklaması yoksa elenir.'
        : durum === 'dikkat' ? 'Marj ' + k + ' yılda ' + nf(1).format(-fark * 100) + ' puan geriledi.' : 'Marj korunuyor ya da artıyor.');
  } else {
    const ttm = m.operatingMarginTTM, o5 = m.operatingMargin5Y;
    if (sayiMi(ttm) && sayiMi(o5)) ek('Faaliyet marjı trendi', ttm < o5 - 2 ? 'dikkat' : 'gecti', '%' + nf(1).format(ttm) + ' (5Y ort. %' + nf(1).format(o5) + ')', 'Yıllık seri yok; son 12 ay 5 yıllık ortalamayla karşılaştırıldı.');
    else ek('Faaliyet marjı trendi', 'yok', '—', '');
  }

  // 3) Serbest nakit akışı
  if (t.finans) ek('Nakit dönüşümü (FCF / net kâr)', 'yok', '—', finansNotu);
  else {
    const fm = seri(m, 'fcfMargin'), nm = seri(m, 'netMargin');
    const yillik = fm.slice(0, 3).map((f, i) => nm[i] > 0 ? f / nm[i] : null).filter(sayiMi);
    const ucYilDusuk = yillik.length === 3 && yillik.every(v => v < 0.5);
    const hizliBuyume = (g3 ?? 0) > 0.25;
    if (!(t.netKar > 0)) ek('Nakit dönüşümü (FCF / net kâr)', 'dikkat', 'net kâr negatif', 'Kâr yokken dönüşüm hesaplanmaz; erken aşama bir büyüme şirketi mi, bakın.');
    else if (!sayiMi(t.nakitDon)) ek('Nakit dönüşümü (FCF / net kâr)', 'yok', '—', '');
    else {
      const durum = ucYilDusuk && t.nakitDon < 0.5 && !hizliBuyume ? 'elendi' : t.nakitDon < 0.6 || ucYilDusuk ? 'dikkat' : 'gecti';
      ek('Nakit dönüşümü (FCF / net kâr)', durum, yuzde(t.nakitDon, 0, false) + (yillik.length ? ' · yıllık ' + yillik.map(v => yuzde(v, 0, false)).join(', ') : ''),
        durum === 'elendi' ? '3 yıldır %50\'nin altında: kâr nakde dönmüyor.' : durum === 'dikkat' ? 'Sağlıklı aralık ~%80–110. Düşüklüğün nedeni genelde işletme sermayesi (alacak, stok).'
          : t.nakitDon > 1.5 ? 'Nakit kârın çok üstünde: kâr geçici olarak düşük olabilir ya da borçlar ertelenmiş olabilir; bir çeyrekte borç artışıyla şişen FCF kalıcı değildir.' : 'Kâr nakde dönüyor (sağlıklı aralık ~%80–110).');
    }
  }

  // 4) ROIC
  if (t.finans) ek('ROIC', 'yok', '—', finansNotu);
  else if (!sayiMi(t.roic)) ek('ROIC', 'yok', '—', '');
  else {
    const s = t.roicSeri.slice(0, 3), yillarca = s.length === 3 && s.every(v => v < SERMAYE_MALIYETI);
    const durum = yillarca ? 'elendi' : t.roic < SERMAYE_MALIYETI ? 'dikkat' : 'gecti';
    ek('ROIC', durum, yuzde(t.roic, 1, false) + (s.length > 1 ? ' · önceki ' + s.slice(1).map(v => yuzde(v, 0, false)).join(', ') : '') + (t.roicSeri.length ? '' : ' (ROI)'),
      durum === 'elendi' ? 'Yıllardır sermaye maliyetinin (%9) altında: büyüdükçe değer yok ediyor.' : durum === 'dikkat' ? 'Sermaye maliyetinin (%9 varsayım) altında.' : 'Sermaye maliyetinin (%9 varsayım) üstünde.');
  }

  // 5) Borç ve faiz yükü
  if (t.finans) ek('Net borç ve faiz yükü', 'yok', '—', finansNotu);
  else if (!sayiMi(t.ndFavok) && !sayiMi(t.kapsama)) ek('Net borç ve faiz yükü', 'yok', '—', '');
  else {
    const netNakit = sayiMi(t.netBorc) && t.netBorc <= 0;
    const durum = !netNakit && sayiMi(t.krizKapsama) && t.krizKapsama < 2 ? 'elendi'
      : !netNakit && ((sayiMi(t.ndFavok) && t.ndFavok > 3) || (sayiMi(t.kapsama) && t.kapsama > 0 && t.kapsama < 5)) ? 'dikkat' : 'gecti';
    const parca = [netNakit ? 'net nakit' : 'net borç/FAVÖK ' + sayi(t.ndFavok) + 'x'];
    if (sayiMi(t.kapsama) && t.kapsama > 0) parca.push('faiz karşılama ' + sayi(t.kapsama) + 'x');
    if (!netNakit && (sayiMi(t.krizNd) || sayiMi(t.krizKapsama))) parca.push('kriz: ' + [sayiMi(t.krizNd) ? sayi(t.krizNd) + 'x borç' : '', sayiMi(t.krizKapsama) ? (t.krizKapsama < 0 ? 'faaliyet zararı' : sayi(t.krizKapsama) + 'x karşılama') : ''].filter(Boolean).join(', '));
    ek('Net borç ve faiz yükü', durum, parca.join(' · '),
      durum === 'elendi' ? 'FAVÖK yarıya inerse faiz karşılama 2x\'in altına düşüyor.' : durum === 'dikkat' ? 'Net borç/FAVÖK 3x\'e kadar rahat, 3–4x izlenmeli, 4x üstü kırılgan; faiz karşılama 5x\'in altı zayıf. Döngüsel şirkette zirve FAVÖK\'e güvenmeyin.' : 'Bilanço rahat (kriz senaryosu: FAVÖK −%50).');
  }

  // 6) Seyrelme
  if (!sayiMi(t.sulanma)) ek('Hisse sayısı (seyrelme)', 'yok', '—', 'Hisse bazlı ödemeyi (SBC) 10-K\'dan kontrol edin.');
  else ek('Hisse sayısı (seyrelme)', t.sulanma > 0.03 ? 'elendi' : t.sulanma > 0.01 ? 'dikkat' : 'gecti', 'yılda ' + yuzde(t.sulanma) + ' (5Y, tahmini)',
    (t.sulanma > 0.03 ? 'Hisse sayısı yılda %3\'ten hızlı artıyor: ortakların payı eriyor. ' : t.sulanma > 0 ? 'Geri alım yalnızca seyrelmeyi karşılıyorsa değer katmaz. ' : 'Hisse sayısı azalıyor. ') + 'SBC / FCF\'yi 10-K\'dan kontrol edin.');

  // 7) Sermaye dağıtımı (yargı gerektirir)
  ek('Sermaye dağıtımı', 'elle', sayiMi(t.temettuFcf) ? 'temettü / FCF ' + (Number.isFinite(t.temettuFcf) ? yuzde(t.temettuFcf, 0, false) : 'FCF negatif') : '—',
    'Satın almalar değer yarattı mı, geri alımlar hangi fiyattan yapıldı, yönetim sözlerini tuttu mu? Hedefleri sürekli kaçırıp dış etkenleri suçluyorsa elenir.');

  // 8) Fiyat (en son)
  const iyimser = sen.satirlar[2].b, pes = seri(m, 'pe', false).filter(v => v > 0).slice(0, 5);
  const fkOrt = pes.length >= 3 ? pes.reduce((x, y) => x + y, 0) / pes.length : null;
  const fkSimdi = t.fkDuzeltildi ? t.duzFk : sen.fkTtm;
  const tarihsel = sayiMi(fkOrt) && sayiMi(fkSimdi) && fkSimdi > 0 ? fkSimdi / fkOrt : null;
  if (!sayiMi(rd.g)) ek('Fiyat', tarihsel !== null && tarihsel > 1.3 ? 'dikkat' : 'yok', tarihsel !== null ? 'F/K ' + sayi(fkSimdi) + ' · ' + pes.length + ' yıl ort. ' + sayi(fkOrt) : '—', 'Reverse DCF hesaplanamadı (' + (rd.hata || 'veri yok') + ').');
  else {
    const durum = rd.g > iyimser ? 'elendi' : rd.g > sen.g || (tarihsel !== null && tarihsel > 1.3) ? 'dikkat' : 'gecti';
    ek('Fiyat', durum, 'fiyatlanan büyüme ' + yuzde(rd.g) + ' · iyimser senaryo ' + yuzde(iyimser) + (tarihsel !== null ? ' · F/K kendi ' + pes.length + ' yıl ort.\'nın ' + nf(1).format(tarihsel) + ' katı' : ''),
      durum === 'elendi' ? 'Fiyat, iyimser senaryomuzdaki büyümeden bile fazlasını istiyor.' : durum === 'dikkat' ? (rd.g > sen.g ? 'Fiyat baz senaryodan hızlı büyüme varsayıyor. ' : '') + (tarihsel !== null && tarihsel > 1.3 ? 'F/K kendi geçmişinin belirgin üstünde.' : '') : 'Fiyatın istediği büyüme baz senaryonun içinde.');
  }
  return a;
}

const BAYRAKLAR = [
  'Net kâr artıyor, serbest nakit akışı artmıyor',
  'Alacaklar gelirden çok daha hızlı büyüyor',
  'Stoklar gelirden hızlı büyüyor',
  'Şirket hep "düzeltilmiş" rakamlarla konuşuyor, resmi rakamla fark her yıl açılıyor',
  'Hisse bazlı ödeme (SBC) net kârdan büyük ya da FCF\'nin büyük kısmı',
  'Geri alım açıklanıyor ama hisse sayısı düşmüyor',
  'Gelir artarken marj düşüyor',
  'ROIC yıllardır sermaye maliyetinin altında',
  'Borcun büyük kısmı 12–24 ay içinde vadeli',
  'Döngüsel şirket, borçluluk zirve FAVÖK ile hesaplanmış',
  'Sık denetçi, CFO ya da muhasebe politikası değişikliği',
  'Hedefler tekrar tekrar kaçırılıyor, hep dış etkenler suçlanıyor',
  'Seri satın almalar sürerken ROIC düşüyor',
  'Temettü FCF\'nin %80\'inden fazla'
];
/** Otomatik hesaplanabilen bayraklar: true = var, false = yok, null = veri yok. Diğerleri elle işaretlenir. */
function otomatikBayraklar(m, t, akis) {
  const devir = ad => { const s = seri(m, ad, false); return s.length >= 3 && s[2] > 0 ? s[0] / s[2] < 0.8 : null; };
  const om = t.omSeri, k = Math.min(3, om.length - 1), g3 = m.revenueGrowth3Y;
  const roic = akis.find(x => x.ad === 'ROIC');
  return {
    0: sayiMi(t.nakitDon) ? t.nakitDon < 0.6 : null,
    1: devir('receivablesTurnover'),
    2: devir('inventoryTurnover'),
    5: sayiMi(t.sulanma) ? t.sulanma > 0.005 : null,
    6: om.length >= 2 && sayiMi(g3) ? g3 > 0 && om[0] < om[k] - 0.01 : null,
    7: t.finans || !roic || roic.durum === 'yok' ? null : roic.durum === 'elendi',
    13: sayiMi(t.temettuFcf) ? t.temettuFcf > 0.8 : false
  };
}

/** Reverse DCF: bugünkü değeri haklı çıkarmak için FCF'nin yıllık kaç büyümesi gerekir (ikiye bölme). */
function dcfDeger(fcf, g, r, tg, n) { let pv = 0, cf = fcf; for (let t = 1; t <= n; t++) { cf *= 1 + g; pv += cf / Math.pow(1 + r, t); } return pv + cf * (1 + tg) / (r - tg) / Math.pow(1 + r, n); }
function reverseDcf(deger, fcf, r, tg, n) {
  if (!(deger > 0)) return { hata: 'Değer yok' };
  if (!sayiMi(fcf) || !(fcf > 0)) return { hata: 'FCF negatif/yok: hesaplanamaz' };
  if (!(r > tg)) return { hata: 'İskonto > kalıcı büyüme olmalı' };
  let lo = -0.5, hi = 1.5;
  if (dcfDeger(fcf, hi, r, tg, n) < deger) return { hata: '%150\'den fazla' };
  if (dcfDeger(fcf, lo, r, tg, n) > deger) return { hata: '−%50\'den az' };
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (dcfDeger(fcf, mid, r, tg, n) < deger) lo = mid; else hi = mid; }
  return { g: (lo + hi) / 2 };
}

// ---------------------------------------------------------------- yönlendirme
const EKRANLAR = { portfoy: ekranPortfoy, analiz: ekranAnaliz, zincir: ekranZincir, insider: ekranInsider, orb: ekranOrb, ayarlar: ekranAyarlar };
let aktif = { ad: '', param: '', yenile: false };

function yonlendir(yenile = false) {
  const [ad, param] = (location.hash.slice(1) || 'portfoy').split('/');
  const ekran = EKRANLAR[ad] ? ad : 'portfoy';
  aktif = { ad: ekran, param: decodeURIComponent(param || ''), yenile };
  document.querySelectorAll('.sekmeler a').forEach(a => {
    if (a.dataset.sekme === ekran) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#demo-rozet').hidden = !ayarlar().demo;
  const main = $('#icerik');
  const calisan = EKRANLAR[ekran](main, aktif.param, yenile);
  if (yenile && calisan && calisan.then) {
    const d = $('#yenile'); d.classList.add('donuyor');
    calisan.finally(() => d.classList.remove('donuyor'));
  }
}
window.addEventListener('hashchange', () => { yonlendir(); window.scrollTo(0, 0); });
$('#yenile').addEventListener('click', () => yonlendir(true));

function anahtarYok(main) {
  main.innerHTML = `<div class="kart bos"><h2>Finnhub anahtarı gerekli</h2>
    <p>Canlı veri için Ayarlar'a ücretsiz Finnhub anahtarını gir. Anahtar yalnızca bu cihazda saklanır.</p>
    <p>Denemek istersen örnek veriyle de bakabilirsin.</p>
    <div class="dugmeler" style="justify-content:center"><a class="dugme" href="#ayarlar">Ayarlar'a git</a>
    <button class="dugme ikincil" type="button" id="demo-ac">Örnek veriyle dene</button></div></div>`;
  $('#demo-ac', main).onclick = () => { ayarKaydet({ demo: true }); yonlendir(); };
}
const hataKutusu = e => `<div class="uyari">⚠️ ${esc(e && e.message || e)}</div>`;
const veriVarMi = () => ayarlar().demo || !!anahtar();
const sorgu = p => kod(p.dayanak) && kod(p.dayanak) !== kod(p.t) ? kod(p.dayanak) : kod(p.t);

// ---------------------------------------------------------------- PORTFÖY
async function ekranPortfoy(main, _p, yenile) {
  const poz = pozisyonlar();
  if (!poz.length) {
    main.innerHTML = `<div class="kart bos"><h2>Portföyün boş</h2><p>Hisselerini ekle; veriler yalnızca bu cihazda saklanır.</p>
      <div class="dugmeler" style="justify-content:center"><button class="dugme" type="button" id="ekle">+ Pozisyon ekle</button>
      <a class="dugme ikincil" href="#ayarlar">İçe aktar</a></div></div>`;
    $('#ekle', main).onclick = () => pozDuzenle(-1);
    return;
  }
  main.innerHTML = `<div class="ozet" id="ozet"></div>
    <div class="kart"><h2>Pozisyonlar <small>· ${poz.length}</small></h2><ul class="liste" id="liste"></ul>
    <div class="dugmeler"><button class="dugme tam" type="button" id="ekle">+ Pozisyon ekle</button></div></div>
    <div id="hata"></div>`;
  $('#ekle', main).onclick = () => pozDuzenle(-1);
  const fiyatlar = {};
  const ciz = () => {
    const satir = poz.map((p, i) => {
      const q = fiyatlar[kod(p.t)] || {};
      const f = sayiMi(q.c) && q.c > 0 ? q.c : null;
      const deger = f !== null ? f * p.adet : null;
      const maliyet = sayiMi(p.maliyet) && p.maliyet > 0 ? p.maliyet * p.adet : null;
      const kz = deger !== null && maliyet !== null ? deger - maliyet : null;
      const gun = sayiMi(q.dp) ? q.dp / 100 : null;
      const gunKz = deger !== null && gun !== null ? deger * gun / (1 + gun) : null;
      return { p, i, f, deger, maliyet, kz, kzY: kz !== null ? kz / maliyet : null, gun, gunKz };
    });
    const top = satir.reduce((a, s) => a + (s.deger || 0), 0);
    const topMal = satir.filter(s => s.kz !== null).reduce((a, s) => a + s.maliyet, 0);
    const topKz = satir.filter(s => s.kz !== null).reduce((a, s) => a + s.kz, 0);
    const topGun = satir.reduce((a, s) => a + (s.gunKz || 0), 0);
    const enBuyuk = satir.filter(s => s.deger).sort((a, b) => b.deger - a.deger)[0];
    $('#ozet', main).innerHTML = `
      <div class="kart"><div class="etiket">Toplam değer</div><div class="buyuk">${top ? usd(top, 0) : '—'}</div><div class="alt">${poz.length} pozisyon</div></div>
      <div class="kart"><div class="etiket">Açık K/Z</div><div class="buyuk ${renk(topKz)}">${topMal ? usdIsaretli(topKz) : '—'}</div><div class="alt">${topMal ? yuzde(topKz / topMal) + ' · maliyet ' + usd(topMal, 0) : 'Maliyet girilmemiş'}</div></div>
      <div class="kart"><div class="etiket">Bugün</div><div class="buyuk ${renk(topGun)}">${top ? usdIsaretli(topGun) : '—'}</div><div class="alt">${top ? yuzde(topGun / (top - topGun), 2) : ''}</div></div>
      <div class="kart"><div class="etiket">En büyük</div><div class="buyuk">${enBuyuk ? esc(enBuyuk.p.t) : '—'}</div><div class="alt">${enBuyuk && top ? 'ağırlık ' + yuzde(enBuyuk.deger / top, 0, false) : ''}</div></div>`;
    $('#liste', main).innerHTML = satir.map(s => `
      <li class="satir" data-i="${s.i}" tabindex="0" role="button" aria-label="${esc(s.p.t)} pozisyonunu düzenle">
        <div class="sol"><div class="kod">${esc(s.p.t)} ${s.p.dayanak ? `<small>→ ${esc(s.p.dayanak)}</small>` : ''}</div>
          <div class="alt">${sayi(s.p.adet, s.p.adet % 1 ? 2 : 0)} × ${usd(s.f)} ${s.gun !== null ? `· <span class="${renk(s.gun)}">${yuzde(s.gun, 2)}</span>` : ''}</div>
          <div class="agirlik" aria-hidden="true"><i style="width:${top && s.deger ? (s.deger / top * 100).toFixed(1) : 0}%"></i></div></div>
        <div class="sag"><div class="kod">${usd(s.deger, 0)}</div>
          <div class="alt ${renk(s.kz)}">${s.kz !== null ? usdIsaretli(s.kz) + ' · ' + yuzde(s.kzY) : 'maliyet yok'}</div></div>
      </li>`).join('');
    main.querySelectorAll('.satir').forEach(li => {
      const ac = () => pozDuzenle(Number(li.dataset.i));
      li.onclick = ac; li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ac(); } };
    });
  };
  ciz();
  if (!veriVarMi()) { $('#hata', main).innerHTML = `<div class="bilgi">Fiyatlar için <a href="#ayarlar">Ayarlar</a>'dan Finnhub anahtarını gir ya da örnek veriyi aç.</div>`; return; }
  const hatalar = [];
  for (const t of [...new Set(poz.map(p => kod(p.t)))]) {
    try { fiyatlar[t] = await api.fiyat(t, yenile); ciz(); } catch (e) { hatalar.push(t + ': ' + e.message); }
    if (aktif.ad !== 'portfoy') return;
  }
  if (hatalar.length) $('#hata', main).innerHTML = hataKutusu(hatalar.join(' · '));
}

function pozDuzenle(i) {
  const d = $('#poz-dialog'), f = $('#poz-form'), poz = pozisyonlar(), p = poz[i] || {};
  $('#poz-baslik').textContent = i < 0 ? 'Pozisyon ekle' : p.t + ' düzenle';
  f.t.value = p.t || ''; f.adet.value = p.adet ?? ''; f.maliyet.value = p.maliyet ?? ''; f.dayanak.value = p.dayanak || ''; f.not.value = p.not || '';
  $('#poz-sil').hidden = i < 0;
  $('#poz-sil').onclick = () => { if (confirm(p.t + ' pozisyonu silinsin mi?')) { poz.splice(i, 1); pozKaydet(poz); d.close(); yonlendir(); } };
  $('#poz-vazgec').onclick = () => d.close();
  f.onsubmit = e => {
    e.preventDefault();
    const yeni = { t: kod(f.t.value), adet: Number(f.adet.value), maliyet: f.maliyet.value === '' ? null : Number(f.maliyet.value), dayanak: kod(f.dayanak.value), not: f.not.value.trim() };
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(yeni.t)) { bildir('Hisse kodu geçersiz.'); return; }
    if (!(yeni.adet > 0)) { bildir('Adet 0\'dan büyük olmalı.'); return; }
    if (yeni.dayanak === yeni.t) yeni.dayanak = '';
    if (i < 0) poz.push(yeni); else poz[i] = yeni;
    pozKaydet(poz); d.close(); bildir('Kaydedildi.'); yonlendir();
  };
  d.showModal(); setTimeout(() => (i < 0 ? f.t : f.adet).focus(), 30);
}

// ---------------------------------------------------------------- ANALİZ
async function ekranAnaliz(main, param, yenile) {
  const t = kod(param || depo.al('sonAnaliz', '') || (pozisyonlar()[0] && sorgu(pozisyonlar()[0])) || 'AMD');
  main.innerHTML = `<form class="kart ara" id="ara-form" role="search"><label class="gizli" for="ara" hidden>Hisse kodu</label>
      <input id="ara" value="${esc(t)}" placeholder="Hisse kodu (ör. AMD)" autocomplete="off" autocapitalize="characters" maxlength="10" aria-label="Hisse kodu">
      <button class="dugme" type="submit">Analiz et</button></form><div id="sonuc"></div>`;
  $('#ara-form', main).onsubmit = e => { e.preventDefault(); const v = kod($('#ara', main).value); if (v) location.hash = 'analiz/' + encodeURIComponent(v); };
  const sonuc = $('#sonuc', main);
  if (!veriVarMi()) return anahtarYok(sonuc);
  depo.koy('sonAnaliz', t);
  sonuc.innerHTML = `<div class="yukleniyor">${esc(t)} yükleniyor…</div>`;
  try {
    const [m, q, pr, kz] = await Promise.all([api.metrik(t, yenile), api.fiyat(t, yenile), api.profil(t, yenile).catch(() => ({})), api.kazanc(t, yenile).catch(() => [])]);
    if (aktif.ad !== 'analiz') return;
    if (!Object.keys(m).length && !(q && q.c)) { sonuc.innerHTML = hataKutusu(t + ' için veri bulunamadı. Kodu kontrol et (Berkshire: BRK.B).'); return; }
    analizCiz(sonuc, t, m, q || {}, pr || {}, Array.isArray(kz) ? kz : []);
    Promise.all([api.takvim(t, yenile).catch(() => null), api.insider(t, yenile).catch(e => ({ hata: e.message }))]).then(([e, o]) => {
      const k = $('#analiz-takvim', sonuc); if (k) k.innerHTML = takvimKarti(e);
      const ins = $('#analiz-insider', sonuc); if (ins) ins.innerHTML = insiderKarti(o);
    });
  } catch (e) {
    sonuc.innerHTML = e.message === 'ANAHTAR' ? '' : hataKutusu(e);
    if (e.message === 'ANAHTAR') anahtarYok(sonuc);
  }
}

/** Temel analizin tüm hesapları (Analiz ve Zincir ekranları ortak kullanır). */
function temelHesapla(t, m, q, pr, kz) {
  const a = ayarlar();
  const fiyat = sayiMi(q.c) && q.c > 0 ? q.c : null;
  const sen = senaryolar(m, fiyat, a);
  const ev = sayiMi(m.enterpriseValue) ? m.enterpriseValue / 1000 : null;
  const pd = sayiMi(m.marketCapitalization) ? m.marketCapitalization / 1000 : sayiMi(pr.marketCapitalization) ? pr.marketCapitalization / 1000 : null;
  const evFcf = ilk(m, ['currentEv/freeCashFlowTTM', 'currentEv/freeCashFlowAnnual']);
  const pFcf = ilk(m, ['pfcfShareTTM', 'pfcfShareAnnual']);
  const fcf = ev !== null && sayiMi(evFcf) && evFcf !== 0 ? ev / evFcf : pd !== null && sayiMi(pFcf) && pFcf !== 0 ? pd / pFcf : null;
  const tr = turet(m, fiyat, ev, pd, fcf, pr.finnhubIndustry);
  const p = puanla(m, { fiyat, kazanc: kz, t: tr }, a.agirlik);
  const rd = reverseDcf(ev ?? pd, fcf, a.iskonto / 100, a.kalici / 100, a.yil);
  const dcf = basitDcf(m, fiyat, ev, pd, fcf, a);
  const baz = sen.satirlar[1].hedef;
  const tut = tr.finans ? { seviye: 'Belirsiz', sinif: '', aciklama: 'Banka/sigorta: nakit akışına dayalı değer bu sektörde anlamlı değil; F/K ve PD/DD ile okuyun.' } : tutarlilik(baz, dcf);
  const akis = elemeAkisi(m, tr, sen, rd);
  const elenen = akis.findIndex(x => x.durum === 'elendi');
  const dikkatSay = akis.filter(x => x.durum === 'dikkat').length;
  const oto = otomatikBayraklar(m, tr, akis);
  const elleKayit = (depo.al('bayrak', {})[t]) || [];
  const bayrakVar = i => oto[i] === true || (oto[i] === undefined && elleKayit.includes(i));
  const bayrakSay = BAYRAKLAR.filter((_, i) => bayrakVar(i)).length;
  const sorunlar = veriKontrol(sen.fkTtm, pd, fcf, dcf, fiyat);
  return { a, fiyat, sen, ev, pd, fcf, tr, p, rd, dcf, baz, tut, akis, elenen, dikkatSay, oto, bayrakVar, bayrakSay, sorunlar };
}

function analizCiz(el, t, m, q, pr, kz) {
  const { a, fiyat, sen, ev, pd, fcf, tr, p, rd, dcf, tut, akis, elenen, dikkatSay, oto, bayrakVar, bayrakSay, sorunlar } = temelHesapla(t, m, q, pr, kz);
  const lo = m['52WeekLow'], hi = m['52WeekHigh'];
  const konum = sayiMi(fiyat) && sayiMi(lo) && sayiMi(hi) && hi > lo ? (fiyat - lo) / (hi - lo) : null;
  const veriUyari = sorunlar.length ? `<div class="uyari kirmizi-kutu" role="alert"><b>⚠️ Veri tutarsız görünüyor</b> — ${esc(sorunlar.join(' · '))}.
    Finnhub verisinde hata olabilir (ör. yeni ayrılan şirketlerde ölçek sorunu). Hedefleri ve değerlemeleri kullanmayın.</div>` : '';
  const g3 = sayiMi(m.revenueGrowth3Y) ? m.revenueGrowth3Y / 100 : null;
  const rdYorum = !sayiMi(rd.g) ? '' : g3 === null ? 'Karşılaştırma için geçmiş büyüme verisi yok.'
    : rd.g > g3 + 0.05 ? 'Piyasa, son 3 yılın gelir büyümesinden daha hızlı bir büyüme fiyatlıyor: beklentiler yüksek.'
    : rd.g < g3 - 0.05 ? 'Piyasa, son 3 yılın gelir büyümesinden daha yavaş bir büyüme fiyatlıyor: beklentiler görece düşük.'
    : 'Piyasanın fiyatladığı büyüme, son 3 yılın gelir büyümesine yakın.';
  const cubuk = v => `<div class="cubuk"><i class="${v === null ? '' : v < 40 ? 'zayif' : v < 70 ? 'orta' : ''}" style="width:${v ?? 0}%"></i></div>`;

  el.innerHTML = `${veriUyari}
  <div class="kart">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div><h2 style="margin:0;font-size:19px;color:var(--metin)">${esc(pr.name || t)}</h2>
        <div class="alt">${esc(t)}${pr.finnhubIndustry ? ' · ' + esc(pr.finnhubIndustry) : ''}${pr.country ? ' · ' + esc(pr.country) : ''}</div></div>
      <div class="sag"><div class="buyuk">${usd(fiyat)}</div><div class="alt ${renk(q.dp)}">${sayiMi(q.dp) ? yuzde(q.dp / 100, 2) + ' bugün' : ''}</div></div>
    </div>
    <div class="uc" style="margin-top:12px">
      <div><div class="etiket">52H aralık</div><div class="sayi">${sayi(lo, 2)} – ${sayi(hi, 2)}</div></div>
      <div><div class="etiket">52H konum</div><div class="sayi">${konum !== null ? yuzde(konum, 0, false) : '—'}</div></div>
      <div><div class="etiket">Piyasa değeri</div><div class="sayi">${pd !== null ? '$' + nf(1).format(pd) + ' Mr' : '—'}</div></div>
    </div>
  </div>

  <div class="kart">
    <h2>Bileşik skor <small>· kendi yöntemimiz</small></h2>
    <div class="skor">
      <div class="halka" style="--p:${p.bilesik ?? 0}" role="img" aria-label="Bileşik skor ${p.bilesik ?? 'yok'} / 100"><b>${p.bilesik ?? '—'}</b></div>
      <div class="boyutlar">${BOYUTLAR.map(b => `<div class="boyut"><span>${b}</span>${cubuk(p.boyut[b])}<b class="sag">${p.boyut[b] ?? '—'}</b></div>`).join('')}</div>
    </div>
    <p class="alt" style="margin:10px 0 0">Ağırlıklar ${BOYUTLAR.map(b => b + ' ' + a.agirlik[b]).join(' · ')} (Ayarlar'dan değişir). Puan 0–100: her metrik "kötü" ile "iyi" eşiği arasında doğrusal.</p>
    <details style="margin-top:8px"><summary>Puanlamaya giren metrikler</summary><div class="kaydir">
      <table class="tablo"><thead><tr><th>Metrik</th><th>Değer</th><th>Kötü</th><th>İyi</th><th>Puan</th></tr></thead><tbody>
      ${p.satirlar.map(s => `<tr><td>${esc(s.ad)} <span class="alt">${s.boyut}</span></td><td>${sayi(s.v, 2)}</td><td>${s.kotu}</td><td>${s.iyi}</td><td><b>${s.p ?? '—'}</b></td></tr>`).join('')}
      </tbody></table></div></details>
  </div>

  <div class="kart">
    <h2>🧭 Eleme akışı <small>· 8 adım, rehbere göre</small></h2>
    ${tr.finans ? '<div class="uyari">🏦 Banka/sigorta: FCF, ROIC ve FAVÖK bu sektörde anlamlı değil. NIM, takipteki krediler, sermaye yeterliliği (CET1) ya da birleşik rasyo gibi sektör ölçütlerine bakın.</div>' : ''}
    <p style="margin:0 0 10px">${elenen >= 0 ? `<span class="cip kirmizi">⛔ ${elenen + 1}. adımda elendi: ${esc(akis[elenen].ad)}</span>` : `<span class="cip ${dikkatSay ? 'sari' : 'yesil'}">${dikkatSay ? '⚠️ Elenmedi, ' + dikkatSay + ' adımda dikkat' : '✅ Otomatik adımların hepsini geçti'}</span>`}
      <span class="alt" style="display:block;margin-top:4px">Amaç beğenmek değil elemek: şirketlerin çoğu ilk 3 adımda düşer. Eşikler başlangıç noktasıdır, kural değil.</span></p>
    <ol class="akis">${akis.map(x => { const d = DURUM[x.durum]; return `<li><div class="akis-ust"><b>${esc(x.ad)}</b><span class="cip ${d[1]}">${d[0]} ${d[2]}</span></div>
      <div class="sayi">${esc(x.deger)}</div>${x.not ? `<div class="alt">${esc(x.not)}</div>` : ''}</li>`; }).join('')}</ol>
  </div>

  <div class="kart" id="bayraklar">
    <h2>🚩 Kırmızı bayraklar <small>· ${bayrakSay} / ${BAYRAKLAR.length}</small></h2>
    <p style="margin:0 0 10px"><span class="cip ${bayrakSay > 2 ? 'kirmizi' : bayrakSay ? 'sari' : 'yesil'}">${bayrakSay > 2 ? '⛔ İkiden fazla bayrak: açıklanana kadar durun' : bayrakSay ? '⚠️ Tek bayrak satış sinyali değil, nedenini araştırın' : '✅ İşaretli bayrak yok'}</span></p>
    <ul class="bayrak-liste">${BAYRAKLAR.map((b, i) => { const o = oto[i]; const otoMu = o !== undefined;
      return `<li><label><input type="checkbox" data-bayrak="${i}" ${bayrakVar(i) ? 'checked' : ''} ${otoMu ? 'disabled' : ''}> <span>${esc(b)}</span></label>
        <small class="alt">${otoMu ? (o === null ? 'otomatik · veri yok' : 'otomatik') : 'elle işaretleyin'}</small></li>`; }).join('')}</ul>
    <p class="alt" style="margin:8px 0 0">Otomatik olanlar Finnhub verisinden hesaplanır; diğerleri 10-K ve bilanço görüşmesinden sizin yargınızdır ve bu cihazda hisse bazında saklanır.</p>
  </div>

  <div class="kart">
    <h2>🎯 Senaryolu hedef fiyat <small>· 1 yıllık</small></h2>
    ${sayiMi(sen.eps) && sen.eps <= 0 ? '<div class="uyari">⚠️ EPS negatif: F/K yöntemi bu hisse için anlamlı değil; reverse DCF\'ye bakın.</div>' : ''}
    ${sorunlar.length ? '<p style="margin:0 0 8px"><span class="cip kirmizi">⚠️ Veri tutarsız — hedefler güvenilir değil</span></p>' : ''}
    <p style="margin:0 0 10px"><span class="cip ${tut.sinif}">Tutarlılık: ${tut.seviye}</span>
      <span class="alt" style="display:block;margin-top:4px">${esc(tut.aciklama)}</span></p>
    <div class="uc" style="margin-bottom:10px">
      <div><div class="etiket">EPS (12 ay)</div><div class="sayi">${usd(sen.eps)}</div></div>
      <div><div class="etiket">Baz büyüme</div><div class="sayi">${yuzde(sen.g)}</div><div class="alt">${esc(sen.gKaynak)}${sayiMi(sen.gHam) && sen.gHam !== sen.g ? ' · ham ' + yuzde(sen.gHam) + ', sınırlandı' : ''}</div></div>
      <div><div class="etiket">F/K</div><div class="sayi">${sayi(sen.fk)}</div><div class="alt">${a.fkKaynak === 'ileri' && sen.fk === sen.fkIleri ? 'ileri' : 'son 12 ay'}${sayiMi(tr.duzFk) ? ' · düzeltilmiş ' + sayi(tr.duzFk) : ''}</div></div>
    </div>
    ${tr.fkDuzeltildi ? `<div class="uyari">⚠️ Net kâr faaliyet kârının ${nf(2).format(tr.nkOrani)} katı: kârın önemli kısmı faaliyet dışı (ör. iştirak/özel şirket payı değerlemesi). Faaliyet kârına dayalı düzeltilmiş F/K ${sayi(tr.duzFk)}; skorda bu kullanıldı. EPS büyümesi de şişik olabilir.</div>` : ''}
    <div class="iki">
      <label>Büyüme üst sınırı (%)<input type="number" id="ust-sinir" value="${a.ustSinir}" min="0" max="100" step="1" inputmode="numeric"></label>
      <label>F/K kaynağı<select id="fk-kaynak"><option value="ttm"${a.fkKaynak !== 'ileri' ? ' selected' : ''}>Son 12 ay (${sayi(sen.fkTtm)})</option><option value="ileri"${a.fkKaynak === 'ileri' ? ' selected' : ''}>İleri (${sayi(sen.fkIleri)})</option></select></label>
    </div>
    <div class="kaydir"><table class="tablo"><thead><tr><th>Senaryo</th><th>Büyüme</th><th>F/K</th><th>Hedef</th><th>Potansiyel</th></tr></thead><tbody>
      ${sen.satirlar.map(s => `<tr><td>${s.ad}</td><td>${yuzde(s.b)}</td><td>${sayi(s.fk)}</td><td><b>${usd(s.hedef)}</b></td><td class="${renk(s.pot)}"><b>${yuzde(s.pot)}</b></td></tr>`).join('')}
      <tr class="toplam"><td colspan="3"><b>Beklenen değer</b> <span class="alt">${a.senAgirlik.kot}/${a.senAgirlik.baz}/${a.senAgirlik.iyi}</span></td><td><b>${usd(sen.beklenen)}</b></td><td class="${renk(sen.beklenenPot)}"><b>${yuzde(sen.beklenenPot)}</b></td></tr>
    </tbody></table></div>
    <p class="alt" style="margin:8px 0 0">Kötümser: −10 puan büyüme, F/K ×0,75 · İyimser: +10 puan, F/K ×1,2. Beklenen değer = senaryoların ağırlıklı ortalaması (ağırlıklar Ayarlar'dan). İleri F/K gelecek yılın kârını zaten içerdiği için hedefi düşük gösterir; en kötümser ölçü olarak okuyun.</p>
  </div>

  <div class="kart">
    <h2>🔄 Reverse DCF <small>· piyasa ne kadar büyüme fiyatlıyor?</small></h2>
    <div class="uc" style="margin-bottom:6px">
      <div><div class="etiket">Firma değeri</div><div class="sayi">${ev !== null ? '$' + nf(1).format(ev) + ' Mr' : '—'}</div></div>
      <div><div class="etiket">Serbest nakit</div><div class="sayi">${fcf !== null ? '$' + nf(2).format(fcf) + ' Mr' : '—'}</div></div>
      <div><div class="etiket">Gelir büy. 3Y</div><div class="sayi">${yuzde(g3)}</div></div>
    </div>
    <div class="uc">
      <label>İskonto (%)<input type="number" id="iskonto" value="${a.iskonto}" step="0.5" inputmode="decimal"></label>
      <label>Kalıcı büy. (%)<input type="number" id="kalici" value="${a.kalici}" step="0.5" inputmode="decimal"></label>
      <label>Yıl<input type="number" id="yil" value="${a.yil}" step="1" min="1" max="30" inputmode="numeric"></label>
    </div>
    ${tr.finans ? '<div class="uyari">🏦 Banka/sigortada serbest nakit akışı anlamlı değil; bu kartı dikkate almayın.</div>' : ''}
    <div class="bilgi"><b>Fiyatlanan yıllık FCF büyümesi: ${sayiMi(rd.g) ? yuzde(rd.g) : esc(rd.hata)}</b>${rdYorum ? '<br>' + rdYorum : ''}</div>
    <div class="iki" style="margin:0">
      <div><div class="etiket">Nakit akışına dayalı değer</div><div class="sayi"><b>${dcf ? usd(dcf.hisseBasi) : '—'}</b></div>
        <div class="alt">${dcf && sayiMi(fiyat) ? yuzde(dcf.hisseBasi / fiyat - 1) + ' fiyata göre' : 'FCF negatif/yok'}</div></div>
      <div><div class="etiket">Varsayım</div><div class="alt">${dcf ? 'FCF ' + a.yil + ' yıl ' + yuzde(dcf.g) + ' büyür (gelir 3Y, üst sınırlı), sonra ' + yuzde(a.kalici / 100, 1, false) + '; iskonto ' + yuzde(a.iskonto / 100, 1, false) : '—'}</div></div>
    </div>
  </div>

  <div class="kart"><h2>📅 Son çeyrek kâr sonuçları</h2>${kz.length ? `<div class="kaydir"><table class="tablo"><thead><tr><th>Dönem</th><th>Beklenti</th><th>Gerçekleşen</th><th>Sürpriz</th></tr></thead><tbody>
    ${kz.slice(0, 4).map(r => `<tr><td>${esc(r.period)}</td><td>${usd(r.estimate)}</td><td>${usd(r.actual)}</td><td class="${renk(r.surprisePercent)}"><b>${sayiMi(r.surprisePercent) ? yuzde(r.surprisePercent / 100) : '—'}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="alt">Veri yok.</p>'}</div>
  <div class="kart" id="analiz-takvim"><h2>📅 Sıradaki bilanço</h2><p class="alt">Yükleniyor…</p></div>
  <div class="kart" id="analiz-insider"><h2>🧑‍💼 Insider</h2><p class="alt">Yükleniyor…</p></div>`;

  const kaydetCiz = degisen => { ayarKaydet(degisen); analizCiz(el, t, m, q, pr, kz); yonlendirmeYok(el, t); };
  el.querySelectorAll('[data-bayrak]').forEach(c => { c.onchange = () => {
    const tum = depo.al('bayrak', {}), i = Number(c.dataset.bayrak), set = new Set(tum[t] || []);
    if (c.checked) set.add(i); else set.delete(i);
    tum[t] = [...set]; if (!tum[t].length) delete tum[t]; depo.koy('bayrak', tum);
    const y = window.scrollY; analizCiz(el, t, m, q, pr, kz); yonlendirmeYok(el, t); window.scrollTo(0, y);
  }; });
  $('#ust-sinir', el).onchange = e => { const v = Number(e.target.value); if (v >= 0 && v <= 100) kaydetCiz({ ustSinir: v }); };
  $('#fk-kaynak', el).onchange = e => kaydetCiz({ fkKaynak: e.target.value });
  ['iskonto', 'kalici', 'yil'].forEach(id => { $('#' + id, el).onchange = e => { const v = Number(e.target.value); if (Number.isFinite(v)) kaydetCiz({ [id]: v }); }; });
}
/** Ayar değişince takvim/insider kartlarını yeniden doldurur (önbellekten, ağ isteği yok). */
function yonlendirmeYok(el, t) {
  Promise.all([api.takvim(t).catch(() => null), api.insider(t).catch(e => ({ hata: e.message }))]).then(([e, o]) => {
    const k = $('#analiz-takvim', el); if (k) k.innerHTML = takvimKarti(e);
    const i = $('#analiz-insider', el); if (i) i.innerHTML = insiderKarti(o);
  });
}
function takvimKarti(e) {
  if (!e) return '<h2>📅 Sıradaki bilanço</h2><p class="alt">90 gün içinde açıklanmış tarih yok.</p>';
  const k = kalanGun(e.date);
  return `<h2>📅 Sıradaki bilanço</h2><div class="uc">
    <div><div class="etiket">Tarih</div><div class="sayi"><b>${tarihTR(e.date)}</b></div><div class="alt">${k} gün · ${SAAT[e.hour] || 'saat belirsiz'}</div></div>
    <div><div class="etiket">EPS beklentisi</div><div class="sayi">${usd(e.epsEstimate)}</div><div class="alt">${e.year} Ç${e.quarter}</div></div>
    <div><div class="etiket">Gelir beklentisi</div><div class="sayi">${sayiMi(e.revenueEstimate) ? '$' + nf(2).format(e.revenueEstimate / 1e9) + ' Mr' : '—'}</div></div></div>`;
}
function insiderKarti(o) {
  if (!o || o.hata) return `<h2>🧑‍💼 Insider</h2><p class="alt">${esc(o && o.hata || 'Veri yok.')}</p>`;
  return `<h2>🧑‍💼 Insider <small>· son 90 gün, açık piyasa</small></h2>
    <div class="uc"><div><div class="etiket">Alım</div><div class="sayi">${o.alim} işlem</div><div class="alt">${usd(o.alimUsd / 1e6, 2)} Mn</div></div>
    <div><div class="etiket">Satış</div><div class="sayi">${o.satis} işlem</div><div class="alt">${usd(o.satisUsd / 1e6, 2)} Mn</div></div>
    <div><div class="etiket">Net</div><div class="sayi ${renk(o.net)}">${usdIsaretli(o.net / 1e6, 2)} Mn</div></div></div>
    <p style="margin:10px 0 0">${o.kume ? `<span class="cip yesil">✅ Küme alımı · ${o.alanSayisi} yönetici</span> <span class="alt">son alım ${tarihTR(o.sonAlim)}</span>` : '<span class="cip">Küme alımı yok</span>'}</p>
    <p class="alt" style="margin:8px 0 0">Yalnızca Form 4 kodu P (alım) ve S (satış); ödül, opsiyon kullanımı ve vergi stopajı hariç. Form 4 işlemden ~2 iş günü sonra yayımlanır.</p>`;
}

// ---------------------------------------------------------------- portföy döngüsü (takvim/insider)
function portfoySorgulari() {
  const g = new Map();
  pozisyonlar().forEach(p => {
    const s = sorgu(p), etiket = s === kod(p.t) ? s : kod(p.t) + ' → ' + s;
    if (g.has(s)) g.get(s).etiket = g.get(s).etiket.split(' → ')[0] + ', ' + etiket; else g.set(s, { t: s, etiket, etf: s === kod(p.t) });
  });
  return [...g.values()];
}
function portfoyBos(main, ne) {
  main.innerHTML = `<div class="kart bos"><h2>Portföy boş</h2><p>${ne} için önce Portföy'e hisse ekle.</p><a class="dugme" href="#portfoy">Portföy'e git</a></div>`;
}

// ---------------------------------------------------------------- ZİNCİR (hisse akışı)
// Tarama → seçim → temel + teknik → yön → spot hedef/stop → opsiyon alternatifleri.
// Tarama, fiyat geçmişi ve opsiyon zinciri Apps Script aracısından (ORB web uygulaması, apps-script/Zincir.gs) gelir;
// temel veri Finnhub. Hesaplar bilgisayardaki araclar/hisse_akisi/*.py ile aynı mantıktadır. Kendi yöntemimiz; yatırım tavsiyesi değildir.
const ZINCIR_HAZIR = [
  ['Aşırı satılmış büyükler', 'cap_largeover,ta_rsi_os30'],
  ['Trend + momentum', 'cap_midover,ta_sma50_pa,ta_sma200_pa,ta_perf_4wup,sh_avgvol_o1000'],
  ['Kaliteli, makul F/K', 'cap_largeover,fa_pe_u20,fa_roe_o15,fa_epsqoq_pos'],
  ['52H zirveye yakın', 'cap_midover,ta_highlow52w_b0to5h,ta_sma50_pa'],
  ['Geri çekilen büyüme', 'cap_midover,ta_highlow52w_10to30-bhx,fa_epsqoq_o25,fa_salesqoq_o25']
];
const zBellek = new Map();
async function zincirAl(param, sure = 5 * 6e4, yenile = false) {
  const qs = new URLSearchParams(param).toString();
  const c = zBellek.get(qs); if (!yenile && c && c.son > Date.now()) return c.v;
  let r;
  try { r = await fetch(orbAdres() + (orbAdres().includes('?') ? '&' : '?') + qs, { cache: 'no-store' }); }
  catch { throw new Error('Aracıya ulaşılamadı (internet bağlantısı?).'); }
  if (!r.ok) throw new Error('Aracı yanıtı HTTP ' + r.status);
  const v = await r.json();
  if (!v || !v.ok) throw new Error((v && v.hata) || 'Aracı hatası');
  zBellek.set(qs, { v, son: Date.now() + sure });
  return v;
}

// --- teknik göstergeler (seviyeler.py ile aynı)
const zOrt = (a, n) => a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null;
function zEma(a, span) { const k = 2 / (span + 1), o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; }
function zWilder(a, n = 14) { const k = 1 / n, o = []; let p = null; for (const v of a) { if (sayiMi(v)) p = p === null ? v : v * k + p * (1 - k); o.push(p); } return o; }
function zGostergeler(g) {
  const { h, l, c } = g, n = c.length, s = n - 1;
  const e12 = zEma(c, 12), e26 = zEma(c, 26), macd = e12.map((v, i) => v - e26[i]), sig = zEma(macd, 9), hist = macd.map((v, i) => v - sig[i]);
  const d = c.map((v, i) => i ? v - c[i - 1] : null);
  const up = zWilder(d.map(x => x === null ? null : Math.max(x, 0))), dn = zWilder(d.map(x => x === null ? null : Math.max(-x, 0)));
  const rsi = dn[s] > 0 ? 100 - 100 / (1 + up[s] / dn[s]) : 100;
  const tr = c.map((_, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]);
  const atr = zWilder(tr);
  const dm = (yon) => c.map((_, i) => { if (!i) return 0; const u = h[i] - h[i - 1], w = l[i - 1] - l[i]; return yon > 0 ? (u > w && u > 0 ? u : 0) : (w > u && w > 0 ? w : 0); });
  const ps = zWilder(dm(1)), ns = zWilder(dm(-1));
  const pdi = ps.map((v, i) => 100 * v / atr[i]), ndi = ns.map((v, i) => 100 * v / atr[i]);
  const adx = zWilder(pdi.map((v, i) => v + ndi[i] > 0 ? 100 * Math.abs(v - ndi[i]) / (v + ndi[i]) : null));
  const ret = c.slice(-21).map((v, i, a) => i ? Math.log(v / a[i - 1]) : null).slice(1);
  const mu = ret.reduce((x, y) => x + y, 0) / ret.length;
  const hv20 = Math.sqrt(ret.reduce((x, y) => x + (y - mu) ** 2, 0) / (ret.length - 1)) * Math.sqrt(252);
  let kesisim = null;
  for (let i = 1; i < Math.min(30, n - 1); i++) { const a = hist[n - i], b = hist[n - i - 1]; if ((a > 0) !== (b > 0)) { kesisim = { yon: a > 0 ? 'yukarı' : 'aşağı', gun: i - 1 }; break; } }
  const s200 = zOrt(c, 200), s200once = n > 220 ? zOrt(c.slice(0, n - 20), 200) : null;
  return { fiyat: c[s], sma20: zOrt(c, 20), sma50: zOrt(c, 50), sma200: s200, s200egim: s200once ? (s200 / s200once - 1) * 100 : null,
    rsi, macd: macd[s], sinyal: sig[s], hist: hist[s], kesisim, adx: adx[s], diArti: pdi[s], diEksi: ndi[s],
    atr: atr[s], hv20, hi52: Math.max(...h.slice(-252)), lo52: Math.min(...l.slice(-252)) };
}
function zSalinim(h, l, k = 2) {
  const t = [], d = [];
  for (let i = k; i < h.length - k; i++) {
    if (h[i] === Math.max(...h.slice(i - k, i + k + 1))) t.push([i, h[i]]);
    if (l[i] === Math.min(...l.slice(i - k, i + k + 1))) d.push([i, l[i]]);
  }
  return [t, d];
}
function zBolgeler(gun, hafta, atr) {
  const h = gun.h.slice(-252), l = gun.l.slice(-252), c = gun.c.slice(-252), n = c.length, nk = [];
  zSalinim(h, l).forEach(ls => ls.forEach(([i, p]) => nk.push([p, 1 + (i >= n - 63 ? 1 : 0)])));
  if (hafta && hafta.h && hafta.h.length > 10) zSalinim(hafta.h.slice(-156), hafta.l.slice(-156)).forEach(ls => ls.forEach(([, p]) => nk.push([p, 2])));
  nk.sort((a, b) => a[0] - b[0]);
  const tol = Math.min(0.5 * atr, 0.015 * c[n - 1]), gr = []; let b = [];
  for (const x of nk) { if (b.length && x[0] - b[0][0] > tol) { gr.push(b); b = []; } b.push(x); }
  if (b.length) gr.push(b);
  return gr.map(b => { const w = b.reduce((s, x) => s + x[1], 0), alt = b[0][0], ust = b[b.length - 1][0];
    return { fiyat: b.reduce((s, x) => s + x[0] * x[1], 0) / w, guc: w, tur: 'salınım', ad: alt === ust ? 'salınım ' + sayi(alt, 2) : 'bölge ' + sayi(alt, 2) + '–' + sayi(ust, 2) }; });
}
function zYonSkoru(g) {
  let s = 0; const n = [], f = g.fiyat;
  if (sayiMi(g.sma50)) { s += f > g.sma50 ? 20 : -20; n.push('fiyat SMA50\'nin ' + (f > g.sma50 ? 'üstünde' : 'altında')); }
  if (sayiMi(g.sma50) && sayiMi(g.sma200)) { s += g.sma50 > g.sma200 ? 20 : -20; n.push('SMA50 ' + (g.sma50 > g.sma200 ? '>' : '<') + ' SMA200'); }
  if (sayiMi(g.s200egim)) { const e = g.s200egim; s += e > 0.5 ? 10 : e < -0.5 ? -10 : 0; n.push('SMA200 eğimi ' + (e > 0.5 ? 'yukarı' : e < -0.5 ? 'aşağı' : 'yatay')); }
  if (sayiMi(g.hist)) { s += g.hist > 0 ? 15 : -15; n.push('MACD ' + (g.hist > 0 ? 'pozitif' : 'negatif') + (g.kesisim ? ' (' + (g.kesisim.gun ? g.kesisim.gun + ' gün önce ' : 'bugün ') + g.kesisim.yon + ' kesti)' : '')); }
  if (sayiMi(g.rsi)) { s += g.rsi >= 55 ? 15 : g.rsi <= 45 ? -15 : 0; n.push('RSI ' + sayi(g.rsi)); }
  if (sayiMi(g.adx)) { const guclu = g.adx >= 25, y = g.diArti > g.diEksi ? 1 : -1; s += (guclu ? 20 : 5) * y; n.push('ADX ' + sayi(g.adx) + ' (' + (guclu ? 'güçlü' : 'zayıf') + ' trend, ' + (y > 0 ? '+DI' : '−DI') + ' önde)'); }
  return { skor: Math.max(-100, Math.min(100, s)), nedenler: n };
}
function zPlan(alt, f, atr, destek, direnc, sigma30, uzak) {
  const koruma = alt ? destek : direnc, hedefTaraf = alt ? direnc : destek;
  const guclu = koruma.filter(x => x.guc >= 2 || x.tur !== 'salınım');
  const dayanak = guclu[0] || koruma[0] || null, notlar = [];
  let stop, stopNeden;
  if (dayanak) { stop = alt ? dayanak.fiyat - 0.5 * atr : dayanak.fiyat + 0.5 * atr; stopNeden = dayanak.ad + ' (' + sayi(dayanak.fiyat, 2) + ') ' + (alt ? 'altı − 0,5 ATR' : 'üstü + 0,5 ATR'); }
  else { stop = alt ? f - 2 * atr : f + 2 * atr; stopNeden = 'yakın seviye yok: 2 ATR'; }
  const risk = Math.abs(f - stop);
  let sikStop = null;
  if (risk > 3 * atr) { sikStop = alt ? f - 2 * atr : f + 2 * atr; notlar.push('Yapısal stop ' + sayi(risk / atr) + ' ATR uzakta; daha sıkı seçenek 2 ATR: ' + sayi(sikStop, 2) + '.'); }
  const rr = p => risk ? Math.abs(p - f) / risk : null;
  const hedefler = hedefTaraf.slice(0, 3).map(x => ({ ad: x.ad, fiyat: x.fiyat, rr: rr(x.fiyat) }));
  uzak.filter(u => alt ? u.fiyat > f : u.fiyat < f).forEach(u => hedefler.push({ ad: u.ad, fiyat: u.fiyat, rr: rr(u.fiyat), uzak: true }));
  const hm = alt ? f + sigma30 : f - sigma30;
  hedefler.push({ ad: '30 günlük 1σ hareket (HV20)', fiyat: hm, rr: rr(hm), olasilik: true });
  const yakin = hedefler.filter(h => !h.uzak && !h.olasilik);
  if (yakin.length && yakin[0].rr < 1.5) notlar.push('İlk hedefin R/R\'si ' + sayi(yakin[0].rr, 2) + ' (< 1,5): şu fiyattan giriş zayıf; geri çekilme beklenebilir.');
  if (!yakin.length) notlar.push('Bu yönde yakın teknik seviye yok (zirve/dip bölgesi); hedefler ATR ve uzak hedeflerden.');
  return { alt, giris: f, altGiris: koruma[0] ? koruma[0].fiyat : null, stop, stopNeden, risk, sikStop, hedefler, notlar };
}

// --- opsiyon (opsiyon.py ile aynı)
function zNcdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2); const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
function zBs(S, K, T, r, s, tip) {
  if (T <= 0 || s <= 0) return tip === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + s * s / 2) * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
  return tip === 'call' ? S * zNcdf(d1) - K * Math.exp(-r * T) * zNcdf(d2) : K * Math.exp(-r * T) * zNcdf(-d2) - S * zNcdf(-d1);
}
function zDelta(S, K, T, r, s, tip) { const d1 = (Math.log(S / K) + (r + s * s / 2) * T) / (s * Math.sqrt(T)); return tip === 'call' ? zNcdf(d1) : zNcdf(d1) - 1; }
function zIv(p, S, K, T, r, tip) { if (!(p > 0) || zBs(S, K, T, r, 5, tip) < p) return null; let lo = 0.01, hi = 5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (zBs(S, K, T, r, m, tip) > p) hi = m; else lo = m; } return (lo + hi) / 2; }
function zZincir(liste, tip, S, T, r) {
  return (liste || []).map(x => {
    const canli = x.b > 0 && x.a > 0, orta = canli ? (x.b + x.a) / 2 : x.s;
    let iv = x.iv > 0.01 ? x.iv : null; if (iv === null && orta > 0) iv = zIv(orta, S, x.k, T, r, tip);
    return { k: x.k, b: x.b, a: x.a, orta, canli, makas: canli && orta > 0 ? (x.a - x.b) / orta : null, iv, oi: x.oi || 0, delta: iv ? zDelta(S, x.k, T, r, iv, tip) : null };
  }).sort((a, b) => a.k - b.k);
}
function zLikidite(z, k) {
  const i = z.findIndex(x => x.k === k); if (i < 0) return [false, 'strike yok'];
  const x = z[i]; let oiOk = x.oi >= 500;
  if (!oiOk) { const kom = z.slice(Math.max(0, i - 2), i + 3); oiOk = kom.length === 5 && kom.every(y => y.oi >= 100); }
  const n = [];
  if (!oiOk) n.push('OI ' + x.oi + ' (< 500)');
  if (x.makas === null) n.push('canlı alış/satış yok'); else if (x.makas > 0.10) n.push('makas %' + Math.round(x.makas * 100) + ' (> %10)');
  return [oiOk && x.makas !== null && x.makas <= 0.10, n.join(', ') || 'uygun'];
}
const zEnYakin = (z, hedef, kosul) => { const d = z.filter(x => x.orta > 0 && (!kosul || kosul(x))); return d.length ? d.reduce((a, b) => Math.abs(b.k - hedef) < Math.abs(a.k - hedef) ? b : a) : null; };
const zDeltaIle = (z, hd) => { const d = z.filter(x => x.orta > 0 && sayiMi(x.delta)); return d.length ? d.reduce((a, b) => Math.abs(Math.abs(b.delta) - hd) < Math.abs(Math.abs(a.delta) - hd) ? b : a) : null; };
const zBacak = (x, islem, tip) => ({ islem, tip, k: x.k, orta: x.orta, delta: x.delta, iv: x.iv, oi: x.oi, canli: x.canli });
function zKz(bacaklar, f) { let t = 0; for (const b of bacaklar) { const ic = b.tip === 'call' ? Math.max(0, f - b.k) : Math.max(0, b.k - f); t += b.islem === 'al' ? ic - b.orta : b.orta - ic; } return t * 100; }
function zUst(S, K, T, s) { if (T <= 0 || s <= 0) return S > K ? 1 : 0; return zNcdf((Math.log(S / K) - s * s / 2 * T) / (s * Math.sqrt(T))); }
function zYapi(ad, bacaklar, c) {
  const { S, hedef, stop, T, sigma, z } = c, kredi = bacaklar.some(b => b.islem === 'sat') && bacaklar.reduce((s, b) => s + (b.islem === 'al' ? b.orta : -b.orta), 0) < 0;
  const net = bacaklar.reduce((s, b) => s + (b.islem === 'al' ? b.orta : -b.orta), 0);
  const N = 1401, grid = Array.from({ length: N }, (_, i) => S * 0.3 + (S * 1.7) * i / (N - 1)), pl = grid.map(x => zKz(bacaklar, x));
  const maksKar = Math.max(...pl), maksZarar = Math.min(...pl), sinirsiz = pl[N - 1] > pl[N - 50] + 1 && pl[N - 1] === maksKar;
  const bb = []; for (let i = 0; i < N - 1; i++) if (pl[i] * pl[i + 1] < 0) bb.push(grid[i] + (grid[i + 1] - grid[i]) * (-pl[i]) / (pl[i + 1] - pl[i]));
  let pop;
  if (bb.length) { const nk = [S * 0.3, ...bb, S * 2]; pop = 0; for (let i = 0; i < nk.length - 1; i++) if (zKz(bacaklar, (nk[i] + nk[i + 1]) / 2) > 0) pop += zUst(S, nk[i], T, sigma) - zUst(S, nk[i + 1], T, sigma); }
  else pop = maksZarar > 0 ? 1 : 0;
  const u = [];
  bacaklar.forEach(b => { const [ok, n] = zLikidite(z[b.tip], b.k); if (!ok) u.push('Likidite (' + b.islem + ' ' + b.k + ' ' + b.tip + '): ' + n);
    if (kredi && b.islem === 'sat' && sayiMi(b.delta) && (Math.abs(b.delta) < 0.2 || Math.abs(b.delta) > 0.3)) u.push('Kısa bacak deltası ' + nf(2).format(Math.abs(b.delta)) + ' (kural 0,20–0,30)'); });
  const st = [...new Set(bacaklar.map(b => b.k))].sort((a, b) => a - b);
  if (st.length > 1) { const gen = Math.max(...st.slice(1).map((v, i) => v - st[i])); if (gen > 0.04 * S) u.push('Spread genişliği ' + gen + ' $ = fiyatın %' + nf(1).format(gen / S * 100) + '\'i (kural ≤ %4)'); }
  const hk = zKz(bacaklar, hedef);
  return { ad, bacaklar, net: net * 100, kredi, maksKar: sinirsiz ? null : maksKar, maksZarar, bb, hedefKz: hk, stopKz: zKz(bacaklar, stop), pop, rr: maksZarar < 0 ? hk / -maksZarar : null, uyarilar: u, geriAlim: kredi ? -net / 2 : null };
}
function zVadeSec(vadeler, bilanco) {
  const u = [], aday = vadeler.map(v => [v, kalanGun(v)]);
  const uygun = aday.filter(x => x[1] >= 21 && x[1] <= 45), temiz = uygun.filter(x => !(bilanco && bilanco >= bugunStr() && bilanco <= x[0]));
  const havuz = temiz.length ? temiz : uygun.length ? uygun : aday;
  if (!temiz.length && uygun.length) u.push('21–45 gün aralığındaki tüm vadeler bilançoyu kapsıyor.');
  if (!uygun.length) u.push('21–45 gün aralığında vade yok; 30 güne en yakın seçildi.');
  return [havuz.reduce((a, b) => Math.abs(b[1] - 30) < Math.abs(a[1] - 30) ? b : a)[0], u];
}
function zOpsiyonHesapla(oz, c) {
  const { S, T, r, yon, hedef, stop } = c;
  const z = { call: zZincir(oz.call, 'call', S, T, r), put: zZincir(oz.put, 'put', S, T, r) };
  const atm = ['call', 'put'].map(tp => zEnYakin(z[tp], S)).filter(x => x && sayiMi(x.iv));
  const sigma = atm.length ? atm.reduce((s, x) => s + x.iv, 0) / atm.length : c.hv20;
  const ac = zEnYakin(z.call, S), ap = zEnYakin(z.put, S), straddle = ac && ap ? ac.orta + ap.orta : null;
  let ivd, olcut;
  if (sayiMi(c.ivRank)) { ivd = c.ivRank >= 50 ? 'pahalı' : c.ivRank <= 25 ? 'ucuz' : 'normal'; olcut = 'IV rank ' + c.ivRank; }
  else { const o = c.hv20 ? sigma / c.hv20 : null; ivd = o >= 1.25 ? 'pahalı' : o !== null && o <= 0.9 ? 'ucuz' : 'normal'; olcut = o !== null ? 'IV/HV20 = ' + nf(2).format(o) + ' (IV rank girilmedi)' : 'hesaplanamadı'; }
  const ctx = { S, hedef, stop, T, sigma, z }, yapilar = [];
  if (yon === 'yukari' || yon === 'asagi') {
    const alt = yon === 'yukari', tip = alt ? 'call' : 'put', karsi = alt ? 'put' : 'call', df = z[tip], dk = z[karsi];
    const uzun = zDeltaIle(df, 0.6); if (uzun) yapilar.push(zYapi('Uzun ' + tip + ' (~0,60 delta)', [zBacak(uzun, 'al', tip)], ctx));
    const al = zEnYakin(df, S);
    const sat = al ? zEnYakin(df, hedef, x => alt ? x.k > al.k : x.k < al.k) : null;
    const etk = alt ? 'Boğa call' : 'Ayı put';
    if (al && sat && sat.k !== al.k) yapilar.push(zYapi(etk + ' spread (borç): ATM al, hedefte sat', [zBacak(al, 'al', tip), zBacak(sat, 'sat', tip)], ctx));
    if (al) { const sinir = alt ? al.k + 0.04 * S : al.k - 0.04 * S;
      const dar = zEnYakin(df, sinir, x => alt ? x.k > al.k && x.k <= sinir : x.k < al.k && x.k >= sinir);
      if (dar && (!sat || dar.k !== sat.k)) yapilar.push(zYapi(etk + ' spread (borç, ≤ %4 genişlik)', [zBacak(al, 'al', tip), zBacak(dar, 'sat', tip)], ctx)); }
    const otesi = dk.filter(x => (alt ? x.k <= stop : x.k >= stop) && sayiMi(x.delta) && x.orta > 0);
    const kisa = otesi.length ? otesi.reduce((a, b) => Math.abs(Math.abs(b.delta) - 0.25) < Math.abs(Math.abs(a.delta) - 0.25) ? b : a) : zDeltaIle(dk, 0.25);
    if (kisa) { const uk = zEnYakin(dk, alt ? kisa.k - 0.04 * S : kisa.k + 0.04 * S, x => alt ? x.k < kisa.k : x.k > kisa.k);
      if (uk) yapilar.push(zYapi((alt ? 'Boğa put' : 'Ayı call') + ' spread (kredi): kısa bacak stop\'un ötesinde', [zBacak(kisa, 'sat', karsi), zBacak(uk, 'al', karsi)], ctx)); }
  } else {
    const kp = zDeltaIle(z.put.filter(x => x.k <= c.alt), 0.25) || zDeltaIle(z.put, 0.25), kc = zDeltaIle(z.call.filter(x => x.k >= c.ust), 0.25) || zDeltaIle(z.call, 0.25);
    if (kp && kc) { const up = zEnYakin(z.put, kp.k - 0.04 * S, x => x.k < kp.k), uc = zEnYakin(z.call, kc.k + 0.04 * S, x => x.k > kc.k);
      if (up && uc) yapilar.push(zYapi('Demir kondor (kredi): kısa bacaklar destek/direnç dışında', [zBacak(up, 'al', 'put'), zBacak(kp, 'sat', 'put'), zBacak(kc, 'sat', 'call'), zBacak(uc, 'al', 'call')], { ...ctx, hedef: S, stop: c.ust })); }
  }
  const sira = y => ivd === 'pahalı' ? [y.kredi ? 0 : y.bacaklar.length === 1 ? 2 : 1, y.uyarilar.length] : ivd === 'ucuz' ? [y.kredi ? 2 : 0, y.uyarilar.length] : [y.uyarilar.length, 0];
  yapilar.sort((a, b) => { const x = sira(a), y = sira(b); return x[0] - y[0] || x[1] - y[1]; });
  if (ivd === 'pahalı') yapilar.forEach(y => { if (y.bacaklar.length === 1) y.uyarilar.push('Opsiyonlar pahalı: kural tanımlı riskli yapı istiyor.'); });
  return { sigma, straddle, ivd, olcut, boyut: { ucuz: 0.5, normal: 1, pahalı: 0.6 }[ivd], yapilar, canliYok: !z.call.some(x => x.canli) };
}

// --- GEX / VEX (araclar/hisse_akisi/gex.py ile AYNI; birinde kural değişirse diğerini de güncelleyin)
// Varsayım: piyasa yapıcı call'da alıcı (+), put'ta satıcı (−). Vadeler 0–45 gün (NY tarihi), strike spot ±%25.
function zGexBacaklar(gx, S, r) {
  const out = [];
  for (const v of gx.vadeler || []) {
    const gun = Math.round((Date.parse(v.vade + 'T00:00:00Z') - Date.parse(gx.bugun + 'T00:00:00Z')) / 864e5);
    if (gun < 0 || gun > 45) continue;
    const T = Math.max(gun, 1) / 365;
    for (const tip of ['call', 'put']) for (const [k, b, a, s, ivh, oi] of v[tip] || []) {
      if (!(oi > 0) || k < S * 0.75 || k > S * 1.25) continue;
      const orta = b > 0 && a > 0 ? (b + a) / 2 : s;
      const iv = ivh > 0.01 ? ivh : zIv(orta, S, k, T, r, tip);
      if (!iv || iv >= 4.99) continue;
      out.push({ k, tip, oi, iv, T, isaret: tip === 'call' ? 1 : -1 });
    }
  }
  return out;
}
function zMaruziyet(b, P, r) {
  const sq = b.iv * Math.sqrt(b.T), d1 = (Math.log(P / b.k) + (r + b.iv * b.iv / 2) * b.T) / sq, d2 = d1 - sq;
  const phi = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI), n = b.isaret * b.oi * 100;
  return [n * phi / (P * sq) * P * P * 0.01, n * (-phi * d2 / b.iv) * P * 0.01];
}
function zGex(gx, S, r) {
  const bac = zGexBacaklar(gx, S, r);
  if (!bac.length) return { veriYok: true };
  const st = new Map(); let tg = 0, tv = 0;
  for (const b of bac) {
    const [g, v] = zMaruziyet(b, S, r); tg += g; tv += v;
    const s = st.get(b.k) || { k: b.k, call: 0, put: 0, net: 0 }; s[b.tip] += g; s.net += g; st.set(b.k, s);
  }
  const izgara = Array.from({ length: 81 }, (_, i) => S * (0.80 + 0.005 * i));
  const egri = izgara.map(P => bac.reduce((t, b) => t + zMaruziyet(b, P, r)[0], 0));
  let flip = null, eniyi = null;
  for (let i = 0; i < izgara.length - 1; i++) if (egri[i] === 0 || egri[i] * egri[i + 1] < 0) {
    const x = egri[i + 1] !== egri[i] ? izgara[i] + (izgara[i + 1] - izgara[i]) * (-egri[i]) / (egri[i + 1] - egri[i]) : izgara[i];
    if (eniyi === null || Math.abs(x - S) < eniyi) { flip = x; eniyi = Math.abs(x - S); }
  }
  const sl = [...st.values()], ust = sl.filter(s => s.k >= S), alt = sl.filter(s => s.k <= S);
  const callD = (ust.length ? ust : sl).reduce((a, b) => b.call > a.call ? b : a), putD = (alt.length ? alt : sl).reduce((a, b) => b.put < a.put ? b : a);
  const toplamOi = bac.reduce((t, b) => t + b.oi, 0), rejim = tg > 0 ? 'artı' : 'eksi';
  return { spot: S, vadeSay: (gx.vadeler || []).length, bacakSay: bac.length, toplamOi, veriZayif: toplamOi < 10000 || bac.length < 20,
    gex: tg, vex: tv, rejim, flip, callDuvar: callD.k, putDuvar: putD.k,
    enGuclu: sl.sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 5),
    rejimYorum: rejim === 'artı' ? 'Artı gamma: piyasa yapıcı düşüşte alır, yükselişte satar; fiyat sakinleşmeye ve duvarlar arasında kalmaya eğilimli.'
      : 'Eksi gamma: piyasa yapıcı düşüşte satar, yükselişte alır; hareketler hızlanabilir, trend sertleşebilir.',
    vannaYorum: tv > 0 ? 'VEX artı: IV düşerse (ör. bilanço sonrası) piyasa yapıcı alımı beklenir (destek); IV yükselirse satış baskısı.'
      : 'VEX eksi: IV düşerse piyasa yapıcı satışı beklenir; IV yükselirse alım.',
    opsiyonNotu: rejim === 'artı' ? 'Artı gamma: fiyat sıkışmaya eğilimli; kredi yapıları ve demir kondor bu ortama daha uygun.'
      : 'Eksi gamma: sert hareket olasılığı yüksek; uzun opsiyon ve borçlu spread\'ler bu ortama daha uygun, kredi yapılarında dikkat.' };
}
function zGexUyarilar(x, yukari, f, hedef, stop) {
  if (!x || x.veriYok) return [];
  const u = [], s2 = v => sayi(v, 2);
  if (yukari && sayiMi(hedef) && hedef > x.callDuvar) u.push(`Hedef (${s2(hedef)}) call duvarının (${s2(x.callDuvar)}) ötesinde: duvar direnç gibi çalışabilir.`);
  if (!yukari && sayiMi(hedef) && hedef < x.putDuvar) u.push(`Hedef (${s2(hedef)}) put duvarının (${s2(x.putDuvar)}) ötesinde: duvar destek gibi çalışabilir.`);
  if (sayiMi(x.flip) && sayiMi(stop)) {
    if (yukari && stop < x.flip && x.flip < f) u.push(`Fiyat stopa giderken sıfır gamma seviyesinin (${s2(x.flip)}) altına iner: düşüş hızlanabilir, stop kayabilir.`);
    if (!yukari && f < x.flip && x.flip < stop) u.push(`Fiyat stopa giderken sıfır gamma seviyesinin (${s2(x.flip)}) üstüne çıkar: yükseliş hızlanabilir, stop kayabilir.`);
  }
  if (sayiMi(x.flip) && x.rejim === 'eksi' && f < x.flip) u.push(`Fiyat sıfır gamma seviyesinin (${s2(x.flip)}) altında: eksi gamma bölgesi.`);
  if (x.veriZayif) u.push('Opsiyon verisi zayıf (açık pozisyon az): GEX/VEX güvenilir değil.');
  return u;
}
const zMilyon = v => (v < 0 ? '−' : '+') + '$' + nf(Math.abs(v) >= 1e9 ? 2 : 0).format(Math.abs(v) >= 1e9 ? Math.abs(v) / 1e9 : Math.abs(v) / 1e6) + (Math.abs(v) >= 1e9 ? ' mr' : ' mn');

// --- ekranlar
function ekranZincir(main, param, yenile) {
  const t = kod(param);
  if (t) return zincirHisse(main, t, yenile);
  const son = depo.al('zTarama', null);
  main.innerHTML = `
  <form class="kart" id="z-form"><h2>⛓️ Hisse akışı <small>· 1. adım: tarama</small></h2>
    <p class="alt" style="margin-top:0">Tarama → seçim → temel + teknik → yön → hedef/stop → opsiyon.</p>
    <label>Hazır kriter<select id="z-hazir"><option value="">— seç ya da kodları yaz —</option>${ZINCIR_HAZIR.map(([ad, f]) => `<option value="${esc(f)}">${esc(ad)}</option>`).join('')}</select></label>
    <label>FinViz filtre kodları <small>(virgülle; boş = yalnız trend)</small><input id="z-filtre" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ör. cap_largeover,ta_rsi_os30" value="${esc((son && son.filtre) || '')}"></label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="z-trend" ${!son || son.trend ? 'checked' : ''} style="width:auto"> Reddit + StockTwits trend listesi</label>
    <div class="dugmeler"><button class="dugme" type="submit">Tara</button><span class="bosluk"></span><span class="alt">${son ? 'son tarama ' + onceSure(son.zaman) : ''}</span></div>
  </form>
  <form class="kart ara" id="z-kod"><input id="z-kod-in" placeholder="ya da hisse kodu (ör. TSLA)" autocomplete="off" autocapitalize="characters" maxlength="10" aria-label="Hisse kodu"><button class="dugme" type="submit">Akışa başla</button></form>
  <div id="z-sonuc"></div>`;
  $('#z-hazir', main).onchange = e => { if (e.target.value) $('#z-filtre', main).value = e.target.value; };
  $('#z-kod', main).onsubmit = e => { e.preventDefault(); const v = kod($('#z-kod-in', main).value); if (v) location.hash = 'zincir/' + encodeURIComponent(v); };
  const sonucEl = $('#z-sonuc', main);
  if (son) zTaramaCiz(sonucEl, son);
  $('#z-form', main).onsubmit = async e => {
    e.preventDefault();
    const filtre = $('#z-filtre', main).value.trim().replace(/\s+/g, ''), trend = $('#z-trend', main).checked;
    if (!filtre && !trend) { bildir('Filtre yaz ya da trend listesini seç.'); return; }
    sonucEl.innerHTML = '<div class="kart yukleniyor">Taranıyor… (20–40 sn sürebilir)</div>';
    try {
      const p = { islem: 'tarama', adet: 20 }; if (filtre) p.finviz = filtre; if (trend) p.trend = '1';
      const v = await zincirAl(p, 10 * 6e4, true);
      const kayit = { filtre, trend, zaman: new Date().toISOString(), v };
      depo.koy('zTarama', kayit);
      if (aktif.ad === 'zincir') zTaramaCiz(sonucEl, kayit);
    } catch (err) { sonucEl.innerHTML = hataKutusu(err); }
  };
}
function zTaramaCiz(el, k) {
  const v = k.v, ad = v.adaylar || [];
  el.innerHTML = `<div class="kart"><h2>2. adım: seç <small>· ${ad.length} aday</small></h2>
    ${(v.hatalar || []).length ? `<div class="uyari">⚠️ ${esc(v.hatalar.join(' · '))}</div>` : ''}
    <p class="alt" style="margin-top:0">İncelemek istediğine dokun. Sıra: 1A değişim · RSI · SMA50'ye uzaklık · zirveden uzaklık.${v.adres ? ` <a href="${esc(v.adres)}" target="_blank" rel="noopener">FinViz'de aç ↗</a>` : ''}</p>
    <ul class="liste">${ad.map(x => `<li class="satir" onclick="location.hash='zincir/${encodeURIComponent(x.ticker)}'">
      <div class="sol"><div class="kod">${esc(x.ticker)} ${x.kaynak.map(s => `<span class="cip${x.kaynak.length > 1 ? ' yesil' : ''}">${esc(s)}</span>`).join(' ')}</div>
        <div class="alt">${esc(x.sirket || '')}${x.sektor ? ' · ' + esc(x.sektor) : ''}${x.piyasa_degeri ? ' · ' + esc(x.piyasa_degeri) : ''}</div>
        <div class="alt">${sayiMi(x.degisim_1a) ? yuzde(x.degisim_1a / 100) + ' 1A' : ''}${sayiMi(x.rsi14) ? ' · RSI ' + sayi(x.rsi14) : ''}${sayiMi(x.sma50) ? ' · SMA50 ' + yuzde(x.sma50 / 100) : ''}${sayiMi(x.zirve) ? ' · zirve ' + yuzde(x.zirve / 100) : ''}</div>
        ${x.not ? `<div style="margin-top:3px"><span class="cip sari">⚠️ ${esc(x.not)}</span></div>` : ''}</div>
      <div class="sag"><div class="kod">${usd(x.fiyat)}</div></div></li>`).join('')}</ul>
    <p class="alt" style="margin:10px 0 0">ETF ve endeksler (SPY, QQQ…) trend listesinde çıkabilir. Kaynaklar: FinViz, ApeWisdom (Reddit), StockTwits, Yahoo (~15 dk gecikmeli). Yatırım tavsiyesi değildir.</p></div>`;
}

async function zincirHisse(main, t, yenile) {
  main.innerHTML = `<div class="kart" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <a href="#zincir">← Tarama</a><a href="#analiz/${encodeURIComponent(t)}">Tam analiz →</a></div>
    <div id="z-ust"><div class="kart yukleniyor">${esc(t)} yükleniyor… (Finnhub + fiyat geçmişi)</div></div>
    <div id="z-temel"></div><div id="z-teknik"></div><div id="z-gex"></div><div id="z-plan"></div><div id="z-ops"></div>`;
  if (!veriVarMi()) return anahtarYok($('#z-ust', main));
  if (ayarlar().demo) { $('#z-ust', main).innerHTML = '<div class="uyari">Zincir örnek veri modunda çalışmaz; Ayarlar\'dan Finnhub anahtarını gir.</div>'; return; }
  let m, q, pr, kz, tk, gc;
  try {
    [m, q, pr, kz, tk, gc] = await Promise.all([api.metrik(t, yenile), api.fiyat(t, yenile), api.profil(t, yenile).catch(() => ({})),
      api.kazanc(t, yenile).catch(() => []), api.takvim(t, yenile).catch(() => null), zincirAl({ islem: 'gecmis', t }, 15 * 6e4, yenile)]);
  } catch (e) { $('#z-ust', main).innerHTML = e.message === 'ANAHTAR' ? '' : hataKutusu(e); return; }
  if (aktif.ad !== 'zincir' || kod(aktif.param) !== t) return;
  kz = Array.isArray(kz) ? kz : []; pr = pr || {}; q = q || {};

  // 3a) Temel
  const T = temelHesapla(t, m, q, pr, kz);
  // 3b) Teknik + seviyeler
  const g = zGostergeler(gc.gun), f = g.fiyat, atr = g.atr;
  const sev = zBolgeler(gc.gun, gc.hafta, atr);
  [['SMA50', g.sma50], ['SMA200', g.sma200], ['52H zirve', g.hi52], ['52H dip', g.lo52]].forEach(([ad, v]) => { if (sayiMi(v)) sev.push({ fiyat: v, guc: 2, tur: ad, ad }); });
  const esik = 0.25 * atr;
  const destek = sev.filter(s => s.fiyat < f - esik).sort((a, b) => b.fiyat - a.fiyat);
  const direnc = sev.filter(s => s.fiyat > f + esik).sort((a, b) => a.fiyat - b.fiyat);
  const test = sev.filter(s => Math.abs(s.fiyat - f) <= esik);
  // 4) Yön
  const ys = zYonSkoru(g);
  const teknikYon = ys.skor >= 25 ? 'Yukarı' : ys.skor <= -25 ? 'Aşağı' : 'Yatay / kararsız';
  const bp = T.sen.beklenenPot;
  const temelIsaret = T.sorunlar.length || !sayiMi(bp) ? null : bp > 0.10 ? 'yukarı' : bp < -0.10 ? 'aşağı' : 'nötr';
  const uyum = temelIsaret === null ? 'temel veri yetersiz' : temelIsaret === 'nötr' ? 'temel nötr' : (temelIsaret === 'yukarı') === (ys.skor > 0) ? 'uyumlu' : 'çelişkili';
  const uzak = [];
  if (!T.sorunlar.length) {
    if (sayiMi(T.sen.beklenen)) uzak.push({ ad: 'Temel beklenen değer', fiyat: T.sen.beklenen });
    if (sayiMi(T.sen.satirlar[0].hedef)) uzak.push({ ad: 'Temel kötümser senaryo', fiyat: T.sen.satirlar[0].hedef });
    if (sayiMi(T.sen.satirlar[2].hedef)) uzak.push({ ad: 'Temel iyimser senaryo', fiyat: T.sen.satirlar[2].hedef });
  }
  const sigma30 = f * g.hv20 * Math.sqrt(30 / 365);
  const plan = { yukari: zPlan(true, f, atr, destek, direnc, sigma30, uzak), asagi: zPlan(false, f, atr, destek, direnc, sigma30, uzak) };
  const varsayilanYon = ys.skor >= 0 ? 'yukari' : 'asagi';

  $('#z-ust', main).innerHTML = `${T.sorunlar.length ? `<div class="uyari kirmizi-kutu" role="alert"><b>⚠️ Veri tutarsız</b> — ${esc(T.sorunlar.join(' · '))}. Temel hedefleri kullanmayın.</div>` : ''}
  <div class="kart"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
    <div><h2 style="margin:0;font-size:19px;color:var(--metin)">${esc(t)} · ${tarihTR(bugunStr())}</h2><div class="alt">${esc(pr.name || '')}${pr.finnhubIndustry ? ' · ' + esc(pr.finnhubIndustry) : ''}</div></div>
    <div class="sag"><div class="buyuk">${usd(T.fiyat ?? f)}</div><div class="alt ${renk(q.dp)}">${sayiMi(q.dp) ? yuzde(q.dp / 100, 2) + ' bugün' : ''}</div></div></div>
    ${tk ? `<p class="alt" style="margin:8px 0 0">📅 Sıradaki bilanço ${tarihTR(tk.date)} (${kalanGun(tk.date)} gün · ${SAAT[tk.hour] || 'saat belirsiz'})</p>` : ''}</div>`;

  $('#z-temel', main).innerHTML = `<div class="kart"><h2>3. Temel <small>· Borsa Defteri yöntemi</small></h2>
    <div class="uc"><div><div class="etiket">Bileşik puan</div><div class="sayi"><b>${T.p.bilesik ?? '—'}</b> <span class="alt">${yorum(T.p.bilesik)}</span></div>
      <div class="alt">${BOYUTLAR.map(b => b[0] + ' ' + (T.p.boyut[b] ?? '—')).join(' · ')}</div></div>
      <div><div class="etiket">Beklenen değer</div><div class="sayi">${usd(T.sen.beklenen)}</div><div class="alt ${renk(bp)}">${yuzde(bp)}</div></div>
      <div><div class="etiket">Tutarlılık</div><div class="sayi"><span class="cip ${T.tut.sinif}">${T.tut.seviye}</span></div><div class="alt">DCF ${T.dcf ? usd(T.dcf.hisseBasi) : '—'}</div></div></div>
    <p style="margin:10px 0 4px">${T.elenen >= 0 ? `<span class="cip kirmizi">⛔ ${T.elenen + 1}. adımda elendi: ${esc(T.akis[T.elenen].ad)}</span>` : `<span class="cip ${T.dikkatSay ? 'sari' : 'yesil'}">${T.dikkatSay ? '⚠️ ' + T.dikkatSay + ' adımda dikkat' : '✅ Eleme akışını geçti'}</span>`}
      <span class="cip ${T.bayrakSay > 2 ? 'kirmizi' : T.bayrakSay ? 'sari' : 'yesil'}">🚩 ${T.bayrakSay} bayrak</span></p>
    <ul class="alt" style="margin:4px 0 0;padding-left:18px">${T.akis.filter(x => x.durum === 'elendi' || x.durum === 'dikkat').map(x => `<li>${DURUM[x.durum][0]} <b>${esc(x.ad)}</b>: ${esc(x.deger)}</li>`).join('')}
      ${sayiMi(T.rd.g) ? `<li>Fiyatlanan FCF büyümesi ${yuzde(T.rd.g)} · baz senaryo ${yuzde(T.sen.g)}</li>` : ''}</ul></div>`;

  $('#z-teknik', main).innerHTML = `<div class="kart"><h2>3. Teknik · 4. Yön</h2>
    <div class="uc"><div><div class="etiket">SMA20 / 50 / 200</div><div class="sayi">${sayi(g.sma20, 0)} / ${sayi(g.sma50, 0)} / ${sayi(g.sma200, 0)}</div></div>
      <div><div class="etiket">RSI · ADX</div><div class="sayi">${sayi(g.rsi)} · ${sayi(g.adx)}</div><div class="alt">+DI ${sayi(g.diArti)} / −DI ${sayi(g.diEksi)}</div></div>
      <div><div class="etiket">ATR · HV20</div><div class="sayi">${sayi(atr, 2)} (%${nf(1).format(atr / f * 100)})</div><div class="alt">HV20 %${nf(0).format(g.hv20 * 100)}</div></div></div>
    <p style="margin:10px 0 4px"><span class="cip ${ys.skor >= 25 ? 'yesil' : ys.skor <= -25 ? 'kirmizi' : 'sari'}">Teknik: ${teknikYon} (${ys.skor > 0 ? '+' : ''}${ys.skor})</span>
      <span class="cip">Temel: ${temelIsaret || '—'}</span> <span class="cip ${uyum === 'uyumlu' ? 'yesil' : uyum === 'çelişkili' ? 'kirmizi' : ''}">${uyum}</span></p>
    <p class="alt" style="margin:0">${esc(ys.nedenler.join(' · '))}</p>
    <div class="iki" style="margin-top:10px"><div><div class="etiket">Dirençler</div>${direnc.slice(0, 3).map(s => `<div class="alt">${sayi(s.fiyat, 2)} <small>· ${esc(s.tur === 'salınım' ? 'güç ' + s.guc : s.ad)}</small></div>`).join('') || '<div class="alt">—</div>'}</div>
      <div><div class="etiket">Destekler</div>${destek.slice(0, 3).map(s => `<div class="alt">${sayi(s.fiyat, 2)} <small>· ${esc(s.tur === 'salınım' ? 'güç ' + s.guc : s.ad)}</small></div>`).join('') || '<div class="alt">—</div>'}</div></div>
    ${test.length ? `<p class="alt" style="margin:6px 0 0">Şu an test edilen: ${test.map(s => esc(s.ad)).join(', ')}</p>` : ''}</div>`;

  const durum = { yon: varsayilanYon, hedef: null, stop: null, ivRank: null, vade: null };
  const planCiz = () => {
    const pl = plan[durum.yon === 'asagi' ? 'asagi' : 'yukari'];
    const yakin = pl.hedefler.filter(h => !h.uzak && !h.olasilik), iyi = yakin.filter(h => h.rr >= 1.5);
    if (durum.hedef === null) durum.hedef = Math.round((iyi[0] || yakin[yakin.length - 1] || pl.hedefler[0]).fiyat * 100) / 100;
    if (durum.stop === null) durum.stop = Math.round(pl.stop * 100) / 100;
    $('#z-plan', main).innerHTML = `<div class="kart"><h2>5. Spot plan <small>· ${pl.alt ? 'Yukarı (alış)' : 'Aşağı (düşüş)'}</small></h2>
      <div class="uc"><div><div class="etiket">Giriş</div><div class="sayi">${usd(pl.giris)}</div>${sayiMi(pl.altGiris) ? `<div class="alt">alternatif ${usd(pl.altGiris)}</div>` : ''}</div>
        <div><div class="etiket">Stop</div><div class="sayi">${usd(pl.stop)}</div><div class="alt">risk %${nf(1).format(pl.risk / f * 100)} · ${nf(1).format(pl.risk / atr)} ATR</div></div>
        <div><div class="etiket">30g 1σ</div><div class="sayi">±${usd(sigma30)}</div><div class="alt">%${nf(1).format(sigma30 / f * 100)} (HV20)</div></div></div>
      <p class="alt" style="margin:6px 0">Stop: ${esc(pl.stopNeden)}${sayiMi(pl.sikStop) ? ' · sıkı stop ' + usd(pl.sikStop) : ''}</p>
      <div class="kaydir"><table class="tablo"><thead><tr><th>Hedef</th><th>Fiyat</th><th>%</th><th>R/R</th></tr></thead><tbody>
        ${pl.hedefler.map(h => `<tr><td>${esc(h.ad)}${h.uzak ? ' <span class="alt">uzak</span>' : ''}</td><td>${usd(h.fiyat)}</td><td class="${renk(h.fiyat - f)}">${yuzde(h.fiyat / f - 1)}</td><td><b>${sayi(h.rr, 2)}</b></td></tr>`).join('')}
      </tbody></table></div>
      ${pl.notlar.map(n => `<div class="uyari">⚠️ ${esc(n)}</div>`).join('')}
      ${zGexUyarilar(durum.gex, pl.alt, f, durum.hedef, durum.stop).map(n => `<div class="uyari">🧲 GEX: ${esc(n)}</div>`).join('')}</div>`;
  };
  planCiz();

  // 4b) Opsiyon pozisyonlanması (GEX/VEX) — arka planda; gelince plan ve opsiyon kartı yenilenir
  let opsCiz = null;
  const gexEl = $('#z-gex', main);
  gexEl.innerHTML = '<div class="kart yukleniyor">GEX/VEX hesaplanıyor… (45 güne kadar tüm vadeler)</div>';
  zincirAl({ islem: 'gex', t }, 15 * 6e4, yenile).then(gx => {
    if (aktif.ad !== 'zincir' || kod(aktif.param) !== t) return;
    const r = sayiMi(gc.irx) ? gc.irx / 100 : 0.045, x = zGex(gx, f, r);
    durum.gex = x;
    if (x.veriYok) { gexEl.innerHTML = '<div class="kart"><h2>4b. Opsiyon pozisyonlanması</h2><p class="alt">45 gün içinde hesaplanabilir opsiyon verisi yok.</p></div>'; return; }
    gexEl.innerHTML = `<div class="kart"><h2>4b. Opsiyon pozisyonlanması <small>· GEX / VEX</small></h2>
      <p style="margin:0 0 6px"><span class="cip ${x.rejim === 'artı' ? 'yesil' : 'kirmizi'}">${x.rejim === 'artı' ? 'Artı' : 'Eksi'} gamma</span>
        <span class="cip">VEX ${x.vex > 0 ? 'artı' : 'eksi'}</span>${x.veriZayif ? ' <span class="cip sari">⚠️ veri zayıf</span>' : ''}</p>
      <div class="uc"><div><div class="etiket">Toplam GEX</div><div class="sayi">${zMilyon(x.gex)}</div><div class="alt">%1 harekette hedge</div></div>
        <div><div class="etiket">Toplam VEX</div><div class="sayi">${zMilyon(x.vex)}</div><div class="alt">IV +1 puanda delta</div></div>
        <div><div class="etiket">Sıfır gamma</div><div class="sayi">${sayiMi(x.flip) ? usd(x.flip) : '—'}</div><div class="alt">${sayiMi(x.flip) ? yuzde(x.flip / f - 1) + ' uzakta' : '±%20 içinde yok'}</div></div></div>
      <div class="iki" style="margin-top:8px"><div><div class="etiket">Call duvarı (direnç)</div><div class="sayi">${usd(x.callDuvar)}</div></div>
        <div><div class="etiket">Put duvarı (destek)</div><div class="sayi">${usd(x.putDuvar)}</div></div></div>
      <p class="alt" style="margin:8px 0 2px">${esc(x.rejimYorum)}</p><p class="alt" style="margin:0 0 4px">${esc(x.vannaYorum)}</p>
      <p class="alt" style="margin:0">En yoğun strike'lar: ${x.enGuclu.map(s => `${String(s.k).replace('.', ',')} (${zMilyon(s.net)})`).join(' · ')}</p>
      <p class="alt" style="margin:6px 0 0">${x.vadeSay} vade · ${nf(0).format(x.toplamOi)} açık pozisyon. Varsayım: piyasa yapıcı call'da alıcı, put'ta satıcı; gerçek pozisyon bilinmez. Açık pozisyon önceki kapanıştan. Tahmindir, yön skoruna katılmaz. Yatırım tavsiyesi değildir.</p></div>`;
    planCiz(); if (opsCiz) opsCiz();
  }).catch(e => { if (aktif.ad === 'zincir') gexEl.innerHTML = `<div class="kart"><h2>4b. Opsiyon pozisyonlanması</h2>${hataKutusu(e)}</div>`; });

  // 6) Opsiyon
  const ops = $('#z-ops', main);
  ops.innerHTML = '<div class="kart yukleniyor">Opsiyon zinciri yükleniyor…</div>';
  let oz;
  try {
    oz = await zincirAl({ islem: 'opsiyon', t }, 5 * 6e4, yenile);
    const [vade, vu] = zVadeSec(oz.vadeler || [], tk ? tk.date : null);
    durum.vadeUyari = vu;
    if (vade && vade !== oz.vade) oz = await zincirAl({ islem: 'opsiyon', t, vade }, 5 * 6e4, yenile);
  } catch (e) { if (aktif.ad === 'zincir') ops.innerHTML = `<div class="kart"><h2>6. Opsiyon</h2>${hataKutusu(e)}</div>`; return; }
  if (aktif.ad !== 'zincir' || kod(aktif.param) !== t) return;
  opsCiz = () => {
    const S = sayiMi(oz.spot) ? oz.spot : f, gun = Math.max(kalanGun(oz.vade), 1), Tt = gun / 365, r = sayiMi(gc.irx) ? gc.irx / 100 : 0.045;
    const yatay = durum.yon === 'yatay';
    const sonuc = zOpsiyonHesapla(oz, { S, T: Tt, r, yon: durum.yon, hedef: durum.hedef, stop: durum.stop, ivRank: durum.ivRank, hv20: g.hv20,
      ust: direnc[0] ? direnc[0].fiyat : S * 1.05, alt: destek[0] ? destek[0].fiyat : S * 0.95 });
    const genel = [...(durum.vadeUyari || [])];
    if (gun < 21 || gun > 45) genel.push('Vade ' + gun + ' gün: kural 21–45 gün.');
    if (tk && tk.date >= bugunStr() && tk.date <= oz.vade) genel.push('Vade bilançoyu (' + tarihTR(tk.date) + ') kapsıyor: IV düşüşü riski.');
    if (sayiMi(gc.vix) && (gc.vix > 35 || gc.vix < 12)) genel.push('VIX ' + sayi(gc.vix) + ': 12–35 dışında → yeni kısa prim (kredi) pozisyonu açılmaz.');
    if (sonuc.canliYok) genel.push('Canlı alış/satış yok (piyasa kapalı): son işlem fiyatları kullanıldı.');
    if (durum.gex && !durum.gex.veriYok) genel.push('GEX: ' + durum.gex.opsiyonNotu + (durum.gex.veriZayif ? ' (veri zayıf)' : ''));
    const tl = v => v === null ? 'sınırsız' : usdIsaretli(v);
    ops.innerHTML = `<div class="kart"><h2>6. Opsiyon alternatifleri</h2>
      <div class="iki"><label>Yön<select id="zo-yon"><option value="yukari"${durum.yon === 'yukari' ? ' selected' : ''}>Yukarı</option><option value="asagi"${durum.yon === 'asagi' ? ' selected' : ''}>Aşağı</option><option value="yatay"${yatay ? ' selected' : ''}>Yatay (kondor)</option></select></label>
        <label>Vade<select id="zo-vade">${(oz.vadeler || []).filter(v => kalanGun(v) >= 0).slice(0, 16).map(v => `<option value="${v}"${v === oz.vade ? ' selected' : ''}>${tarihTR(v)} · ${kalanGun(v)} g</option>`).join('')}</select></label></div>
      <div class="uc"><label>Hedef ($)<input type="number" id="zo-hedef" value="${durum.hedef}" step="any" inputmode="decimal"${yatay ? ' disabled' : ''}></label>
        <label>Stop ($)<input type="number" id="zo-stop" value="${durum.stop}" step="any" inputmode="decimal"${yatay ? ' disabled' : ''}></label>
        <label>IV rank<input type="number" id="zo-ivr" value="${durum.ivRank ?? ''}" placeholder="boş" min="0" max="100" inputmode="numeric"></label></div>
      <p style="margin:6px 0"><span class="cip ${sonuc.ivd === 'pahalı' ? 'kirmizi' : sonuc.ivd === 'ucuz' ? 'yesil' : ''}">Opsiyonlar ${sonuc.ivd}</span>
        <span class="cip">Boyut ×${nf(1).format(sonuc.boyut)}</span> <span class="cip">ATM IV %${nf(0).format(sonuc.sigma * 100)}</span>
        ${sayiMi(gc.vix) ? `<span class="cip">VIX ${sayi(gc.vix)}</span>` : ''}</p>
      <p class="alt" style="margin:0">${esc(sonuc.olcut)} · spot ${usd(S)} · ${oz.kaynak}${sonuc.straddle ? ' · vade beklenen hareketi ±' + usd(sonuc.straddle) + ' (%' + nf(1).format(sonuc.straddle / S * 100) + ')' : ''}</p>
      ${genel.map(u => `<div class="uyari">⚠️ ${esc(u)}</div>`).join('')}
      ${sonuc.yapilar.length ? '' : '<p class="alt">Uygun yapı bulunamadı.</p>'}</div>
      ${sonuc.yapilar.map(y => `<div class="kart"><h2 style="font-size:15px">${esc(y.ad)}</h2>
        <div class="kaydir"><table class="tablo"><thead><tr><th></th><th>Strike</th><th>Orta</th><th>Delta</th><th>OI</th></tr></thead><tbody>
          ${y.bacaklar.map(b => `<tr><td>${b.islem === 'al' ? 'Al' : 'Sat'} ${b.tip}</td><td>${b.k}</td><td>${usd(b.orta)}${b.canli ? '' : '*'}</td><td>${sayiMi(b.delta) ? nf(2).format(b.delta) : '—'}</td><td>${b.oi}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="uc" style="margin-top:8px"><div><div class="etiket">${y.kredi ? 'Alınan' : 'Ödenen'}</div><div class="sayi">${usd(Math.abs(y.net), 0)}</div></div>
          <div><div class="etiket">Maks kâr / zarar</div><div class="sayi">${tl(y.maksKar)} / ${usdIsaretli(y.maksZarar)}</div></div>
          <div><div class="etiket">Başa baş</div><div class="sayi">${y.bb.map(v => sayi(v, 2)).join(' · ') || '—'}</div></div></div>
        <div class="uc"><div><div class="etiket">Hedefte</div><div class="sayi ${renk(y.hedefKz)}">${usdIsaretli(y.hedefKz)}</div></div>
          <div><div class="etiket">Stopta</div><div class="sayi ${renk(y.stopKz)}">${usdIsaretli(y.stopKz)}</div></div>
          <div><div class="etiket">Kâr olasılığı · R/R</div><div class="sayi">%${Math.round(y.pop * 100)} · ${sayi(y.rr, 2)}</div></div></div>
        ${sayiMi(y.geriAlim) ? `<p class="alt" style="margin:4px 0 0">Kâr al: GTC geri alım ${usd(y.geriAlim)} (primin %50'si)</p>` : ''}
        ${y.uyarilar.map(u => `<div class="uyari">⚠️ ${esc(u)}</div>`).join('')}</div>`).join('')}
      <div class="kart"><p class="alt" style="margin:0">K/Z kontrat başına (100 hisse) ve <b>vadedeki</b> değerdir; stop vadeden önce gelirse sonuç farklı olur. * = canlı fiyat yok, son işlem. Kurallar (KARARLAR 06) uyarıdır, eleme değil: vadeye 7 gün kala kapat; kredi yapılarında %50 kâr al. Delta Black-Scholes (Yahoo IV, faiz ^IRX). Kendi yöntemimiz; <b>yatırım tavsiyesi değildir</b>.</p></div>`;
    $('#zo-yon', ops).onchange = e => { durum.yon = e.target.value; durum.hedef = null; durum.stop = null; planCiz(); opsCiz(); };
    $('#zo-hedef', ops).onchange = e => { const v = Number(e.target.value); if (v > 0) { durum.hedef = v; opsCiz(); } };
    $('#zo-stop', ops).onchange = e => { const v = Number(e.target.value); if (v > 0) { durum.stop = v; opsCiz(); } };
    $('#zo-ivr', ops).onchange = e => { const v = e.target.value === '' ? null : Number(e.target.value); durum.ivRank = sayiMi(v) ? v : null; opsCiz(); };
    $('#zo-vade', ops).onchange = async e => {
      ops.querySelector('.kart').classList.add('yukleniyor');
      try { oz = await zincirAl({ islem: 'opsiyon', t, vade: e.target.value }); durum.vadeUyari = []; opsCiz(); } catch (err) { bildir(err.message); opsCiz(); }
    };
  };
  opsCiz();
}

// ---------------------------------------------------------------- INSIDER
const insSekme = secili => `<div class="kart" style="display:flex;gap:8px;padding:10px 12px">
  <a class="cip${secili === 'piyasa' ? ' yesil' : ''}" href="#insider">Tüm piyasa</a><a class="cip${secili === 'portfoy' ? ' yesil' : ''}" href="#insider/portfoy">Portföyüm</a></div>`;

/** Ana kaynak: OpenInsider (Apps Script aracısı, son 30 gün; alım ≥ 50 bin $, satış ≥ 1 mn $). Satır → ortak kayıt. */
function insiderOpenInsider(v) {
  return (v.satirlar || []).map(([bildirim, tarih, t, sirket, kisi, unvan, kod, fiyat, adet, dSahip, tutar]) =>
    ({ t, sirket, kisi, unvan, tarih: tarih || bildirim, kod, fiyat, adet, dSahip, tutar }));
}
/** Yedek kaynak: Finnhub sembolsüz uç nokta (en son ~2000 bildirim ≈ son 3–5 iş günü). Yalnız SEC Form 4, kod P/S. */
function insiderFinnhub(r) {
  const gorulen = new Set(), out = [];
  ((r && r.data) || []).forEach(x => {
    if (x.source && x.source !== 'sec') return;
    if (x.isDerivative || !x.symbol || (x.transactionCode !== 'P' && x.transactionCode !== 'S')) return;
    const adet = Math.abs(Number(x.change) || 0), fiyat = Number(x.transactionPrice) || 0;
    if (!adet || !fiyat) return;
    const tarih = x.transactionDate || x.filingDate || '';
    const anahtar = [x.symbol, x.name, tarih, x.change, fiyat, x.transactionCode].join('|');
    if (gorulen.has(anahtar)) return; gorulen.add(anahtar);
    out.push({ t: x.symbol, sirket: '', kisi: x.name, unvan: '', tarih, kod: x.transactionCode, fiyat, adet, dSahip: '', tutar: adet * fiyat });
  });
  return out;
}
/** Hisse + işlem türüne göre gruplar; yalnız `gun` gün içindeki işlemler. */
function insiderGrupla(kayitlar, gun) {
  const sinir = gunEkle(bugunStr(), -gun), grup = new Map();
  let ilkT = '', sonT = '';
  kayitlar.forEach(x => {
    if (x.tarih < sinir) return;
    if (!ilkT || x.tarih < ilkT) ilkT = x.tarih; if (x.tarih > sonT) sonT = x.tarih;
    const k = x.t + '|' + x.kod;
    const g = grup.get(k) || { t: x.t, sirket: x.sirket, kod: x.kod, kisiler: new Map(), islem: 0, usd: 0, adet: 0, son: '' };
    if (!g.kisiler.has(x.kisi)) g.kisiler.set(x.kisi, x.unvan);
    g.islem++; g.usd += x.tutar; g.adet += x.adet; if (x.tarih > g.son) g.son = x.tarih;
    grup.set(k, g);
  });
  return { ilkT, sonT, gruplar: [...grup.values()].map(g => ({ ...g, kisiSay: g.kisiler.size, kisiler: [...g.kisiler].map(([ad, u]) => u ? ad + ' (' + u + ')' : ad), ort: g.adet ? g.usd / g.adet : null })) };
}

async function ekranInsider(main, param, yenile) {
  if (param !== 'portfoy') return ekranInsiderPiyasa(main, yenile);
  const liste = portfoySorgulari();
  if (!liste.length) { portfoyBos(main, 'Insider özeti'); main.insertAdjacentHTML('afterbegin', insSekme('portfoy')); return; }
  if (!veriVarMi()) return anahtarYok(main);
  main.innerHTML = `${insSekme('portfoy')}<div class="kart"><h2>🧑‍💼 Portföyümde insider <small>· son 90 gün, açık piyasa</small></h2><div id="ins" class="yukleniyor">Yükleniyor…</div>
    <p class="alt" style="margin:10px 0 0">Yalnızca Form 4 kodu P (alım) ve S (satış). Küme alımı = 2+ farklı yöneticinin alımı. Kendi yöntemimiz; yatırım tavsiyesi değildir.</p></div>`;
  const sonuc = [];
  for (const h of liste) {
    try { sonuc.push({ ...h, o: await api.insider(h.t, yenile) }); } catch (e) { sonuc.push({ ...h, hata: e.message }); }
    if (aktif.ad !== 'insider') return;
  }
  sonuc.sort((a, b) => (b.o && b.o.kume) - (a.o && a.o.kume) || ((b.o && b.o.alim) || 0) - ((a.o && a.o.alim) || 0));
  $('#ins', main).className = '';
  $('#ins', main).innerHTML = `<ul class="liste">${sonuc.map(s => `
    <li class="satir" onclick="location.hash='analiz/${encodeURIComponent(s.t)}'">
      <div class="sol"><div class="kod">${esc(s.etiket)}</div>
        <div class="alt">${s.o ? `${s.o.alim} alım · ${s.o.satis} satış` : esc(s.hata || '')}${s.o && !s.o.alim && !s.o.satis && s.etf ? ' · ETF ise dayanak hisse ekle' : ''}</div>
        ${s.o && s.o.kume ? `<div style="margin-top:4px"><span class="cip yesil">✅ Küme alımı · ${s.o.alanSayisi} yönetici</span></div>` : ''}</div>
      <div class="sag">${s.o ? `<div class="kod ${renk(s.o.net)}">${usdIsaretli(s.o.net / 1e6, 1)} Mn</div><div class="alt">net</div>` : ''}</div></li>`).join('')}</ul>`;
}

async function ekranInsiderPiyasa(main, yenile) {
  if (!veriVarMi()) return anahtarYok(main);
  const f = { tur: 'P', min: 100000, gun: 30, ...depo.al('insFiltre', {}) };
  if (![0, 100000, 1000000, 10000000].includes(f.min)) f.min = 100000;
  if (![7, 14, 30].includes(f.gun)) f.gun = 30;
  const sec = (id, liste, deger) => `<select id="${id}">${liste.map(([v, a]) => `<option value="${v}"${deger === v ? ' selected' : ''}>${a}</option>`).join('')}</select>`;
  main.innerHTML = `${insSekme('piyasa')}
  <div class="kart"><h2>🧑‍💼 Tüm piyasa insider <small>· açık piyasa</small></h2>
    <div class="uc"><label>İşlem${sec('ins-tur', [['P', 'Alımlar'], ['S', 'Satışlar'], ['H', 'Hepsi']], f.tur)}</label>
      <label>Dönem${sec('ins-gun', [[7, '7 gün'], [14, '14 gün'], [30, '30 gün']], f.gun)}</label>
      <label>En az tutar${sec('ins-min', [[0, 'Hepsi'], [100000, '100 bin $'], [1000000, '1 mn $'], [10000000, '10 mn $']], f.min)}</label></div>
    <div id="ins" class="yukleniyor">Yükleniyor… (ilk açılış birkaç saniye sürer)</div>
    <p class="alt" id="ins-kaynak" style="margin:10px 0 0"></p></div>`;
  const kutu = $('#ins', main);
  const yenidenCiz = () => { depo.koy('insFiltre', f); ciz(); };
  $('#ins-tur', main).onchange = e => { f.tur = e.target.value; yenidenCiz(); };
  $('#ins-gun', main).onchange = e => { f.gun = Number(e.target.value); yenidenCiz(); };
  $('#ins-min', main).onchange = e => { f.min = Number(e.target.value); yenidenCiz(); };
  let kayitlar, kaynakNot, yedek = false;
  const ortak = ' Yalnız SEC Form 4 kodu P (açık piyasa alımı) ve S (satış); ödül, opsiyon kullanımı ve vergi stopajı hariç. Form 4 işlemden ~2 iş günü sonra yayınlanır. Küme alımı = aynı hissede 2+ farklı kişinin alımı. Tarih = işlem tarihi. Kendi yöntemimiz; yatırım tavsiyesi değildir.';
  try {
    if (ayarlar().demo) throw new Error('örnek veri');
    const v = await zincirAl({ islem: 'insider' }, 30 * 6e4, yenile);
    kayitlar = insiderOpenInsider(v);
    kaynakNot = 'Kaynak: OpenInsider (SEC Form 4), son 30 gün. Kapsam: alımlar ≥ 50 bin $, satışlar ≥ 1 mn $ (daha küçük işlemler listede yok).' + ortak;
  } catch (e) {
    try { kayitlar = insiderFinnhub(await fh('/stock/insider-transactions', {}, 30 * 6e4, yenile)); yedek = !ayarlar().demo; }
    catch (e2) { if (aktif.ad === 'insider') kutu.outerHTML = hataKutusu(e2); return; }
    kaynakNot = 'Kaynak: Finnhub (yedek), en son ~2000 bildirim ≈ son 3–5 iş günü.' + ortak;
  }
  if (aktif.ad !== 'insider') return;
  $('#ins-kaynak', main).textContent = kaynakNot;
  const portfoyde = new Set(portfoySorgulari().map(h => h.t));
  function ciz() {
    const veri = insiderGrupla(kayitlar, f.gun);
    const g = veri.gruplar.filter(x => (f.tur === 'H' || x.kod === f.tur) && x.usd >= f.min)
      .sort((a, b) => (b.kod === 'P' && b.kisiSay >= 2) - (a.kod === 'P' && a.kisiSay >= 2) || b.usd - a.usd);
    const alimSay = veri.gruplar.filter(x => x.kod === 'P').length, satisSay = veri.gruplar.filter(x => x.kod === 'S').length;
    kutu.className = '';
    kutu.innerHTML = `${yedek ? '<div class="uyari">⚠️ OpenInsider\'a ulaşılamadı; Finnhub\'ın son birkaç günlük verisi gösteriliyor.</div>' : ''}<p class="alt" style="margin:8px 0">${veri.ilkT ? tarihTR(veri.ilkT) + ' – ' + tarihTR(veri.sonT) : '—'} · ${alimSay} hissede alım, ${satisSay} hissede satış · gösterilen ${g.length}</p>
      ${g.length ? `<ul class="liste">${g.slice(0, 150).map(x => `
      <li class="satir" onclick="location.hash='analiz/${encodeURIComponent(x.t)}'">
        <div class="sol"><div class="kod">${esc(x.t)} <span class="cip ${x.kod === 'P' ? 'yesil' : 'kirmizi'}">${x.kod === 'P' ? 'Alım' : 'Satış'}</span>${portfoyde.has(x.t) ? ' <span class="cip sari">portföyde</span>' : ''}</div>
          ${x.sirket ? `<div class="alt">${esc(x.sirket)}</div>` : ''}
          <div class="alt">${esc(x.kisiler.slice(0, 2).join(', '))}${x.kisiSay > 2 ? ' +' + (x.kisiSay - 2) : ''}</div>
          <div class="alt">${x.islem} işlem · ort. ${usd(x.ort)} · son ${tarihTR(x.son)}</div>
          ${x.kod === 'P' && x.kisiSay >= 2 ? `<div style="margin-top:4px"><span class="cip yesil">✅ Küme alımı · ${x.kisiSay} kişi</span></div>` : ''}</div>
        <div class="sag"><div class="kod ${x.kod === 'P' ? 'arti' : 'eksi'}">${x.usd >= 1e6 ? nf(1).format(x.usd / 1e6) + ' mn $' : nf(0).format(x.usd / 1e3) + ' bin $'}</div></div></li>`).join('')}</ul>` : '<p class="alt">Bu filtrelere uyan işlem yok.</p>'}`;
  }
  ciz();
}

// ---------------------------------------------------------------- ORB TARAMASI
const orbAdres = () => depo.al('orbAdres', '') || ORB_ADRES;
const orbKod = h => String(h).replace('-', '.'); // Yahoo BRK-B → Finnhub BRK.B
const etTarih = z => { const [g, s] = String(z || '').split(' '); return g ? tarihTR(g) + ' ' + (s || '') : '—'; };
function onceSure(iso) {
  const dk = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  if (!Number.isFinite(dk)) return '';
  if (dk < 1) return 'az önce'; if (dk < 60) return dk + ' dk önce';
  const sa = Math.floor(dk / 60); return sa < 24 ? sa + ' sa önce' : Math.floor(sa / 24) + ' gün önce';
}

async function ekranOrb(main) {
  main.innerHTML = `<div class="kart"><h2>📈 ORB taraması <small>· ilk 15 dk açılış aralığı</small></h2><div id="orb" class="yukleniyor">Yükleniyor…</div></div>`;
  let v;
  try {
    const r = await fetch(orbAdres() + (orbAdres().includes('?') ? '&' : '?') + 'k=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Sunucu yanıtı ' + r.status);
    v = await r.json();
  } catch (e) {
    if (aktif.ad !== 'orb') return;
    $('#orb', main).className = ''; $('#orb', main).innerHTML = hataKutusu('Tarama sonuçlarına ulaşılamadı. İnternet bağlantısını kontrol et. (' + e.message + ')');
    return;
  }
  if (aktif.ad !== 'orb') return;
  const el = $('#orb', main); el.className = '';
  const s = v && v.son;
  if (!s) { el.innerHTML = '<p class="alt">Henüz tarama gelmedi. Bilgisayardaki tarama, ABD seansında (TSİ 17:45–24:00 civarı) 15 dakikada bir sonuç gönderir.</p>'; return; }

  const gecmis = Array.isArray(v.gecmis) ? v.gecmis : [];
  const bugun = String(s.zaman).slice(0, 10);
  const onceki = gecmis.filter(g => g.zaman < s.zaman && String(g.zaman).startsWith(bugun)).pop();
  const oncekiSet = onceki ? new Set([...(onceki.yukari || []), ...(onceki.asagi || [])]) : null;
  const satir = s.satirlar || [];
  const yuk = satir.filter(r => r.Yon === 'YUKARI'), asa = satir.filter(r => r.Yon !== 'YUKARI');
  const eski = (Date.now() - new Date(s.alindi).getTime()) > 40 * 6e4;

  const liste = (rows, baslik) => !rows.length ? `<h3 style="margin:14px 0 4px">${baslik}</h3><p class="alt" style="margin:0">Yok.</p>` :
    `<h3 style="margin:14px 0 4px">${baslik} <small class="alt">· ${rows.length}</small></h3><ul class="liste">${rows.map(r => `
      <li class="satir" onclick="location.hash='analiz/${encodeURIComponent(orbKod(r.Hisse))}'">
        <div class="sol"><div class="kod">${esc(r.Hisse)} ${oncekiSet && !oncekiSet.has(r.Hisse) ? '<span class="cip sari">yeni</span>' : ''}</div>
          <div class="alt">OR ${usd(r.OR_Alt)} – ${usd(r.OR_Ust)} (%${nf(2).format(r.OR_Genislik_Yuzde)}) · ilk kırılım ${esc(r.Ilk_Kirilim_ET)} ET · hacim ${sayi(r.Hacim_Orani, 2)}×</div></div>
        <div class="sag"><div class="kod ${renk(r.Fark_Yuzde)}">${r.Fark_Yuzde > 0 ? '+' : r.Fark_Yuzde < 0 ? '−' : ''}%${nf(2).format(Math.abs(r.Fark_Yuzde))}</div><div class="alt">${usd(r.Son)}</div></div></li>`).join('')}</ul>`;

  const bugunku = gecmis.filter(g => String(g.zaman).startsWith(bugun)).reverse();
  el.innerHTML = `
    <p style="margin:0"><b>${etTarih(s.zaman)} ET</b> <span class="alt">· ${onceSure(s.alindi)}</span></p>
    ${eski ? '<div class="uyari" style="margin-top:8px">⚠️ Son tarama 40 dakikadan eski. Seans kapalı olabilir ya da bilgisayar kapalı.</div>' : ''}
    <p style="margin:8px 0 0"><span class="cip yesil">⬆️ Yukarı ${yuk.length}</span> <span class="cip kirmizi">⬇️ Aşağı ${asa.length}</span>
      <span class="cip">Veri ${s.veriGelen}/${s.toplam}</span></p>
    ${liste(yuk, '⬆️ Yukarı kırılım')}
    ${liste(asa, '⬇️ Aşağı kırılım')}
    ${s.kesildi ? '<p class="alt">Liste çok uzun olduğu için ilk 60 satır gösteriliyor.</p>' : ''}`;

  main.insertAdjacentHTML('beforeend', `
    ${bugunku.length > 1 ? `<div class="kart"><h2>🕒 Bugünkü taramalar <small>· ${bugunku.length}</small></h2><ul class="liste">${bugunku.map(g => `
      <li class="satir" style="cursor:default"><div class="sol"><div class="kod">${esc(String(g.zaman).slice(11))} ET</div>
        <div class="alt">${esc([...(g.yukari || []).slice(0, 8)].join(' '))}${(g.yukari || []).length > 8 ? ' …' : ''}</div></div>
        <div class="sag"><span class="cip yesil">⬆️ ${(g.yukari || []).length}</span> <span class="cip kirmizi">⬇️ ${(g.asagi || []).length}</span></div></li>`).join('')}</ul></div>` : ''}
    <div class="kart"><p class="alt" style="margin:0">Açılış aralığı (OR) = 09:30–09:45 ET'nin en yüksek/en düşük fiyatı. Kırılım: son kapanmış 5 dk mum OR'un üstünde (yukarı) ya da altında (aşağı) kapandı. Fark % = son fiyatın OR sınırına uzaklığı. Hacim oranı = son 3 mumun ortalama hacmi / OR mumlarının ortalaması. "Yeni" = bir önceki taramada yoktu. S&P 500'ün en büyük ~100 hissesi; veri Yahoo Finance, 15 dakikada bir bilgisayardan gönderilir. Kendi yöntemimiz; <b>yatırım tavsiyesi değildir</b>.</p></div>`);
}

// ---------------------------------------------------------------- AYARLAR
function ekranAyarlar(main) {
  const a = ayarlar(), k = anahtar();
  main.innerHTML = `
  <form class="kart" id="f-anahtar"><h2>Finnhub anahtarı</h2>
    <p class="alt" style="margin-top:0">Ücretsiz anahtar: finnhub.io → hesap aç → Dashboard. Anahtar yalnızca bu cihazda saklanır, hiçbir yere gönderilmez (yalnızca Finnhub isteklerinde).</p>
    <label>Anahtar (40 karakter)<input id="anahtar" type="password" autocomplete="off" spellcheck="false" value="${esc(k)}" placeholder="${k ? '' : 'yapıştır'}"></label>
    <div class="dugmeler"><button class="dugme" type="submit">Kaydet</button><button class="dugme ikincil" type="button" id="goster">Göster</button>
      <span class="bosluk"></span><span class="alt">${k ? '✅ kayıtlı' : 'kayıtlı değil'}</span></div>
  </form>

  <div class="kart"><h2>Örnek veri modu</h2>
    <p class="alt" style="margin-top:0">Anahtar olmadan arayüzü denemek için uydurma veriler gösterir. Gerçek değildir.</p>
    <label style="display:flex;align-items:center;gap:10px;margin:0"><input type="checkbox" id="demo" style="width:22px;min-height:22px;margin:0" ${a.demo ? 'checked' : ''}> Örnek veriyi kullan</label>
  </div>

  <form class="kart" id="f-orb"><h2>ORB taraması adresi</h2>
    <p class="alt" style="margin-top:0">Bilgisayardaki taramanın sonuç gönderdiği adres. Hazır gelir; değiştirmen gerekmez. Boş bırakıp kaydedersen varsayılana döner.</p>
    <label>Adres<input id="orb-adres" type="url" autocomplete="off" spellcheck="false" value="${esc(depo.al('orbAdres', ''))}" placeholder="varsayılan"></label>
    <div class="dugmeler"><button class="dugme" type="submit">Kaydet</button></div>
  </form>

  <form class="kart" id="f-agirlik"><h2>Puan ağırlıkları <small>· kendi yöntemimiz</small></h2>
    <div class="iki">${BOYUTLAR.map(b => `<label>${b}<input type="number" name="${b}" value="${a.agirlik[b]}" min="0" max="100" step="1" inputmode="numeric"></label>`).join('')}</div>
    <p class="etiket" style="margin:4px 0 6px">Beklenen değer: senaryo ağırlıkları</p>
    <div class="uc">
      <label>Kötümser<input type="number" name="sKot" value="${a.senAgirlik.kot}" min="0" max="100" step="1" inputmode="numeric"></label>
      <label>Baz<input type="number" name="sBaz" value="${a.senAgirlik.baz}" min="0" max="100" step="1" inputmode="numeric"></label>
      <label>İyimser<input type="number" name="sIyi" value="${a.senAgirlik.iyi}" min="0" max="100" step="1" inputmode="numeric"></label>
    </div>
    <label>Tema<select name="tema"><option value="auto"${a.tema === 'auto' ? ' selected' : ''}>Cihaza göre</option><option value="light"${a.tema === 'light' ? ' selected' : ''}>Açık</option><option value="dark"${a.tema === 'dark' ? ' selected' : ''}>Koyu</option></select></label>
    <div class="dugmeler"><button class="dugme" type="submit">Kaydet</button><button class="dugme ikincil" type="button" id="sifirla">Varsayılana dön</button></div>
  </form>

  <div class="kart"><h2>Yedek</h2>
    <p class="alt" style="margin-top:0">Portföy ve ayarlar yalnızca bu cihazda. Telefon değiştirirken ya da tarayıcı verisi silinmeden önce dışa aktar. (API anahtarı yedeğe girmez.)</p>
    <div class="dugmeler"><button class="dugme" type="button" id="disa">Dışa aktar (.json)</button>
      <label class="dugme ikincil" style="margin:0;display:inline-flex;align-items:center;color:var(--metin)">İçe aktar<input type="file" id="ice" accept="application/json,.json" hidden></label></div>
  </div>

  <div class="kart"><h2>Bakım</h2>
    <div class="dugmeler"><button class="dugme ikincil" type="button" id="onbellek">Önbelleği temizle</button>
      <button class="dugme tehlike" type="button" id="hepsini-sil">Tüm verileri sil</button></div>
    <p class="alt">Veriler 6 saat önbellekte tutulur (fiyat 1 dakika). Ücretsiz Finnhub: dakikada ~60 istek.</p>
  </div>
  <div class="kart"><h2>Sürüm</h2>
    <p style="margin:0"><b>Borsa Defteri v${UYGULAMA_SURUM.no}</b> <span class="alt">· ${UYGULAMA_SURUM.tarih}</span></p>
    <p class="alt" id="surum-durum" style="margin:6px 0 0">Kontrol ediliyor…</p>
  </div>
  <p class="alt">Puanlar, hedefler ve takvim kendi yöntemimizdir; eğitim ve kişisel takip amaçlıdır, yatırım tavsiyesi değildir.</p>`;
  surumKontrol($('#surum-durum', main));

  $('#f-anahtar', main).onsubmit = e => {
    e.preventDefault(); const v = $('#anahtar', main).value.trim();
    if (v && !/^[A-Za-z0-9]{20,64}$/.test(v)) { bildir('Anahtar biçimi beklenmedik: tek parça, boşluksuz olmalı.'); return; }
    depo.koy('anahtar', v); if (v) ayarKaydet({ demo: false }); bildir(v ? 'Anahtar kaydedildi.' : 'Anahtar silindi.'); yonlendir();
  };
  $('#goster', main).onclick = e => { const i = $('#anahtar', main); i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'Göster' : 'Gizle'; };
  $('#f-orb', main).onsubmit = e => {
    e.preventDefault(); const v = $('#orb-adres', main).value.trim();
    if (v && !/^https:\/\/script\.google(usercontent)?\.com\//.test(v)) { bildir('Adres https://script.google.com/... ile başlamalı.'); return; }
    if (v) depo.koy('orbAdres', v); else depo.sil('orbAdres'); bildir(v ? 'ORB adresi kaydedildi.' : 'Varsayılan ORB adresi kullanılacak.');
  };
  $('#demo', main).onchange =e => { ayarKaydet({ demo: e.target.checked }); bildir(e.target.checked ? 'Örnek veri açık.' : 'Örnek veri kapalı.'); yonlendir(); };
  $('#f-agirlik', main).onsubmit = e => {
    e.preventDefault(); const f = e.target, ag = {};
    for (const b of BOYUTLAR) { const v = Number(f[b].value); if (!(v >= 0)) { bildir(b + ' ağırlığı geçersiz.'); return; } ag[b] = v; }
    if (!Object.values(ag).some(v => v > 0)) { bildir('En az bir ağırlık 0\'dan büyük olmalı.'); return; }
    const sen = { kot: Number(f.sKot.value), baz: Number(f.sBaz.value), iyi: Number(f.sIyi.value) };
    if (!Object.values(sen).every(v => v >= 0) || !Object.values(sen).some(v => v > 0)) { bildir('Senaryo ağırlıkları geçersiz.'); return; }
    ayarKaydet({ agirlik: ag, senAgirlik: sen, tema: f.tema.value }); temaUygula(); bildir('Kaydedildi.');
  };
  $('#sifirla', main).onclick = () => { ayarKaydet({ agirlik: { ...VARSAYILAN_AYAR.agirlik }, senAgirlik: { ...VARSAYILAN_AYAR.senAgirlik }, hatirlatGun: 7, tema: 'auto' }); temaUygula(); yonlendir(); bildir('Varsayılanlar yüklendi.'); };
  $('#disa', main).onclick = () => {
    const veri = { uygulama: 'Borsa Defteri', surum: 1, tarih: new Date().toISOString(), pozisyonlar: pozisyonlar(), ayarlar: ayarlar() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(veri, null, 2)], { type: 'application/json' }));
    const l = document.createElement('a'); l.href = url; l.download = 'borsa-defteri-' + bugunStr() + '.json'; document.body.appendChild(l); l.click(); l.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('#ice', main).onchange = async e => {
    const dosya = e.target.files[0]; if (!dosya) return;
    try {
      const v = JSON.parse(await dosya.text());
      const p = Array.isArray(v) ? v : v.pozisyonlar;
      if (!Array.isArray(p)) throw new Error('Pozisyon listesi bulunamadı.');
      const temiz = p.map(x => ({ t: kod(x.t || x.hisse || x.ticker), adet: Number(x.adet ?? x.shares), maliyet: x.maliyet == null || x.maliyet === '' ? null : Number(x.maliyet), dayanak: kod(x.dayanak), not: String(x.not || '').slice(0, 80) }))
        .filter(x => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x.t) && x.adet > 0);
      if (!confirm(temiz.length + ' pozisyon içe aktarılacak; mevcut ' + pozisyonlar().length + ' pozisyonun yerine geçecek. Devam?')) return;
      pozKaydet(temiz); if (v.ayarlar) ayarKaydet({ ...v.ayarlar, demo: false }); temaUygula(); bildir('İçe aktarıldı.'); location.hash = 'portfoy';
    } catch (err) { bildir('İçe aktarılamadı: ' + err.message); }
    e.target.value = '';
  };
  $('#onbellek', main).onclick = () => { bellek.clear(); onbellekBudama(true); bildir('Önbellek temizlendi.'); };
  $('#hepsini-sil', main).onclick = () => {
    if (!confirm('Portföy, ayarlar, anahtar ve önbellek bu cihazdan silinecek. Geri alınamaz. Önce dışa aktarmanı öneririm. Silinsin mi?')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith(ON)).forEach(k => localStorage.removeItem(k)); } catch { /* yok */ }
    bellek.clear(); temaUygula(); bildir('Tüm veriler silindi.'); location.hash = 'portfoy'; yonlendir();
  };
}

/** Yayındaki sürümü (sw.js) okuyup bu cihazdakiyle karşılaştırır. */
async function surumKontrol(el) {
  if (!el) return;
  try {
    const r = await fetch('sw.js?k=' + Date.now(), { cache: 'no-store' });
    const m = (await r.text()).match(/defter-v(\d+)/);
    const yayin = m ? Number(m[1]) : null;
    if (yayin === null) { el.textContent = 'Yayındaki sürüm okunamadı.'; return; }
    if (yayin === UYGULAMA_SURUM.no) el.innerHTML = '<span class="cip yesil">✅ Güncel</span> <span>yayındaki sürüm de v' + yayin + '</span>';
    else if (yayin > UYGULAMA_SURUM.no) el.innerHTML = '<span class="cip sari">Yeni sürüm var: v' + yayin + '</span> Uygulamayı tamamen kapatıp yeniden aç.';
    else el.textContent = 'Yayındaki sürüm: v' + yayin;
  } catch { el.textContent = 'Çevrimdışı: yayındaki sürüm kontrol edilemedi.'; }
}

function temaUygula() { const t = ayarlar().tema; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }

// ---------------------------------------------------------------- örnek veri (uydurma, yalnızca arayüz denemesi için)
function tohum(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }
function ornekVeri(yol, p) {
  const t = p.symbol || 'X', r = tohum(t), ar = (a, b) => a + (b - a) * r();
  const fiyat = Math.round(ar(20, 600) * 100) / 100;
  if (yol === '/quote') return { c: fiyat, dp: Math.round(ar(-4, 4) * 100) / 100, pc: fiyat };
  if (yol === '/stock/profile2') return { name: t + ' Örnek A.Ş.', finnhubIndustry: 'Örnek sektör', country: 'US', marketCapitalization: ar(5e3, 9e5) };
  if (yol === '/stock/metric') {
    const eps = ar(-1, 12), pe = eps > 0 ? fiyat / eps : null;
    return { metric: { '52WeekHigh': fiyat * ar(1.02, 1.6), '52WeekLow': fiyat * ar(0.4, 0.95), marketCapitalization: ar(5e3, 9e5), enterpriseValue: ar(5e3, 9e5),
      'currentEv/freeCashFlowTTM': ar(10, 80), pfcfShareTTM: ar(10, 80), epsTTM: eps, peTTM: pe, forwardPE: pe ? pe * ar(0.5, 0.9) : null,
      epsGrowth3Y: ar(-10, 50), revenueGrowth3Y: ar(-5, 35), revenueGrowth5Y: ar(0, 30), roeTTM: ar(-5, 40), roaTTM: ar(-2, 20), grossMarginTTM: ar(20, 75),
      netProfitMarginTTM: ar(-5, 30), 'totalDebt/totalEquityQuarterly': ar(0, 2.5), currentRatioQuarterly: ar(0.7, 3.5), psTTM: ar(1, 18), pbQuarterly: ar(1, 15),
      revenueGrowthTTMYoy: ar(-10, 40), epsGrowthTTMYoy: ar(-30, 60), beta: ar(0.6, 2.6), netInterestCoverageTTM: ar(0, 40),
      revenueShareGrowth5Y: ar(-2, 30), operatingMarginTTM: ar(-5, 40), operatingMargin5Y: ar(0, 35), evEbitdaTTM: ar(5, 40), roiTTM: ar(-5, 35),
      currentDividendYieldTTM: r() > 0.5 ? ar(0.3, 4) : null },
      series: { annual: Object.fromEntries(['operatingMargin', 'netMargin', 'fcfMargin', 'roic', 'pe', 'receivablesTurnover', 'inventoryTurnover'].map(k => {
        const taban = { pe: ar(10, 40), receivablesTurnover: ar(4, 12), inventoryTurnover: ar(3, 10) }[k] ?? ar(0.02, 0.35);
        return [k, [2025, 2024, 2023, 2022, 2021].map((y, i) => ({ period: y + '-12-31', v: taban * (1 + ar(-0.15, 0.15) - i * ar(-0.05, 0.05)) }))];
      })) } };
  }
  if (yol === '/stock/earnings') return ['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'].map(d => { const e = ar(0.5, 3), a = e * ar(0.9, 1.15); return { period: d, estimate: e, actual: a, surprisePercent: (a / e - 1) * 100 }; });
  if (yol === '/calendar/earnings') { const d = gunEkle(bugunStr(), Math.floor(ar(1, 80))); return { earningsCalendar: [{ symbol: t, date: d, hour: ['bmo', 'amc', 'amc'][Math.floor(ar(0, 3))], quarter: 4, year: 2026, epsEstimate: ar(0.5, 3), revenueEstimate: ar(1e9, 3e10) }] }; }
  if (yol === '/stock/insider-transactions' && !p.symbol) {
    const kodlar = ['ORNA', 'ORNB', 'ORNC', 'ORND', 'ORNE', 'ORNF'], kisi = ['Örnek Kişi 1', 'Örnek Kişi 2', 'Örnek Kişi 3'];
    return { data: Array.from({ length: 30 }, (_, i) => { const kod = r() > 0.5 ? 'P' : 'S', adet = Math.floor(ar(500, 60000));
      return { symbol: kodlar[i % 6], name: kisi[Math.floor(ar(0, 3))], change: kod === 'P' ? adet : -adet, transactionPrice: Math.round(ar(5, 300) * 100) / 100,
        transactionDate: gunEkle(bugunStr(), -Math.floor(ar(1, 5))), transactionCode: kod, isDerivative: false, source: 'sec' }; }) };
  }
  if (yol === '/stock/insider-transactions') {
    const ad =['Örnek Yönetici A', 'Örnek Yönetici B', 'Örnek Yönetici C'];
    return { data: Array.from({ length: Math.floor(ar(0, 7)) }, (_, i) => ({ name: ad[i % 3], change: (r() > 0.6 ? 1 : -1) * Math.floor(ar(100, 5000)), transactionPrice: fiyat,
      transactionDate: gunEkle(bugunStr(), -Math.floor(ar(1, 85))), transactionCode: r() > 0.6 ? 'P' : 'S', isDerivative: false })).map(x => ({ ...x, change: x.transactionCode === 'P' ? Math.abs(x.change) : -Math.abs(x.change) })) };
  }
  return {};
}

// ---------------------------------------------------------------- başlat
temaUygula();
onbellekBudama();
yonlendir();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
