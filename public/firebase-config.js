// Firebase project: your-project-id — the same project as Pace and Hours, shared for sign-in.
// This app keeps its own collections ("tastings_days", "tastings_config"); it never reads
// or writes anything Pace or Hours own.
// These values are public by design — Firestore security rules are the real gate. The rules
// live in ~/pace/firestore.rules and are deployed from there, never from this project
// (only owner@example.com can read or write anything).
export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "1:YOUR_SENDER_ID:web:YOUR_APP_ID"
};

// The only account allowed in. Must match ~/pace/firestore.rules.
export const OWNER_EMAIL = "owner@example.com";
