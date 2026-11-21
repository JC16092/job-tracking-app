/* ══════════════════════════════════════════════════════════
   Tastings — the Firebase side of the sync.

   The only file that touches the Firebase SDK. Same project as
   Hours and Pace (your-project-id), same sign-in, written the way
   Hours writes it. Tastings keeps its own collections:
     tastings_config/main      settings, stores, remembered km
     tastings_days/{date}      one document per work day
   It never reads or writes anything Hours or Pace own.

   The SDK is loaded with dynamic import() so the app still opens
   when it cannot be fetched (no reception inside a store).
   ══════════════════════════════════════════════════════════ */

const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";

export async function connectFirebase({ onUser }) {
  const [appMod, authMod, fsMod, cfgMod] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js"),
    import("./firebase-config.js")
  ]);
  const { initializeApp } = appMod;
  const {
    initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
    browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup,
    onAuthStateChanged, signOut
  } = authMod;
  const { getFirestore, collection, doc, onSnapshot, setDoc } = fsMod;
  const { firebaseConfig, OWNER_EMAIL } = cfgMod;

  const fb = initializeApp(firebaseConfig);
  const auth = initializeAuth(fb, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    popupRedirectResolver: browserPopupRedirectResolver
  });
  const db = getFirestore(fb);

  onAuthStateChanged(auth, user => {
    if (user && user.email !== OWNER_EMAIL) {
      signOut(auth);
      onUser(null, "This app is for one account only.");
      return;
    }
    onUser(user ? { email: user.email, name: user.displayName || "" } : null, "");
  });

  const configRef = () => doc(db, "tastings_config", "main");
  const dayRef = date => doc(db, "tastings_days", date);

  /* Also report "the server has now confirmed what you already had" (a change of metadata only).
     Without it, a listener whose first answer came from memory, or was this phone's own write
     still on its way, would never say that the account has been heard from. Documents are
     passed on exactly as before: docChanges() leaves metadata-only changes out. */
  const LISTEN = { includeMetadataChanges: true };

  const remote = {
    /* Resolves once the server has the write (it stays pending while offline). */
    pushDoc(kind, id, data) {
      return setDoc(kind === "config" ? configRef() : dayRef(id), data);
    },

    /* Passes on documents as the server has them — never the echo of a write still on its way.
       The second argument says whether the answer came from the SDK's own memory (no server). */
    subscribe(kind, onChange) {
      if (kind === "config") {
        return onSnapshot(configRef(), LISTEN, snap => {
          if (snap.metadata.hasPendingWrites) return;
          onChange(snap.exists() ? [{ id: "main", data: snap.data() }] : [], { fromCache: snap.metadata.fromCache });
        }, err => console.error("config sync", err));
      }
      return onSnapshot(collection(db, "tastings_days"), LISTEN, snap => {
        const out = [];
        snap.docChanges().forEach(ch => {
          if (ch.type === "removed" || ch.doc.metadata.hasPendingWrites) return;
          out.push({ id: ch.doc.id, data: ch.doc.data() });
        });
        onChange(out, { fromCache: snap.metadata.fromCache });
      }, err => console.error("days sync", err));
    },

    fetchDays() { return Promise.resolve([]); }
  };

  return {
    signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
    remote
  };
}
