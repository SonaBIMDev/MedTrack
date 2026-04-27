/**
 * MedTrack PWA — main.ts
 * Basé sur la même API ThatOpen 3.3 qu'AssetsBoard (ifcLoader.load signature 4 args)
 */

import "./style.css";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import { initFirebase, listenDatabase } from "./firebase";
import type { FirebaseDB, SpaceInfo, SpaceStatus, EquipmentStatus } from "./types";

// ═══════════════════════════════════════════════════════════════
// Couleurs
// ═══════════════════════════════════════════════════════════════
const SPACE_COLORS: Record<SpaceStatus, string> = {
  ok:          "#3fb950",  // vert   — disponibles
  in_use:      "#388bfd",  // bleu   — en utilisation
  displaced:   "#d29922",  // orange — hors zone
  maintenance: "#f85149",  // rouge  — maintenance
  empty:       "#6a7494",  // gris   — vide
};
const SEARCH_HIT_COLOR  = "#2f81f7";
const SEARCH_MISS_COLOR = "#1a1f2a";

// ═══════════════════════════════════════════════════════════════
// Globals ThatOpen
// ═══════════════════════════════════════════════════════════════
const components = new OBC.Components();
const world = components.get(OBC.Worlds).create<
  OBC.SimpleScene,
  OBC.SimpleCamera,
  OBC.SimpleRenderer
>();

let fragments: OBC.FragmentsManager;
let ifcLoader: OBC.IfcLoader;
let currentModel: any | null = null;
let highlighter: any = null;

let _isLoadingIfc = false;
let _ifcLoadToken = 0;

// ─── Suivi espaces ────────────────────────────────────────────
const spaceById    = new Map<string, SpaceInfo>();
const spaceByExpId = new Map<number, string>();
let spaceExpressIds    = new Set<number>();
let nonSpaceExpressIds = new Set<number>();

// ─── État Firebase ────────────────────────────────────────────
let firebaseDB: FirebaseDB | null = null;
let activeSearch: string | null = null;
let selectedSpaceId: string | null = null;

