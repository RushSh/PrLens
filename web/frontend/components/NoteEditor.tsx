"use client";

import { useState } from "react";
import { clientFetch } from "@/lib/api";

export function NoteEditor({ runId, initial }: { runId: string; initial: string | null }) {
  const [note, setNote] = useState(initial ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    setState("saving");
    try {
      await clientFetch(`/api/runs/${runId}`, { method: "PATCH", body: { note: note.trim() || null } });
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <label className="block text-sm">
      <span className="text-stone-500">Note</span>
      <div className="mt-1 flex gap-2">
        <input
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setState("idle");
          }}
          placeholder="e.g. first run with the tighter prompt"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
        />
        <button type="button" onClick={save} className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-50">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save"}
        </button>
      </div>
      {state === "error" ? <span className="text-xs text-red-700">Could not save the note.</span> : null}
    </label>
  );
}
