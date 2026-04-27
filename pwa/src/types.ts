// ═══════════════════════════════════════════════════════════════
// MedTrack — Types partagés
// ═══════════════════════════════════════════════════════════════

export interface FirebaseSpace {
  name: string;
  floor: number;
  service: string;
}

export interface FirebaseEquipmentType {
  label: string;
  icon: string;
  unit_cost: number;
}

export type EquipmentStatus = "available" | "in_use" | "maintenance";

export interface FirebaseEquipment {
  type: string;           // ex: "TYPE_01"
  serial: string;
  home_space: string;     // ex: "SPACE_R1_03"
  status: EquipmentStatus;
  beacon_id: string;      // ex: "BCN_001"
  last_maintenance: string;
}

export interface FirebaseBeacon {
  mac: string;
  current_space: string;  // ex: "SPACE_RDC_02"
  rssi: number;
  last_seen: string;
}

export interface FirebaseDB {
  spaces: Record<string, FirebaseSpace>;
  equipment_types: Record<string, FirebaseEquipmentType>;
  equipment: Record<string, FirebaseEquipment>;
  beacons: Record<string, FirebaseBeacon>;
}

// ─── Computed / enriched ────────────────────────────────────────

export type SpaceStatus = "empty" | "ok" | "in_use" | "displaced" | "maintenance";

export interface SpaceInfo {
  spaceId: string;          // ex: "SPACE_RDC_01"
  expressId: number;        // ThatOpen expressId
  name: string;             // ex: "Accueil & Admissions"
  floor: number;
  service: string;
  status: SpaceStatus;
  equipmentCount: number;   // nombre total d'équipements actuellement dans la pièce
  displaced: number;        // équipements hors de leur zone d'affectation
  availableCount: number;
}

export interface EquipmentInSpace {
  eqId: string;
  type: FirebaseEquipmentType;
  serial: string;
  status: EquipmentStatus;
  isOutOfPlace: boolean;    // current_space !== home_space
  homeSpace: string;
}