// ═══════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════
function logInfo(m: string) { console.log(`  ℹ️  ${m}`); }
function logOk(m: string)   { console.log(`  ✅ ${m}`); }
function logWarn(m: string) { console.warn(`  ⚠️  ${m}`); }

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: "ok" | "warn" | "err" = "ok") {
  const el = document.getElementById("toast") as HTMLElement;
  el.textContent = msg;
  el.className = `show ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3500);
}
function showSpinner(label = "Chargement…") {
  const s = document.getElementById("loading-spinner");
  const l = document.getElementById("spinner-label");
  s?.classList.remove("hidden");
  if (l) l.textContent = label;
}
function hideSpinner() {
  document.getElementById("loading-spinner")?.classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════════
// Lecture propriété "Commentaires" dans IsDefinedBy
// ═══════════════════════════════════════════════════════════════
function extractCommentaires(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.IsDefinedBy)) {
    for (const rel of data.IsDefinedBy) {
      const rpd = rel?.RelatingPropertyDefinition;
      if (!rpd || !Array.isArray(rpd.HasProperties)) continue;
      for (const prop of rpd.HasProperties) {
        const propName = prop?.Name?.value ?? prop?.Name ?? "";
        if (String(propName).toLowerCase() === "commentaires") {
          const val = prop?.NominalValue?.value ?? prop?.NominalValue?.Value ?? prop?.NominalValue;
          if (val !== undefined && val !== null) return String(val).trim();
        }
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Calcul statuts pièces
// ═══════════════════════════════════════════════════════════════
function computeSpaceStatuses(): void {
  if (!firebaseDB) return;
  const { equipment, beacons } = firebaseDB;

  for (const info of spaceById.values()) {
    info.equipmentCount = 0;
    info.displaced = 0;
    info.availableCount = 0;
    info.status = "empty";
  }

  for (const [, eq] of Object.entries(equipment)) {
    const beacon = beacons[eq.beacon_id];
    if (!beacon) continue;
    const spaceInfo = spaceById.get(beacon.current_space);
    if (!spaceInfo) continue;
    spaceInfo.equipmentCount++;
    if (eq.status === "available") spaceInfo.availableCount++;
    if (beacon.current_space !== eq.home_space) spaceInfo.displaced++;
  }

  for (const info of spaceById.values()) {
    if (info.equipmentCount === 0) { info.status = "empty"; continue; }
    if (info.displaced > 0) { info.status = "displaced"; continue; }
    let hasMaint = false;
    for (const [, eq] of Object.entries(equipment)) {
      const beacon = beacons[eq.beacon_id];
      if (!beacon) continue;
      if (beacon.current_space === info.spaceId && eq.status === "maintenance") {
        hasMaint = true; break;
      }
    }
    info.status = hasMaint ? "maintenance" : "ok";
  }
}

// ═══════════════════════════════════════════════════════════════
// Équipements dans une pièce
// ═══════════════════════════════════════════════════════════════
function getEquipmentInSpace(spaceId: string) {
  if (!firebaseDB) return [];
  const { equipment, beacons, equipment_types } = firebaseDB;
  const result: any[] = [];
  for (const [eqId, eq] of Object.entries(equipment)) {
    const beacon = beacons[eq.beacon_id];
    if (!beacon || beacon.current_space !== spaceId) continue;
    result.push({
      eqId,
      type: equipment_types[eq.type] || { label: eq.type, icon: "📦", unit_cost: 0 },
      serial: eq.serial,
      status: eq.status,
      isOutOfPlace: beacon.current_space !== eq.home_space,
      homeSpace: eq.home_space,
    });
  }
  return result.sort((a, b) => a.type.label.localeCompare(b.type.label));
}

// ═══════════════════════════════════════════════════════════════
// Coloration 3D — utilise OBC.Hider comme AssetsBoard
// ═══════════════════════════════════════════════════════════════
async function applySpacesMode(spacesOnly: boolean): Promise<void> {
  if (!currentModel) return;
  const hider = components.get(OBC.Hider);
  const modelId = currentModel.modelId;
  const spacesMap: OBC.ModelIdMap    = { [modelId]: new Set(spaceExpressIds) };
  const nonSpacesMap: OBC.ModelIdMap = { [modelId]: new Set(nonSpaceExpressIds) };

  if (spacesOnly) {
    await hider.set(true, spacesMap);
    await hider.set(false, nonSpacesMap);
  } else {
    await hider.set(false, spacesMap);
    await hider.set(true, nonSpacesMap);
  }
  await fragments.core.update(true);
}

// Map: expressId → fragmentId → Set<instanceIndex> (cachée au chargement)
// ─── Coloration des espaces (même pattern exact qu'AssetsBoard) ─
// ─── Couleur d'une pièce selon le type recherché ─────────────
// Priorité : displaced > maintenance > in_use > ok > absent(dim)
function spaceColorForType(spaceId: string, typeId: string): string | null {
  if (!firebaseDB) return null;
  const { equipment, beacons } = firebaseDB;

  let hasDisplaced = false, hasMaintenance = false, hasInUse = false, hasAvailable = false;

  for (const [, eq] of Object.entries(equipment)) {
    if (eq.type !== typeId) continue;
    const beacon = beacons[eq.beacon_id];
    if (!beacon || beacon.current_space !== spaceId) continue;

    if (beacon.current_space !== eq.home_space) hasDisplaced    = true;
    if (eq.status === "maintenance")             hasMaintenance  = true;
    if (eq.status === "in_use")                  hasInUse        = true;
    if (eq.status === "available")               hasAvailable    = true;
  }

  if (!hasDisplaced && !hasMaintenance && !hasInUse && !hasAvailable) return null; // absent
  if (hasDisplaced)   return SPACE_COLORS.displaced;
  if (hasMaintenance) return SPACE_COLORS.maintenance;
  if (hasInUse)       return SPACE_COLORS.in_use;   // bleu si au moins 1 en utilisation
  if (hasAvailable)   return SPACE_COLORS.ok;        // vert seulement si tous disponibles
  return null;
}

async function applySpaceColors(_searchTypeId: string | null = null): Promise<void> {
  if (!highlighter || !currentModel) return;
  const modelId = currentModel.modelId;

  // Toujours afficher les couleurs de statut (la liste de recherche suffit pour le highlight)
  const byStyle = new Map<string, { color: string; ids: number[] }>();
  for (const [, info] of spaceById) {
    const hex = SPACE_COLORS[info.status];
    const styleName = `mt-${hex.replace("#", "")}`;
    if (!byStyle.has(styleName)) byStyle.set(styleName, { color: hex, ids: [] });
    byStyle.get(styleName)!.ids.push(info.expressId);
  }

  for (const [styleName, { color, ids }] of byStyle) {
    // styles.set attend un objet plain { color, opacity, transparent, renderedFaces }
    if (!highlighter.styles.has(styleName)) {
      highlighter.styles.set(styleName, {
        color: new THREE.Color(color),
        opacity: 0.6,
        transparent: true,
        renderedFaces: 0,
      });
    } else {
      const style = highlighter.styles.get(styleName);
      if (style) style.color = new THREE.Color(color);
    }
    try {
      highlighter.highlightByID(styleName, { [modelId]: new Set(ids) }, false, false);
    } catch (e) { logWarn(`applySpaceColors [${styleName}]: ${e}`); }
  }
}

function hasEquipmentType(spaceId: string, typeId: string): boolean {
  if (!firebaseDB) return false;
  for (const [, eq] of Object.entries(firebaseDB.equipment)) {
    if (eq.type !== typeId) continue;
    const beacon = firebaseDB.beacons[eq.beacon_id];
    if (beacon?.current_space === spaceId) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// Identification des IfcSpaces (copie exacte d'AssetsBoard)
// ═══════════════════════════════════════════════════════════════
async function identifySpaces(model: any): Promise<void> {
  spaceById.clear();
  spaceByExpId.clear();
  spaceExpressIds = new Set();
  nonSpaceExpressIds = new Set();

  try {
    const allIds: number[] = await model.getItemsIdsWithGeometry();
    logInfo(`Scan de ${allIds.length} éléments…`);

    for (const id of allIds) {
      try {
        const [dataLight] = await model.getItemsData([id], {
          attributesDefault: true,
          relations: {},
        });
        if (!dataLight) { nonSpaceExpressIds.add(id); continue; }

        const ifcType = dataLight.type;
        const cat = String(dataLight._category?.value ?? dataLight._category ?? "").toLowerCase();
        const isSpace =
          ifcType === 3856911033 || ifcType === 2706460486 ||
          cat.includes("space") || cat.includes("pièce") || cat.includes("room");

        if (!isSpace) { nonSpaceExpressIds.add(id); continue; }

        // Lecture complète pour Commentaires
        const [dataFull] = await model.getItemsData([id], {
          attributesDefault: true,
          relations: { IsDefinedBy: { attributes: true, relations: true } },
        });

        const commentaires = dataFull ? extractCommentaires(dataFull) : null;
        const longName = dataFull?.LongName?.value ?? dataFull?.LongName ?? null;
        const name     = dataFull?.Name?.value     ?? dataFull?.Name     ?? null;
        const chosenName = (longName && String(longName).trim()) ||
                           (name     && String(name).trim()) || `#${id}`;

        logInfo(`  IfcSpace id=${id} Name="${name}" LongName="${longName}" Commentaires="${commentaires}"`);

        // Commentaires = clé SPACE_xxx (si renseigné) sinon matching par name
        const commentairesKey = commentaires;
        const longNameVal = String(chosenName).trim();
        
        // Chercher dans Firebase : d'abord par clé Commentaires, sinon par champ name
        let spaceId = commentairesKey ?? longNameVal;
        let fbSpace = commentairesKey ? firebaseDB?.spaces[commentairesKey] : undefined;
        if (!fbSpace && firebaseDB) {
          // Lookup par name (LongName de l'IFC = name dans Firebase)
          for (const [key, sp] of Object.entries(firebaseDB.spaces)) {
            if (sp.name === longNameVal) { fbSpace = sp; spaceId = key; break; }
          }
        }

        const info: SpaceInfo = {
          spaceId,
          expressId: id,
          name: fbSpace?.name ?? String(chosenName).trim(),
          floor: fbSpace?.floor ?? -1,
          service: fbSpace?.service ?? "—",
          status: "empty",
          equipmentCount: 0,
          displaced: 0,
          availableCount: 0,
        };

        spaceById.set(spaceId, info);
        spaceByExpId.set(id, spaceId);
        spaceExpressIds.add(id);

      } catch { nonSpaceExpressIds.add(id); }
    }
    logOk(`${spaceById.size} pièces, ${nonSpaceExpressIds.size} autres`);
  } catch (e) { logWarn(`identifySpaces: ${e}`); }
}

