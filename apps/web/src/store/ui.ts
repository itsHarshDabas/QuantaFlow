import { create } from "zustand";

/** Local UI state that isn't worth putting in the URL. */
export interface UiChrome {
  newJob: { open: boolean; agentId: string | null };
  queueOpen: boolean;
  openNewJob: (agentId?: string | null) => void;
  closeNewJob: () => void;
  setQueueOpen: (open: boolean) => void;
}

export const useChrome = create<UiChrome>()((set) => ({
  newJob: { open: false, agentId: null },
  queueOpen: false,
  openNewJob: (agentId = null) => set({ newJob: { open: true, agentId } }),
  closeNewJob: () => set((s) => ({ newJob: { ...s.newJob, open: false } })),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
}));
