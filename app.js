/* Borsa Defteri — kişisel ABD borsası takibi (PWA).
 * Puanlar, hedefler ve takvim kendi yöntemimizdir; yatırım tavsiyesi değildir.
 * Mantık Google Sheets sürümüyle aynıdır (apps-script/, builders/analiz.py).
 */
'use strict';

// Her yayında artırın; sw.js'deki SURUM ('defter-vN') ile aynı numara olmalı.
const UYGULAMA_SURUM = { no: 4, tarih: '23.11.2026' };

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
  metrik: (t, y) => fh('/stock/metric', { symbol: t, metric: 'all' }, SURE.metric, y).then(r => (r && r.metric) || {}),
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
  ['Kalite', 'Borç / özkaynak', m => ilk(m, ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual']), 2, 0, 'Hayır'],
  ['Kalite', 'Cari oran', m => ilk(m, ['currentRatioQuarterly', 'currentRatioAnnual']), 0.8, 2.5, 'Hayır'],
  ['Değer', 'F/K', m => ilk(m, ['peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peInclExtraTTM']), 45, 12, 'Evet'],
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
  ['Risk', 'Faiz karşılama oranı', m => ilk(m, ['netInterestCoverageTTM', 'netInterestCoverageAnnual']), 1, 15, 'Hayır'],
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
const EKRANLAR = { portfoy: ekranPortfoy, analiz: ekranAnaliz, takvim: ekranTakvim, insider: ekranInsider, ayarlar: ekranAyarlar };
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

function analizCiz(el, t, m, q, pr, kz) {
  const a = ayarlar();
  const fiyat = sayiMi(q.c) && q.c > 0 ? q.c : null;
  const p = puanla(m, { fiyat, kazanc: kz }, a.agirlik);
  const sen = senaryolar(m, fiyat, a);
  const lo = m['52WeekLow'], hi = m['52WeekHigh'];
  const konum = sayiMi(fiyat) && sayiMi(lo) && sayiMi(hi) && hi > lo ? (fiyat - lo) / (hi - lo) : null;
  const ev = sayiMi(m.enterpriseValue) ? m.enterpriseValue / 1000 : null;
  const pd = sayiMi(m.marketCapitalization) ? m.marketCapitalization / 1000 : sayiMi(pr.marketCapitalization) ? pr.marketCapitalization / 1000 : null;
  const evFcf = ilk(m, ['currentEv/freeCashFlowTTM', 'currentEv/freeCashFlowAnnual']);
  const pFcf = ilk(m, ['pfcfShareTTM', 'pfcfShareAnnual']);
  const fcf = ev !== null && sayiMi(evFcf) && evFcf !== 0 ? ev / evFcf : pd !== null && sayiMi(pFcf) && pFcf !== 0 ? pd / pFcf : null;
  const rd = reverseDcf(ev ?? pd, fcf, a.iskonto / 100, a.kalici / 100, a.yil);
  const dcf = basitDcf(m, fiyat, ev, pd, fcf, a);
  const baz = sen.satirlar[1].hedef;
  const tut = tutarlilik(baz, dcf);
  const sorunlar = veriKontrol(sen.fkTtm, pd, fcf, dcf, fiyat);
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
    <h2>🎯 Senaryolu hedef fiyat <small>· 1 yıllık</small></h2>
    ${sayiMi(sen.eps) && sen.eps <= 0 ? '<div class="uyari">⚠️ EPS negatif: F/K yöntemi bu hisse için anlamlı değil; reverse DCF\'ye bakın.</div>' : ''}
    ${sorunlar.length ? '<p style="margin:0 0 8px"><span class="cip kirmizi">⚠️ Veri tutarsız — hedefler güvenilir değil</span></p>' : ''}
    <p style="margin:0 0 10px"><span class="cip ${tut.sinif}">Tutarlılık: ${tut.seviye}</span>
      <span class="alt" style="display:block;margin-top:4px">${esc(tut.aciklama)}</span></p>
    <div class="uc" style="margin-bottom:10px">
      <div><div class="etiket">EPS (12 ay)</div><div class="sayi">${usd(sen.eps)}</div></div>
      <div><div class="etiket">Baz büyüme</div><div class="sayi">${yuzde(sen.g)}</div><div class="alt">${esc(sen.gKaynak)}${sayiMi(sen.gHam) && sen.gHam !== sen.g ? ' · ham ' + yuzde(sen.gHam) + ', sınırlandı' : ''}</div></div>
      <div><div class="etiket">F/K</div><div class="sayi">${sayi(sen.fk)}</div><div class="alt">${a.fkKaynak === 'ileri' && sen.fk === sen.fkIleri ? 'ileri' : 'son 12 ay'}</div></div>
    </div>
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

// ---------------------------------------------------------------- TAKVİM
async function ekranTakvim(main, _p, yenile) {
  const liste = portfoySorgulari();
  if (!liste.length) return portfoyBos(main, 'Bilanço takvimi');
  if (!veriVarMi()) return anahtarYok(main);
  const n = ayarlar().hatirlatGun;
  main.innerHTML = `<div class="kart"><h2>📅 Bilanço takvimi <small>· önümüzdeki 90 gün</small></h2><div id="tk" class="yukleniyor">Yükleniyor…</div>
    <p class="alt" style="margin:10px 0 0">${n} gün içindekiler vurgulanır. Tarihleri şirketler değiştirebilir. Kaldıraçlı ETF için pozisyonda "dayanak hisse" alanını doldur.</p></div>`;
  const sonuc = [];
  for (const h of liste) {
    try { sonuc.push({ ...h, e: await api.takvim(h.t, yenile) }); } catch (e) { sonuc.push({ ...h, hata: e.message }); }
    if (aktif.ad !== 'takvim') return;
  }
  sonuc.sort((a, b) => (a.e ? a.e.date : '9999').localeCompare(b.e ? b.e.date : '9999'));
  $('#tk', main).className = '';
  $('#tk', main).innerHTML = `<ul class="liste">${sonuc.map(s => {
    const k = s.e ? kalanGun(s.e.date) : null;
    return `<li class="satir ${k !== null && k <= n ? 'yakin' : ''}" onclick="location.hash='analiz/${encodeURIComponent(s.t)}'">
      <div class="sol"><div class="kod">${esc(s.etiket)}</div><div class="alt">${s.e ? (SAAT[s.e.hour] || 'saat belirsiz') + ' · ' + s.e.year + ' Ç' + s.e.quarter : s.hata ? esc(s.hata) : '90 gün içinde tarih yok' + (s.etf ? ' · ETF ise dayanak hisse ekle' : '')}</div></div>
      <div class="sag">${s.e ? `<div class="kod">${tarihTR(s.e.date)}</div><div class="alt"><span class="cip ${k <= n ? 'sari' : ''}">${k === 0 ? 'bugün' : k + ' gün'}</span></div>` : ''}
        ${s.e && sayiMi(s.e.epsEstimate) ? `<div class="alt">EPS bekl. ${usd(s.e.epsEstimate)}</div>` : ''}</div></li>`;
  }).join('')}</ul>`;
}

// ---------------------------------------------------------------- INSIDER
async function ekranInsider(main, _p, yenile) {
  const liste = portfoySorgulari();
  if (!liste.length) return portfoyBos(main, 'Insider özeti');
  if (!veriVarMi()) return anahtarYok(main);
  main.innerHTML = `<div class="kart"><h2>🧑‍💼 Insider işlemleri <small>· son 90 gün, açık piyasa</small></h2><div id="ins" class="yukleniyor">Yükleniyor…</div>
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

  <form class="kart" id="f-agirlik"><h2>Puan ağırlıkları <small>· kendi yöntemimiz</small></h2>
    <div class="iki">${BOYUTLAR.map(b => `<label>${b}<input type="number" name="${b}" value="${a.agirlik[b]}" min="0" max="100" step="1" inputmode="numeric"></label>`).join('')}</div>
    <p class="etiket" style="margin:4px 0 6px">Beklenen değer: senaryo ağırlıkları</p>
    <div class="uc">
      <label>Kötümser<input type="number" name="sKot" value="${a.senAgirlik.kot}" min="0" max="100" step="1" inputmode="numeric"></label>
      <label>Baz<input type="number" name="sBaz" value="${a.senAgirlik.baz}" min="0" max="100" step="1" inputmode="numeric"></label>
      <label>İyimser<input type="number" name="sIyi" value="${a.senAgirlik.iyi}" min="0" max="100" step="1" inputmode="numeric"></label>
    </div>
    <label>Takvimde vurgulanacak gün sayısı<input type="number" name="hatirlatGun" value="${a.hatirlatGun}" min="1" max="60" step="1" inputmode="numeric"></label>
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
  $('#demo', main).onchange = e => { ayarKaydet({ demo: e.target.checked }); bildir(e.target.checked ? 'Örnek veri açık.' : 'Örnek veri kapalı.'); yonlendir(); };
  $('#f-agirlik', main).onsubmit = e => {
    e.preventDefault(); const f = e.target, ag = {};
    for (const b of BOYUTLAR) { const v = Number(f[b].value); if (!(v >= 0)) { bildir(b + ' ağırlığı geçersiz.'); return; } ag[b] = v; }
    if (!Object.values(ag).some(v => v > 0)) { bildir('En az bir ağırlık 0\'dan büyük olmalı.'); return; }
    const sen = { kot: Number(f.sKot.value), baz: Number(f.sBaz.value), iyi: Number(f.sIyi.value) };
    if (!Object.values(sen).every(v => v >= 0) || !Object.values(sen).some(v => v > 0)) { bildir('Senaryo ağırlıkları geçersiz.'); return; }
    ayarKaydet({ agirlik: ag, senAgirlik: sen, hatirlatGun: Math.max(1, Number(f.hatirlatGun.value) || 7), tema: f.tema.value }); temaUygula(); bildir('Kaydedildi.');
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
      revenueGrowthTTMYoy: ar(-10, 40), epsGrowthTTMYoy: ar(-30, 60), beta: ar(0.6, 2.6), netInterestCoverageTTM: ar(0, 40) } };
  }
  if (yol === '/stock/earnings') return ['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'].map(d => { const e = ar(0.5, 3), a = e * ar(0.9, 1.15); return { period: d, estimate: e, actual: a, surprisePercent: (a / e - 1) * 100 }; });
  if (yol === '/calendar/earnings') { const d = gunEkle(bugunStr(), Math.floor(ar(1, 80))); return { earningsCalendar: [{ symbol: t, date: d, hour: ['bmo', 'amc', 'amc'][Math.floor(ar(0, 3))], quarter: 4, year: 2026, epsEstimate: ar(0.5, 3), revenueEstimate: ar(1e9, 3e10) }] }; }
  if (yol === '/stock/insider-transactions') {
    const ad = ['Örnek Yönetici A', 'Örnek Yönetici B', 'Örnek Yönetici C'];
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