// ═══════════════════════════════════════════════════════════════
// Refresh complet
// ═══════════════════════════════════════════════════════════════
async function refresh(): Promise<void> {
  computeSpaceStatuses();
  await applySpaceColors(null);          // 1. statuts
  if (activeSearch) {
    await applySearchVisibility(activeSearch); // 2. dim par-dessus (remplace)
    updateSearchResults(activeSearch);
  }
  updateDashboard();
  await fragments.core.update(true);
}

// ═══════════════════════════════════════════════════════════════
// UI — Dashboard
// ═══════════════════════════════════════════════════════════════
function updateDashboard(): void {
  if (!firebaseDB) return;
  const { equipment, beacons } = firebaseDB;

  document.getElementById("dashboard-empty")!.style.display = "none";
  document.getElementById("dashboard-stats")!.style.display = "";

  let total = 0, available = 0, displaced = 0, maintenance = 0;
  const alerts: string[] = [];

  for (const [, eq] of Object.entries(equipment)) {
    total++;
    if (eq.status === "available") available++;
    if (eq.status === "maintenance") maintenance++;
    const beacon = beacons[eq.beacon_id];
    if (beacon && beacon.current_space !== eq.home_space) {
      displaced++;
      const type = firebaseDB!.equipment_types[eq.type]?.label ?? eq.type;
      const cur  = firebaseDB!.spaces[beacon.current_space]?.name ?? beacon.current_space;
      const home = firebaseDB!.spaces[eq.home_space]?.name ?? eq.home_space;
      alerts.push(`${type} (${eq.serial}) — trouvé à <strong>${cur}</strong> au lieu de ${home}`);
    }
  }

  (document.getElementById("stat-total")!      ).textContent = String(total);
  (document.getElementById("stat-available")!  ).textContent = String(available);
  (document.getElementById("stat-displaced")!  ).textContent = String(displaced);
  (document.getElementById("stat-maintenance")!).textContent = String(maintenance);

  const alertsList = document.getElementById("alerts-list")!;
  alertsList.innerHTML = alerts.length === 0
    ? `<div class="alert-ok">✅ Aucun équipement hors de sa zone</div>`
    : `<div class="alert-title">⚠ ${alerts.length} équipement${alerts.length > 1 ? "s" : ""} hors zone</div>` +
      alerts.map(a => `<div class="alert-row">${a}</div>`).join("");
}

