import { Experiments } from "@/components/Experiments";

export const dynamic = "force-dynamic";

export default function ExperimentsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Experiments</h1>
        <p className="max-w-3xl text-sm text-stone-500">
          Every stage, from building decoys to calibration. Steps that call models or a GPU are planned first: you see the
          calls and the cost, and nothing runs until you confirm. One step runs at a time per lane (models, this machine,
          admin); the rest wait in Jobs. Results appear on their pages automatically.
        </p>
      </div>
      <Experiments />
    </div>
  );
}
