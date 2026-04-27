# 🏥 MedTrack — POC de géolocalisation d'équipements médicaux

---

## Structure du projet

```
MedTrack/
├── simulator/
│   └── index.html          # Simulateur drag & drop 2D (sync Firebase)
├── pwa/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── .env.example        # → copier en .env avec vos clés Firebase
│   ├── public/
│   │   ├── TrackMed.ifc    # ← À copier ici
│   │   ├── web-ifc/        # ← Copier depuis node_modules après npm install
│   │   └── worker.mjs      # ← Copier depuis node_modules après npm install
│   └── src/
│       ├── main.ts         # Viewer ThatOpen + Firebase + UI
│       ├── firebase.ts     # Service Firebase
│       ├── types.ts        # Types TypeScript
│       └── style.css
├── data/
│   └── seed.json           # Données initiales Firebase
└── README.md
```

---

## 1. Firebase — Création et configuration

### 1.1 Nouveau projet
1. [console.firebase.google.com](https://console.firebase.google.com) → **"Créer un projet"**
2. Nom : `medtrack-poc` → Désactiver Google Analytics → **Créer**

### 1.2 Realtime Database
1. Menu gauche → **Build > Realtime Database** → **"Créer une base de données"**
2. Région : **`europe-west1` (Belgique)**
3. Mode de démarrage : **"Mode test"** (accès libre 30 jours)

### 1.3 Règles d'accès permanent (POC sans auth)
Realtime Database → onglet **"Règles"** → remplacer par :
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```
→ **Publier**

### 1.4 Enregistrer l'application Web
1. **⚙ > Paramètres du projet** → section **"Vos applications"** → **`</>`**
2. Nom : `MedTrack PWA` → **Enregistrer**
3. Copier l'objet `firebaseConfig` → vous aurez besoin de ces valeurs pour `.env` et le simulateur

---

## 2. Importer les données initiales

Realtime Database → menu **⋮** → **"Importer JSON"** → sélectionner `data/seed.json`

---

## 3. Lancer la PWA

```bash
cd pwa

# 1. Copier et remplir le fichier d'environnement
cp .env.example .env
# → Éditer .env avec vos valeurs Firebase

# 2. Installer les dépendances
npm install

# 3. Copier les assets nécessaires
mkdir -p public/web-ifc
cp node_modules/web-ifc/web-ifc.wasm       public/web-ifc/
cp node_modules/web-ifc/web-ifc-mt.wasm    public/web-ifc/
cp node_modules/@thatopen/fragments/dist/worker.mjs public/
cp /chemin/vers/TrackMed.ifc               public/

# 4. Lancer
npm run dev
# → http://localhost:5173

# 5. Build production
npm run build
```

---

## 4. Lancer le simulateur

Éditer `simulator/index.html` → section `FIREBASE_CONFIG` → coller vos valeurs Firebase.

Ouvrir directement `simulator/index.html` dans le navigateur (aucun serveur).

---

## Correspondance IFC ↔ Firebase

La propriété `Commentaires` de chaque `IfcSpace` (ex: `SPACE_RDC_01`) est utilisée
comme clé pour matcher les données Firebase `/spaces/SPACE_RDC_01`.

| IFCSpace Commentaires | Firebase /spaces/ | Nom |
|---|---|---|
| SPACE_RDC_01 | spaces/SPACE_RDC_01 | Accueil & Admissions |
| SPACE_RDC_02 | spaces/SPACE_RDC_02 | Urgences – Tri |
| ... | ... | ... |