// ═══════════════════════════════════════════════════════════════
// UI — Sélecteur types
// ═══════════════════════════════════════════════════════════════
function populateEquipmentTypes(): void {
  if (!firebaseDB) return;
  const select = document.getElementById("eq-type-select") as HTMLSelectElement;
  const previousValue = select.value; // sauvegarder la sélection
  while (select.options.length > 1) select.remove(1);
  for (const [typeId, type] of Object.entries(firebaseDB.equipment_types)) {
    const opt = document.createElement("option");
    opt.value = typeId;
    opt.textContent = `${type.icon} ${type.label}`;
    select.appendChild(opt);
  }
  // Restaurer la sélection si elle existait
  if (previousValue) select.value = previousValue;
}

// ═══════════════════════════════════════════════════════════════
// UI — Résultats recherche
// ═══════════════════════════════════════════════════════════════
function statusLabel(s: EquipmentStatus): string {
  return { available: "Disponible", in_use: "En utilisation", maintenance: "Maintenance" }[s] ?? s;
}

function updateSearchResults(typeId: string): void {
  if (!firebaseDB) return;
  const { equipment, beacons, equipment_types, spaces } = firebaseDB;
  const type = equipment_types[typeId];
  if (!type) return;

  const bySpace = new Map<string, Array<{ eqId: string; eq: any }>>();
  for (const [eqId, eq] of Object.entries(equipment)) {
    if (eq.type !== typeId) continue;
    const beacon = beacons[eq.beacon_id];
    if (!beacon) continue;
    const sid = beacon.current_space;
    if (!bySpace.has(sid)) bySpace.set(sid, []);
    bySpace.get(sid)!.push({ eqId, eq });
  }

  let totalCount = 0, availableCount = 0;
  for (const list of bySpace.values()) {
    totalCount += list.length;
    availableCount += list.filter(({ eq }) => eq.status === "available").length;
  }

  document.getElementById("search-summary")!.innerHTML = `
    <span class="sr-total">${totalCount} ${type.label}${totalCount > 1 ? "s" : ""}</span>
    <span class="sr-available">${availableCount} disponible${availableCount > 1 ? "s" : ""}</span>
  `;

  const list = document.getElementById("search-list")!;
  list.innerHTML = "";

  if (bySpace.size === 0) {
    list.innerHTML = `<div class="rp-empty-hint">Aucun équipement de ce type localisé</div>`;
  } else {
    for (const [sid, items] of [...bySpace.entries()].sort()) {
      const spaceName  = spaces[sid]?.name ?? sid;
      const floor      = spaces[sid]?.floor;
      const floorLabel = floor === 0 ? "RDC" : floor != null ? `R+${floor}` : "";

      const group = document.createElement("div");
      group.className = "sr-group";
      group.innerHTML = `
        <div class="sr-space-name">
          ${spaceName}
          ${floorLabel ? `<span class="sr-floor">${floorLabel}</span>` : ""}
        </div>
        ${items.map(({ eq }) => `
          <div class="sr-eq-row ${eq.status}">
            <span class="sr-serial">${eq.serial}</span>
            <span class="sr-status">${statusLabel(eq.status)}</span>
            ${beacons[eq.beacon_id]?.current_space !== eq.home_space
              ? `<span class="sr-displaced">⚠ hors zone</span>` : ""}
          </div>
        `).join("")}
      `;
      group.addEventListener("click", () => {
        selectSpace(sid);
        zoomToSpace(sid);
      });
      list.appendChild(group);
    }
  }

  document.getElementById("search-results")!.style.display = "";
  document.getElementById("search-empty")!.style.display = "none";
}

// ═══════════════════════════════════════════════════════════════
// UI — Fiche pièce
// ═══════════════════════════════════════════════════════════════
function spaceStatusLabel(s: string): string {
  return { ok: "Normal", displaced: "Hors zone", maintenance: "Maintenance", empty: "Vide" }[s] ?? s;
}

const SELECTED_COLOR = "#ffffff";

