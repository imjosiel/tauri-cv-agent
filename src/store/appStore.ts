import { create } from "zustand";

export interface OllamaStatus {
  connected: boolean;
  model?: string;
  models_available: string[];
}

export interface NightConfig {
  mode: "autonomous" | "dry_run" | "manual";
  min_score: number;
  max_per_night: number;
  delay_minutes: number;
  cover_letter: boolean;
  stop_on_captcha: boolean;
  blacklist: string[];
  sites: string[];
  modality?: string;
  locations?: string[];
}

export interface JobListing {
  id: string;
  title: string;
  company: string;
  url: string;
  site: string;
  description: string;
  score?: number;
  status: string;
  applied_at?: string;
  resume_path?: string;
  skip_reason?: string;
  screenshot_path?: string;
}

export interface LiveEvent {
  type: string;
  payload: any;
  ts: number;
}

// Tipos de currículo — espelham SavedResumePackage do Rust
export interface ResumeAsset {
  filename: string;
  data_url?: string;
  present: boolean;
  placeholder: boolean;
}

export interface ResumePackage {
  name: string;
  tex_content: string;
  assets: ResumeAsset[];
  saved_at: string;
}

interface AppStore {
  ollama: OllamaStatus | null;
  running: boolean;
  nightConfig: NightConfig;
  liveEvents: LiveEvent[];
  jobs: JobListing[];

  // Currículos — persistidos no disco, carregados uma vez na montagem do App
  resumePackages: ResumePackage[];
  resumesLoaded: boolean;

  setOllama: (s: OllamaStatus) => void;
  setRunning: (r: boolean) => void;
  setNightConfig: (c: Partial<NightConfig>) => void;
  addEvent: (type: string, payload: any) => void;
  setJobs: (jobs: JobListing[]) => void;
  clearEvents: () => void;

  setResumePackages: (pkgs: ResumePackage[]) => void;
  addResumePackage: (pkg: ResumePackage) => void;
  updateResumePackage: (name: string, pkg: Partial<ResumePackage>) => void;
  deleteResumePackage: (name: string) => void;
  setResumesLoaded: (v: boolean) => void;
}

const DEFAULT_CONFIG: NightConfig = {
  mode: "autonomous",
  min_score: 40,
  max_per_night: 12,
  delay_minutes: 7,
  cover_letter: true,
  stop_on_captcha: false,
  blacklist: [],
  sites: ["linkedin", "indeed", "catho", "infojobs"],
};

export const useAppStore = create<AppStore>((set) => ({
  ollama: null,
  running: false,
  nightConfig: DEFAULT_CONFIG,
  liveEvents: [],
  jobs: [],
  resumePackages: [],
  resumesLoaded: false,

  setOllama: (ollama) => set({ ollama }),
  setRunning: (running) => set({ running }),
  setNightConfig: (c) =>
    set((s) => ({ nightConfig: { ...s.nightConfig, ...c } })),
  addEvent: (type, payload) =>
    set((s) => ({
      liveEvents: [{ type, payload, ts: Date.now() }, ...s.liveEvents].slice(0, 200),
    })),
  setJobs: (jobs) => set({ jobs }),
  clearEvents: () => set({ liveEvents: [] }),

  setResumePackages: (resumePackages) => set({ resumePackages }),
  addResumePackage: (pkg) =>
    set((s) => ({
      resumePackages: [...s.resumePackages.filter((p) => p.name !== pkg.name), pkg],
    })),
  updateResumePackage: (name, partial) =>
    set((s) => ({
      resumePackages: s.resumePackages.map((p) =>
        p.name === name ? { ...p, ...partial } : p
      ),
    })),
  deleteResumePackage: (name) =>
    set((s) => ({
      resumePackages: s.resumePackages.filter((p) => p.name !== name),
    })),
  setResumesLoaded: (resumesLoaded) => set({ resumesLoaded }),
}));
