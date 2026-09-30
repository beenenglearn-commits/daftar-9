import { db } from "./firebase";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  setDoc,
  getDoc,
} from "firebase/firestore";

const COLLECTIONS = {
  income: "incomes",
  expense: "expenses",
  debt: "debts",
  payment: "payments",
  support: "supportRequests",
  supplier: "suppliers",
  supplierTransaction: "supplierTransactions",
};

// Subscribes to a collection and calls `callback` with a live array
// (with each item's Firestore document id attached as `id`) every time
// the data changes — locally or from another phone.
// كل عنصر يحمل أيضًا _pending: true إذا كان قد كُتب على هذا الهاتف ولم يصل
// إلى الخادم بعد (لا يزال في طابور الرفع الذي تديره مكتبة Firestore تلقائيًا).
export function subscribe(kind, callback) {
  const colRef = collection(db, COLLECTIONS[kind]);
  return onSnapshot(
    colRef,
    { includeMetadataChanges: true },
    (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
      callback(items);
    },
    (error) => {
      console.error(`subscribe(${kind}) failed:`, error);
    }
  );
}

export async function addItem(kind, data) {
  return addDoc(collection(db, COLLECTIONS[kind]), data);
}

export async function updateItem(kind, id, patch) {
  const { _pending, id: _drop, ...clean } = patch; // احتياطًا إن مرّ الحقلان عبر نموذج تعديل
  return updateDoc(doc(db, COLLECTIONS[kind], id), clean);
}

export async function deleteItem(kind, id) {
  return deleteDoc(doc(db, COLLECTIONS[kind], id));
}

// ---------- Admin password (stored in a single settings document) ----------
const ADMIN_DOC = ["settings", "admin"];

export function subscribeAdminPassword(callback) {
  const ref = doc(db, ...ADMIN_DOC);
  return onSnapshot(ref, (snap) => {
    if (snap.exists()) callback(snap.data().password);
  });
}

export async function ensureAdminPasswordDoc(defaultPassword) {
  const ref = doc(db, ...ADMIN_DOC);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { password: defaultPassword });
  }
}

export async function setAdminPasswordRemote(password) {
  await setDoc(doc(db, ...ADMIN_DOC), { password }, { merge: true });
}