function selectSpace(spaceId: string | null): void {
  // Restaurer la couleur précédente
  if (selectedSpaceId && selectedSpaceId !== spaceId) {
    const prev = spaceById.get(selectedSpaceId);
    if (prev) colorSingleSpace(prev);
  }
  selectedSpaceId = spaceId;
  if (spaceId) {
    const info = spaceById.get(spaceId);
    if (info) {
      // Couleur sélection : version plus claire du statut
      const selColor = new THREE.Color(SPACE_COLORS[info.status]).lerp(new THREE.Color("#ffffff"), 0.4);
      const hex = "#" + selColor.getHexString();
      const styleName = `mt-sel-${hex.replace("#","")}`;
      if (highlighter && currentModel) {
        if (!highlighter.styles.has(styleName)) {
          highlighter.styles.set(styleName, {
            color: selColor, opacity: 0.9, transparent: true, renderedFaces: 0,
          });
        }
        try {
          highlighter.highlightByID(styleName, { [currentModel.modelId]: new Set([info.expressId]) }, false, false);
        } catch { /* ignore */ }
      }
    }
    showRoomDetail(spaceId);
    document.getElementById("section-room")?.scrollIntoView({ behavior: "smooth" });
  } else {
    showRoomDetail("");
  }
}

function colorSingleSpace(info: SpaceInfo): void {
  if (!highlighter || !currentModel) return;
  const hex = activeSearch
    ? (hasEquipmentType(info.spaceId, activeSearch) ? SEARCH_HIT_COLOR : SEARCH_MISS_COLOR)
    : SPACE_COLORS[info.status];
  const styleName = `mt-${hex.replace("#","")}`;
  if (!highlighter.styles.has(styleName)) {
    highlighter.styles.set(styleName, {
      color: new THREE.Color(hex), opacity: 0.6, transparent: true, renderedFaces: 0,
    });
  }
  try {
    // Re-highlight ce seul espace dans son groupe (on reconstruit le groupe)
    const groupIds: number[] = [];
    for (const [, sp] of spaceById) {
      const spHex = activeSearch
        ? (hasEquipmentType(sp.spaceId, activeSearch) ? SEARCH_HIT_COLOR : SEARCH_MISS_COLOR)
        : SPACE_COLORS[sp.status];
      if (spHex === hex) groupIds.push(sp.expressId);
    }
    highlighter.highlightByID(styleName, { [currentModel.modelId]: new Set(groupIds) }, false, false);
  } catch { /* ignore */ }
}

function showRoomDetail(spaceId: string): void {
  const info = spaceById.get(spaceId);
  const roomEmpty  = document.getElementById("room-empty")!;
  const roomDetail = document.getElementById("room-detail")!;

  if (!info) { roomEmpty.style.display = ""; roomDetail.style.display = "none"; return; }

  roomEmpty.style.display = "none";
  roomDetail.style.display = "";

  document.getElementById("room-name-big")!.textContent = info.name;
  document.getElementById("room-meta")!.innerHTML = `
    <span class="badge-service">${info.service}</span>
    <span class="badge-floor">${info.floor === 0 ? "RDC" : `R+${info.floor}`}</span>
    <span class="badge-status badge-${info.status}">${spaceStatusLabel(info.status)}</span>
  `;

  const eqList = document.getElementById("room-eq-list")!;
  const items  = getEquipmentInSpace(spaceId);

  if (items.length === 0) {
    eqList.innerHTML = `<div class="rp-empty-hint">Aucun équipement dans cette pièce</div>`;
  } else {
    eqList.innerHTML = items.map(item => `
      <div class="eq-item ${item.status}">
        <span class="eq-item-icon">${item.type.icon}</span>
        <div class="eq-item-info">
          <div class="eq-item-label">${item.type.label}</div>
          <div class="eq-item-serial">${item.serial}</div>
        </div>
        <div class="eq-item-right">
          <span class="eq-status-dot status-${item.status}"></span>
          ${item.isOutOfPlace
            ? `<span class="eq-displaced" title="Zone d'affectation: ${firebaseDB?.spaces[item.homeSpace]?.name ?? item.homeSpace}">⚠</span>`
            : ""}
        </div>
      </div>
    `).join("");
  }
}


// ═══════════════════════════════════════════════════════════════
// Zoom caméra sur une pièce
// ═══════════════════════════════════════════════════════════════
async function zoomToSpace(spaceId: string): Promise<void> {
  if (!currentModel) return;
  const info = spaceById.get(spaceId);
  if (!info) return;
  try {
    const box = await currentModel.getMergedBox([info.expressId]);
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const dist   = Math.max(size.x, size.y, size.z) * 2.5;
    await world.camera.controls.setLookAt(
      center.x + dist, center.y + dist * 0.8, center.z + dist,
      center.x, center.y, center.z,
      true  // animate
    );
  } catch (e) { logWarn(`zoomToSpace: ${e}`); }
}


