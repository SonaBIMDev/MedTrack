// ═══════════════════════════════════════════════════════════════
// MedTrack — Firebase service
// ═══════════════════════════════════════════════════════════════

import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, type Database } from "firebase/database";
import type { FirebaseDB } from "./types";

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL:       import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

let db: Database | null = null;

export function initFirebase(): Database | null {
  if (!firebaseConfig.apiKey) {
    console.warn("[MedTrack] Firebase non configuré — ajoutez vos clés dans .env");
    return null;
  }
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  return db;
}

export function listenDatabase(
  onData: (data: FirebaseDB) => void,
  onConnected: (connected: boolean) => void
): void {
  if (!db) return;

  // Toute la base en un seul listener (petit dataset)
  onValue(ref(db, "/"), (snapshot) => {
    const data = snapshot.val() as FirebaseDB | null;
    if (data) onData(data);
  });

  // Statut de connexion
  onValue(ref(db, ".info/connected"), (snap) => {
    onConnected(!!snap.val());
  });
}
