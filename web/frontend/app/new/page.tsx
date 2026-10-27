import { LaunchForm } from "@/components/LaunchForm";

export const dynamic = "force-dynamic";

export default function NewRunPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">New run</h1>
        <p className="text-sm text-stone-500">
          Pick a file and one or more reviewer models. Nothing is called until you press Run. Runs go one at a
          time, in the order you start them.
        </p>
      </div>
      <LaunchForm />
    </div>
  );
}