// ═══════════════════════════════════════════════════════════════
// Filtre par niveau
// ═══════════════════════════════════════════════════════════════
async function applyFloorFilter(floor: number): Promise<void> {
  if (!currentModel) return;
  const hider   = components.get(OBC.Hider);
  const modelId = currentModel.modelId;
  const toShow  = new Set<number>();
  const toHide  = new Set<number>();
  for (const [, info] of spaceById) {
    if (floor === -1 || info.floor === floor) toShow.add(info.expressId);
    else toHide.add(info.expressId);
  }
  if (toShow.size) await hider.set(true,  { [modelId]: toShow });
  if (toHide.size) await hider.set(false, { [modelId]: toHide });
  await fragments.core.update(true);
}

// ─── Visibilité pendant une recherche ──────────────────────────
// Pièces sans l'équipement : affichées en blanc très transparent
const SEARCH_DIM_STYLE = "mt-search-dim";

async function applySearchVisibility(typeId: string | null): Promise<void> {
  if (!currentModel || !highlighter) return;
  const hider   = components.get(OBC.Hider);
  const modelId = currentModel.modelId;

  // Toujours restaurer la visibilité complète
  const allIds = new Set([...spaceById.values()].map(i => i.expressId));
  if (allIds.size) await hider.set(true, { [modelId]: allIds });

  if (!typeId) {
    // Effacer le style "dim"
    try { await highlighter.clear(SEARCH_DIM_STYLE); } catch { /* ignore */ }
  } else {
    // Enregistrer le style dim (blanc très transparent)
    if (!highlighter.styles.has(SEARCH_DIM_STYLE)) {
      highlighter.styles.set(SEARCH_DIM_STYLE, {
        color: new THREE.Color("#ffffff"),
        opacity: 0.08,
        transparent: true,
        renderedFaces: 0,
      });
    }
    // Dim les pièces sans l'équipement, colorier les autres selon statut du type
    const dimIds = new Set<number>();
    const colorGroups = new Map<string, number[]>(); // hex → [expressIds]

    for (const [, info] of spaceById) {
      const col = spaceColorForType(info.spaceId, typeId);
      if (!col) {
        dimIds.add(info.expressId);
      } else {
        const styleName = `mt-${col.replace("#", "")}`;
        if (!colorGroups.has(styleName)) colorGroups.set(styleName, []);
        colorGroups.get(styleName)!.push(info.expressId);
      }
    }

    // Appliquer les couleurs par type
    for (const [styleName, ids] of colorGroups) {
      const hex = "#" + styleName.replace("mt-", "");
      if (!highlighter.styles.has(styleName)) {
        highlighter.styles.set(styleName, {
          color: new THREE.Color(hex), opacity: 0.6, transparent: true, renderedFaces: 0,
        });
      }
      try {
        await highlighter.highlightByID(styleName, { [modelId]: new Set(ids) }, false, false);
      } catch { /* ignore */ }
    }

    // Dim les pièces sans l'équipement
    if (dimIds.size) {
      try {
        await highlighter.highlightByID(SEARCH_DIM_STYLE, { [modelId]: dimIds }, false, false);
      } catch { /* ignore */ }
    } else {
      try { await highlighter.clear(SEARCH_DIM_STYLE); } catch { /* ignore */ }
    }
  }
  await fragments.core.update(true);
}

