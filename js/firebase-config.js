import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getDatabase, ref, set, push, onValue, get } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

// COLOQUE AS SUAS CHAVES DO FIREBASE AQUI
const firebaseConfig = {
  apiKey: "AIzaSyAiykf5IqYbnHglovdxyRzXXmrk-GtHlzQ",
  authDomain: "thiaguinho-40a14.firebaseapp.com",
  databaseURL: "https://thiaguinho-40a14-default-rtdb.firebaseio.com",
  projectId: "thiaguinho-40a14",
  storageBucket: "thiaguinho-40a14.firebasestorage.app",
  messagingSenderId: "953851363533",
  appId: "1:953851363533:web:a912b840e5d268c5d16984"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

export { auth, database, signInWithEmailAndPassword, signOut, onAuthStateChanged, ref, set, push, onValue, get };
