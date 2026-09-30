import React, { useState, useMemo, useEffect, useId } from "react";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { auth } from "./firebase";
import { persist as persistCache, loadCached } from "./syncCache";
import { buildAgg, reportFromAgg, tsOf } from "./logic";
import { compressImage, isImageFile, beginPicking, endPicking, isPicking } from "./imageUtil";
import {
  subscribe,
  addItem,
  updateItem,
  deleteItem,
  subscribeAdminPassword,
  ensureAdminPasswordDoc,
  setAdminPasswordRemote,
} from "./dataService";

// ---------- Design tokens ----------
// Background: warm paper (#F6F3EC) · Ink: deep pine (#182620)
// Income: #2F6F4E (green) · Expense: #A6403B (brick) · Receivable("لي"): #2B6C8F (blue)
// Payable("عليّ"): #B5721E (amber-brown) · Net profit accent: #C9A34A (muted gold)
// Text (Arabic): 'Tajawal' · Figures (ledger numbers): monospace, tabular-nums

const DEFAULT_ADMIN_PASSWORD = "Daftar2026";

const COLORS = {
  bg: "#F6F3EC",
  card: "#F8F7F2",
  ink: "#182620",
  inkSoft: "#5C6B62",
  line: "#E4DFD2",
  income: "#2F6F4E",
  expense: "#A6403B",
  receivable: "#2B6C8F",
  payable: "#B5721E",
  gold: "#B8933A",
  goldBg: "#FBF3DF",
  netBg: "#DDF4D8",
  debtTotalBg: "#FFE8B8",
  paymentBg: "#DDF4D8",
  incomeBg: "#D8EAF9",
  debtBtn: "#E4B429",
  paymentBtn: "#2563C7",
  expenseLight: "#F7D9D7",
  invoiceCard: "#EEECE5",
  bar: "#0E4D4D",
  button: "#182620",
  buttonText: "#FFFFFF",
  inputBg: "#FFFFFF",
  shopIcon: "د",
  incomeCard: "#EAF5EE",
  expenseCard: "#FBEAE9",
  debtCard: "#FFF3D8",
  paymentCard: "#EAF0F8",
  supplierCard: "#FFFFFF",
  navButton: "#145A58",
};

const THEME_KEY = "daftar_ui_theme_v3";
const DEFAULT_THEME = {
  ...COLORS,
  mode: "light",
  reportCards: [COLORS.netBg, "#FBEAE9", COLORS.incomeBg, COLORS.debtTotalBg],
  supplierPaletteA: ["#EAF0F8", "#D8EAF9", "#FFFFFF"],
  supplierPaletteB: ["#FBF3DF", "#FBEAE9", "#E9F8EE"],
  categories: ["طعام", "مواصلات", "مواد أولية", "فواتير", "أخرى"],
};
function readTheme() {
  try { return { ...DEFAULT_THEME, ...(JSON.parse(localStorage.getItem(THEME_KEY) || "{}")) }; } catch { return { ...DEFAULT_THEME }; }
}
function applyTheme(theme) {
  Object.assign(COLORS, theme || {});
  inputStyle.background = theme?.inputBg || COLORS.card || "#fff";
  inputStyle.border = `1px solid ${theme?.line || COLORS.line}`;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.themeMode = theme?.mode || "light";
    document.documentElement.style.setProperty("--app-bg", theme?.bg || COLORS.bg);
    document.documentElement.style.setProperty("--app-card", theme?.card || COLORS.card);
    document.documentElement.style.setProperty("--app-ink", theme?.ink || COLORS.ink);
    document.documentElement.style.setProperty("--app-bar", theme?.bar || "#0E4D4D");
  }
}
function saveTheme(theme) {
  const next = { ...DEFAULT_THEME, ...theme };
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch {}
  applyTheme(next);
  window.dispatchEvent(new CustomEvent("daftar-theme-change", { detail: next }));
  return next;
}
// يفصل الصورة المضغوطة (dataUrl) عن بيانات المرفق: attachment = {name,type} و image = dataUrl
// (Firestore يرفض القيم undefined، لذلك نضمن null عند عدم وجود مرفق)
function withAttachments(data) {
  const legacy = data.attachment?.dataUrl ? [data.attachment] : [];
  const list = Array.isArray(data.attachments) ? data.attachments : legacy;
  const attachments = list.slice(0, 3).map((a) => {
    const { dataUrl, ...meta } = a || {};
    return dataUrl ? { ...meta, dataUrl } : meta;
  });
  const clean = { ...data };
  delete clean.attachment;
  delete clean.image;
  return { ...clean, attachments };
}