// ═══════════════════════════════════════════════════════════════
// Chargement IFC — même signature que AssetsBoard (4 args)
// ═══════════════════════════════════════════════════════════════
async function loadIfc(): Promise<void> {
  const myToken = ++_ifcLoadToken;
  _isLoadingIfc = true;

  showSpinner("Téléchargement du modèle IFC…");
  const placeholder = document.getElementById("viewer-placeholder");
  if (placeholder) placeholder.style.display = "none";

  try {
    // Nettoyer le modèle précédent si besoin
    if (currentModel) {
      world.scene.three.remove(currentModel.object);
      currentModel = null;
    }

    const response = await fetch("/TrackMed.ifc");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    showSpinner("Analyse IFC…");
    const buffer = await response.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    const modelId = `TrackMed__${Date.now()}`;

    // ✅ Signature identique à AssetsBoard : 4 arguments
    await (ifcLoader.load as any)(bytes, false, modelId, {
      processData: {
        progressCallback: (p: number) => {
          if (myToken !== _ifcLoadToken) return;
          showSpinner(`Analyse IFC… ${Math.round(p * 100)}%`);
        },
      },
    });

    logOk(`IFC chargé: ${modelId}`);

  } catch (e) {
    _isLoadingIfc = false;
    hideSpinner();
    if (placeholder) placeholder.style.display = "";
    showToast(`Erreur chargement IFC: ${e}`, "err");
    console.error(e);
  }
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
async function init(): Promise<void> {
  // ─── Firebase ─────────────────────────────────────
  const db = initFirebase();
  if (db) {
    listenDatabase(
      (data) => {
        const isFirst = !firebaseDB;
        firebaseDB = data;
        populateEquipmentTypes();
        if (currentModel) refresh();
        if (isFirst) logOk("Firebase connecté, données reçues");
      },
      (connected) => {
        const dot   = document.getElementById("fb-dot")!;
        const label = document.getElementById("fb-label")!;
        dot.className     = connected ? "fb-dot connected" : "fb-dot";
        label.textContent = connected ? "Connecté" : "Reconnexion…";
      }
    );
  }

  // ─── ThatOpen ─────────────────────────────────────
  const container = document.getElementById("viewer-container") as HTMLElement;
  world.scene    = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera   = new OBC.SimpleCamera(components);

  components.init();
  world.scene.setup();
  world.camera.controls.setLookAt(15, 15, 15, 0, 0, 0);
  world.camera.controls.addEventListener("control", () => {
    if (!_isLoadingIfc) fragments?.core.update(false);
  });

  const light1 = new THREE.DirectionalLight(0xffffff, 1.2);
  light1.position.set(12, 20, 8);
  world.scene.three.add(light1);
  world.scene.three.add(new THREE.AmbientLight(0xffffff, 0.5));
  world.scene.three.background = new THREE.Color("#0b0d14");

  // ─── Sections collapsibles ─────────────────────────
  document.querySelectorAll(".section-header").forEach(header => {
    header.addEventListener("click", () => {
      const id = header.getAttribute("data-target");
      if (id) document.getElementById(id)?.classList.toggle("collapsed");
    });
  });

  document.getElementById("bg-color")?.addEventListener("input", (e) => {
    world.scene.three.background = new THREE.Color((e.target as HTMLInputElement).value);
  });

  const spacesToggle = document.getElementById("spaces-only") as HTMLInputElement;
  spacesToggle?.addEventListener("change", () => applySpacesMode(spacesToggle.checked));

  // ─── FragmentsManager (identique AssetsBoard) ──────
  fragments = components.get(OBC.FragmentsManager);
  fragments.init(import.meta.env.BASE_URL + "worker.mjs");
  logOk("FragmentsManager initialisé");

  // ─── IfcLoader (identique AssetsBoard) ────────────
  ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: import.meta.env.BASE_URL + "web-ifc/", absolute: true },
    customLocateFileHandler: (url: string | undefined) => {
      const base = import.meta.env.BASE_URL;
      if (!url || url.endsWith(".wasm")) return base + "web-ifc/web-ifc.wasm";
      return base + "web-ifc/" + url.split("/").pop();
    },
  });
  try { (ifcLoader as any).settings.excludedCategories = new Set(); } catch { /* ignore */ }
  logOk("IfcLoader setup OK");

  // ─── Highlighter : détection de clic + coloration statut ────
  try {
    const hl = components.get(OBF.Highlighter);
    hl.setup({ world, selectName: "select" });

    hl.events.select.onHighlight.add(async (selection: any) => {
      // Récupérer l'expressId via ThatOpen
      const keys = Object.keys(selection);
      if (!keys.length) return;
      const set = selection[keys[0]];
      let expId: number | null = null;
      if (set instanceof Set) expId = [...set][0] ?? null;
      else if (Array.isArray(set)) expId = set[0] ?? null;

      // Effacer immédiatement le bleu "select"
      try { await hl.clear("select"); } catch { /* ignore */ }

      if (expId == null) { selectSpace(null); return; }
      const spaceId = spaceByExpId.get(expId);
      if (spaceId) {
        if (spaceId === selectedSpaceId) selectSpace(null);
        else { selectSpace(spaceId); zoomToSpace(spaceId); }
      } else {
        selectSpace(null);
      }
    });

    highlighter = hl;
    logOk("Highlighter actif");
  } catch (e) { logWarn(`Highlighter: ${e}`); }

  // Clic dans le vide → désélectionner (canvas direct, pas onClear)
  // On utilise mousedown pour être sûr de l'ordre d'exécution
  world.renderer.three.domElement.addEventListener("click", (e: MouseEvent) => {
    if (!currentModel) return;
    try {
      const canvas = world.renderer.three.domElement;
      const rect   = canvas.getBoundingClientRect();
      const mouse  = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top)  / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, world.camera.three);
      // Collecter uniquement les meshes avec géométrie valide
      const validMeshes: THREE.Object3D[] = [];
      currentModel.object.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry?.attributes?.position?.count > 0) {
          validMeshes.push(mesh);
        }
      });
      const hits = raycaster.intersectObjects(validMeshes, false);
      if (hits.length === 0) selectSpace(null);
    } catch { /* ignore */ }
  });

  // ─── onItemSet (identique AssetsBoard) ────────────
  fragments.list.onItemSet.add(async ({ value: model }: any) => {
    const isDelta = (model as any)._parentModelId != null;
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    model.object.position.set(0, 0, 0);
    model.object.updateMatrixWorld(true);
    if (isDelta) { await fragments.core.update(true); return; }

    currentModel = model;

    try {
      showSpinner("Finalisation du modèle…");
      await fragments.core.update(true);
      await new Promise<void>((r) => setTimeout(r, 0));

      // Centrer caméra
      try {
        const allIds = await model.getItemsIdsWithGeometry();
        if (allIds?.length) {
          const box = await model.getMergedBox(allIds);
          if (box && !box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3());
            const size   = box.getSize(new THREE.Vector3());
            const dist   = Math.max(size.x, size.y, size.z) * 0.5;
            await world.camera.controls.setLookAt(
              center.x + dist, center.y + dist * 0.6, center.z + dist,
              center.x, center.y, center.z, true
            );
          }
        }
      } catch { /* ignore */ }

      // Identifier espaces
      await identifySpaces(model);
      if (firebaseDB) computeSpaceStatuses();

      // Mode par défaut : pièces uniquement
      const spacesToggle = document.getElementById("spaces-only") as HTMLInputElement;
      if (spacesToggle) spacesToggle.checked = true;
      await applySpacesMode(true);
      await applySpaceColors(null);

      // Afficher la top-bar
      document.getElementById("top-bar")?.classList.remove("hidden");

      if (firebaseDB) updateDashboard();

      await fragments.core.update(true);
      requestAnimationFrame(() => fragments.core.update(false));
      logOk(`Modèle prêt — ${spaceById.size} pièces identifiées`);

    } catch (e) {
      console.error(e);
      showToast(`Erreur post-chargement: ${e}`, "err");
    } finally {
      _isLoadingIfc = false;
      hideSpinner();
    }
  });

  // ─── Bouton charger ────────────────────────────────
  document.getElementById("btn-load-model")?.addEventListener("click", loadIfc);

  // ─── Floor tabs ────────────────────────────────────
  document.getElementById("floor-tabs")?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(".floor-btn") as HTMLButtonElement;
    if (!btn) return;
    document.querySelectorAll(".floor-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const floor = parseInt(btn.dataset.floor ?? "-1");
    const spacesToggle = document.getElementById("spaces-only") as HTMLInputElement;
    if (spacesToggle?.checked) await applyFloorFilter(floor);
  });

  // ─── Recherche équipement ──────────────────────────
  const select   = document.getElementById("eq-type-select") as HTMLSelectElement;
  const clearBtn = document.getElementById("btn-clear-search") as HTMLButtonElement;

  select.addEventListener("change", async () => {
    const typeId = select.value;
    if (!typeId) {
      activeSearch = null;
      clearBtn.style.display = "none";
      document.getElementById("search-results")!.style.display = "none";
      document.getElementById("search-empty")!.style.display = "";
      await applySearchVisibility(null);
      applySpaceColors(null);
    } else {
      activeSearch = typeId;
      clearBtn.style.display = "";
      updateSearchResults(typeId);
      await applySpaceColors(null);          // 1. statuts sur toutes les pièces
      await applySearchVisibility(typeId);   // 2. dim les non-concernées par-dessus
    }
  });

  clearBtn.addEventListener("click", async () => {
    select.value = "";
    activeSearch = null;
    clearBtn.style.display = "none";
    document.getElementById("search-results")!.style.display = "none";
    document.getElementById("search-empty")!.style.display = "";
    await applySpaceColors(null);
    await applySearchVisibility(null);
  });

  // ─── Panel mobile ──────────────────────────────────
  const panel         = document.getElementById("right-panel")!;
  const mobileToggle  = document.getElementById("mobile-panel-toggle") as HTMLButtonElement;
  const mobileOverlay = document.getElementById("mobile-overlay") as HTMLElement;
  const closePanel = () => { panel.classList.remove("open"); mobileOverlay.classList.remove("visible"); };
  mobileToggle?.addEventListener("click", () => panel.classList.contains("open") ? closePanel() : panel.classList.add("open"));
  mobileOverlay?.addEventListener("click", closePanel);

  // ─── Panel resize desktop ──────────────────────────
  const handle = document.getElementById("panel-resize-handle")!;
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true; startX = e.clientX; startW = panel.offsetWidth;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newW = Math.min(Math.max(startW + startX - e.clientX, 280), window.innerWidth * 0.7);
    panel.style.width = `${newW}px`;
  });
  document.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; }
  });

  logOk("MedTrack initialisé");
  hideSpinner();
  animate();
}


function animate() {
  requestAnimationFrame(animate);
  world.renderer.three.render(world.scene.three, world.camera.three);
  if (!_isLoadingIfc) fragments?.core.update(false);
}

init().catch(console.error);