function whatsappNumber(phone) {
  let n = String(phone || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = "213" + n.slice(1);
  return n;
}

function downloadDataUrl(dataUrl, name = "مرفق.jpg") {
  if (!dataUrl) return;
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();

const BIOMETRIC_KEY = "daftar_admin_native_biometric_enabled";

// Capacitor Android/iOS: use the OS biometric prompt. Browser/PWA: keep the
// existing WebAuthn path so the same project still works on the web.
import { Capacitor } from "@capacitor/core";
import { NativeBiometric } from "@rolster/capacitor-native-biometric";

function isNativeCapacitor() {
  return Capacitor.isNativePlatform();
}
function webAuthnSupported() {
  return typeof window !== "undefined" && window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;
}
function hasBiometricCredential() {
  try {
    return localStorage.getItem(BIOMETRIC_KEY) === "1" && (isNativeCapacitor() ? !!NativeBiometric : webAuthnSupported());
  } catch { return false; }
}
function biometricErrorMessage(e) {
  const name = e?.name || "";
  const msg = String(e?.message || e || "");
  if (/cancel|user.*cancel|dismiss/i.test(msg) || name === "NotAllowedError") return "تم إلغاء التحقق بالبصمة";
  if (name === "InvalidStateError") return "بصمة الأدمن على هذا الجهاز غير صالحة — أعد تفعيلها من كلمة المرور";
  if (name === "NotSupportedError" || name === "SecurityError") return "البصمة غير مدعومة على هذا الجهاز";
  return msg || "تعذّر التحقق بالبصمة";
}
async function registerAdminBiometric() {
  if (isNativeCapacitor() && NativeBiometric) {
    const available = await NativeBiometric.isAvailable();
    if (!available?.isAvailable) throw new Error("لا توجد بصمة أو وسيلة تحقق حيوية مفعّلة على هذا الجهاز");
    localStorage.setItem(BIOMETRIC_KEY, "1");
    return true;
  }
  if (!webAuthnSupported()) throw new Error("البصمة غير متاحة في هذا المتصفح؛ استخدم HTTPS أو نسخة APK.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({ publicKey: {
    challenge,
    rp: { name: "دفتر" },
    user: { id: userId, name: "admin@daftar.local", displayName: "مدير دفتر" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    timeout: 60000,
    attestation: "none",
  }});
  if (!cred) throw new Error("تعذّر إنشاء بصمة الأدمن");
  localStorage.setItem(BIOMETRIC_KEY, "1");
  return true;
}
async function verifyAdminBiometric() {
  if (isNativeCapacitor() && NativeBiometric) {
    if (!localStorage.getItem(BIOMETRIC_KEY)) throw new Error("لم يتم تفعيل بصمة الأدمن بعد");
    const available = await NativeBiometric.isAvailable();
    if (!available?.isAvailable) throw new Error("البصمة غير متاحة على هذا الجهاز");
    await NativeBiometric.verifyIdentity({
      reason: "فتح تطبيق دفتر",
      title: "التحقق من الهوية",
      subtitle: "استخدم بصمة إصبعك لفتح التطبيق",
      description: "تأكيد هوية مدير التطبيق",
    });
    return true;
  }
  if (!webAuthnSupported()) throw new Error("البصمة غير متاحة في هذا المتصفح");
  // Browser WebAuthn remains supported for PWA/web builds.
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const result = await navigator.credentials.get({ publicKey: {
    challenge,
    userVerification: "required",
    timeout: 60000,
  }});
  return !!result;
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " دج";
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " — " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// Ledger-style number span
function Fig({ children, className = "", style = {} }) {
  return (
    <span
      className={className}
      style={{ fontFamily: "'JetBrains Mono','Menlo',monospace", fontVariantNumeric: "tabular-nums", fontWeight: 600, ...style }}
    >
      {children}
    </span>
  );
}

function debtStatusLabel(s) {
  return { unpaid: "غير مسدد", partial: "مسدد جزئيًا", paid: "مسدد بالكامل" }[s] || s;
}
function debtStatusColor(s) {
  return { unpaid: COLORS.expense, partial: COLORS.payable, paid: COLORS.income }[s] || COLORS.inkSoft;
}
function paymentStatusLabel(s) {
  return { pending: "بانتظار تأكيد الأدمن", confirmed: "مؤكد", rejected: "مرفوض" }[s] || s;
}
function supportStatusLabel(s) {
  return { new: "جديد", in_review: "قيد المراجعة", resolved: "تم الحل", rejected: "مرفوض" }[s] || s;
}

// ---------- Small UI atoms ----------
// يُمرَّر onClick (وأي خصائص أخرى مثل onKeyDown) إلى الـ div مباشرة — من دون هذا
// التمرير، أي <Card onClick={...}> لا يفتح شيئًا عند الضغط (وهذا كان سبب تعطّل
// فتح بطاقة المورد سابقًا). عند وجود onClick تُضاف أيضًا role/tabIndex ودعم
// لوحة المفاتيح (Enter/Space) لتبقى البطاقة قابلة للتفعيل بأكثر من طريقة.
function Card({ children, className = "", style = {}, onClick, ...rest }) {
  const interactive = typeof onClick === "function";
  return (
    <div
      className={`rounded-2xl ui-card ${className}`}
      style={{ background: COLORS.card, border: `1px solid ${COLORS.line}`, ...style }}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } } : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const base = "px-4 py-2.5 rounded-xl text-[14px] font-bold ui-button transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100";
  const styles = {
    primary: { background: COLORS.button || COLORS.ink, color: COLORS.buttonText || "#fff" },
    ghost: { background: "transparent", color: COLORS.ink, border: `1px solid ${COLORS.line}` },
    income: { background: COLORS.income, color: "#fff" },
    expense: { background: COLORS.expense, color: "#fff" },
    danger: { background: COLORS.expense, color: "#fff", border: `1px solid ${COLORS.expense}` },
    gold: { background: COLORS.gold, color: "#fff" },
    debt: { background: COLORS.debtBtn, color: COLORS.ink },
    payment: { background: COLORS.paymentBtn, color: "#fff" },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${base} ${className}`} style={styles[variant]}>
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-[13px] mb-1 font-bold" style={{ color: COLORS.inkSoft }}>{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl px-3 py-2.5 text-[15px] outline-none focus:ring-2 transition";
const inputStyle = { border: `1px solid ${COLORS.line}`, background: COLORS.inputBg || "#fff" };
applyTheme(readTheme());

function TextInput(props) {
  return <input {...props} className={inputCls} style={{ ...inputStyle, ...(props.style || {}) }} dir={props.dir} />;
}
function TextArea(props) {
  return <textarea {...props} className={inputCls} style={inputStyle} rows={props.rows || 3} />;
}

function Modal({ title, onClose, children, wide, zClass = "z-50" }) {
  return (
    <div className={`fixed inset-0 ${zClass} flex items-end sm:items-center justify-center`} style={{ background: "rgba(24,38,32,0.45)" }} onClick={onClose}>
      <div
        className={`w-full ${wide ? "sm:max-w-lg" : "sm:max-w-md"} rounded-t-3xl sm:rounded-3xl max-h-[90vh] overflow-y-auto`}
        style={{ background: COLORS.bg }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 sticky top-0" style={{ background: COLORS.bg, borderBottom: `1px solid ${COLORS.line}` }}>
          <h3 className="text-[17px] font-extrabold" style={{ color: /حذف|خروج|تنبيه|تحذير/.test(title) ? COLORS.expense : COLORS.ink }}>{title}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: COLORS.card, color: COLORS.inkSoft }}>✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function FileAttach({ files = [], onChange, label = "إرفاق فواتير أو صور (اختياري)" }) {
  const inputId = useId();
  const cameraId = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const addFiles = async (picked) => {
    const list = Array.from(picked || []).slice(0, 3 - files.length);
    endPicking();
    if (!list.length) return;
    setBusy(true); setErr("");
    const out = [];
    let lastErr = "";
    for (const f of list) {
      try {
        if (!isImageFile(f)) throw new Error("الرجاء اختيار صور فقط للفواتير");
        out.push(await compressImage(f));
      } catch (e) { lastErr = e?.message || "تعذّر تجهيز الصورة"; }
    }
    if (out.length) onChange([...(files || []), ...out].slice(0, 3));
    setErr(lastErr);
    setBusy(false);
  };
  const onPick = async (e) => { const picked = Array.from(e.target.files || []); e.target.value = ""; await addFiles(picked); };
  const full = files.length >= 3;
  return (
    <Field label={`${label} — حتى 3 صور`}>
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={inputId} className="flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-[14px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, background: COLORS.card, color: COLORS.inkSoft, opacity: full ? .5 : 1 }}>
          📎 اختيار الصور
        </label>
        <label htmlFor={cameraId} className="flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-[14px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, background: COLORS.goldBg, color: COLORS.ink, opacity: full ? .5 : 1 }}>
          📷 تصوير فاتورة
        </label>
      </div>
      <input id={inputId} type="file" accept="image/*" multiple disabled={full} onClick={beginPicking} onCancel={endPicking} onChange={onPick} className="sr-only" />
      <input id={cameraId} type="file" accept="image/*" capture="environment" disabled={full} onClick={beginPicking} onCancel={endPicking} onChange={onPick} className="sr-only" />
      {busy && <p className="text-[12px] mt-2" style={{ color: COLORS.inkSoft }}>جارٍ تجهيز الصور...</p>}
      {!!files.length && <div className="grid grid-cols-3 gap-2 mt-2">
        {files.map((f, i) => <div key={i} className="relative">
          <img src={f.dataUrl} alt={f.name || `صورة ${i+1}`} className="w-full aspect-square object-cover rounded-xl" />
          <button type="button" onClick={() => onChange(files.filter((_, idx) => idx !== i))} className="absolute top-1 left-1 w-7 h-7 rounded-full text-white bg-black/60">×</button>
        </div>)}
      </div>}
      {err && <p className="text-[12px] mt-1" style={{ color: COLORS.expense }}>{err}</p>}
    </Field>
  );
}

function AttachmentsView({ item, admin = false }) {
  const files = Array.isArray(item?.attachments) ? item.attachments : (item?.image ? [{ name: item.attachment?.name || "مرفق", dataUrl: item.image }] : []);
  if (!files.length) return null;
  return <div className="mt-2 grid grid-cols-3 gap-2">{files.map((f, i) => <div key={i}>
    <img src={f.dataUrl} alt={f.name || `مرفق ${i+1}`} className="w-full aspect-square object-cover rounded-xl" />
    {admin && f.dataUrl && <button type="button" onClick={() => downloadDataUrl(f.dataUrl, f.name || `invoice-${i+1}.jpg`)} className="w-full mt-1 text-[11px] font-bold rounded-lg py-1.5" style={{ background: COLORS.goldBg, color: COLORS.ink }}>⬇ تنزيل</button>}
  </div>)}</div>;
}

// ================= APP =================
export default function App() {
  const [view, setView] = useState("select"); // select | admin | user
  const [pinModal, setPinModal] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [toast, setToast] = useState(null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [theme, setTheme] = useState(() => readTheme());
  const [adminPin, setAdminPin] = useState(() => { try { return localStorage.getItem("daftar_admin_backup_pin") || ""; } catch { return ""; } });

  const [authReady, setAuthReady] = useState(false);
  const [connError, setConnError] = useState(false);
  const [adminPassword, setAdminPassword] = useState(DEFAULT_ADMIN_PASSWORD);

  const [incomes, setIncomes] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [debts, setDebts] = useState([]);
  const [payments, setPayments] = useState([]);
  const [supportRequests, setSupportRequests] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierTransactions, setSupplierTransactions] = useState([]);

  // نسخة "آخر ما نعرفه" مأخوذة من تخزين الهاتف المحلي (آخر 50 عملية + الإجماليات
  // + الديون المفتوحة). تُستخدم للعرض الفوري عند فتح التطبيق بلا إنترنت، قبل أن
  // يصل Firestore (سواء من ذاكرته الداخلية أو من الخادم).
  const [cache, setCache] = useState(null); // null = لم تُقرأ بعد
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);

  useEffect(() => {
    loadCached().then(setCache).catch(() => setCache({ incomes: [], expenses: [], debts: [], payments: [], agg: {}, openDebts: [] }));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    const lock = () => { if (document.hidden && view !== "select" && !isPicking()) setView("select"); };
    document.addEventListener("visibilitychange", lock);
    window.addEventListener("pagehide", lock);
    return () => { document.removeEventListener("visibilitychange", lock); window.removeEventListener("pagehide", lock); };
  }, [view]);

  // Sign in anonymously so Firestore security rules can require an authenticated
  // request, without needing separate accounts for each of the 3 shop users.
  // ملاحظة: إن كان المستخدم قد سجّل دخوله من قبل، تستعيد Firebase Auth الجلسة من
  // تخزين الهاتف تلقائيًا حتى بلا إنترنت، فيصبح authReady=true دون اتصال أيضًا،
  // وتُقرأ عندها بيانات Firestore المخزّنة محليًا (وليست الـ50 المصغّرة فقط).
  function attemptSignIn() {
    setConnError(false);
    signInAnonymously(auth).catch(() => setConnError(true));
  }
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) { setAuthReady(true); setConnError(false); }
      else attemptSignIn();
    });
    return unsub;
  }, []);
  // إن عاد الاتصال بالإنترنت بعد فشل أول محاولة دخول، نعيد المحاولة تلقائيًا
  // بدل تجميد شاشة "جارٍ الاتصال..." إلى أن يُغلق المستخدم التطبيق ويعيد فتحه.
  useEffect(() => {
    if (isOnline && connError && !authReady) attemptSignIn();
  }, [isOnline, connError, authReady]);

  // Once signed in, subscribe to live data from Firestore — every phone using
  // the app sees the same data update in real time.
  useEffect(() => {
    if (!authReady) return;
    const unsubs = [
      subscribe("income", setIncomes),
      subscribe("expense", setExpenses),
      subscribe("debt", setDebts),
      subscribe("payment", setPayments),
      subscribe("support", setSupportRequests),
      subscribe("supplier", setSuppliers),
      subscribe("supplierTransaction", setSupplierTransactions),
    ];
    ensureAdminPasswordDoc(DEFAULT_ADMIN_PASSWORD).catch(() => {});
    const unsubPass = subscribeAdminPassword(setAdminPassword);
    return () => { unsubs.forEach((u) => u()); unsubPass(); };
  }, [authReady]);

  // كلما تغيّرت البيانات الحية، نحدّث نسخة الهاتف المحلية (آخر 50 + الإجماليات)
  // في الخلفية دون انتظار — هذا ما يحقق "احتفظ محليًا بآخر 50 عملية".
  // لا نحفظ قبل وصول بيانات فعلية، كي لا تُستبدل الإجماليات المخزّنة بقيم فارغة أثناء بدء التطبيق
  const gotFirstSnapshot = incomes.length + expenses.length + debts.length + payments.length > 0;
  useEffect(() => {
    if (!gotFirstSnapshot) return;
    persistCache({ incomes, expenses, debts, payments }).catch(() => {});
  }, [incomes, expenses, debts, payments, gotFirstSnapshot]);

  // البيانات المعروضة: الحيّة إن وصلت، وإلا نسخة الهاتف المحفوظة (بلا إنترنت عند أول فتح)
  const useLive = authReady;
  const dIncomes = useLive ? incomes : cache?.incomes || [];
  const dExpenses = useLive ? expenses : cache?.expenses || [];
  const dDebts = useLive ? debts : cache?.debts || [];
  const dPayments = useLive ? payments : cache?.payments || [];

  useEffect(() => {
    const handler = (e) => { const next = e.detail || readTheme(); setTheme(next); applyTheme(next); };
    window.addEventListener("daftar-theme-change", handler);
    return () => window.removeEventListener("daftar-theme-change", handler);
  }, []);

  useEffect(() => { setBiometricReady(hasBiometricCredential()); }, [pinModal]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // ---------- Write-through actions (every write goes to Firestore; the
  // subscriptions above bring the change back into local state automatically) ----------
  const addIncome = (amount) => addItem("income", { amount, date: todayISO(), createdAt: nowISO() });
  const addExpense = (data) => addItem("expense", { ...withAttachments(data), date: todayISO(), createdAt: nowISO() });
  const addDebt = (data) => addItem("debt", { ...withAttachments(data), paidAmount: 0, remainingAmount: data.amount, status: "unpaid", date: todayISO(), createdAt: nowISO() });
  const addPayment = (data) => addItem("payment", { ...withAttachments(data), status: "pending", date: todayISO(), createdAt: nowISO() });
  const addSupportRequest = (data) => addItem("support", { ...withAttachments(data), status: "new", adminReply: "", senderUid: auth.currentUser?.uid || "", createdAt: nowISO() });
  const addSupplier = (data) => addItem("supplier", { ...data, createdAt: nowISO() });

  async function confirmPayment(p) {
    const d = debts.find((x) => x.id === p.debtId);
    if (!d) return;
    const paid = (d.paidAmount || 0) + p.amount;
    const remaining = Math.max(d.amount - paid, 0);
    await updateItem("payment", p.id, { status: "confirmed" });
    await updateItem("debt", d.id, { paidAmount: paid, remainingAmount: remaining, status: remaining === 0 ? "paid" : "partial" });
  }
  const rejectPayment = (p) => updateItem("payment", p.id, { status: "rejected" });

  function finishAdminLogin() {
    setPinModal(false);
    setPinValue("");
    setPinError("");
    setView("admin");
  }
  function tryAdminLogin() {
    if (pinValue === adminPassword || (adminPin && pinValue === adminPin)) finishAdminLogin();
    else setPinError("كلمة المرور أو رمز PIN غير صحيح");
  }
  async function tryBiometricLogin() {
    setBiometricBusy(true); setPinError("");
    try {
      await verifyAdminBiometric();
      finishAdminLogin();
    } catch (e) {
      setPinError(biometricErrorMessage(e));
    } finally { setBiometricBusy(false); }
  }
  // الضغط على "أدمن": إن كانت البصمة مفعّلة على هذا الجهاز من قبل، نطلقها فورًا
  // بنفس الضغطة (فتح فعلي بالبصمة، لا ضغطة إضافية) مع فتح نافذة كلمة المرور في
  // نفس الوقت كخيار احتياطي إن أُلغيت البصمة أو فشلت.
  function handleAdminTap() {
    setPinValue(""); setPinError(""); setPinModal(true);
    if (hasBiometricCredential()) {
      // ابدأ التحقق فورًا، مع إبقاء كلمة المرور كخيار احتياطي.
      tryBiometricLogin();
    }
  }
  async function enableBiometric() {
    setBiometricBusy(true); setPinError("");
    try {
      if (pinValue !== adminPassword) throw new Error("أدخل كلمة المرور الصحيحة أولاً لتفعيل البصمة");
      await registerAdminBiometric();
      setBiometricReady(true);
      setPinError("تم تفعيل الدخول بالبصمة لهذا الجهاز");
    } catch (e) { setPinError(biometricErrorMessage(e)); }
    finally { setBiometricBusy(false); }
  }
  function disableBiometric() {
    try { localStorage.removeItem(BIOMETRIC_KEY); } catch {}
    setBiometricReady(false);
    setPinError("تم إلغاء الدخول بالبصمة من هذا الجهاز");
  }

  // نعرض شاشة الانتظار فقط إن لم يصل Firestore بعد ولم تُقرأ الذاكرة المحلية بعد.
  // إن وُجدت نسخة محلية (من فتحة سابقة) نعرض التطبيق بها فورًا حتى بلا إنترنت.
  if (!authReady && !cache) {
    return (
      <div dir="rtl" lang="ar" className="min-h-screen w-full flex flex-col items-center justify-center gap-4 px-6 text-center" style={{ background: COLORS.bg, fontFamily: "'Tajawal', sans-serif", color: COLORS.inkSoft }}>
        <span>{connError ? "تعذّر الاتصال — تحقّق من الإنترنت وإعدادات Firebase" : "جارٍ الاتصال..."}</span>
        {connError && <Button className="!px-6" onClick={attemptSignIn}>إعادة المحاولة</Button>}
      </div>
    );
  }

  return (
    <div dir="rtl" lang="ar" className="min-h-screen w-full" style={{ background: COLORS.bg, fontFamily: "'Tajawal', sans-serif", color: COLORS.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=JetBrains+Mono:wght@500;600;700&display=swap');
        * { box-sizing: border-box; }
        input:focus, textarea:focus, select:focus { box-shadow: 0 0 0 3px ${COLORS.goldBg}; border-color: ${COLORS.gold}; }
      `}</style>

      {!isOnline && (
        <div className="fixed top-0 inset-x-0 z-[70] text-center text-[12px] font-bold py-1.5" style={{ background: COLORS.gold, color: "#fff" }}>
          غير متصل — سيتم رفع العمليات تلقائيًا عند عودة الإنترنت
        </div>
      )}

      {view === "select" && (
        <RoleSelect onUser={() => setView("user")} onAdmin={handleAdminTap} />
      )}

      {view === "user" && (
        <UserApp
          incomes={dIncomes} expenses={dExpenses} debts={dDebts} payments={dPayments}
          openDebtsCache={cache?.openDebts || []} useLive={useLive} supportRequests={supportRequests}
          addIncome={addIncome} addExpense={addExpense} addDebt={addDebt} addPayment={addPayment} addSupportRequest={addSupportRequest} addSupplier={addSupplier}
          showToast={showToast}
          onExit={() => setView("select")}
          theme={theme}
          onOpenAdmin={() => {}}
        />
      )}

      {view === "admin" && (
        <AdminApp
          incomes={dIncomes} expenses={dExpenses} debts={dDebts} payments={dPayments} supportRequests={supportRequests} suppliers={suppliers} supplierTransactions={supplierTransactions}
          aggCache={cache?.agg || {}} useLive={useLive}
          confirmPayment={confirmPayment} rejectPayment={rejectPayment}
          showToast={showToast}
          onExit={() => setView("select")}
          adminPassword={adminPassword}
          onChangePassword={setAdminPasswordRemote}
          theme={theme}
          adminPin={adminPin}
          onSavePin={(pin) => { setAdminPin(pin); try { if (pin) localStorage.setItem("daftar_admin_backup_pin", pin); else localStorage.removeItem("daftar_admin_backup_pin"); } catch {} }}
          onSaveTheme={(next) => setTheme(saveTheme(next))}
        />
      )}

      {pinModal && (
        <Modal title="دخول الأدمن" onClose={() => { setPinModal(false); setPinValue(""); setPinError(""); }}>
          <Field label="كلمة المرور">
            <TextInput
              type="password"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              placeholder="كلمة المرور"
              dir="ltr"
              style={{ textAlign: "center", letterSpacing: "2px", fontSize: "18px" }}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") tryAdminLogin(); }}
            />
          </Field>
          {pinError && <p className="text-[13px] mb-3" style={{ color: pinError.includes("تم تفعيل") ? COLORS.income : COLORS.expense }}>{pinError}</p>}
          <Button className="w-full" onClick={tryAdminLogin} disabled={biometricBusy}>دخول بكلمة المرور</Button>
          {biometricReady && <Button variant="gold" className="w-full mt-2" onClick={tryBiometricLogin} disabled={biometricBusy}>⌾ دخول بالبصمة</Button>}
          {biometricReady ? (
            <Button variant="ghost" className="w-full mt-2 !py-2 !text-[13px]" onClick={disableBiometric} disabled={biometricBusy}>إلغاء البصمة من هذا الجهاز</Button>
          ) : (
            <Button variant="ghost" className="w-full mt-2 !py-2 !text-[13px]" onClick={enableBiometric} disabled={biometricBusy}>تفعيل البصمة لهذا الجهاز</Button>
          )}
        </Modal>
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] px-5 py-3 rounded-full text-[14px] font-bold shadow-lg" style={{ background: COLORS.ink, color: "#fff" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------- Role select ----------
function RoleSelect({ onUser, onAdmin }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10">
      <div className="mb-10 text-center">
        <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center text-2xl" style={{ background: COLORS.ink, color: COLORS.goldBg }}>{COLORS.shopIcon || "د"}</div>
        <h1 className="text-[28px] font-black mb-1" style={{ color: COLORS.ink }}>دفتر</h1>
        <p className="text-[14px]" style={{ color: COLORS.inkSoft }}>إدارة المداخيل، المصاريف، والديون</p>
      </div>

      <div className="w-full max-w-sm space-y-4">
        <button onClick={onUser} className="w-full text-right p-5 rounded-2xl transition active:scale-[0.98]" style={{ background: COLORS.card, border: `1px solid ${COLORS.line}` }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[17px] font-extrabold mb-0.5">مستخدم</div>
              <div className="text-[13px]" style={{ color: COLORS.inkSoft }}>تسجيل العمليات اليومية</div>
            </div>
            <div className="w-11 h-11 rounded-full flex items-center justify-center text-lg" style={{ background: COLORS.goldBg, color: COLORS.gold }}>←</div>
          </div>
        </button>

        <button onClick={onAdmin} className="w-full text-right p-5 rounded-2xl transition active:scale-[0.98]" style={{ background: COLORS.ink }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[17px] font-extrabold mb-0.5" style={{ color: "#fff" }}>أدمن</div>
              <div className="text-[13px]" style={{ color: "rgba(255,255,255,0.65)" }}>لوحة التحكم الكاملة</div>
            </div>
            <div className="w-11 h-11 rounded-full flex items-center justify-center text-lg" style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}>←</div>
          </div>
        </button>
      </div>
    </div>
  );
}

// ---------- Support button + modal (shared) ----------
function SupportButton({ onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full text-[12px] font-bold shadow-md flex items-center gap-1.5"
      style={{ background: "#fff", border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}
    >
      <span>💬</span> الدعم والشكوى
    </button>
  );
}

function SupportModal({ onClose, onSubmit }) {
  const draft = useMemo(() => { try { return JSON.parse(localStorage.getItem("daftar_support_draft") || "{}"); } catch { return {}; } }, []);
  const [type, setType] = useState(draft.type || "daily_change_request");
  const [title, setTitle] = useState(draft.title || "");
  const [description, setDescription] = useState(draft.description || "");
  const [files, setFiles] = useState([]);
  // نحفظ النص أثناء الكتابة كي لا يضيع إن أُعيد تحميل التطبيق أثناء فتح الكاميرا
  useEffect(() => { try { localStorage.setItem("daftar_support_draft", JSON.stringify({ type, title, description })); } catch {} }, [type, title, description]);

  return (
    <Modal title="الدعم والشكوى" onClose={onClose}>
      <Field label="نوع الطلب">
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="daily_change_request">طلب تغيير شيء غير مناسب في اليوم</option>
          <option value="complaint">شكوى أو ملاحظة</option>
        </select>
      </Field>
      <Field label="العنوان">
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان مختصر" />
      </Field>
      <Field label="وصف المشكلة بالتفصيل">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="اكتب التفاصيل هنا..." />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button
        className="w-full mt-2"
        disabled={!title || !description}
        onClick={() => { try { localStorage.removeItem("daftar_support_draft"); } catch {} onSubmit({ type, title, description, attachments: files }); onClose(); }}
      >
        إرسال الطلب
      </Button>
    </Modal>
  );
}

// ---------- Top bar: icons only ----------
// في الواجهة العربية (RTL) أول عنصر يظهر يمين الشاشة: القائمة يمينًا، الإشعارات يسارًا.
function AppHeader({ onMenu, onBell, unread = 0 }) {
  const icon = (n) => `${import.meta.env.BASE_URL}icons/${n}.png`;
  const btn = "relative w-11 h-11 rounded-xl flex items-center justify-center";
  return (
    <header className="sticky top-0 z-30 px-4 py-2.5 flex items-center justify-between" style={{ background: COLORS.bar, color: "#fff", paddingTop: "calc(0.625rem + env(safe-area-inset-top, 0px))" }}>
      <button onClick={onMenu} className={btn} style={{ background: "rgba(255,255,255,.10)" }} aria-label="القائمة"><img src={icon("more")} alt="" className="w-7 h-7 object-contain" draggable="false" /></button>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl font-black" style={{ background: "rgba(255,255,255,.14)" }}>{COLORS.shopIcon || "د"}</div>
      <button onClick={onBell} className={btn} style={{ background: "rgba(255,255,255,.10)" }} aria-label="الإشعارات">
        <img src={icon("notification")} alt="" className="w-7 h-7 object-contain" draggable="false" />
        {unread > 0 && <span className="absolute top-1 left-1 w-2.5 h-2.5 rounded-full" style={{ background: "#E53935" }} />}
      </button>
    </header>
  );
}

// ================= USER APP =================
function UserApp({ incomes, expenses, debts, payments, openDebtsCache, useLive, supportRequests = [], addIncome, addExpense, addDebt, addPayment, addSupportRequest, addSupplier, showToast, onExit, theme }) {
  const paymentDebts = useLive ? debts : (debts.length ? debts : openDebtsCache);
  const [drawer,setDrawer]=useState(false); const [noticeOpen,setNoticeOpen]=useState(false); const [calcOpen,setCalcOpen]=useState(false);
  const [noticeRead,setNoticeRead]=useState(()=>{try{return JSON.parse(localStorage.getItem("daftar_user_notice_read")||"[]")}catch{return[]}});
  const [dark,setDark]=useState(theme.mode==="dark");
  const userNotices=supportRequests.filter(r=>r.senderUid===auth.currentUser?.uid && r.adminReply);
  const unread=userNotices.filter(r=>!noticeRead.includes(r.id)).length;
  function markNoticesRead(){const ids=userNotices.map(r=>r.id);setNoticeRead(ids);try{localStorage.setItem("daftar_user_notice_read",JSON.stringify(ids))}catch{};setNoticeOpen(true)}
  function toggleDark(){const next=saveTheme({...readTheme(),mode:dark?"light":"dark",bg:dark?DEFAULT_THEME.bg:"#101615",card:dark?DEFAULT_THEME.card:"#18211F",ink:dark?DEFAULT_THEME.ink:"#F4F7F5",inkSoft:dark?DEFAULT_THEME.inkSoft:"#B7C3BD",line:dark?DEFAULT_THEME.line:"#33413B",inputBg:dark?"#FFFFFF":"#202B27",bar:dark?DEFAULT_THEME.bar:"#092F2E"});setDark(!dark)}
  const [modal, setModal] = useState(null); // 'income'|'expense'|'debt'|'payment'|'support'
  const [debtTab, setDebtTab] = useState("receivable");
  const [incomeConfirm, setIncomeConfirm] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);

  const today = todayISO();
  const todayIncome = incomes.find((i) => i.date === today);
  const todayExpenses = expenses.filter((e) => e.date === today);
  const todayDebts = debts.filter((d) => d.date === today);

  const feed = useMemo(() => {
    const items = [
      ...(todayIncome ? [{ kind: "income", ...todayIncome }] : []),
      ...todayExpenses.map((e) => ({ kind: "expense", ...e })),
      ...todayDebts.map((d) => ({ kind: "debt", ...d })),
      ...payments.filter((p) => p.date === today).map((p) => ({ kind: "payment", ...p })),
    ];
    return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [todayIncome, todayExpenses, todayDebts, payments, today]);

  return (
    <div className="min-h-screen max-w-lg mx-auto">
      <AppHeader onMenu={()=>setDrawer(true)} onBell={markNoticesRead} unread={unread} />
      <div className="px-5 pt-5 pb-4"><div className="text-[13px]" style={{color:COLORS.inkSoft}}>{fmtDate(today)}</div><div className="text-[20px] font-black">لوحة اليوم</div></div>

      {/* quick actions */}
      <div className="px-5 grid grid-cols-2 gap-3 mb-6">
        {todayIncome ? (
          <div className="col-span-2 rounded-xl px-4 py-3 text-center text-[13px] font-bold" style={{ background: COLORS.goldBg, color: COLORS.gold }}>
            {Date.now()-new Date(todayIncome.createdAt||todayIncome.date).getTime() < 5*60*1000 ? <>تم تسجيل دخل اليوم بالفعل — <Fig>{fmtMoney(todayIncome.amount)}</Fig></> : <>تم إضافة الدخل اليومي — {fmtDateTime(todayIncome.createdAt||todayIncome.date)}</>}
          </div>
        ) : (
          <Button variant="income" className="col-span-2" onClick={() => setIncomeConfirm(true)}>+ تسجيل دخل اليوم</Button>
        )}
        <Button variant="expense" onClick={() => setModal("expense")}>+ إضافة مصروف</Button>
        <Button variant="debt" onClick={() => setModal("debt")}>+ إضافة دين</Button>
        <Button variant="payment" className="col-span-2" onClick={() => setModal("payment")}>+ تسجيل سداد</Button>
      </div>

      {/* today's operations */}
      <div className="px-5">
        <h2 className="text-[15px] font-extrabold mb-2">عمليات اليوم</h2>
        {feed.length === 0 && (
          <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد عمليات مسجلة اليوم</div>
        )}
        <div className="space-y-2">
          {feed.map((it) => (
            <OperationRow key={it.kind + it.id} item={it} debts={debts} />
          ))}
        </div>
      </div>

      {supportRequests.filter(r => r.senderUid && r.senderUid === auth.currentUser?.uid && r.adminReply).length > 0 && (
        <div className="px-5 mt-5">
          <Card className="p-4" style={{ border: `1px solid ${COLORS.gold}` }}>
            <div className="font-extrabold mb-2">ردود الأدمن</div>
            <div className="space-y-2">
              {supportRequests.filter(r => r.senderUid === auth.currentUser?.uid && r.adminReply).slice().reverse().map(r => (
                <div key={r.id} className="rounded-xl p-3" style={{ background: COLORS.goldBg }}>
                  <div className="text-[12px] font-bold mb-1">{r.title}</div>
                  <div className="text-[13px] leading-6">{r.adminReply}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}


      <SideDrawer open={drawer} onClose={()=>setDrawer(false)} title="القائمة">
        <DrawerButton icon="🔔" label="الإشعارات" badge={unread>0} onClick={()=>{setDrawer(false);markNoticesRead();}}/>
        <DrawerButton icon="💬" label="الدعم والشكوى" onClick={()=>{setDrawer(false);setModal("support")}}/>
        <DrawerButton icon={dark?"☀️":"🌙"} label={dark?"الوضع العادي":"الوضع الداكن"} onClick={toggleDark}/>
        <DrawerButton icon="🧮" label="آلة حاسبة" onClick={()=>setCalcOpen(true)}/>
        <DrawerButton icon="🚪" label="خروج" danger onClick={()=>{setDrawer(false);setExitConfirm(true)}}/>
      </SideDrawer>
      {noticeOpen&&<NotificationModal notices={userNotices} onClose={()=>setNoticeOpen(false)} role="user"/>}
      {calcOpen&&<CalculatorModal onClose={()=>setCalcOpen(false)}/>}

      {exitConfirm && (
        <Modal title="تأكيد الخروج" onClose={() => setExitConfirm(false)}>
          <p className="text-[14px] leading-7 mb-5">هل تريد الخروج من واجهة المستخدم؟</p>
          <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setExitConfirm(false)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={onExit}>خروج</Button></div>
        </Modal>
      )}

      {incomeConfirm && (
        <Modal title="تأكيد تسجيل دخل اليوم" onClose={() => setIncomeConfirm(false)}>
          <p className="text-[14px] leading-7 mb-5">سيتم تسجيل الدخل <b>مرة واحدة فقط لهذا اليوم</b>. بعد الحفظ لن يظهر زر تسجيل دخل آخر لليوم نفسه.</p>
          <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setIncomeConfirm(false)}>إلغاء</Button><Button variant="income" className="flex-1" onClick={() => { setIncomeConfirm(false); setModal("income"); }}>متابعة</Button></div>
        </Modal>
      )}

      {modal === "income" && (
        <IncomeForm
          onClose={() => setModal(null)}
          onSubmit={async (amount) => {
            try {
              await addIncome(amount);
              showToast("تم تسجيل دخل اليوم");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "expense" && (
        <ExpenseForm
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addExpense(data);
              showToast("تم إضافة المصروف");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "debt" && (
        <DebtForm
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addDebt(data);
              showToast("تم إضافة الدين");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "payment" && (
        <PaymentForm
          debts={paymentDebts}
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addPayment(data);
              showToast("تم إرسال طلب السداد، بانتظار تأكيد الأدمن");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
      {modal === "support" && (
        <SupportModal
          onClose={() => setModal(null)}
          onSubmit={async (data) => {
            try {
              await addSupportRequest(data);
              showToast("تم إرسال طلبك للأدمن");
            } catch (e) {
              showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
            }
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color, bg }) {
  return (
    <Card className="p-[12.6px]" style={{ background: bg || COLORS.invoiceCard, borderColor: COLORS.line }}>
      <div className="text-[11px] font-bold mb-1" style={{ color: COLORS.inkSoft }}>{label}</div>
      <Fig className="text-[17px]" style={{ color }}>{fmtMoney(value)}</Fig>
    </Card>
  );
}

function OperationRow({ item, debts }) {
  const map = {
    income: { label: "دخل اليوم", color: COLORS.income, icon: "↓" },
    expense: { label: item.description || "مصروف", color: COLORS.expense, icon: "↑" },
    debt: { label: `${item.type === "receivable" ? "دين لي" : "دين عليّ"} — ${item.person}`, color: item.type === "receivable" ? COLORS.receivable : COLORS.payable, icon: "≈" },
    payment: { label: `سداد دين — ${debts.find((d) => d.id === item.debtId)?.person || ""}`, color: COLORS.gold, icon: "✓" },
  };
  const m = map[item.kind];
  return (
    <Card className="p-3.5 flex items-center justify-between" style={{background:item.kind==="income"?COLORS.incomeCard:item.kind==="expense"?COLORS.expenseCard:item.kind==="debt"?COLORS.debtCard:item.kind==="payment"?COLORS.paymentCard:COLORS.card}}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-[15px] font-bold" style={{ background: m.color + "1A", color: m.color }}>{m.icon}</div>
        <div>
          <div className="text-[14px] font-bold">{m.label}</div>
          <div className="text-[12px]" style={{ color: COLORS.inkSoft }}>
            {new Date(item.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            {item.kind === "payment" && ` · ${paymentStatusLabel(item.status)}`}
            {item._pending && " · ⏳ بانتظار الرفع"}
          </div>
        </div>
      </div>
      {item.kind === "income" && Date.now() - new Date(item.createdAt||item.date).getTime() >= 5*60*1000 ? <div className="text-[11px] font-bold text-right" style={{color:COLORS.inkSoft}}>تمت الإضافة</div> : <Fig style={{ color: m.color }}>{fmtMoney(item.amount)}</Fig>}
    </Card>
  );
}

function IncomeForm({ onClose, onSubmit }) {
  const [amount, setAmount] = useState("");
  return (
    <Modal title="تسجيل دخل اليوم" onClose={onClose}>
      <Field label="قيمة الدخل (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <p className="text-[12px] mb-4" style={{ color: COLORS.inkSoft }}>سيتم تسجيل التاريخ تلقائيًا بتاريخ اليوم. لا يمكن تسجيل أكثر من دخل واحد في اليوم.</p>
      <Button variant="income" className="w-full" disabled={!amount || Number(amount) <= 0} onClick={() => { onSubmit(Number(amount)); onClose(); }}>
        تأكيد الدخل
      </Button>
    </Modal>
  );
}

function ExpenseForm({ onClose, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [category, setCategory] = useState("");
  const [files, setFiles] = useState([]);
  return (
    <Modal title="إضافة مصروف" onClose={onClose}>
      <Field label="المبلغ (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <Field label="وصف المصروف">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="مثال: شراء مواد أولية" />
      </Field>
      <Field label="التصنيف">
        <select value={category} onChange={e=>setCategory(e.target.value)} className={inputCls} style={inputStyle}><option value="">اختر تصنيفًا</option>{readTheme().categories.map(c=><option key={c} value={c}>{c}</option>)}</select>
      </Field>
      <Field label="اسم المورد (إن وجد)">
        <TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="مثال: شركة ABC" />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button variant="expense" className="w-full mt-2" disabled={!amount || Number(amount) <= 0 || !description}
        onClick={() => { onSubmit({ amount: Number(amount), description, supplier, category, attachments: files }); onClose(); }}>
        حفظ المصروف
      </Button>
    </Modal>
  );
}

function DebtForm({ onClose, onSubmit }) {
  const [type, setType] = useState("receivable");
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState([]);
  return (
    <Modal title="إضافة دين" onClose={onClose}>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setType("receivable")} className="flex-1 py-2.5 rounded-xl text-[14px] font-bold" style={type === "receivable" ? { background: COLORS.receivable, color: "#fff" } : { background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}>لي</button>
        <button onClick={() => setType("payable")} className="flex-1 py-2.5 rounded-xl text-[14px] font-bold" style={type === "payable" ? { background: COLORS.payable, color: "#fff" } : { background: COLORS.card, border: `1px solid ${COLORS.line}`, color: COLORS.inkSoft }}>عليّ</button>
      </div>
      <Field label="اسم الشخص / العميل / المورد">
        <TextInput value={person} onChange={(e) => setPerson(e.target.value)} placeholder="مثال: أحمد" />
      </Field>
      <Field label="المبلغ الإجمالي (دج)">
        <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
      </Field>
      <Field label="وصف أو تفاصيل الدين">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="تفاصيل الدين..." />
      </Field>
      <FileAttach files={files} onChange={setFiles} />
      <Button variant="debt" className="w-full mt-2" disabled={!person || !amount || Number(amount) <= 0}
        onClick={() => { onSubmit({ type, person, amount: Number(amount), description, attachments: files }); onClose(); }}>
        حفظ الدين
      </Button>
    </Modal>
  );
}

function PaymentForm({ debts, onClose, onSubmit }) {
  const unpaid = debts.filter((d) => d.status !== "paid");
  const [debtId, setDebtId] = useState(unpaid[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [files, setFiles] = useState([]);
  const selected = debts.find((d) => d.id === debtId);
  const over = selected && Number(amount) > selected.remainingAmount;

  return (
    <Modal title="تسجيل سداد" onClose={onClose}>
      {unpaid.length === 0 ? (
        <p className="text-[14px]" style={{ color: COLORS.inkSoft }}>لا توجد ديون غير مسددة حاليًا.</p>
      ) : (
        <>
          <Field label="اختر الدين">
            <select value={debtId} onChange={(e) => setDebtId(e.target.value)} className={inputCls} style={inputStyle}>
              {unpaid.map((d) => (
                <option key={d.id} value={d.id}>
                  {(d.type === "receivable" ? "لي" : "عليّ")} — {d.person} (متبقي {fmtMoney(d.remainingAmount)})
                </option>
              ))}
            </select>
          </Field>
          {selected && (
            <div className="text-[13px] mb-3 px-3 py-2 rounded-lg" style={{ background: COLORS.goldBg, color: COLORS.ink }}>
              المبلغ المتبقي: <Fig>{fmtMoney(selected.remainingAmount)}</Fig>
            </div>
          )}
          <Field label="المبلغ المدفوع (دج)">
            <TextInput type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" dir="ltr" />
          </Field>
          {over && <p className="text-[12px] mb-3" style={{ color: COLORS.expense }}>لا يمكن سداد مبلغ أكبر من المبلغ المتبقي</p>}
          <FileAttach files={files} onChange={setFiles} label="إرفاق إيصال السداد (اختياري)" />
          <p className="text-[12px] mb-4" style={{ color: COLORS.inkSoft }}>لن يعتبر السداد نهائيًا حتى يؤكده الأدمن.</p>
          <Button variant="payment" className="w-full" disabled={!amount || Number(amount) <= 0 || over}
            onClick={() => { onSubmit({ debtId, amount: Number(amount), attachments: files }); onClose(); }}>
            إرسال طلب السداد
          </Button>
        </>
      )}
    </Modal>
  );
}

// ================= ICONS =================
function BottomIcon({ src, alt }) {
  return <img src={src} alt={alt} className="w-8 h-8 object-contain transition-transform duration-200" draggable="false" />;
}
function WhatsAppIcon() {
  return <svg viewBox="0 0 48 48" className="w-9 h-9" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#25D366"/><path fill="#fff" d="M34.8 13.2A15.1 15.1 0 0 0 24 8.7c-8.4 0-15.2 6.8-15.2 15.2 0 2.7.7 5.3 2.1 7.6L8.7 40l8.8-2.1c2.2 1.2 4.2 1.8 6.5 1.8h.1c8.4 0 15.2-6.8 15.2-15.2 0-4.1-1.6-8.3-4.5-11.3Zm-10.8 23.9h-.1c-2 0-4-.5-5.7-1.6l-.4-.2-5.2 1.2 1.3-5.1-.3-.5a12.5 12.5 0 1 1 10.4 6.2Zm6.8-9.4c-.4-.2-2.3-1.1-2.7-1.2-.4-.1-.6-.2-.9.2-.3.4-1 1.2-1.2 1.4-.2.2-.4.3-.8.1-2.2-1.1-3.7-2-5.2-4.5-.4-.7.4-.6 1.1-2 .1-.3.1-.5 0-.7-.1-.2-.9-2.1-1.2-2.9-.3-.8-.6-.7-.9-.7h-.8c-.3 0-.7.1-1 .5-.3.4-1.3 1.3-1.3 3.2s1.3 3.7 1.5 4c.2.3 2.5 3.8 6.1 5.3 2.3 1 3.1 1.1 4.2.9.7-.1 2.3-.9 2.6-1.8.3-.9.3-1.7.2-1.8-.1-.2-.3-.3-.6-.5Z"/></svg>;
}
function PersonIcon() {
  return <svg viewBox="0 0 48 48" className="w-12 h-12" aria-hidden="true"><circle cx="24" cy="15" r="8" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M10 39c1.5-8 6.4-12 14-12s12.5 4 14 12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>;
}

function NavIcon({ name }) {
  const paths = {
    reports: <><path d="M4 20V11M10 20V4M16 20v-6M22 20H2" /></>,
    expenses: <><path d="M7 17 17 7M9 7h8v8" /></>,
    incomes: <><path d="M17 7 7 17M15 17H7V9" /></>,
    payments: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16 9.5" /></>,
    debts: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></>,
    suppliers: <><path d="m3 9 1.5-5h15L21 9" /><path d="M4 9v11h16V9M3 9h18M10 20v-6h4v6" /></>,
  };
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

// ================= ADMIN APP =================
function AdminApp(props) {
  const { incomes, expenses, debts, payments, supportRequests, suppliers, supplierTransactions, aggCache, useLive, confirmPayment, rejectPayment, showToast, onExit, adminPassword, onChangePassword, theme, adminPin, onSavePin, onSaveTheme } = props;
  const [drawer,setDrawer]=useState(false); const [noticeOpen,setNoticeOpen]=useState(false); const [calcOpen,setCalcOpen]=useState(false);
  const [dark,setDark]=useState(theme.mode==="dark");
  const [noticeRead,setNoticeRead]=useState(()=>{try{return JSON.parse(localStorage.getItem("daftar_admin_notice_read")||"[]")}catch{return[]}});
  const adminNotices=supportRequests.filter(r=>!['resolved','rejected'].includes(r.status));
  const unread=adminNotices.filter(r=>!noticeRead.includes(r.id)).length;
  function markNoticesRead(){const ids=adminNotices.map(r=>r.id);setNoticeRead(ids);try{localStorage.setItem("daftar_admin_notice_read",JSON.stringify(ids))}catch{};setNoticeOpen(true)}
  function toggleDark(){const next=saveTheme({...readTheme(),mode:dark?"light":"dark",bg:dark?DEFAULT_THEME.bg:"#101615",card:dark?DEFAULT_THEME.card:"#18211F",ink:dark?DEFAULT_THEME.ink:"#F4F7F5",inkSoft:dark?DEFAULT_THEME.inkSoft:"#B7C3BD",line:dark?DEFAULT_THEME.line:"#33413B",inputBg:dark?"#FFFFFF":"#202B27",bar:dark?DEFAULT_THEME.bar:"#092F2E"});setDark(!dark)}
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [exitConfirm, setExitConfirm] = useState(false);

  async function save(kind, updated) {
    try { const { id, ...patch } = updated; await updateItem(kind, id, patch); setEditing(null); showToast("تم حفظ التعديلات"); }
    catch { showToast("تعذّر الحفظ — تحقق من الاتصال بالإنترنت"); }
  }
  const go = (id) => setTab(id);
  const top = [
    ["overview", "reports", "التقارير", "navButton"],
    ["expenses", "expenses", "المصروفات", "expense"],
    ["payments", "payments", "السداد", "paymentBtn"],
    ["incomes", "incomes", "المداخيل", "income"],
    ["debts", "debts", "الديون", "payable"],
    ["suppliers", "suppliers", "الموردين", "receivable"],
  ];
  const pendingPayments = payments.filter(p => p.status === "pending").length;
  const openSupport = supportRequests.filter(r => !["resolved","rejected"].includes(r.status)).length;
  return (
    <div className="min-h-screen max-w-3xl mx-auto" style={{ background: COLORS.bg }}>
      <AppHeader onMenu={()=>setDrawer(true)} onBell={markNoticesRead} unread={unread} />

      <div className="px-5 py-3 grid grid-cols-3 gap-2.5">
        {top.map(([id, icon, label, colorKey]) => {
          const c = COLORS[colorKey] || COLORS.navButton;
          const active = tab === id;
          return <button key={id} onClick={() => go(id)} className="h-[62px] rounded-2xl text-[13px] font-extrabold flex flex-col items-center justify-center gap-1 transition active:scale-[.97] relative" style={{ background: c, color: "#fff", boxShadow: active ? `0 0 0 2px ${COLORS.bg}, 0 0 0 4.5px ${COLORS.ink}` : "none", opacity: active ? 1 : .9 }}>
            <NavIcon name={icon} />
            <span>{label}</span>
            {id === "payments" && pendingPayments > 0 && <span className="absolute top-1.5 left-2 w-2.5 h-2.5 rounded-full" style={{background:"#E53935",boxShadow:`0 0 0 2px ${c}`}} />}
            {id === "overview" && openSupport > 0 && <span className="absolute top-1.5 left-2 w-2.5 h-2.5 rounded-full" style={{background:"#E53935",boxShadow:`0 0 0 2px ${c}`}} />}
          </button>;
        })}
      </div>

      <main key={tab} className="px-5 admin-page-enter">
        {tab === "overview" && <ReportsTab incomes={incomes} expenses={expenses} debts={debts} payments={payments} aggCache={aggCache} useLive={useLive} />}
        {tab === "incomes" && <ListTab title="المداخيل" rows={incomes.map(i => ({ id:i.id, cols:[fmtDate(i.date),fmtMoney(i.amount)], raw:i }))} onEdit={raw=>setEditing({kind:"income",data:raw})} onDelete={id=>setConfirmDel({kind:"income",id})} />}
        {tab === "expenses" && <ListTab title="المصاريف" rows={expenses.map(e => ({ id:e.id, cols:[fmtDate(e.date),e.description,e.supplier||"—",fmtMoney(e.amount)], raw:e }))} headers={["التاريخ","الوصف","المورد","المبلغ"]} onEdit={raw=>setEditing({kind:"expense",data:raw})} onDelete={id=>setConfirmDel({kind:"expense",id})} />}
        {tab === "debts" && <ListTab title="الديون" rows={debts.map(d=>({id:d.id,cols:[fmtDate(d.date),d.type==="receivable"?"لي":"عليّ",d.person,fmtMoney(d.amount),fmtMoney(d.remainingAmount),debtStatusLabel(d.status)],raw:d,color:debtStatusColor(d.status)}))} headers={["التاريخ","النوع","الشخص","الإجمالي","المتبقي","الحالة"]} onEdit={raw=>setEditing({kind:"debt",data:raw})} onDelete={id=>setConfirmDel({kind:"debt",id})} />}
        {tab === "payments" && <PaymentsTab payments={payments} debts={debts} onConfirm={async p=>{try{await confirmPayment(p);showToast("تم تأكيد السداد")}catch{showToast("تعذّر تأكيد السداد")}}} onReject={async p=>{try{await rejectPayment(p);showToast("تم رفض السداد")}catch{showToast("تعذّر التنفيذ")}}} onEdit={raw=>setEditing({kind:"payment",data:raw})} onDelete={id=>setConfirmDel({kind:"payment",id})} />}
        {tab === "support" && <SupportTab requests={supportRequests} onUpdate={async(id,patch)=>{try{await updateItem("support",id,patch);showToast("تم الحفظ")}catch{showToast("تعذّر الحفظ")}}} onDelete={async id=>{try{await deleteItem("support",id);showToast("تم الحذف")}catch{showToast("تعذّر الحذف")}}} showToast={showToast} />}
        {tab === "search" && <SearchTab incomes={incomes} expenses={expenses} debts={debts} payments={payments} />}
        {tab === "suppliers" && <SuppliersTab showToast={showToast} suppliers={suppliers} expenses={expenses} debts={debts} supplierTransactions={supplierTransactions} onEdit={s=>setEditing({kind:"supplier",data:s})} onDelete={id=>setConfirmDel({kind:"supplier",id})} onAdd={async d=>{try{await addItem("supplier",{...d,createdAt:nowISO()});showToast("تمت إضافة المورد")}catch{showToast("تعذّرت الإضافة")}}} />}
        {tab === "customize" && <CustomizationTab theme={theme} onSave={onSaveTheme} showToast={showToast} />}
        {tab === "settings" && <SettingsTab adminPassword={adminPassword} onChangePassword={onChangePassword} showToast={showToast} incomes={incomes} expenses={expenses} debts={debts} payments={payments} supportRequests={supportRequests} suppliers={suppliers} supplierTransactions={supplierTransactions} adminPin={adminPin} onSavePin={onSavePin} theme={theme} onSaveTheme={onSaveTheme} />}
      </main>

      <SideDrawer open={drawer} onClose={()=>setDrawer(false)} title="القائمة">
        <DrawerButton icon="⚙️" label="الإعدادات" onClick={()=>{setDrawer(false);go("settings")}}/>
        <DrawerButton icon="🎨" label="التخصيص" onClick={()=>{setDrawer(false);go("customize")}}/>
        <DrawerButton icon="💬" label="الدعم والشكاوى" badge={unread>0} onClick={()=>{setDrawer(false);markNoticesRead();go("support")}}/>
        <DrawerButton icon={dark?"☀️":"🌙"} label={dark?"الوضع العادي":"الوضع الداكن"} onClick={toggleDark}/>
        <DrawerButton icon="🧮" label="آلة حاسبة" onClick={()=>setCalcOpen(true)}/>
        <DrawerButton icon="🔎" label="بحث" onClick={()=>{setDrawer(false);go("search")}}/>
        <DrawerButton icon="🔒" label="قفل / خروج" danger onClick={()=>{setDrawer(false);setExitConfirm(true)}}/>
      </SideDrawer>
      {noticeOpen&&<NotificationModal notices={adminNotices} onClose={()=>setNoticeOpen(false)} role="admin"/>}
      {calcOpen&&<CalculatorModal onClose={()=>setCalcOpen(false)}/>}

      {exitConfirm && <Modal title="تأكيد الخروج" onClose={() => setExitConfirm(false)}>
        <p className="text-[14px] leading-7 mb-5">هل أنت متأكد أنك تريد الخروج من لوحة الأدمن؟</p>
        <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => setExitConfirm(false)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={onExit}>خروج</Button></div>
      </Modal>}

      {editing && <EditModal kind={editing.kind} data={editing.data} onClose={()=>setEditing(null)} onSave={u=>save(editing.kind,u)} />}
      {confirmDel && <Modal title="تأكيد الحذف" onClose={()=>setConfirmDel(null)}><p className="text-[14px] mb-5">هل أنت متأكد من حذف هذه العملية؟ لا يمكن التراجع عن هذا الإجراء.</p><div className="flex gap-3"><Button variant="ghost" className="flex-1" onClick={()=>setConfirmDel(null)}>إلغاء</Button><Button variant="danger" className="flex-1" onClick={async()=>{try{await deleteItem(confirmDel.kind,confirmDel.id);showToast("تم الحذف")}catch{showToast("تعذّر الحذف")}setConfirmDel(null)}}>حذف</Button></div></Modal>}
    </div>
  );
}


function DrawerButton({icon,label,onClick,badge,danger}){return <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-right font-bold" style={{background:danger?"#FBEAE9":"transparent",color:danger?COLORS.expense:COLORS.ink}}><span className="text-xl w-7 text-center">{icon}</span><span className="flex-1">{label}</span>{badge&&<span className="w-2.5 h-2.5 rounded-full" style={{background:"#E53935"}}/>}</button>}
function SideDrawer({open,onClose,title,children}){if(!open)return null;return <div className="fixed inset-0 z-[80]" onClick={onClose}><div className="absolute inset-0 bg-black/35"/><aside onClick={e=>e.stopPropagation()} className="absolute right-0 top-0 h-full w-[min(86vw,360px)] p-4 overflow-y-auto shadow-2xl" style={{background:COLORS.bg,borderLeft:`1px solid ${COLORS.line}`}}><div className="flex items-center justify-between mb-4"><h2 className="text-lg font-black">{title}</h2><button onClick={onClose} className="w-9 h-9 rounded-full" style={{background:COLORS.card}}>✕</button></div><div className="space-y-1">{children}</div></aside></div>}
function NotificationModal({notices,onClose,role}){return <Modal title="الإشعارات" onClose={onClose}>{notices.length===0?<div className="text-sm py-8 text-center" style={{color:COLORS.inkSoft}}>لا توجد إشعارات جديدة</div>:<div className="space-y-2">{notices.slice().reverse().map(n=><Card key={n.id} className="p-3"><div className="font-bold">{role==="admin"?n.title||"طلب دعم جديد":n.title||"رد من الأدمن"}</div><div className="text-xs mt-1" style={{color:COLORS.inkSoft}}>{n.description||n.adminReply}</div><div className="text-[10px] mt-2" style={{color:COLORS.inkSoft}}>{fmtDateTime(n.createdAt)}</div></Card>)}</div>}</Modal>}
function CalculatorModal({onClose}){const [v,setV]=useState("");const keys=["7","8","9","÷","4","5","6","×","1","2","3","−","0",".","C","+","="];function press(k){if(k==="C")return setV("");if(k==="="){try{const x=v.replaceAll("×","*").replaceAll("÷","/").replaceAll("−","-");setV(String(Function(`return (${x})`)()))}catch{setV("خطأ")}return}setV(x=>x+k)}return <Modal title="آلة حاسبة" onClose={onClose}><div className="rounded-xl p-4 mb-3 text-left text-2xl font-black" dir="ltr" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`,minHeight:60}}>{v||"0"}</div><div className="grid grid-cols-4 gap-2">{keys.map(k=><button key={k} onClick={()=>press(k)} className="h-12 rounded-xl font-black" style={{background:k==="="?COLORS.income:COLORS.card,color:k==="="?"#fff":COLORS.ink,border:`1px solid ${COLORS.line}`}}>{k}</button>)}</div></Modal>}
function ColorField({label,value,onChange}){return <Field label={label}><div className="flex items-center gap-2"><input type="color" value={value} onChange={e=>onChange(e.target.value)} className="w-14 h-11 rounded-lg"/><TextInput value={value} onChange={e=>onChange(e.target.value)} dir="ltr"/></div></Field>}
function CustomizationTab({theme,onSave,showToast}){
  const [t,setT]=useState(()=>readTheme()); const set=(k,v)=>setT(x=>({...x,[k]:v})); const save=()=>{onSave(t);showToast("تم حفظ التخصيص")};
  const reports=t.reportCards||DEFAULT_THEME.reportCards; const a=t.supplierPaletteA||DEFAULT_THEME.supplierPaletteA; const b=t.supplierPaletteB||DEFAULT_THEME.supplierPaletteB;
  return <div className="space-y-4"><h2 className="text-[18px] font-black">تخصيص كل شيء</h2>
    <Card className="p-4"><h3 className="font-black mb-3">الألوان الأساسية</h3><ColorField label="الخلفية" value={t.bg} onChange={v=>set("bg",v)}/><ColorField label="الكاردات العامة" value={t.card} onChange={v=>set("card",v)}/><ColorField label="لون النص" value={t.ink} onChange={v=>set("ink",v)}/><ColorField label="الأشرطة" value={t.bar} onChange={v=>set("bar",v)}/><ColorField label="الأزرار الرئيسية" value={t.button} onChange={v=>set("button",v)}/><ColorField label="زر التقارير وقائمة الفترة" value={t.navButton||DEFAULT_THEME.navButton} onChange={v=>set("navButton",v)}/><ColorField label="حدود العناصر" value={t.line} onChange={v=>set("line",v)}/></Card>
    <Card className="p-4"><h3 className="font-black mb-3">ألوان الكاردات الأساسية</h3>{[["incomeCard","كارد الدخل"],["expenseCard","كارد المصروف"],["debtCard","كارد الدين"],["paymentCard","كارد السداد"],["supplierCard","كارد المورد"]].map(([k,l])=><ColorField key={k} label={l} value={t[k]||DEFAULT_THEME[k]} onChange={v=>set(k,v)}/>)}</Card>
    <Card className="p-4"><h3 className="font-black mb-3">كاردات التقارير — كل كارد مستقل</h3>{reports.map((c,i)=><ColorField key={i} label={["صافي الربح","إجمالي المصاريف","إجمالي الدخل","إجمالي الديون"][i]} value={c} onChange={v=>set("reportCards",reports.map((x,j)=>j===i?v:x))}/>)}</Card>
    <Card className="p-4"><h3 className="font-black mb-3">كاردات الموردين — مجموعتان بالتناوب</h3><p className="text-xs mb-3" style={{color:COLORS.inkSoft}}>الكارد 1 = اللون A، الكارد 2 = اللون B، الكارد 3 = A وهكذا.</p><ColorField label="لون الكروت الفردية (A)" value={a[0]} onChange={v=>set("supplierPaletteA",[v,...a.slice(1)])}/><ColorField label="لون الكروت الزوجية (B)" value={b[0]} onChange={v=>set("supplierPaletteB",[v,...b.slice(1)])}/></Card>
    <Card className="p-4"><h3 className="font-black mb-3">أيقونة المتجر والتصنيفات</h3><Field label="رمز أيقونة المتجر"><TextInput value={t.shopIcon||"د"} onChange={e=>set("shopIcon",e.target.value.slice(0,3))}/></Field><Field label="التصنيفات — واحد في كل سطر"><TextArea value={(t.categories||[]).join("\n")} onChange={e=>set("categories",e.target.value.split("\n").map(x=>x.trim()).filter(Boolean))} rows={5}/></Field></Card>
    <Card className="p-4"><h3 className="font-black mb-3">تخصيص التنبيهات</h3><p className="text-xs mb-3" style={{color:COLORS.inkSoft}}>يمكنك إنشاء إشعار بالاسم والنغمة والتكرار والمدة. تحفظ الإعدادات محليًا على الجهاز.</p><NotificationScheduler /></Card>
    <Button className="w-full" onClick={save}>حفظ كل التخصيصات</Button>
  </div>
}
function NotificationScheduler(){const [name,setName]=useState("");const [tone,setTone]=useState("افتراضي");const [repeat,setRepeat]=useState("مرة واحدة");const [duration,setDuration]=useState("5");const [list,setList]=useState(()=>{try{return JSON.parse(localStorage.getItem("daftar_custom_notifications")||"[]")}catch{return[]}});function add(){if(!name)return;const n=[...list,{id:Date.now(),name,tone,repeat,duration}];setList(n);localStorage.setItem("daftar_custom_notifications",JSON.stringify(n));setName("")}return <><Field label="اسم الإشعار"><TextInput value={name} onChange={e=>setName(e.target.value)} placeholder="مثال: تذكير إغلاق المحل"/></Field><div className="grid grid-cols-3 gap-2"><Field label="النغمة"><select value={tone} onChange={e=>setTone(e.target.value)} className={inputCls} style={inputStyle}><option>افتراضي</option><option>هادئ</option><option>تنبيه</option></select></Field><Field label="التكرار"><select value={repeat} onChange={e=>setRepeat(e.target.value)} className={inputCls} style={inputStyle}><option>مرة واحدة</option><option>يومي</option><option>أسبوعي</option><option>كل ساعة</option></select></Field><Field label="المدة"><TextInput value={duration} onChange={e=>setDuration(e.target.value)} inputMode="numeric"/></Field></div><Button variant="ghost" className="w-full" onClick={add}>+ إضافة إشعار</Button>{list.length>0&&<div className="mt-3 space-y-1">{list.map(n=><div key={n.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`}}><span className="text-xs">{n.name} · {n.repeat} · {n.duration}</span><button onClick={()=>{const x=list.filter(a=>a.id!==n.id);setList(x);localStorage.setItem("daftar_custom_notifications",JSON.stringify(x))}} style={{color:COLORS.expense}}>حذف</button></div>)}</div>}</>}

function SettingsTab({ adminPassword, onChangePassword, showToast, incomes, expenses, debts, payments, supportRequests, suppliers = [], supplierTransactions = [], adminPin, onSavePin, theme, onSaveTheme }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(null); // { data, fileName }
  const importInputId = useId();

  function handleExport() {
    const payload = {
      exportedAt: nowISO(),
      app: "daftar",
      version: 2,
      incomes, expenses, debts, payments, supportRequests, suppliers, supplierTransactions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daftar-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("تم إنشاء ملف النسخة الاحتياطية");
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== "object") throw new Error("bad");
        setConfirmImport({ data, fileName: file.name });
      } catch (err) {
        showToast("ملف النسخة الاحتياطية غير صالح");
      }
    };
    reader.readAsText(file);
  }

  async function runImport() {
    const data = confirmImport.data;
    setConfirmImport(null);
    setImporting(true);
    try {
      const groups = [
        ["income", data.incomes], ["expense", data.expenses], ["debt", data.debts],
        ["payment", data.payments], ["support", data.supportRequests], ["supplier", data.suppliers], ["supplierTransaction", data.supplierTransactions], ["supplierTransaction", data.supplierTransactions],
      ];
      let count = 0;
      for (const [kind, list] of groups) {
        for (const rec of Array.isArray(list) ? list : []) {
          const { id, ...rest } = rec; // تُضاف كسجلات جديدة بمعرّفات جديدة، دون المساس بالبيانات الحالية
          await addItem(kind, rest);
          count++;
        }
      }
      showToast(`تم استيراد ${count} سجلًا كعمليات جديدة`);
    } catch (err) {
      showToast("تعذّر الاستيراد بالكامل — تحقق من الاتصال بالإنترنت");
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    setError("");
    if (current !== adminPassword) {
      setError("كلمة المرور الحالية غير صحيحة");
      return;
    }
    if (next.length < 8 || next.length > 12) {
      setError("كلمة المرور الجديدة يجب أن تكون بين 8 و 12 رمزًا");
      return;
    }
    if (next !== confirm) {
      setError("كلمتا المرور الجديدتان غير متطابقتين");
      return;
    }
    try {
      await onChangePassword(next);
      setCurrent(""); setNext(""); setConfirm("");
      showToast("تم تغيير كلمة المرور بنجاح");
    } catch (e) {
      setError("تعذّر الحفظ — تحقق من الاتصال بالإنترنت");
    }
  }

  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-2">الإعدادات</h2>
      <Card className="p-4">
        <h3 className="text-[14px] font-extrabold mb-3">تغيير كلمة المرور</h3>
        <Field label="كلمة المرور الحالية">
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} dir="ltr" />
        </Field>
        <Field label="كلمة المرور الجديدة (8 إلى 12 رمزًا)">
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} dir="ltr" minLength={8} maxLength={12} />
        </Field>
        <Field label="تأكيد كلمة المرور الجديدة">
          <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" minLength={8} maxLength={12} />
        </Field>
        {error && <p className="text-[13px] mb-3" style={{ color: COLORS.expense }}>{error}</p>}
        <Button className="w-full" disabled={!current || !next || !confirm} onClick={handleSave}>
          حفظ كلمة المرور
        </Button>
      </Card>

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-3">رمز PIN احتياطي</h3>
        <p className="text-[12px] mb-3" style={{color:COLORS.inkSoft}}>يستخدم كمسار دخول احتياطي للأدمن عند تعذّر كلمة المرور أو البصمة.</p>
        <TextInput type="password" inputMode="numeric" maxLength={8} value={adminPin||""} onChange={e=>onSavePin(e.target.value.replace(/\D/g,"").slice(0,8))} placeholder="مثال: 2580" dir="ltr" style={{textAlign:"center",letterSpacing:"4px"}}/>
      </Card>

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-3">اختصارات</h3>
        <Button variant="ghost" className="w-full" onClick={()=>showToast("افتح التخصيص من القائمة الجانبية")}>🎨 تخصيص الواجهة والتنبيهات</Button>
      </Card>

      <Card className="p-4 mt-4"><h3 className="text-[14px] font-extrabold mb-2">التنبيهات والتخصيص</h3><p className="text-[12px] mb-3" style={{color:COLORS.inkSoft}}>لتعديل اسم التنبيه ونغمته وتكراره ومدته افتح التخصيص من القائمة الجانبية.</p><Button variant="ghost" className="w-full" onClick={()=>showToast("افتح القائمة الجانبية ← التخصيص")}>فتح تخصيص التنبيهات</Button></Card>

      <Card className="p-4 mt-4">
        <h3 className="text-[14px] font-extrabold mb-1">نسخة احتياطية</h3>
        <p className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>
          يمكنك حفظ كل البيانات الحالية في ملف على هاتفك، والرجوع إليه لاحقًا عند الحاجة.
        </p>
        <Button variant="ghost" className="w-full mb-3" onClick={handleExport}>⬇ تنزيل نسخة احتياطية (JSON)</Button>

        <label htmlFor={importInputId} className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-[15px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${COLORS.line}`, color: COLORS.inkSoft }}>
          {importing ? "جارٍ الاستيراد..." : "⬆ استعادة من ملف نسخة احتياطية"}
        </label>
        <input id={importInputId} type="file" accept="application/json,.json" onChange={handleImportFile} className="sr-only" disabled={importing}
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }} />
        <p className="text-[11px] mt-2" style={{ color: COLORS.inkSoft }}>
          الاستعادة تضيف سجلات النسخة كعمليات جديدة، ولا تحذف أي بيانات موجودة حاليًا.
        </p>
      </Card>

      {confirmImport && (
        <Modal title="تأكيد الاستيراد" onClose={() => setConfirmImport(null)}>
          <p className="text-[14px] mb-5">
            سيتم إضافة كل السجلات الموجودة في الملف "{confirmImport.fileName}" كعمليات جديدة في هذا الحساب. هل تريد المتابعة؟
          </p>
          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => setConfirmImport(null)}>إلغاء</Button>
            <Button className="flex-1" onClick={runImport}>استيراد</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ListTab({ title, rows, headers, onEdit, onDelete }) {
  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-2">{title}</h2>
      {rows.length === 0 ? (
        <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد بيانات</div>
      ) : (
        <div className="space-y-2">
          {rows.slice().sort((a, b) => tsOf(b.raw) - tsOf(a.raw)).map((r) => (
            <Card key={r.id} className="p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="text-[13px] leading-6 flex-1" style={{ color: COLORS.inkSoft }}>
                  {headers ? (
                    r.cols.map((c, i) => (
                      <div key={i}><span className="font-bold" style={{ color: r.color || COLORS.ink }}>{headers[i]}: </span>{c}</div>
                    ))
                  ) : (
                    <>
                      <div style={{ color: COLORS.inkSoft }}>{r.cols[0]}</div>
                      <Fig className="text-[16px]" style={{ color: COLORS.ink }}>{r.cols[1]}</Fig>
                    </>
                  )}
                  {r.raw?._pending && <div className="text-[12px] font-bold" style={{ color: COLORS.gold }}>⏳ بانتظار الرفع</div>}
                  <AttachmentsView item={r.raw} admin />
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => onEdit(r.raw)} className="w-8 h-8 rounded-full text-[13px]" style={{ background: COLORS.goldBg, color: COLORS.gold }}>✎</button>
                  <button onClick={() => onDelete(r.id)} className="w-8 h-8 rounded-full text-[13px]" style={{ background: "#FBEAE9", color: COLORS.expense }}>🗑</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PaymentsTab({ payments, debts, onConfirm, onReject, onEdit, onDelete }) {
  const pending = payments.filter((p) => p.status === "pending");
  const others = payments.filter((p) => p.status !== "pending");
  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-2">طلبات السداد بانتظار التأكيد</h2>
      {pending.length === 0 && <div className="text-[13px] mb-6" style={{ color: COLORS.inkSoft }}>لا توجد طلبات بانتظار التأكيد</div>}
      <div className="space-y-2 mb-6">
        {pending.map((p) => {
          const d = debts.find((x) => x.id === p.debtId);
          return (
            <Card key={p.id} className="p-3.5">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[14px] font-bold">{d?.person || "—"}</div>
                <Fig style={{ color: COLORS.gold }}>{fmtMoney(p.amount)}</Fig>
              </div>
              <div className="text-[12px] mb-3" style={{ color: COLORS.inkSoft }}>{fmtDate(p.date)} · متبقي قبل السداد: <Fig>{fmtMoney(d?.remainingAmount)}</Fig></div>
              <div className="flex gap-2">
                <Button variant="income" className="flex-1 !py-2 !text-[13px]" onClick={() => onConfirm(p)}>تأكيد السداد</Button>
                <Button variant="danger" className="flex-1 !py-2 !text-[13px]" onClick={() => onReject(p)}>رفض</Button>
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="text-[15px] font-extrabold mb-2">سجل الدفعات</h2>
      {others.length === 0 ? (
        <div className="text-[13px]" style={{ color: COLORS.inkSoft }}>لا يوجد سجل بعد</div>
      ) : (
        <div className="space-y-2">
          {others.map((p) => {
            const d = debts.find((x) => x.id === p.debtId);
            return (
              <Card key={p.id} className="p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[13px] leading-6" style={{ color: COLORS.inkSoft }}>
                    <div className="font-bold" style={{ color: COLORS.ink }}>{d?.person || "—"}</div>
                    <div>{fmtDate(p.date)} · <Fig>{fmtMoney(p.amount)}</Fig> · {paymentStatusLabel(p.status)}</div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => onEdit(p)} className="w-8 h-8 rounded-full text-[13px]" style={{ background: COLORS.goldBg, color: COLORS.gold }}>✎</button>
                    <button onClick={() => onDelete(p.id)} className="w-8 h-8 rounded-full text-[13px]" style={{ background: "#FBEAE9", color: COLORS.expense }}>🗑</button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SupportTab({ requests, onUpdate, onDelete, showToast }) {
  const [open, setOpen] = useState(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-3"><h2 className="text-[18px] font-black">الشكاوى والطلبات</h2><span className="text-[12px]" style={{color:COLORS.inkSoft}}>{requests.length} طلب</span></div>
      {requests.length === 0 ? <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد شكاوى أو طلبات</div> :
        <div className="space-y-2">
          {requests.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(r => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="font-extrabold text-[14px] truncate">{r.title || "بدون عنوان"}</div><div className="text-[11px] mt-1" style={{color:COLORS.inkSoft}}>{fmtDateTime(r.createdAt)} · {r.type === "complaint" ? "شكوى" : "طلب تغيير"}</div><div className="text-[11px] mt-1" style={{color:COLORS.inkSoft}}>{r.adminReply ? "تم الرد" : "بانتظار الرد"}</div></div>
                <span className="text-[10px] px-2 py-1 rounded-full font-bold shrink-0" style={{ background: COLORS.goldBg, color: COLORS.gold }}>{supportStatusLabel(r.status)}</span>
              </div>
              <div className="flex gap-2 mt-3"><Button className="flex-1 !py-2 !text-[12px]" onClick={async () => { setOpen(r); if (r.status === "new") { try { await onUpdate(r.id,{status:"in_review",readAt:nowISO()}); } catch {} } }}>قراءة والرد</Button><Button variant="danger" className="!py-2 !text-[12px]" onClick={() => onDelete(r.id)}>حذف</Button></div>
            </Card>
          ))}
        </div>}
      {open && <Modal title={open.title || "تفاصيل الطلب"} onClose={() => setOpen(null)} wide>
        <div className="text-[12px] mb-2" style={{color:COLORS.inkSoft}}>{fmtDateTime(open.createdAt)} · {open.type === "complaint" ? "شكوى" : "طلب تغيير"}</div>
        <div className="rounded-xl p-3 mb-4 leading-7 text-[14px]" style={{background:"#fff",border:`1px solid ${COLORS.line}`}}>{open.description}</div>
        <div className="text-[11px] mb-3" style={{color:COLORS.inkSoft}}>سيتم حفظ الرد لنفس جهاز المرسل المرتبط بطلبه.</div>
        <AttachmentsView item={open} admin />
        <Field label="الحالة"><select value={open.status || "new"} onChange={e=>setOpen(o=>({...o,status:e.target.value}))} className={inputCls} style={inputStyle}><option value="new">جديد</option><option value="in_review">قيد المراجعة</option><option value="resolved">تم الحل</option><option value="rejected">مرفوض</option></select></Field>
        <Field label="الرد"><TextArea value={open.adminReply || ""} onChange={e=>setOpen(o=>({...o,adminReply:e.target.value}))} placeholder="اكتب الرد الذي سيظهر على هاتف المرسل..." rows={5}/></Field>
        <div className="flex gap-2"><Button className="flex-1" onClick={async()=>{await onUpdate(open.id,{status:open.status||"new",adminReply:open.adminReply||"",replyAt:nowISO()});showToast("تم حفظ الرد وإرساله لنفس الجهاز");setOpen(null)}}>حفظ وإرسال الرد</Button><Button variant="danger" onClick={async()=>{await onDelete(open.id);setOpen(null);showToast("تم حذف الشكوى")}}>حذف</Button></div>
      </Modal>}
    </div>
  );
}

function exportRows(type,data,name){
  const rows=[['النوع','التاريخ','الوصف/الشخص','المبلغ','الحالة'],...data.incomes.map(x=>['دخل',x.date,'دخل يومي',x.amount,'']),...data.expenses.map(x=>['مصروف',x.date,x.description,x.amount,x.category||'']),...data.debts.map(x=>['دين',x.date,x.person,x.amount,x.status||'']),...data.payments.map(x=>['سداد',x.date,x.debtId,x.amount,x.status||''])];
  if(type==='csv'){const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),name);return}
  const html='<table border="1" dir="rtl">'+rows.map(r=>'<tr>'+r.map(v=>`<td>${String(v??'')}</td>`).join('')+'</tr>').join('')+'</table>';
  downloadBlob(new Blob(['\ufeff',html],{type:'application/vnd.ms-excel'}),name);
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}

function periodRange(period, custom) {
  const now = new Date(); let start, end;
  if (period === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (period === "week") { const day=(now.getDay()+6)%7; start=new Date(now); start.setDate(now.getDate()-day); }
  else if (period === "month") start=new Date(now.getFullYear(),now.getMonth(),1);
  else if (period === "year") start=new Date(now.getFullYear(),0,1);
  else start=custom.from?new Date(custom.from):new Date(0);
  end = period === "custom" && custom.to ? new Date(custom.to) : new Date(now);
  start.setHours(0,0,0,0); end.setHours(23,59,59,999); return [start,end];
}

function ReportsTab({ incomes, expenses, debts, payments, aggCache, useLive }) {
  const [period,setPeriod]=useState("today");
  const [custom,setCustom]=useState({from:"",to:""});
  const [openMenu,setOpenMenu]=useState(false);
  const [start,end]=periodRange(period,custom);
  const inRange=d=>{const x=new Date(d);return x>=start&&x<=end};
  const agg=useLive?buildAgg(incomes,expenses,debts,payments):aggCache||{};
  const {incTotal,expTotal,debtTotal,paymentTotal,receivable,payable,paid,partial,unpaid,net}=reportFromAgg(agg,inRange);
  const periods=[{id:"today",label:"التقرير اليومي"},{id:"week",label:"التقرير الأسبوعي"},{id:"month",label:"التقرير الشهري"},{id:"year",label:"التقرير السنوي"}];
  function handlePrint(){const w=window.open("","_blank");w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>تقرير دفتر</title></head><body style="font-family:Arial;padding:30px"><h1>تقرير دفتر</h1><p>${periods.find(p=>p.id===period)?.label || "تقرير مخصص"} — ${fmtDate(start)} إلى ${fmtDate(end)}</p><p>إجمالي الدخل: ${fmtMoney(incTotal)}</p><p>إجمالي سداد الديون: ${fmtMoney(paymentTotal)}</p><p>إجمالي المصاريف: ${fmtMoney(expTotal)}</p><p>إجمالي الديون: ${fmtMoney(debtTotal)}</p><h2>صافي الربح: ${fmtMoney(net)}</h2></body></html>`);w.document.close();w.print();}
  const label=periods.find(p=>p.id===period)?.label || "تقرير مخصص";
  const rc=[0,1,2,3].map(i=>(COLORS.reportCards||DEFAULT_THEME.reportCards)[i]||DEFAULT_THEME.reportCards[i]);
  return <div>
    <div className="relative mb-4">
      <button onClick={()=>setOpenMenu(v=>!v)} className="w-full h-[31.5px] rounded-[16px] px-5 flex items-center justify-between text-[15.3px] font-black" style={{background:COLORS.navButton||"#145A58",color:"#fff"}}><span>{label}</span><span className="text-[21px] leading-none">⌄</span></button>
      {openMenu && <div className="absolute z-20 top-[40px] inset-x-0 rounded-2xl p-2 shadow-xl" style={{background:COLORS.card,border:`1px solid ${COLORS.line}`}}>{periods.map(p=><button key={p.id} onClick={()=>{setPeriod(p.id);setOpenMenu(false)}} className="w-full text-right px-4 py-3 rounded-xl text-[14px] font-bold" style={period===p.id?{background:COLORS.goldBg,color:COLORS.ink}:{background:"#fff",color:COLORS.ink}}>{p.label}</button>)}<button onClick={()=>{setPeriod("custom");setOpenMenu(false)}} className="w-full text-right px-4 py-3 rounded-xl text-[14px] font-bold" style={{color:COLORS.ink}}>تقرير مخصص</button></div>}
    </div>
    {period==="custom"&&<div className="grid grid-cols-2 gap-2 mb-4"><TextInput type="date" value={custom.from} onChange={e=>setCustom(c=>({...c,from:e.target.value}))} dir="ltr"/><TextInput type="date" value={custom.to} onChange={e=>setCustom(c=>({...c,to:e.target.value}))} dir="ltr"/></div>}
    <div className="grid grid-cols-2 gap-3">
      <StatCard label="صافي الربح" value={net} color="#3F7D38" bg={rc[0]} />
      <StatCard label="إجمالي المصاريف" value={expTotal} color={COLORS.expense} bg={rc[1]} />
      <StatCard label="إجمالي الدخل" value={incTotal} color="#3476A6" bg={rc[2]} />
      <StatCard label="إجمالي الديون" value={debtTotal} color="#A87518" bg={rc[3]} />
    </div>
    <Card className="p-0 mt-4 overflow-hidden"><div className="px-4 py-[10.8px] text-[15.3px] font-black">تفاصيل الديون</div><div className="grid grid-cols-2 text-[13px]" style={{borderTop:`1px solid ${COLORS.line}`}}>{[["ديون لي",receivable],["ديون عليّ",payable],["مسددة بالكامل",paid],["مسددة جزئيًا",partial],["غير مسددة",unpaid],["سداد الديون",paymentTotal]].map(([k,v],i)=><div key={k} className="px-4 py-[10.8px] flex items-center justify-between" style={{background:k==="سداد الديون"?COLORS.paymentBg:"transparent",borderBottom:`1px solid ${COLORS.line}`,borderLeft:i%2===0?`1px solid ${COLORS.line}`:"none"}}><span>{k}</span><Fig>{typeof v === "number" && (k.includes("ديون") || k.includes("سداد")) ? fmtMoney(v) : v}</Fig></div>)}</div></Card>
    <div className="grid grid-cols-3 gap-2 mt-4"><Button className="!py-2.5 !text-[12px]" onClick={handlePrint}>PDF</Button><Button variant="ghost" className="!py-2.5 !text-[12px]" onClick={()=>exportRows("csv",{incomes,expenses,debts,payments},`daftar-${period}.csv`)}>CSV</Button><Button variant="ghost" className="!py-2.5 !text-[12px]" onClick={()=>exportRows("xls",{incomes,expenses,debts,payments},`daftar-${period}.xls`)}>Excel</Button></div>
  </div>;
}

function SearchTab({ incomes, expenses, debts, payments = [] }) {
  const [q, setQ] = useState("");
  const [date, setDate] = useState("");

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const inc = incomes.filter((i) => (!date || i.date === date) && !query);
    const exp = expenses.filter((e) => (!date || e.date === date) && (!query || e.description.toLowerCase().includes(query) || (e.supplier || "").toLowerCase().includes(query)));
    const dbt = debts.filter((d) => (!date || d.date === date) && (!query || d.person.toLowerCase().includes(query)));
    return [
      ...inc.map((i) => ({ kind: "دخل", label: fmtDate(i.date), amount: i.amount, color: COLORS.income })),
      ...exp.map((e) => ({ kind: "مصروف", label: `${e.description}${e.supplier ? " · " + e.supplier : ""}`, amount: e.amount, color: COLORS.expense })),
      ...dbt.map((d) => ({ kind: d.type === "receivable" ? "دين لي" : "دين عليّ", label: d.person, amount: d.amount, color: d.type === "receivable" ? COLORS.receivable : COLORS.payable })),
    ];
  }, [q, date, incomes, expenses, debts]);

  return (
    <div>
      <h2 className="text-[15px] font-extrabold mb-3">بحث شامل</h2>
      <div className="flex gap-2 mb-4">
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="اسم العميل أو المورد..." />
        <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" style={{ maxWidth: "150px" }} />
      </div>
      {results.length === 0 ? (
        <div className="text-center py-10 text-[13px]" style={{ color: COLORS.inkSoft }}>لا توجد نتائج</div>
      ) : (
        <div className="space-y-2">
          {results.map((r, i) => (
            <Card key={i} className="p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[12px] font-bold mb-0.5" style={{ color: r.color }}>{r.kind}</div>
                <div className="text-[14px]">{r.label}</div>
              </div>
              <Fig>{fmtMoney(r.amount)}</Fig>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierPhotoField({ value, onChange }) {
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(""); const galleryId=useId(); const cameraId=useId();
  const onPick=async e=>{const f=e.target.files?.[0];e.target.value="";endPicking();if(!f)return;setBusy(true);setErr("");try{const c=await compressImage(f);onChange(c.dataUrl)}catch(x){setErr(x?.message||"تعذّر تجهيز الصورة")}finally{setBusy(false)}};
  const lbl="cursor-pointer rounded-xl px-3 py-2.5 text-[12px] font-bold text-center";
  return <Field label="صورة المورد (اختيارية)"><div className="flex items-center gap-3"><div className="w-20 h-20 rounded-full flex items-center justify-center overflow-hidden shrink-0" style={{background:"#EEF3F0",color:COLORS.inkSoft}}>{value?<img src={value} alt="المورد" className="w-full h-full object-cover"/>:<PersonIcon/>}</div><div className="flex-1 grid grid-cols-2 gap-2"><label htmlFor={galleryId} className={lbl} style={{background:COLORS.goldBg,color:COLORS.ink}}>{busy?"جارٍ التجهيز...":"📎 من المعرض"}</label><label htmlFor={cameraId} className={lbl} style={{background:COLORS.goldBg,color:COLORS.ink}}>📷 كاميرا</label></div><input id={galleryId} className="sr-only" type="file" accept="image/*" onClick={beginPicking} onCancel={endPicking} onChange={onPick}/><input id={cameraId} className="sr-only" type="file" accept="image/*" capture="environment" onClick={beginPicking} onCancel={endPicking} onChange={onPick}/></div>{err&&<p className="text-[12px] mt-1" style={{color:COLORS.expense}}>{err}</p>}</Field>;
}
function SupplierCard({ supplier, expenses, debts, supplierTransactions=[], onOpen, index=0 }) {
  const tx = supplierTransactions.filter(t => t.supplierId === supplier.id);
  const purchases = tx.filter(t => t.type === "purchase").reduce((s,t) => s + (Number(t.amount) || 0), 0);
  const supplierPaid = tx.filter(t => t.type === "payment").reduce((s,t) => s + (Number(t.amount) || 0), 0);
  const legacyExpenses = expenses.filter(e => (e.supplier || "").trim() === supplier.name).reduce((s,e) => s + (Number(e.amount) || 0), 0);
  const due = Math.max(purchases + legacyExpenses - supplierPaid, 0);
  const palette = index % 2 === 0
    ? (readTheme().supplierPaletteA || DEFAULT_THEME.supplierPaletteA)
    : (readTheme().supplierPaletteB || DEFAULT_THEME.supplierPaletteB);
  const bg = palette[0] || COLORS.supplierCard;

  return (
    <Card className="cursor-pointer overflow-hidden" onClick={onOpen} style={{ background: bg, padding: 0 }}>
      <div className="flex items-center gap-3 p-3.5">
        <div className="w-[58px] h-[58px] rounded-2xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: "rgba(255,255,255,0.7)", color: COLORS.inkSoft }}>
          {supplier.photo ? <img src={supplier.photo} alt={supplier.name} className="w-full h-full object-cover"/> : <PersonIcon/>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-black truncate" style={{ color: COLORS.ink }}>{supplier.name}</div>
          <div className="text-[12px] mt-0.5 truncate" style={{ color: COLORS.inkSoft }}>{supplier.goods || "السلع غير محددة"}</div>
          <div className="text-[11px] mt-0.5 truncate" style={{ color: COLORS.inkSoft }}>{supplier.location || "المكان غير محدد"}</div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          {supplier.phone && (
            <a href={`tel:${supplier.phone}`} onClick={e=>e.stopPropagation()} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:"#EAF0F8", color: COLORS.receivable }} title="اتصال">📞</a>
          )}
          {supplier.phone && (
            <a href={`https://wa.me/${whatsappNumber(supplier.phone)}`} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:"#E9F8EE" }} title="واتساب"><WhatsAppIcon/></a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderTop: `1px solid ${COLORS.line}`, background: "rgba(255,255,255,0.5)" }}>
        <div className="flex-1">
          <div className="text-[10px]" style={{ color: COLORS.inkSoft }}>المطلوب منا</div>
          <div className="text-[13px] font-black" style={{ color: COLORS.expense }}>{fmtMoney(due)}</div>
        </div>
        <div className="w-px h-7" style={{ background: COLORS.line }} />
        <div className="flex-1 text-left">
          <div className="text-[10px]" style={{ color: COLORS.inkSoft }}>المدفوع</div>
          <div className="text-[13px] font-black" style={{ color: COLORS.income }}>{fmtMoney(supplierPaid)}</div>
        </div>
      </div>
    </Card>
  );
}

function SupplierFields({ form, setForm }) {
  const set=k=>e=>setForm(f=>({...f,[k]:e.target.value}));
  return <div className="space-y-1"><SupplierPhotoField value={form.photo} onChange={photo=>setForm(f=>({...f,photo}))}/><Field label="اسم المورد"><TextInput value={form.name||""} onChange={set("name")} /></Field><Field label="رقم الهاتف الرئيسي"><TextInput value={form.phone||""} onChange={set("phone")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="رقم ثانٍ 1"><TextInput value={form.phone2||""} onChange={set("phone2")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="رقم ثانٍ 2"><TextInput value={form.phone3||""} onChange={set("phone3")} dir="ltr" type="tel" inputMode="tel" /></Field><Field label="المكان"><TextInput value={form.location||""} onChange={set("location")} /></Field><Field label="السلع"><TextInput value={form.goods||""} onChange={set("goods")} /></Field><Field label="ملاحظات"><TextArea value={form.notes||""} onChange={set("notes")} /></Field></div>;
}

function SupplierTransactionForm({ supplier, initialType="purchase", onClose, onSave }) {
  const [type,setType]=useState(initialType); const [amount,setAmount]=useState(""); const [description,setDescription]=useState(""); const [date,setDate]=useState(todayISO()); const [files,setFiles]=useState([]);
  return <Modal title={type==="purchase"?"إضافة فاتورة / سلعة":"تسجيل دفع للمورد"} onClose={onClose} zClass="z-[60]">
    <Field label="نوع العملية"><select value={type} onChange={e=>setType(e.target.value)} className={inputCls} style={inputStyle}><option value="purchase">فاتورة / شراء جديد</option><option value="payment">دفع مبلغ للمورد</option></select></Field>
    <Field label="المبلغ"><TextInput type="number" value={amount} onChange={e=>setAmount(e.target.value)} dir="ltr" inputMode="decimal" /></Field>
    <Field label="الوصف / السلعة"><TextInput value={description} onChange={e=>setDescription(e.target.value)} placeholder={type==="purchase"?"مثال: 10 كراتين زيت":"مثال: دفعة نقدية"} /></Field>
    <Field label="التاريخ"><TextInput type="date" value={date} onChange={e=>setDate(e.target.value)} dir="ltr" /></Field>
    {type==="purchase"&&<FileAttach files={files} onChange={setFiles} label="صور الفاتورة (اختياري)" />}
    <Button className="w-full" disabled={!amount || Number(amount)<=0} onClick={()=>onSave({supplierId:supplier.id,type,amount:Number(amount),description,date,attachments:files,createdAt:nowISO()})}>حفظ العملية</Button>
  </Modal>;
}

function SuppliersTab({ suppliers, expenses, debts, supplierTransactions=[], onEdit, onDelete, onAdd, showToast }) {
  const [open,setOpen]=useState(null); const [showAdd,setShowAdd]=useState(false); const [showTx,setShowTx]=useState(null);
  const relatedExpenses=open?expenses.filter(e=>(e.supplier||"").trim()===open.name):[];
  const relatedDebts=open?debts.filter(d=>(d.person||"").trim()===open.name):[];
  const tx=open?supplierTransactions.filter(t=>t.supplierId===open.id).sort((a,b)=>new Date(b.date||b.createdAt)-new Date(a.date||a.createdAt)):[];
  const purchased=tx.filter(t=>t.type==="purchase").reduce((s,t)=>s+(Number(t.amount)||0),0)+relatedExpenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
  const supplierPaid=tx.filter(t=>t.type==="payment").reduce((s,t)=>s+(Number(t.amount)||0),0);
  const due=Math.max(purchased-supplierPaid,0);
  const allPhones=open?[open.phone,open.phone2,open.phone3].filter(Boolean):[];
  return <div><div className="flex items-center justify-between mb-3"><h2 className="text-[18px] font-black">الموردين</h2><Button className="!py-2 !px-3 !text-[13px]" onClick={()=>setShowAdd(true)}>+ مورد</Button></div>{suppliers.length===0?<div className="text-center py-10 text-[13px]" style={{color:COLORS.inkSoft}}>لا يوجد موردون بعد</div>:<div className="space-y-3">{suppliers.map((s,si)=><div key={s.id}><SupplierCard index={si} supplier={s} expenses={expenses} debts={debts} supplierTransactions={supplierTransactions} onOpen={()=>setOpen(s)} /><div className="flex gap-2 mt-1"><button onClick={()=>onEdit(s)} className="text-[11px] px-3 py-1 rounded-lg" style={{background:COLORS.goldBg}}>✎ تعديل</button><button onClick={()=>onDelete(s.id)} className="text-[11px] px-3 py-1 rounded-lg" style={{background:"#FBEAE9",color:COLORS.expense}}>حذف</button></div></div>)}</div>}
    {showAdd&&<SupplierForm onClose={()=>setShowAdd(false)} onSave={async d=>{await onAdd(d);setShowAdd(false)}} />}
    {showTx&&<SupplierTransactionForm supplier={showTx.supplier} initialType={showTx.type} onClose={()=>setShowTx(null)} onSave={async d=>{
      try { await addItem("supplierTransaction", d); setShowTx(null); }
      catch (e) { console.error(e); showToast?.("تعذّر حفظ العملية. تحقق من الاتصال ثم حاول مرة أخرى."); }
    }} />}
    {open&&<Modal title={`المورد: ${open.name}`} wide onClose={()=>setOpen(null)}><div className="flex items-start gap-3 mb-4"><div className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center shrink-0" style={{background:"#EEF3F0",color:COLORS.inkSoft}}>{open.photo?<img src={open.photo} alt={open.name} className="w-full h-full object-cover"/>:<PersonIcon/>}</div><div className="min-w-0 flex-1"><div className="text-[20px] font-black">{open.name}</div><div className="text-[12px] mt-1">{open.location||"المكان غير محدد"}</div><div className="flex flex-wrap gap-1.5 mt-2">{allPhones.map((ph,i)=><a key={i} href={`tel:${ph}`} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold" style={{background:"#EAF0F8",color:COLORS.receivable}}>📞 {ph}</a>)}</div></div></div><div className="grid grid-cols-2 gap-2 mb-4"><div className="rounded-xl p-3" style={{background:"#FBEAE9"}}><div className="text-[11px]" style={{color:COLORS.inkSoft}}>إجمالي المطلوب منا</div><div className="font-black mt-1">{fmtMoney(due)}</div></div><div className="rounded-xl p-3" style={{background:COLORS.goldBg}}><div className="text-[11px]" style={{color:COLORS.inkSoft}}>إجمالي ما تم سداده</div><div className="font-black mt-1">{fmtMoney(supplierPaid)}</div></div></div><div className="flex gap-2 mb-4"><Button className="flex-1 !py-2.5 !text-[12px]" onClick={(e)=>{e.stopPropagation();setShowTx({supplier:open,type:"purchase"})}}>➕ فاتورة / سلعة</Button><Button variant="payment" className="flex-1 !py-2.5 !text-[12px]" onClick={(e)=>{e.stopPropagation();setShowTx({supplier:open,type:"payment"})}}>➖ دفع للمورد</Button></div><div className="flex gap-2 mb-4">{open.phone&&<a href={`tel:${open.phone}`} className="flex-1 text-center rounded-xl py-2.5 text-[12px] font-bold" style={{background:"#EAF0F8",color:COLORS.receivable}}>📞 اتصال مباشر</a>}{open.phone&&<a href={`https://wa.me/${whatsappNumber(open.phone)}`} target="_blank" rel="noreferrer" className="flex-1 text-center rounded-xl py-2.5 text-[12px] font-bold" style={{background:"#E9F8EE",color:"#168A45"}}>واتساب</a>}</div><h3 className="font-extrabold mb-2">سجل الفواتير والمعاملات</h3><div className="space-y-2">{tx.map(t=><Card key={t.id} className="p-3"><div className="flex justify-between gap-2"><span className="font-bold">{t.type==="purchase"?"شراء / فاتورة":"سداد للمورد"}</span><Fig>{fmtMoney(t.amount)}</Fig></div><div className="text-[11px] mt-1" style={{color:COLORS.inkSoft}}>{fmtDate(t.date)} · {t.description||"—"}</div>{t.type==="purchase"&&<AttachmentsView item={t} admin />}</Card>)}{relatedExpenses.map(e=><Card key={e.id} className="p-3"><div className="flex justify-between"><span>مصروف قديم — {e.description}</span><Fig>{fmtMoney(e.amount)}</Fig></div><div className="text-[11px]" style={{color:COLORS.inkSoft}}>{fmtDate(e.date)}</div><AttachmentsView item={e} admin /></Card>)}{relatedDebts.map(d=><Card key={d.id} className="p-3"><div className="flex justify-between"><span>دين مرتبط — {d.type==="receivable"?"لي":"عليّ"}</span><Fig>{fmtMoney(d.amount)}</Fig></div><div className="text-[11px]" style={{color:COLORS.inkSoft}}>{fmtDate(d.date)} · المتبقي {fmtMoney(d.remainingAmount)}</div><AttachmentsView item={d} admin /></Card>)}{tx.length===0&&relatedExpenses.length===0&&relatedDebts.length===0&&<p className="text-[13px]" style={{color:COLORS.inkSoft}}>لا توجد معاملات بعد.</p>}</div><div className="mt-4 text-[12px]" style={{color:COLORS.inkSoft}}>السلع: {open.goods||"—"} · ملاحظات: {open.notes||"—"}</div></Modal>}
  </div>;
}

function SupplierForm({ onClose, onSave }) { const [form,setForm]=useState({name:"",phone:"",phone2:"",phone3:"",location:"",goods:"",notes:"",photo:""}); return <Modal title="إضافة مورد" onClose={onClose}><SupplierFields form={form} setForm={setForm}/><Button className="w-full" disabled={!form.name} onClick={()=>onSave(form)}>حفظ المورد</Button></Modal>; }

function EditModal({ kind, data, onClose, onSave }) {
  const [form, setForm] = useState({ ...data });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setNum = (k) => (e) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));

  const titles = { income: "تعديل الدخل", expense: "تعديل المصروف", debt: "تعديل الدين", payment: "تعديل الدفعة", supplier: "تعديل المورد" };

  return (
    <Modal title={titles[kind]} onClose={onClose} wide>
      {kind !== "supplier" && <Field label="التاريخ">
        <TextInput type="date" value={form.date} onChange={set("date")} dir="ltr" />
      </Field>}

      {kind === "income" && (
        <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
      )}

      {kind === "expense" && (
        <>
          <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
          <Field label="الوصف"><TextInput value={form.description} onChange={set("description")} /></Field>
          <Field label="المورد"><TextInput value={form.supplier || ""} onChange={set("supplier")} /></Field>
        </>
      )}

      {kind === "debt" && (
        <>
          <Field label="النوع">
            <select value={form.type} onChange={set("type")} className={inputCls} style={inputStyle}>
              <option value="receivable">لي</option>
              <option value="payable">عليّ</option>
            </select>
          </Field>
          <Field label="الشخص"><TextInput value={form.person} onChange={set("person")} /></Field>
          <Field label="المبلغ الإجمالي"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
          <Field label="المبلغ المسدد"><TextInput type="number" value={form.paidAmount} onChange={(e) => {
            const paid = Number(e.target.value);
            const remaining = Math.max(form.amount - paid, 0);
            setForm((f) => ({ ...f, paidAmount: paid, remainingAmount: remaining, status: remaining === 0 ? "paid" : paid > 0 ? "partial" : "unpaid" }));
          }} dir="ltr" /></Field>
          <Field label="الوصف"><TextArea value={form.description || ""} onChange={set("description")} /></Field>
          <Field label="الحالة">
            <select value={form.status} onChange={set("status")} className={inputCls} style={inputStyle}>
              <option value="unpaid">غير مسدد</option>
              <option value="partial">مسدد جزئيًا</option>
              <option value="paid">مسدد بالكامل</option>
            </select>
          </Field>
        </>
      )}

      {kind === "payment" && (
        <>
          <Field label="المبلغ"><TextInput type="number" value={form.amount} onChange={setNum("amount")} dir="ltr" /></Field>
          <Field label="الحالة">
            <select value={form.status} onChange={set("status")} className={inputCls} style={inputStyle}>
              <option value="pending">بانتظار تأكيد الأدمن</option>
              <option value="confirmed">مؤكد</option>
              <option value="rejected">مرفوض</option>
            </select>
          </Field>
        </>
      )}

      {kind !== "income" && kind !== "supplier" && <FileAttach files={form.attachments || []} onChange={(files) => setForm(f => ({ ...f, attachments: files }))} />}
      {kind === "supplier" && <SupplierFields form={form} setForm={setForm} />}
      <Button className="w-full mt-2" onClick={() => onSave(form)}>حفظ التعديلات</Button>
    </Modal>
  );
}
